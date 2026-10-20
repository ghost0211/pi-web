import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  INITIAL_STREAMING_STATE,
  createStreamingStore,
  streamReducer,
} = await jiti.import("./streaming-message.ts");

function assistant(content = []) {
  return {
    role: "assistant",
    content,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    timestamp: 123,
  };
}

function snapshot(state, message) {
  return streamReducer(state, { type: "snapshot", message });
}

function delta(state, event) {
  return streamReducer(state, { type: "delta", event });
}

test("builds thinking and text blocks from official assistant deltas", () => {
  let state = streamReducer(INITIAL_STREAMING_STATE, { type: "start" });
  state = snapshot(state, assistant());
  state = delta(state, { type: "thinking_start", contentIndex: 0 });
  state = delta(state, { type: "thinking_delta", contentIndex: 0, delta: "Plan" });
  state = delta(state, { type: "thinking_end", contentIndex: 0, content: "Plan." });
  state = delta(state, { type: "text_start", contentIndex: 1 });
  state = delta(state, { type: "text_delta", contentIndex: 1, delta: "Hel" });
  state = delta(state, { type: "text_delta", contentIndex: 1, delta: "lo" });
  state = delta(state, { type: "text_end", contentIndex: 1, content: "Hello" });

  assert.equal(state.isStreaming, true);
  assert.equal(state.streamingMessage.model, "claude-sonnet-4-6");
  assert.equal(state.streamingMessage.provider, "anthropic");
  assert.equal(state.streamingMessage.timestamp, 123);
  assert.deepEqual(state.streamingMessage.content, [
    { type: "thinking", thinking: "Plan." },
    { type: "text", text: "Hello" },
  ]);
});

test("a reconnect snapshot replaces the old partial before deltas continue", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "text", text: "stale" },
  ]));
  state = snapshot(state, assistant([
    { type: "text", text: "Hello wor" },
  ]));
  state = delta(state, { type: "text_delta", contentIndex: 0, delta: "ld" });

  assert.deepEqual(state.streamingMessage.content, [
    { type: "text", text: "Hello world" },
  ]);
});

test("resuming a running session preserves an already-received partial", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "text", text: "Hello" },
  ]));
  state = streamReducer(state, { type: "resume" });

  assert.equal(state.isStreaming, true);
  assert.deepEqual(state.streamingMessage.content, [
    { type: "text", text: "Hello" },
  ]);
});

test("a thinking start clears the first chunk leaked into the assistant snapshot", () => {
  // Pi's `start` event aliases the live partial message, so `message_start`
  // can already contain the first delta; the deltas deliver it again.
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "thinking", thinking: "The", thinkingSignature: "reasoning_content" },
  ]));
  state = delta(state, { type: "thinking_start", contentIndex: 0 });
  state = delta(state, { type: "thinking_delta", contentIndex: 0, delta: "The" });
  state = delta(state, { type: "thinking_delta", contentIndex: 0, delta: " user" });

  assert.deepEqual(state.streamingMessage.content, [
    { type: "thinking", thinking: "The user" },
  ]);
});

test("a text start clears text leaked into the assistant snapshot", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "text", text: "The" },
  ]));
  state = delta(state, { type: "text_start", contentIndex: 0 });
  state = delta(state, { type: "text_delta", contentIndex: 0, delta: "The" });
  state = delta(state, { type: "text_delta", contentIndex: 0, delta: " command" });

  assert.deepEqual(state.streamingMessage.content, [
    { type: "text", text: "The command" },
  ]);
});

test("a tool call start clears streamed input leaked into the snapshot", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "toolCall", id: "call-1", name: "bash", arguments: {}, partialJson: '{"command":' },
  ]));
  state = delta(state, { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "bash" });
  state = delta(state, { type: "toolcall_delta", contentIndex: 0, delta: '{"command":' });
  state = delta(state, { type: "toolcall_delta", contentIndex: 0, delta: '"pwd"}' });

  assert.equal(state.streamingMessage.content[0].rawInput, '{"command":"pwd"}');
  assert.deepEqual(state.streamingMessage.content[0].input, {});
});

test("text deltas update immutably so React observes each chunk", () => {
  const previous = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "text", text: "Hello" },
  ]));
  const next = delta(previous, { type: "text_delta", contentIndex: 0, delta: "!" });

  assert.notStrictEqual(next, previous);
  assert.notStrictEqual(next.streamingMessage, previous.streamingMessage);
  assert.notStrictEqual(next.streamingMessage.content, previous.streamingMessage.content);
  assert.equal(previous.streamingMessage.content[0].text, "Hello");
  assert.equal(next.streamingMessage.content[0].text, "Hello!");
});

