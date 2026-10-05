import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  readModelsConfig,
  writeModelsConfig,
} = await jiti.import("./models-config-store.ts");

function createIsolatedTestEnv(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-sampling-test-"));
  const homeDir = join(root, "home");
  const agentDir = join(root, "agent");
  const modelsPath = join(agentDir, "models.json");
  const authPath = join(agentDir, "auth.json");

  const prevHome = process.env.HOME;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = homeDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  t.after(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;

    if (prevAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    else delete process.env.PI_CODING_AGENT_DIR;

    rmSync(root, { recursive: true, force: true });
  });

  return { root, modelsPath, authPath };
}

test("Web writeModelsConfig -> readModelsConfig -> SDK ModelRuntime preserves and natively merges sampling parameters", async (t) => {
  const { modelsPath, authPath } = createIsolatedTestEnv(t);

  const initialConfig = {
    providers: {
      "synthetic-openai": {
        baseUrl: "https://synthetic-api.example.test/v1",
        api: "openai-completions",
        apiKey: "synthetic-model-api-key",
        models: [
          {
            id: "synthetic-sampling-model",
            name: "Synthetic Sampling Model",
            reasoning: true,
            cost: { input: 1.75 }, // Partial cost to be normalized
            samplingParams: {
              temperature: 0.5,
              top_p: 0.95,
            },
            samplingParamsByThinkingLevel: {
              off: {
                temperature: 0.7,
                top_p: 0.8,
              },
              high: {
                temperature: 1.0,
                top_k: 20,
              },
            },
          },
        ],
        modelOverrides: {
          "synthetic-sampling-model": {
            samplingParams: {
              top_p: 0.99,
            },
            samplingParamsByThinkingLevel: {
              high: {
                top_k: 50,
                presence_penalty: 0.5,
              },
            },
          },
        },
      },
    },
  };

  // 1. Web UI save: writeModelsConfig -> readModelsConfig
  writeModelsConfig(initialConfig, modelsPath);
  const readBack = readModelsConfig(modelsPath);

  // Verify non-related cost normalization preserves samplingParams and samplingParamsByThinkingLevel
  const savedModel = readBack.providers["synthetic-openai"].models[0];
  assert.deepEqual(savedModel.cost, {
    input: 1.75,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.deepEqual(savedModel.samplingParams, {
    temperature: 0.5,
    top_p: 0.95,
  });
  assert.deepEqual(savedModel.samplingParamsByThinkingLevel, {
    off: { temperature: 0.7, top_p: 0.8 },
    high: { temperature: 1.0, top_k: 20 },
  });

  const savedOverride = readBack.providers["synthetic-openai"].modelOverrides["synthetic-sampling-model"];
  assert.deepEqual(savedOverride.samplingParams, {
    top_p: 0.99,
  });
  assert.deepEqual(savedOverride.samplingParamsByThinkingLevel, {
    high: { top_k: 50, presence_penalty: 0.5 },
  });

  // 2. Load via actual SDK ModelRuntime.create
  const modelRuntime = await ModelRuntime.create({
    authPath,
    modelsPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  // 3. Verify no credential entry was written into auth.json
  if (existsSync(authPath)) {
    const authData = JSON.parse(readFileSync(authPath, "utf8"));
    assert.deepEqual(authData, {}, "auth.json should have no entries written");
  }

  // 4. Verify SDK native merge of model and modelOverrides
  const loadedModel = modelRuntime.getModel("synthetic-openai", "synthetic-sampling-model");
  assert.ok(loadedModel, "Model should be loaded by SDK runtime");

  // samplingParams base + override merged (top_p overridden to 0.99)
  assert.deepEqual(loadedModel.samplingParams, {
    temperature: 0.5,
    top_p: 0.99,
  });

  // samplingParamsByThinkingLevel:
  // "off" is preserved from base
  // "high" is natively merged per key (temperature: 1.0, top_k: 50, presence_penalty: 0.5)
  assert.deepEqual(loadedModel.samplingParamsByThinkingLevel?.off, {
    temperature: 0.7,
    top_p: 0.8,
  });
  assert.deepEqual(loadedModel.samplingParamsByThinkingLevel?.high, {
    temperature: 1.0,
    top_k: 50,
    presence_penalty: 0.5,
  });

  // Cost normalization did not harm model metadata
  assert.deepEqual(loadedModel.cost, {
    input: 1.75,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });

  // 5. Mock openai-completions request via fetch mock / onPayload
  const chunks = [
    { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "fixture" }, finish_reason: null }] },
    { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  const mockFetch = async () => new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

  // 5a. Test effective thinking level "off": chooses samplingParamsByThinkingLevel.off
  let capturedPayloadOff = null;
  const streamOff = modelRuntime.streamSimple(
    loadedModel,
    { messages: [{ role: "user", content: "test prompt" }] },
    {
      fetch: mockFetch,
      reasoning: "off",
      onPayload: (payload) => {
        capturedPayloadOff = payload;
      },
    },
  );
  assert.equal((await streamOff.result()).stopReason, "stop");
  assert.ok(capturedPayloadOff, "onPayload should be called for reasoning=off");
  assert.equal(capturedPayloadOff.temperature, 0.7);
  assert.equal(capturedPayloadOff.top_p, 0.8);
  assert.equal(capturedPayloadOff.top_k, undefined);
  assert.equal(capturedPayloadOff.presence_penalty, undefined);

  // 5b. Test effective thinking level "high": chooses merged samplingParamsByThinkingLevel.high
  let capturedPayloadHigh = null;
  const streamHigh = modelRuntime.streamSimple(
    loadedModel,
    { messages: [{ role: "user", content: "test prompt" }] },
    {
      fetch: mockFetch,
      reasoning: "high",
      onPayload: (payload) => {
        capturedPayloadHigh = payload;
      },
    },
  );
  assert.equal((await streamHigh.result()).stopReason, "stop");
  assert.ok(capturedPayloadHigh, "onPayload should be called for reasoning=high");
  assert.equal(capturedPayloadHigh.temperature, 1.0);
  assert.equal(capturedPayloadHigh.top_p, 0.99); // inherited from model samplingParams default
  assert.equal(capturedPayloadHigh.top_k, 50);
  assert.equal(capturedPayloadHigh.presence_penalty, 0.5);

  // 5c. Test request-level samplingParams priority over model defaults and level overrides
  let capturedPayloadRequestPriority = null;
  const streamRequestPriority = modelRuntime.streamSimple(
    loadedModel,
    { messages: [{ role: "user", content: "test prompt" }] },
    {
      fetch: mockFetch,
      reasoning: "high",
      samplingParams: {
        temperature: 0.15,
        top_k: 99,
      },
      onPayload: (payload) => {
        capturedPayloadRequestPriority = payload;
      },
    },
  );
  assert.equal((await streamRequestPriority.result()).stopReason, "stop");
  assert.ok(capturedPayloadRequestPriority, "onPayload should be called for request-level priority");
  // Request-level values win:
  assert.equal(capturedPayloadRequestPriority.temperature, 0.15);
  assert.equal(capturedPayloadRequestPriority.top_k, 99);
  // Unset request-level fields fall back to level override and model defaults:
  assert.equal(capturedPayloadRequestPriority.presence_penalty, 0.5);
  assert.equal(capturedPayloadRequestPriority.top_p, 0.99);
});
