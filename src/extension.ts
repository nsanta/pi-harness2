/** The harness² pi extension surface: six commands (h2:init, h2:run, h2:adopt, h2:status,
 * h2:report, h2:publish) and one model-callable tool (h2_run), all funnelling through the
 * injectable runHarness() flow. Every handler catches its own failures and reports them
 * through ctx.ui.notify(..., "error") — a command never throws raw into the session. All
 * state lives under one state directory (<cwd>/.harness2 by default, overridable via
 * options); the one exception is h2:publish, which writes a lesson doc outside it, and
 * only when the user runs that command.
 *
 * Command names use colons (h2:init, not h2_init): pi dispatches extension commands by
 * exact invocationName match with no character restrictions, and itself generates colon
 * names (built-in /skill:<name> commands, duplicate disambiguation as name:2). */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DEFAULTS,
  DEFAULT_STATE_DIR,
  loadConfig,
  resolveDocsDir,
  type HarnessConfig,
} from "./config.ts";
import { Library, slugify } from "./library.ts";
import { renderRunReport } from "./report.ts";
import { runMode as runModeReal, type ModeResult, type Stage } from "./recursion.ts";
import { clip } from "./runner.ts";
import {
  diffTrees,
  normalizeRel,
  readTree as readTreeReal,
  writeTree as writeTreeReal,
} from "./tree.ts";
import type { Tree } from "./types.ts";

/** Everything the run flow needs from the outside; each seam defaults to the real
 * implementation so production code calls runHarness(input) and tests inject fakes. */
export interface HarnessDeps {
  loadConfig: (stateDir: string) => HarnessConfig;
  readTree: typeof readTreeReal;
  runMode: typeof runModeReal;
  writeTree: typeof writeTreeReal;
  renderRunReport: typeof renderRunReport;
  newRunId: () => string;
}

function defaultDeps(): HarnessDeps {
  return {
    loadConfig,
    readTree: readTreeReal,
    runMode: runModeReal,
    writeTree: writeTreeReal,
    renderRunReport,
    newRunId,
  };
}

/** Run ids are r-<yyyymmdd>-<4 hex>. recursion.ts's probe ids differ on purpose: probe ids
 * name their slot and exist only inside one run, while these name archived runs. */
export function newRunId(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  return `r-${day}-${randomBytes(2).toString("hex")}`;
}

export interface RunHarnessInput {
  task: string;
  /** Archive grouping slug; defaults to slugify(task), same resolution as recursion. */
  taskSlug?: string;
  /** Overrides config.k when set. */
  k?: number;
  /** Overrides config.mode when set. */
  mode?: "parallel" | "sequential";
  /** State root; defaults to DEFAULT_STATE_DIR. */
  stateDir?: string;
}

export interface RunHarnessOutcome {
  runId: string;
  ok: boolean;
  mode: "parallel" | "sequential";
  k: number;
  best: {label: string; score: number} | null;
  fellBack: string[];
  report: string;
  reportPath: string;
  /** Directory holding the adopted-candidate final tree; null when the run produced none. */
  finalDir: string | null;
  finalTreeFiles: number;
}

/** One full propose–probe–compose run against the harness tree at <stateDir>/harness:
 * groups everything under runs/<task-slug>/<runid>/ — the final tree (final/), the report
 * (report.md) and the stage record (stages.json, the h2:report source of truth — the
 * global ledger has no run attribution). The slug is input.taskSlug or slugify(task).
 * Throws when the harness tree is missing; callers report that. */
