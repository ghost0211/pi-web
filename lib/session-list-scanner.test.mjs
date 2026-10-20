import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const {
  listSessionsIncremental,
  resetSessionScanIndexForTests,
  scanSessionFileInfo,
  invalidateSessionScanEntry,
  flushSessionScanIndexForTests,
} = await jiti.import("./session-list-scanner.ts");
const { listAllSessions, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const timestamp = "2026-01-01T00:00:00.000Z";

// Track every read stream a scan opens, where it starts, and exact bytes read.
const reads = [];
const originalCreateReadStream = fs.createReadStream;
mock.method(fs, "createReadStream", (path, options, ...rest) => {
  const record = { path, start: options?.start ?? 0, bytesRead: 0 };
  reads.push(record);
  const stream = originalCreateReadStream(path, options, ...rest);
  stream.on("data", (chunk) => {
    record.bytesRead += chunk.length;
  });
  return stream;
});
syncBuiltinESMExports();

const line = (entry) => JSON.stringify(entry) + "\n";
const message = (id, role, content, time = timestamp) => ({
  type: "message", id, parentId: null, timestamp: time, message: { role, content },
});

function fixture(t) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-scanner-"));
  const dir = join(root, "sessions", "project");
  fs.mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = root;
  resetSessionScanIndexForTests();
  invalidateSessionListCache();
  t.after(() => {
    resetSessionScanIndexForTests();
    invalidateSessionListCache();
    globalThis.__piSessionPathCache = undefined;
    globalThis.__piPathToSessionIdCache = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function write(id, entries = [], extraHeader = {}) {
    const path = join(dir, `${id}.jsonl`);
    fs.writeFileSync(path, line({ type: "session", version: 3, id, cwd: root, timestamp, ...extraHeader }) + entries.map(line).join(""));
    return path;
  }
  return { root, dir, write, indexPath: join(root, "pi-web-session-index.json") };
}

async function sdkMetadata() {
  return (await SessionManager.listAll()).map((session) => {
    const info = { ...session };
    delete info.allMessagesText;
    return info;
  });
}

async function fullScan(path) {
  const info = await scanSessionFileInfo(path);
  return info ? [info] : [];
}

test("matches SDK metadata and tie ordering across cache hits, mutations, and restarts", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [
    message("a1", "user", [{ type: "image", data: "ignored", mimeType: "image/png" }, { type: "text", text: "first" }, { type: "text", text: "request" }]),
    message("a2", "assistant", [{ type: "text", text: "answer" }]),
    message("a3", "toolResult", [{ type: "text", text: "output" }], "2026-01-03T00:00:00.000Z"),
    { type: "custom", data: "x".repeat(256 * 1024) },
  ]);
  const b = write("b", [message("b1", "user", "forked request")], { parentSession: a });
  const c = write("c");

  async function check(label, expectedReads) {
    const expected = await sdkMetadata();
    reads.length = 0;
    const canonical = (sessions) => [...sessions].sort(
      (a, b) => b.modified.getTime() - a.modified.getTime() || String(a.id).localeCompare(String(b.id)),
    );
    assert.deepEqual(canonical(await listSessionsIncremental()), canonical(expected), label);
    assert.deepEqual(reads.map((r) => r.path).sort(), [...expectedReads].sort(), `${label}: scanned files`);
    flushSessionScanIndexForTests();
  }

  await check("cold", [a, b, c]);
  await check("warm", []);
  if (process.platform !== "win32") assert.equal(fs.statSync(indexPath).mode & 0o777, 0o600);
  resetSessionScanIndexForTests();
  await check("persisted cache", []);

  fs.appendFileSync(a, line({ type: "session_info", name: "  Renamed  " }));
  await check("rename preserves equal-time order", [a]);
  fs.appendFileSync(a, line({ type: "session_info", name: " " }));
  await check("explicit name clear", [a]);
  fs.appendFileSync(b, line(message("b2", "assistant", "new activity", "2026-01-02T00:00:00.000Z")));
  await check("append", [b]);
  write("a", [message("replacement", "user", "rewritten")]);
  await check("whole-file rewrite", [a]);
  const d = write("d", [message("d1", "user", "new session")]);
  fs.rmSync(c);
  await check("create and delete", [d]);

  resetSessionScanIndexForTests();
  fs.appendFileSync(a, line({ type: "session_info", name: "changed while stopped" }));
  fs.rmSync(b);
  await check("restart revalidates changed and deleted files", [a]);
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.deepEqual(Object.keys(persisted.entries).sort(), [a, d].sort());
});

