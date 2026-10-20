/** The LLM judge: one channel call over a probe's rendered trajectory and extracted
 * deliverable, replacing harness2's per-benchmark graders (nothing in the method grades
 * itself; a run is judged only after it happened).
 *
 * THE INVARIANT (ported from core/judge.py: "a judge failure is None, never a zero"): a
 * judge that could not produce a usable verdict returns verdict "unavailable" with score 0
 * -- and an unavailable judgement is NEVER cached as a zero and NEVER read as a fail. The
 * "unavailable" verdict is the exclusion marker; consumers must filter on it, not on score. */

import { readFileSync } from "node:fs";
import { callChannel } from "./channel.ts";
import { blockText, clip, isRecord } from "./runner.ts";
import type { ChannelReply } from "./types.ts";

/** Verdicts a usable judgement may carry; "unavailable" marks a failed or malformed judge
 * reply and is never a measurement of the run. */
export type Verdict = "pass" | "partial" | "fail" | "unavailable";

/** One judgement of one probe. costUsd is reported even when the judgement is unavailable:
 * a failed judge call still spent money, and the audit trail must show it. */
export interface Judgement {
  verdict: Verdict;
  /** [0, 1]; 0 exactly when verdict is "unavailable" -- see the invariant above. */
  score: number;
  /** Verbatim quotes from the trajectory/deliverable backing the verdict. */
  evidence: string[];
  notes: string;
  costUsd: number;
}

export interface JudgeInput {
  /** The task the probe ran on; what the deliverable is judged against. */
  task: string;
  /** Optional extra criteria, anchored into the judge role. */
  rubric?: string;
  /** The rendered trajectory of the probe run. */
  trajectory: string;
  /** The deliverable text extracted from the probe (its last assistant message). */
  deliverable: string;
  /** Model pattern handed to the channel. */
  model: string;
  /** Wall budget per channel call, in seconds. */
  wallSeconds: number;
  /** pi binary override, passed through to the channel. */
  piBin?: string;
  /** Channel dependency; defaults to callChannel. */
  channel?: typeof callChannel;
}

/** Collapse blank runs and end on one newline. prompts.ts keeps a private copy; the G3
 * brief locks that file to the lens-threading change only, so the two-line helper lives
 * here too rather than widening prompts.ts's surface. */
function tidy(text: string): string {
  return `${text.replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

const MAX_TRAJECTORY_CHARS = 30000;

/** The judge role: anchored rubric, deliverable-only scope, verbatim evidence. */
const JUDGE_SYSTEM = tidy(
  `You are an outcome judge for one agent run.

You judge ONLY the deliverable against the task (and the rubric when one is given). Never
judge style, effort or how the work was done: a correct deliverable produced oddly still
passes, and a polished answer to the wrong task fails.

Anchor the score in [0, 1]:
- pass: score >= 0.8 -- the deliverable does what the task asks.
- partial: score >= 0.4 -- recognisable progress with material gaps.
- fail: below 0.4 -- wrong, incomplete, or unusable.

Every "evidence" entry must quote the trajectory or the deliverable VERBATIM: copy the
exact text, never paraphrase. A machine consumes your reply: return exactly the one JSON
object the OUTPUT CONTRACT describes.`,
);

/** One judge mission: task, rubric, deliverable, clipped trajectory, output contract. */
function buildJudgeMission(input: JudgeInput): string {
  const parts = [
    `# THE TASK\n\n${input.task.trim()}`,
    input.rubric?.trim() ? `# THE RUBRIC\n\n${input.rubric.trim()}` : null,
    `# THE DELIVERABLE\n\n${input.deliverable}`,
    `# THE TRAJECTORY\n\n${clip(input.trajectory, MAX_TRAJECTORY_CHARS)}`,
    tidy(
      `# OUTPUT CONTRACT

Reply with ONE JSON object and nothing else:

    {"verdict": "pass" | "partial" | "fail", "score": 0.0-1.0, "evidence": ["..."], "notes": "..."}

- "verdict": pass, partial or fail, anchored by the system rules.
- "score": one number in [0, 1] consistent with the verdict.
- "evidence": one or more VERBATIM quotes from the trajectory or deliverable.
- "notes": one short paragraph naming what is present and what is missing.`,
    ),
  ];
  return tidy(parts.filter((p) => p !== null).join("\n\n"));
}

const USABLE_VERDICTS = new Set(["pass", "partial", "fail"]);

/** Parse one judge reply. Null when it is not one usable verdict object: unparseable JSON,
 * a verdict outside pass/partial/fail, or a missing/non-finite score. The score is clamped
 * into [0, 1] (documented choice: anchoring is instructed in the system prompt; only the
 * range is enforced here). Non-string evidence entries are dropped, a missing notes is "". */
function parseJudgement(
  text: string,
): {verdict: "pass" | "partial" | "fail"; score: number; evidence: string[]; notes: string} | null {
  if (!text.trim()) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(obj) || Array.isArray(obj)) return null;
  const verdict = obj["verdict"];
  if (typeof verdict !== "string" || !USABLE_VERDICTS.has(verdict)) return null;
  const rawScore = obj["score"];
  if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) return null;
  const score = Math.min(1, Math.max(0, rawScore));
  const evidence = Array.isArray(obj["evidence"])
    ? obj["evidence"].filter((e): e is string => typeof e === "string")
    : [];
  const notes = typeof obj["notes"] === "string" ? obj["notes"] : "";
  return {verdict: verdict as "pass" | "partial" | "fail", score, evidence, notes};
}

/** The exclusion marker of the honesty invariant: score 0 that is NEVER a zero. */
export function unavailableJudgement(note: string, costUsd = 0): Judgement {
  return {verdict: "unavailable", score: 0, evidence: [], notes: note, costUsd};
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Judge one probe: one channel call, parse the reply, and on ANY failure return an
 * "unavailable" judgement with score 0 -- an unavailable judgement is never cached as a
 * zero, mirroring core/judge.py. */
export async function judge(input: JudgeInput): Promise<Judgement> {
  const call = input.channel ?? callChannel;
  let reply: ChannelReply;
  try {
    reply = await call({
      mission: buildJudgeMission(input),
      system: JUDGE_SYSTEM,
      model: input.model,
      wallSeconds: input.wallSeconds,
      piBin: input.piBin,
    });
  } catch (e) {
    return unavailableJudgement(`the judge channel threw: ${errText(e)}`);
  }
  const parsed = reply.ok ? parseJudgement(reply.text) : null;
  if (parsed === null) {
    const why = reply.ok
      ? "the judge reply was not one usable verdict JSON object"
      : "the judge channel produced no parseable reply";
    return unavailableJudgement(why, reply.costUsd);
  }
  return {...parsed, costUsd: reply.costUsd};
}

/** The last assistant message_end text of a pi `--mode json` stream: the probe's
 * deliverable. "" when the stream is missing, unreadable, or holds no assistant text. */
export function extractLastAssistantText(streamPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(streamPath, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i]!.trim();
    if (!s.startsWith("{")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (!isRecord(ev) || ev["type"] !== "message_end") continue;
    const msg = isRecord(ev["message"]) ? ev["message"] : {};
    if (msg["role"] !== "assistant") continue;
    const text = blockText(msg["content"]);
    if (text.trim()) return text;
  }
  return "";
}
