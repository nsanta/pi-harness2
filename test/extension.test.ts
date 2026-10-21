import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import harness2, {
  newRunId,
  parseRunArgs,
  resolveRunDir,
  runHarness,
} from "../src/extension.ts";
import type { HarnessDeps } from "../src/extension.ts";
import { Library } from "../src/library.ts";
import type { ModeResult, RunInput } from "../src/recursion.ts";
import { readTree, writeTree } from "../src/tree.ts";
import type { Tree } from "../src/types.ts";

interface Notification {
  message: string;
  level?: string;
}

interface FakeCtx {
  ui: {notify(message: string, level?: "info" | "warning" | "error"): void};
  notifications: Notification[];
}

interface RegisteredCommand {
  description?: string;
  handler: (args: string, ctx: FakeCtx) => Promise<void>;
}

interface RegisteredTool {
  name: string;
  parameters: {required?: string[]};
  execute: (...a: unknown[]) => unknown;
}

interface FakePi {
  commands: Map<string, RegisteredCommand>;
  tools: Map<string, RegisteredTool>;
  registerCommand(name: string, options: RegisteredCommand): void;
  registerTool(tool: RegisteredTool): void;
}

function fakeCtx(): FakeCtx {
  const notifications: Notification[] = [];
  return {
    notifications,
    ui: {notify: (message, level) => notifications.push({message, level})},
  };
}

function fakePi(): FakePi {
  const pi: FakePi = {
    commands: new Map(),
    tools: new Map(),
    registerCommand: (name, options) => pi.commands.set(name, options),
    registerTool: (tool) => pi.tools.set(tool.name, tool),
  };
  return pi;
}

function asPi(fake: FakePi): Parameters<typeof harness2>[0] {
  return fake as unknown as Parameters<typeof harness2>[0];
}

function tempState(): string {
  return mkdtempSync(join(tmpdir(), "h2-ext-"));
}

function fakeResult(overrides: Partial<ModeResult> = {}): ModeResult {
  return {
    ok: true,
    mode: "parallel",
    k: 1,
    taskSlug: "t",
    stages: [{name: "propose-general-1", ok: true, attempts: 1, costUsd: 0.01, detail: "d"}],
    finalTree: {"systemprompt.md": "NEW PROMPT", "extra.md": "e"},
    best: {label: "general-1", score: 7.5},
    deliverable: "done",
    fellBack: [],
    ...overrides,
  };
}

function runDeps(): {
  deps: Partial<HarnessDeps>;
  captured: () => RunInput | null;
  modeSeen: () => "parallel" | "sequential" | null;
} {
  let captured: RunInput | null = null;
  let modeSeen: "parallel" | "sequential" | null = null;
  const deps: Partial<HarnessDeps> = {
    newRunId: () => "r-20251020-cafe",
    runMode: ((_mode: "parallel" | "sequential", input: RunInput) => {
      modeSeen = _mode;
      captured = input;
      return Promise.resolve(fakeResult({k: input.k, mode: _mode}));
    }) as HarnessDeps["runMode"],
  };
  return {deps, captured: () => captured, modeSeen: () => modeSeen};
}

async function seedHarness(stateDir: string, tree: Tree): Promise<void> {
  mkdirSync(join(stateDir, "harness"), {recursive: true});
  for (const [rel, content] of Object.entries(tree)) {
    const target = join(stateDir, "harness", rel);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, content, "utf8");
  }
}

const SEED: Tree = {
  "systemprompt.md": "SP",
  "guardrails.md": "GR",
  "LongTermMEMORY.md": "",
  "tool_descriptions/tool_guidance.md": "TG",
};

test("newRunId reads r-<yyyymmdd>-<4 hex>", () => {
  assert.match(newRunId(), /^r-\d{8}-[0-9a-f]{4}$/);
});

