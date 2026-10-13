import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper, resolveSessionIdleTimeoutMs } = await jiti.import("./rpc-manager.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function configure(t, value) {
  const previous = process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS;
  process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS = value;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS;
    else process.env.PI_WEB_SESSION_IDLE_TIMEOUT_MS = previous;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
}
function makeInner() {
  return {
    sessionId: "stuck-stop", isBashRunning: false, isStreaming: true, isCompacting: false,
    extensionRunner: {}, agent: { state: {} }, sessionManager: { getCwd: () => process.cwd() },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    subscribe: () => () => {}, abort: () => new Promise(() => {}), dispose() {},
  };
}

test("disabled idle reaping still cleans up a run Stop cannot unwind", async (t) => {
  configure(t, "0");
  const wrapper = new AgentSessionWrapper(makeInner());
  t.after(() => wrapper.destroy());
  wrapper.start();
  t.mock.timers.tick(3600000);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  void wrapper.send({ type: "abort" });
  await nextTurn();
  t.mock.timers.tick(599999);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});

for (const value of ["", "0"]) {
  test(`repeated Stop and status reconciliation cannot postpone cleanup (idle=${JSON.stringify(value)})`, async (t) => {
    configure(t, value);
    const wrapper = new AgentSessionWrapper(makeInner());
    t.after(() => wrapper.destroy());
    wrapper.start();
    void wrapper.send({ type: "abort" });
    await nextTurn();
    t.mock.timers.tick(540000);
    await nextTurn();
    void wrapper.send({ type: "abort" });
    await nextTurn();
    await wrapper.send({ type: "get_state" });
    t.mock.timers.tick(60000);
    await nextTurn();
    assert.equal(wrapper.isAlive(), false);
  });
}

test("when Stop unwinds successfully the disabled idle policy is restored", async (t) => {
  configure(t, "0");
  const inner = makeInner();
  inner.abort = async () => { inner.isStreaming = false; };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();
  await wrapper.send({ type: "abort" });
  t.mock.timers.tick(3600000);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
});

test("a bash command that ignores Stop is also reaped with idle shutdown disabled", async (t) => {
  configure(t, "0");
  const inner = makeInner();
  inner.isStreaming = false;
  inner.isBashRunning = true;
  inner.abortBash = () => {};
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();
  await wrapper.send({ type: "abort_bash" });
  t.mock.timers.tick(600000);
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
});

test("an active surrogate stays alive for hours under the ordinary ten-minute idle policy", async t => {
  configure(t, "");
  const inner = makeInner();
  inner.isStreaming = false;
  inner.sessionManager.getEntries = () => [];
  inner.sessionManager.getLeafId = () => "fixture-leaf";
  inner.messages = [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Verification pending" }] }];
  inner.settingsManager = { getEnabledModels: () => undefined };
  const model = { provider: "fixture", id: "surrogate", contextWindow: 32000, maxTokens: 4096 };
  let signal;
  inner.modelRuntime = {
    getAvailable: async () => [model], getPhysicalModel: () => model,
    completeSimple: async (_model, _context, options) => { signal = options.signal; return new Promise(() => {}); },
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  wrapper.start();
  await wrapper.send({ type: "start_auto_advance", config: { goal: "Verify locally", scope: "Tests only; no commit or release", model: { provider: model.provider, modelId: model.id }, maxRounds: 99 } });
  t.mock.timers.tick(0);
  await nextTurn();
  assert.equal(wrapper.isRunning(), true);
  assert.ok(signal instanceof AbortSignal);
  t.mock.timers.tick(8 * 60 * 60 * 1000);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
  assert.equal(wrapper.isRunning(), true);
  assert.equal(signal.aborted, false);
  await wrapper.send({ type: "stop_auto_advance" });
  assert.equal(signal.aborted, true);
  assert.equal(wrapper.isRunning(), false);
});

test("out-of-range idle settings cannot wrap Node's timer into immediate disposal", (t) => {
  configure(t, "2592000000");
  assert.equal(resolveSessionIdleTimeoutMs(), 600000);
});
