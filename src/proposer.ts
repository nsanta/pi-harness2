/** Propose/compose orchestration over the one-shot channel: mission + system -> channel call ->
 * JSON schema check -> surface validation, with exactly ONE proposer-level retry carrying the
 * violation list back as feedback (port of Proposer.call plus the validate_tree retry loop).
 *
 * Attempts and cost accumulate across every channel call; the final failure surfaces as a
 * ProposerError carrying the audit (attempts, costUsd, lastViolations). */

import { callChannel } from "./channel.ts";
import { isRecord } from "./runner.ts";
import { PI_SURFACE, validateTree } from "./tree.ts";
import type { ChannelReply, Tree } from "./types.ts";
import {
  buildComposeMission,
  buildProposeMission,
  buildProposeSystem,
  type ComposeMissionInput,
  type ProposeMissionInput,
} from "./prompts.ts";

/** A proposal did not produce a usable, surface-valid reply. Carries the audit trail:
 * channel calls made, their summed cost, and the violation list of the last failed reply. */
export class ProposerError extends Error {
  /** Channel calls consumed (the one retry included). */
  attempts: number;
  /** Summed reply cost across those calls, in USD. */
  costUsd: number;
  /** Problems of the last rejected reply: schema faults and/or validateTree violations. */
  lastViolations: string[];

  constructor(message: string, attempts: number, costUsd: number, lastViolations: string[]) {
    super(message);
    this.name = "ProposerError";
    this.attempts = attempts;
    this.costUsd = costUsd;
    this.lastViolations = lastViolations;
  }
}

/** Everything propose() needs: the mission input plus channel options. `channel` defaults to
 * callChannel; tests inject a fake to stay offline. */
export type ProposeInput = ProposeMissionInput & {
  /** Model pattern handed to the channel. */
  model: string;
  /** Wall budget per channel call, in seconds. */
  wallSeconds: number;
  /** pi binary override, passed through to the channel. */
  piBin?: string;
  /** Channel dependency; defaults to callChannel. */
  channel?: typeof callChannel;
};

/** What propose() returns: the accepted edits exactly as proposed (already a Tree), the
 * model's one-paragraph rationale, and the audit. */
export interface ProposeResult {
  edits: Tree;
  notes: string;
  attempts: number;
  costUsd: number;
}

/** Everything compose() needs: the compose mission input plus the same channel options. */
export type ComposeInput = ComposeMissionInput & {
  model: string;
  wallSeconds: number;
  piBin?: string;
  channel?: typeof callChannel;
};

/** What compose() returns: the merged tree (base + accepted edits, "" applied as delete). */
export interface ComposeResult {
  tree: Tree;
  notes: string;
  attempts: number;
  costUsd: number;
}

/** A JSON object that is not an array (runner.isRecord also accepts arrays). */
function isJsonObject(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && !Array.isArray(v);
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Schema-check one channel reply against the output contract. Null `edits` means rejected,
 * with `problems` listing every fault; a missing or non-string "notes" is tolerated as "". */
function parseEdits(
  reply: ChannelReply,
): { problems: string[]; edits: Tree | null; notes: string } {
  const fail = (problems: string[]): { problems: string[]; edits: Tree | null; notes: string } => ({
    problems,
    edits: null,
    notes: "",
  });
  if (!reply.ok || !reply.text.trim()) {
    return fail(["the channel produced no parseable reply"]);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(reply.text);
  } catch {
    return fail(["the reply is not one JSON object (it did not parse)"]);
  }
  if (!isJsonObject(obj)) return fail(["the reply is not one JSON object"]);
  if (!isJsonObject(obj["edits"])) {
    return fail(['"edits" is missing or is not a relpath -> content object']);
  }
  const edits = obj["edits"];
  const bad = Object.entries(edits)
    .filter(([, v]) => typeof v !== "string")
    .map(([k]) => k);
  if (bad.length > 0) {
    return fail([`"edits" values must be strings (non-string values at: ${bad.join(", ")})`]);
  }
  return {
    problems: [],
    edits: edits as unknown as Tree,
    notes: typeof obj["notes"] === "string" ? obj["notes"] : "",
  };
}

/** Apply omit-is-inherited edits onto base: set every non-empty entry, "" deletes the key. */
function applyEdits(base: Tree, edits: Tree): Tree {
  const merged: Tree = { ...base };
  for (const [rel, content] of Object.entries(edits)) {
    if (content === "") delete merged[rel];
    else merged[rel] = content;
  }
  return merged;
}

const FEEDBACK_HEAD =
  "# RETRY FEEDBACK\n\n" +
  "Your previous reply was rejected. Fix every problem listed and reply again with exactly " +
  "the one JSON object the mission's OUTPUT CONTRACT requires:\n";

function listProblems(problems: string[]): string {
  return problems.map((p) => `- ${p}`).join("\n");
}

/** Shared propose/compose flow: up to two channel calls; the retry appends the rejection
 * reasons to the system prompt. `validate` returns the surface violations of the proposal. */
async function runEdits(
  mission: string,
  opts: Pick<ProposeInput, "model" | "wallSeconds" | "piBin" | "channel">,
  validate: (edits: Tree) => string[],
): Promise<{ payload: Tree; notes: string; attempts: number; costUsd: number }> {
  const call = opts.channel ?? callChannel;
  const baseSystem = buildProposeSystem(PI_SURFACE);
  let spent = 0;
  let feedback = "";
  let lastViolations: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const system = attempt === 1 ? baseSystem : `${baseSystem}\n\n${FEEDBACK_HEAD}${feedback}`;
    const reply = await call({
      mission,
      system,
      model: opts.model,
      wallSeconds: opts.wallSeconds,
      piBin: opts.piBin,
    });
    spent += reply.costUsd;
    const parsed = parseEdits(reply);
    const problems = parsed.edits === null ? parsed.problems : validate(parsed.edits);
    if (problems.length === 0) {
      const payload = parsed.edits!;
      return { payload, notes: parsed.notes, attempts: attempt, costUsd: round6(spent) };
    }
    lastViolations = problems;
    feedback = listProblems(problems);
  }
  throw new ProposerError(
    `harness proposal rejected after 2 attempts: ${lastViolations.join(" | ")}`,
    2,
    round6(spent),
    lastViolations,
  );
}

/** One propose round: build the mission, call the channel, schema-check, validate the edits
 * against PI_SURFACE, retrying once with the violation list as feedback. */
export async function propose(input: ProposeInput): Promise<ProposeResult> {
  const mission = buildProposeMission(input);
  const out = await runEdits(mission, input, (edits) => validateTree(edits, PI_SURFACE));
  return { edits: out.payload, notes: out.notes, attempts: out.attempts, costUsd: out.costUsd };
}

/** One compose round: same flow with the compose mission; the reply's edits are normalized by
 * merging onto the base tree ("" deletes) and the MERGED tree is what gets validated. */
export async function compose(input: ComposeInput): Promise<ComposeResult> {
  const mission = buildComposeMission(input);
  const merged = (edits: Tree): Tree => applyEdits(input.baseTree, edits);
  const validate = (edits: Tree): string[] => validateTree(merged(edits), PI_SURFACE);
  const out = await runEdits(mission, input, validate);
  return {
    tree: merged(out.payload),
    notes: out.notes,
    attempts: out.attempts,
    costUsd: out.costUsd,
  };
}