test("discards malformed persisted entries and rebuilds the list from valid session files", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [message("a1", "user", "healthy")]);
  write("b", [message("b1", "user", "also healthy")]);
  const expected = await listSessionsIncremental();
  flushSessionScanIndexForTests();
  const pristine = fs.readFileSync(indexPath, "utf8");
  const corruptions = [
    ["missing fingerprint", (entry) => { delete entry.fp; }],
    ["null fingerprint", (entry) => { entry.fp = null; }],
    ["string size", (entry) => { entry.fp.size = String(entry.fp.size); }],
    ["negative size", (entry) => { entry.fp.size = -1; }],
    ["invalid mtime", (entry) => { entry.fp.mtimeMs = null; }],
    ["missing metadata", (entry) => { delete entry.info; }],
    ["mismatched path", (entry) => { entry.info.path = "/elsewhere/session.jsonl"; }],
    ["invalid id", (entry) => { entry.info.id = null; }],
    ["invalid cwd", (entry) => { entry.info.cwd = []; }],
    ["invalid first message", (entry) => { entry.info.firstMessage = 1; }],
    ["invalid name", (entry) => { entry.info.name = {}; }],
    ["invalid parent", (entry) => { entry.info.parentSessionPath = []; }],
    ["invalid count", (entry) => { entry.info.messageCount = -1; }],
    ["invalid created", (entry) => { entry.info.created = "not a date"; }],
    ["invalid modified", (entry) => { entry.info.modified = "not a date"; }],
    ["null date", (entry) => { entry.info.created = null; }],
    ["malformed resume point", (entry) => { entry.resume.offset = "12"; }],
    ["resume point inside the header", (entry) => { entry.resume.headerEnd = entry.resume.offset + 1; }],
    ["resume point without an inode", (entry) => { delete entry.resume.ino; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const index = JSON.parse(pristine);
    corrupt(index.entries[a]);
    fs.writeFileSync(indexPath, JSON.stringify(index));
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    const sessions = await listAllSessions({ force: true });
    assert.deepEqual(sessions.map((s) => s.id), expected.map((s) => s.id), label);
    flushSessionScanIndexForTests();
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, `${label}: repaired cache survives restart`);
  }
  for (const source of ["{", "null", '{"version":2,"entries":{}}', '{"version":1,"entries":[]}', '{"version":1,"entries":{"broken":null}}']) {
    fs.writeFileSync(indexPath, source);
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, source);
  }
});

test("retains SDK handling of partial lines, activity timestamps, and empty sessions", async (t) => {
  const { dir, write } = fixture(t);
  const a = write("a", [
    message("a1", "assistant", "not the first user message"),
    message("a2", "user", []),
    { ...message("a3", "user", "user message"), message: { role: "user", content: "user message", timestamp: Date.parse("2026-01-04T00:00:00.000Z") } },
  ]);
  fs.appendFileSync(a, '{"unfinished":');
  const b = write("b");
  fs.writeFileSync(b, "\nnot json\n" + fs.readFileSync(b, "utf8"));
  fs.writeFileSync(join(dir, "invalid.jsonl"), line(message("invalid", "user", "no header")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});

test("a file that only grew is parsed from where the last scan stopped", async (t) => {
  const { write } = fixture(t);
  const a = write("a", [message("a1", "assistant", "an assistant-only start", "2026-01-02T00:00:00.000Z")]);
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());

  async function appendAndCheck(label, text, { resumed = true } = {}) {
    const offset = fs.statSync(a).size;
    fs.appendFileSync(a, text);
    const expected = await fullScan(a);
    reads.length = 0;
    const listed = await listSessionsIncremental();
    assert.deepEqual(listed, expected, label);
    if (resumed) {
      assert.equal(reads.length, 1, `${label}: one read`);
      assert.ok(reads[0].start > 0 && reads[0].start <= offset, `${label}: resumed at ${reads[0].start}`);
    } else {
      assert.deepEqual(reads.map((r) => ({ path: r.path, start: r.start })), [{ path: a, start: 0 }], `${label}: full scan`);
    }
    return listed[0];
  }

  let row = await appendAndCheck("message", line(message("a2", "assistant", "more", "2026-01-03T00:00:00.000Z")));
  assert.equal(row.messageCount, 2);
  assert.equal(row.firstMessage, "(no messages)");
  row = await appendAndCheck("rename", line({ type: "session_info", name: "  Renamed  " }));
  assert.equal(row.name, "Renamed");
  row = await appendAndCheck("first user message after an assistant-only start", line(message("a3", "user", [{ type: "text", text: "the" }, { type: "text", text: "question" }])));
  assert.equal(row.firstMessage, "the question");
  row = await appendAndCheck("a later user message keeps the first", line(message("a4", "user", "later question", "2026-01-05T00:00:00.000Z")));
  assert.equal(row.firstMessage, "the question");
  assert.equal(row.modified.toISOString(), "2026-01-05T00:00:00.000Z");
  row = await appendAndCheck("name cleared", line({ type: "session_info", name: " " }));
  assert.equal(row.name, undefined);

  // Partial line midway through a line: counted like readline, next scan retries line from beginning
  const half = line(message("a5", "assistant", "half written", "2026-01-06T00:00:00.000Z"));
  const before = fs.statSync(a).size;
  row = await appendAndCheck("partial line", half.slice(0, 40));
  assert.equal(row.messageCount, 4);
  row = await appendAndCheck("partial line completed", half.slice(40));
  assert.equal(reads[0].start, before, "the completed line is read from its start");
  assert.equal(row.messageCount, 5);

  // Complete entry without trailing newline counts now; with no resume point kept,
  // the newline appended later causes one safe full scan.
  row = await appendAndCheck("entry without newline", JSON.stringify(message("a6", "assistant", "no newline yet")));
  assert.equal(row.messageCount, 6);
  await appendAndCheck("its newline", "\n", { resumed: false });
  await appendAndCheck("resumes after that full scan", line(message("a7", "assistant", "again")));

  // Resume point survives cache reloads
  flushSessionScanIndexForTests();
  resetSessionScanIndexForTests();
  row = await appendAndCheck("after a restart", line(message("a8", "user", "after restart")));
  assert.equal(row.messageCount, 8);
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata(), "matches the SDK");
});

