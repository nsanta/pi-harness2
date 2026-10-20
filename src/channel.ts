/** One-shot model channel: proposer/reflector/composer calls run as separate headless
 * `pi --print` processes, never the interactive session. Carries the Proposer contract:
 * a wall timeout, exactly one retry, cost accounting, and JSON repair over the
 * `--mode json` event stream (Proposer.call/_parse_json ported onto the pi substrate).
 */

import { spawn } from "node:child_process";
import { blockText, isRecord } from "./runner.ts";
import type { ChannelReply } from "./types.ts";

export interface CallChannelOptions {
  /** The mission: what the one-shot session must produce. Final positional argument. */
  mission: string;
  /** System instructions, passed through the native `--system-prompt` flag (it REPLACES
   * the default system prompt; deliberately never `--append-system-prompt` here). */
  system: string;
  /** Model pattern handed to --model. */
  model: string;
  /** Wall budget per attempt, in seconds. */
  wallSeconds: number;
  /** Working directory for the one-shot process. */
  cwd?: string;
  /** pi binary override; tests point this at the offline stub. */
  piBin?: string;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** One spawn of argv: resolves {code, stdout} on close. The wall SIGTERMs the child so a
 * hung session degrades into a retryable failure instead of a hang; a spawn failure
 * resolves with code null, which counts as a failed attempt. */
function runOnce(
  argv: string[],
  wallMs: number,
  cwd?: string,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const [bin = "pi", ...args] = argv;
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const wall = setTimeout(() => child.kill("SIGTERM"), wallMs);
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wall);
      resolve({ code, stdout });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

/** usage.cost.total from one usage record, or 0 when the shape is not what the docs
 * promise. */
function usageCost(usage: unknown): number {
  if (!isRecord(usage) || !isRecord(usage["cost"])) return 0;
  const t = usage["cost"]["total"];
  return typeof t === "number" ? t : 0;
}

/** Sum `usage.cost.total` over every event of a `--mode json` capture. pi reports usage
 * at the top level of message_update events and on the message of message_end events
 * (never both on one event); events without a numeric total contribute zero. */
export function costUsdOf(stdout: string): number {
  let total = 0;
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (!isRecord(ev)) continue;
    const msgUsage = isRecord(ev["message"]) ? ev["message"]["usage"] : undefined;
    total += usageCost(ev["usage"]) + usageCost(msgUsage);
  }
  return total;
}

/** Extract the model's one JSON object from a `pi --mode json` stdout capture.
 *
 * Assistant text wins: message_end assistant text blocks are gathered and joined, then
 * the first balanced {...} object is extracted by a string-aware brace scan, so code
 * fences and prose around the object are tolerated. With no parseable events the raw
 * text is treated as the assistant text (banner tolerance, as in Proposer._parse_json).
 * Returns null when nothing parses; never throws. */
export function parsePiJson(stdout: string): string | null {
  const texts: string[] = [];
  for (const line of (stdout ?? "").split("\n")) {
    const s = line.trim();
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
    const txt = blockText(msg["content"]);
    if (txt.trim()) texts.push(txt);
  }
  const source = texts.length > 0 ? texts.join("\n") : (stdout ?? "");
  return firstBalancedJson(source);
}

/** The first balanced {...} in s that also JSON.parses; candidates that balance but do
 * not parse are skipped past. Null when none survives. */
function firstBalancedJson(s: string): string | null {
  for (let i = s.indexOf("{"); i !== -1; i = s.indexOf("{", i + 1)) {
    const end = balancedEnd(s, i);
    if (end === -1) continue;
    const candidate = s.slice(i, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Index of the } closing the { at `open`, honoring string literals and escapes; -1 when
 * unbalanced. A backslash inside a string escapes the next character, whatever it is. */
function balancedEnd(s: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** One channel call. Retries exactly once on nonzero exit, wall timeout, or an
 * unparseable reply — 2 attempts total, and `attempts` reports the truth. costUsd
 * accumulates across attempts; raw is the last attempt's stdout: the audit trail. */
export async function callChannel(opts: CallChannelOptions): Promise<ChannelReply> {
  const argv = [
    opts.piBin ?? "pi",
    "--print",
    "--mode",
    "json",
    "--no-extensions",
    "--approve",
    "--model",
    opts.model,
    "--system-prompt",
    opts.system,
    opts.mission,
  ];
  let spent = 0;
  let lastRaw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { code, stdout } = await runOnce(argv, opts.wallSeconds * 1000, opts.cwd);
    lastRaw = stdout;
    spent += costUsdOf(stdout);
    if (code !== 0) continue;
    const text = parsePiJson(stdout);
    if (text === null) continue;
    return { ok: true, text, costUsd: round6(spent), raw: stdout, attempts: attempt };
  }
  return { ok: false, text: "", costUsd: round6(spent), raw: lastRaw, attempts: 2 };
}
