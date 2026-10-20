import assert from "node:assert/strict";
import { test } from "node:test";
import { callChannel, type CallChannelOptions } from "../src/channel.ts";
import { ProposerError, compose, propose } from "../src/proposer.ts";
import type { ChannelReply, Tree } from "../src/types.ts";

/** An offline channel: replays `replies` in order, repeating the last one, and records the
 * system prompts it was called with so the retry feedback is observable. */
function fakeChannel(replies: ChannelReply[], systems: string[] = []): typeof callChannel {
  let i = 0;
  return async (opts: CallChannelOptions): Promise<ChannelReply> => {
    systems.push(opts.system);
    return replies[Math.min(i++, replies.length - 1)]!;
  };
}

function jsonReply(edits: unknown, notes = "why"): ChannelReply {
  return { ok: true, text: JSON.stringify({ edits, notes }), costUsd: 0.01, raw: "x", attempts: 1 };
}

const INPUT = {
  task: "reconcile the ledger",
  baseTree: { "systemprompt.md": "base" } as Tree,
  candidates: [{ label: "cand-1", trajectory: "one run" }],
  model: "m",
  wallSeconds: 5,
};

test("propose returns a valid first reply as-is with attempts 1", async () => {
  const edits: Tree = { "guardrails.md": "- Be terse.\n" };
  const channel = fakeChannel([jsonReply(edits, "one rule")]);
  const res = await propose({ ...INPUT, channel });
  assert.deepEqual(res.edits, edits);
  assert.equal(res.notes, "one rule");
  assert.equal(res.attempts, 1);
});

test("propose retries once on garbage, then returns the valid edits with attempts 2", async () => {
  const edits: Tree = { "guardrails.md": "- Be terse.\n" };
  const garbage: ChannelReply = {
    ok: true,
    text: "not json at all",
    costUsd: 0.02,
    raw: "",
    attempts: 2,
  };
  const channel = fakeChannel([garbage, jsonReply(edits)]);
  const res = await propose({ ...INPUT, channel });
  assert.equal(res.attempts, 2);
  assert.deepEqual(res.edits, edits);
  assert.equal(res.costUsd, 0.03);
});

test("propose throws ProposerError after two path-escape violations, with the audit", async () => {
  const escape = jsonReply({ "../evil.md": "nope" });
  const channel = fakeChannel([escape, escape]);
  await assert.rejects(propose({ ...INPUT, channel }), (err: unknown) => {
    assert.ok(err instanceof ProposerError);
    assert.equal(err.attempts, 2);
    assert.ok(err.lastViolations.length > 0);
    const hit = err.lastViolations.some(
      (v) => v.includes("path escapes") && v.includes("../evil.md"),
    );
    assert.ok(hit);
    assert.ok(/rejected after 2 attempts/.test(err.message));
    return true;
  });
});

test("propose feeds surface violations back through the retry system prompt", async () => {
  const edits: Tree = { "guardrails.md": "- Be terse.\n" };
  const systems: string[] = [];
  const channel = fakeChannel([jsonReply({ "../evil.md": "x" }), jsonReply(edits)], systems);
  const res = await propose({ ...INPUT, channel });
  assert.equal(res.attempts, 2);
  assert.equal(systems.length, 2);
  assert.ok(systems[1]!.startsWith(systems[0]!));
  assert.ok(systems[1]!.includes("RETRY FEEDBACK") && systems[1]!.includes("path escapes"));
});

test("compose merges onto base: overrides, deletions, and validates the merged tree", async () => {
  const baseTree: Tree = { "a.md": "one", "b.md": "two", "c.md": "three" };
  const candidateEdits: Tree = { "a.md": "one!", "b.md": "", "d.md": "four" };
  const channel = fakeChannel([jsonReply(candidateEdits)]);
  const res = await compose({
    ...INPUT,
    baseTree,
    candidates: [{ label: "cand-1", edits: candidateEdits, trajectory: "one run" }],
    channel,
  });
  assert.deepEqual(res.tree, { "a.md": "one!", "c.md": "three", "d.md": "four" });
  assert.equal(res.attempts, 1);
});

test("compose rejects a surface-breaking merged tree and throws after the retry", async () => {
  const baseTree: Tree = { "guardrails.md": "x".repeat(100) };
  // The merged always-on content lands over the cap on both attempts, so both are rejected.
  const candidateEdits: Tree = { "guardrails.md": "y".repeat(24001) };
  const reply = jsonReply(candidateEdits);
  const channel = fakeChannel([reply, reply]);
  await assert.rejects(
    compose({
      ...INPUT,
      baseTree,
      candidates: [{ label: "cand-1", edits: candidateEdits, trajectory: "one run" }],
      channel,
    }),
    (err: unknown) => {
      assert.ok(err instanceof ProposerError);
      assert.equal(err.attempts, 2);
      assert.ok(err.lastViolations.some((v) => v.includes("over the 24000 cap")));
      return true;
    },
  );
});
