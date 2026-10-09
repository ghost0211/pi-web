import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  extractSubagentReportText,
  parseSubagentReport,
  resolveSubagentReportTime,
} = await jiti.import("./subagent-report.ts");

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const knownDetails = (overrides = {}) => ({
  kind: "pi-web-subagent",
  sessionId: SESSION_ID,
  profile: "Explore",
  description: "Inspect the parser",
  status: "completed",
  completedAt: "2026-03-04T05:06:07.000Z",
  ...overrides,
});

test("extracts only supported text block shapes and preserves the full Markdown source", () => {
  const markdown = "# Complete report\n\n" + "detail ".repeat(20_000) + "FINAL_SENTINEL";
  assert.equal(extractSubagentReportText(markdown), markdown);
  assert.equal(extractSubagentReportText([
    { type: "text", text: "first" },
    { type: "image", data: "must-not-be-read" },
    { text: "second" },
    { type: "text", content: "third" },
    null,
    { type: "json", text: "must-not-be-read-either" },
  ]), "first\nsecond\nthird");
  assert.equal(extractSubagentReportText([]), "");
  assert.equal(extractSubagentReportText({ text: "not a content list" }), "");
});

test("uses a valid completedAt first and falls back to the message timestamp", () => {
  assert.equal(
    resolveSubagentReportTime("2026-03-04T05:06:07Z", Date.parse("2026-03-01T00:00:00Z")),
    "2026-03-04T05:06:07.000Z",
  );
  assert.equal(
    resolveSubagentReportTime("not a date", Date.parse("2026-03-01T00:00:00Z")),
    "2026-03-01T00:00:00.000Z",
  );
  assert.equal(resolveSubagentReportTime("not a date", Number.NaN), null);
});

test("parses documented metadata and preserves the actual report status", () => {
  const parsed = parseSubagentReport(knownDetails(), "Raw result", Date.parse("2026-03-01T00:00:00Z"));
  assert.deepEqual(parsed, {
    content: "Raw result",
    taskDescription: "Inspect the parser",
    profile: "Explore",
    status: "completed",
    completedAt: "2026-03-04T05:06:07.000Z",
    sessionId: SESSION_ID,
  });

  for (const status of ["failed", "aborted", "interrupted", "running", "starting", "cancelled", "canceled"]) {
    assert.equal(parseSubagentReport(knownDetails({ status }), "", 1).status,
      status === "canceled" ? "cancelled" : status);
  }
});

test("legacy messages and malformed or unknown details never imply completion", () => {
  const legacy = parseSubagentReport(undefined, [{ type: "text", text: "Legacy result" }], 1_700_000_000_000);
  assert.equal(legacy.status, "unknown");
  assert.equal(legacy.taskDescription, null);
  assert.equal(legacy.content, "Legacy result");
  assert.equal(legacy.completedAt, "2023-11-14T22:13:20.000Z");

  for (const details of [
    null,
    "{\"status\":\"completed\"}",
    { kind: "other-extension", status: "completed" },
    { kind: "pi-web-subagent", status: { value: "completed" } },
    { kind: "pi-web-subagent", status: "success" },
  ]) {
    assert.equal(parseSubagentReport(details, "", 0).status, "unknown");
  }
});

test("session links accept only the pure UUID session-id format", () => {
  assert.equal(parseSubagentReport(knownDetails(), "", 0).sessionId, SESSION_ID);
  for (const sessionId of ["../../sessions/secret", "/tmp/session", "https://example.test", "child-session", ""])
    assert.equal(parseSubagentReport(knownDetails({ sessionId }), "", 0).sessionId, null);
});

test("trusted reportText overrides model-facing content, including an intentional empty result", () => {
  const guidance = "Main agent: integrate this report and do not repeat it verbatim.";
  assert.equal(parseSubagentReport(knownDetails({ reportText: "Original subagent result" }), guidance).content,
    "Original subagent result");
  assert.equal(parseSubagentReport(knownDetails({ reportText: "" }), guidance).content, "");
  assert.equal(parseSubagentReport(knownDetails({ reportText: 42 }), guidance).content, guidance);
});

test("unknown kinds cannot use reportText metadata and task prompts are not treated as titles", () => {
  const guidance = "model-facing integration guidance";
  const unknown = parseSubagentReport({ kind: "other", status: "completed", reportText: "secret raw result" }, guidance);
  assert.equal(unknown.content, guidance);
  assert.equal(unknown.status, "unknown");

  const parsed = parseSubagentReport(knownDetails({ description: {}, task: "very long full prompt" , profile: 42 }), "", 0);
  assert.equal(parsed.taskDescription, null);
  assert.equal(parsed.profile, null);
});
