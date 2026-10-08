import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { createJiti } from "jiti";

const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { DELETE: deleteSession, GET: getSessionDetail, PATCH: patchSession } = await jiti.import("./[id]/route.ts");
const { POST: postAgentCommand } = await jiti.import("../agent/[id]/route.ts");
const { startRpcSession } = await jiti.import("../../../lib/rpc-manager.ts");
const { GET: getSessionState } = await jiti.import("./[id]/state/route.ts");
const { GET: getSessionList } = await jiti.import("./route.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const {
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
} = await jiti.import("../../../lib/session-reader.ts");

test("session listing merges live registry snapshots and honors force refresh", () => {
  assert.match(listRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(listRoute, /listAllSessions\(\{ force \}\)/);
  assert.match(listRoute, /attachSessionProjectInfo\(getRpcSessionInfos\(\)\)/);
  assert.match(listRoute, /mergeSessionLists\(persistedSessions, runtimeSessions\)/);
  assert.match(listRoute, /"Cache-Control": "no-store"/);
});

test("session reads use the live SessionManager before requiring a JSONL path", () => {
  for (const source of [detailRoute, contextRoute]) {
    const liveLookup = source.indexOf("getRpcSession(id)");
    const pathLookup = source.indexOf("resolveSessionPath(id)");
    assert.ok(liveLookup >= 0);
    assert.ok(pathLookup > liveLookup);
    assert.match(source, /liveRpc\?\.inner\.sessionManager \?\? SessionManager\.open/);
  }
});

test("detail reads probe disk only on force/mount and evict a stale idle wrapper", () => {
  assert.match(detailRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(detailRoute, /force && liveWrapper\?\.evictIfDiskAhead\(\)/);
  assert.doesNotMatch(contextRoute, /evictIfDiskAhead|readLatestSessionEntryId/);
});

test("live agent state is available before the session file is persisted", () => {
  const liveLookup = stateRoute.indexOf("getRpcSession(id)");
  const pathLookup = stateRoute.indexOf("resolveSessionPath(id)");
  assert.ok(liveLookup >= 0);
  assert.ok(pathLookup > liveLookup);
  assert.match(stateRoute, /if \(rpc\?\.isAlive\(\)\)/);
});

test("deleting an intermediate subagent reparents both relation representations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-reparent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const grandparentPath = join(dir, "grandparent.jsonl");
  const parentPath = join(dir, "parent.jsonl");
  const childPath = join(dir, "child.jsonl");
  const parentId = "delete-reparent-parent";
  const header = (id, parentSession) => JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    ...(parentSession ? { parentSession } : {}),
  });
  await writeFile(grandparentPath, `${header("delete-reparent-grandparent")}\n`);
  await writeFile(parentPath, `${header(parentId, grandparentPath)}\n`);
  await writeFile(childPath, [
    header("delete-reparent-child", parentPath),
    JSON.stringify({
      type: "custom",
      customType: "pi-web:subagent",
      id: "meta",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: {
        version: 1,
        parentSessionId: parentId,
        parentSessionPath: parentPath,
        profile: "Explore",
        description: "Inspect parser",
      },
    }),
    "",
  ].join("\n"));
  cacheSessionPath(parentId, parentPath);
  t.after(async () => {
    invalidateSessionPathCache(parentId);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${parentId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    }),
    { params: Promise.resolve({ id: parentId }) },
  );

  assert.equal(response.status, 200);
  await assert.rejects(readFile(parentPath), { code: "ENOENT" });
  const [childHeaderLine, childMetadataLine] = (await readFile(childPath, "utf8")).trim().split("\n");
  assert.equal(JSON.parse(childHeaderLine).parentSession, grandparentPath);
  assert.deepEqual(JSON.parse(childMetadataLine).data, {
    version: 1,
    parentSessionId: "delete-reparent-grandparent",
    parentSessionPath: grandparentPath,
    profile: "Explore",
    description: "Inspect parser",
  });
});

test("live detail and state routes work without a persisted JSONL file", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "live-route-test";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello live" },
  };
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [entry],
    getLeafId: () => entry.id,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-not-persisted-${process.pid}.jsonl`,
  };
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd: "/tmp",
    send: async () => ({ isStreaming: true }),
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const detailResponse = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`),
    routeContext,
  );
  const stateResponse = await getSessionState(
    new Request(`http://localhost/api/sessions/${id}/state`),
    routeContext,
  );
  const detail = await detailResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detail.info.transient, true);
  assert.equal(detail.info.projectRoot, "/tmp");
  assert.equal(typeof detail.info.projectKey, "string");
  assert.deepEqual(detail.context.messages.map((message) => message.content), ["hello live"]);
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    running: true,
    state: { isStreaming: true },
  });
});

