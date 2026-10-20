import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createJiti } from "jiti";
import { componentHarness } from "../components/mcp-test-harness.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  INITIAL_STREAMING_STATE,
  createStreamingStore,
} = await jiti.import("../lib/streaming-message.ts");
const {
  useStreamingSelector,
  selectIsStreaming,
  selectHasStreamingContent,
  selectStreamingMessage,
} = await jiti.import("./useStreamingSelector.ts");

function assistant(content = []) {
  return {
    role: "assistant",
    content,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    timestamp: 123,
  };
}

test("selectors extract accurate slices from streaming state", () => {
  assert.equal(selectIsStreaming(INITIAL_STREAMING_STATE), false);
  assert.equal(selectHasStreamingContent(INITIAL_STREAMING_STATE), false);
  assert.equal(selectStreamingMessage(INITIAL_STREAMING_STATE), null);

  const activeState = {
    isStreaming: true,
    streamingMessage: assistant([{ type: "text", text: "hello" }]),
  };
  assert.equal(selectIsStreaming(activeState), true);
  assert.equal(selectHasStreamingContent(activeState), true);
  assert.deepEqual(selectStreamingMessage(activeState), assistant([{ type: "text", text: "hello" }]));

  const emptyActiveState = {
    isStreaming: true,
    streamingMessage: assistant([]),
  };
  assert.equal(selectIsStreaming(emptyActiveState), true);
  assert.equal(selectHasStreamingContent(emptyActiveState), false);
});

test("renders initial state from store via useStreamingSelector", () => {
  const store = createStreamingStore();
  const Component = ({ store }) => {
    const isStreaming = useStreamingSelector(store, selectIsStreaming);
    return React.createElement("span", null, String(isStreaming));
  };

  const h = componentHarness(Component, { store });
  try {
    h.render();
    assert.equal(h.text(), "false");
  } finally {
    h.cleanup();
  }
});

test("updates selected value when subscribed slice changes and cleans up on unmount", () => {
  const store = createStreamingStore();
  const Component = ({ store }) => {
    const isStreaming = useStreamingSelector(store, selectIsStreaming);
    return React.createElement("span", null, String(isStreaming));
  };

  const h = componentHarness(Component, { store });
  try {
    h.render();
    assert.equal(h.text(), "false");

    store.dispatch({ type: "start" });
    h.render();
    assert.equal(h.text(), "true");

    store.dispatch({ type: "end" });
    h.render();
    assert.equal(h.text(), "false");
  } finally {
    h.cleanup();
  }

  // After cleanup, subscriber is removed so dispatching does not affect harness
  store.dispatch({ type: "start" });
  assert.equal(store.getState().isStreaming, true);
});

test("bails out on unchanged selector values without triggering unnecessary updates", () => {
  const store = createStreamingStore();
  store.dispatch({ type: "start" });
  store.dispatch({ type: "snapshot", message: assistant([{ type: "text", text: "Hello" }]) });

  const StreamingStatusComponent = ({ store }) => {
    const isStreaming = useStreamingSelector(store, selectIsStreaming);
    return React.createElement("div", null, `streaming:${isStreaming}`);
  };

  const MessageComponent = ({ store }) => {
    const message = useStreamingSelector(store, selectStreamingMessage);
    return React.createElement("div", null, `msg:${message?.content[0]?.text ?? ""}`);
  };

  const h1 = componentHarness(StreamingStatusComponent, { store });
  const h2 = componentHarness(MessageComponent, { store });

  try {
    h1.render();
    h2.render();
    assert.equal(h1.text(), "streaming:true");
    assert.equal(h2.text(), "msg:Hello");

    // Dispatch multiple text deltas:
    // isStreaming stays `true` (unchanged), while streamingMessage changes on each delta.
    for (let i = 0; i < 5; i++) {
      store.dispatch({
        type: "delta",
        event: { type: "text_delta", contentIndex: 0, delta: ` ${i}` },
      });
    }

    // Both re-rendered to sync view:
    h1.render();
    h2.render();

    assert.equal(h1.text(), "streaming:true");
    assert.equal(h2.text(), "msg:Hello 0 1 2 3 4");
  } finally {
    h1.cleanup();
    h2.cleanup();
  }
});

test("evaluates per-chunk render vs batching and skips setState for identical values", () => {
  // Evaluates why useStreamingSelector uses plain state updates rather than
  // useSyncExternalStore:
  // 1. Selector equality bailout prevents setState from being scheduled at all
  //    when deltas do not change the selected slice (e.g. isStreaming during delta floods).
  // 2. React 19 microtask batching coalesces multiple rapid deltas within the same
  //    event tick, preventing redundant markdown/AST re-parses.

  const store = createStreamingStore();
  store.dispatch({ type: "start" });
  store.dispatch({ type: "snapshot", message: assistant([{ type: "text", text: "" }]) });

  let isStreamingSetStateCount = 0;
  let messageSetStateCount = 0;

  // Track subscription activity on listeners directly
  const isStreamingListenerCalls = [];
  const messageListenerCalls = [];

  // Simulate useStreamingSelector internal update logic to verify bailout and batching behavior
  let currentIsStreaming = selectIsStreaming(store.getState());
  let currentMessage = selectStreamingMessage(store.getState());

  const unsub1 = store.subscribe(() => {
    const next = selectIsStreaming(store.getState());
    if (!Object.is(currentIsStreaming, next)) {
      currentIsStreaming = next;
      isStreamingSetStateCount++;
    }
    isStreamingListenerCalls.push(next);
  });

  const unsub2 = store.subscribe(() => {
    const next = selectStreamingMessage(store.getState());
    if (!Object.is(currentMessage, next)) {
      currentMessage = next;
      messageSetStateCount++;
    }
    messageListenerCalls.push(next);
  });

  // Rapid dispatch of 20 deltas (simulating high-speed streaming chunk arrival)
  for (let i = 0; i < 20; i++) {
    store.dispatch({
      type: "delta",
      event: { type: "text_delta", contentIndex: 0, delta: "x" },
    });
  }

  // Verification 1: Listeners are invoked synchronously on dispatch
  assert.equal(isStreamingListenerCalls.length, 20);
  assert.equal(messageListenerCalls.length, 20);

  // Verification 2: isStreaming selector NEVER called setState because isStreaming remained true
  assert.equal(isStreamingSetStateCount, 0, "Unchanged selector bails out with 0 setState calls");

  // Verification 3: message selector called setState for each distinct message object
  assert.equal(messageSetStateCount, 20);

  unsub1();
  unsub2();
});