test("quantified I/O: appends read only delta bytes instead of reading the full transcript", async (t) => {
  const { write } = fixture(t);
  // Create a large session with 50 messages (~15 KB)
  const messages = [];
  for (let i = 1; i <= 50; i++) {
    messages.push(message(`m${i}`, i % 2 === 1 ? "user" : "assistant", `Detailed transcript payload content number ${i}: ${"x".repeat(200)}`));
  }
  const sessionPath = write("large_session", messages);
  const initialSize = fs.statSync(sessionPath).size;
  assert.ok(initialSize > 10_000, `Initial file size is ${initialSize} bytes`);

  // First cold scan reads the entire file
  reads.length = 0;
  const coldListing = await listSessionsIncremental();
  assert.equal(coldListing.length, 1);
  assert.equal(coldListing[0].messageCount, 50);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].start, 0);
  assert.equal(reads[0].bytesRead, initialSize, "Cold scan reads 100% of the file bytes");

  // Perform multiple appends and quantify bytes read on each pass
  const appendCount = 4;
  for (let step = 1; step <= appendCount; step++) {
    const sizeBeforeAppend = fs.statSync(sessionPath).size;
    const appendPayload = line(message(`appended_${step}`, "user", `Short message ${step}`, `2026-02-0${step}T00:00:00.000Z`));
    fs.appendFileSync(sessionPath, appendPayload);
    const appendedBytes = Buffer.byteLength(appendPayload);

    reads.length = 0;
    const updated = await listSessionsIncremental();
    assert.equal(updated.length, 1);
    assert.equal(updated[0].messageCount, 50 + step);

    // Quantified assertion: stream starts at exactly previous offset,
    // and read bytes are strictly the appended bytes, not the whole file!
    assert.equal(reads.length, 1, `Step ${step}: exactly one read stream`);
    assert.equal(reads[0].start, sizeBeforeAppend, `Step ${step}: resume start matches previous EOF`);
    assert.equal(reads[0].bytesRead, appendedBytes, `Step ${step}: read bytes match appended payload exactly`);
    assert.ok(reads[0].bytesRead < 500, `Step ${step}: read bytes (${reads[0].bytesRead}) are negligible compared to full size (${sizeBeforeAppend})`);
  }
});

