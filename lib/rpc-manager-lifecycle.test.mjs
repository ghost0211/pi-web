import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// Real startup fixtures must never load or write the operator's Pi settings.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper, getRpcSession, resolveSessionShutdownDeadlineMs, setRpcSessionTools, startRpcSession } = await jiti.import("./rpc-manager.ts");
after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function heldInner(calls) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  return {
    inner: {
      sessionId: "closing-session", isBashRunning: false, isStreaming: false,
      extensionRunner: { emit: async (event) => { calls.push(event.type); await held; } },
      dispose: () => calls.push("dispose"),
    },
    release,
  };
}

test("shutdown deadline is finite, defaults to 5s and rejects unsafe timer values", (t) => {
  t.mock.method(console, "warn", () => {});
  for (const value of ["", " ", "0", "-1", "bad", "Infinity", "2147483648"]) {
    assert.equal(resolveSessionShutdownDeadlineMs(value), 5000);
  }
  assert.equal(resolveSessionShutdownDeadlineMs("250"), 250);
  assert.equal(resolveSessionShutdownDeadlineMs("2147483647"), 2147483647);
});

test("closing begins before any await, rejects new work and joins concurrent shutdown", async () => {
  const calls = [];
  const { inner, release } = heldInner(calls);
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push("unregister"));
  const shutting = wrapper.shutdown();
  assert.equal(wrapper.isAlive(), false);
  await assert.rejects(wrapper.send({ type: "prompt", message: "too late" }), /shutting down/);
  const joined = wrapper.shutdown();
  await nextTurn();
  assert.deepEqual(calls, ["session_shutdown"]);
  release();
  await Promise.all([shutting, joined]);
  assert.deepEqual(calls, ["session_shutdown", "dispose", "unregister"]);
  assert.equal(await wrapper.waitUntilDisposed(1), true);
});

for (const operation of ["shutdown", "destroy"]) {
  test(`${operation} disposes a hung session_shutdown after its deadline`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(console, "warn", () => {});
    const calls = [];
    const { inner } = heldInner(calls);
    const wrapper = new AgentSessionWrapper(inner);
    wrapper.onDestroy(() => calls.push("unregister"));
    const done = wrapper[operation]();
    await nextTurn();
    t.mock.timers.tick(4999);
    await nextTurn();
    assert.deepEqual(calls, ["session_shutdown"]);
    t.mock.timers.tick(1);
    await done;
    await nextTurn();
    assert.deepEqual(calls, ["session_shutdown", "dispose", "unregister"]);
    assert.equal(await wrapper.waitUntilDisposed(1), true);
  });
}

test("a hung extension binding shares the shutdown deadline and cannot emit after disposal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const calls = [];
  const { inner } = heldInner(calls);
  const wrapper = new AgentSessionWrapper(inner);
  let releaseBinding;
  wrapper.extensionBindingPromise = new Promise((resolve) => { releaseBinding = resolve; });
  const done = wrapper.shutdown();
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(5000);
  await done;
  assert.deepEqual(calls, ["dispose"]);
  releaseBinding();
  await nextTurn();
  assert.deepEqual(calls, ["dispose"], "no session_shutdown is emitted on the disposed SDK");
});

test("a late hook rejection after timed-out shutdown is handled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  let rejectLate;
  let disposed = 0;
  const wrapper = new AgentSessionWrapper({
    sessionId: "late", isBashRunning: false,
    extensionRunner: { emit: () => new Promise((_resolve, reject) => { rejectLate = reject; }) },
    dispose: () => { disposed++; },
  });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const done = wrapper.shutdown();
  await nextTurn();
  t.mock.timers.tick(5000);
  await done;
  rejectLate(new Error("late close failure"));
  await nextTurn();
  assert.equal(disposed, 1);
  assert.deepEqual(unhandled, []);
});

