import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  computeEnabledModelsForSave,
  resolveEnabledModelIds,
} = await createJiti(import.meta.url).import("./model-scope-setting.ts");

function fakeModel(provider, id) {
  return { provider, id, name: id };
}

const ALL = [
  fakeModel("anthropic", "claude-opus-4-5"),
  fakeModel("anthropic", "claude-sonnet-4-6"),
  fakeModel("openai", "gpt-5"),
];

test("no stored selection resolves to null (all models enabled)", async () => {
  assert.deepEqual(await resolveEnabledModelIds(undefined, ALL), { enabledIds: null, warnings: [] });
  assert.deepEqual(await resolveEnabledModelIds([], ALL), { enabledIds: null, warnings: [] });
});

test("exact ids resolve in configured order and deduplicate", async () => {
  const { enabledIds, warnings } = await resolveEnabledModelIds(
    ["openai/gpt-5", "anthropic/claude-opus-4-5", "openai/gpt-5"],
    ALL,
  );
  assert.deepEqual(enabledIds, ["openai/gpt-5", "anthropic/claude-opus-4-5"]);
  assert.deepEqual(warnings, []);
});

test("glob patterns resolve through pi's matcher", async () => {
  const { enabledIds } = await resolveEnabledModelIds(["anthropic/*"], ALL);
  assert.deepEqual(enabledIds, ["anthropic/claude-opus-4-5", "anthropic/claude-sonnet-4-6"]);
});

test("unmatched patterns surface as warnings without dropping valid entries", async () => {
  const { enabledIds, warnings } = await resolveEnabledModelIds(["openai/gpt-5", "gone/provider-model-*"], ALL);
  assert.deepEqual(enabledIds, ["openai/gpt-5", "gone/provider-model-*"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /gone\/provider-model-\*/);
});

test("saving a full selection clears the setting (undefined = unrestricted)", () => {
  const allIds = ALL.map((m) => `${m.provider}/${m.id}`);
  assert.equal(computeEnabledModelsForSave([...allIds].reverse(), allIds), undefined);
});

test("saving a partial selection follows model catalog order", () => {
  const allIds = ALL.map((m) => `${m.provider}/${m.id}`);
  assert.deepEqual(
    computeEnabledModelsForSave(["openai/gpt-5", "anthropic/claude-opus-4-5"], allIds),
    ["anthropic/claude-opus-4-5", "openai/gpt-5"],
  );
});

test("saving preserves unavailable patterns after selected models", () => {
  const allIds = ALL.map((m) => `${m.provider}/${m.id}`);
  assert.deepEqual(
    computeEnabledModelsForSave(["future/provider-*", "openai/gpt-5"], allIds),
    ["openai/gpt-5", "future/provider-*"],
  );
});

test("saving an empty selection normalizes to unrestricted", () => {
  // The runtime falls back to all models when the stored selection resolves to
  // nothing, so storing [] would silently behave like "all on". Normalize to
  // undefined instead of persisting a misleading empty array.
  const allIds = ALL.map((m) => `${m.provider}/${m.id}`);
  assert.equal(computeEnabledModelsForSave([], allIds), undefined);
});
