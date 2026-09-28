// Behavior coverage for cross-session body search. Pure extractor/snippet tests
// pin the "plain text only" contract; the search tests build real session JSONL
// files and assert active-branch scoping, recency ordering, turn anchors and the
// skip/partial reporting that keeps oversized or unreadable sessions from being
// silently dropped. The route test drives the exported handler end to end.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const routeSrc = readFileSync(new URL("../app/api/sessions/search/route.ts", import.meta.url), "utf8");
const libSrc = readFileSync(new URL("./session-search.ts", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const search = await jiti.import("./session-search.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const { GET } = await jiti.import("../app/api/sessions/search/route.ts");

const T = (offsetMs) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();

function header(id, cwd) {
  return { type: "session", version: 3, id, timestamp: T(0), cwd };
}

function user(id, parentId, content, timestamp = T(0)) {
  return { type: "message", id, parentId, timestamp, message: { role: "user", content } };
}

function assistant(id, parentId, content, timestamp = T(1000)) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      provider: "test",
      model: "test-model",
      content: Array.isArray(content) ? content : [{ type: "text", text: content }],
    },
  };
}

function toolResult(id, parentId, text, timestamp = T(1000)) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "toolResult", toolCallId: "tc", content: [{ type: "text", text }] },
  };
}

function compaction(id, parentId, summary, timestamp = T(2000)) {
  return { type: "compaction", id, parentId, timestamp, summary, firstKeptEntryId: parentId, tokensBefore: 10 };
}

function branchSummary(id, parentId, summary, timestamp = T(2000)) {
  return { type: "branch_summary", id, parentId, timestamp, summary };
}

function customMessage(id, parentId, content, timestamp = T(0)) {
  return { type: "custom_message", id, parentId, timestamp, customType: "note", content, display: true };
}