test("parseRunArgs splits the quoted task from --k/--mode flags", () => {
  assert.deepEqual(parseRunArgs('"multi word task" --k 2 --mode sequential'), {
    task: "multi word task",
    k: 2,
    mode: "sequential",
  });
  assert.deepEqual(parseRunArgs("raw words --k 3"), {task: "raw words", k: 3, mode: undefined});
  assert.throws(() => parseRunArgs("--k 1"), /usage/);
  assert.throws(() => parseRunArgs('"t" --k 0'), /--k/);
  assert.throws(() => parseRunArgs('"t" --k'), /--k expects a value/);
  assert.throws(() => parseRunArgs('"t" --mode both'), /--mode/);
});

test("the factory registers exactly five commands and one tool", () => {
  const pi = fakePi();
  harness2(asPi(pi));
  assert.deepEqual([...pi.commands.keys()].sort(), [
    "h2:adopt",
    "h2:init",
    "h2:report",
    "h2:run",
    "h2:status",
  ]);
  for (const cmd of pi.commands.values()) assert.ok(cmd.description);
  const tool = pi.tools.get("h2_run");
  assert.ok(tool);
  assert.deepEqual(tool.parameters.required, ["task"]);
});

test("runHarness archives report.md, stages.json and final/ under runs/<slug>/<run>", async () => {
  const stateDir = tempState();
  await seedHarness(stateDir, SEED);
  const {deps, captured} = runDeps();
  const outcome = await runHarness({task: "do X", k: 2, mode: "parallel", stateDir}, deps);
  assert.equal(outcome.runId, "r-20251020-cafe");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.finalTreeFiles, 2);
  const input = captured();
  assert.ok(input, "runMode was called once");
  assert.equal(input.task, "do X");
  assert.equal(input.taskSlug, "do-x");
  assert.equal(input.k, 2);
  assert.deepEqual(input.baseTree, SEED);
  assert.deepEqual(input.models, {channel: ""});
  assert.equal(input.wallSeconds, 900);
  assert.equal(input.piBin, "pi");
  // Everything groups under the task slug; the report path shows the grouped layout.
  const runDir = join(stateDir, "runs", "do-x", "r-20251020-cafe");
  assert.equal(outcome.reportPath, join(runDir, "report.md"));
  const report = readFileSync(join(runDir, "report.md"), "utf8");
  assert.ok(report.includes("# harness² run r-20251020-cafe"));
  assert.ok(report.includes("**Best:** general-1 (score 7.5)"));
  assert.equal(readFileSync(join(runDir, "final", "systemprompt.md"), "utf8"), "NEW PROMPT");
  assert.equal(readFileSync(join(runDir, "final", "extra.md"), "utf8"), "e");
  const archived = JSON.parse(readFileSync(join(runDir, "stages.json"), "utf8")) as {ok: boolean};
  assert.equal(archived.ok, true);
  assert.ok(!existsSync(join(stateDir, "runs", "r-20251020-cafe")));
});

test("runHarness refuses to run without a harness tree and points at h2:init", async () => {
  const stateDir = tempState();
  await assert.rejects(() => runHarness({task: "t", stateDir}, {newRunId: () => "r-x"}), /h2:init/);
});

test("h2:init seeds the state tree and config.json, and is idempotent", async () => {
  const pi = fakePi();
  const stateDir = tempState();
  harness2(asPi(pi), {stateDir});
  const ctx = fakeCtx();
  await pi.commands.get("h2:init")!.handler("", ctx);
  const harnessDir = join(stateDir, "harness");
  assert.equal(
    readFileSync(join(harnessDir, "systemprompt.md"), "utf8"),
    "You are a careful professional assistant. " +
      "Work toward the deliverable; verify before claiming done.",
  );
  assert.equal(
    readFileSync(join(harnessDir, "guardrails.md"), "utf8"),
    "- Never fabricate sources, ids, or citations.\n" +
      "- Prefer deterministic helper scripts over repeated manual steps.\n",
  );
  assert.equal(readFileSync(join(harnessDir, "LongTermMEMORY.md"), "utf8"), "");
  assert.equal(readFileSync(join(harnessDir, "tool_descriptions", "tool_guidance.md"), "utf8"), "");
  assert.ok(readFileSync(join(stateDir, "config.json"), "utf8").includes('"wallSeconds": 900'));
  assert.ok(ctx.notifications.at(-1)!.message.includes("created:"));

  const before = readTree(harnessDir);
  const ctx2 = fakeCtx();
  await pi.commands.get("h2:init")!.handler("", ctx2);
  assert.deepEqual(readTree(harnessDir), before);
  const second = ctx2.notifications.at(-1)!.message;
  assert.ok(second.includes("created: nothing"));
  assert.ok(second.includes("skipped"));
});

