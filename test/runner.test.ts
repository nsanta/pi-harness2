import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { piLaunchArgv, renderTrajectory, runProbe, stageWorkspace } from "../src/runner.ts";
import { PI_SURFACE } from "../src/tree.ts";
import type { Tree } from "../src/types.ts";

const STUB = fileURLToPath(new URL("./fixtures/stub-pi.mjs", import.meta.url));

// The stub is executed through its shebang, so Windows cannot spawn it directly. The case
// that needs it is skipped there instead of left failing; everything else still runs.
const stubSkip =
  process.platform === "win32" ? "the offline stub is a POSIX shebang script" : false;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("piLaunchArgv emits the verified argv contract with the prompt last", () => {
  const ws = tempDir("h2-argv-");
  try {
    mkdirSync(join(ws, "tool_descriptions"), { recursive: true });
    writeFileSync(join(ws, "systemprompt.md"), "sp");
    writeFileSync(join(ws, "guardrails.md"), "gr");
    const promptPath = join(ws, "tasks", "t1.md");
    const opts = { workspace: ws, promptPath, runId: "t1", model: "m", piBin: "stub-pi" };
    const argv = piLaunchArgv(opts);
    assert.deepEqual(argv, [
      "stub-pi",
      "--print",
      "--mode",
      "json",
      "--no-extensions",
      "--session-dir",
      join(ws, "sessions"),
      "--session-id",
      "t1",
      "--approve",
      "--model",
      "m",
      "--append-system-prompt",
      join(ws, "systemprompt.md"),
      "--append-system-prompt",
      join(ws, "guardrails.md"),
      promptPath,
    ]);
    assert.equal(argv[argv.length - 1], promptPath);
    assert.equal(argv.filter((a) => a === "--append-system-prompt").length, 2);

    unlinkSync(join(ws, "guardrails.md"));
    const dropped = piLaunchArgv(opts);
    assert.equal(dropped.filter((a) => a === "--append-system-prompt").length, 1);
    assert.ok(!dropped.includes(join(ws, "guardrails.md")));
    assert.equal(dropped[dropped.length - 1], promptPath);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("stageWorkspace relocates skills and plugins, stages always-on and scripts as-is", () => {
  const ws = tempDir("h2-stage-");
  const dest = join(ws, "staged");
  try {
    const tree: Tree = {
      "systemprompt.md": "sp",
      "guardrails.md": "gr",
      "skills/alpha/SKILL.md": "---\nname: alpha\n---\nbody",
      "scripts/run.sh": "echo hi\n",
      ".pi/extensions/extra.ts": "export const x = 1;\n",
    };
    stageWorkspace(tree, PI_SURFACE, dest);
    assert.equal(readFileSync(join(dest, "systemprompt.md"), "utf8"), "sp");
    assert.equal(readFileSync(join(dest, "guardrails.md"), "utf8"), "gr");
    assert.equal(
      readFileSync(join(dest, ".agents", "skills", "alpha", "SKILL.md"), "utf8"),
      "---\nname: alpha\n---\nbody",
    );
    assert.equal(readFileSync(join(dest, "scripts", "run.sh"), "utf8"), "echo hi\n");
    assert.equal(
      readFileSync(join(dest, ".pi", "extensions", "extra.ts"), "utf8"),
      "export const x = 1;\n",
    );
    assert.ok(!existsSync(join(dest, "skills")));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

function writeStream(lines: unknown[]): string {
  const dir = tempDir("h2-traj-");
  const p = join(dir, "stream.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

const START = {
  type: "tool_execution_start",
  toolCallId: "c1",
  toolName: "bash",
  args: { command: "echo hi" },
};
const END = {
  type: "tool_execution_end",
  toolCallId: "c1",
  toolName: "bash",
  result: { content: [{ type: "text", text: "hi" }], details: {} },
  isError: false,
};

test("renderTrajectory maps the JSONL stream onto the shared grammar", () => {
  const p = writeStream([
    { type: "session", version: 3, id: "s", timestamp: "t", cwd: "/w" },
    START,
    END,
    { ...END, isError: true, result: { content: [{ type: "text", text: "boom" }], details: {} } },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hello world" }] },
    },
  ]);
  assert.equal(
    renderTrajectory(p, { obsTrunc: 1000, maxChars: 10000, argsTrunc: 400 }),
    [
      '[ACTION] bash({"command":"echo hi"})',
      "[OBSERVATION] hi",
      "[ERROR] boom",
      "[ASSISTANT] hello world",
    ].join("\n"),
  );
});

test("renderTrajectory clips per-observation and per-action args", () => {
  const long = "x".repeat(50);
  const p = writeStream([
    START,
    END,
    { ...END, result: { content: [{ type: "text", text: long }], details: {} } },
    { ...START, args: { command: "echo hi" } },
  ]);
  const out = renderTrajectory(p, { obsTrunc: 10, maxChars: 100000, argsTrunc: 5 });
  const obsLine = `[OBSERVATION] ${"x".repeat(10)}\u2026(+40 chars \u2014 render truncation)`;
  assert.ok(out.split("\n").includes(obsLine));
  assert.ok(
    out.split("\n").includes('[ACTION] bash({"com\u2026(+16 chars \u2014 render truncation))'),
  );
});

test("renderTrajectory truncates the total to maxChars exactly", () => {
  const boom = {
    ...END,
    isError: true,
    result: { content: [{ type: "text", text: "boom" }], details: {} },
  };
  const p = writeStream([START, END, boom]);
  const full = renderTrajectory(p, { obsTrunc: 1000, maxChars: 100000, argsTrunc: 400 });
  assert.ok(full.length > 20);
  const cut = renderTrajectory(p, { obsTrunc: 1000, maxChars: 20, argsTrunc: 400 });
  const suffix = `\u2026(+${full.length - 20} chars \u2014 render truncation)`;
  assert.equal(cut, `${full.slice(0, 20)}\n${suffix}`);
});

test("renderTrajectory falls back when nothing parses", () => {
  const dir = tempDir("h2-traj-bad-");
  const p = join(dir, "stream.jsonl");
  writeFileSync(p, "hello\nworld\n");
  assert.equal(renderTrajectory(p, { obsTrunc: 10, maxChars: 100, argsTrunc: 10 }),
    "(no parseable events in trajectory)");
});

test("runProbe captures the stub stream offline and returns the probe artifacts", { skip: stubSkip }, async () => {
  const ws = tempDir("h2-probe-");
  try {
    writeFileSync(join(ws, "systemprompt.md"), "sp");
    const promptPath = join(ws, "task.md");
    writeFileSync(promptPath, "do things");
    const res = await runProbe({
      workspace: ws,
      promptPath,
      runId: "r1",
      model: "m",
      piBin: STUB,
      wallSeconds: 10,
    });
    assert.equal(res.runDir, join(ws, "runs", "r1"));
    assert.equal(res.streamPath, join(res.runDir, "stream.jsonl"));
    assert.equal(res.exitCode, 0);
    const stream = readFileSync(res.streamPath, "utf8");
    assert.ok(stream.includes('"type":"tool_execution_start"'));
    assert.ok(stream.includes('\\"edits\\": []'));
    assert.ok(existsSync(join(res.runDir, "stderr.log")));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
