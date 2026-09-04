import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  parseGeneralSettingsPatch,
  readGeneralSettings,
  updateGeneralSettings,
} = await createJiti(import.meta.url).import("./general-settings.ts");

test("general settings use canonical nested SDK fields and preserve unrelated values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-general-settings-"));
  const settingsPath = join(root, "settings.json");
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await writeFile(settingsPath, JSON.stringify({
    compactionEnabled: true,
    compaction: { reserveTokens: 123 },
    retry: { maxRetries: 4 },
    defaultThinkingLevel: "high",
    unrelated: { keep: true },
  }));

  const result = await updateGeneralSettings(settingsPath, {
    compactionEnabled: false,
    retryEnabled: false,
    defaultThinkingLevel: "auto",
    defaultProjectTrust: "auto",
  });
  assert.equal(result.compactionEnabled, false);
  assert.equal(result.retryEnabled, false);
  assert.equal(result.defaultThinkingLevel, "auto");
  assert.equal(result.defaultProjectTrust, "auto");

  const stored = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(stored.compaction, { reserveTokens: 123, enabled: false });
  assert.deepEqual(stored.retry, { maxRetries: 4, enabled: false });
  assert.equal(stored.defaultProjectTrust, "always");
  assert.equal(stored.defaultThinkingLevel, undefined);
  assert.equal(stored.compactionEnabled, undefined);
  assert.deepEqual(stored.unrelated, { keep: true });
});

test("general settings reject invalid mutations", () => {
  assert.throws(() => parseGeneralSettingsPatch(null), /Expected a JSON object/);
  assert.throws(() => parseGeneralSettingsPatch({ retryEnabled: "yes" }), /must be a boolean/);
  assert.throws(() => parseGeneralSettingsPatch({ defaultThinkingLevel: "extreme" }), /is invalid/);
  assert.throws(() => parseGeneralSettingsPatch({ defaultProjectTrust: "sometimes" }), /is invalid/);
});

test("malformed settings fail closed and are never overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-general-settings-invalid-"));
  const settingsPath = join(root, "settings.json");
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await writeFile(settingsPath, "{");

  await assert.rejects(readGeneralSettings(settingsPath));
  await assert.rejects(updateGeneralSettings(settingsPath, { retryEnabled: false }));
  assert.equal(await readFile(settingsPath, "utf8"), "{");
});