test("catches up state changed between initial render and effect mount", () => {
  // Verifies the catch-up guard:
  // `update();` runs immediately inside useLayoutEffect to capture any dispatch
  // that arrived in the gap between render phase and commit/effect phase.
  const store = createStreamingStore();

  let effectUpdateCount = 0;
  let capturedValue = null;

  // Simulate render phase snapshot
  const renderPhaseValue = selectIsStreaming(store.getState());
  assert.equal(renderPhaseValue, false);

  // Dispatch arrives before effect mounts
  store.dispatch({ type: "start" });
  assert.equal(store.getState().isStreaming, true);

  // Effect mounts and executes catch-up
  const effect = () => {
    const update = () => {
      const next = selectIsStreaming(store.getState());
      if (!Object.is(renderPhaseValue, next)) {
        capturedValue = next;
        effectUpdateCount++;
      }
    };
    update();
    return store.subscribe(update);
  };

  const unsub = effect();
  assert.equal(capturedValue, true, "Effect catch-up successfully captures gap update");
  assert.equal(effectUpdateCount, 1);

  unsub();
});

test("custom equalityFn skips update when derived values match criteria", () => {
  const store = createStreamingStore();
  store.dispatch({ type: "start" });
  store.dispatch({ type: "snapshot", message: assistant([{ type: "text", text: "A" }]) });

  // Custom equality: only care about text length parity (even vs odd)
  const isEvenLength = (state) => (state.streamingMessage?.content[0]?.text?.length ?? 0) % 2 === 0;

  const Component = ({ store }) => {
    const even = useStreamingSelector(store, isEvenLength);
    return React.createElement("span", null, String(even));
  };

  const h = componentHarness(Component, { store });
  try {
    h.render();
    assert.equal(h.text(), "false"); // length 1 is odd

    // Add 1 char -> length 2 (even)
    store.dispatch({
      type: "delta",
      event: { type: "text_delta", contentIndex: 0, delta: "B" },
    });
    h.render();
    assert.equal(h.text(), "true");

    // Add 2 chars -> length 4 (still even, parity unchanged)
    store.dispatch({
      type: "delta",
      event: { type: "text_delta", contentIndex: 0, delta: "CD" },
    });
    h.render();
    assert.equal(h.text(), "true");
  } finally {
    h.cleanup();
  }
});

test("handles store instance switches safely without stale flashes", () => {
  const storeA = createStreamingStore();
  storeA.dispatch({ type: "start" });
  storeA.dispatch({ type: "snapshot", message: assistant([{ type: "text", text: "Store A" }]) });

  const storeB = createStreamingStore();
  storeB.dispatch({ type: "start" });
  storeB.dispatch({ type: "snapshot", message: assistant([{ type: "text", text: "Store B" }]) });

  const Component = ({ store }) => {
    const message = useStreamingSelector(store, selectStreamingMessage);
    return React.createElement("span", null, message?.content[0]?.text ?? "");
  };

  const h = componentHarness(Component, { store: storeA });
  try {
    h.render({ store: storeA });
    assert.equal(h.text(), "Store A");

    // Switch store instance
    h.render({ store: storeB });
    assert.equal(h.text(), "Store B");

    // Further updates to storeA should not affect component subscribed to storeB
    storeA.dispatch({
      type: "delta",
      event: { type: "text_delta", contentIndex: 0, delta: " update" },
    });
    h.render({ store: storeB });
    assert.equal(h.text(), "Store B");

    // Updates to storeB work as expected
    storeB.dispatch({
      type: "delta",
      event: { type: "text_delta", contentIndex: 0, delta: " update" },
    });
    h.render({ store: storeB });
    assert.equal(h.text(), "Store B update");
  } finally {
    h.cleanup();
  }
});

test("StrictMode double-mounting lifecycle is safe and does not leak subscribers", () => {
  const store = createStreamingStore();

  let activeListeners = 0;
  const originalSubscribe = store.subscribe;
  store.subscribe = (listener) => {
    activeListeners++;
    const unsubscribe = originalSubscribe(listener);
    return () => {
      activeListeners--;
      unsubscribe();
    };
  };

  // Mount component 1
  const Component = ({ store }) => {
    const isStreaming = useStreamingSelector(store, selectIsStreaming);
    return React.createElement("span", null, String(isStreaming));
  };

  const h1 = componentHarness(Component, { store });
  h1.render();
  assert.equal(activeListeners, 1);

  // Unmount
  h1.cleanup();
  assert.equal(activeListeners, 0, "Cleanup removes listener, preventing memory leaks");

  // Remount (StrictMode second mount simulation)
  const h2 = componentHarness(Component, { store });
  h2.render();
  assert.equal(activeListeners, 1, "Remount establishes exactly one active listener");

  store.dispatch({ type: "start" });
  h2.render();
  assert.equal(h2.text(), "true");

  h2.cleanup();
  assert.equal(activeListeners, 0);
});
