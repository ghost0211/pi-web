import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
import { componentHarness, tick } from "./mcp-test-harness.mjs";
const { CodemodeSettings, parseCodemodeBudget } = await createJiti(import.meta.url, { tsconfigPaths: true, jsx: true }).import("./CodemodeSettings.tsx");

test("Codemode description budget accepts zero but not empty, negative, fractional or unsafe input", () => {
  assert.equal(parseCodemodeBudget("0"), 0);
  assert.equal(parseCodemodeBudget("3000"), 3000);
  for (const value of ["", " ", "-1", "1.5", "NaN", "Infinity", String(Number.MAX_SAFE_INTEGER + 1)]) assert.equal(parseCodemodeBudget(value), undefined, value);
});
test("Codemode UI keeps the explicit no-start reload boundary and tool selections unchanged", async () => {
  const source = await readFile(new URL("./CodemodeSettings.tsx", import.meta.url), "utf8");
  assert.match(source, /codemodeMode: mode, codemodeInlineBudget: parsed/);
  assert.match(source, /requireLiveSession: true/);
  // Mode select and budget input must look like editable controls, not plain text.
  assert.match(source, /<select className="config-input"/);
  assert.match(source, /<input className="config-input"/);
  assert.match(source, /if \(controller.signal.aborted\) return;\s*setNeedsReload\(false\);\s*onSessionReloaded\(\)/);
  assert.doesNotMatch(source, /defaultTools|set_tools|\/api\/agent\/new/);
});
test("Codemode interaction rejects empty budgets, saves zero and never reloads automatically", async (t) => {
  const before = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return Response.json(options.method === "PUT" ? { success: true, settings: { codemodeMode: "on", codemodeInlineBudget: 0 } } : { codemodeMode: "on", codemodeInlineBudget: 3000 });
  };
  const harness = componentHarness(CodemodeSettings, { sessionId: "sid", onSessionReloaded() {} });
  t.after(() => { harness.cleanup(); globalThis.fetch = before; });
  harness.render(); await tick(); harness.render();
  harness.input("settings.codemode.budget").props.onChange({ target: { value: "" } });
  harness.render(); harness.button("settings.codemode.save").props.onClick(); await tick(); harness.render();
  assert.match(harness.text(), /settings.codemode.budgetError/);
  assert.equal(calls.some((call) => call.options.method === "PUT"), false);
  harness.input("settings.codemode.budget").props.onChange({ target: { value: "0" } });
  harness.render(); harness.button("settings.codemode.save").props.onClick(); await tick(); harness.render();
  assert.deepEqual(JSON.parse(calls.find((call) => call.options.method === "PUT").options.body), { codemodeMode: "on", codemodeInlineBudget: 0 });
  assert.equal(calls.some((call) => call.url.startsWith("/api/agent")), false);
});
test("Codemode reload refuses an absent runtime instead of starting a session", async (t) => {
  const before = globalThis.fetch; const calls = []; let reloaded = false;
  globalThis.fetch = async (url, options = {}) => {
    calls.push(url);
    return Response.json(url.startsWith("/api/mcp/runtime") ? { live: false, available: false } : options.method === "PUT" ? { success: true, settings: { codemodeMode: "on", codemodeInlineBudget: 3000 } } : { codemodeMode: "on", codemodeInlineBudget: 3000 });
  };
  const harness = componentHarness(CodemodeSettings, { sessionId: "idle", onSessionReloaded() { reloaded = true; } });
  t.after(() => { harness.cleanup(); globalThis.fetch = before; });
  harness.render(); await tick(); harness.render(); harness.button("settings.codemode.save").props.onClick();
  await tick(); harness.render(); harness.button("settings.codemode.reload").props.onClick(); await tick(); harness.render();
  assert.equal(calls.some((url) => url.startsWith("/api/agent")), false);
  assert.equal(reloaded, false); assert.match(harness.text(), /settings.codemode.reloadError/);
});
