// The Usage panel must accept an optional project scope, read the aggregation
// from /api/usage, render the historical cost/token totals, and never surface a
// raw path. These are source-level assertions, matching the other panel tests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./UsagePanel.tsx", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

test("accepts optional project cwd/key scope props", () => {
  assert.match(source, /export interface UsagePanelProps \{/);
  assert.match(source, /cwd\?: string;/);
  assert.match(source, /projectKey\?: string;/);
  // Scope is used for the request only.
  assert.match(source, /query\.set\("projectKey", projectKey\)/);
  assert.match(source, /query\.set\("cwd", cwd\)/);
});

test("fetches the usage aggregation from the API", () => {
  assert.match(source, /fetch\(`\/api\/usage\$\{suffix \? `\?\$\{suffix\}` : ""\}`/);
  assert.match(source, /import \{[^}]*type UsageResponse[^}]*\} from "@\/lib\/session-usage"/s);
  assert.match(source, /setReloadKey\(\(value\) => value \+ 1\)/);
});

test("renders totals, projects and models from recorded usage", () => {
  assert.match(source, /formatUsageCost\(data\.totals\.cost\)/);
  assert.match(source, /formatUsageTokens\(data\.totals\.tokens\.total\)/);
  assert.match(source, /data\.projects\.map\(\(project\) =>/);
  assert.match(source, /key=\{project\.projectId\}/);
  assert.match(source, /key=\{model\.key\}/);
  assert.match(source, /formatUsageCost\(model\.cost\)/);
});

test("flags partial scans and bounds the empty state", () => {
  assert.match(source, /data\.partial && <div className="usage-banner">/);
  assert.match(source, /data\.projects\.length === 0 && models\.length === 0/);
});

test("never renders a raw project path", () => {
  // Only the basename-only scope name and the opaque id reach the DOM.
  assert.match(source, /data\?\.scope\?\.name \?\? t\("usage\.allProjects"\)/);
  assert.match(source, /project\.name/);
  assert.doesNotMatch(source, /project\.(cwd|path|projectRoot|projectKey)/);
  assert.doesNotMatch(source, /title=\{cwd\}/);
  // No price catalog lookup — cost comes straight from the API payload.
  assert.doesNotMatch(source, /price|calculateCost|models\.json/i);
});
