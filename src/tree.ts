/** The c1..c8 component tree: read, validate, write, diff — parametrised by SurfaceSpec.
 *
 * Everything that differs between agent frameworks is data on the spec; the shared logic
 * exists once. The edit contract is omitted-is-inherited: a proposal emits only what it
 * changes, and a key emitted as "" is a deletion. PI_SURFACE mirrors the verified pi
 * surface in substrate/pi.py — filenames, caps, and rules are a compatibility contract of
 * the harness² method, not a style choice.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { SurfaceSpec, Tree } from "./types.ts";

export const PI_SURFACE: SurfaceSpec = {
  name: "pi",
  alwaysOn: [
    "systemprompt.md",
    "guardrails.md",
    "LongTermMEMORY.md",
    "tool_descriptions/tool_guidance.md",
  ],
  alwaysOnMax: 24000,
  alwaysOnCapReason:
    "every token here competes with the agent's own output budget: each staged file " +
    "rides in the system prompt via a --append-system-prompt flag",
  skillDir: "skills",
  skillNameRule: "must_match",
  triggerHint:
    "Fix it by adding a trigger line naming `{name}` to systemprompt.md or guardrails.md, " +
    'e.g. "When <the situation this skill handles>, load the `{name}` skill."',
  autotriggerFile: "guardrails.md",
  triggerLine: "- When {desc}, load the `{name}` skill.\n",
  subagentRequiresMode: false,
  pluginDir: ".pi/extensions",
  hooksFile: null,
  stubs: [
    [
      "scripts/README.md",
      "<!-- c7: deterministic helpers, run as `python3 scripts/<name>.py`. " +
        "Add one by emitting scripts/<name>.py. -->\n",
    ],
    [
      "sub_agents/README.md",
      "<!-- c5: delegated subagents defined as pi agent definitions, each running in " +
        "its OWN context. Add one as sub_agents/<name>/AGENT.md with frontmatter " +
        "`description:`. -->\n",
    ],
    [
      ".pi/extensions/README.md",
      "<!-- c8: pi extensions, loaded from .pi/extensions or with `pi -e <path>`. Acts " +
        "INSIDE the tool loop -- the only lever that can enforce something the model " +
        "cannot skip. Add one as .pi/extensions/<name>.ts. -->\n",
    ],
    [
      "skills/README.md",
      "<!-- c6: reusable workflows pi loads on demand. Add one as " +
        "skills/<name>/SKILL.md with frontmatter `name:` matching the directory and a " +
        "`description:`; the staged workspace discovers them at " +
        ".agents/skills/<name>/SKILL.md. -->\n",
    ],
  ],
};

/** Normalise a relative path, rejecting escapes before it is ever joined to a directory.
 * Backslashes count as separators; absolute paths and any ".." segment raise. */
export function normalizeRel(rel: string): string {
  let r = rel.replace(/\\/g, "/").trim();
  if (r.startsWith("/") || r.split("/").includes("..")) {
    throw new Error(`path escapes the harness: ${rel}`);
  }
  while (r.startsWith("./")) r = r.slice(2);
  return r.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** relPath -> content for every regular file under dir, read as UTF-8; keys are
 * POSIX-relative. An absent directory yields {}. Surface membership is a validateTree and
 * staging concern, not a readTree one. */
export function readTree(dir: string): Tree {
  const out: Tree = {};
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  const walk = (abs: string): void => {
    const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out[relative(dir, child).split(sep).join("/")] =
        readFileSync(child, "utf8");
    }
  };
  walk(dir);
  return out;
}

/** Materialise tree entries under dest, creating parent directories as needed.
 *
 * Invariant: "" is the deletion marker of the omitted-is-inherited contract, so empty
 * entries are never written — writing them would resurrect a file the proposal removed.
 * Escaping keys raise (normalizeRel) before any bytes leave dest. */