test("shows and streams a tool call after thinking, then accepts the authoritative end", () => {
  let state = snapshot(INITIAL_STREAMING_STATE, assistant([
    { type: "thinking", thinking: "I will write the file." },
  ]));

  state = delta(state, {
    type: "toolcall_start",
    contentIndex: 1,
    id: "call-1",
    toolName: "write",
  });
  assert.deepEqual(state.streamingMessage.content, [
    { type: "thinking", thinking: "I will write the file." },
    {
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "write",
      input: {},
      rawInput: "",
    },
  ]);

  const beforeDelta = state;
  state = delta(state, {
    type: "toolcall_delta",
    contentIndex: 1,
    delta: '{"path":',
    id: "call-1",
    toolName: "write",
  });
  state = delta(state, { type: "toolcall_delta", contentIndex: 1, delta: '"/tmp/file"' });
  assert.notStrictEqual(state, beforeDelta);
  assert.equal(state.streamingMessage.content[1].rawInput, '{"path":"/tmp/file"');

  state = delta(state, {
    type: "toolcall_end",
    contentIndex: 1,
    toolCall: {
      type: "toolCall",
      id: "call-1",
      name: "write",
      arguments: { path: "/tmp/file" },
    },
  });
  assert.deepEqual(state.streamingMessage.content, [
    { type: "thinking", thinking: "I will write the file." },
    {
      type: "toolCall",
      toolCallId: "call-1",
      toolName: "write",
      input: { path: "/tmp/file" },
    },
  ]);
  assert.equal(Object.hasOwn(state.streamingMessage.content[1], "rawInput"), false);
});

test("restores the raw tool input from a reconnect snapshot", () => {
  const state = snapshot(INITIAL_STREAMING_STATE, assistant([{
    type: "toolCall",
    id: "call-2",
    name: "write",
    arguments: { path: "/tmp/reconnected" },
    partialJson: '{"path":"/tmp/reconnected","content":"hel',
  }]));

  assert.deepEqual(state.streamingMessage.content, [{
    type: "toolCall",
    toolCallId: "call-2",
    toolName: "write",
    input: { path: "/tmp/reconnected" },
    rawInput: '{"path":"/tmp/reconnected","content":"hel',
  }]);
});

test("ignores deltas without a baseline and unknown future deltas", () => {
  const started = streamReducer(INITIAL_STREAMING_STATE, { type: "start" });
  assert.strictEqual(
    delta(started, { type: "text_delta", contentIndex: 0, delta: "lost" }),
    started,
  );

  const withMessage = snapshot(started, assistant());
  assert.strictEqual(
    delta(withMessage, { type: "future_delta", contentIndex: 0, delta: "ignored" }),
    withMessage,
  );
});

test("normalizes tool calls in snapshots and clears on end", () => {
  const state = snapshot(INITIAL_STREAMING_STATE, assistant([{
    type: "toolCall",
    id: "call-2",
    name: "bash",
    arguments: { command: "pwd" },
  }]));
  assert.deepEqual(state.streamingMessage.content, [{
    type: "toolCall",
    toolCallId: "call-2",
    toolName: "bash",
    input: { command: "pwd" },
  }]);
  assert.strictEqual(streamReducer(state, { type: "end" }), INITIAL_STREAMING_STATE);
});

test("supports reset action to clear streaming state identically to end", () => {
  const state = snapshot(INITIAL_STREAMING_STATE, assistant([{
    type: "text",
    text: "hello",
  }]));
  assert.equal(state.isStreaming, true);
  assert.strictEqual(streamReducer(state, { type: "reset" }), INITIAL_STREAMING_STATE);
});

test("createStreamingStore manages external state and notifies subscribers", () => {
  const store = createStreamingStore();
  assert.deepEqual(store.getState(), INITIAL_STREAMING_STATE);

  let notifyCount = 0;
  const unsub = store.subscribe(() => {
    notifyCount++;
  });

  store.dispatch({ type: "start" });
  assert.equal(notifyCount, 1);
  assert.equal(store.getState().isStreaming, true);
  assert.equal(store.getState().streamingMessage, null);

  // Snapshot changes state and triggers listener
  store.dispatch({ type: "snapshot", message: assistant([{ type: "text", text: "Hi" }]) });
  assert.equal(notifyCount, 2);
  assert.equal(store.getState().streamingMessage.content[0].text, "Hi");

  // Deltas notify synchronously
  store.dispatch({
    type: "delta",
    event: { type: "text_delta", contentIndex: 0, delta: " there" },
  });
  assert.equal(notifyCount, 3);
  assert.equal(store.getState().streamingMessage.content[0].text, "Hi there");

  // No-op action (ignored delta) must NOT notify
  store.dispatch({
    type: "delta",
    event: { type: "future_delta", contentIndex: 0, delta: "noop" },
  });
  assert.equal(notifyCount, 3, "No-op dispatch does not invoke listeners");

  // Unsubscribe stops notifications
  unsub();
  store.dispatch({ type: "end" });
  assert.equal(notifyCount, 3);
  assert.deepEqual(store.getState(), INITIAL_STREAMING_STATE);
});

test("createStreamingStore safely handles unsubscriptions during listener notifications", () => {
  const store = createStreamingStore();
  const callOrder = [];

  let unsub2;
  const unsub1 = store.subscribe(() => {
    callOrder.push("listener1");
    // Listener 1 unsubscribes listener 2 mid-flight
    if (unsub2) unsub2();
  });

  unsub2 = store.subscribe(() => {
    callOrder.push("listener2");
  });

  const unsub3 = store.subscribe(() => {
    callOrder.push("listener3");
  });

  store.dispatch({ type: "start" });
  // Listener 2 was unsubscribed during listener 1, so it shouldn't be called
  assert.deepEqual(callOrder, ["listener1", "listener3"]);

  unsub1();
  unsub3();
});
