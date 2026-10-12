import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  RunTimingRuntime,
  RUN_TIMING_CUSTOM_TYPE,
  findLatestAssistantEntryIdAfter,
  getLeafEntryId,
} = await jiti.import("./run-timing-runtime.ts");
const { buildRunDurationIndex } = await jiti.import("./run-duration.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

function createMockSessionManager(initialEntries = []) {
  const entries = [...initialEntries];
  const customEntries = [];
  return {
    entries,
    customEntries,
    getBranch() {
      return [...entries];
    },
    getEntries() {
      return [...entries];
    },
    getLeafId() {
      return entries.length > 0 ? entries[entries.length - 1].id : null;
    },
    appendMessage(msg, id = `m_${entries.length + 1}`) {
      const entry = {
        type: "message",
        id,
        parentId: entries.length > 0 ? entries[entries.length - 1].id : null,
        timestamp: new Date().toISOString(),
        message: msg,
      };
      entries.push(entry);
      return entry;
    },
    appendCustomEntry(customType, data) {
      const entry = {
        type: "custom",
        id: `c_${entries.length + 1}`,
        parentId: entries.length > 0 ? entries[entries.length - 1].id : null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      };
      entries.push(entry);
      customEntries.push(entry);
      return entry;
    },
  };
}

test("normal logical run records timing with monotonic duration and correct payload structure", async () => {
  const sm = createMockSessionManager();
  const runtime = new RunTimingRuntime({ getSessionManager: () => sm });

  const run = runtime.beginPromptRun();
  assert.ok(run);
  assert.equal(typeof run.runId, "string");
  assert.equal(typeof run.startedAt, "number");
  assert.equal(run.startLeafId, null);
  assert.equal(runtime.getRunningStartedAt(), run.startedAt);

  // SDK fires agent_start
  const startSnapshot = runtime.onAgentStart();
  assert.equal(startSnapshot.runId, run.runId, "Repeated agent_start does not change existing run");

  // SDK appends user and assistant
  sm.appendMessage({ role: "user", content: "hello" }, "u1");
  await new Promise((r) => setTimeout(r, 20));
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "world" }] }, "a1");

  // Agent settled
  const record = runtime.onAgentSettled({ aborted: false });
  assert.ok(record);
  assert.equal(record.version, 1);
  assert.equal(record.runId, run.runId);
  assert.equal(record.startedAt, run.startedAt);
  assert.ok(record.finishedAt >= record.startedAt);
  assert.ok(record.durationMs >= 15, `durationMs (${record.durationMs}) should be >= 15ms`);
  assert.equal(record.finalAssistantEntryId, "a1");
  assert.equal(record.aborted, false);
  assert.equal(runtime.getRunningStartedAt(), null);

  assert.equal(sm.customEntries.length, 1);
  assert.equal(sm.customEntries[0].customType, RUN_TIMING_CUSTOM_TYPE);
  assert.deepEqual(sm.customEntries[0].data, record);
});

test("completed elapsed duration stays monotonic when the system wall clock moves backwards", async () => {
  const sm = createMockSessionManager();
  const runtime = new RunTimingRuntime({ getSessionManager: () => sm });
  const originalNow = Date.now;
  let wall = 10_000;
  Date.now = () => wall;
  try {
    runtime.beginPromptRun();
    sm.appendMessage({ role: "assistant", content: "done" }, "a1");
    await new Promise(resolve => setTimeout(resolve, 20));
    wall = 1000;
    const record = runtime.onAgentSettled();
    assert.equal(record.startedAt, 10_000);
    assert.equal(record.finishedAt, 1000);
    assert.ok(record.durationMs >= 15);
  } finally { Date.now = originalNow; }
});

test("agent_end -> start loop protection across multi-tool iterations", async () => {
  const sm = createMockSessionManager();
  const runtime = new RunTimingRuntime({ getSessionManager: () => sm });

  const run = runtime.beginPromptRun();
  const initialStartedAt = run.startedAt;
  const initialPerf = run.startedPerf;

  // Round 1 of tool calling
  runtime.onAgentStart();
  sm.appendMessage({ role: "user", content: "do work" }, "u1");
  sm.appendMessage({ role: "assistant", content: [{ type: "tool_use", id: "t1" }] }, "a1");
  runtime.onAgentEnd();

  // Tool execution happened...
  sm.appendMessage({ role: "tool_result", toolUseId: "t1" }, "tr1");
  await new Promise((r) => setTimeout(r, 20));

  // Round 2 continues the same run
  runtime.onAgentStart();
  const currentRun = runtime.getActiveRun();
  assert.equal(currentRun.startedAt, initialStartedAt, "Tool iteration must not reset startedAt");
  assert.equal(currentRun.startedPerf, initialPerf, "Tool iteration must not reset startedPerf");

  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }] }, "a2");
  runtime.onAgentEnd();

  // Finally settles
  const record = runtime.onAgentSettled({ aborted: false });
  assert.ok(record);
  assert.equal(record.finalAssistantEntryId, "a2", "Must point to the final assistant message");
  assert.ok(record.durationMs >= 15);
  assert.equal(runtime.getActiveRun(), null);
});

