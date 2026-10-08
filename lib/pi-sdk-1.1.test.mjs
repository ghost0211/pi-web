import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { calculateCost, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { readModelsConfig, writeModelsConfig } = await createJiti(import.meta.url)
  .import("./models-config-store.ts");

async function createOfflineRuntime(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-sdk-1.1-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const authPath = join(root, "auth.json");
  const runtime = await ModelRuntime.create({
    authPath,
    // Keep the host's models.json out of this catalog-only test. The explicit store path is also
    // isolated, even though modelsPath:null makes this runtime use its in-memory model store.
    modelsPath: null,
    modelsStorePath: join(root, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return { root, runtime };
}

test("SDK catalog exposes Haiku 5.5 chat with xhigh and max thinking levels", async (t) => {
  const { runtime } = await createOfflineRuntime(t);
  const model = runtime.getModels("anthropic").find((entry) => entry.id === "claude-haiku-5-5");

  assert.ok(model, "Claude Haiku 5.5 should be present in the bundled chat catalog");
  assert.equal(model.type, "chat");
  assert.equal(model.name, "Claude Haiku 5.5");
  assert.equal(model.api, "anthropic-messages");

  const supportedLevels = getSupportedThinkingLevels(model);
  assert.ok(supportedLevels.includes("xhigh"), `expected xhigh in ${supportedLevels}`);
  assert.ok(supportedLevels.includes("max"), `expected max in ${supportedLevels}`);
});

test("GPT-6 Luna has separate chat and image-capable classifier catalog entries", async (t) => {
  const { runtime } = await createOfflineRuntime(t);
  const chat = runtime.getModels("openai").find((entry) => entry.id === "gpt-6-luna");
  const classifiers = runtime.getModelsOfType("classifier", "openai");
  const classifier = runtime.getModelOfType("classifier", "openai", "gpt-6-luna");

  // The same provider/id is intentionally in both operations; chat catalog lookup must not hide
  // the classifier entry or mistake it for the chat model.
  assert.ok(chat, "GPT-6 Luna should be present in the chat catalog");
  assert.ok(classifier, "GPT-6 Luna should be present in the classifier catalog");
  assert.ok(classifiers.some((entry) => entry.id === "gpt-6-luna"));
  assert.equal(chat.type, "chat");
  assert.equal(chat.api, "openai-responses");
  assert.equal(classifier.type, "classifier");
  assert.equal(classifier.api, "openai-decisions");
  assert.ok(classifier.input.includes("text"));
  assert.ok(classifier.input.includes("image"));
});

function usageFor({ input, output, cacheRead, cacheWrite }) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + cacheRead + cacheWrite + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function asMicroUsd(cost) {
  // Rates are USD per million tokens, so comparing rounded micro-USD avoids brittle float checks.
  return Object.fromEntries(
    ["input", "output", "cacheRead", "cacheWrite", "total"]
      .map((key) => [key, Math.round(cost[key] * 1_000_000)]),
  );
}

test("SDK calculateCost uses strict prompt-token tiers and counts cached input", () => {
  const model = {
    cost: {
      input: 2,
      output: 3,
      cacheRead: 1,
      cacheWrite: 4,
      tiers: [
        { inputTokensAbove: 10, input: 5, output: 7, cacheRead: 2, cacheWrite: 8 },
        { inputTokensAbove: 20, input: 11, output: 13, cacheRead: 17, cacheWrite: 19 },
      ],
    },
  };
  const cases = [
    // input + cached input is exactly 10: the `above 10` tier does not apply.
    { usage: { input: 3, cacheRead: 4, cacheWrite: 3, output: 2 }, expected: { input: 6, output: 6, cacheRead: 4, cacheWrite: 12, total: 28 } },
    // Cached input participates in the prompt-length threshold: 3 + 4 + 4 = 11.
    { usage: { input: 3, cacheRead: 4, cacheWrite: 4, output: 2 }, expected: { input: 15, output: 14, cacheRead: 8, cacheWrite: 32, total: 69 } },
    // Exactly 20 still selects the first tier; tier thresholds are strict.
    { usage: { input: 5, cacheRead: 5, cacheWrite: 10, output: 2 }, expected: { input: 25, output: 14, cacheRead: 10, cacheWrite: 80, total: 129 } },
    // 21 prompt tokens select the highest matching tier.
    { usage: { input: 3, cacheRead: 4, cacheWrite: 14, output: 2 }, expected: { input: 33, output: 26, cacheRead: 68, cacheWrite: 266, total: 393 } },
  ];

  for (const { usage: counts, expected } of cases) {
    const actual = calculateCost(model, usageFor(counts));
    assert.deepEqual(asMicroUsd(actual), expected);
  }
});

test("models.json cost normalization round-trips full base rates, tiers, and zero values", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-sdk-cost-tiers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelsPath = join(root, "agent", "models.json");
  const cost = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tiers: [
      { inputTokensAbove: 0, input: 0, output: 1.25, cacheRead: 0, cacheWrite: 2 },
      { inputTokensAbove: 500_000, input: 3, output: 0, cacheRead: 4, cacheWrite: 0 },
    ],
  };
  const config = {
    providers: {
      "offline-fixture": {
        baseUrl: "https://offline-fixture.invalid/v1",
        api: "openai-completions",
        models: [{ id: "tiered-model", cost }],
      },
    },
  };

  writeModelsConfig(config, modelsPath);
  const roundTripped = readModelsConfig(modelsPath);
  assert.deepEqual(roundTripped, config);
  assert.deepEqual(roundTripped.providers["offline-fixture"].models[0].cost, cost);
});
