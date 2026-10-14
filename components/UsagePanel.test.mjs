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

test("embedded usage fills its settings host and leaves scrolling to the details", () => {
  assert.match(source, /embedded\?: boolean;/);
  assert.match(source, /UsagePanel\(\{ embedded = false,/);
  assert.match(source, /usage-panel\$\{embedded \? " is-embedded" : ""\}/);
  const embeddedRule = source.match(/\.usage-panel\.is-embedded \{([^}]+)\}/)?.[1] ?? "";
  assert.match(embeddedRule, /width: 100%;/);
  assert.match(embeddedRule, /height: 100%;/);
  assert.match(embeddedRule, /min-height: 0;/);
  assert.match(embeddedRule, /overflow: hidden;/);
  assert.doesNotMatch(embeddedRule, /600px|75dvh|max-height/);
  for (const selector of ["usage-header", "usage-filter", "usage-fixed", "usage-detail-controls"]) {
    const rule = source.match(new RegExp(`\\.${selector} \\{([^}]+)\\}`))?.[1] ?? "";
    assert.match(rule, /flex-shrink: 0;/);
  }
  const scrollRule = source.match(/\.usage-scroll \{([^}]+)\}/)?.[1] ?? "";
  assert.match(scrollRule, /flex: 1;/);
  assert.match(scrollRule, /min-height: 0;/);
  assert.match(scrollRule, /overflow: auto;/);
});

test("short embedded sections compact spacing without hiding the overview", () => {
  assert.match(source, /container-name: usage-embedded;/);
  assert.match(source, /container-type: size;/);
  const compactAt = source.indexOf("@container usage-embedded (max-height: 600px)");
  assert.ok(compactAt > 0, "compact layout follows the actual settings section height");
  const compact = source.slice(compactAt, source.indexOf("@media (max-width: 640px)", compactAt));
  assert.match(compact, /\.usage-chart \{ height: 40px; \}/);
  assert.match(compact, /\.usage-card-value \{ margin-top: 2px; font-size: 16px; \}/);
  assert.doesNotMatch(compact, /display: none|visibility: hidden/);
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

test("provider/project tabs display one dropdown and one grouping at a time", () => {
  assert.match(source, /const DETAIL_TABS: DetailTab\[\] = \["provider", "project"\]/);
  assert.match(source, /role="tablist"/);
  assert.match(source, /role="tab"/);
  assert.match(source, /aria-selected=\{detailTab === tab\}/);
  assert.match(source, /role="tabpanel"/);
  // Both tabs reference the one currently rendered dynamic panel, never an
  // absent inactive-panel id.
  assert.match(source, /aria-controls=\{`\$\{detailId\}-panel`\}/);
  assert.match(source, /id=\{`\$\{detailId\}-panel`\}/);
  assert.match(source, /aria-labelledby=\{`\$\{detailId\}-tab-\$\{detailTab\}`\}/);
  assert.match(source, /\{detailTab === "provider" \? \(/);
  assert.match(source, /data && \(detailTab === "provider" \? \(/);
  assert.match(source, /visibleProviders\.map\(\(provider\) => \(/);
  assert.match(source, /visibleProjects\.map\(\(project\) => <ProjectDetail/);
  assert.match(source, /key=\{provider\.provider\}/);
  assert.match(source, /key=\{project\.projectId\}/);
  assert.match(source, /key=\{model\.key\}/);
  assert.match(source, /formatUsageCost\(model\.cost\)/);
});

test("both dropdowns offer all without colliding with a provider named all", () => {
  assert.equal((source.match(/<option value="">all<\/option>/g) ?? []).length, 2);
  assert.match(source, /data\.providers\.map\(\(provider\) => \(/);
  assert.match(source, /data\.projects\.map\(\(project\) => \(/);
  // Empty value means all; a provider literally named 'all' remains selectable
  // by its actual provider id and filters to that entry only.
  assert.match(source, /providerValue === "" \|\| item\.provider === providerValue/);
  assert.match(source, /projectValue === "" \|\| item\.projectId === projectValue/);
  assert.match(source, /value=\{provider\.provider\}/);
  assert.match(source, /value=\{project\.projectId\}/);
});

test("independent selections default and fall back to all", () => {
  assert.match(source, /\[selectedProvider, setSelectedProvider\] = useState\(""\)/);
  assert.match(source, /\[selectedProject, setSelectedProject\] = useState\(""\)/);
  assert.match(source, /data\?\.providers\.some\(\(item\) => item\.provider === selectedProvider\)\s*\? selectedProvider : ""/);
  assert.match(source, /data\?\.projects\.some\(\(item\) => item\.projectId === selectedProject\)\s*\? selectedProject : ""/);
  assert.match(source, /onChange=\{\(event\) => setSelectedProvider\(event\.target\.value\)\}/);
  assert.match(source, /onChange=\{\(event\) => setSelectedProject\(event\.target\.value\)\}/);
  // Clear removed choices on a new response instead of reviving them when a
  // wider range brings the entry back.
  assert.match(source, /setSelectedProvider\(\(previous\) => payload\.providers\.some\(\(item\) => item\.provider === previous\) \? previous : ""\)/);
  assert.match(source, /setSelectedProject\(\(previous\) => payload\.projects\.some\(\(item\) => item\.projectId === previous\) \? previous : ""\)/);
});

test("tab controls stay above the detail scroll and support keyboard navigation", () => {
  assert.ok(source.indexOf('className="usage-detail-controls"') < source.indexOf('className="usage-scroll"'));
  assert.match(source, /tabIndex=\{detailTab === tab \? 0 : -1\}/);
  assert.match(source, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(source, /setDetailTab\(next\)/);
  assert.match(source, /querySelector<HTMLButtonElement>[\s\S]*?\.focus\(\)/);
  assert.match(source, /key=\{detailTab\}\s+className="usage-scroll"/);
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
  assert.match(source, /visibleProviders\.length === 0 \? <div className="usage-status">/);
  assert.match(source, /visibleProjects\.length === 0 \? <div className="usage-status">/);
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
