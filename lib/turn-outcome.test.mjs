import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { buildTurnOutcome } = await createJiti(import.meta.url).import("./turn-outcome.ts");
const call = (id, name, input) => ({ role: "assistant", content: [{ type: "toolCall", toolCallId: id, toolName: name, input }] });
const result = (id, text = "done", isError = false) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError });

test("uses completed writes and recorded commands, not claims in the answer", () => {
  const outcome = buildTurnOutcome([
    call("write", "write", { path: "src/main.ts" }), result("write"),
    call("check", "bash", { command: "npm test" }), result("check", "tests passed"),
    { role: "assistant", content: [{ type: "text", text: "Created secret.txt and ran lint" }] },
  ], "/project");
  assert.deepEqual(outcome.files, [{ filePath: "/project/src/main.ts" }]);
  assert.deepEqual(outcome.commands, [{ id: "check", command: "npm test", status: "completed", output: "tests passed", truncated: false }]);
});

test("retains failures and missing results and excludes unsuccessful writes", () => {
  const outcome = buildTurnOutcome([
    call("bad-write", "write", { path: "a.ts" }), result("bad-write", "denied", true),
    call("pending-write", "edit", { path: "b.ts" }),
    call("bad", "bash", { command: "npm test" }), result("bad", "exit code 1", true),
    call("missing", "bash", { command: "npm run lint" }),
  ], "/project");
  assert.deepEqual(outcome.files, []);
  assert.deepEqual(outcome.commands.map(({ status }) => status), ["failed", "unknown"]);
});

test("does not infer custom tool contracts and deduplicates replayed call ids", () => {
  const command = call("a", "bash", { command: "echo hello" });
  const outcome = buildTurnOutcome([
    command, command, result("a"),
    call("b", "custom.bash", { command: "npm test" }), result("b"),
    call("c", "bash", { command: 7 }), result("c"),
  ]);
  assert.equal(outcome.commands.length, 1);
});

test("bounds output previews while preserving the trailing failure", () => {
  const outcome = buildTurnOutcome([call("a", "bash", { command: "npm test" }), result("a", "x".repeat(5000) + "FAILED", true)]);
  assert.equal(outcome.commands[0].output.length, 4000);
  assert.equal(outcome.commands[0].truncated, true);
  assert.ok(outcome.commands[0].output.endsWith("FAILED"));
});

test("a different turn's tool result cannot complete this turn", () => {
  const outcome = buildTurnOutcome([call("a", "bash", { command: "npm test" }), result("b")]);
  assert.equal(outcome.commands[0].status, "unknown");
});
