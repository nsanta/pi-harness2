import assert from "node:assert/strict";
import { test } from "node:test";
import { PI_SURFACE, diffTrees, fingerprint, validateTree } from "../src/tree.ts";
import type { Tree } from "../src/types.ts";

test("validateTree reports every violation class", () => {
  const tree: Tree = {
    "systemprompt.md": "be brief",
    "guardrails.md": "x".repeat(PI_SURFACE.alwaysOnMax + 1),
    "skills/alpha/SKILL.md": "---\nname: beta\ndescription: does things\n---\nbody",
    "../escape.md": "nope",
    "/abs.md": "nope",
    ".pi/extensions/tool.js": "// wrong extension",
  };
  const errs = validateTree(tree, PI_SURFACE);
  assert.ok(
    errs.some((e) => e.includes("over the 24000 cap") && e.includes(PI_SURFACE.alwaysOnCapReason)),
  );
  assert.ok(errs.some((e) => e.includes("skills/alpha/SKILL.md") && e.includes("`name: alpha`")));
  assert.ok(errs.some((e) => e.includes("path escapes the harness") && e.includes("../escape.md")));
  assert.ok(errs.some((e) => e.includes("path escapes the harness") && e.includes("/abs.md")));
  assert.ok(errs.some((e) => e.includes(".pi/extensions/tool.js") && e.includes(".ts")));
});

test("validateTree accepts a clean tree", () => {
  const tree: Tree = {
    "systemprompt.md": "be brief",
    "guardrails.md": "- When the user asks for tests, load the `tests` skill.\n",
    "skills/tests/SKILL.md": "---\nname: tests\ndescription: write tests\n---\ngo",
    "scripts/helper.py": "print('hi')\n",
    ".pi/extensions/log.ts": "export const x = 1;\n",
  };
  assert.deepEqual(validateTree(tree, PI_SURFACE), []);
});

test("fingerprint is stable per content and moves on any edit", () => {
  const t1: Tree = { "a.md": "one", "b/c.md": "two" };
  const t1again: Tree = { "b/c.md": "two", "a.md": "one" };
  assert.equal(fingerprint(t1), fingerprint(t1again));
  assert.match(fingerprint(t1), /^[0-9a-f]{16}$/);
  assert.notEqual(fingerprint(t1), fingerprint({ ...t1, "b/c.md": "two!" }));
});

test("diffTrees emits omit-is-inherited edits, deletions as empty strings", () => {
  const base: Tree = { "a.md": "one", "b.md": "two", "c.md": "three" };
  const cand: Tree = { "a.md": "one", "b.md": "two!", "d.md": "four" };
  assert.deepEqual(diffTrees(base, cand), { "b.md": "two!", "c.md": "", "d.md": "four" });
  assert.deepEqual(diffTrees(base, { ...base }), {});
});
