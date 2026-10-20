import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Library } from "../src/library.ts";
import { runMode, runParallel, runSequential, type RecursionDeps } from "../src/recursion.ts";
import type { ComposeInput, ProposeInput } from "../src/proposer.ts";
import type { ReflectInput } from "../src/library.ts";
import type { JudgeInput } from "../src/judge.ts";
import type { ProbeResult, Tree } from "../src/types.ts";

const BASE: Tree = {"systemprompt.md": "base\n"};

/** A fake headless probe: writes a one-line assistant stream into the workspace run dir so
 * the real renderer and deliverable extractor run over genuine artifacts. */
function probeWriter(): RecursionDeps["runProbe"] {
  return async (opts): Promise<ProbeResult> => {
    const runDir = join(opts.workspace, "runs", opts.runId);
    mkdirSync(runDir, {recursive: true});
    const text = `done ${opts.runId}`;
    writeFileSync(
      join(runDir, "stream.jsonl"),
      `${JSON.stringify({
        type: "message_end",
        message: {role: "assistant", content: [{type: "text", text}]},
      })}\n`,
      "utf8",
    );
    return {runDir, streamPath: join(runDir, "stream.jsonl"), exitCode: 0};
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "h2-rec-"));
}

const INPUT = (root: string, deps: Partial<RecursionDeps>) => ({
  task: "summarize invoices",
  k: 1,
  baseTree: BASE,
  stateDir: root,
  models: {channel: "m"},
  wallSeconds: 5,
  deps,
});