export async function runHarness(
  input: RunHarnessInput,
  overrides: Partial<HarnessDeps> = {},
): Promise<RunHarnessOutcome> {
  const deps: HarnessDeps = {...defaultDeps(), ...overrides};
  const stateDir = input.stateDir ?? DEFAULT_STATE_DIR;
  const harnessDir = join(stateDir, "harness");
  const baseTree = deps.readTree(harnessDir);
  if (Object.keys(baseTree).length === 0) {
    throw new Error(`no harness tree at ${harnessDir}; run h2:init first`);
  }
  const config = deps.loadConfig(stateDir);
  const mode = input.mode ?? config.mode;
  const k = input.k ?? config.k;
  const runId = deps.newRunId();
  const taskSlug = input.taskSlug ?? slugify(input.task);
  const result = await deps.runMode(mode, {
    task: input.task,
    taskSlug,
    k,
    baseTree,
    stateDir,
    models: {channel: config.channelModel},
    wallSeconds: config.wallSeconds,
    piBin: config.piBin,
  });
  const runDir = join(stateDir, "runs", taskSlug, runId);
  mkdirSync(runDir, {recursive: true});
  let finalDir: string | null = null;
  let finalTreeFiles = 0;
  if (result.finalTree !== null) {
    finalDir = join(runDir, "final");
    deps.writeTree(result.finalTree, finalDir);
    finalTreeFiles = Object.values(result.finalTree).filter((c) => c !== "").length;
  }
  const report = deps.renderRunReport({
    runId,
    mode,
    k,
    stages: result.stages,
    result,
    task: input.task,
    baseTree,
  });
  const reportPath = join(runDir, "report.md");
  writeFileSync(reportPath, report, "utf8");
  const archive = {
    task: input.task,
    mode,
    k,
    ok: result.ok,
    best: result.best,
    fellBack: result.fellBack,
    deliverable: result.deliverable,
    stages: result.stages,
    finalTree: result.finalTree,
  };
  writeFileSync(join(runDir, "stages.json"), `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  return {
    runId,
    ok: result.ok,
    mode,
    k,
    best: result.best,
    fellBack: result.fellBack,
    report,
    reportPath,
    finalDir,
    finalTreeFiles,
  };
}

/** Files seeded by h2:init; existing files are never overwritten. */
const SEED_FILES: Array<[rel: string, content: string]> = [
  [
    "systemprompt.md",
    "You are a careful professional assistant. " +
      "Work toward the deliverable; verify before claiming done.",
  ],
  [
    "guardrails.md",
    "- Never fabricate sources, ids, or citations.\n" +
      "- Prefer deterministic helper scripts over repeated manual steps.\n",
  ],
  ["LongTermMEMORY.md", ""],
  [join("tool_descriptions", "tool_guidance.md"), ""],
];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Write every tree entry as a real file, INCLUDING empty ones — unlike tree.ts's
 * writeTree, whose ""-is-deletion contract must not apply to backups and seeds. */
function materializeTree(tree: Tree, dest: string): void {
  for (const [rel, content] of Object.entries(tree)) {
    const target = join(dest, ...normalizeRel(rel).split("/"));
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, content, "utf8");
  }
}

/** Structural subset of ExtensionCommandContext that handlers actually use; keeps the
 * command implementations testable against a plain fake. */
interface Notifier {
  ui: {notify(message: string, level?: "info" | "warning" | "error"): void};
}

/** Reports a finished run: the full report when it fits in a notification, else a short
 * summary plus the report path. A completed-but-fell-back run warns instead of claiming
 * success. */
const REPORT_NOTIFY_MAX = 1200;

function summarizeOutcome(outcome: RunHarnessOutcome): string {
  const best = outcome.best ? `${outcome.best.label} (score ${outcome.best.score})` : "none";
  return (
    `harness² run ${outcome.runId} finished: ${outcome.ok ? "ok" : "fell back"}; best: ${best}; ` +
    `${outcome.finalTreeFiles} file(s) in the final tree`
  );
}

function notifyOutcome(ctx: Notifier, outcome: RunHarnessOutcome): void {
  const level = outcome.ok ? "info" : "warning";
  if (outcome.report.length <= REPORT_NOTIFY_MAX) {
    ctx.ui.notify(outcome.report, level);
    return;
  }
  ctx.ui.notify(`${summarizeOutcome(outcome)}\nReport: ${outcome.reportPath}`, level);
}

async function cmdInit(stateDir: string, ctx: Notifier): Promise<void> {
  mkdirSync(stateDir, {recursive: true});
  const created: string[] = [];
  const skipped: string[] = [];
  const seedIn = (rel: string, content: string): void => {
    const target = join(stateDir, "harness", rel);
    if (existsSync(target)) {
      skipped.push(target);
      return;
    }
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, content, "utf8");
    created.push(target);
  };
  for (const [rel, content] of SEED_FILES) seedIn(rel, content);
  const configPath = join(stateDir, "config.json");
  if (existsSync(configPath)) skipped.push(configPath);
  else {
    writeFileSync(configPath, `${JSON.stringify(CONFIG_DEFAULTS, null, 2)}\n`, "utf8");
    created.push(configPath);
  }
  const createdList = created.map((p) => `- ${p}`).join("\n");
  const skippedList = skipped.map((p) => `- ${p}`).join("\n");
  ctx.ui.notify(
    `harness² state at ${stateDir}\n` +
      `created: ${created.length === 0 ? "nothing" : `\n${createdList}`}\n` +
      `skipped (already present, never overwritten): ` +
      `${skipped.length === 0 ? "nothing" : `\n${skippedList}`}`,
    "info",
  );
}

export interface ParsedRunArgs {
  task: string;
  k?: number;
  mode?: "parallel" | "sequential";
}

/** Tokenizes a command tail: quoted segments stay one token, flags take the next token,
 * everything else joins into the task. */
export function parseRunArgs(raw: string): ParsedRunArgs {
  const tokens = [...raw.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
  const task: string[] = [];
  let k: number | undefined;
  let mode: ParsedRunArgs["mode"];
  const value = (flag: string): string => {
    const next = tokens.shift();
    if (next === undefined) throw new Error(`${flag} expects a value`);
    return next;
  };
  while (tokens.length > 0) {
    const tok = tokens.shift()!;
    if (tok === "--k") {
      const raw = value("--k");
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--k expects an integer > 0, got ${JSON.stringify(raw)}`);
      }
      k = n;
    } else if (tok === "--mode") {
      const v = value("--mode");
      if (v !== "parallel" && v !== "sequential") {
        throw new Error(`--mode expects "parallel" or "sequential", got ${JSON.stringify(v)}`);
      }
      mode = v;
    } else {
      task.push(tok);
    }
  }
  const joined = task.join(" ").trim();
  if (!joined) throw new Error('usage: h2:run "<task>" [--k N] [--mode parallel|sequential]');
  return {task: joined, k, mode};
}

