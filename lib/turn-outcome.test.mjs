import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { buildTurnOutcome, isClaimedFileFromTurn } = await createJiti(import.meta.url).import("./turn-outcome.ts");
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

test("records powershell commands with the same contract as bash", () => {
  const outcome = buildTurnOutcome([
    call("ps", "powershell", { command: "python work/build.py" }), result("ps", "generated"),
    call("bad-ps", "powershell", { command: "exit 1" }), result("bad-ps", "failed", true),
  ], "/project");
  assert.deepEqual(outcome.commands.map(({ command, status }) => [command, status]), [
    ["python work/build.py", "completed"],
    ["exit 1", "failed"],
  ]);
});

test("claims reply-mentioned deliverables that no write call recorded", () => {
  const outcome = buildTurnOutcome([
    call("gen", "write", { path: "work/build_flyway_migration.py" }), result("gen"),
    call("run", "powershell", { command: "python work/build_flyway_migration.py" }), result("run"),
    { role: "assistant", content: [{ type: "text", text: "已按规范生成：`sql/V1.0.0.20261019_1__PudongAuditInit.sql`（260 KB）" }] },
  ], "/project");
  assert.deepEqual(outcome.files, [{ filePath: "/project/work/build_flyway_migration.py" }]);
  assert.deepEqual(outcome.claimed, [{ filePath: "/project/sql/V1.0.0.20261019_1__PudongAuditInit.sql" }]);
});

test("claimed files require an mtime inside the turn window", () => {
  const turnStart = 1_000_000;
  assert.equal(isClaimedFileFromTurn({ mtimeMs: turnStart }, turnStart), true);
  assert.equal(isClaimedFileFromTurn({ mtimeMs: turnStart - 120_000 }, turnStart), true, "slack covers clock skew");
  assert.equal(isClaimedFileFromTurn({ mtimeMs: turnStart - 120_001 }, turnStart), false, "older than the turn");
  assert.equal(isClaimedFileFromTurn({ mtimeMs: 1 }, turnStart), false);
  assert.equal(isClaimedFileFromTurn({}, turnStart), false, "missing mtime");
  assert.equal(isClaimedFileFromTurn({ mtimeMs: turnStart }, undefined), false, "no turn window");
});