test("multi-turn interactions track separate runs and never bind to historical assistants", () => {
  const sm = createMockSessionManager();
  const runtime = new RunTimingRuntime({ getSessionManager: () => sm });

  // Turn 1
  const run1 = runtime.beginPromptRun();
  assert.equal(run1.startLeafId, null);
  sm.appendMessage({ role: "user", content: "turn 1" }, "u1");
  sm.appendMessage({ role: "assistant", content: "answer 1" }, "a1");
  const record1 = runtime.onAgentSettled({ aborted: false });
  assert.equal(record1.finalAssistantEntryId, "a1");

  // Turn 2
  const run2 = runtime.beginPromptRun();
  assert.notEqual(run2.runId, run1.runId);
  // Leaf before turn 2 is the custom timing entry c_3, which is after a1
  assert.ok(run2.startLeafId);

  sm.appendMessage({ role: "user", content: "turn 2" }, "u2");
  sm.appendMessage({ role: "assistant", content: "answer 2" }, "a2");
  const record2 = runtime.onAgentSettled({ aborted: false });
  assert.equal(record2.finalAssistantEntryId, "a2", "Must bind to new assistant in turn 2, not a1");
});

test("queued / steer / followUp do not restart timing and merge into current logical run", async () => {
  const sm = createMockSessionManager();
  const runtime = new RunTimingRuntime({ getSessionManager: () => sm });

  const run = runtime.beginPromptRun();
  const startedAt = run.startedAt;

  sm.appendMessage({ role: "user", content: "initial" }, "u1");
  // Simulate queued or follow-up prompt call while running
  const nextAttempt = runtime.beginPromptRun();
  assert.equal(nextAttempt.runId, run.runId, "beginPromptRun while active returns same run");
  assert.equal(nextAttempt.startedAt, startedAt);

  sm.appendMessage({ role: "user", content: "followup message" }, "u2");
  sm.appendMessage({ role: "assistant", content: "combined answer" }, "a1");

  const record = runtime.onAgentSettled({ aborted: false });
  assert.ok(record);
  assert.equal(record.runId, run.runId);
  assert.equal(record.finalAssistantEntryId, "a1");
});

test("extension or subagent can start independent run via agent_start", () => {
  const sm = createMockSessionManager();
  const runtime = new RunTimingRuntime({ getSessionManager: () => sm });

  // Independent run started by agent_start without beginPromptRun
  const run = runtime.onAgentStart();
  assert.ok(run);
  assert.equal(run.origin, "agent_start");
  assert.equal(runtime.getRunningStartedAt(), run.startedAt);

  sm.appendMessage({ role: "assistant", content: "extension response" }, "a_ext");
  const record = runtime.onAgentSettled({ aborted: false });
  assert.ok(record);
  assert.equal(record.finalAssistantEntryId, "a_ext");
});

test("aborted runs without assistant produce no record; aborted with assistant persist aborted:true", () => {
  const sm = createMockSessionManager();
  const runtime = new RunTimingRuntime({ getSessionManager: () => sm });

  // Case 1: aborted before any assistant produced
  runtime.beginPromptRun();
  sm.appendMessage({ role: "user", content: "aborted early" }, "u1");
  const abortRecord1 = runtime.onAgentSettled({ aborted: true });
  assert.equal(abortRecord1, null, "No record when aborted without new assistant");
  assert.equal(sm.customEntries.length, 0);

  // Case 2: assistant generated partially/error, then aborted
  runtime.beginPromptRun();
  sm.appendMessage({ role: "user", content: "partially answered" }, "u2");
  sm.appendMessage({ role: "assistant", content: "interrupted text", errorMessage: "Aborted" }, "a_abort");
  const abortRecord2 = runtime.onAgentSettled({ aborted: true });
  assert.ok(abortRecord2);
  assert.equal(abortRecord2.aborted, true);
  assert.equal(abortRecord2.finalAssistantEntryId, "a_abort");
  assert.equal(sm.customEntries.length, 1);
});

test("preflight rejection or handled without new assistant discards run and leaves no record", () => {
  const sm = createMockSessionManager();
  const runtime = new RunTimingRuntime({ getSessionManager: () => sm });

  const run = runtime.beginPromptRun();
  assert.ok(runtime.getActiveRun());

  // Preflight rejected
  runtime.discardPromptRun(run);
  assert.equal(runtime.getActiveRun(), null);
  assert.equal(runtime.onAgentSettled(), null);
  assert.equal(sm.customEntries.length, 0);

  // Slash command handled without assistant
  runtime.beginPromptRun();
  sm.appendMessage({ role: "user", content: "/custom-cmd" }, "u1");
  // Only non-assistant entry (e.g. bash or notice)
  sm.appendMessage({ role: "bashExecution", content: "echo hi" }, "b1");
  const noAssistantRecord = runtime.onAgentSettled();
  assert.equal(noAssistantRecord, null);
  assert.equal(sm.customEntries.length, 0);
});

