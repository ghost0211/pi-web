import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": process.cwd(),
  },
});
const { createAgentEventStream, closeAllAgentEventStreams } = await jiti.import("./agent-event-stream.ts");
const decoder = new TextDecoder();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function readWithin(reader, timeoutMs = 1_000) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out reading SSE chunk")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeData(chunk) {
  const text = decoder.decode(chunk.value);
  assert.match(text, /^data: /);
  return JSON.parse(text.slice("data: ".length));
}

test("opens the transport before a slow session is ready and snapshots after subscribing", async () => {
  const startup = deferred();
  const abortController = new AbortController();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    startup.promise,
  );
  const reader = stream.getReader();

  const transport = await readWithin(reader);
  assert.equal(decoder.decode(transport.value), ":\n\n");

  const snapshot = { role: "assistant", content: [{ type: "text", text: "Hello" }] };
  let listener;
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  startup.resolve({
    isStreaming: true,
    streamingMessage: snapshot,
    onEvent(nextListener) {
      subscribeCount += 1;
      listener = nextListener;
      nextListener({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_delta", delta: "ignored" },
      });
      nextListener({ type: "agent_start" });
      return () => { unsubscribeCount += 1; };
    },
  });

  const connected = decodeData(await readWithin(reader));
  const messageStart = decodeData(await readWithin(reader));
  const replayedEvent = decodeData(await readWithin(reader));
  assert.equal(subscribeCount, 1);
  assert.deepEqual(connected, {
    type: "connected",
    sessionId: "session-id",
    isStreaming: true,
  });
  assert.deepEqual(messageStart, { type: "agent_start" });
  assert.deepEqual(replayedEvent, { type: "message_start", message: snapshot });

  listener({
    type: "message_update",
    message: { ...snapshot },
    assistantMessageEvent: {
      type: "text_delta",
      delta: "!",
      partial: { ...snapshot },
    },
  });
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "!" },
  });

  abortController.abort();
  assert.equal(unsubscribeCount, 1);
  assert.equal((await readWithin(reader)).done, true);
});

test("reports a startup failure in-band after opening the transport", async () => {
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "session-id",
    Promise.reject(new Error("broken config")),
  );
  const reader = stream.getReader();

  assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "startup_error",
    errorMessage: "Failed to start agent: broken config",
  });
  assert.equal((await readWithin(reader)).done, true);
});

