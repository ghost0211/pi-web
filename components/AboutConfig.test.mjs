// The About panel must label the registry comparison target as "current
// version". Showing the latest registry version next to an "update available"
// pill for that same version reads as a contradiction.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./AboutConfig.tsx", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

function rowFor(labelKey) {
  const start = source.indexOf(`t("${labelKey}")`);
  assert.notEqual(start, -1, `missing row labeled ${labelKey}`);
  // The row ends where the next labeled property row begins.
  const next = source.indexOf("about-property-label", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("labels the comparison target as the current version", () => {
  const row = rowFor("about.currentVersion");
  assert.match(row, /info\?\.piAgent\.currentVersion \? `v\$\{info\.piAgent\.currentVersion\}`/);
  // The status pill lives in the current-version row, not the latest-version one.
  assert.match(row, /about-status-pill/);
  assert.match(row, /about\.statusUpdateAvailable/);
  assert.match(row, /about\.statusUpToDate/);
});

test("keeps the latest registry version as a separate, pill-free row", () => {
  const row = rowFor("about.latestVersion");
  assert.match(row, /info\?\.piAgent\.latestVersion \? `v\$\{info\.piAgent\.latestVersion\}`/);
  assert.doesNotMatch(row, /about-status-pill/);
});

test("reports the source of the current version without new translation keys", () => {
  const row = rowFor("about.currentVersion");
  assert.match(row, /currentVersionSource === "cli"[\s\S]{0,80}t\("about\.globalCli"\)/);
  assert.match(row, /currentVersionSource === "sdk"[\s\S]{0,80}t\("about\.embeddedKernel"\)/);
});

test("shows the check-failed state instead of a stale pill", () => {
  const row = rowFor("about.currentVersion");
  assert.match(row, /!info\?\.piAgent\.latestVersion && info\?\.piAgent\.error/);
  assert.match(row, /about\.statusCheckFailed/);
});

test("copies the current version and its source into diagnostics", () => {
  assert.match(source, /`- \*\*Pi Agent Current Version:\*\* \$\{info\.piAgent\.currentVersion \?\? "unknown"\}/);
  assert.match(source, /`- \*\*Pi Agent Latest Registry:\*\* \$\{info\.piAgent\.latestVersion \?\? "unknown"\}`/);
});