test("session listing returns a gzip-compressed response when the client accepts it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-list-gzip-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });

  const firstMessage = "compressible session content ".repeat(500);
  const manager = SessionManager.create(dir);
  manager.appendMessage({ role: "user", content: firstMessage, timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() });
  invalidateSessionListCache();

  const response = await getSessionList(new Request("http://localhost/api/sessions", {
    headers: { "Accept-Encoding": "gzip" },
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Encoding"), "gzip");
  assert.match(response.headers.get("Vary") ?? "", /(?:^|,\s*)Accept-Encoding(?:\s*,|$)/i);
  const payload = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8"));
  assert.equal(payload.sessions[0].firstMessage, firstMessage);
});

test("session detail returns a gzip-compressed response when the client accepts it", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "live-route-gzip-test";
  const timestamp = "2026-09-05T00:00:00.000Z";
  const firstMessage = "large session detail content ".repeat(500);
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: firstMessage },
  };
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [entry],
    getLeafId: () => entry.id,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-gzip-${process.pid}.jsonl`,
  };
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => false,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd: "/tmp",
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const response = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`, {
      headers: { "Accept-Encoding": "gzip" },
    }),
    { params: Promise.resolve({ id }) },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Encoding"), "gzip");
  const payload = JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8"));
  assert.equal(payload.info.firstMessage, firstMessage);
});

test("DELETE requires explicit confirmation before shutting down even an ephemeral runtime", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "delete-confirmation-test";
  let shutdownCalls = 0;
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    shutdown: async () => { shutdownCalls += 1; },
  }]]);
  t.after(() => { globalThis.__piSessions = previousRegistry; });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).deleted, false);
  assert.equal(shutdownCalls, 0);
});

test("DELETE refuses busy targets and loaded dependent sessions, including idle wrappers", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-busy-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  const targetId = "delete-busy-target";
  const childId = "delete-busy-child";
  const targetPath = join(dir, "target.jsonl");
  const childPath = join(dir, "child.jsonl");
  const header = (id, parentSession) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir, ...(parentSession ? { parentSession } : {}) });
  await writeFile(targetPath, `${header(targetId)}\n`);
  await writeFile(childPath, `${header(childId, targetPath)}\n`);
  cacheSessionPath(targetId, targetPath);
  globalThis.__piSessions = new Map([[childId, { isAlive: () => true, isRunning: () => false }]]);
  t.after(async () => {
    invalidateSessionPathCache(targetId);
    invalidateSessionPathCache(childId);
    globalThis.__piSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });

  const activeChildResponse = await deleteSession(
    new Request(`http://localhost/api/sessions/${targetId}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    }),
    { params: Promise.resolve({ id: targetId }) },
  );
  assert.equal(activeChildResponse.status, 409);
  assert.match((await activeChildResponse.json()).error, /dependent session.*loaded in Pi Web \(even if idle\)/i);
  assert.equal(await readFile(targetPath, "utf8"), `${header(targetId)}\n`);
  assert.equal(await readFile(childPath, "utf8"), `${header(childId, targetPath)}\n`);

  globalThis.__piSessions = new Map([[targetId, {
    isAlive: () => true,
    isRunning: () => true,
    shutdown: async () => { throw new Error("must not shutdown a busy target"); },
  }]]);
  const busyTargetResponse = await deleteSession(
    new Request(`http://localhost/api/sessions/${targetId}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    }),
    { params: Promise.resolve({ id: targetId }) },
  );
  assert.equal(busyTargetResponse.status, 409);
  assert.equal(await readFile(targetPath, "utf8"), `${header(targetId)}\n`);
});

test("DELETE refuses an unpersisted running child discovered from its loaded session header", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-unpersisted-child-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  const targetId = "delete-unpersisted-target";
  const childId = "delete-unpersisted-child";
  const targetPath = join(dir, "target.jsonl");
  const childPath = join(dir, "child-not-yet-persisted.jsonl");
  const header = (id, parentSession) => ({
    type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir,
    ...(parentSession ? { parentSession } : {}),
  });
  const targetHeader = `${JSON.stringify(header(targetId))}\n`;
  await writeFile(targetPath, targetHeader);
  cacheSessionPath(targetId, targetPath);

  let targetShutdowns = 0;
  let childShutdowns = 0;
  const target = {
    sessionId: targetId,
    sessionFile: targetPath,
    isAlive: () => true,
    isRunning: () => false,
    shutdown: async () => { targetShutdowns += 1; },
    inner: { sessionManager: {
      getHeader: () => header(targetId),
      getEntries: () => [],
      getSessionFile: () => targetPath,
    } },
  };
  const child = {
    sessionId: childId,
    sessionFile: childPath,
    isAlive: () => true,
    isRunning: () => true,
    shutdown: async () => { childShutdowns += 1; },
    inner: { sessionManager: {
      getHeader: () => header(childId, targetPath),
      getEntries: () => [],
      getSessionFile: () => childPath,
    } },
  };
  globalThis.__piSessions = new Map([[targetId, target], [childId, child]]);
  t.after(async () => {
    invalidateSessionPathCache(targetId);
    invalidateSessionPathCache(childId);
    globalThis.__piSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${targetId}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    }),
    { params: Promise.resolve({ id: targetId }) },
  );

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /dependent session.*loaded in Pi Web \(even if idle\)/i);
  assert.equal(await readFile(targetPath, "utf8"), targetHeader);
  await assert.rejects(readFile(childPath), { code: "ENOENT" });
  assert.equal(targetShutdowns, 0);
  assert.equal(childShutdowns, 0);
  assert.equal(globalThis.__piSessions.get(targetId), target);
  assert.equal(globalThis.__piSessions.get(childId), child);
});

