import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  parseGeneralSettingsPatch,
  toGeneralSettings,
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

test("Codemode exposes SDK defaults and validates zero and safe integer budgets", () => {
  assert.equal(toGeneralSettings({}).codemodeMode, "on");
  assert.equal(toGeneralSettings({}).codemodeInlineBudget, 3000);
  assert.equal(toGeneralSettings({ codemode: { mode: "only", inlineBudget: 0 } }).codemodeInlineBudget, 0);
  assert.equal(toGeneralSettings({ codemode: { mode: "only" } }).codemodeMode, "only");
  assert.deepEqual(parseGeneralSettingsPatch({ codemodeMode: "only", codemodeInlineBudget: 0 }), { codemodeMode: "only", codemodeInlineBudget: 0 });
  for (const value of ["3000", null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseGeneralSettingsPatch({ codemodeInlineBudget: value }), /non-negative integer/);
  }
  assert.throws(() => parseGeneralSettingsPatch({ codemodeMode: "off" }), /invalid/);
});

test("Codemode edits preserve unrelated settings, unknown nested fields and tool selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-codemode-settings-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const file = join(root, "settings.json");
  await writeFile(file, JSON.stringify({ codemode: { mode: "on", inlineBudget: 3000, future: true }, defaultTools: ["read"], other: "preserved" }));
  await updateGeneralSettings(file, parseGeneralSettingsPatch({ codemodeMode: "only", codemodeInlineBudget: 0 }));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { codemode: { mode: "only", inlineBudget: 0, future: true }, defaultTools: ["read"], other: "preserved" });
  await updateGeneralSettings(file, { quietStartup: true });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).codemode, { mode: "only", inlineBudget: 0, future: true });
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
