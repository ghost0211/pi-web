// Coverage for cross-session usage/cost aggregation. The compute tests pin the
// model-attribution contract (assistant messages own their model; tool results
// and compaction/summary entries inherit the active model; cost is summed, never
// recomputed). The scan tests build real session JSONL files and assert project
// /model grouping, scoping, the oversized and budget skips, the LRU cache, and
// that no absolute path leaks into the response. The route test drives the
// exported handler end to end.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const routeSrc = readFileSync(new URL("../app/api/usage/route.ts", import.meta.url), "utf8");
const libSrc = readFileSync(new URL("./session-usage.ts", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const usageLib = await jiti.import("./session-usage.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const { projectIdentityKey } = await jiti.import("./project-identity.ts");
const { GET } = await jiti.import("../app/api/usage/route.ts");

const {
  collectUsage,
  computeSessionUsage,
  clearSessionUsageCache,
  getSessionUsageCacheSize,
  formatUsageCost,
  formatUsageTokens,
  USAGE_CACHE_MAX_SESSIONS,
} = usageLib;

const T0 = "2026-01-01T00:00:00.000Z";

function approx(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? "approx"}: ${actual} !== ${expected}`);
}

function u(over = {}) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...over,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, ...(over.cost ?? {}) },
  };
}

/** A usage row with an explicit input count and a verbatim historical cost. */
function usageRow(input, totalCost, over = {}) {
  return u({ input, output: over.output ?? 0, cacheRead: over.cacheRead ?? 0, cacheWrite: over.cacheWrite ?? 0, cost: { total: totalCost } });
}

function header(id, cwd) {
  return { type: "session", version: 3, id, timestamp: T0, cwd };
}

function assistantEntry(id, parentId, model, usage, provider = "test") {
  const message = { role: "assistant", provider, model, content: [{ type: "text", text: "ok" }] };
  if (usage) message.usage = usage;
  return { type: "message", id, parentId, timestamp: T0, message };
}

function toolResultEntry(id, parentId, usage) {
  const message = { role: "toolResult", toolCallId: "tc", content: [{ type: "text", text: "result" }] };
  if (usage) message.usage = usage;
  return { type: "message", id, parentId, timestamp: T0, message };
}

function compactionEntry(id, parentId, usage) {
  const entry = { type: "compaction", id, parentId, timestamp: T0, summary: "summary", firstKeptEntryId: parentId, tokensBefore: 10 };
  if (usage) entry.usage = usage;
  return entry;
}

function branchSummaryEntry(id, parentId, usage) {
  const entry = { type: "branch_summary", id, parentId, timestamp: T0, fromId: parentId, summary: "branch" };
  if (usage) entry.usage = usage;
  return entry;
}

function modelChangeEntry(id, parentId, provider, modelId) {
  return { type: "model_change", id, parentId, timestamp: T0, provider, modelId };
}

function makeSessionFile(agentDir, dirName, lines) {
  const projectDir = join(agentDir, "sessions", dirName);
  mkdirSync(projectDir, { recursive: true });
  const filePath = join(projectDir, `2026-01-01T00-00-00-000Z_${dirName}.jsonl`);
  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return filePath;
}

function sessionInfo(id, filePath, { cwd, projectRoot, projectKey, modified }) {
  return {
    path: filePath,
    id,
    cwd,
    projectRoot: projectRoot ?? cwd,
    projectKey: projectKey ?? projectIdentityKey(projectRoot ?? cwd),
    created: modified,
    modified,
    messageCount: 0,
    firstMessage: "",
  };
}

function makeTempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("attributes usage to the message's model and model-less entries to the active model", () => {
  const entries = [
    modelChangeEntry("mc", null, "prov", "base-model"),
    toolResultEntry("t0", "mc", usageRow(1, 0.01)),
    assistantEntry("a1", "t0", "m1", usageRow(10, 0.1), "prov"),
    toolResultEntry("t1", "a1", usageRow(3, 0.03)),
    compactionEntry("c1", "t1", usageRow(2, 0.02)),
    branchSummaryEntry("b1", "c1", usageRow(4, 0.04)),
  ];

  const usage = computeSessionUsage(entries);
  assert.equal(usage.entries, 5);
  assert.equal(usage.input, 20);
  assert.equal(usage.total, 20);

  const base = usage.models.get("prov/base-model");
  assert.ok(base, "tool result before any assistant uses the model_change model");
  assert.equal(base.input, 1);
  approx(base.cost, 0.01);

  const m1 = usage.models.get("prov/m1");
  assert.ok(m1);
  assert.equal(m1.input, 19);
  approx(m1.cost, 0.19);
});

test("sums recorded cost verbatim instead of recomputing it from tokens", () => {
  // A deliberately absurd rate: if the aggregator ever multiplied tokens by a
  // price, this cost would not survive.
  const usage = computeSessionUsage([
    assistantEntry("a1", null, "wild", usageRow(1_000_000, 0.000123)),
  ]);
  assert.equal(usage.models.get("test/wild").input, 1_000_000);
  approx(usage.models.get("test/wild").cost, 0.000123);
  approx(usage.cost, 0.000123);
});

test("formats cost and tokens compactly", () => {
  assert.equal(formatUsageCost(0), "$0.00");
  assert.equal(formatUsageCost(-1), "$0.00");
  assert.equal(formatUsageCost(0.000123), "$0.000123");
  assert.equal(formatUsageCost(0.5), "$0.5000");
  assert.equal(formatUsageCost(2.5), "$2.50");
  assert.equal(formatUsageTokens(999), "999");
  assert.equal(formatUsageTokens(1500), "1.5K");
  assert.equal(formatUsageTokens(2_500_000), "2.50M");
  assert.equal(formatUsageTokens(3_000_000_000), "3.00B");
});

test("collectUsage groups by project and model and never leaks paths", async (t) => {
  clearSessionUsageCache();
  const dir = makeTempDir(t, "pi-web-usage-agg-");
  const p1 = join(dir, "proj-one");
  const p2 = join(dir, "proj-two");
  mkdirSync(p1, { recursive: true });
  mkdirSync(p2, { recursive: true });

  const fileA = makeSessionFile(dir, "sess-a", [
    header("sess-a", p1),
    assistantEntry("a1", null, "m1", usageRow(10, 0.18, { output: 5, cacheRead: 2, cacheWrite: 1 })),
    toolResultEntry("t1", "a1", usageRow(3, 0.1)),
    compactionEntry("c1", "t1", usageRow(1, 0.05)),
  ]);
  const fileB = makeSessionFile(dir, "sess-b", [
    header("sess-b", p1),
    assistantEntry("a1", null, "m2", usageRow(20, 0.3, { output: 10 })),
    toolResultEntry("t1", "a1", usageRow(5, 0.2)),
  ]);
  const fileC = makeSessionFile(dir, "sess-c", [
    header("sess-c", p2),
    assistantEntry("a1", null, "m1", usageRow(7, 0.07, { output: 3 })),
  ]);

  const sessions = [
    sessionInfo("sess-a", fileA, { cwd: p1, modified: "2026-01-03T00:00:00.000Z" }),
    sessionInfo("sess-b", fileB, { cwd: p1, modified: "2026-01-02T00:00:00.000Z" }),
    sessionInfo("sess-c", fileC, { cwd: p2, modified: "2026-01-01T00:00:00.000Z" }),
  ];

  const response = await collectUsage({ sessions });

  assert.equal(response.partial, false);
  assert.deepEqual(response.skipped, { oversized: 0, unreadable: 0, budget: 0 });
  assert.equal(response.scannedSessions, 3);

  assert.equal(response.totals.sessions, 3);
  assert.equal(response.totals.entries, 6);
  assert.equal(response.totals.tokens.input, 46);
  assert.equal(response.totals.tokens.output, 18);
  assert.equal(response.totals.tokens.cacheRead, 2);
  assert.equal(response.totals.tokens.cacheWrite, 1);
  assert.equal(response.totals.tokens.total, 67);
  approx(response.totals.cost, 0.9, "grand total cost");

  // Projects sorted by cost: proj-one (0.83) before proj-two (0.07).
  assert.deepEqual(response.projects.map((project) => project.name), ["proj-one", "proj-two"]);
  const projectOne = response.projects[0];
  assert.equal(projectOne.sessions, 2);
  assert.equal(projectOne.entries, 5);
  assert.equal(projectOne.tokens.total, 57);
  approx(projectOne.cost, 0.83);
  assert.equal(projectOne.lastActivity, "2026-01-03T00:00:00.000Z");
  // Per-project model sessions count sessions within that project.
  assert.deepEqual(projectOne.models.map((model) => model.key), ["test/m2", "test/m1"]);
  assert.deepEqual(projectOne.models.map((model) => model.sessions), [1, 1]);

  // Global model aggregation across projects.
  assert.deepEqual(response.models.map((model) => model.key), ["test/m2", "test/m1"]);
  assert.equal(response.models[0].sessions, 1);
  assert.equal(response.models[1].sessions, 2);
  approx(response.models[1].cost, 0.4);

  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes(dir), false, "response must not contain the temp directory");
  assert.equal(serialized.includes(p1), false);
  assert.equal(serialized.includes("sess-a"), false, "raw file names must not leak");
});

test("collectUsage scopes to a project by key or cwd", async (t) => {
  clearSessionUsageCache();
  const dir = makeTempDir(t, "pi-web-usage-scope-");
  const p1 = join(dir, "alpha");
  const p2 = join(dir, "beta");
  mkdirSync(p1, { recursive: true });
  mkdirSync(p2, { recursive: true });
  const fileA = makeSessionFile(dir, "sa", [header("sa", p1), assistantEntry("a1", null, "m1", usageRow(10, 0.1))]);
  const fileB = makeSessionFile(dir, "sb", [header("sb", p2), assistantEntry("a1", null, "m1", usageRow(20, 0.2))]);
  const sessions = [
    sessionInfo("sa", fileA, { cwd: p1, modified: "2026-01-02T00:00:00.000Z" }),
    sessionInfo("sb", fileB, { cwd: p2, modified: "2026-01-01T00:00:00.000Z" }),
  ];

  const byKey = await collectUsage({ sessions, projectKey: projectIdentityKey(p1) });
  assert.equal(byKey.projects.length, 1);
  assert.equal(byKey.projects[0].name, "alpha");
  assert.equal(byKey.totals.sessions, 1);
  assert.equal(byKey.scope.name, "alpha");
  assert.equal(byKey.scope.projectId, byKey.projects[0].projectId);

  const byCwd = await collectUsage({ sessions, cwd: p2 });
  assert.equal(byCwd.projects.length, 1);
  assert.equal(byCwd.projects[0].name, "beta");

  const none = await collectUsage({ sessions, cwd: join(dir, "missing") });
  assert.equal(none.projects.length, 0);
  assert.equal(none.totals.cost, 0);
  assert.equal(none.scope.name, "missing");
});

test("collectUsage reports oversized files instead of silently dropping them", async (t) => {
  clearSessionUsageCache();
  const dir = makeTempDir(t, "pi-web-usage-oversize-");
  const p = join(dir, "proj");
  mkdirSync(p, { recursive: true });
  const file = makeSessionFile(dir, "big", [header("big", p), assistantEntry("a1", null, "m1", usageRow(10, 0.5))]);
  const sessions = [sessionInfo("big", file, { cwd: p, modified: T0 })];

  const response = await collectUsage({ sessions, maxFileBytes: 50 });
  assert.equal(response.partial, true);
  assert.equal(response.skipped.oversized, 1);
  assert.equal(response.scannedSessions, 0);
  assert.equal(response.totals.cost, 0);
});

test("collectUsage reports the session budget", async (t) => {
  clearSessionUsageCache();
  const dir = makeTempDir(t, "pi-web-usage-budget-");
  const p = join(dir, "proj");
  mkdirSync(p, { recursive: true });
  const sessions = [];
  for (let index = 0; index < 3; index += 1) {
    const id = `s${index}`;
    const file = makeSessionFile(dir, id, [header(id, p), assistantEntry("a1", null, "m1", usageRow(1, 0.01))]);
    sessions.push(sessionInfo(id, file, { cwd: p, modified: `2026-01-0${index + 1}T00:00:00.000Z` }));
  }

  const response = await collectUsage({ sessions, maxSessions: 1 });
  assert.equal(response.scannedSessions, 1);
  assert.equal(response.skipped.budget, 2);
  assert.equal(response.partial, true);
});

test("per-session usage cache is reused and invalidated when the file changes", async (t) => {
  clearSessionUsageCache();
  const dir = makeTempDir(t, "pi-web-usage-cache-");
  const p = join(dir, "proj");
  mkdirSync(p, { recursive: true });
  const file = makeSessionFile(dir, "cache", [header("cache", p), assistantEntry("a1", null, "m1", usageRow(10, 0.1))]);
  const sessions = [sessionInfo("cache", file, { cwd: p, modified: T0 })];

  const first = await collectUsage({ sessions });
  approx(first.totals.cost, 0.1);
  assert.equal(getSessionUsageCacheSize(), 1);

  appendFileSync(file, `${JSON.stringify(assistantEntry("a2", "a1", "m1", usageRow(5, 0.25)))}\n`);
  const second = await collectUsage({ sessions });
  approx(second.totals.cost, 0.35, "cache must be invalidated when the file grows");

  const third = await collectUsage({ sessions });
  approx(third.totals.cost, 0.35);
});

test("per-session usage cache is bounded by its limit", async (t) => {
  clearSessionUsageCache();
  assert.ok(USAGE_CACHE_MAX_SESSIONS >= 2);
  const dir = makeTempDir(t, "pi-web-usage-lru-");
  const p = join(dir, "proj");
  mkdirSync(p, { recursive: true });
  const sessions = [];
  for (let index = 0; index < 3; index += 1) {
    const id = `lru${index}`;
    const file = makeSessionFile(dir, id, [header(id, p), assistantEntry("a1", null, "m1", usageRow(1, 0.01))]);
    sessions.push(sessionInfo(id, file, { cwd: p, modified: `2026-01-0${index + 1}T00:00:00.000Z` }));
  }

  await collectUsage({ sessions, cacheLimit: 2 });
  assert.equal(getSessionUsageCacheSize(), 2);
});

test("usage route validates scope and never echoes it into errors", () => {
  assert.match(routeSrc, /USAGE_MAX_SCOPE_PARAM_LENGTH/);
  assert.match(routeSrc, /collectUsage\(\{ cwd, projectKey, signal: req\.signal \}\)/);
  assert.match(routeSrc, /error: "Usage aggregation failed"/);
  assert.match(routeSrc, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(routeSrc, /String\(error\)/);
  assert.doesNotMatch(routeSrc, /console\./);
  assert.doesNotMatch(libSrc, /console\.(log|warn|error|info|debug)/);
});

test("usage route end to end on a real agent directory", async (t) => {
  const agentDir = makeTempDir(t, "pi-web-usage-route-");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  clearSessionUsageCache();
  invalidateSessionListCache();
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    clearSessionUsageCache();
    invalidateSessionListCache();
  });

  const cwd = join(agentDir, "route-project");
  mkdirSync(cwd, { recursive: true });
  makeSessionFile(agentDir, "route-session", [
    header("route-session", cwd),
    assistantEntry("a1", null, "m1", usageRow(100, 0.42)),
  ]);

  const tooLong = await GET(new Request(`http://localhost/api/usage?projectKey=${"x".repeat(2000)}`));
  assert.equal(tooLong.status, 400);
  const tooLongBody = await tooLong.json();
  assert.equal(tooLongBody.error, "Scope parameter too long");
  assert.equal(JSON.stringify(tooLongBody).includes("xxxx"), false);

  const response = await GET(new Request("http://localhost/api/usage"));
  assert.equal(response.status, 200);
  const body = await response.json();
  approx(body.totals.cost, 0.42);
  assert.equal(body.projects.length, 1);
  assert.equal(body.projects[0].name, "route-project");
  assert.equal(body.partial, false);

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(agentDir), false);
  assert.equal(serialized.includes(cwd), false);
});
