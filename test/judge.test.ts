import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { callChannel, type CallChannelOptions } from "../src/channel.ts";
import { extractLastAssistantText, judge } from "../src/judge.ts";
import type { ChannelReply } from "../src/types.ts";

/** An offline channel: records the calls and always returns `reply`. */
function fakeChannel(
  reply: ChannelReply,
  calls: CallChannelOptions[] = [],
): typeof callChannel {
  return async (opts: CallChannelOptions): Promise<ChannelReply> => {
    calls.push(opts);
    return reply;
  };
}

function okReply(text: string, costUsd = 0.02): ChannelReply {
  return {ok: true, text, costUsd, raw: "x", attempts: 1};
}

const BASE = {
  task: "reconcile the ledger",
  trajectory: "[ACTION] bash(cat ledger)\n[ASSISTANT] done",
  deliverable: "done",
  model: "m",
  wallSeconds: 5,
};

test("judge maps a valid verdict reply onto the judgement, cost included", async () => {
  const calls: CallChannelOptions[] = [];
  const verdict = {verdict: "pass", score: 0.9, evidence: ["[ASSISTANT] done"], notes: "works"};
  const j = await judge({
    ...BASE,
    channel: fakeChannel(okReply(JSON.stringify(verdict), 0.03), calls),
  });
  assert.deepEqual(j, {
    verdict: "pass",
    score: 0.9,
    evidence: ["[ASSISTANT] done"],
    notes: "works",
    costUsd: 0.03,
  });
  assert.equal(calls.length, 1);
  // The anchored rubric rides in the system prompt; the mission carries task + deliverable.
  assert.ok(calls[0]!.system.includes("score >= 0.8"));
  assert.ok(calls[0]!.system.includes("VERBATIM"));
  assert.ok(calls[0]!.mission.includes("reconcile the ledger"));
  assert.ok(calls[0]!.mission.includes("[ASSISTANT] done"));
});

test("judge folds an optional rubric into the mission", async () => {
  const calls: CallChannelOptions[] = [];
  const failReply = okReply('{"verdict":"fail","score":0.1,"evidence":[],"notes":"x"}');
  await judge({...BASE, rubric: "every row totals", channel: fakeChannel(failReply, calls)});
  assert.ok(calls[0]!.mission.includes("# THE RUBRIC"));
  assert.ok(calls[0]!.mission.includes("every row totals"));
});

test("a malformed reply is unavailable, never fail, and never a cached zero", async () => {
  const garbage = await judge({...BASE, channel: fakeChannel(okReply("not json at all"))});
  assert.equal(garbage.verdict, "unavailable");
  assert.equal(garbage.score, 0);
  assert.notEqual(garbage.verdict, "fail");

  const badVerdict = await judge({
    ...BASE,
    channel: fakeChannel(okReply('{"verdict":"excellent","score":0.9,"evidence":[],"notes":""}')),
  });
  assert.equal(badVerdict.verdict, "unavailable");
  assert.equal(badVerdict.score, 0);

  const noScore = await judge({
    ...BASE,
    channel: fakeChannel(okReply('{"verdict":"pass","evidence":[],"notes":""}')),
  });
  assert.equal(noScore.verdict, "unavailable");
});

test("a failed channel is unavailable and still reports its cost", async () => {
  const j = await judge({
    ...BASE,
    channel: fakeChannel({ok: false, text: "", costUsd: 0.07, raw: "", attempts: 2}),
  });
  assert.equal(j.verdict, "unavailable");
  assert.equal(j.score, 0);
  assert.equal(j.costUsd, 0.07);
  assert.ok(j.notes.includes("no parseable reply"));
});

test("scores are clamped into [0,1] (documented choice: only the range is enforced)", async () => {
  const high = await judge({
    ...BASE,
    channel: fakeChannel(okReply('{"verdict":"pass","score":1.5,"evidence":[],"notes":""}')),
  });
  assert.equal(high.score, 1);
  const low = await judge({
    ...BASE,
    channel: fakeChannel(okReply('{"verdict":"fail","score":-0.2,"evidence":[],"notes":""}')),
  });
  assert.equal(low.score, 0);
});

test("extractLastAssistantText returns the last assistant message_end text", () => {
  const dir = mkdtempSync(join(tmpdir(), "h2-judge-"));
  try {
    const p = join(dir, "stream.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({
          type: "message_end",
          message: {role: "user", content: [{type: "text", text: "go"}]},
        }),
        JSON.stringify({type: "tool_execution_start", toolName: "bash", args: {cmd: "ls"}}),
        JSON.stringify({
          type: "message_end",
          message: {role: "assistant", content: [{type: "text", text: "first"}]},
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              {type: "text", text: "second"},
              {type: "text", text: " part"},
            ],
          },
        }),
        "not json",
        "",
      ].join("\n"),
      "utf8",
    );
    assert.equal(extractLastAssistantText(p), "second\n part");
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test("extractLastAssistantText returns empty for a missing or assistant-less stream", () => {
  const dir = mkdtempSync(join(tmpdir(), "h2-judge-"));
  try {
    const p = join(dir, "empty.jsonl");
    writeFileSync(
      p,
      `${JSON.stringify({type: "message_end", message: {role: "user", content: "hi"}})}\n`,
      "utf8",
    );
    assert.equal(extractLastAssistantText(p), "");
    assert.equal(extractLastAssistantText(join(dir, "missing.jsonl")), "");
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