test("runParallel k=1: both lenses proposed, compose sees only anonymized labels", async () => {
  const root = tmpRoot();
  try {
    const proposeCalls: ProposeInput[] = [];
    const composeCalls: ComposeInput[] = [];
    const reflectCalls: ReflectInput[] = [];
    const deps: Partial<RecursionDeps> = {
      propose: async (input: ProposeInput) => {
        proposeCalls.push(input);
        return {
          edits: {[`edit-${input.lens}.md`]: `content for ${input.lens}\n`},
          notes: `note ${input.lens}`,
          attempts: 1,
          costUsd: 0.01,
        };
      },
      compose: async (input: ComposeInput) => {
        composeCalls.push(input);
        return {
          tree: {...input.baseTree, "composed.md": "yes\n"},
          notes: "merged",
          attempts: 1,
          costUsd: 0.02,
        };
      },
      runProbe: probeWriter(),
      judge: async (input: JudgeInput) => {
        const domain = input.trajectory.includes("domain");
        return {
          verdict: domain ? "pass" : "partial",
          score: domain ? 0.9 : 0.6,
          evidence: ["[ASSISTANT] done"],
          notes: "",
          costUsd: 0.005,
        };
      },
      reflect: async (input: ReflectInput) => {
        reflectCalls.push(input);
        return "# shared lesson";
      },
    };
    const res = await runParallel(INPUT(root, deps));

    assert.equal(res.ok, true);
    assert.equal(res.mode, "parallel");
    assert.equal(res.k, 1);
    // k=1 builds exactly two slots: one general, one domain, each proposed under its lens.
    assert.deepEqual(
      proposeCalls.map((c) => c.lens),
      ["general", "domain"],
    );
    assert.deepEqual(
      proposeCalls[0]!.candidates.map((c) => c.label),
      [],
    );
    // The composed tree is exactly what compose returned; the composition is not probed.
    assert.deepEqual(res.finalTree, {...BASE, "composed.md": "yes\n"});
    assert.equal(composeCalls.length, 1);

    // Anonymization: the composer saw candidate ids, never "general"/"domain", and the
    // ids follow score order (domain, the 0.9, first).
    const composed = composeCalls[0]!.candidates;
    assert.deepEqual(
      composed.map((c) => c.label),
      ["candidate-1", "candidate-2"],
    );
    for (const c of composed) {
      assert.ok(!c.label.includes("general") && !c.label.includes("domain"));
    }
    assert.ok(composed[0]!.edits["edit-domain.md"]!.includes("domain"));
    assert.ok(composed[1]!.edits["edit-general.md"]!.includes("general"));

    // Best is the higher-scored candidate under its internal slot name.
    assert.deepEqual(res.best, {label: "domain-1", score: 0.9});
    assert.ok(res.deliverable.includes("domain-1"));

    // Streams archived into stateDir BEFORE the workspace was removed.
    const runDirs = readdirSync(join(root, "runs")).sort();
    assert.equal(runDirs.length, 2);
    for (const d of runDirs) {
      assert.ok(existsSync(join(root, "runs", d, "stream.jsonl")));
      assert.ok(existsSync(join(root, "runs", d, "trajectory.md")));
      const rendered = readFileSync(join(root, "runs", d, "trajectory.md"), "utf8");
      assert.ok(rendered.includes("[ASSISTANT]"));
    }

    // Ledger: 2 propose + 2 probe + 2 judge + 1 compose + 1 reflect, all ok.
    const rows = readFileSync(join(root, "ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(rows.length, 8);
    assert.ok(rows.every((r) => r["ok"] === true));
    assert.ok(rows.some((r) => r["stage"] === "compose"));

    // Reflection ran on the best candidate's trajectory and stored the composed tree.
    assert.equal(reflectCalls.length, 1);
    assert.ok(reflectCalls[0]!.trajectory.includes("domain"));
    const lib = new Library(root);
    assert.deepEqual(
      lib.entries().map((e) => e.taskSlug),
      ["summarize-invoices"],
    );
    assert.equal(lib.lessonsOf("summarize-invoices"), "# shared lesson");
    assert.deepEqual(lib.treeOf("summarize-invoices"), {...BASE, "composed.md": "yes\n"});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("runSequential k=2: a lower score is not adopted; the final tree is step 1's", async () => {
  const root = tmpRoot();
  try {
    const proposeCalls: ProposeInput[] = [];
    const reflectCalls: ReflectInput[] = [];
    const deps: Partial<RecursionDeps> = {
      propose: async (input: ProposeInput) => {
        proposeCalls.push(input);
        const n = proposeCalls.length;
        return {
          edits: {[`step${n}.md`]: `edit ${n}\n`},
          notes: `n${n}`,
          attempts: 1,
          costUsd: 0.01,
        };
      },
      compose: async () => {
        throw new Error("compose is never used in sequential mode");
      },
      runProbe: probeWriter(),
      judge: async (input: JudgeInput) => {
        const first = input.trajectory.includes("step1");
        return {verdict: "pass", score: first ? 0.8 : 0.3, evidence: [], notes: "", costUsd: 0.004};
      },
      reflect: async (input: ReflectInput) => {
        reflectCalls.push(input);
        return "# lesson";
      },
    };
    const res = await runSequential({
      task: "audit contracts",
      k: 2,
      baseTree: BASE,
      stateDir: root,
      models: {channel: "m"},
      wallSeconds: 5,
      deps,
    });

    assert.equal(res.ok, true);
    assert.equal(res.mode, "sequential");
    assert.equal(proposeCalls.length, 2);
    // Step 1 proposes against the base with no previous-best; step 2 carries both the
    // adopted tree and the previous-best trajectory as evidence.
    assert.deepEqual(proposeCalls[0]!.candidates, []);
    assert.deepEqual(proposeCalls[1]!.candidates.map((c) => c.label), ["previous-best"]);
    assert.ok(proposeCalls[1]!.baseTree["step1.md"]);
    assert.ok(proposeCalls[1]!.candidates[0]!.trajectory.includes("step1"));

    // Step 2 scored lower: current tree stays step 1's merge.
    assert.deepEqual(res.finalTree, {...BASE, "step1.md": "edit 1\n"});
    assert.ok(res.finalTree && !("step2.md" in res.finalTree));
    assert.deepEqual(res.best, {label: "step-1", score: 0.8});
    assert.ok(res.deliverable.includes("step1"));

    // Stages per step-part, plus the reflect stage.
    const names = res.stages.map((s) => s.name);
    for (const n of [
      "step-1-propose",
      "step-1-probe",
      "step-1-judge",
      "step-2-propose",
      "step-2-probe",
      "step-2-judge",
      "reflect",
    ]) {
      assert.ok(names.includes(n), `missing stage ${n}`);
    }
    const step2 = res.stages.find((s) => s.name === "step-2-judge")!;
    assert.ok(step2.detail!.includes("0.3") && step2.detail!.includes("kept current"));

    // Reflection ran on the adopted (step 1) trajectory and tree only.
    assert.equal(reflectCalls.length, 1);
    assert.ok(reflectCalls[0]!.trajectory.includes("step1"));
    assert.ok(!("step2.md" in reflectCalls[0]!.tree));
    assert.equal(new Library(root).entries().length, 1);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("a throwing reflector never fails the run; it records ok false", async () => {
  const root = tmpRoot();
  try {
    const deps: Partial<RecursionDeps> = {
      propose: async () => ({edits: {"only.md": "x\n"}, notes: "", attempts: 1, costUsd: 0}),
      compose: async () => {
        throw new Error("unused in sequential mode");
      },
      runProbe: probeWriter(),
      judge: async () => ({verdict: "pass", score: 0.9, evidence: [], notes: "", costUsd: 0}),
      reflect: async () => {
        throw new Error("reflector down");
      },
    };
    const res = await runSequential(INPUT(root, deps));
    assert.equal(res.ok, true); // the run itself succeeded
    const refl = res.stages.find((s) => s.name === "reflect")!;
    assert.ok(refl);
    assert.equal(refl.ok, false);
    assert.ok(refl.detail!.includes("reflector down"));
    assert.ok(!existsSync(join(root, "library"))); // nothing half-stored
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("runParallel with every proposal rejected: ok false, fellBack lists slots", async () => {
  const root = tmpRoot();
  try {
    const deps: Partial<RecursionDeps> = {
      propose: async () => {
        throw new Error("channel down");
      },
      compose: async () => {
        throw new Error("unreachable: no candidates");
      },
      runProbe: probeWriter(),
      judge: async () => ({verdict: "fail", score: 0.1, evidence: [], notes: "", costUsd: 0}),
      reflect: async () => "# x",
    };
    const res = await runParallel(INPUT(root, deps));
    assert.equal(res.ok, false);
    assert.deepEqual(res.fellBack, ["general-1", "domain-1"]);
    assert.equal(res.best, null);
    assert.equal(res.finalTree, null);
    assert.equal(res.deliverable, "");
    // Nothing was composed, so there is nothing to reflect on or store.
    assert.ok(!res.stages.some((s) => s.name === "reflect"));
    assert.ok(!existsSync(join(root, "library")));
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("an unavailable judgement is excluded from compose, not treated as a zero", async () => {
  const root = tmpRoot();
  try {
    const composeCalls: ComposeInput[] = [];
    const deps: Partial<RecursionDeps> = {
      propose: async (input: ProposeInput) => ({
        edits: {[`edit-${input.lens}.md`]: `c ${input.lens}\n`},
        notes: "",
        attempts: 1,
        costUsd: 0,
      }),
      compose: async (input: ComposeInput) => {
        composeCalls.push(input);
        return {tree: BASE, notes: "", attempts: 1, costUsd: 0};
      },
      runProbe: probeWriter(),
      judge: async (input: JudgeInput) => {
        if (!input.trajectory.includes("domain")) {
          return {verdict: "pass", score: 0.5, evidence: [], notes: "", costUsd: 0.01};
        }
        // The domain judgement FAILED: unavailable, never a zero, never a fail.
        return {
          verdict: "unavailable",
          score: 0,
          evidence: [],
          notes: "no parseable reply",
          costUsd: 0.01,
        };
      },
      reflect: async () => "",
    };
    const res = await runParallel(INPUT(root, deps));
    // The domain candidate's judge failed; only the graded general candidate composes.
    assert.deepEqual(
      composeCalls[0]!.candidates.map((c) => c.label),
      ["candidate-1"],
    );
    assert.ok(composeCalls[0]!.candidates[0]!.edits["edit-general.md"]);
    assert.deepEqual(res.best, {label: "general-1", score: 0.5});
    assert.equal(res.ok, true);
    const judgeRow = res.stages.find((s) => s.name === "judge-domain-1")!;
    assert.equal(judgeRow.ok, false); // recorded as a failed judge stage, honestly
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("runMode dispatches both modes and rejects unknown ones", async () => {
  const root = tmpRoot();
  try {
    const deps: Partial<RecursionDeps> = {
      propose: async () => {
        throw new Error("no channel");
      },
      compose: async () => {
        throw new Error("unreachable");
      },
      runProbe: probeWriter(),
      judge: async () => ({verdict: "fail", score: 0, evidence: [], notes: "", costUsd: 0}),
      reflect: async () => "",
    };
    const seq = await runMode("sequential", INPUT(root, deps));
    assert.equal(seq.mode, "sequential");
    const par = await runMode("parallel", {...INPUT(root, deps), stateDir: root});
    assert.equal(par.mode, "parallel");
    assert.throws(() => runMode("bogus" as "parallel", INPUT(root, deps)), /exactly two/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
