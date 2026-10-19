import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { resolveVisibleModels } = await createJiti(import.meta.url).import("./model-scope.ts");

/**
 * SDK 1.3.0 (#10160): scope patterns that match the same model id under
 * several providers now resolve to ALL of them and add an "ambiguous"
 * diagnostic, instead of silently picking one by catalog order. Pi Web keeps
 * its stricter guard for exact patterns (it throws) and must surface the new
 * warning verbatim for glob patterns, without dropping duplicate ids from the
 * selector list.
 */
async function createRuntime(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-sdk-1.3-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authPath = join(root, "auth.json");
  const modelsPath = join(root, "models.json");
  const modelsStorePath = join(root, "models-store.json");
  const model = (id) => ({
    id,
    name: id,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10000,
    maxTokens: 1000,
  });
  await writeFile(authPath, JSON.stringify({
    "prov-a": { type: "api_key", key: "fixture-a" },
    "prov-b": { type: "api_key", key: "fixture-b" },
  }));
  await writeFile(modelsPath, JSON.stringify({
    providers: {
      "prov-a": { baseUrl: "https://a.fixture.invalid/v1", models: [model("shared-model")] },
      "prov-b": { baseUrl: "https://b.fixture.invalid/v1", models: [model("shared-model")] },
    },
  }));
  return ModelRuntime.create({ authPath, modelsPath, modelsStorePath, catalogBaseUrl: "https://catalog.fixture.invalid", allowModelNetwork: false });
}

test("SDK 1.3 glob scope keeps duplicate ids from several providers without a warning", async t => {
  const runtime = await createRuntime(t);
  const available = await runtime.getAvailable();
  assert.deepEqual(available.map(m => `${m.provider}/${m.id}`).sort(), ["prov-a/shared-model", "prov-b/shared-model"]);

  // Globs are explicit multi-match patterns: every provider's copy is listed
  // and no ambiguity warning is raised.
  const scope = await resolveVisibleModels(runtime, ["*/shared-model"]);
  assert.deepEqual(scope.visible.map(m => `${m.provider}/${m.id}`).sort(), ["prov-a/shared-model", "prov-b/shared-model"]);
  assert.deepEqual(scope.warnings, []);
});

test("SDK 1.3 fuzzy scope keeps duplicate ids and surfaces the ambiguity warning", async t => {
  const runtime = await createRuntime(t);
  const scope = await resolveVisibleModels(runtime, ["shared"]).catch(() => null);
  // "shared" fuzzy-matches the same id under both providers; SDK 1.3 adds all
  // of them and warns instead of picking one by catalog order (#10160).
  assert.ok(scope);
  assert.deepEqual(scope.visible.map(m => `${m.provider}/${m.id}`).sort(), ["prov-a/shared-model", "prov-b/shared-model"]);
  assert.ok(
    scope.warnings.some(w => w.includes("matches several providers") && w.includes("prov-a") && w.includes("prov-b")),
    `expected the SDK ambiguous warning, got: ${JSON.stringify(scope.warnings)}`,
  );
});

test("Pi Web still rejects ambiguous exact scope patterns with its own error", async t => {
  const runtime = await createRuntime(t);
  await assert.rejects(
    () => resolveVisibleModels(runtime, ["shared-model"]),
    /Ambiguous enabledModels entry "shared-model" matches multiple models: prov-a\/shared-model, prov-b\/shared-model/,
  );
});