test("normal incremental scans handle UTF-8 CJK text and Windows CRLF without byte offset skew", async (t) => {
  const { dir } = fixture(t);
  const path = join(dir, "cjk_session.jsonl");
  const crlfLine = (obj) => JSON.stringify(obj) + "\r\n";

  // Initial write with CRLF and Chinese characters
  const initial =
    crlfLine({ type: "session", version: 3, id: "cjk", cwd: dir, timestamp }) +
    crlfLine(message("cjk1", "user", "你好，这是包含中文字符和特殊标点的第一条用户提问。"));
  fs.writeFileSync(path, initial);

  const initialSize = fs.statSync(path).size;
  reads.length = 0;
  let listed = await listSessionsIncremental();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].messageCount, 1);
  assert.equal(listed[0].firstMessage, "你好，这是包含中文字符和特殊标点的第一条用户提问。");

  // Incremental append with CRLF and CJK assistant reply
  const append1 = crlfLine(message("cjk2", "assistant", "你好！我收到了你的中文提问，正在处理中：✨🚀", "2026-01-02T10:00:00.000Z"));
  fs.appendFileSync(path, append1);

  reads.length = 0;
  listed = await listSessionsIncremental();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].messageCount, 2);
  assert.equal(listed[0].firstMessage, "你好，这是包含中文字符和特殊标点的第一条用户提问。");
  assert.equal(listed[0].modified.toISOString(), "2026-01-02T10:00:00.000Z");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].start, initialSize);
  assert.equal(reads[0].bytesRead, Buffer.byteLength(append1));

  // Incomplete UTF-8 / partial line: write incomplete multibyte sequence midway
  const incompleteJson = '{"type":"message","id":"cjk3","message":{"role":"user","content":"正在输入中文';
  fs.appendFileSync(path, incompleteJson);

  reads.length = 0;
  listed = await listSessionsIncremental();
  // Incomplete line is discarded safely without corrupting count or firstMessage
  assert.equal(listed[0].messageCount, 2);

  // Complete the incomplete JSON line with CRLF
  const completion = '以及后续完整句子"}}\r\n';
  fs.appendFileSync(path, completion);

  reads.length = 0;
  listed = await listSessionsIncremental();
  assert.equal(listed[0].messageCount, 3);
  // Resumes accurately from the start of the completed line
  assert.deepEqual(listed, await fullScan(path));
});

test("a resumed scan splits CRLF and lone CR line ends as readline does", async (t) => {
  const { dir } = fixture(t);
  const path = join(dir, "crlf.jsonl");
  const crlf = (entry) => JSON.stringify(entry) + "\r\n";
  fs.writeFileSync(path, crlf({ type: "session", version: 3, id: "crlf", cwd: dir, timestamp }) + crlf(message("c1", "user", "windows")));
  await listSessionsIncremental();
  fs.appendFileSync(path, JSON.stringify(message("c2", "assistant", "reply")) + "\r" + crlf({ type: "session_info", name: "CR" }));
  const expected = await fullScan(path);
  reads.length = 0;
  assert.deepEqual(await listSessionsIncremental(), expected);
  assert.ok(reads[0].start > 0, "resumed");
  assert.equal(expected[0].messageCount, 2);
  assert.equal(expected[0].name, "CR");
});

test("a rewrite in place or a truncation falls back to a full scan", async (t) => {
  const { write } = fixture(t);
  const entries = [message("r1", "user", "original question"), message("r2", "assistant", "original answer")];
  const a = write("a", entries);
  async function rewriteAndCheck(label, rewrite) {
    await listSessionsIncremental();
    const before = fs.statSync(a);
    rewrite();
    // A distinct mtime, so even a same-size rewrite changes the fingerprint.
    const later = new Date(before.mtimeMs + 60_000);
    fs.utimesSync(a, later, later);
    const expected = await fullScan(a);
    reads.length = 0;
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    assert.deepEqual(reads.map((r) => ({ path: r.path, start: r.start })), [{ path: a, start: 0 }], `${label}: full scan`);
    return { row: expected[0], grew: fs.statSync(a).size - before.size };
  }

  let result = await rewriteAndCheck("same size", () => write("a", [message("r1", "user", "replaced question"), entries[1]]));
  assert.equal(result.grew, 0);
  assert.equal(result.row.firstMessage, "replaced question");
  result = await rewriteAndCheck("larger, header changed", () => {
    write("a", [...entries, message("r3", "assistant", "appended")], { parentSession: "/elsewhere/parent.jsonl" });
  });
  assert.ok(result.grew > 0);
  assert.equal(result.row.parentSessionPath, "/elsewhere/parent.jsonl");
  result = await rewriteAndCheck("larger, last line changed", () => {
    write("a", [entries[0], message("r2", "assistant", "a longer rewritten answer"), message("r3", "assistant", "appended"), message("r4", "assistant", "appended")], { parentSession: "/elsewhere/parent.jsonl" });
  });
  assert.ok(result.grew > 0);
  assert.equal(result.row.messageCount, 4);
  result = await rewriteAndCheck("truncated", () => write("a", [entries[0]]));
  assert.ok(result.grew < 0);
  assert.equal(result.row.messageCount, 1);
});

