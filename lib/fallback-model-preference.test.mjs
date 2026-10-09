import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { getFallbackModelPreference, setFallbackModelPreference } = await jiti.import("./fallback-model-preference.ts");
const key = "pi-fallback-model-preference";

test("fresh-composer backup preferences round-trip their own level and read legacy model-only values", (t) => {
  const stored = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (name) => stored.get(name) ?? null,
    setItem: (name, value) => stored.set(name, value),
    removeItem: (name) => stored.delete(name),
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else delete globalThis.window; });
  const model = { provider: "backup", modelId: "reasoner" };
  stored.set(key, JSON.stringify(model));
  assert.deepEqual(getFallbackModelPreference(), model);
  setFallbackModelPreference({ ...model, thinkingLevel: "low" });
  assert.deepEqual(getFallbackModelPreference(), { ...model, thinkingLevel: "low" });
  setFallbackModelPreference({ ...model, thinkingLevel: "bad" });
  assert.equal(getFallbackModelPreference().thinkingLevel, "low", "invalid writes do not replace valid preferences");
  setFallbackModelPreference(null);
  assert.equal(getFallbackModelPreference(), null);
  assert.equal(stored.has(key), false);
});
