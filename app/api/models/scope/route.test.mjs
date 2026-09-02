import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("model scope edits the global enabledModels setting", () => {
  assert.match(source, /getGlobalSettings\(\)\.enabledModels/);
  assert.match(source, /setEnabledModels\(/);
  assert.doesNotMatch(source, /getEnabledModels\(\)/);
});

test("model scope confirms queued settings writes before returning success", () => {
  const preflightErrorIndex = source.indexOf("drainErrors().length");
  const writeIndex = source.indexOf("setEnabledModels(");
  const flushIndex = source.indexOf("await services.settingsManager.flush()", writeIndex);
  const errorIndex = source.indexOf("drainErrors().length", flushIndex);
  const successIndex = source.indexOf("success: true", errorIndex);
  assert.ok(preflightErrorIndex >= 0 && writeIndex > preflightErrorIndex);
  assert.ok(flushIndex > writeIndex && errorIndex > flushIndex && successIndex > errorIndex);
});

test("model scope does not authorize arbitrary cwd file access", () => {
  assert.doesNotMatch(source, /allowFileRoot|searchParams|getAllowedFileRoots/);
  assert.match(source, /cwd: homedir\(\)/);
});

test("model scope rejects a null or non-object JSON body", () => {
  assert.match(source, /parsed === null \|\| typeof parsed !== "object" \|\| Array\.isArray\(parsed\)/);
});
