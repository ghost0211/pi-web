import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST, MAX_STATS_SESSIONS, setSessionPathResolverForTests } = await jiti.import("./route.ts");

const SESSION_A = "01a11fe6-75a0-7748-b30b-db3e71f06c71";
const SESSION_B = "01a12e3a-1111-7748-b30b-db3e71f06c71";

function request(body, headers = { "Content-Type": "application/json" }) {
  return new Request("http://localhost/api/sessions/stats", {
    method: "POST",
    // A constructed Request carries no Host header; the API guard requires one.
    headers: { Host: "localhost", Origin: "http://localhost", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("rejects untrusted origins, wrong content types and oversized bodies", async () => {
  assert.equal((await POST(request({ ids: [SESSION_A] }, { Origin: "http://evil.example" }))).status, 403);
  assert.equal((await POST(request({ ids: [SESSION_A] }, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await POST(request({ ids: [SESSION_A], pad: "x".repeat(9 * 1024) }))).status, 413);
});

test("validates ids and bounds the set", async () => {
  for (const body of [
    {},
    { ids: [] },
    { ids: "not-an-array" },
    { ids: [1] },
    { ids: ["not-a-uuid"] },
    { ids: [SESSION_A, "../etc/passwd"] },
    { ids: Array.from({ length: MAX_STATS_SESSIONS + 1 }, (_, index) => `01a11fe6-75a0-7748-b30b-db3e71f06c${String(index).padStart(2, "0")}`) },
  ]) {
    const response = await POST(request(body));
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
  }
});

test("an unknown session reports unreadable instead of fabricated zeros", async () => {
  const response = await POST(request({ ids: [SESSION_B] }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stats[SESSION_B].unreadable, true);
  assert.equal(body.stats[SESSION_B].tokens, 0);
  assert.equal(body.stats[SESSION_B].cost, 0);
});

test("reads a real session file and returns aggregates without paths or text", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-stats-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "session.jsonl");
  const entries = [
    { type: "session", version: 3, id: SESSION_A, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/project" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "secret prompt" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:10.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "secret answer" }],
        usage: {
          input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200,
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        },
      },
    },
    { type: "custom", id: "t1", parentId: "a1", timestamp: "2026-01-01T00:00:11.000Z", customType: "pi-web:run-timing", data: { version: 1, durationMs: 9000, finalAssistantEntryId: "a1" } },
  ];
  await writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");

  setSessionPathResolverForTests(async () => filePath);
  t.after(() => setSessionPathResolverForTests(null));

  const response = await POST(request({ ids: [SESSION_A], roles: { [SESSION_A]: "subagent" } }));
  assert.equal(response.status, 200);
  const text = await response.clone().text();
  const body = JSON.parse(text);
  assert.equal(body.stats[SESSION_A].role, "subagent");
  assert.equal(body.stats[SESSION_A].tokens, 1200);
  assert.equal(body.stats[SESSION_A].cost, 0.03);
  assert.equal(body.stats[SESSION_A].measuredDurationMs, 9000);
  assert.equal(body.stats[SESSION_A].durationEstimated, false);
  // Privacy: no path, cwd or message text in the payload.
  assert.doesNotMatch(text, /secret prompt|secret answer|\/project|session\.jsonl/);
});
