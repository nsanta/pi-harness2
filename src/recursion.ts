/** The Propose–Probe–Compose recursion engine (port of core/recursion.py's run_parallel /
 * run_sequential, narrowed to the pi-harness2 method: no benchmark adapters, the LLM judge
 * replaces grader verdicts, and there is one composition per run whose final judgement is
 * the CLI's concern (G4), never probed here).
 *
 * Honesty invariants carried over:
 * - an "unavailable" judgement is never a zero: it excludes its candidate from composition
 *   and from the best-so-far adoption, exactly like core/judge.py's None;
 * - reflection failure never fails the run: it records a reflect stage with ok:false;
 * - compose candidates are anonymized ("candidate-1..n") before the composer sees them.
 *
 * All model-touching steps (propose/compose/runProbe/judge/reflect) are injectable for
 * offline tests and default to the real implementations. */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractLastAssistantText, judge, unavailableJudgement, type Judgement } from "./judge.ts";
import { Library, reflect, slugify } from "./library.ts";
import { compose, propose, ProposerError } from "./proposer.ts";
import { renderTrajectory, runProbe, stageWorkspace } from "./runner.ts";
import { anonIds, orderGradedFirst, poolSlots } from "./selection.ts";
import { PI_SURFACE } from "./tree.ts";
import type { ProbeResult, TrajectoryOptions, Tree } from "./types.ts";

/** One recorded step of a run. costUsd is the audit truth even when ok is false. */
export interface Stage {
  name: string;
  ok: boolean;
  attempts: number;
  costUsd: number;
  detail?: string;
}

/** What one mode run concluded. `best.label` is the internal slot name (e.g. "domain-1"),
 * never the anonymized id: anon ids exist only inside the compose mission. */
export interface ModeResult {
  ok: boolean;
  mode: "parallel" | "sequential";
  k: number;
  stages: Stage[];
  finalTree: Tree | null;
  best: {label: string; score: number} | null;
  deliverable: string;
  fellBack: string[];
}

/** The headless-probe dependency, mirroring runner.ts's RunProbeOptions (minus the wall,
 * which the runner defaults): stage-independent so tests write a fake stream instead. */
export type RunProbeDep = (opts: {
  workspace: string;
  promptPath: string;
  runId: string;
  model: string;
  piBin?: string;
}) => Promise<ProbeResult>;

/** Everything the engine needs from the outside. `reflect` is a fifth, optional-in-spirit
 * seam added beyond the four named in the brief: the required offline test "reflect failure
 * does not fail the run" needs a throwing seam, and the real reflect never throws. */
export interface RecursionDeps {
  propose: typeof propose;
  compose: typeof compose;
  runProbe: RunProbeDep;
  judge: typeof judge;
  reflect: typeof reflect;
}

function defaultDeps(): RecursionDeps {
  return {propose, compose, runProbe, judge, reflect};
}

/** One mode run's input. stateDir is explicit (G4 wires the <cwd>/.harness2 default). */
export interface RunInput {
  /** The work to adapt the harness for. */
  task: string;
  /** Slots per lens (parallel) or steps (sequential). */
  k: number;
  /** The tree every proposal starts from. */
  baseTree: Tree;
  /** Accumulated experience text, folded into parallel proposals and the compose mission. */
  experience?: string;
  /** State root: ledger.jsonl, archived runs, and the library live beneath it. */
  stateDir: string;
  /** Model pattern for channel calls (and probes' --model). */
  models: {channel: string};
  /** Wall budget per channel call, in seconds. */
  wallSeconds: number;
  /** pi binary override, passed through everywhere. */
  piBin?: string;
  /** Dependency overrides; each defaults to the real implementation. */
  deps?: Partial<RecursionDeps>;
}

/** Omit-is-inherited merge onto base (proposer.ts keeps a private copy; the G3 brief locks
 * that file to the lens-threading change only, so the semantics are replicated here):
 * non-empty values set, "" deletes. */