test("does not subscribe when the client cancels during startup", async () => {
  const startup = deferred();
  let subscribeCount = 0;
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "session-id",
    startup.promise,
  );
  const reader = stream.getReader();

  await readWithin(reader);
  await reader.cancel();
  startup.resolve({
    isStreaming: false,
    streamingMessage: undefined,
    onEvent() {
      subscribeCount += 1;
      return () => {};
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subscribeCount, 0);
});

test("session_shutdown from a live wrapper closes the SSE stream", async () => {
  const abortController = new AbortController();
  let listener;
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    Promise.resolve({
      isStreaming: false,
      streamingMessage: undefined,
      isAlive: () => true,
      onEvent(nextListener) {
        listener = nextListener;
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  await readWithin(reader);
  decodeData(await readWithin(reader));
  listener({ type: "session_shutdown" });
  assert.equal((await readWithin(reader)).done, true);
});

test("does not subscribe when the wrapper died before the snapshot", async () => {
  let subscribeCount = 0;
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "session-id",
    Promise.resolve({
      isStreaming: false,
      streamingMessage: undefined,
      isAlive: () => false,
      onEvent() {
        subscribeCount += 1;
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  await readWithin(reader);
  assert.equal((await readWithin(reader)).done, true);
  assert.equal(subscribeCount, 0);
});

test("closes an already-aborted request and handles a later startup rejection", async () => {
  const abortController = new AbortController();
  abortController.abort();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    Promise.reject(new Error("startup failed after disconnect")),
  );

  assert.equal((await readWithin(stream.getReader())).done, true);
  await new Promise((resolve) => setImmediate(resolve));
});

async function connectedStream(sessionId) {
  const abortController = new AbortController();
  let listener;
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    sessionId,
    Promise.resolve({
      isStreaming: true,
      streamingMessage: undefined,
      onEvent(nextListener) {
        listener = nextListener;
        return () => {};
      },
    }),
  );
  const reader = stream.getReader();
  assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "connected",
    sessionId,
    isStreaming: true,
  });
  return { reader, listener, abortController };
}

const BIG_PAYLOAD = "x".repeat(30_000);

function toolUpdate(partialResult = BIG_PAYLOAD) {
  return {
    type: "tool_execution_update",
    toolCallId: "call-1",
    toolName: "bash",
    partialResult,
  };
}

/** Non-droppable, so it always survives and marks the end of the queued batch. */
function sentinelEvent() {
  return { type: "agent_end" };
}

test("terminates the stream when an unread, non-rebuildable backlog exceeds the limit", async () => {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(64 * 1024);
  try {
    const { reader, listener } = await connectedStream("backlog-session");

    // Stop reading here: message snapshots cannot be rebuilt client-side, so
    // they must hit the hard limit instead of being dropped.
    const message = { role: "assistant", content: [{ type: "text", text: BIG_PAYLOAD }] };
    for (let index = 0; index < 8; index += 1) {
      listener({ type: "message_start", message });
    }

    let queuedChunks = 0;
    await assert.rejects(async () => {
      for (;;) {
        const next = await readWithin(reader);
        if (next.done) return;
        queuedChunks += 1;
        assert.ok(queuedChunks < 8, "stream kept queueing past the backlog limit");
      }
    }, /client backlog exceeded/);
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});

test("drops rebuildable deltas while the client is behind instead of disconnecting it", async () => {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(8 * 1024 * 1024);
  try {
    const { reader, listener, abortController } = await connectedStream("behind-session");

    const emitted = 60;
    for (let index = 0; index < emitted; index += 1) listener(toolUpdate());
    listener(sentinelEvent());

    // Whatever was queued before the water mark is still delivered…
    let delivered = 0;
    let sawSentinel = false;
    while (!sawSentinel) {
      const next = await readWithin(reader);
      assert.equal(next.done, false);
      const event = decodeData(next);
      if (event.type === "agent_end") sawSentinel = true;
      else delivered += 1;
    }
    assert.ok(delivered < emitted, `expected drops, delivered ${delivered} of ${emitted}`);

    // …and the stream stays usable once the client catches up.
    listener(toolUpdate());
    const afterCatchUp = await readWithin(reader);
    assert.equal(afterCatchUp.done, false);
    assert.equal(decodeData(afterCatchUp).type, "tool_execution_update");
    abortController.abort();
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});

test("keeps the start and end of a streamed block while dropping its deltas", async (t) => {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(8 * 1024 * 1024);
  try {
    const { reader, listener, abortController } = await connectedStream("block-session");
    t.after(() => abortController.abort());
    const update = (assistantMessageEvent) => ({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent,
    });

    listener(update({ type: "text_start", contentIndex: 0 }));
    for (let index = 0; index < 60; index += 1) {
      listener(update({ type: "text_delta", contentIndex: 0, delta: BIG_PAYLOAD }));
    }
    // The client's reducer replaces the block with this content, repairing any dropped delta.
    listener(update({ type: "text_end", contentIndex: 0, content: "final text" }));
    listener(sentinelEvent());

    const kinds = [];
    for (;;) {
      const event = decodeData(await readWithin(reader));
      if (event.type === "agent_end") break;
      kinds.push(event.assistantMessageEvent.type);
    }
    assert.equal(kinds[0], "text_start");
    assert.equal(kinds.at(-1), "text_end");
    assert.ok(kinds.length < 62, `expected dropped deltas, got ${kinds.length} events`);
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});

test("delivers every event to a client that reads promptly", async () => {
  const { reader, listener, abortController } = await connectedStream("prompt-session");
  for (let index = 0; index < 40; index += 1) {
    listener(toolUpdate());
    const next = await readWithin(reader);
    assert.equal(next.done, false);
    assert.equal(decodeData(next).type, "tool_execution_update");
  }
  abortController.abort();
});

test("gracefully closes SSE streams with error at process shutdown", async () => {
  const { reader: reader1, abortController: ac1 } = await connectedStream("shutdown-s1");
  const { reader: reader2, abortController: ac2 } = await connectedStream("shutdown-s2");

  closeAllAgentEventStreams();

  await assert.rejects(async () => {
    await readWithin(reader1);
  }, /pi-web server shutting down/);

  await assert.rejects(async () => {
    await readWithin(reader2);
  }, /pi-web server shutting down/);

  // Subsequent call should be safe and idempotent
  closeAllAgentEventStreams();
  ac1.abort();
  ac2.abort();
});

test("exercises an actual slow ReadableStream reader dropping deltas under backpressure", async (t) => {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(8 * 1024 * 1024);
  try {
    const { reader, listener, abortController } = await connectedStream("slow-reader-session");
    t.after(() => abortController.abort());

    // Concurrently emit events faster than the reader reads them
    const emitted = 60;
    const emitTask = (async () => {
      for (let i = 0; i < emitted; i += 1) {
        listener(toolUpdate());
        if (i % 10 === 0) await new Promise((r) => setTimeout(r, 2));
      }
      listener(sentinelEvent());
    })();

    // The slow reader consumes with deliberate pauses between reads
    let receivedToolUpdates = 0;
    let sawSentinel = false;
    while (!sawSentinel) {
      await new Promise((r) => setTimeout(r, 8)); // deliberate slow reader pacing
      const chunk = await readWithin(reader, 2_000);
      assert.equal(chunk.done, false);
      const event = decodeData(chunk);
      if (event.type === "agent_end") {
        sawSentinel = true;
      } else if (event.type === "tool_execution_update") {
        receivedToolUpdates += 1;
      }
    }

    await emitTask;

    assert.ok(receivedToolUpdates < emitted, `expected dropped updates due to slow reader, got ${receivedToolUpdates} of ${emitted}`);
    assert.ok(receivedToolUpdates > 0, "slow reader should still have received initial queued chunks");
    assert.equal(sawSentinel, true, "non-droppable sentinel must be delivered to slow reader");
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});

test("isolates subscribers: slow reader hitting backlog cap does not affect prompt reader on same session", async (t) => {
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(64 * 1024);
  try {
    const listeners = [];
    const sharedSession = {
      isStreaming: true,
      streamingMessage: undefined,
      onEvent(l) {
        listeners.push(l);
        return () => {
          const idx = listeners.indexOf(l);
          if (idx !== -1) listeners.splice(idx, 1);
        };
      },
    };

    const acSlow = new AbortController();
    const acPrompt = new AbortController();
    t.after(() => {
      acSlow.abort();
      acPrompt.abort();
    });

    const streamSlow = createAgentEventStream(
      new Request("http://localhost/events", { signal: acSlow.signal }),
      "isolated-session",
      Promise.resolve(sharedSession),
    );
    const streamPrompt = createAgentEventStream(
      new Request("http://localhost/events", { signal: acPrompt.signal }),
      "isolated-session",
      Promise.resolve(sharedSession),
    );

    const readerSlow = streamSlow.getReader();
    const readerPrompt = streamPrompt.getReader();

    // Consume preambles for both
    await readWithin(readerSlow);
    decodeData(await readWithin(readerSlow));
    await readWithin(readerPrompt);
    decodeData(await readWithin(readerPrompt));

    assert.equal(listeners.length, 2);

    // Emit non-droppable message starts.
    // The prompt reader reads promptly; slow reader does not read.
    const message = { role: "assistant", content: [{ type: "text", text: BIG_PAYLOAD }] };
    for (let i = 0; i < 8; i += 1) {
      for (const l of [...listeners]) l({ type: "message_start", message });
      const promptChunk = await readWithin(readerPrompt);
      assert.equal(promptChunk.done, false);
      assert.equal(decodeData(promptChunk).type, "message_start");
    }

    // Slow reader should reject with client backlog exceeded
    await assert.rejects(async () => {
      for (;;) {
        const next = await readWithin(readerSlow);
        if (next.done) break;
      }
    }, /client backlog exceeded/);

    // Slow reader cleaned up and unhooked from session listeners
    assert.equal(listeners.length, 1);

    // Prompt reader continues operating without issue
    for (const l of [...listeners]) l(sentinelEvent());
    const promptSentinel = await readWithin(readerPrompt);
    assert.equal(promptSentinel.done, false);
    assert.equal(decodeData(promptSentinel).type, "agent_end");
  } finally {
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
  }
});

test("isolates subscribers: listener error in one subscriber does not disrupt another healthy subscriber", async (t) => {
  const listeners = [];
  const sharedSession = {
    isStreaming: true,
    streamingMessage: undefined,
    onEvent(l) {
      listeners.push(l);
      return () => {
        const idx = listeners.indexOf(l);
        if (idx !== -1) listeners.splice(idx, 1);
      };
    },
  };

  const acHealthy = new AbortController();
  t.after(() => acHealthy.abort());

  const streamHealthy = createAgentEventStream(
    new Request("http://localhost/events", { signal: acHealthy.signal }),
    "isolate-health-session",
    Promise.resolve(sharedSession),
  );
  const readerHealthy = streamHealthy.getReader();
  await readWithin(readerHealthy);
  decodeData(await readWithin(readerHealthy));

  // Add an external listener that throws
  let throwerCalls = 0;
  listeners.unshift(() => {
    throwerCalls += 1;
    throw new Error("simulated listener failure");
  });

  // Dispatch events to all listeners
  for (const l of [...listeners]) {
    try {
      l(sentinelEvent());
    } catch {
      // simulate session continuing or logging
    }
  }

  const next = await readWithin(readerHealthy);
  assert.equal(next.done, false);
  assert.deepEqual(decodeData(next), { type: "agent_end" });
  assert.equal(throwerCalls, 1);
});

test("a throwing unsubscribe cannot strand a response on shutdown", async () => {
  let unsubscribed = 0;
  const stream = createAgentEventStream(new Request("http://localhost/events"), "bad-teardown", Promise.resolve({
    isStreaming: false,
    streamingMessage: undefined,
    onEvent() { return () => { unsubscribed++; throw new Error("bad teardown"); }; },
  }));
  const reader = stream.getReader();
  await readWithin(reader);
  decodeData(await readWithin(reader));
  closeAllAgentEventStreams();
  await assert.rejects(readWithin(reader), /pi-web server shutting down/);
  assert.equal(unsubscribed, 1);
  closeAllAgentEventStreams();
  assert.equal(unsubscribed, 1);
});

test("Edge instrumentation excludes Node signal registration", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../instrumentation.ts", import.meta.url), "utf8");
  assert.match(source, /if \(process\.env\.NEXT_RUNTIME === "nodejs"\)/);
  assert.doesNotMatch(source, /process\.on\(/);
  const previousRuntime = process.env.NEXT_RUNTIME;
  try {
    process.env.NEXT_RUNTIME = "edge";
    const { register } = await jiti.import("../instrumentation.ts");
    const before = process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    await register();
    assert.equal(process.listenerCount("SIGINT") + process.listenerCount("SIGTERM"), before);
  } finally {
    if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = previousRuntime;
  }
});

test("instrumentation registers SIGINT and SIGTERM hooks that close agent event streams", async () => {
  const previousRuntime = process.env.NEXT_RUNTIME;
  process.env.NEXT_RUNTIME = "nodejs";

  const registeredListeners = { SIGINT: [], SIGTERM: [] };
  const origOn = process.on;
  process.on = function (sig, handler) {
    if (sig === "SIGINT" || sig === "SIGTERM") {
      registeredListeners[sig].push(handler);
      return process;
    }
    return origOn.apply(this, arguments);
  };

  try {
    const { register } = await jiti.import("../instrumentation.ts");
    await register();

    assert.ok(registeredListeners.SIGINT.length >= 1, "SIGINT handler registered");
    assert.ok(registeredListeners.SIGTERM.length >= 1, "SIGTERM handler registered");

    const { reader, abortController } = await connectedStream("instrumentation-session");
    // Trigger the registered SIGINT shutdown handler
    registeredListeners.SIGINT[registeredListeners.SIGINT.length - 1]();

    await assert.rejects(async () => {
      await readWithin(reader);
    }, /pi-web server shutting down/);
    abortController.abort();
  } finally {
    process.on = origOn;
    if (previousRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = previousRuntime;
  }
});