test("DELETE refuses a no-file metadata-only child of an ephemeral parent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-metadata-child-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  const targetId = "delete-ephemeral-parent";
  const childId = "delete-metadata-only-child";
  const targetHeader = { type: "session", version: 3, id: targetId, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir };
  const childHeader = { type: "session", version: 3, id: childId, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir };
  const metadata = {
    type: "custom",
    customType: "pi-web:subagent",
    data: { version: 1, parentSessionId: targetId, parentSessionPath: "", profile: "Explore", description: "metadata-only child" },
  };
  let targetShutdowns = 0;
  let childShutdowns = 0;
  const target = {
    sessionId: targetId,
    sessionFile: "",
    isAlive: () => true,
    isRunning: () => false,
    isEphemeral: () => true,
    shutdown: async () => { targetShutdowns += 1; },
    inner: { sessionManager: {
      getHeader: () => targetHeader,
      getEntries: () => [],
      getSessionFile: () => undefined,
    } },
  };
  const child = {
    sessionId: childId,
    sessionFile: "",
    isAlive: () => true,
    isRunning: () => false,
    shutdown: async () => { childShutdowns += 1; },
    inner: { sessionManager: {
      getHeader: () => childHeader,
      getEntries: () => [metadata],
      getSessionFile: () => undefined,
    } },
  };
  globalThis.__piSessions = new Map([[targetId, target], [childId, child]]);
  t.after(async () => {
    invalidateSessionPathCache(targetId);
    invalidateSessionPathCache(childId);
    globalThis.__piSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${targetId}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    }),
    { params: Promise.resolve({ id: targetId }) },
  );

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /dependent session.*loaded in Pi Web \(even if idle\)/i);
  assert.equal(targetShutdowns, 0);
  assert.equal(childShutdowns, 0);
  assert.equal(globalThis.__piSessions.get(targetId), target);
  assert.equal(globalThis.__piSessions.get(childId), child);
});

test("DELETE ignores independent loaded wrappers when discovering dependents", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-independent-wrapper-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  const targetId = "delete-independent-target";
  const independentId = "delete-independent-loaded";
  const targetPath = join(dir, "target.jsonl");
  const targetHeader = { type: "session", version: 3, id: targetId, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir };
  await writeFile(targetPath, `${JSON.stringify(targetHeader)}\n`);
  cacheSessionPath(targetId, targetPath);
  let targetShutdowns = 0;
  let independentShutdowns = 0;
  const wrapper = (sessionId, sessionManager, shutdown) => ({
    sessionId,
    isAlive: () => true,
    isRunning: () => false,
    shutdown: async () => { shutdown(); },
    inner: { sessionManager },
  });
  const target = wrapper(targetId, {
    getHeader: () => targetHeader,
    getEntries: () => [],
    getSessionFile: () => targetPath,
  }, () => { targetShutdowns += 1; });
  const independent = wrapper(independentId, {
    getHeader: () => ({ type: "session", id: independentId, cwd: dir }),
    getEntries: () => [],
    getSessionFile: () => undefined,
  }, () => { independentShutdowns += 1; });
  globalThis.__piSessions = new Map([[targetId, target], [independentId, independent]]);
  t.after(async () => {
    invalidateSessionPathCache(targetId);
    globalThis.__piSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${targetId}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    }),
    { params: Promise.resolve({ id: targetId }) },
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, true);
  assert.equal(targetShutdowns, 1);
  assert.equal(independentShutdowns, 0);
  assert.equal(globalThis.__piSessions.get(independentId), independent);
  await assert.rejects(readFile(targetPath), { code: "ENOENT" });
});