test("custom shutdown deadlines apply and do not hold a quitting process open", async (t) => {
  const previous = process.env.PI_WEB_SHUTDOWN_DEADLINE_MS;
  process.env.PI_WEB_SHUTDOWN_DEADLINE_MS = "250";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_SHUTDOWN_DEADLINE_MS;
    else process.env.PI_WEB_SHUTDOWN_DEADLINE_MS = previous;
  });
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const timer = realSetTimeout(callback, delay, ...args);
    timers.push(timer);
    return timer;
  });
  const { inner, release } = heldInner([]);
  const wrapper = new AgentSessionWrapper(inner);
  const done = wrapper.shutdown();
  await nextTurn();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].hasRef(), false);
  release();
  await done;
});

async function startPersisted(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = SessionManager.create(cwd);
  manager.appendMessage({ role: "user", content: "persisted", timestamp: Date.now() });
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile && existsSync(sessionFile));
  const { session } = await startRpcSession(sessionId, sessionFile, undefined, { toolNames: [] });
  t.after(() => session.destroy());
  assert.ok(getRpcSession(sessionId) === session);
  return { session, sessionId, sessionFile };
}

function holdShutdown(wrapper) {
  let release, signalStarted;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { signalStarted = resolve; });
  wrapper.inner.extensionRunner.emit = async () => { signalStarted(); await held; };
  return { release, started };
}

test("concurrent restarts wait for disposal and share one replacement", async (t) => {
  const { session: closing, sessionId, sessionFile } = await startPersisted(t);
  const hook = holdShutdown(closing);
  const order = [];
  const dispose = closing.inner.dispose.bind(closing.inner);
  closing.inner.dispose = () => { order.push("disposed"); dispose(); };
  const done = closing.shutdown();
  await hook.started;
  const replacing = startRpcSession(sessionId, sessionFile, undefined).then((started) => {
    order.push("started"); return started;
  });
  const concurrent = startRpcSession(sessionId, sessionFile, undefined);
  t.after(async () => {
    hook.release();
    for (const pending of [replacing, concurrent]) (await pending.catch(() => null))?.session.destroy();
  });
  await nextTurn();
  assert.deepEqual(order, []);
  assert.ok(globalThis.__piStartLocks.has(sessionId));
  hook.release();
  await done;
  const { session: replacement } = await replacing;
  assert.deepEqual(order, ["disposed", "started"]);
  assert.ok(replacement !== closing);
  assert.ok((await concurrent).session === replacement);
  assert.ok(getRpcSession(sessionId) === replacement);
});

test("a tool change while closing applies to a concurrently reopened wrapper", async (t) => {
  const { session: closing, sessionId, sessionFile } = await startPersisted(t);
  const hook = holdShutdown(closing);
  const done = closing.shutdown();
  await hook.started;
  const reconnect = startRpcSession(sessionId, sessionFile, undefined);
  const change = setRpcSessionTools(sessionId, sessionFile, ["read"]);
  t.after(async () => {
    hook.release();
    for (const pending of [reconnect, change]) (await pending.catch(() => null))?.session.destroy();
  });
  hook.release();
  await done;
  const changed = await change;
  await reconnect;
  assert.equal(changed.session.isAlive(), true);
  assert.equal(changed.session.isChatOnly(), false);
  assert.ok(getRpcSession(sessionId) === changed.session);
  assert.ok((await changed.session.send({ type: "get_tools" })).some((tool) => tool.name === "read" && tool.active));
});

for (const preHmrCallback of [false, true]) {
  test(`a late closing wrapper cannot unregister its replacement (pre-HMR=${preHmrCallback})`, async (t) => {
    const { session: closing, sessionId, sessionFile } = await startPersisted(t);
    const hook = holdShutdown(closing);
    if (preHmrCallback) closing.onDestroy(() => globalThis.__piSessions.delete(sessionId));
    // Exercise the bounded-wait fallback without spending six wall-clock seconds.
    closing.waitUntilDisposed = async () => false;
    t.mock.method(console, "warn", () => {});
    const done = closing.shutdown();
    await hook.started;
    const { session: replacement } = await startRpcSession(sessionId, sessionFile, undefined);
    t.after(() => replacement.destroy());
    assert.ok(replacement !== closing);
    hook.release();
    await done;
    assert.ok(getRpcSession(sessionId) === replacement);
    await replacement.shutdown();
    assert.equal(getRpcSession(sessionId), undefined);
  });
}
