import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseFallbackModel, parseModelFallbackNotice, sameFallbackModel } = await jiti.import("./model-fallback.ts");
const { appendSessionModelFallback, appendSessionModelFallbackNotice, readSessionModelFallback, readSessionModelFallbackNotice, validateFallbackModel, MODEL_FALLBACK_SELECTION_TYPE } = await jiti.import("./session-model-fallback.ts");
const backup = { provider: "test-provider", modelId: "test/model:latest" };

test("fallback model references are bounded references, never credentials or malformed objects", () => {
  assert.deepEqual(parseFallbackModel(backup), backup);
  assert.equal(parseFallbackModel(null), null);
  for (const value of [undefined, [], "x", {}, { ...backup, apiKey: "fixture-not-a-key" }, { ...backup, provider: "https://host" }, { ...backup, modelId: "bad\nmodel" }, { ...backup, provider: "p".repeat(129) }, { ...backup, modelId: "m".repeat(513) }]) {
    assert.equal(parseFallbackModel(value), undefined);
    assert.throws(() => validateFallbackModel(value), /fallbackModel/);
  }
  assert.equal(sameFallbackModel(backup, { ...backup }), true);
  assert.equal(sameFallbackModel(backup, null), false);
});

test("backup thinking is strictly validated, persisted independently, and absent in legacy references", () => {
  const manager = SessionManager.inMemory(tmpdir());
  for (const thinkingLevel of ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const selection = { ...backup, thinkingLevel };
    assert.deepEqual(validateFallbackModel(selection), selection);
    appendSessionModelFallback(manager, selection);
    assert.deepEqual(readSessionModelFallback(manager.getEntries()), selection);
    assert.equal(sameFallbackModel(selection, backup), true, "thinking never changes model identity");
  }
  for (const thinkingLevel of ["invalid", null, {}, true, 2]) {
    assert.equal(parseFallbackModel({ ...backup, thinkingLevel }), undefined);
    assert.throws(() => validateFallbackModel({ ...backup, thinkingLevel }), /fallbackModel/);
  }
  appendSessionModelFallback(manager, backup);
  assert.deepEqual(readSessionModelFallback(manager.getEntries()), backup);
  assert.equal(manager.getEntries().some((entry) => entry.type === "thinking_level_change"), false);
  appendSessionModelFallback(manager, null);
  assert.equal(readSessionModelFallback(manager.getEntries()), null);
});

test("legacy sessions stay off, explicit clears survive restoration, malformed newest entry fails closed", () => {
  const manager = SessionManager.inMemory(tmpdir());
  assert.equal(readSessionModelFallback(manager.getEntries()), undefined);
  appendSessionModelFallback(manager, backup);
  assert.deepEqual(readSessionModelFallback(manager.getEntries()), backup);
  appendSessionModelFallback(manager, null);
  assert.equal(readSessionModelFallback(manager.getEntries()), null);
  appendSessionModelFallback(manager, backup);
  manager.appendCustomEntry(MODEL_FALLBACK_SELECTION_TYPE, { version: 2, model: backup });
  assert.equal(readSessionModelFallback(manager.getEntries()), null, "must not revive an older enabled configuration");
  assert.equal(manager.buildSessionContext().messages.length, 0, "configuration never participates in model context");
});

test("fallback audit metadata is validated and has no prompt or raw upstream error body", () => {
  const manager = SessionManager.inMemory(tmpdir());
  const notice = { from: { provider: "primary", modelId: "main" }, to: backup, ruleId: "openai.insufficient-quota", kind: "credit-balance", timestamp: 123456 };
  assert.equal(readSessionModelFallbackNotice(manager.getEntries()), null);
  appendSessionModelFallbackNotice(manager, notice);
  assert.deepEqual(readSessionModelFallbackNotice(manager.getEntries()), notice);
  assert.deepEqual(parseModelFallbackNotice({ ...notice, rawBody: "ignored" }), notice);
  for (const invalid of [{ ...notice, timestamp: NaN }, { ...notice, ruleId: "not\nvalid" }, { ...notice, kind: "network" }, { ...notice, to: null }]) assert.equal(parseModelFallbackNotice(invalid), null);
  assert.equal(manager.buildSessionContext().messages.length, 0);
});

test("fallback notices are read from the active branch, not unrelated branches", () => {
  const manager = SessionManager.inMemory(tmpdir());
  manager.appendMessage({ role: "user", content: "branch root", timestamp: Date.now() });
  const rootId = manager.getLeafId();
  manager.appendMessage({ role: "user", content: "other branch", timestamp: Date.now() });
  appendSessionModelFallbackNotice(manager, {
    from: { provider: "primary", modelId: "main" },
    to: backup,
    ruleId: "portable.usage_limit_reached",
    kind: "subscription-limit",
    timestamp: 123457,
  });
  assert.equal(readSessionModelFallbackNotice(manager.getBranch())?.to.modelId, backup.modelId);

  manager.branch(rootId);
  assert.equal(readSessionModelFallbackNotice(manager.getBranch()), null);
  assert.equal(readSessionModelFallbackNotice(manager.getEntries())?.to.modelId, backup.modelId);
});