async function cmdRun(
  stateDir: string,
  rawArgs: string,
  deps: Partial<HarnessDeps>,
  ctx: Notifier,
): Promise<void> {
  const parsed = parseRunArgs(rawArgs);
  const parts = [`harness²: starting run: "${parsed.task}"`];
  if (parsed.k !== undefined) parts.push(`k=${parsed.k}`);
  if (parsed.mode !== undefined) parts.push(`mode=${parsed.mode}`);
  ctx.ui.notify(parts.join(" "), "info");
  const outcome = await runHarness(
    {task: parsed.task, k: parsed.k, mode: parsed.mode, stateDir},
    deps,
  );
  notifyOutcome(ctx, outcome);
}

export interface ResolvedRun {
  /** Task-slug segment of the grouped layout: runs/<taskSlug>/<runId>. */
  taskSlug: string;
  runId: string;
  /** The resolved archive directory. */
  dir: string;
}

/** Resolve a run reference to its grouped archive directory under <stateDir>/runs.
 *
 * A reference containing "/" is a direct "<taskSlug>/<runId>" and is used as-is. A bare
 * "<runId>" is searched across every task-slug directory beneath runs/; the first hit in
 * sorted task-slug order wins, so the result is deterministic. References naming the
 * pre-grouping flat layout (a runId directly beneath runs/, i.e. runs created before this
 * change) are NOT resolved by either form; those directories remain on disk but are
 * unreachable from here. Throws an actionable error when nothing matches. */
export function resolveRunDir(stateDir: string, ref: string): ResolvedRun {
  const wanted = ref.trim().replace(/^"|"$/g, "").trim();
  if (!wanted) {
    throw new Error('a run reference is required: "<task-slug>/<runid>" or a bare "<runid>"');
  }
  const runsRoot = join(stateDir, "runs");
  const guidance =
    `no run "${wanted}" under ${runsRoot}; pass "<task-slug>/<runid>" as shown by the ` +
    `h2:run notification path, or a bare "<runid>" to search every task slug. ` +
    `Runs archived before task-slug grouping (flat runs/<runid> layout) do not resolve; ` +
    `they remain on disk.`;
  if (wanted.includes("/")) {
    const slash = wanted.indexOf("/");
    const taskSlug = wanted.slice(0, slash);
    const runId = wanted.slice(slash + 1);
    const dir = join(runsRoot, taskSlug, runId);
    if (!taskSlug || !runId || !existsSync(dir)) throw new Error(guidance);
    return {taskSlug, runId, dir};
  }
  if (!existsSync(runsRoot)) throw new Error(guidance);
  const hit = readdirSync(runsRoot)
    .filter((name) => !name.startsWith("."))
    .sort()
    .find(
      (slug) =>
        statSync(join(runsRoot, slug, wanted), {throwIfNoEntry: false})?.isDirectory() === true,
    );
  if (!hit) throw new Error(guidance);
  return {taskSlug: hit, runId: wanted, dir: join(runsRoot, hit, wanted)};
}