function applyEdits(base: Tree, edits: Tree): Tree {
  const merged: Tree = {...base};
  for (const [rel, content] of Object.entries(edits)) {
    if (content === "") delete merged[rel];
    else merged[rel] = content;
  }
  return merged;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stage(
  name: string,
  ok: boolean,
  attempts: number,
  costUsd: number,
  detail: string,
): Stage {
  return {name, ok, attempts, costUsd, detail};
}

function proposerAudit(e: unknown): {attempts: number; costUsd: number} {
  if (e instanceof ProposerError) return {attempts: e.attempts, costUsd: e.costUsd};
  return {attempts: 0, costUsd: 0};
}

/** Append one JSON line per stage to <stateDir>/ledger.jsonl. */
function appendLedger(stateDir: string, mode: string, k: number, stages: Stage[]): void {
  mkdirSync(stateDir, {recursive: true});
  for (const s of stages) {
    const row = {
      ts: new Date().toISOString(),
      mode,
      k,
      stage: s.name,
      ok: s.ok,
      attempts: s.attempts,
      costUsd: s.costUsd,
      detail: s.detail ?? "",
    };
    appendFileSync(join(stateDir, "ledger.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
  }
}

const PROBE_RENDER: TrajectoryOptions = {obsTrunc: 50000, maxChars: 100000, argsTrunc: 4000};

export interface ProbeOutcome {
  trajectory: string;
  deliverable: string;
  streamPath: string;
  exitCode: number | null;
}

/** Probe one candidate tree on the task in a throwaway mkdtemp workspace: stage the tree,
 * write the task prompt at <ws>/tasks/<runId>.md, run the headless child, render the
 * trajectory, and extract the deliverable (last assistant text). When stateDir is set,
 * stream.jsonl and trajectory.md are archived to <stateDir>/runs/<runId>/ BEFORE the
 * workspace is removed; the workspace is always removed, success or not. */
export async function probe(
  input: {task: string; model: string; piBin?: string; stateDir?: string; runProbe: RunProbeDep},
  tree: Tree,
  runId: string,
): Promise<ProbeOutcome> {
  const ws = mkdtempSync(join(tmpdir(), "h2-probe-"));
  try {
    stageWorkspace(tree, PI_SURFACE, ws);
    const tasksDir = join(ws, "tasks");
    mkdirSync(tasksDir, {recursive: true});
    const promptPath = join(tasksDir, `${runId}.md`);
    writeFileSync(promptPath, input.task, "utf8");
    const res = await input.runProbe({
      workspace: ws,
      promptPath,
      runId,
      model: input.model,
      piBin: input.piBin,
    });
    const trajectory = renderTrajectory(res.streamPath, PROBE_RENDER);
    const deliverable = extractLastAssistantText(res.streamPath);
    if (input.stateDir) {
      const archive = join(input.stateDir, "runs", runId);
      mkdirSync(archive, {recursive: true});
      if (existsSync(res.streamPath)) copyFileSync(res.streamPath, join(archive, "stream.jsonl"));
      writeFileSync(join(archive, "trajectory.md"), trajectory, "utf8");
    }
    return {trajectory, deliverable, streamPath: res.streamPath, exitCode: res.exitCode};
  } finally {
    rmSync(ws, {recursive: true, force: true});
  }
}

interface Candidate {
  /** Internal slot name, e.g. "general-1"; never shown to the composer. */
  name: string;
  edits: Tree;
  trajectory: string;
  deliverable: string;
  judgement: Judgement;
}

const isGraded = (c: Candidate): boolean => c.judgement.verdict !== "unavailable";

/** Reflect on the adopted tree and store it in the library. Best-effort by contract: a
 * thrown reflector records a reflect stage with ok:false; empty lessons skip the add; and
 * with no judged trajectory at all there is nothing to reflect on, so nothing runs. */
async function reflectAndStore(
  input: RunInput,
  deps: RecursionDeps,
  result: ModeResult,
  trajectory: string,
): Promise<void> {
  if (result.finalTree === null || !trajectory) return;
  try {
    const lessons = await deps.reflect({
      task: input.task,
      trajectory,
      tree: result.finalTree,
      model: input.models.channel,
      wallSeconds: input.wallSeconds,
      piBin: input.piBin,
    });
    if (lessons) {
      new Library(input.stateDir).add({
        taskSlug: slugify(input.task),
        tree: result.finalTree,
        lessons,
        summary: input.task.slice(0, 100),
      });
      result.stages.push(stage("reflect", true, 1, 0, "lessons stored"));
    } else {
      result.stages.push(stage("reflect", true, 1, 0, "no lessons; library skipped"));
    }
  } catch (e) {
    result.stages.push(stage("reflect", false, 0, 0, errText(e)));
  }
}

/** WIDTH: k general + k domain candidates from shared evidence, one composition over the
 * graded ones. ok requires at least one judged candidate AND a successful compose. */
export async function runParallel(input: RunInput): Promise<ModeResult> {
  const deps: RecursionDeps = {...defaultDeps(), ...input.deps};
  const {task, k, baseTree, stateDir, models, wallSeconds, piBin} = input;
  const stages: Stage[] = [];
  const fellBack: string[] = [];
  const candidates: Candidate[] = [];
  const slots = poolSlots(k);
  for (let i = 0; i < slots.length; i++) {
    const variant = slots[i]!.variant;
    // Per-variant index (general-1..k, domain-1..k), matching the Python label convention.
    const idx = (i % k) + 1;
    const name = `${variant}-${idx}`;
    const runId = `${randomUUID().slice(0, 8)}-${variant}-${idx}`;
    let candidateTree: Tree;
    let proposedEdits: Tree;
    try {
      const p = await deps.propose({
        task,
        baseTree,
        candidates: input.experience ? [{label: "experience", trajectory: input.experience}] : [],
        lens: variant,
        model: models.channel,
        wallSeconds,
        piBin,
      });
      stages.push(stage(`propose-${name}`, true, p.attempts, p.costUsd, p.notes));
      proposedEdits = p.edits;
      candidateTree = applyEdits(baseTree, p.edits);
    } catch (e) {
      const {attempts, costUsd} = proposerAudit(e);
      stages.push(stage(`propose-${name}`, false, attempts, costUsd, errText(e)));
      fellBack.push(name);
      continue;
    }
    let outcome: ProbeOutcome;
    try {
      outcome = await probe(
        {task, model: models.channel, piBin, stateDir, runProbe: deps.runProbe},
        candidateTree,
        runId,
      );
      stages.push(stage(`probe-${name}`, outcome.exitCode === 0, 1, 0, `exit ${outcome.exitCode}`));
    } catch (e) {
      stages.push(stage(`probe-${name}`, false, 0, 0, errText(e)));
      fellBack.push(name);
      continue;
    }
    let judgement: Judgement;
    try {
      judgement = await deps.judge({
        task,
        trajectory: outcome.trajectory,
        deliverable: outcome.deliverable,
        model: models.channel,
        wallSeconds,
        piBin,
      });
    } catch (e) {
      judgement = unavailableJudgement(errText(e));
    }
    stages.push(
      stage(
        `judge-${name}`,
        judgement.verdict !== "unavailable",
        1,
        judgement.costUsd,
        `${judgement.verdict} ${judgement.score}`,
      ),
    );
    candidates.push({
      name,
      edits: proposedEdits,
      trajectory: outcome.trajectory,
      deliverable: outcome.deliverable,
      judgement,
    });
  }
  // Stable score sort (ties keep slot order), then graded-first: the top of the result is
  // the best JUDGED candidate, and "unavailable" candidates are excluded from compose --
  // they are not zeros, they are absent evidence.
  const byScore = [...candidates].sort((a, b) => b.judgement.score - a.judgement.score);
  const top = orderGradedFirst(byScore, isGraded).filter(isGraded);
  let finalTree: Tree | null = null;
  if (top.length > 0) {
    const ids = anonIds(top.length);
    try {
      const comp = await deps.compose({
        task,
        baseTree,
        candidates: top.map((c, i) => ({label: ids[i]!, edits: c.edits, trajectory: c.trajectory})),
        experience: input.experience,
        model: models.channel,
        wallSeconds,
        piBin,
      });
      stages.push(stage("compose", true, comp.attempts, comp.costUsd, comp.notes));
      finalTree = comp.tree;
    } catch (e) {
      const {attempts, costUsd} = proposerAudit(e);
      stages.push(stage("compose", false, attempts, costUsd, errText(e)));
      fellBack.push("compose");
    }
  }
  const best = top[0];
  const result: ModeResult = {
    ok: top.length > 0 && finalTree !== null,
    mode: "parallel",
    k,
    stages,
    finalTree,
    best: best ? {label: best.name, score: best.judgement.score} : null,
    deliverable: best?.deliverable ?? "",
    fellBack,
  };
  await reflectAndStore(input, deps, result, best?.trajectory ?? "");
  appendLedger(stateDir, "parallel", k, result.stages);
  return result;
}

/** DEPTH: k propose–probe–judge steps carrying the refined tree and the previous best's
 * trajectory as evidence. A step adopts only when its judgement is graded AND beats the
 * previous best; otherwise the current tree is kept and the decision recorded. On the
 * FIRST step there is no baseline judgement, so any graded candidate adopts over the
 * unjudged base; comparison is strict (>). ok means at least one judged candidate was
 * adopted. */
export async function runSequential(input: RunInput): Promise<ModeResult> {
  const deps: RecursionDeps = {...defaultDeps(), ...input.deps};
  const {task, k, baseTree, stateDir, models, wallSeconds, piBin} = input;
  const stages: Stage[] = [];
  const fellBack: string[] = [];
  let current: Tree = {...baseTree};
  let priorBest: {label: string; score: number; trajectory: string; deliverable: string} | null =
    null;
  for (let stepNo = 1; stepNo <= k; stepNo++) {
    const lens: "general" | "domain" = stepNo % 2 === 0 ? "general" : "domain";
    const name = `step-${stepNo}`;
    const runId = `${randomUUID().slice(0, 8)}-step${stepNo}`;
    let candidateTree: Tree;
    try {
      const p = await deps.propose({
        task,
        baseTree: current,
        candidates: priorBest ? [{label: "previous-best", trajectory: priorBest.trajectory}] : [],
        lens,
        model: models.channel,
        wallSeconds,
        piBin,
      });
      stages.push(stage(`${name}-propose`, true, p.attempts, p.costUsd, p.notes));
      candidateTree = applyEdits(current, p.edits);
    } catch (e) {
      const {attempts, costUsd} = proposerAudit(e);
      stages.push(stage(`${name}-propose`, false, attempts, costUsd, errText(e)));
      fellBack.push(`${name}:${lens}`);
      continue;
    }
    let outcome: ProbeOutcome;
    try {
      outcome = await probe(
        {task, model: models.channel, piBin, stateDir, runProbe: deps.runProbe},
        candidateTree,
        runId,
      );
      stages.push(stage(`${name}-probe`, outcome.exitCode === 0, 1, 0, `exit ${outcome.exitCode}`));
    } catch (e) {
      stages.push(stage(`${name}-probe`, false, 0, 0, errText(e)));
      fellBack.push(`${name}:${lens}`);
      continue;
    }
    let judgement: Judgement;
    try {
      judgement = await deps.judge({
        task,
        trajectory: outcome.trajectory,
        deliverable: outcome.deliverable,
        model: models.channel,
        wallSeconds,
        piBin,
      });
    } catch (e) {
      judgement = unavailableJudgement(errText(e));
    }
    const adopt =
      judgement.verdict !== "unavailable" &&
      (priorBest === null || judgement.score > priorBest.score);
    stages.push(
      stage(
        `${name}-judge`,
        judgement.verdict !== "unavailable",
        1,
        judgement.costUsd,
        `${judgement.verdict} ${judgement.score} ${adopt ? "adopted" : "kept current"}`,
      ),
    );
    if (adopt) {
      current = candidateTree;
      priorBest = {
        label: name,
        score: judgement.score,
        trajectory: outcome.trajectory,
        deliverable: outcome.deliverable,
      };
    }
  }
  const result: ModeResult = {
    ok: priorBest !== null,
    mode: "sequential",
    k,
    stages,
    finalTree: current,
    best: priorBest ? {label: priorBest.label, score: priorBest.score} : null,
    deliverable: priorBest?.deliverable ?? "",
    fellBack,
  };
  await reflectAndStore(input, deps, result, priorBest?.trajectory ?? "");
  appendLedger(stateDir, "sequential", k, result.stages);
  return result;
}

/** Dispatch on the mode token; exactly two modes exist. */
export function runMode(mode: "parallel" | "sequential", input: RunInput): Promise<ModeResult> {
  if (mode === "parallel") return runParallel(input);
  if (mode === "sequential") return runSequential(input);
  throw new Error(`unknown mode ${String(mode)}; the method has exactly two: parallel, sequential`);
}
