import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createSubagentController } = await createJiti(import.meta.url).import("./subagent-runtime.ts");

function completedRun() {
  return {
    sessionId: "child-session",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent-session",
    parentToolCallId: "tool-call",
    profile: "Explore",
    description: "Inspect parser",
    task: "Find the parser",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: "Parser found",
  };
}

test("completion notification reopens an idle parent and uses its current session", async () => {
  const delivered = [];
  const reopened = [];
  let ready = false;
  let parent;
  const liveParent = {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => { ready = true; },
    inner: {
      sendCustomMessage: async (message, options) => delivered.push({ message, options }),
    },
  };
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async (sessionId, sessionFile) => {
      reopened.push([sessionId, sessionFile]);
      parent = liveParent;
      return liveParent;
    },
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
  });

  await controller.extensionRuntime.notifyParent(completedRun());

  assert.deepEqual(reopened, [["parent-session", "/tmp/parent.jsonl"]]);
  assert.equal(ready, true);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].message.content, /Background subagent report \(not a new user request\)/);
  assert.match(delivered[0].message.content, /"description":"Inspect parser"/);
  assert.match(delivered[0].message.content, /Original subagent report:\nParser found$/);
  assert.equal(delivered[0].message.details.sessionId, "child-session");
  assert.equal(delivered[0].message.details.parentToolCallId, "tool-call");
  assert.equal(delivered[0].message.details.reportText, "Parser found");
  assert.deepEqual(delivered[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("parallel background reports retain source attribution and their original delivery order", async () => {
  const delivered = [];
  const parent = {
    isAlive: () => true,
    waitUntilReady: async () => {},
    inner: { sendCustomMessage: async (message, options) => delivered.push({ message, options }) },
  };
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
  });
  const first = { ...completedRun(), sessionId: "review-session", parentToolCallId: "review-call", description: "Review parser", result: "Review: retry path covered" };
  const second = { ...completedRun(), sessionId: "implementation-session", parentToolCallId: "implementation-call", description: "Implement parser", result: "Implementation done" };
  await controller.extensionRuntime.notifyParent(first);
  await controller.extensionRuntime.notifyParent(second);
  assert.deepEqual(delivered.map((item) => item.message.details.sessionId), ["review-session", "implementation-session"]);
  for (const [index, run] of [first, second].entries()) {
    assert.equal(delivered[index].message.details.reportText, run.result);
    assert.ok(delivered[index].message.content.includes(`"parentToolCallId":"${run.parentToolCallId}"`));
    assert.ok(delivered[index].message.content.endsWith(run.result));
    assert.deepEqual(delivered[index].options, { deliverAs: "followUp", triggerTurn: true });
  }
});

test("disabled built-in subagents reject stale Agent calls before starting", async () => {
  const controller = createSubagentController({
    getSession: () => { throw new Error("must not inspect a parent"); },
    registerSession: () => {},
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => false,
  });

  await assert.rejects(
    controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent" } },
      parentToolCallId: "call",
      profile: "explore",
      task: "Inspect",
      description: "Inspect",
    }),
    /built-in sub-agents are disabled/,
  );
});
