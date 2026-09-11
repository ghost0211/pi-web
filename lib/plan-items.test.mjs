import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { findLatestActivePlan } = await jiti.import("./session-reader.ts");
const { planItemsFromInput, normalizePlanStatus } = await jiti.import("./plan-items.ts");

test("normalizes plan status variants", () => {
  assert.equal(normalizePlanStatus("done"), "done");
  assert.equal(normalizePlanStatus("completed"), "done");
  assert.equal(normalizePlanStatus("in_progress"), "running");
  assert.equal(normalizePlanStatus("running"), "running");
  assert.equal(normalizePlanStatus("failed"), "failed");
  assert.equal(normalizePlanStatus("pending"), "queued");
  assert.equal(normalizePlanStatus("queued"), "queued");
});

test("extracts plan items from tool inputs with todos array", () => {
  const items = planItemsFromInput({
    todos: [
      { title: "Task 1", status: "done", description: "desc 1" },
      { title: "Task 2", status: "pending" },
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Task 1");
  assert.equal(items[0].status, "done");
  assert.equal(items[0].detail, "desc 1");
  assert.equal(items[1].title, "Task 2");
  assert.equal(items[1].status, "queued");
});

test("findLatestActivePlan finds the latest todolist across the active branch even when truncated", () => {
  const entries = [
    {
      type: "message",
      id: "msg-1",
      parentId: null,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "todolist",
            arguments: {
              todos: [
                { title: "Step 1", status: "done" },
                { title: "Step 2", status: "in_progress" },
              ],
            },
          },
        ],
      },
    },
    {
      type: "message",
      id: "msg-2",
      parentId: "msg-1",
      message: { role: "toolResult", toolCallId: "call-1", content: [] },
    },
    // Follow-up messages simulating a long conversation after the todolist call
    {
      type: "message",
      id: "msg-3",
      parentId: "msg-2",
      message: { role: "user", content: "continue" },
    },
    {
      type: "message",
      id: "msg-4",
      parentId: "msg-3",
      message: { role: "assistant", content: [{ type: "text", text: "working..." }] },
    },
  ];

  const plan = findLatestActivePlan(entries, "msg-4");
  assert.ok(plan);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].title, "Step 1");
  assert.equal(plan[0].status, "done");
  assert.equal(plan[1].title, "Step 2");
  assert.equal(plan[1].status, "running");
});
