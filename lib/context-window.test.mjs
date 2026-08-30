import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  calculateContextUsageDisplay,
  resolveModelContextWindow,
} = await jiti.import("./context-window.ts");

const sol = { provider: "openai-codex", modelId: "gpt-5.6-sol" };
const models = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai-codex",
    contextWindow: 272_000,
  },
];

test("model catalog context window overrides a stale 128k usage fallback", () => {
  assert.equal(resolveModelContextWindow(sol, models, 128_000), 272_000);
});

test("model resolution respects provider when model ids overlap", () => {
  const duplicateModels = [
    ...models,
    {
      id: "gpt-5.6-sol",
      name: "Gateway GPT-5.6 Sol",
      provider: "gateway",
      contextWindow: 512_000,
    },
  ];

  assert.equal(
    resolveModelContextWindow({ provider: "gateway", modelId: "gpt-5.6-sol" }, duplicateModels, 128_000),
    512_000,
  );
});

test("known live context window is preserved while the model catalog is loading", () => {
  assert.equal(resolveModelContextWindow(sol, [], 272_000), 272_000);
});

test("display percentage is recomputed against the resolved model window", () => {
  const display = calculateContextUsageDisplay({
    contextWindow: resolveModelContextWindow(sol, models, 128_000),
    contextUsage: { tokens: 221_000, contextWindow: 128_000, percent: 100 },
  });

  assert.deepEqual(display, {
    tokens: 221_000,
    contextWindow: 272_000,
    percent: 81,
  });
});