/** Adopt = the run's final tree BECOMES the harness. The previous tree is backed up once
 * (harness.bak-<runid>) and the harness is replaced, not overlaid: the composed tree is a
 * full merge, so overlaying would resurrect files the proposal deleted. */
async function cmdAdopt(stateDir: string, rawArgs: string, ctx: Notifier): Promise<void> {
  const resolved = resolveRunDir(stateDir, rawArgs);
  const {runId} = resolved;
  const finalDir = join(resolved.dir, "final");
  const after = readTreeReal(finalDir);
  if (Object.keys(after).length === 0) {
    throw new Error(`no final tree for run "${runId}" at ${finalDir}; run h2:run first`);
  }
  const harnessDir = join(stateDir, "harness");
  const before = readTreeReal(harnessDir);
  const backupDir = join(stateDir, `harness.bak-${runId}`);
  if (!existsSync(backupDir)) materializeTree(before, backupDir);
  rmSync(harnessDir, {recursive: true, force: true});
  writeTreeReal(after, harnessDir);
  const changed = diffTrees(before, after);
  const rels = Object.keys(changed);
  if (rels.length === 0) {
    ctx.ui.notify(
      `adopted run ${runId}: the harness already matches the final tree; ` +
        `previous tree kept at ${backupDir}`,
      "info",
    );
    return;
  }
  const deleted = rels.filter((rel) => changed[rel] === "").length;
  const added = rels.filter((rel) => changed[rel] !== "" && !(rel in before)).length;
  const modified = rels.length - deleted - added;
  ctx.ui.notify(
    `adopted run ${runId}: ${rels.length} file(s) changed ` +
      `(${added} added, ${modified} modified, ${deleted} deleted); ` +
      `previous tree backed up at ${backupDir}`,
    "info",
  );
}

/** Last n JSONL lines of the ledger; [] when it does not exist yet. */
function ledgerTail(stateDir: string, n: number): string[] {
  const path = join(stateDir, "ledger.jsonl");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  return lines.slice(-n);
}

async function cmdStatus(stateDir: string, ctx: Notifier): Promise<void> {
  const rows = ledgerTail(stateDir, 10);
  const stageLines = rows.map((line) => {
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const cost = Number(r["costUsd"] ?? 0);
      const detail = r["detail"] ? ` — ${clip(String(r["detail"]), 80)}` : "";
      return `- ${String(r["stage"])}: ${r["ok"] ? "ok" : "FAIL"} ` +
        `(${String(r["mode"])} k=${String(r["k"])}, cost ${cost.toFixed(6)})${detail}`;
    } catch {
      return `- (unparseable ledger line) ${clip(line, 80)}`;
    }
  });
  const ledgerPart =
    rows.length > 0
      ? `ledger (last ${rows.length}):\n${stageLines.join("\n")}`
      : "ledger: none yet (run h2:run)";
  const entries = new Library(stateDir).entries().length;
  const body = [
    `harness² status at ${stateDir}`,
    ledgerPart,
    `library: ${entries} entr${entries === 1 ? "y" : "ies"}`,
  ];
  ctx.ui.notify(body.join("\n"), "info");
}

/** Newest grouped run as a "<taskSlug>/<runId>" reference — resolveRunDir's direct form.
 * Runs left in the pre-grouping flat layout (runs/<runId>) are not candidates. */
function latestRunId(stateDir: string): string | null {
  const runsDir = join(stateDir, "runs");
  if (!existsSync(runsDir)) return null;
  let best: {id: string; mtime: number} | null = null;
  for (const slug of readdirSync(runsDir)) {
    const slugDir = join(runsDir, slug);
    if (!statSync(slugDir, {throwIfNoEntry: false})?.isDirectory()) continue;
    for (const runId of readdirSync(slugDir)) {
      const st = statSync(join(slugDir, runId), {throwIfNoEntry: false});
      if (!st?.isDirectory()) continue;
      if (best === null || st.mtimeMs > best.mtime) {
        best = {id: `${slug}/${runId}`, mtime: st.mtimeMs};
      }
    }
  }
  return best?.id ?? null;
}

