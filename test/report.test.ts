import assert from "node:assert/strict";
import { test } from "node:test";
import { renderRunReport } from "../src/report.ts";
import type { ModeResult, Stage } from "../src/recursion.ts";
import type { Tree } from "../src/types.ts";

const STAGES: Stage[] = [
  {name: "propose-general-1", ok: true, attempts: 1, costUsd: 0.0123, detail: "notes | here"},
  {name: "judge-general-1", ok: false, attempts: 1, costUsd: 0, detail: "unavailable\nafter retry"},
];

const RESULT: ModeResult = {
  ok: true,
  mode: "parallel",
  k: 1,
  stages: STAGES,
  finalTree: {"guardrails.md": "xy", "skills/README.md": "z", "systemprompt.md": "abc"},
  best: {label: "general-1", score: 8},
  deliverable: "did the thing",
  fellBack: ["domain-1"],
};

const BASE: Tree = {"systemprompt.md": "ab", "guardrails.md": "xy", "obsolete.md": "gone"};

const INPUT = {
  runId: "r-20251020-cafe",
  mode: "parallel",
  k: 1,
  stages: STAGES,
  result: RESULT,
  task: "Fix the flaky login test",
};

test("renderRunReport is a deterministic markdown document", () => {
  const expected = [
    "# harness² run r-20251020-cafe",
    "",
    "**Task:** Fix the flaky login test",
    "**Mode:** parallel (k=1)",
    "**Outcome:** ok — 2 stage(s), $0.012300 total",
    "**Best:** general-1 (score 8)",
    "",
    "## Final tree",
    "",
    "- guardrails.md: 2 chars",
    "- skills/README.md: 1 chars",
    "- systemprompt.md: 3 chars",
    "",
    "## Stages",
    "",
    "| stage | ok | attempts | costUsd | detail |",
    "| --- | --- | --- | --- | --- |",
    "| propose-general-1 | yes | 1 | 0.012300 | notes \\| here |",
    "| judge-general-1 | no | 1 | 0.000000 | unavailable after retry |",
    "",
    "## Fell back",
    "",
    "- domain-1",
    "",
    "## Changed files vs base",
    "",
    "- obsolete.md: deleted",
    "- skills/README.md: added (+1 chars)",
    "- systemprompt.md: modified: 2 -> 3 chars",
    "",
  ].join("\n");
  assert.equal(renderRunReport({...INPUT, baseTree: BASE}), expected);
});

test("renderRunReport is stable across calls (no timestamps, no ordering drift)", () => {
  const a = renderRunReport({...INPUT, baseTree: BASE});
  const b = renderRunReport({...INPUT, baseTree: BASE});
  assert.equal(a, b);
});

test("the changed-files section is skipped when no base tree is derivable", () => {
  const report = renderRunReport(INPUT);
  assert.ok(report.includes("# harness² run r-20251020-cafe"));
  assert.ok(!report.includes("Changed files vs base"));
});

test("a run without a final tree or best candidate reports it honestly", () => {
  const report = renderRunReport({
    ...INPUT,
    result: {...RESULT, ok: false, finalTree: null, best: null, fellBack: []},
  });
  assert.ok(report.includes("**Outcome:** fell back"));
  assert.ok(report.includes("**Best:** none"));
  assert.ok(report.includes("No final tree: the run produced nothing to adopt."));
  assert.ok(report.includes("None — every slot produced usable evidence."));
});

test("stage detail cells escape pipes and newlines so the table stays intact", () => {
  const report = renderRunReport(INPUT);
  assert.ok(report.includes("notes \\| here"));
  const judgeRow = report.split("\n").find((l) => l.startsWith("| judge-general-1 |"));
  assert.ok(judgeRow?.includes("unavailable after retry"));
});
