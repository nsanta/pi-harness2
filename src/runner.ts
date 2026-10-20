/** Headless probe execution: the verified pi argv contract, workspace staging, and the
 * JSONL event-stream → trajectory renderer.
 *
 * Two compatibility contracts live here, both verified against pi 1.3.0 and mirrored from
 * substrate/pi.py; do not improvise them:
 *  - argv: `pi --print --mode json --no-extensions --session-dir <ws>/sessions --session-id
 *    <id> --approve --model <m>` plus one `--append-system-prompt <file>` per staged
 *    always-on file, with the task prompt path ALWAYS last.
 *  - grammar: `[ACTION] name(<args>)`, `[OBSERVATION] <text>`, `[ERROR] <text>` on error,
 *    `[ASSISTANT] <text>`, clipped with the `…(+N chars — render truncation)` suffix.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PI_SURFACE } from "./tree.ts";
import type { ProbeResult, SurfaceSpec, TrajectoryOptions, Tree } from "./types.ts";

export interface PiLaunchOptions {
  /** Staged probe workspace; doubles as the child's cwd and session storage root. */
  workspace: string;
  /** Task prompt file passed as the final argv element. */
  promptPath: string;
  /** pi session id for this probe. */
  runId: string;
  /** Model pattern handed to --model. */
  model: string;
  /** pi binary override; tests point this at the offline stub. */
  piBin?: string;
}

/** Pure argv builder for one headless probe. Always-on files are read from the staged
 * workspace and only existing ones become flags, so a half-staged file can never reach
 * the system prompt; the prompt path is appended last, unconditionally. */
export function piLaunchArgv(opts: PiLaunchOptions): string[] {
  const argv = [
    opts.piBin ?? "pi",
    "--print",
    "--mode",
    "json",
    "--no-extensions",
    "--session-dir",
    join(opts.workspace, "sessions"),
    "--session-id",
    opts.runId,
    "--approve",
    "--model",
    opts.model,
  ];
  for (const rel of PI_SURFACE.alwaysOn) {
    const p = join(opts.workspace, ...rel.split("/"));
    if (existsSync(p)) argv.push("--append-system-prompt", p);
  }
  argv.push(opts.promptPath);
  return argv;
}

/** Stage the candidate tree into a probe workspace: always-on files and scripts/ land
 * as-is, skills/<name>/* is relocated to <dest>/.agents/skills/<name>/* where pi discovers
 * skills, and .pi/extensions/*.ts lands as-is. Off-surface keys are ignored; "" entries
 * (the deletion marker) are never materialised. */
export function stageWorkspace(tree: Tree, surface: SurfaceSpec, dest: string): void {
  for (const [rel, content] of Object.entries(tree)) {
    if (content === "") continue;
    const target = rel.startsWith(`${surface.skillDir}/`)
      ? join(dest, ".agents", rel)
      : join(dest, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

export interface RunProbeOptions extends PiLaunchOptions {
  /** Wall budget in seconds; the child is SIGTERMed (then SIGKILLed) when it elapses. */
  wallSeconds?: number;
}

/** Run one headless probe with cwd=workspace, streaming the child's stdout into
 * <runDir>/stream.jsonl and stderr into <runDir>/stderr.log. pi has no timeout flag, so
 * the wall is enforced here; a killed run resolves with exitCode null and never rejects. */
export function runProbe(opts: RunProbeOptions): Promise<ProbeResult> {
  const wallSeconds = opts.wallSeconds ?? 600;
  const runDir = join(opts.workspace, "runs", opts.runId);
  const streamPath = join(runDir, "stream.jsonl");
  mkdirSync(runDir, { recursive: true });
  const argv = piLaunchArgv(opts);
  const [bin = "pi", ...args] = argv;
  return new Promise((resolve) => {
    const out = openSync(streamPath, "w");
    const err = openSync(join(runDir, "stderr.log"), "w");
    const child = spawn(bin, args, { cwd: opts.workspace, stdio: ["ignore", out, err] });
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const wall = setTimeout(() => {
      child.kill("SIGTERM");
      grace = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, wallSeconds * 1000);
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      if (grace !== undefined) clearTimeout(grace);
      closeSync(out);
      closeSync(err);
      resolve({ runDir, streamPath, exitCode });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

const TRUNC_FMT = "…(+{n} chars — render truncation)";

/** The grammar's clip: NUL-stripped text cut to n characters with a suffix naming the
 * drop; n <= 0 disables clipping. Exported for reuse across renderers. */
export function clip(text: string, n: number): string {
  const s = (text ?? "").replace(/\x00/g, "");
  if (n <= 0 || s.length <= n) return s;
  return s.slice(0, n) + TRUNC_FMT.replace("{n}", String(s.length - n));
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** The text blocks of a pi message/tool content value; non-text blocks are dropped. */
export function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block["type"] === "text" && block["text"]) {
        parts.push(String(block["text"]));
      }
    }
  }
  return parts.join("\n");
}

/** The observation text of a tool_execution_end result, defensive across pi versions:
 * a string result passes through, a dict renders its text blocks or, failing that, its
 * JSON, and anything else is stringified. */
function resultText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (isRecord(result)) return blockText(result["content"]) || JSON.stringify(result);
  return String(result);
}

/** Render pi's `--mode json` JSONL event stream into the shared grammar. The session
 * header carries no grammar line. Parsing is defensive because the event schema can vary
 * across pi versions; input with no parseable events renders as a single fallback line. */
export function renderTrajectory(streamPath: string, opts: TrajectoryOptions): string {
  let raw: string;
  try {
    raw = readFileSync(streamPath, "utf8");
  } catch (e) {
    return `(failed to read trajectory: ${String(e)})`;
  }
  const lines: string[] = [];
  for (const ln of raw.split("\n")) {
    const line = ln.trim();
    if (!line.startsWith("{")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(ev)) continue;
    const etype = ev["type"];
    if (etype === "tool_execution_start") {
      const name = typeof ev["toolName"] === "string" ? ev["toolName"] : "tool";
      const args =
        ev["args"] === undefined || ev["args"] === null ? "" : JSON.stringify(ev["args"]);
      lines.push(`[ACTION] ${name}(${clip(args, opts.argsTrunc)})`);
    } else if (etype === "tool_execution_end") {
      const text = resultText(ev["result"]);
      lines.push(`${ev["isError"] ? "[ERROR]" : "[OBSERVATION]"} ${clip(text, opts.obsTrunc)}`);
    } else if (etype === "message_end") {
      const msg = isRecord(ev["message"]) ? ev["message"] : {};
      if (msg["role"] === "assistant") {
        const txt = blockText(msg["content"]);
        if (txt.trim()) lines.push(`[ASSISTANT] ${clip(txt, opts.obsTrunc)}`);
      }
    }
  }
  let rendered = lines.join("\n").trim();
  if (!rendered) return "(no parseable events in trajectory)";
  if (rendered.length > opts.maxChars) {
    rendered =
      rendered.slice(0, opts.maxChars) +
      "\n" +
      TRUNC_FMT.replace("{n}", String(rendered.length - opts.maxChars));
  }
  return rendered;
}