test("DELETE barrier rejects startup, prompt, and rename while idle shutdown is pending", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-barrier-race-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  const id = "delete-barrier-race-target";
  const filePath = join(dir, "target.jsonl");
  const header = JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir });
  const original = `${header}\n`;
  await writeFile(filePath, original);
  cacheSessionPath(id, filePath);

  let resolveShutdown;
  let signalShutdownStarted;
  const shutdownStarted = new Promise((resolve) => { signalShutdownStarted = resolve; });
  const shutdownGate = new Promise((resolve) => { resolveShutdown = resolve; });
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => false,
    shutdown: async () => {
      signalShutdownStarted();
      await shutdownGate;
    },
  }]]);
  t.after(async () => {
    resolveShutdown();
    invalidateSessionPathCache(id);
    globalThis.__piSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });

  const context = { params: Promise.resolve({ id }) };
  const deletion = deleteSession(
    new Request(`http://localhost/api/sessions/${id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    }),
    context,
  );
  await shutdownStarted;

  await assert.rejects(startRpcSession(id, filePath, undefined), /permanently deleted/);
  const promptResponse = await postAgentCommand(
    new Request(`http://localhost/api/agent/${id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "prompt", message: "must not append" }),
    }),
    context,
  );
  assert.equal(promptResponse.status, 409);
  const promptError = await promptResponse.json();
  assert.equal(promptError.accepted, false);
  assert.equal(promptError.code, "prompt_rejected");
  assert.match(promptError.error, /permanently deleted/);

  const renameResponse = await patchSession(
    new Request(`http://localhost/api/sessions/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "raced rename" }),
    }),
    context,
  );
  assert.equal(renameResponse.status, 409);
  assert.match((await renameResponse.json()).error, /permanently deleted/);
  assert.equal(await readFile(filePath, "utf8"), original, "blocked requests must not write or recreate the target JSONL");

  resolveShutdown();
  const response = await deletion;
  assert.equal(response.status, 200);
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
});

test("DELETE refuses a legacy startup lock that predates the deletion guard", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-legacy-start-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousStartLocks = globalThis.__piStartLocks;
  process.env.PI_CODING_AGENT_DIR = dir;
  const id = "delete-legacy-start-target";
  const filePath = join(dir, "target.jsonl");
  const original = `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir })}\n`;
  await writeFile(filePath, original);
  cacheSessionPath(id, filePath);
  globalThis.__piStartLocks = new Map([[id, new Promise(() => {})]]);
  t.after(async () => {
    invalidateSessionPathCache(id);
    globalThis.__piStartLocks = previousStartLocks;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /still starting in Pi Web/i);
  assert.equal(await readFile(filePath, "utf8"), original);
});

test("DELETE distinguishes an already-deleted session when metadata cleanup fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-metadata-warning-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const id = "delete-metadata-warning";
  const filePath = join(dir, "session.jsonl");
  const header = JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir });
  await writeFile(filePath, `${header}\n`);
  await writeFile(join(dir, "pi-web", "session-management.json"), "corrupt-state").catch(async (error) => {
    if (error.code !== "ENOENT") throw error;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "pi-web"), { recursive: true });
    await writeFile(join(dir, "pi-web", "session-management.json"), "corrupt-state");
  });
  cacheSessionPath(id, filePath);
  t.after(async () => {
    invalidateSessionPathCache(id);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    }),
    { params: Promise.resolve({ id }) },
  );
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.deleted, true);
  assert.equal(Array.isArray(result.warnings), true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /metadata cleanup failed/i);
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
});

test("concurrent DELETE requests serialize reparenting and remove both requested sessions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-race-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__piSessions = new Map();
  const grandparentId = "delete-race-grandparent";
  const parentId = "delete-race-parent";
  const childId = "delete-race-child";
  const grandparentPath = join(dir, "grandparent.jsonl");
  const parentPath = join(dir, "parent.jsonl");
  const childPath = join(dir, "child.jsonl");
  const header = (id, parentSession) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir, ...(parentSession ? { parentSession } : {}) });
  await writeFile(grandparentPath, `${header(grandparentId)}\n`);
  await writeFile(parentPath, `${header(parentId, grandparentPath)}\n`);
  await writeFile(childPath, `${header(childId, parentPath)}\n`);
  cacheSessionPath(parentId, parentPath);
  cacheSessionPath(childId, childPath);
  t.after(async () => {
    invalidateSessionPathCache(parentId);
    invalidateSessionPathCache(childId);
    globalThis.__piSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });

  const remove = (id) => deleteSession(
    new Request(`http://localhost/api/sessions/${id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    }),
    { params: Promise.resolve({ id }) },
  );
  const [parentResponse, childResponse] = await Promise.all([remove(parentId), remove(childId)]);
  assert.equal(parentResponse.status, 200);
  assert.equal(childResponse.status, 200);
  await assert.rejects(readFile(parentPath), { code: "ENOENT" });
  await assert.rejects(readFile(childPath), { code: "ENOENT" });
  assert.equal(await readFile(grandparentPath, "utf8"), `${header(grandparentId)}\n`);
});

