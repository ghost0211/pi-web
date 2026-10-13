import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { personalizeOpenRouterCatalog } from "@earendil-works/pi-ai/providers/openrouter";
import { createJiti } from "jiti";

const { resolveVisibleModels } = await createJiti(import.meta.url).import("./model-scope.ts");

test("SDK 1.2 personalized OpenRouter metadata flows through the Web scope and offline catalog", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-sdk-1.2-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const modelsPath = join(root, "models.json");
  const modelsStorePath = join(root, "models-store.json");
  await writeFile(authPath, JSON.stringify({ openrouter: { type: "api_key", key: "fixture-not-real" } }));
  await writeFile(modelsPath, JSON.stringify({ $schema: "https://pi.dev/schemas/models.schema.json", providers: { openrouter: { baseUrl: "https://us.openrouter.ai/api/v1" } } }));
  const create = () => ModelRuntime.create({ authPath, modelsPath, modelsStorePath, catalogBaseUrl: "https://catalog.fixture.invalid", allowModelNetwork: false });
  const runtime = await create();
  const initial = runtime.getModels("openrouter");
  assert.ok(initial.length > 2);
  const chosen = initial.slice(0, 2);
  const calls = [];
  t.mock.method(globalThis, "fetch", async input => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://catalog.fixture.invalid/api/models/providers/openrouter")) return new Response(null, { status: 404 });
    assert.equal(url, "https://us.openrouter.ai/api/v1/models/user", "uses the configured regional endpoint");
    return Response.json({ data: chosen.map((model, index) => ({ id: model.id, context_length: 20000, top_provider: { context_length: 16000 + index, max_completion_tokens: 1024 + index }, pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.00000025", input_cache_write: "0.0000005" } })) });
  });
  await runtime.refresh({ providers: ["openrouter"], allowNetwork: true });
  assert.equal(runtime.getError(), undefined);
  assert.equal(calls.length, 2);
  const scope = await resolveVisibleModels(runtime, chosen.map(model => `openrouter/${model.id}`));
  assert.deepEqual(scope.visible.map(model => model.id).sort(), chosen.map(model => model.id).sort());
  assert.equal(runtime.getModels("openrouter").length, 2, "unavailable chat models are filtered by the SDK");
  for (const [index, original] of chosen.entries()) {
    const model = scope.visible.find(entry => entry.id === original.id);
    assert.equal(model.contextWindow, 16000 + index);
    assert.equal(model.maxTokens, 1024 + index);
    assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 });
  }
  const reopened = await create();
  assert.equal(calls.length, 2, "Web startup keeps its offline-first policy");
  assert.deepEqual(reopened.getModels("openrouter").map(model => [model.id, model.contextWindow, model.maxTokens, model.cost]), runtime.getModels("openrouter").map(model => [model.id, model.contextWindow, model.maxTokens, model.cost]));
});

test("OpenRouter unsupported or rejected personalization endpoints preserve the catalog", async t => {
  const catalog = [{ type: "chat", provider: "openrouter", id: "fixture/chat", contextWindow: 10000, maxTokens: 1000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }];
  let status = 401;
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status }));
  const context = { credential: { type: "api_key", key: "fixture-not-real" }, signal: new AbortController().signal };
  for (status of [401, 403, 404]) assert.equal(await personalizeOpenRouterCatalog(catalog, context), catalog);
  assert.equal(await personalizeOpenRouterCatalog(catalog, { ...context, credential: undefined }), catalog);
});