test("h2:run happy path parses flags, runs the flow and notifies the report", async () => {
  const pi = fakePi();
  const stateDir = tempState();
  harness2(asPi(pi), {stateDir});
  await pi.commands.get("h2:init")!.handler("", fakeCtx());
  const {deps} = runDeps();
  harness2(asPi(pi), {stateDir, deps});
  const ctx = fakeCtx();
  await pi.commands.get("h2:run")!.handler('"fix the flaky test" --k 2 --mode sequential', ctx);
  assert.equal(ctx.notifications[0]!.level, "info");
  assert.ok(ctx.notifications[0]!.message.includes("starting"));
  const last = ctx.notifications.at(-1)!;
  assert.equal(last.level, "info");
  assert.ok(last.message.includes("# harness² run r-20251020-cafe"));
  assert.ok(
    existsSync(
      join(stateDir, "runs", "fix-the-flaky-test", "r-20251020-cafe", "final", "systemprompt.md"),
    ),
  );
});

test("h2:adopt backs up the previous tree once and replaces the harness exactly", async () => {
  const pi = fakePi();
  const stateDir = tempState();
  harness2(asPi(pi), {stateDir});
  await pi.commands.get("h2:init")!.handler("", fakeCtx());
  const finalTree: Tree = {"systemprompt.md": "NEW", "extra.md": "e"};
  const finalDir = join(stateDir, "runs", "demo-task", "r-x", "final");
  mkdirSync(finalDir, {recursive: true});
  writeTree(finalTree, finalDir);
  const beforeTree = readTree(join(stateDir, "harness"));

  // A bare runid resolves through the grouped layout (runs/*/<runid> search).
  const ctx = fakeCtx();
  await pi.commands.get("h2:adopt")!.handler("r-x", ctx);
  const backupDir = join(stateDir, "harness.bak-r-x");
  assert.deepEqual(
    readTree(backupDir),
    beforeTree,
    "the backup preserves the previous tree byte-exactly",
  );
  assert.deepEqual(readTree(join(stateDir, "harness")), finalTree);
  assert.ok(!existsSync(join(stateDir, "harness", "guardrails.md")));
  assert.ok(ctx.notifications.at(-1)!.message.includes("5 file(s) changed"));
  assert.ok(ctx.notifications.at(-1)!.message.includes("1 added, 1 modified, 3 deleted"));

  const backupBefore = readTree(backupDir);
  const ctx2 = fakeCtx();
  await pi.commands.get("h2:adopt")!.handler("demo-task/r-x", ctx2);
  assert.deepEqual(readTree(backupDir), backupBefore, "the backup is one-time");
});

test("resolveRunDir: direct slug/runid hit, bare-runid search hit, guided miss", () => {
  const stateDir = tempState();
  mkdirSync(join(stateDir, "runs", "demo-task", "r-1"), {recursive: true});
  mkdirSync(join(stateDir, "runs", "another", "r-1"), {recursive: true});

  // The direct form is used exactly as given.
  assert.deepEqual(resolveRunDir(stateDir, "demo-task/r-1"), {
    taskSlug: "demo-task",
    runId: "r-1",
    dir: join(stateDir, "runs", "demo-task", "r-1"),
  });

  // A bare runid searches every task slug; sorted order makes the hit deterministic.
  assert.deepEqual(resolveRunDir(stateDir, "r-1"), {
    taskSlug: "another",
    runId: "r-1",
    dir: join(stateDir, "runs", "another", "r-1"),
  });

  // Misses throw actionable guidance, including the pre-grouping flat-layout caveat.
  assert.throws(() => resolveRunDir(stateDir, "r-nope"), /task-slug/);
  assert.throws(() => resolveRunDir(stateDir, "demo-task/r-nope"), /remain on disk/);
  // Flat-layout runs (created before grouping) are not resolved by either form.
  mkdirSync(join(stateDir, "runs", "r-flat"), {recursive: true});
  assert.throws(() => resolveRunDir(stateDir, "r-flat"), /remain on disk/);
  assert.throws(() => resolveRunDir(stateDir, ""), /run reference is required/);
});

