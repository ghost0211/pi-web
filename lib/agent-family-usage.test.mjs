import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildMemberUsage,
  computeMemberDuration,
  detectCostIncomplete,
  totalFamilyUsage,
} = await jiti.import("./agent-family-usage.ts");

const usage = (input, output, cacheRead, cacheWrite, total) => ({
  input, output, cacheRead, cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const stats = (totalTokens, cost, extra = {}) => ({
  userMessages: 1,
  assistantMessages: 2,
  toolCalls: 1,
  toolResults: 1,
  totalMessages: 4,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalTokens },
  cost,
  ...extra,
});

const assistant = (id, parentId, timestamp, cost) => ({
  type: "message",
  id,
  parentId,
  timestamp,
  message: {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    ...(cost === undefined ? {} : { usage: usage(100, 50, 0, 0, cost) }),
  },
});

test("sums cost from recorded totals and flags a session that recorded none", () => {
  assert.equal(detectCostIncomplete([assistant("a", null, "2026-01-01T00:00:00Z", 0.02)]), false);
  assert.equal(detectCostIncomplete([assistant("b", null, "2026-01-01T00:00:00Z")]), false, "no usage at all is not incomplete");
  const missingCost = {
    type: "message",
    id: "c",
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "assistant", content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: {} } },
  };
  assert.equal(detectCostIncomplete([missingCost]), true);
});

test("counts compaction and summary usage once each", () => {
  const entries = [
    assistant("a", null, "2026-01-01T00:00:00Z", 0.01),
    { type: "compaction", id: "c1", parentId: "a", timestamp: "2026-01-01T00:05:00Z", summary: "s", firstKeptEntryId: "a", tokensBefore: 100, usage: usage(10, 5, 0, 0, 0.02) },
  ];
  const member = buildMemberUsage({ sessionId: "s1", role: "main", entries, stats: stats(150, 0.03) });
  assert.equal(member.cost, 0.03);
  assert.equal(member.costIncomplete, false);
  // Duration only counts turns that produced usage-bearing answers.
  assert.equal(member.turns, 1);
});

test("prefers precise run-timing records over the legacy estimate", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hi" } },
    assistant("a1", "u1", "2026-01-01T00:00:10Z", 0.01),
    { type: "custom", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:11Z", customType: "pi-web:run-timing", data: { version: 1, durationMs: 7000, finalAssistantEntryId: "a1" } },
  ];
  const duration = computeMemberDuration(entries);
  assert.equal(duration.measuredDurationMs, 7000);
  assert.equal(duration.durationEstimated, false);
});

test("reports an estimate as an estimate, never as a measurement", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "hi" } },
    assistant("a1", "u1", "2026-01-01T00:00:10Z", 0.01),
  ];
  const duration = computeMemberDuration(entries);
  assert.equal(duration.measuredDurationMs, 0);
  assert.ok(duration.estimatedDurationMs > 0);
  assert.equal(duration.durationEstimated, true);
});

test("family totals add members and inherit incompleteness", () => {
  const main = buildMemberUsage({
    sessionId: "root",
    role: "main",
    entries: [assistant("a", null, "2026-01-01T00:00:00Z", 0.5)],
    stats: stats(1000, 0.5),
  });
  const child = buildMemberUsage({
    sessionId: "child",
    role: "subagent",
    label: "Review SQL",
    entries: [assistant("b", null, "2026-01-01T00:00:00Z", 0.25)],
    stats: stats(400, 0.25),
  });
  const total = totalFamilyUsage([main, child]);
  assert.equal(total.tokens, 1400);
  assert.equal(total.cost, 0.75);
  assert.equal(total.costIncomplete, false);

  const unreadable = { ...child, unreadable: true };
  assert.equal(totalFamilyUsage([main, unreadable]).costIncomplete, true);
  assert.deepEqual(totalFamilyUsage([]), {
    tokens: 0, cost: 0, costIncomplete: false,
    measuredDurationMs: 0, estimatedDurationMs: 0, durationEstimated: false,
  });
});

test("a subagent row carries its label so the UI can attribute cost", () => {
  const member = buildMemberUsage({
    sessionId: "child",
    role: "subagent",
    label: "Review SQL",
    entries: [],
    stats: stats(0, 0),
  });
  assert.equal(member.role, "subagent");
  assert.equal(member.label, "Review SQL");
});
