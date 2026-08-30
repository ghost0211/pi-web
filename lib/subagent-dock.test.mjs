import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { mergeSubagentDockItems } = await createJiti(import.meta.url).import("./subagent-dock.ts");

function session(id, status, overrides = {}) {
  return {
    id,
    path: `/tmp/${id}.jsonl`,
    cwd: "/repo",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-02T00:00:00.000Z",
    messageCount: 3,
    firstMessage: `task ${id}`,
    relation: {
      kind: "subagent",
      parentSessionId: "parent",
      profile: "explore",
      description: `Agent ${id}`,
      status,
    },
    ...overrides,
  };
}

test("adds persisted subagent sessions even when the parent has no Agent tool calls", () => {
  const items = mergeSubagentDockItems([], [
    session("child-a", "completed"),
    session("child-b", "failed"),
  ], new Set());

  assert.deepEqual(items.map(({ id, title, status }) => ({ id, title, status })), [
    { id: "child-a", title: "Agent child-a", status: "done" },
    { id: "child-b", title: "Agent child-b", status: "failed" },
  ]);
});

test("deduplicates tool-call rows by session id and lets live running state win", () => {
  const items = mergeSubagentDockItems([
    { id: "child-a", title: "tool task", detail: "tool output", status: "done", timestamp: 1 },
  ], [session("child-a", "completed")], new Set(["child-a"]));

  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: "child-a",
    title: "Agent child-a",
    detail: "tool output",
    status: "running",
    timestamp: Date.parse("2026-01-02T00:00:00.000Z"),
  });
});