test("runHarness threads config.json values into the run input", async () => {
  const stateDir = tempState();
  await seedHarness(stateDir, SEED);
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({channelModel: "vendor/model", k: 3}),
  );
  const {deps, captured, modeSeen} = runDeps();
  await runHarness({task: "t", stateDir}, deps);
  const input = captured();
  assert.ok(input);
  assert.equal(input.models.channel, "vendor/model");
  assert.equal(input.k, 3);
  assert.equal(modeSeen(), "parallel");
});

test("long report notifies summary + path; fell-back runs warn, not claim success", async () => {
  const pi = fakePi();
  const stateDir = tempState();
  await seedHarness(stateDir, SEED);
  const bigStages = Array.from({length: 40}, (_, i) => ({
    name: `stage-${i}`,
    ok: true,
    attempts: 1,
    costUsd: 0.01,
    detail: "x".repeat(40),
  }));
  const deps: Partial<HarnessDeps> = {
    newRunId: () => "r-big",
    runMode: (() =>
      Promise.resolve(
        fakeResult({
          ok: false,
          best: null,
          finalTree: null,
          fellBack: ["general-1"],
          stages: bigStages,
        }),
      )) as HarnessDeps["runMode"],
  };
  harness2(asPi(pi), {stateDir, deps});
  const ctx = fakeCtx();
  await pi.commands.get("h2:run")!.handler('"t"', ctx);
  const last = ctx.notifications.at(-1)!;
  assert.equal(last.level, "warning");
  assert.ok(last.message.includes("Report:"));
  assert.ok(
    !last.message.includes("## Stages"),
    "the oversized report is not pasted into the notification",
  );
});

test("h2:status on an uninitialized state reports nothing yet", async () => {
  const pi = fakePi();
  harness2(asPi(pi), {stateDir: tempState()});
  const ctx = fakeCtx();
  await pi.commands.get("h2:status")!.handler("", ctx);
  const message = ctx.notifications.at(-1)!.message;
  assert.ok(message.includes("none yet"));
  assert.ok(message.includes("library: 0 entries"));
});

test("h2:adopt with an unknown or missing runid reports an error", async () => {
  const pi = fakePi();
  const stateDir = tempState();
  harness2(asPi(pi), {stateDir});
  const ctx = fakeCtx();
  await pi.commands.get("h2:adopt")!.handler("r-nope", ctx);
  assert.equal(ctx.notifications.at(-1)!.level, "error");
  const ctx2 = fakeCtx();
  await pi.commands.get("h2:adopt")!.handler("", ctx2);
  assert.equal(ctx2.notifications.at(-1)!.level, "error");
});

test("h2:status reports the ledger tail and library size", async () => {
  const pi = fakePi();
  const stateDir = tempState();
  harness2(asPi(pi), {stateDir});
  writeFileSync(
    join(stateDir, "ledger.jsonl"),
    `${JSON.stringify({
      ts: "t1",
      mode: "parallel",
      k: 1,
      stage: "propose-general-1",
      ok: true,
      attempts: 1,
      costUsd: 0.5,
      detail: "d",
    })}\n`,
    "utf8",
  );
  new Library(stateDir).add({
    taskSlug: "demo",
    tree: SEED,
    lessons: "learned",
    summary: "demo task",
  });
  const ctx = fakeCtx();
  await pi.commands.get("h2:status")!.handler("", ctx);
  const message = ctx.notifications.at(-1)!.message;
  assert.ok(message.includes("propose-general-1"));
  assert.ok(message.includes("library: 1 entry"));
});