function makeSessionFile(agentDir, dirName, lines) {
  const projectDir = join(agentDir, "sessions", dirName);
  mkdirSync(projectDir, { recursive: true });
  const id = dirName;
  const filePath = join(projectDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return filePath;
}

function sessionInfo(id, filePath, modified) {
  return {
    path: filePath,
    id,
    cwd: dirname(filePath),
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

test("extractEntrySearchText keeps only plain conversational text", () => {
  const { extractEntrySearchText } = search;

  assert.deepEqual(extractEntrySearchText(user("u", null, "hello world")), {
    role: "user",
    text: "hello world",
  });
  // base64 image blocks are dropped even when mixed into a user message.
  assert.deepEqual(
    extractEntrySearchText(user("u", null, [
      { type: "text", text: "kept" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ])),
    { role: "user", text: "kept" },
  );
  // assistant thinking and tool-call arguments are never searchable body text.
  assert.deepEqual(
    extractEntrySearchText(assistant("a", "u", [
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "hidden chain" },
      { type: "toolCall", id: "tc", name: "read", arguments: { path: "/secret-path" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
    ])),
    { role: "assistant", text: "answer" },
  );
  assert.equal(extractEntrySearchText(toolResult("t", "a", "tool output")), null);
  assert.deepEqual(extractEntrySearchText(compaction("c", "u", "summary text")), {
    role: "compaction",
    text: "summary text",
  });
  assert.deepEqual(extractEntrySearchText(branchSummary("b", "u", "branch text")), {
    role: "branch_summary",
    text: "branch text",
  });
  assert.deepEqual(
    extractEntrySearchText(customMessage("cm", "u", [{ type: "text", text: "note text" }])),
    { role: "custom_message", text: "note text" },
  );
  assert.equal(
    extractEntrySearchText({ type: "model_change", id: "m", parentId: null, timestamp: T(0), provider: "p", modelId: "m" }),
    null,
  );
});

test("buildSearchSnippet bounds and centres the excerpt", () => {
  const { buildSearchSnippet, SESSION_SEARCH_MAX_SNIPPET_LENGTH } = search;
  assert.equal(buildSearchSnippet("short and sweet", "sweet"), "short and sweet");
  assert.equal(buildSearchSnippet("one\ntwo\nthree", "two"), "one two three");

  const long = `${"x".repeat(500)} needle ${"y".repeat(500)}`;
  const snippet = buildSearchSnippet(long, "needle");
  assert.ok(snippet.includes("needle"));
  assert.ok(snippet.startsWith("…"));
  assert.ok(snippet.endsWith("…"));
  // Bounded: the body is capped, plus at most the two ellipsis characters.
  assert.ok(snippet.length <= SESSION_SEARCH_MAX_SNIPPET_LENGTH + 2);
});

test("searchSessions returns active-branch matches with turn anchors, newest session first", async (t) => {
  const dir = makeTempDir(t, "pi-web-search-order-");
  const oldPath = makeSessionFile(dir, "old", [
    header("old", dir),
    user("uOld", null, "older prompt"),
    assistant("aOld", "uOld", "a needle in the old session"),
  ]);
  const newPath = makeSessionFile(dir, "new", [
    header("new", dir),
    user("uNew", null, "newer prompt"),
    assistant("aNew", "uNew", "a needle in the new session"),
  ]);

  const { results, partial, truncated } = await search.searchSessions({
    query: "needle",
    sessions: [
      sessionInfo("old", oldPath, "2026-01-01T00:00:00.000Z"),
      sessionInfo("new", newPath, "2026-01-02T00:00:00.000Z"),
    ],
  });

  assert.equal(partial, false);
  assert.equal(truncated, false);
  assert.deepEqual(
    results.map((r) => [r.sessionId, r.entryId, r.role, r.turnEntryId]),
    [
      ["new", "aNew", "assistant", "uNew"],
      ["old", "aOld", "assistant", "uOld"],
    ],
  );
  assert.ok(results[0].snippet.includes("needle"));
  assert.equal(typeof results[0].timestamp, "string");
});

test("searchSessions scopes matches to the active branch", async (t) => {
  const dir = makeTempDir(t, "pi-web-search-branch-");
  const filePath = makeSessionFile(dir, "branched", [
    header("branched", dir),
    user("e0", null, "root prompt"),
    assistant("e1", "e0", "abandoned zebra answer"),
    // e2/e3 replace e1 as the live path; e1 is now off-branch.
    user("e2", "e0", "new prompt"),
    assistant("e3", "e2", "fresh answer"),
  ]);
  const sessions = [sessionInfo("branched", filePath, "2026-01-01T00:00:00.000Z")];

  assert.equal((await search.searchSessions({ query: "zebra", sessions })).results.length, 0);
  const fresh = await search.searchSessions({ query: "fresh", sessions });
  assert.deepEqual(
    fresh.results.map((r) => [r.entryId, r.turnEntryId]),
    [["e3", "e2"]],
  );
});

test("searchSessions never matches tool results, thinking, tool arguments or base64", async (t) => {
  const dir = makeTempDir(t, "pi-web-search-secrets-");
  const filePath = makeSessionFile(dir, "leaky", [
    header("leaky", dir),
    user("u1", null, [
      { type: "text", text: "visible text" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "SEKRITBASE64" } },
    ]),
    toolResult("t1", "u1", "tool secret output"),
    assistant("a1", "u1", [
      { type: "text", text: "assistant visible" },
      { type: "thinking", thinking: "thinking secret" },
      { type: "toolCall", id: "tc", name: "read", arguments: { path: "argument-secret" } },
    ]),
  ]);
  const sessions = [sessionInfo("leaky", filePath, "2026-01-01T00:00:00.000Z")];

  for (const query of ["SEKRITBASE64", "tool secret", "thinking secret", "argument-secret"]) {
    const { results } = await search.searchSessions({ query, sessions });
    assert.equal(results.length, 0, `query ${query} must not match non-body text`);
  }
  const visible = await search.searchSessions({ query: "visible", sessions });
  assert.deepEqual(visible.results.map((r) => r.role).sort(), ["assistant", "user"]);
});

test("searchSessions anchors matches to the nearest user/compaction/branch summary", async (t) => {
  const dir = makeTempDir(t, "pi-web-search-anchor-");
  const filePath = makeSessionFile(dir, "anchors", [
    header("anchors", dir),
    user("u1", null, "first prompt"),
    assistant("a1", "u1", "needle one"),
    compaction("c1", "a1", "needle summary"),
    user("u2", "c1", "second prompt"),
    assistant("a2", "u2", "needle two"),
    branchSummary("bs1", "a2", "needle branch summary"),
    assistant("a3", "bs1", "needle three"),
  ]);

  const { results } = await search.searchSessions({
    query: "needle",
    sessions: [sessionInfo("anchors", filePath, "2026-01-01T00:00:00.000Z")],
  });

  assert.deepEqual(
    results.map((r) => [r.entryId, r.role, r.turnEntryId]),
    [
      ["a1", "assistant", "u1"],
      ["c1", "compaction", "c1"],
      ["a2", "assistant", "u2"],
      ["bs1", "branch_summary", "bs1"],
      ["a3", "assistant", "bs1"],
    ],
  );
});

test("searchSessions reports oversized files instead of silently dropping them", async (t) => {
  const dir = makeTempDir(t, "pi-web-search-oversize-");
  const smallPath = makeSessionFile(dir, "small", [
    header("small", dir),
    user("u1", null, "small needle"),
  ]);
  const bigPath = makeSessionFile(dir, "big", [
    header("big", dir),
    user("u2", null, `big needle ${"z".repeat(5000)}`),
  ]);

  const response = await search.searchSessions({
    query: "needle",
    maxFileBytes: 2000,
    sessions: [
      sessionInfo("big", bigPath, "2026-01-02T00:00:00.000Z"),
      sessionInfo("small", smallPath, "2026-01-01T00:00:00.000Z"),
    ],
  });

  assert.deepEqual(response.results.map((r) => r.sessionId), ["small"]);
  assert.equal(response.partial, true);
  assert.equal(response.skipped.oversized, 1);
  assert.equal(response.skipped.budget, 0);
  assert.equal(response.scannedSessions, 1);
});

test("searchSessions reports the session budget and result cap", async (t) => {
  const dir = makeTempDir(t, "pi-web-search-budget-");
  const sessions = [];
  for (let index = 0; index < 3; index += 1) {
    const id = `s${index}`;
    const filePath = makeSessionFile(dir, id, [
      header(id, dir),
      user(`u${index}`, null, `needle ${index}`),
    ]);
    sessions.push(sessionInfo(id, filePath, `2026-01-0${index + 1}T00:00:00.000Z`));
  }

  const budgeted = await search.searchSessions({ query: "needle", sessions, maxSessions: 1 });
  assert.equal(budgeted.scannedSessions, 1);
  assert.equal(budgeted.skipped.budget, 2);
  assert.equal(budgeted.partial, true);
  assert.deepEqual(budgeted.results.map((r) => r.sessionId), ["s2"]);

  const capped = await search.searchSessions({ query: "needle", sessions, limit: 2 });
  assert.equal(capped.results.length, 2);
  assert.equal(capped.truncated, true);
});

test("search route validates its query and never echoes input into errors", () => {
  assert.match(routeSrc, /SESSION_SEARCH_MAX_QUERY_LENGTH/);
  assert.match(routeSrc, /url\.searchParams\.get\("q"\) \?\? url\.searchParams\.get\("query"\)/);
  assert.match(routeSrc, /error: "Session search failed"/);
  assert.match(routeSrc, /searchSessions\(\{ query, limit, signal: req\.signal \}\)/);
  assert.match(routeSrc, /"Cache-Control": "no-store"/);
  // The query and session content must never reach a log or an error body.
  assert.doesNotMatch(routeSrc, /String\(error\)/);
  assert.doesNotMatch(routeSrc, /console\./);
  assert.doesNotMatch(libSrc, /console\.(log|warn|error|info|debug)/);
});

test("search route end to end on a real agent directory", async (t) => {
  const agentDir = makeTempDir(t, "pi-web-search-route-");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    invalidateSessionListCache();
  });

  const cwd = join(agentDir, "project");
  mkdirSync(cwd, { recursive: true });
  makeSessionFile(agentDir, "route-session", [
    header("route-session", cwd),
    user("u1", null, "route needle prompt"),
    assistant("a1", "u1", "route needle answer"),
  ]);

  const missing = await GET(new Request("http://localhost/api/sessions/search"));
  assert.equal(missing.status, 400);

  const tooLong = await GET(new Request(
    `http://localhost/api/sessions/search?q=${"x".repeat(300)}`,
  ));
  assert.equal(tooLong.status, 400);

  const response = await GET(new Request("http://localhost/api/sessions/search?q=needle"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].sessionId, "route-session");
  assert.equal(body.results[0].role, "user");
  assert.equal(body.results[0].entryId, "u1");
  assert.equal(body.results[1].turnEntryId, "u1");
  assert.equal(body.truncated, false);
});