export function writeTree(tree: Tree, dest: string): void {
  for (const [rel, content] of Object.entries(tree)) {
    if (content === "") continue;
    const safe = normalizeRel(rel);
    const target = join(dest, ...safe.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

/** Every problem with `tree` against `surface`, each a one-line fix in harness2 voice;
 * [] when clean. Checks the always-on cap, the skill frontmatter name rule, path escapes
 * (absolute or any ".." segment), and the plugin extension rule. Probe only clean trees. */
export function validateTree(tree: Tree, surface: SurfaceSpec): string[] {
  const errs: string[] = [];
  const body = surface.alwaysOn.map((a) => tree[a] ?? "").join("\n\n");
  if (body.length > surface.alwaysOnMax) {
    errs.push(
      `always-on content is ${body.length} chars, over the ${surface.alwaysOnMax} cap; ` +
        surface.alwaysOnCapReason,
    );
  }
  errs.push(...checkSkills(tree, surface));
  for (const rel of Object.keys(tree).sort()) {
    try {
      normalizeRel(rel);
    } catch {
      errs.push(`path escapes the harness: ${rel}`);
      continue;
    }
    const badPlugin =
      surface.pluginDir !== null &&
      rel.startsWith(`${surface.pluginDir}/`) &&
      !rel.endsWith(".ts");
    if (badPlugin) {
      errs.push(`${rel}: extensions must be .ts files (${surface.pluginDir}/<name>.ts)`);
    }
  }
  return errs;
}

/** Skill-frontmatter problems under `<skillDir>/<name>/SKILL.md`. Under "must_match" a
 * mismatched `name:` is dropped SILENTLY at load — exactly the failure the proposer
 * cannot see, which is why it is enforced where the proposal is written. */
function checkSkills(tree: Tree, surface: SurfaceSpec): string[] {
  const errs: string[] = [];
  const prefix = `${surface.skillDir}/`;
  const names = new Set<string>();
  for (const rel of Object.keys(tree)) {
    const parts = rel.split("/");
    if (parts.length === 3 && parts[0] === surface.skillDir && parts[2] === "SKILL.md") {
      names.add(parts[1]!);
    }
  }
  for (const name of [...names].sort()) {
    const fm = (tree[`${prefix}${name}/SKILL.md`] ?? "").slice(0, 600);
    const m = fm.match(/^name:\s*(\S+)\s*$/m);
    if (surface.skillNameRule === "must_match") {
      if (!(m && m[1] === name)) {
        errs.push(
          `${prefix}${name}/SKILL.md needs frontmatter \`name: ${name}\` matching its ` +
            `directory (a mismatch is dropped SILENTLY at load)`,
        );
      }
    } else if (m && m[1] !== name) {
      errs.push(
        `${prefix}${name}/SKILL.md frontmatter \`name: ${m[1]}\` OVERRIDES the directory ` +
          `name at load, so every trigger line naming \`${name}\` stops matching; drop ` +
          `the \`name:\` line or make it \`name: ${name}\``,
      );
    }
  }
  return errs;
}

/** 16-hex sha256 prefix over the sorted relPath+content pairs; equal trees fingerprint
 * equal, so a probe's evidence can be tied to the exact bytes that produced it. */
export function fingerprint(tree: Tree): string {
  const h = createHash("sha256");
  for (const rel of Object.keys(tree).sort()) {
    h.update(rel);
    h.update("\0");
    h.update(tree[rel]!);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** The omitted-is-inherited edit from base to candidate: only changed/new keys appear,
 * carrying the candidate content; base keys absent from the candidate appear as "".
 * Applying diffTrees(base, candidate) on top of base reproduces candidate exactly. */
export function diffTrees(base: Tree, candidate: Tree): Tree {
  const out: Tree = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(candidate)]);
  for (const rel of [...keys].sort()) {
    const after = candidate[rel];
    if (after !== base[rel]) out[rel] = after ?? "";
  }
  return out;
}
