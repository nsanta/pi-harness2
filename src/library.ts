/** The persistent experience library: one directory per task slug under
 * <stateDir>/library, holding the adopted harness tree, its distilled lessons, and an
 * entry record (port of core/library.py's add/tree_of/retain/forget/index, reshaped for a
 * single-domain pi package: no run-tag/mode/domain nesting, explicit index rebuilds).
 *
 * Lesson identity is owned by the wrapper, never the model: emitLesson wraps a reflector's
 * markdown in the stable frontmatter block external consumers read, deriving the verifier
 * from the run's graded outcome alone.
 *
 * Reflection failure is honesty-adjacent here too: the reflector returns "" on any
 * failure, and the caller skips the library add -- a failed reflection is never stored and
 * never fails the run, mirroring the judge's unavailable-is-not-a-zero invariant. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { callChannel } from "./channel.ts";
import { isRecord } from "./runner.ts";
import { buildReflectMission, REFLECT_SYSTEM } from "./prompts.ts";
import { fingerprint, readTree, writeTree } from "./tree.ts";
import type { ChannelReply, Tree } from "./types.ts";

/** One library entry record, as stored in library/<taskSlug>/entry.json. */
export interface LessonEntry {
  taskSlug: string;
  summary: string;
  /** 16-hex fingerprint of the stored tree (tree.ts), tying the entry to exact bytes. */
  fingerprint: string;
  /** ISO timestamp of the add that wrote (or last overwrote) this entry. */
  created: string;
}

/** Filesystem-safe slug: NFKD, lowercase, non-alphanumeric runs -> "-", trimmed to 64
 * chars; an empty result maps to "task". */
export function slugify(task: string): string {
  const s = (task ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return s || "task";
}

let stagingCounter = 0;

export class Library {
  /** <stateDir>/library — one directory per task slug beneath it. */
  readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, "library");
  }

  private entryDir(slug: string): string {
    return join(this.dir, slug);
  }

  /** Store one adopted harness plus its lessons. Overwrites an existing slug atomically:
   * everything is written into a staging directory that is renamed into place, with the
   * previous entry moved aside first and restored if the rename fails. */
  add(entry: {taskSlug: string; tree: Tree; lessons: string; summary: string}): LessonEntry {
    const slug = slugify(entry.taskSlug);
    const rec: LessonEntry = {
      taskSlug: slug,
      summary: entry.summary,
      fingerprint: fingerprint(entry.tree),
      created: new Date().toISOString(),
    };
    mkdirSync(this.dir, {recursive: true});
    const tag = `${Date.now()}-${stagingCounter++}`;
    const staging = join(this.dir, `.staging-${slug}-${tag}`);
    writeTree(entry.tree, join(staging, "harness"));
    writeFileSync(join(staging, "lessons.md"), entry.lessons, "utf8");
    writeFileSync(join(staging, "entry.json"), `${JSON.stringify(rec, null, 2)}\n`, "utf8");
    const target = this.entryDir(slug);
    const retired = `${target}.retired-${tag}`;
    const hadOld = existsSync(target);
    if (hadOld) renameSync(target, retired);
    try {
      renameSync(staging, target);
    } catch (e) {
      if (hadOld) renameSync(retired, target);
      throw e;
    }
    if (hadOld) rmSync(retired, {recursive: true, force: true});
    return rec;
  }

  /** The stored tree of one entry, read back through readTree; null when the entry does
   * not exist. */
  treeOf(taskSlug: string): Tree | null {
    const target = this.entryDir(slugify(taskSlug));
    if (!existsSync(join(target, "entry.json"))) return null;
    return readTree(join(target, "harness"));
  }

  /** The lessons.md content of one entry; null when the entry does not exist. */
  lessonsOf(taskSlug: string): string | null {
    const target = this.entryDir(slugify(taskSlug));
    if (!existsSync(join(target, "lessons.md"))) return null;
    return readFileSync(join(target, "lessons.md"), "utf8");
  }

  /** Every valid entry record, sorted by taskSlug. Invalid or partial records are skipped
   * silently; staging/retired directories are never listed. */
  entries(): LessonEntry[] {
    if (!existsSync(this.dir)) return [];
    const out: LessonEntry[] = [];
    for (const name of readdirSync(this.dir)) {
      if (name.startsWith(".")) continue;
      const path = join(this.dir, name, "entry.json");
      if (!existsSync(path)) continue;
      try {
        const rec: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (
          isRecord(rec) &&
          typeof rec["taskSlug"] === "string" &&
          typeof rec["summary"] === "string" &&
          typeof rec["fingerprint"] === "string" &&
          typeof rec["created"] === "string" &&
          rec["taskSlug"] === name
        ) {
          out.push(rec as unknown as LessonEntry);
        }
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => a.taskSlug.localeCompare(b.taskSlug));
  }

  /** Keep only the listed slugs: delete every entry NOT in the list, return what remains. */
  retain(slugs: string[]): string[] {
    const keep = new Set(slugs.map(slugify));
    return this.forget(this.entries().map((e) => e.taskSlug).filter((s) => !keep.has(s)));
  }

  /** Delete the listed entries (unknown ones are ignored); return the remaining slugs.
   * Unlike core/library.py, the index is NOT rebuilt implicitly: rebuildIndex is explicit
   * in this port, so pruning never surprises a reader mid-inspection. */
  forget(slugs: string[]): string[] {
    for (const raw of slugs) {
      const target = this.entryDir(slugify(raw));
      if (existsSync(target)) rmSync(target, {recursive: true, force: true});
    }
    return this.entries().map((e) => e.taskSlug);
  }

  /** Rewrite library/index.md from disk: one "- <taskSlug>: <summary>" line per entry,
   * slug-sorted. Returns the written text ("" for an empty library). */
  rebuildIndex(): string {
    mkdirSync(this.dir, {recursive: true});
    const body = this.entries().map((e) => `- ${e.taskSlug}: ${e.summary}`).join("\n");
    const text = body ? `${body}\n` : "";
    writeFileSync(join(this.dir, "index.md"), text, "utf8");
    return text;
  }
}