test("a file replaced by a rename is read in full, even when its sampled bytes match", async (t) => {
  const { dir, write } = fixture(t);
  const a = write("a", [message("k1", "user", "deploy with key sk-live-1234567890"), message("k2", "assistant", "r".repeat(2048))]);
  await listSessionsIncremental();
  // sed -i replacement: the same-length edit is written to a new file renamed over the old
  const temp = join(dir, ".a.tmp");
  fs.writeFileSync(temp, fs.readFileSync(a, "utf8").replace("sk-live-1234567890", "*".repeat(18)));
  fs.renameSync(temp, a);
  fs.appendFileSync(a, line(message("k3", "assistant", "done")));
  const expected = await fullScan(a);
  reads.length = 0;
  const listed = await listSessionsIncremental();
  assert.deepEqual(listed, expected);
  assert.equal(listed[0].firstMessage, `deploy with key ${"*".repeat(18)}`);
  assert.deepEqual(reads.map((r) => ({ path: r.path, start: r.start })), [{ path: a, start: 0 }], "full scan");
});

test("a raw U+2028 or U+2029 stays inside its line, as pi's loader reads it", async (t) => {
  const { write } = fixture(t);
  const loaded = (path) => {
    const session = SessionManager.open(path);
    const messages = session.getEntries().filter((entry) => entry.type === "message");
    return { messageCount: messages.length, firstMessage: messages[0]?.message.content, name: session.getSessionName() };
  };
  const text = "first\u2028second";
  const a = write("a", [message("u1", "user", text)]);
  assert.ok(fs.readFileSync(a, "utf8").includes("\u2028"), "JSON.stringify leaves it raw");
  let [row] = await listSessionsIncremental();
  assert.deepEqual(loaded(a), { messageCount: 1, firstMessage: text, name: undefined });
  assert.equal(row.messageCount, 1);
  assert.equal(row.firstMessage, text);

  fs.appendFileSync(a, line({ type: "session_info", name: "named\u2029here" }));
  reads.length = 0;
  [row] = await listSessionsIncremental();
  assert.ok(reads[0].start > 0, "resumed");
  assert.deepEqual([row], await fullScan(a));
  assert.equal(row.name, "named\u2029here");
  assert.equal(loaded(a).name, row.name);
});

test("explicit invalidateSessionScanEntry forces full rescan for targeted or all files", async (t) => {
  const { write } = fixture(t);
  const a = write("inv_a", [message("a1", "user", "msg a")]);
  const b = write("inv_b", [message("b1", "user", "msg b")]);
  await listSessionsIncremental();

  // Both files append 1 line
  fs.appendFileSync(a, line(message("a2", "assistant", "more a")));
  fs.appendFileSync(b, line(message("b2", "assistant", "more b")));

  // Invalidate only a: a must do full scan (start: 0), while b resumes (start > 0)
  invalidateSessionScanEntry(a);
  reads.length = 0;
  await listSessionsIncremental();
  const readA = reads.find((r) => r.path === a);
  const readB = reads.find((r) => r.path === b);
  assert.ok(readA && readA.start === 0, "Targeted invalidated file performs full cold scan (start === 0)");
  assert.ok(readB && readB.start > 0, "Non-invalidated file performs tail resume (start > 0)");

  // Append again to both
  fs.appendFileSync(a, line(message("a3", "user", "a3")));
  fs.appendFileSync(b, line(message("b3", "user", "b3")));

  // Global invalidate: both must do full scan
  invalidateSessionScanEntry();
  reads.length = 0;
  await listSessionsIncremental();
  assert.equal(reads.filter((r) => r.path === a && r.start === 0).length, 1, "Global invalidate forces full scan on a");
  assert.equal(reads.filter((r) => r.path === b && r.start === 0).length, 1, "Global invalidate forces full scan on b");
});

test("discovers sessions through project directory symlinks", { skip: process.platform === "win32" }, async (t) => {
  const { root, dir, write } = fixture(t);
  write("a", [message("a1", "user", "linked")]);
  const external = join(root, "external-project");
  fs.renameSync(dir, external);
  fs.symlinkSync(external, dir, "dir");
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});
