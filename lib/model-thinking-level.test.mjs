import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { normalizeThinkingLevelOption } = await jiti.import("./thinking-level-options.ts");
const { resolveModelThinkingLevel } = await jiti.import("./model-thinking-level.ts");
const model = { provider: "fixture", id: "reasoner", api: "openai-completions", reasoning: true };
const restricted = { ...model, thinkingLevelMap: { off: null, minimal: null, low: "lite", medium: null, high: "strong", xhigh: null, max: null } };

test("incompatible UI preferences reset to auto instead of borrowing another model's level", () => {
  assert.equal(normalizeThinkingLevelOption("xhigh", ["low", "high"]), "auto");
  assert.equal(normalizeThinkingLevelOption("low", ["low", "high"]), "low");
  assert.equal(normalizeThinkingLevelOption("auto", ["off"]), "auto");
  assert.equal(normalizeThinkingLevelOption(undefined, ["low"]), "auto");
  assert.equal(normalizeThinkingLevelOption("bad", null), "auto");
});

test("backup explicit thinking uses its own supported level and auto resolves a model default", () => {
  assert.equal(resolveModelThinkingLevel(restricted, "low"), "low");
  assert.equal(resolveModelThinkingLevel(restricted, "auto", "low"), "low");
  assert.equal(resolveModelThinkingLevel(restricted, "auto"), "high", "SDK clamps medium to this model's supported map");
  assert.equal(resolveModelThinkingLevel(model, "auto"), "medium");
  assert.equal(resolveModelThinkingLevel(model, "high", "low"), "high", "explicit backup pick wins over model pin/default");
});

test("unsupported legacy thinking and non-reasoning backups always resolve a valid SDK level", () => {
  assert.equal(resolveModelThinkingLevel(restricted, "max", "low"), "low");
  assert.equal(resolveModelThinkingLevel({ ...model, reasoning: false }, "high"), "off");
  assert.equal(resolveModelThinkingLevel({ ...model, thinkingLevelMap: { xhigh: "max" } }, "xhigh"), "xhigh");
});
