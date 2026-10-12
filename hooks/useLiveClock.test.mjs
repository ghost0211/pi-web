import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createJiti } from "jiti";
import { componentHarness } from "../components/mcp-test-harness.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useLiveClock } = await jiti.import("./useLiveClock.ts");
const Component = ({ enabled, now }) => React.createElement("span", null, useLiveClock(enabled, now));

test("one live interval updates each second, catches up on visibility, and cleans up", () => {
  const oldInterval = globalThis.setInterval, oldClear = globalThis.clearInterval, oldDocument = globalThis.document, oldNow = Date.now;
  const listeners = new Map();
  let clock = 1000, intervals = 0, clears = 0, tick;
  Date.now = () => clock;
  globalThis.document = { visibilityState: "visible", addEventListener: (name, cb) => listeners.set(name, cb), removeEventListener: name => listeners.delete(name) };
  globalThis.setInterval = (cb, delay) => { assert.equal(delay, 1000); intervals++; tick = cb; return 1; };
  globalThis.clearInterval = () => { clears++; };
  const h = componentHarness(Component, { enabled: true });
  try {
    h.render();
    assert.equal(h.text(), "1000");
    clock = 2000; tick(); h.render();
    assert.equal(h.text(), "2000");
    clock = 60_000; listeners.get("visibilitychange")(); h.render();
    assert.equal(h.text(), "60000");
    assert.equal(intervals, 1, "rendering/ticks never spawn additional intervals");
    h.render({ enabled: false });
    assert.equal(clears, 1);
    assert.equal(listeners.size, 0);
    h.render({ enabled: true, now: 123 });
    assert.equal(h.text(), "123");
    assert.equal(intervals, 1, "injected clocks never allocate a timer");
  } finally {
    h.cleanup(); globalThis.setInterval = oldInterval; globalThis.clearInterval = oldClear;
    Date.now = oldNow;
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  }
});
