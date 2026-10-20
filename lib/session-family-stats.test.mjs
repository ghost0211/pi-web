import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { collectFamilyStats, MAX_STATS_SESSIONS } = await jiti.import("./session-family-stats.ts");

const SESSION_ID = "01a11fe6-75a0-7748-b30b-db3e71f06c71";

const usage = (cost) => ({
  input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: cost },
});

function entries({ withCost = true, secret = "secret" } = {}) {
  return [
    { type: "session", version: 3, id: SESSION_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/project" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: secret } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:10.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: secret }],
        usage: withCost ? usage(0.03) : { ...usage(0), cost: {} },
      },
    },
    { type: "custom", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:11.000Z", customType: "pi-web:run-timing", data: { version: 1, durationMs: 9000, finalAssistantEntryId: "a1" } },
  ];
}

async function fixture(t, options) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-family-stats-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "session.jsonl");
  await writeFile(filePath, entries(options).map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  return filePath;
}

test("aggregates a real session file without leaking its content", async (t) => {
  const filePath = await fixture(t);
  const stats = await collectFamilyStats(
    [{ sessionId: SESSION_ID, role: "main" }],
    async () => filePath,
  );
  const row = stats[SESSION_ID];
  assert.equal(row.tokens, 1200);
  assert.equal(row.cost, 0.03);
  assert.equal(row.costIncomplete, false);
  assert.equal(row.measuredDurationMs, 9000);
  assert.equal(row.durationEstimated, false);
  assert.equal(row.role, "main");
  const text = JSON.stringify(stats);
  assert.doesNotMatch(text, /secret|session\.jsonl|\/project/);
});

test("marks a cancelled price as incomplete rather than zero cost", async (t) => {
  const filePath = await fixture(t, { withCost: false });
  const stats = await collectFamilyStats([{ sessionId: SESSION_ID, role: "subagent" }], async () => filePath);
  assert.equal(stats[SESSION_ID].cost, 0);
  assert.equal(stats[SESSION_ID].costIncomplete, true);
});

test("an unresolvable or missing file reports unreadable", async () => {
  const stats = await collectFamilyStats(
    [
      { sessionId: "01a12e3a-1111-7748-b30b-db3e71f06c71", role: "main" },
      { sessionId: "01a12e3a-2222-7748-b30b-db3e71f06c71", role: "subagent" },
    ],
    async (id) => (id.endsWith("111") ? null : "/definitely/missing/session.jsonl"),
  );
  assert.equal(stats["01a12e3a-1111-7748-b30b-db3e71f06c71"].unreadable, true);
  assert.equal(stats["01a12e3a-2222-7748-b30b-db3e71f06c71"].unreadable, true);
});

test("reuses the cache for an unchanged file and reloads after an append", async (t) => {
  const filePath = await fixture(t);
  let reads = 0;
  const resolvePath = async () => { reads += 1; return filePath; };
  const first = await collectFamilyStats([{ sessionId: SESSION_ID, role: "main" }], resolvePath);
  const second = await collectFamilyStats([{ sessionId: SESSION_ID, role: "main" }], resolvePath);
  assert.deepEqual(second[SESSION_ID], first[SESSION_ID]);

  // Grow the file: the cached row must be replaced by the new totals.
  await writeFile(
    filePath,
    `${entries().map((entry) => JSON.stringify(entry)).join("\n")}\n${JSON.stringify({
      type: "message", id: "a2", parentId: "t1", timestamp: "2026-01-01T00:01:00.000Z",
      message: { role: "assistant", content: [], usage: usage(0.07) },
    })}`,
    "utf8",
  );
  const third = await collectFamilyStats([{ sessionId: SESSION_ID, role: "main" }], resolvePath);
  assert.equal(third[SESSION_ID].cost, 0.1);
  assert.ok(third[SESSION_ID].tokens > first[SESSION_ID].tokens);
  assert.equal(reads, 3);
});

test("the family is bounded to the documented maximum", () => {
  assert.equal(MAX_STATS_SESSIONS, 32);
});