interface ArchivedRun {
  task: string;
  mode: "parallel" | "sequential";
  k: number;
  ok: boolean;
  best: {label: string; score: number} | null;
  fellBack: string[];
  stages: Stage[];
  finalTree: Tree | null;
}

async function cmdReport(stateDir: string, rawArgs: string, ctx: Notifier): Promise<void> {
  const wanted = rawArgs.trim().replace(/^"|"$/g, "").trim();
  const ref = wanted || latestRunId(stateDir);
  if (!ref) throw new Error(`no runs under ${join(stateDir, "runs")}; run h2:run first`);
  const resolved = resolveRunDir(stateDir, ref);
  const runId = resolved.runId;
  const runDir = resolved.dir;
  if (!existsSync(runDir)) throw new Error(`unknown run "${runId}": ${runDir} does not exist`);
  const stagesPath = join(runDir, "stages.json");
  let report: string;
  let degraded = false;
  if (existsSync(stagesPath)) {
    const arch = JSON.parse(readFileSync(stagesPath, "utf8")) as ArchivedRun;
    const result: ModeResult = {
      ok: arch.ok,
      mode: arch.mode,
      k: arch.k,
      taskSlug: resolved.taskSlug,
      stages: arch.stages,
      finalTree: arch.finalTree,
      best: arch.best,
      deliverable: "",
      fellBack: arch.fellBack,
    };
    report = renderRunReport({
      runId,
      mode: arch.mode,
      k: arch.k,
      stages: arch.stages,
      result,
      task: arch.task,
    });
  } else {
    degraded = true;
    const rows = ledgerTail(stateDir, 10);
    const tail =
      rows.length > 0
        ? rows.map((l) => `- ${clip(l, 200)}`).join("\n")
        : "(ledger is empty)";
    report = [
      `# harness² run ${runId}`,
      "",
      "No archived stage data for this run; showing the last ledger lines instead.",
      "",
      tail,
      "",
    ].join("\n");
  }
  const reportPath = join(runDir, "report.md");
  writeFileSync(reportPath, report, "utf8");
  const note = degraded ? " (degraded: ledger tail only)" : "";
  ctx.ui.notify(
    `harness² report for run ${runId}${note}: ${reportPath}`,
    degraded ? "warning" : "info",
  );
}

export interface Harness2Options {
  /** State root override; defaults to DEFAULT_STATE_DIR (<cwd>/.harness2). */
  stateDir?: string;
  /** Dependency overrides threaded into every runHarness call (tests inject fakes). */
  deps?: Partial<HarnessDeps>;
}

/** h2:publish: the ONLY handler permitted to write outside the state directory, and only
 * when the user runs it. Copies the task's stored lesson (frontmatter included) verbatim
 * to <docsDir>/harness2/<taskSlug>.md, creating directories as needed, and reports the
 * written path plus the trust tier an external consumer will derive from the frontmatter:
 * a run verifier means machine-confirmed; its absence means unverified. The lesson is read
 * from the library (not the run archive): the library holds the task's current distilled
 * lessons, which is what publishing means. Without one there is nothing honest to publish. */
async function cmdPublish(
  stateDir: string,
  rawArgs: string,
  deps: Partial<HarnessDeps>,
  ctx: Notifier,
): Promise<void> {
  const resolved = resolveRunDir(stateDir, rawArgs);
  const library = new Library(stateDir);
  const lesson = library.lessonsOf(resolved.taskSlug);
  if (lesson === null) {
    throw new Error(
      `no stored lesson for task "${resolved.taskSlug}" under ` +
        `${join(library.dir, resolved.taskSlug)}; reflection failed for this run or the run ` +
        `predates stored lessons — re-run h2:run for this task, then h2:publish again`,
    );
  }
  const load = deps.loadConfig ?? loadConfig;
  const target = join(resolveDocsDir(load(stateDir)), "harness2", `${resolved.taskSlug}.md`);
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, lesson, "utf8");
  const tier = /^verified:/m.test(lesson)
    ? "machine-confirmed (run verifier in the frontmatter)"
    : "unverified (no verifier recorded; a human may add one by editing the file)";
  ctx.ui.notify(
    `published harness² lessons for "${resolved.taskSlug}" (run ${resolved.runId}): ${target}\n` +
      `trust tier: ${tier}`,
    "info",
  );
}

