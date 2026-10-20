/** Shared types for the pi-harness2 harness² port (group G1+). */

/** The c1..c8 tree: harness-relative POSIX path -> file content.
 *
 * The edit contract is omitted-is-inherited: proposals carry only changed keys, and a key
 * emitted as "" is a deletion, never an empty file. */
export type Tree = Record<string, string>;

/** The editable surface of one agent framework: paths, caps and per-surface rules. */
export interface SurfaceSpec {
  /** Surface name; identifies the harness kind in reports and fingerprints. */
  name: string;
  /** Harness-relative files staged into every probe's system prompt, in this order. */
  alwaysOn: string[];
  /** Hard cap on joined always-on characters; enforced by validateTree. */
  alwaysOnMax: number;
  /** Why the cap exists; surfaced verbatim in cap violations. */
  alwaysOnCapReason: string;
  /** Directory holding c6 skills, e.g. "skills". */
  skillDir: string;
  /** Frontmatter rule for SKILL.md: "must_match" requires `name:` to equal the directory. */
  skillNameRule: string;
  /** Hint appended when a skill is never named in the always-on text. */
  triggerHint: string;
  /** Always-on file that receives autotrigger lines. */
  autotriggerFile: string;
  /** Autotrigger line template; {name} and {desc} are substituted. */
  triggerLine: string;
  /** Whether sub_agents need frontmatter `mode: subagent`. */
  subagentRequiresMode: boolean;
  /** Directory of c8 extension files, or null when the framework has none. */
  pluginDir: string | null;
  /** Hooks schema file, or null when the framework has no hooks. */
  hooksFile: string | null;
  /** [relPath, body] seeds so a fresh harness shows the proposer every lever. */
  stubs: Array<[string, string]>;
}

/** One one-shot channel call: what came back, what it cost, how hard it tried. */
export interface ChannelReply {
  /** Whether a usable, parseable reply was produced. */
  ok: boolean;
  /** The extracted JSON text; "" when ok is false. */
  text: string;
  /** Summed usage.cost.total across all events and attempts, in USD. */
  costUsd: number;
  /** Raw stdout of the last attempt: the audit trail. */
  raw: string;
  /** Attempts consumed: 1 on first-try success, 2 after the single retry. */
  attempts: number;
}

/** One headless probe: where its artifacts landed and how the child exited. */
export interface ProbeResult {
  /** <workspace>/runs/<runId>/ — holds stream.jsonl and stderr.log. */
  runDir: string;
  /** The probe's JSONL event stream. */
  streamPath: string;
  /** Child exit code; null when the wall timeout killed it or it failed to spawn. */
  exitCode: number | null;
}

/** Render budgets for the trajectory grammar. */
export interface TrajectoryOptions {
  /** Per-observation clip in characters. */
  obsTrunc: number;
  /** Total output clip; the suffix names how many characters were dropped. */
  maxChars: number;
  /** Per-action args-JSON clip in characters. */
  argsTrunc: number;
}