/** Collapse blank runs and end on one newline (same rationale as judge.ts's private copy). */
function tidy(text: string): string {
  return `${text.replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** One lesson to emit: the verdict is the RUN's graded outcome, never model opinion -- it
 * decides the verifier block alone. */
export interface EmitLessonInput {
  taskSlug: string;
  runId: string;
  verdict: "pass" | "partial" | "fail";
  body: string;
  /** Optional ISO 8601 staleness marker; emitted only when provided. */
  staleAfter?: string;
  /** Instant pinned for tests; defaults to now. */
  now?: Date;
}

/** Wrap a reflector's markdown body in the stable frontmatter block external consumers
 * read. Hand-built YAML (no yaml dependency), fixed key order, one ISO instant shared by
 * generated.at and the verifier's at. A pass run verifies the lessons with the archived
 * run record (h2:run/<runId>); partial and fail stay honest and emit NO verifier, which
 * consumers read as the unverified tier. The body is normalized to end on exactly one
 * newline; the model never supplies frontmatter itself (prompts.ts's reflect contract). */
export function emitLesson(input: EmitLessonInput): string {
  const at = (input.now ?? new Date()).toISOString();
  const lines = [
    "type: doc",
    `resource: harness2-lessons-${input.taskSlug}`,
    "status: stable",
    // OKF §5.2 nested mapping — the flat dotted key is a concept name, not YAML syntax;
    // the consumer's catalog reads generated:{by,at} and cannot see the flat form.
    "generated:",
    `  by: "h2:run/${input.runId}"`,
    `  at: ${at}`,
  ];
  if (input.verdict === "pass") {
    lines.push("verified:", `  - by: "h2:run/${input.runId}"`, `    at: ${at}`);
  }
  if (input.staleAfter !== undefined) {
    lines.push(`stale_after: ${input.staleAfter}`);
  }
  return `---\n${lines.join("\n")}\n---\n${tidy(input.body)}`;
}

export interface ReflectInput {
  /** The task the run worked on. */
  task: string;
  /** The rendered trajectory of the run's best execution. */
  trajectory: string;
  /** The final harness tree the lessons are about. */
  tree: Tree;
  /** Model pattern handed to the channel. */
  model: string;
  /** Wall budget per channel call, in seconds. */
  wallSeconds: number;
  /** pi binary override, passed through to the channel. */
  piBin?: string;
  /** Channel dependency; defaults to callChannel. */
  channel?: typeof callChannel;
}

/** Distill one run's lessons. NEVER throws and NEVER returns a fake answer: on a channel
 * error, an unparseable reply, or a non-string "lessons" it returns "" -- reflection
 * failure is not an error, and the caller skips the library add (the judge's honesty
 * invariant, mirrored). */
export async function reflect(input: ReflectInput): Promise<string> {
  const call = input.channel ?? callChannel;
  let reply: ChannelReply;
  try {
    reply = await call({
      mission: buildReflectMission(input),
      system: REFLECT_SYSTEM,
      model: input.model,
      wallSeconds: input.wallSeconds,
      piBin: input.piBin,
    });
  } catch {
    return "";
  }
  if (!reply.ok) return "";
  try {
    const obj: unknown = JSON.parse(reply.text);
    if (isRecord(obj) && typeof obj["lessons"] === "string") return obj["lessons"];
  } catch {
    // fall through to the empty return
  }
  return "";
}