/** Wrap one command body so failures surface as an error notification, never a throw. */
function guard(
  name: string,
  run: (args: string, ctx: Notifier) => Promise<void>,
): (args: string, ctx: Notifier) => Promise<void> {
  return async (args, ctx) => {
    try {
      await run(args, ctx);
    } catch (e) {
      ctx.ui.notify(`${name} failed: ${errText(e)}`, "error");
    }
  };
}

/** TypeBox parameter schema for h2_run, written as a plain JSON-Schema object: the package
 * has zero runtime dependencies, so the typebox helper is not imported. */
const RUN_TOOL_PARAMS = {
  type: "object",
  properties: {
    task: {type: "string", description: "The task to adapt the harness for."},
    k: {type: "number", description: "Slots (parallel) or steps (sequential); overrides config."},
    mode: {type: "string", enum: ["parallel", "sequential"], description: "Run strategy."},
  },
  required: ["task"],
} as const;

interface RunToolParams {
  task: string;
  k?: number;
  mode?: "parallel" | "sequential";
}

/** The harness² extension factory. Registering loads nothing and starts nothing; work
 * happens inside command/tool handlers. */
export default function harness2(pi: ExtensionAPI, options: Harness2Options = {}): void {
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const deps = options.deps ?? {};
  pi.registerCommand("h2:init", {
    description: "harness²: seed the state directory and harness tree (idempotent)",
    handler: guard("h2:init", async (_args, ctx) => cmdInit(stateDir, ctx)),
  });
  pi.registerCommand("h2:run", {
    description:
      'harness²: run propose–probe–compose — "<task>" [--k N] [--mode parallel|sequential]',
    handler: guard("h2:run", async (args, ctx) => cmdRun(stateDir, args, deps, ctx)),
  });
  pi.registerCommand("h2:adopt", {
    description:
      'harness²: adopt a run\'s final tree (backs up the old harness) — "[<task-slug>/]<runid>"',
    handler: guard("h2:adopt", async (args, ctx) => cmdAdopt(stateDir, args, ctx)),
  });
  pi.registerCommand("h2:status", {
    description: "harness²: ledger tail and library size",
    handler: guard("h2:status", async (_args, ctx) => cmdStatus(stateDir, ctx)),
  });
  pi.registerCommand("h2:report", {
    description: "harness²: (re)write a run's report — \"[<task-slug>/]<runid>\"",
    handler: guard("h2:report", async (args, ctx) => cmdReport(stateDir, args, ctx)),
  });
  pi.registerCommand("h2:publish", {
    description:
      "harness²: publish a task's stored lessons as a doc (opt-in, writes outside the " +
      'state dir) — "[<task-slug>/]<runid>"',
    handler: guard("h2:publish", async (args, ctx) => cmdPublish(stateDir, args, deps, ctx)),
  });
  pi.registerTool({
    name: "h2_run",
    label: "harness² run",
    description:
      "Run the harness² propose–probe–compose loop on the harness tree in the state " +
      "directory: proposes candidate harness edits, probes them headlessly, judges the " +
      "trajectories, composes the best into a final tree, and archives report + tree. " +
      "Returns a short summary and the report path.",
    parameters: RUN_TOOL_PARAMS,
    execute: async (
      _toolCallId: string,
      params: RunToolParams,
      _signal: unknown,
      _onUpdate: unknown,
      toolCtx: unknown,
    ) => {
      void toolCtx;
      try {
        const outcome = await runHarness(
          {task: params.task, k: params.k, mode: params.mode, stateDir},
          deps,
        );
        return {
          content: [
            {type: "text", text: `${summarizeOutcome(outcome)}\nReport: ${outcome.reportPath}`},
          ],
          details: {
            runId: outcome.runId,
            ok: outcome.ok,
            best: outcome.best,
            finalTreeFiles: outcome.finalTreeFiles,
          },
        };
      } catch (e) {
        return {
          content: [{type: "text", text: `h2_run failed: ${errText(e)}`}],
          details: {runId: "", ok: false, best: null, finalTreeFiles: 0},
          isError: true,
        };
      }
    },
  } as Parameters<ExtensionAPI["registerTool"]>[0]);
}