test("fallbackPromptFinish supports legacy SDKs without agent_settled", () => {
  const sm = createMockSessionManager();
  const runtime = new RunTimingRuntime({ getSessionManager: () => sm });

  const run = runtime.beginPromptRun();
  sm.appendMessage({ role: "user", content: "legacy" }, "u1");
  sm.appendMessage({ role: "assistant", content: "legacy answer" }, "a_legacy");

  // When inner is still streaming, fallback should not settle
  const rejectedWhileStreaming = runtime.fallbackPromptFinish(run, { isStreaming: true });
  assert.equal(rejectedWhileStreaming, null);
  assert.ok(runtime.getActiveRun());

  // Settles when streaming is done
  const record = runtime.fallbackPromptFinish(run, { isStreaming: false, aborted: false });
  assert.ok(record);
  assert.equal(record.finalAssistantEntryId, "a_legacy");
  assert.equal(runtime.getActiveRun(), null);

  // Subsequent settle call does nothing
  assert.equal(runtime.onAgentSettled(), null);
});

test("partial mock protection, append failure does not throw, destroy prevents write", () => {
  const smThrow = createMockSessionManager();
  smThrow.appendCustomEntry = () => { throw new Error("Disk full simulation"); };
  const runtimeThrow = new RunTimingRuntime({ getSessionManager: () => smThrow });
  runtimeThrow.beginPromptRun();
  smThrow.appendMessage({ role: "assistant", content: "done" }, "a1");
  const oldError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(" "));
  try {
    assert.doesNotThrow(() => runtimeThrow.onAgentSettled());
    assert.equal(runtimeThrow.getActiveRun(), null);
    assert.match(logs.join("\n"), /Disk full simulation/);
  } finally { console.error = oldError; }

  // Destroyed runtime
  const smDestroy = createMockSessionManager();
  const runtimeDestroy = new RunTimingRuntime({ getSessionManager: () => smDestroy });
  runtimeDestroy.beginPromptRun();
  runtimeDestroy.destroy();
  assert.equal(runtimeDestroy.getRunningStartedAt(), null);
  assert.equal(runtimeDestroy.onAgentSettled(), null);
  assert.equal(smDestroy.customEntries.length, 0);
});

test("empty reset roots and branch mismatches never borrow unrelated assistants", () => {
  const old = { id: "old", type: "message", message: { role: "assistant" } };
  assert.equal(getLeafEntryId({ getLeafId: () => null, getBranch: () => [], getEntries: () => [old] }), null);
  assert.equal(findLatestAssistantEntryIdAfter({ getBranch: () => [old], getEntries: () => [{ id: "start" }, old] }, "start"), null);
  assert.equal(findLatestAssistantEntryIdAfter({ getEntries: () => [{ id: "start" }, old] }, "start"), "old", "minimal mocks can fall back when no branch API exists");
  const sm = SessionManager.inMemory();
  sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "old branch" }], timestamp: Date.now() });
  sm.resetLeaf();
  const runtime = new RunTimingRuntime({ getSessionManager: () => sm });
  assert.equal(runtime.beginPromptRun().startLeafId, null);
  sm.appendMessage({ role: "user", content: "new root", timestamp: Date.now() });
  assert.equal(runtime.onAgentSettled(), null);
});

test("real SessionManager disk round-trip: SDK context excludes custom, reader parses duration", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-timing-test-"));
  try {
    const sm = SessionManager.create(tempDir, tempDir);
    const runtime = new RunTimingRuntime({ getSessionManager: () => sm });

    const run = runtime.beginPromptRun();
    sm.appendMessage({ role: "user", content: "hello world", timestamp: Date.now() });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "how can I help?" }],
      timestamp: Date.now(),
    });

    const record = runtime.onAgentSettled({ aborted: false });
    assert.ok(record);
    assert.ok(record.finalAssistantEntryId);

    // 1. SDK buildSessionContext must not contain custom timing entries
    const sdkContext = sm.buildSessionContext();
    assert.equal(sdkContext.messages.length, 2);
    assert.deepEqual(sdkContext.messages.map((m) => m.role), ["user", "assistant"]);

    // 2. Open from disk and verify file round-trip
    const sessionFile = sm.getSessionFile();
    assert.ok(sessionFile);
    const reloaded = SessionManager.open(sessionFile);
    const entries = reloaded.getEntries();
    const timingEntry = entries.find((e) => e.type === "custom" && e.customType === RUN_TIMING_CUSTOM_TYPE);
    assert.ok(timingEntry);
    assert.equal(timingEntry.data.runId, run.runId);
    assert.equal(timingEntry.data.finalAssistantEntryId, record.finalAssistantEntryId);

    // 3. buildRunDurationIndex successfully indexes the exact duration
    const durationIndex = buildRunDurationIndex(entries);
    assert.ok(durationIndex.has(record.finalAssistantEntryId));
    const indexed = durationIndex.get(record.finalAssistantEntryId);
    assert.equal(indexed.estimated, false);
    assert.equal(indexed.durationMs, record.durationMs);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
