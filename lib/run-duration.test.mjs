import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildRunDurationIndex, formatRunDuration, getGroupRunDuration } = await jiti.import("./run-duration.ts");
const { buildSessionHistory, buildSessionContext } = await jiti.import("./session-reader.ts");
const iso = ms => new Date(ms).toISOString();
function message(id, parentId, role, time, extra = {}) {
  return { type: "message", id, parentId, timestamp: iso(time), message: { role, content: role === "assistant" ? [{ type: "text", text: id }] : id, timestamp: 42, ...extra } };
}
const timing = (id, parentId, target, durationMs) => ({
  type: "custom", id, parentId, timestamp: iso(20_000), customType: "pi-web:run-timing",
  data: { version: 1, runId: id, startedAt: 1000, finishedAt: 20_000, durationMs, finalAssistantEntryId: target, aborted: false },
});

test("duration formatting covers seconds, minutes, hours and all locales", () => {
  assert.equal(formatRunDuration(0), "0s");
  assert.equal(formatRunDuration(59_999), "59s");
  assert.equal(formatRunDuration(60_000), "1m 00s");
  assert.equal(formatRunDuration(3_661_999), "1h 01m 01s");
  assert.equal(formatRunDuration(3_661_999, "zh-CN"), "1小时01分01秒");
  assert.equal(formatRunDuration(3_661_999, "zh-TW"), "1小時01分01秒");
  assert.equal(formatRunDuration(61_000, "zh-CN"), "1分01秒");
  for (const invalid of [-1, NaN, Infinity]) assert.equal(formatRunDuration(invalid), "");
});

test("legacy timing uses final entry append time, excluding human idle and intermediate tool messages", () => {
  const entries = [message("u1", null, "user", 1000), message("p1", "u1", "assistant", 2000), message("a1", "p1", "assistant", 7000), message("u2", "a1", "user", 1_000_000), message("a2", "u2", "assistant", 1_005_000)];
  const index = buildRunDurationIndex(entries);
  assert.equal(index.has("p1"), false);
  assert.deepEqual(index.get("a1"), { durationMs: 6000, estimated: true });
  assert.deepEqual(index.get("a2"), { durationMs: 5000, estimated: true });
});

test("exact records override estimates and remain attached through pagination and branch views", () => {
  const entries = [message("u1", null, "user", 1000), message("a1", "u1", "assistant", 7000), timing("r1", "a1", "a1", 6500), message("u2", "r1", "user", 90_000), message("a2", "u2", "assistant", 95_000)];
  const snapshot = JSON.stringify(entries);
  for (const build of [buildSessionHistory, buildSessionContext]) {
    const page = build(entries, "u2", { tail: 1, excludeLeaf: true });
    assert.deepEqual(page.entryIds, ["a1"]);
    assert.equal(page.messages[0].runDurationMs, 6500);
    assert.equal(page.messages[0].runDurationEstimated, false);
    const atAnswer = build(entries, "a1", { tail: 1, deferThinking: true });
    assert.equal(atAnswer.messages[0].runDurationMs, 6500);
  }
  assert.equal(JSON.stringify(entries), snapshot, "SDK entries/messages are never modified");
  const full = buildSessionHistory(entries);
  assert.equal(full.messages.length, 4, "timing custom entries never become chat messages");
  assert.deepEqual(getGroupRunDuration(full.messages, 0, 2), { durationMs: 6500, estimated: false });
});

test("automatic compaction keeps the original prompt start, reports start separate supplements", () => {
  const entries = [message("u1", null, "user", 1000), message("p1", "u1", "assistant", 2000), { type: "compaction", id: "c1", parentId: "p1", timestamp: iso(4000), summary: "summary", firstKeptEntryId: "u1" }, message("a1", "c1", "assistant", 7000), { type: "custom_message", id: "n1", parentId: "a1", timestamp: iso(60_000), customType: "pi-web:subagent-notification", content: "report", display: true }, message("a2", "n1", "assistant", 62_000)];
  const index = buildRunDurationIndex(entries);
  assert.equal(index.has("p1"), false);
  assert.deepEqual(index.get("a1"), { durationMs: 6000, estimated: true });
  assert.deepEqual(index.get("a2"), { durationMs: 2000, estimated: true });
});

test("separate branches never borrow another answer's duration", () => {
  const entries = [message("u1", null, "user", 1000), message("a1", "u1", "assistant", 2000), timing("r1", "a1", "a1", 1200), message("u2", "r1", "user", 90_000), message("a2", "u2", "assistant", 95_000), timing("r2", "a2", "a2", 5500), message("b1", "u1", "assistant", 4000), timing("rb", "b1", "b1", 3200)];
  const a = buildSessionHistory(entries, "r2");
  const b = buildSessionHistory(entries, "rb");
  assert.deepEqual(a.messages.filter(m => m.role === "assistant").map(m => m.runDurationMs), [1200, 5500]);
  assert.deepEqual(b.messages.filter(m => m.role === "assistant").map(m => m.runDurationMs), [3200]);
});

test("invalid records/timestamps and standalone assistant traffic never fabricate durations", () => {
  const entries = [message("a0", null, "assistant", 1000), message("u1", "a0", "user", 3000), message("a1", "u1", "assistant", 2000), timing("bad", "a1", "a1", -1), { ...timing("bad2", "bad", "a1", 999), data: { version: 2, finalAssistantEntryId: "a1", durationMs: 999 } }];
  assert.equal(buildRunDurationIndex(entries).size, 0);
  assert.equal(getGroupRunDuration([{ role: "assistant", runDurationMs: -1 }], 0, 1), undefined);
  const bash = [...entries, message("bash", "bad2", "bashExecution", 50_000), message("a2", "bash", "assistant", 60_000)];
  assert.equal(buildRunDurationIndex(bash).has("a2"), false);
  const exact = [message("u2", null, "user", 1000), message("a3", "u2", "assistant", 2000), timing("zero", "a3", "a3", 0)];
  assert.deepEqual(buildRunDurationIndex(exact).get("a3"), { durationMs: 0, estimated: false });
});