test("h2:report regenerates report.md from archived stages, latest run by default", async () => {
  const pi = fakePi();
  const stateDir = tempState();
  harness2(asPi(pi), {stateDir});
  await seedHarness(stateDir, SEED);
  await runHarness({task: "t", stateDir}, runDeps().deps);
  const reportPath = join(stateDir, "runs", "t", "r-20251020-cafe", "report.md");
  const ctx = fakeCtx();
  await pi.commands.get("h2:report")!.handler("", ctx);
  const report = readFileSync(reportPath, "utf8");
  assert.ok(report.includes("# harness² run r-20251020-cafe"));
  assert.ok(report.includes("## Stages"));
  assert.ok(report.includes("**Best:** general-1 (score 7.5)"));
  assert.ok(ctx.notifications.at(-1)!.message.includes(reportPath));
});

test("h2:report degrades to the ledger tail for runs without archived stages", async () => {
  const pi = fakePi();
  const stateDir = tempState();
  harness2(asPi(pi), {stateDir});
  const runDir = join(stateDir, "runs", "legacy", "r-old");
  mkdirSync(runDir, {recursive: true});
  writeFileSync(
    join(stateDir, "ledger.jsonl"),
    `${JSON.stringify({stage: "compose", ok: false})}\n`,
    "utf8",
  );
  const ctx = fakeCtx();
  await pi.commands.get("h2:report")!.handler("legacy/r-old", ctx);
  const report = readFileSync(join(runDir, "report.md"), "utf8");
  assert.ok(report.includes("# harness² run r-old"));
  assert.ok(report.includes("compose"));
  assert.equal(ctx.notifications.at(-1)!.level, "warning");
});

test("h2:report with an unknown runid reports an error", async () => {
  const pi = fakePi();
  const stateDir = tempState();
  harness2(asPi(pi), {stateDir});
  const ctx = fakeCtx();
  await pi.commands.get("h2:report")!.handler("r-nope", ctx);
  assert.equal(ctx.notifications.at(-1)!.level, "error");
});

test("command handlers catch failures and notify at level error instead of throwing", async () => {
  const pi = fakePi();
  const stateDir = tempState();
  harness2(asPi(pi), {stateDir});
  const ctx = fakeCtx();
  await pi.commands.get("h2:run")!.handler('"t"', ctx);
  assert.equal(ctx.notifications.at(-1)!.level, "error");
  assert.ok(ctx.notifications.at(-1)!.message.includes("h2:run failed"));
  assert.ok(ctx.notifications.at(-1)!.message.includes("h2:init"));
});

test("the h2_run tool runs the same flow and returns a summarizing result", async () => {
  const pi = fakePi();
  const stateDir = tempState();
  await seedHarness(stateDir, SEED);
  const {deps} = runDeps();
  harness2(asPi(pi), {stateDir, deps});
  const ctx = fakeCtx();
  const tool = pi.tools.get("h2_run")!;
  const result = (await tool.execute("call-1", {task: "t"}, undefined, undefined, ctx)) as {
    content: Array<{type: string; text: string}>;
    details: {runId: string; ok: boolean; best: {label: string} | null; finalTreeFiles: number};
    isError?: boolean;
  };
  assert.equal(result.details.runId, "r-20251020-cafe");
  assert.equal(result.details.ok, true);
  assert.equal(result.details.finalTreeFiles, 2);
  assert.equal(result.details.best?.label, "general-1");
  assert.ok(result.content[0]!.text.includes("Report:"));
  assert.ok(existsSync(join(stateDir, "runs", "t", "r-20251020-cafe", "report.md")));
});

test("the h2_run tool reports failures with isError instead of throwing", async () => {
  const pi = fakePi();
  const stateDir = tempState();
  harness2(asPi(pi), {stateDir});
  const tool = pi.tools.get("h2_run")!;
  const result = (await tool.execute("call-1", {task: "t"}, undefined, undefined, fakeCtx())) as {
    content: Array<{text: string}>;
    details: {ok: boolean};
    isError?: boolean;
  };
  assert.equal(result.isError, true);
  assert.equal(result.details.ok, false);
  assert.ok(result.content[0]!.text.includes("h2_run failed"));
});
