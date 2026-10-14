// The Usage panel must accept an optional project scope, read the aggregation
// from /api/usage, render the historical cost/token totals, and never surface a
// raw path. The dashboard adds arbitrary time-range filtering (presets + custom
// dates in the browser's timezone), a trend chart, and a per-provider breakdown
// with nested models. These are source-level assertions, matching the other
// panel tests.
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

test("sends the applied time range with the browser timezone", () => {
  assert.match(source, /query\.set\("from", appliedRange\.from\)/);
  assert.match(source, /query\.set\("to", appliedRange\.to\)/);
  assert.match(source, /query\.set\("tz", String\(new Date\(\)\.getTimezoneOffset\(\)\)\)/);
  // Changing the applied range must retrigger the fetch.
  assert.match(source, /\[cwd, projectKey, reloadKey, appliedRange\]/);
});

test("offers all/today/7d/30d presets plus a custom date range", () => {
  assert.match(source, /\["all", "today", "last7", "last30", "custom"\]/);
  assert.match(source, /aria-pressed=\{preset === key\}/);
  assert.match(source, /type="date"/);
  assert.match(source, /aria-label=\{t\("usage\.range\.from"\)\}/);
  assert.match(source, /aria-label=\{t\("usage\.range\.to"\)\}/);
  // Custom range requires at least one bound and rejects an inverted range.
  assert.match(source, /if \(!customFrom && !customTo\) return;/);
  assert.match(source, /if \(customFrom && customTo && customFrom > customTo\) return;/);
});

test("renders totals and the trend inside the non-scrolling block", () => {
  assert.match(source, /formatUsageCost\(data\.totals\.cost\)/);
  assert.match(source, /formatUsageTokens\(data\.totals\.tokens\.total\)/);
  assert.match(source, /data\.series\.length > 0 && \(/);
  assert.match(source, /points=\{data\.series\}/);
  // The filter bar, cards and chart live above the scroll container so a wheel
  // scroll only moves the detail list.
  const fixedAt = source.indexOf('className="usage-fixed"');
  const cardsAt = source.indexOf('className="usage-cards"');
  const chartAt = source.indexOf("<TrendChart");
  const scrollAt = source.indexOf('className="usage-scroll"');
  assert.ok(fixedAt > 0 && cardsAt > fixedAt, "cards belong to the fixed block");
  assert.ok(chartAt > fixedAt && scrollAt > chartAt, "chart is fixed, details scroll");
});

test("providers and projects are dropdowns that render only the selected entry", () => {
  const selects = source.match(/className="usage-select"/g) ?? [];
  assert.equal(selects.length, 2, "one dropdown for providers, one for projects");
  assert.match(source, /aria-label=\{t\("usage\.byProvider"\)\}/);
  assert.match(source, /aria-label=\{t\("usage\.byProject"\)\}/);
  // Options carry the identifying label plus its totals; only the active entry
  // gets a detail block.
  assert.match(source, /data\.providers\.map\(\(provider\) => \(/);
  assert.match(source, /key=\{provider\.provider\}/);
  assert.match(source, /data\.projects\.map\(\(project\) => \(/);
  assert.match(source, /key=\{project\.projectId\}/);
  assert.match(source, /<ProviderDetail\s+provider=\{activeProvider\}/);
  assert.match(source, /key=\{model\.key\}/);
  assert.match(source, /formatUsageCost\(model\.cost\)/);
  assert.doesNotMatch(
    source,
    /data\.providers\.map\(\(provider\) => \(\s*<ProviderDetail/,
    "the provider list must not render every detail block",
  );
});

test("selection falls back to the top entry when the current one disappears", () => {
  assert.match(
    source,
    /data\.providers\.find\(\(item\) => item\.provider === selectedProvider\) \?\? data\.providers\[0\]/,
  );
  assert.match(
    source,
    /data\.projects\.find\(\(item\) => item\.projectId === selectedProject\) \?\? data\.projects\[0\]/,
  );
  assert.match(source, /onChange=\{\(event\) => setSelectedProvider\(event\.target\.value\)\}/);
  assert.match(source, /onChange=\{\(event\) => setSelectedProject\(event\.target\.value\)\}/);
});

test("trend chart is CSS-only, accessible, and carries exact values in titles", () => {
  assert.match(source, /role="img"/);
  assert.match(source, /aria-label=\{`\$\{title\}: \$\{summary\}`\}/);
  assert.match(source, /className="usage-chart-bar"/);
  assert.match(source, /formatUsageTokens\(point\.tokens\.total\)/);
  assert.match(source, /formatUsageCost\(point\.cost\)/);
});

test("provider rows show a token-share bar of the filtered total", () => {
  assert.match(source, /totalTokens=\{data\.totals\.tokens\.total\}/);
  assert.match(source, /provider\.tokens\.total \/ totalTokens/);
  assert.match(source, /className="usage-share-bar"/);
  assert.match(source, /ModelRows models=\{provider\.models\}/);
});

test("flags partial scans, untimestamped records, and bounds the empty state", () => {
  assert.match(source, /data\.partial && <div className="usage-banner">/);
  assert.match(source, /t\("usage\.untimestamped", \{ count: data\.untimestampedRecords \}\)/);
  assert.match(source, /data\.projects\.length === 0 && data\.providers\.length === 0/);
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
