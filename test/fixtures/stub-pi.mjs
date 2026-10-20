#!/usr/bin/env node
/** Offline fake `pi` for the pi-harness2 test-suite.
 *
 * Speaks just enough of the verified pi 1.3.0 CLI contract to exercise the package without
 * a model: `--version` banner, and the `--mode json` JSONL event stream (session header,
 * user message_end, one bash tool round-trip, assistant message_end carrying
 * `{"edits": []}` plus `usage.cost.total`). STUB_PI_FAIL=1 exits 3 before any output, so
 * the channel retry path is observable offline.
 */

if (process.argv.includes("--version")) {
  console.log("pi 1.3.0 (stub)");
  process.exit(0);
}

if (process.env.STUB_PI_FAIL === "1") {
  console.error("stub-pi: simulated channel failure");
  process.exit(3);
}

if (process.argv.includes("--mode")) {
  const mission = process.argv[process.argv.length - 1] ?? "";
  const ev = (event) => process.stdout.write(JSON.stringify(event) + "\n");
  ev({
    type: "session",
    version: 3,
    id: "stub-session",
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  });
  ev({ type: "message_end", message: { role: "user", content: mission, timestamp: Date.now() } });
  ev({
    type: "tool_execution_start",
    toolCallId: "call_stub_1",
    toolName: "bash",
    args: { command: "echo hi" },
  });
  ev({
    type: "tool_execution_end",
    toolCallId: "call_stub_1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "hi" }], details: {} },
    isError: false,
  });
  ev({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: '{"edits": []}' }],
      stopReason: "stop",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0003 },
      },
    },
  });
  process.exit(0);
}

console.error("stub-pi: unsupported invocation");
process.exit(2);
