import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { callChannel, parsePiJson } from "../src/channel.ts";

const STUB = fileURLToPath(new URL("./fixtures/stub-pi.mjs", import.meta.url));

test("callChannel parses the stub assistant JSON and reports cost", async () => {
  const reply = await callChannel({
    mission: "return the edits json",
    system: "you are a proposer",
    model: "m",
    wallSeconds: 10,
    piBin: STUB,
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.text, '{"edits": []}');
  assert.equal(reply.attempts, 1);
  assert.ok(reply.costUsd > 0);
  assert.equal(reply.costUsd, 0.0003);
  assert.ok(reply.raw.includes('"type":"tool_execution_start"'));
});

test("callChannel retries once on a failing channel and reports attempts", async () => {
  process.env.STUB_PI_FAIL = "1";
  try {
    const reply = await callChannel({
      mission: "m",
      system: "s",
      model: "m",
      wallSeconds: 10,
      piBin: STUB,
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.attempts, 2);
    assert.equal(reply.text, "");
    assert.equal(reply.raw, "");
  } finally {
    delete process.env.STUB_PI_FAIL;
  }
});

test("parsePiJson extracts fenced, prose-wrapped and nested JSON, rejects garbage", () => {
  assert.equal(parsePiJson('```json\n{"a": 1}\n```'), '{"a": 1}');
  assert.equal(parsePiJson("Sure \u2014 here it is: {\"a\": 1} hope that helps"), '{"a": 1}');
  assert.equal(parsePiJson('{"a": {"b": [1, 2]}}'), '{"a": {"b": [1, 2]}}');
  assert.equal(parsePiJson("no structured answer here"), null);
  assert.equal(parsePiJson('{"a": 1'), null);
});
