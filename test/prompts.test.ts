import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVIDENCE_BOUNDARY,
  FORBIDDEN_WORDS,
  SURFACE_DOC,
  VERSION,
  buildComposeMission,
  buildProposeMission,
  buildProposeSystem,
  leakGuard,
} from "../src/prompts.ts";
import { PI_SURFACE } from "../src/tree.ts";
import type { Tree } from "../src/types.ts";

test("leakGuard catches the five measurement words case-insensitively, passes clean text", () => {
  const dirty =
    "The BENCHMARK defines an Evaluation; a GRADER applies the Rubric and the final SCORE decides.";
  assert.deepEqual(leakGuard(dirty), FORBIDDEN_WORDS);
  assert.deepEqual(leakGuard("Score it twice, then re-score"), ["score"]);
  assert.deepEqual(leakGuard("reconcile the ledger and write the summary"), []);
  assert.equal(VERSION, "harness2-1");
});

test("buildProposeMission throws listing violations when the task names measurement", () => {
  assert.throws(
    () =>
      buildProposeMission({
        task: "sort the rubric rows",
        baseTree: {},
        candidates: [],
      }),
    (err: unknown) => err instanceof Error && /rubric/.test(err.message),
  );
});

test("buildProposeMission embeds the boundary, every base file fenced, every label", () => {
  const baseTree: Tree = {
    "systemprompt.md": "Be terse.",
    "guardrails.md": "- No secrets in artifacts.\n",
  };
  const mission = buildProposeMission({
    task: "reconcile the ledger",
    baseTree,
    candidates: [
      { label: "cand-1", trajectory: "run one: read the ledger, wrote the table" },
      { label: "cand-2", trajectory: "run two: stalled on a parse error" },
    ],
    experience: "when two sources disagree, the ledger wins",
  });
  assert.ok(mission.includes(EVIDENCE_BOUNDARY));
  assert.ok(mission.includes("# INVARIANT EDIT"));
  assert.ok(mission.includes("# DOMAIN EDIT"));
  assert.ok(mission.includes('"edits"'));
  assert.ok(mission.includes("## systemprompt.md") && mission.includes("Be terse."));
  assert.ok(mission.includes("## guardrails.md"));
  assert.ok(mission.includes("- No secrets in artifacts."));
  assert.ok(mission.includes("## cand-1") && mission.includes("run one"));
  assert.ok(mission.includes("## cand-2") && mission.includes("run two"));
  assert.ok(mission.includes("EXPERIENCE FROM EARLIER TASKS"));
});

test("buildComposeMission carries the keep-base discipline and each candidate's edits", () => {
  const mission = buildComposeMission({
    task: "reconcile the ledger",
    baseTree: { "a.md": "one", "b.md": "two" },
    candidates: [
      { label: "cand-7", edits: { "a.md": "one!", "b.md": "" }, trajectory: "run: fast" },
    ],
  });
  assert.ok(mission.includes("KEEP_BASE"));
  assert.ok(mission.includes("inherited"));
  assert.ok(mission.includes("## cand-7"));
  assert.ok(mission.includes("one!") && mission.includes("DELETED BY THIS CANDIDATE"));
});

test("buildProposeSystem embeds the surface doc, the cap number and the trigger rule", () => {
  const system = buildProposeSystem(PI_SURFACE);
  assert.ok(system.startsWith("You are a harness editor."));
  assert.ok(system.includes(SURFACE_DOC));
  assert.ok(system.includes(String(PI_SURFACE.alwaysOnMax)));
  assert.ok(system.includes(PI_SURFACE.alwaysOnCapReason));
  assert.ok(system.includes(PI_SURFACE.autotriggerFile));
  assert.ok(system.includes("load the `<name>` skill"));
});
