import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createSessionManagementClient } = await jiti.import("./session-management-client.ts");

const EMPTY_STATE = {
  version: 1,
  revision: 0,
  sessions: {},
  projects: {},
  migrationIds: [],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memoryStorage(initial = {}, { failSet = () => false, failGet = () => false } = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      if (failGet(key)) throw new Error(`get blocked: ${key}`);
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      if (failSet(key)) throw new Error(`set blocked: ${key}`);
      values.set(key, String(value));
    },
  };
}

function testClient({ storage = memoryStorage(), fetch, ...options }) {
  return createSessionManagementClient({
    getStorage: () => storage,
    getOrigin: () => "http://session-management.test",
    generateMigrationId: () => "migration-test-id",
    pollIntervalMs: 0,
    fetch,
    ...options,
  });
}

function installFakeBrowser(t) {
  const previousGlobals = new Map(
    ["window", "document", "BroadcastChannel"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const windows = [];
  const storageValues = new Map();
  const storageWrites = [];
  const channels = new Set();

  class FakeEventTarget {
    listeners = new Map();

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    dispatchEvent(event) {
      for (const listener of this.listeners.get(event.type) ?? []) listener(event);
      return true;
    }
  }

  class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.listeners = new Set();
      this.closed = false;
      channels.add(this);
    }

    addEventListener(type, listener) {
      if (type === "message") this.listeners.add(listener);
    }

    removeEventListener(type, listener) {
      if (type === "message") this.listeners.delete(listener);
    }

    postMessage(data) {
      for (const channel of channels) {
        if (channel === this || channel.closed || channel.name !== this.name) continue;
        for (const listener of channel.listeners) listener({ data });
      }
    }

    close() {
      this.closed = true;
      channels.delete(this);
    }
  }

  for (let index = 0; index < 2; index += 1) windows.push(new FakeEventTarget());
  const fakeDocument = new FakeEventTarget();
  fakeDocument.visibilityState = "visible";
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: windows[0] });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: fakeDocument });
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, writable: true, value: FakeBroadcastChannel });

  function storageFor(sourceWindow) {
    return {
      getItem(key) {
        return storageValues.has(key) ? storageValues.get(key) : null;
      },
      setItem(key, value) {
        const newValue = String(value);
        storageValues.set(key, newValue);
        storageWrites.push({ key, value: newValue });
        for (const targetWindow of windows) {
          if (targetWindow !== sourceWindow) {
            targetWindow.dispatchEvent({ type: "storage", key, newValue });
          }
        }
      },
    };
  }

  t.after(() => {
    for (const channel of channels) channel.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });

  return {
    windows,
    storageWrites,
    storageFor,
    useWindow(index) {
      globalThis.window = windows[index];
    },
  };
}

test("migrates normalized legacy state only after saving exact raw backup", async () => {
  const originalLegacy = {
    "pi-web:hidden-sessions": JSON.stringify(["hidden-1", { id: "hidden-2", projectKey: "/work" }, "hidden-1"]),
    "pi-web:hidden-projects": JSON.stringify(["/hidden-project", { key: "/other", root: "/work/other" }]),
    "pi-web:archived-sessions": JSON.stringify(["archived-1", "archived-1"]),
    "pi-web:pinned-sessions": JSON.stringify(["pinned-1"]),
    "pi-web:show-archived-sessions": "1",
  };
  const storage = memoryStorage(originalLegacy);
  let postBody;
  let calls = 0;
  const client = testClient({
    storage,
    fetch: async (_url, init) => {
      calls += 1;
      if (init.method === "GET") return jsonResponse({ state: EMPTY_STATE });
      assert.equal(init.method, "POST");
      assert.equal(storage.getItem("pi-web:session-management:migration-id"), "migration-test-id");
      const backupKey = "pi-web:session-management:legacy-backup:migration-test-id";
      assert.deepEqual(JSON.parse(storage.getItem(backupKey)), originalLegacy);
      postBody = JSON.parse(init.body);
      return jsonResponse({
        state: {
          version: 1,
          revision: 1,
          sessions: {
            "hidden-1": { status: "active", pinned: false },
            "hidden-2": { status: "active", pinned: false },
            "archived-1": { status: "archived", pinned: false },
            "pinned-1": { status: "active", pinned: true },
          },
          projects: {
            "/hidden-project": { removed: true },
            "/other": { removed: true, root: "/work/other" },
          },
          migrationIds: ["migration-test-id"],
        },
      });
    },
  });

  const state = await client.load();
  assert.equal(calls, 2);
  assert.equal(state.migrationIds.includes("migration-test-id"), true);
  assert.deepEqual(postBody.hiddenSessions, [
    { id: "hidden-1" },
    { id: "hidden-2", projectKey: "/work" },
  ]);
  assert.deepEqual(postBody.hiddenProjects, [
    { key: "/hidden-project" },
    { key: "/other", root: "/work/other" },
  ]);
  assert.deepEqual(postBody.archivedSessionIds, ["archived-1"]);
  assert.deepEqual(postBody.pinnedSessionIds, ["pinned-1"]);
  assert.deepEqual(postBody.rawBackup, originalLegacy);
  for (const [key, value] of Object.entries(originalLegacy)) assert.equal(storage.getItem(key), value);
  assert.equal((await client.load()), state);
  assert.equal(calls, 2, "cached load does not repeat GET or migration");
});

test("deduplicates bootstrap GET and migration among consumers", async () => {
  let releaseGet;
  let gets = 0;
  let posts = 0;
  const gate = new Promise((resolve) => { releaseGet = resolve; });
  const client = testClient({
    storage: memoryStorage({ "pi-web:hidden-sessions": JSON.stringify(["legacy"]) }),
    fetch: async (_url, init) => {
      if (init.method === "GET") {
        gets += 1;
        await gate;
        return jsonResponse({ state: EMPTY_STATE });
      }
      posts += 1;
      return jsonResponse({ state: { ...EMPTY_STATE, revision: 1, migrationIds: ["migration-test-id"] } });
    },
  });

  const first = client.load();
  const second = client.load();
  assert.equal(gets, 1);
  releaseGet();
  const [firstState, secondState] = await Promise.all([first, second]);
  assert.equal(firstState, secondState);
  assert.equal(posts, 1);
});

test("migration acknowledgement is required before ready and retry reuses its saved id/backup", async () => {
  const legacyRaw = JSON.stringify(["legacy"]);
  const storage = memoryStorage({ "pi-web:hidden-sessions": legacyRaw });
  let acknowledge = false;
  const posted = [];
  const client = testClient({
    storage,
    fetch: async (_url, init) => {
      if (init.method === "GET") return jsonResponse({ state: EMPTY_STATE });
      posted.push(JSON.parse(init.body));
      return jsonResponse({
        state: {
          ...EMPTY_STATE,
          revision: 1,
          migrationIds: acknowledge ? ["migration-test-id"] : [],
        },
      });
    },
  });

  await assert.rejects(client.load(), /did not acknowledge/);
  assert.equal(client.getSnapshot().ready, false);
  assert.equal(client.getSnapshot().state, null);
  assert.equal(storage.getItem("pi-web:session-management:migration-id"), "migration-test-id");
  acknowledge = true;
  const state = await client.load();
  assert.equal(state.migrationIds.includes("migration-test-id"), true);
  assert.equal(posted.length, 2);
  assert.deepEqual(posted[0], posted[1]);
  assert.deepEqual(posted[1].rawBackup["pi-web:hidden-sessions"], legacyRaw);
});

test("a GET started before a PATCH cannot overwrite the newer PATCH state", async () => {
  let getCount = 0;
  let releaseStaleGet;
  const staleGet = new Promise((resolve) => { releaseStaleGet = resolve; });
  const patchedState = {
    version: 1,
    revision: 2,
    sessions: { s1: { status: "archived", pinned: true } },
    projects: {},
    migrationIds: [],
  };
  const client = testClient({
    fetch: async (_url, init) => {
      if (init.method === "GET") {
        getCount += 1;
        if (getCount === 1) return jsonResponse({ state: { ...EMPTY_STATE, revision: 1 } });
        await staleGet;
        return jsonResponse({ state: { ...EMPTY_STATE, revision: 1 } });
      }
      assert.equal(init.method, "PATCH");
      assert.deepEqual(JSON.parse(init.body), { type: "sessions", ids: ["s1"], status: "archived", pinned: true });
      return jsonResponse({ state: patchedState });
    },
  });

  await client.load();
  const refreshing = client.refresh();
  assert.equal(getCount, 2);
  const updated = await client.update({ type: "sessions", ids: ["s1"], status: "archived", pinned: true });
  assert.deepEqual(updated, patchedState);
  releaseStaleGet();
  await refreshing;
  assert.deepEqual(client.getSnapshot().state, patchedState);
});

test("PATCH requests are serialized and each action reaches the server", async () => {
  let activePatches = 0;
  let maximumConcurrentPatches = 0;
  let revision = 0;
  const actions = [];
  const client = testClient({
    fetch: async (_url, init) => {
      if (init.method === "GET") return jsonResponse({ state: EMPTY_STATE });
      activePatches += 1;
      maximumConcurrentPatches = Math.max(maximumConcurrentPatches, activePatches);
      actions.push(JSON.parse(init.body));
      await new Promise((resolve) => setTimeout(resolve, 1));
      revision += 1;
      activePatches -= 1;
      return jsonResponse({ state: { ...EMPTY_STATE, revision } });
    },
  });

  await client.load();
  await Promise.all([
    client.update({ type: "sessions", ids: ["one"], pinned: true }),
    client.update({ type: "project", key: "/project", removed: true }),
  ]);
  assert.equal(maximumConcurrentPatches, 1);
  assert.deepEqual(actions, [
    { type: "sessions", ids: ["one"], pinned: true },
    { type: "project", key: "/project", removed: true },
  ]);
  assert.equal(client.getSnapshot().state.revision, 2);
});

test("failed PATCH retains prior state, exposes error, and propagates rejection", async () => {
  const priorState = {
    version: 1,
    revision: 4,
    sessions: { keep: { status: "active", pinned: false } },
    projects: {},
    migrationIds: [],
  };
  const client = testClient({
    fetch: async (_url, init) => init.method === "GET"
      ? jsonResponse({ state: priorState })
      : jsonResponse({ error: "write denied" }, 503),
  });

  await client.load();
  await assert.rejects(
    client.update({ type: "sessions", ids: ["keep"], pinned: true }),
    /HTTP 503.*write denied/,
  );
  assert.deepEqual(client.getSnapshot().state, priorState);
  assert.equal(client.getSnapshot().ready, true);
  assert.match(client.getSnapshot().error, /write denied/);
  assert.equal(client.getSnapshot().loading, false);
});

test("storage read and backup failures prevent migration and are surfaced", async (t) => {
  await t.test("legacy read failure", async () => {
    let posts = 0;
    const storage = memoryStorage({}, { failGet: (key) => key === "pi-web:hidden-projects" });
    const client = testClient({
      storage,
      fetch: async (_url, init) => {
        if (init.method === "POST") posts += 1;
        return jsonResponse({ state: EMPTY_STATE });
      },
    });
    await assert.rejects(client.load(), /Unable to read legacy session-management storage/);
    assert.equal(posts, 0);
    assert.equal(client.getSnapshot().ready, false);
    assert.match(client.getSnapshot().error, /hidden-projects/);
  });

  await t.test("backup write failure", async () => {
    let posts = 0;
    const storage = memoryStorage(
      { "pi-web:hidden-sessions": JSON.stringify(["legacy"]) },
      { failSet: (key) => key.startsWith("pi-web:session-management:legacy-backup:") },
    );
    const client = testClient({
      storage,
      fetch: async (_url, init) => {
        if (init.method === "POST") posts += 1;
        return jsonResponse({ state: EMPTY_STATE });
      },
    });
    await assert.rejects(client.load(), /Unable to save the legacy session-management backup/);
    assert.equal(posts, 0);
    assert.equal(storage.getItem("pi-web:hidden-sessions"), JSON.stringify(["legacy"]));
    assert.equal(client.getSnapshot().ready, false);
  });
});

test("origin changes clear the cached snapshot before loading another backend", async () => {
  let origin = "http://first.test";
  const client = testClient({
    getOrigin: () => origin,
    fetch: async () => jsonResponse({
      state: {
        ...EMPTY_STATE,
        revision: origin === "http://first.test" ? 5 : 1,
        sessions: { [origin]: { status: "active", pinned: false } },
      },
    }),
  });

  await client.load();
  assert.deepEqual(Object.keys(client.getSnapshot().state.sessions), ["http://first.test"]);
  origin = "http://second.test";
  await client.load();
  assert.deepEqual(Object.keys(client.getSnapshot().state.sessions), ["http://second.test"]);
  assert.equal(client.getSnapshot().state.revision, 1);
});

test("show-archived preference alone is not a migration, while API shape is validated", async (t) => {
  await t.test("no meaningful legacy content", async () => {
    const storage = memoryStorage({ "pi-web:show-archived-sessions": "1" });
    let posts = 0;
    const client = testClient({
      storage,
      fetch: async (_url, init) => {
        if (init.method === "POST") posts += 1;
        return jsonResponse({ state: EMPTY_STATE });
      },
    });
    await client.load();
    assert.equal(posts, 0);
    assert.equal(storage.getItem("pi-web:session-management:migration-id"), null);
  });

  await t.test("invalid response shape", async () => {
    const client = testClient({ fetch: async () => jsonResponse({ state: { revision: 1 } }) });
    await assert.rejects(client.load(), /invalid state/);
    assert.equal(client.getSnapshot().ready, false);
    assert.match(client.getSnapshot().error, /invalid state/);
  });
});

test("deletions are sequential, individually acknowledged, and notify successful ids", async () => {
  const deletedEvents = [];
  let activeDeletes = 0;
  let maximumConcurrentDeletes = 0;
  let getCount = 0;
  const client = testClient({
    dispatchCatalogChanged: (ids) => deletedEvents.push(ids),
    fetch: async (url, init) => {
      if (init.method === "GET") {
        getCount += 1;
        return jsonResponse({ state: { ...EMPTY_STATE, revision: 3 } });
      }
      assert.equal(init.method, "DELETE");
      assert.deepEqual(JSON.parse(init.body), { confirm: true });
      activeDeletes += 1;
      maximumConcurrentDeletes = Math.max(maximumConcurrentDeletes, activeDeletes);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeDeletes -= 1;
      if (url.endsWith("/bad")) return jsonResponse({ error: "not found" }, 404);
      assert.equal(url, "/api/sessions/good%2Fid");
      return jsonResponse({ ok: true, warning: "legacy warning" });
    },
  });

  await client.load();
  const result = await client.deleteManagedSessions(["good/id", "bad"]);
  assert.deepEqual(result.deletedIds, ["good/id"]);
  assert.deepEqual(result.failures, [{ id: "bad", error: "Session-management request failed (HTTP 404): not found" }]);
  assert.deepEqual(deletedEvents, [["good/id"]]);
  assert.deepEqual(result.warnings, ["legacy warning"]);
  assert.equal(maximumConcurrentDeletes, 1);
  assert.equal(getCount, 2, "management state refreshed after the batch");
});

test("cross-tab delete messages notify once across channel and storage and refresh metadata", async (t) => {
  const browser = installFakeBrowser(t);
  const localEvents = [];
  const remoteEvents = [];
  let senderGets = 0;
  let receiverGets = 0;
  const sender = testClient({
    storage: browser.storageFor(browser.windows[0]),
    dispatchCatalogChanged: (ids) => localEvents.push(ids),
    fetch: async (_url, init) => {
      if (init.method === "GET") {
        senderGets += 1;
        return jsonResponse({ state: { ...EMPTY_STATE, revision: senderGets } });
      }
      return jsonResponse({ ok: true });
    },
  });
  const receiver = testClient({
    storage: browser.storageFor(browser.windows[1]),
    dispatchCatalogChanged: (ids) => remoteEvents.push(ids),
    fetch: async (_url, init) => {
      assert.equal(init.method, "GET");
      receiverGets += 1;
      return jsonResponse({ state: { ...EMPTY_STATE, revision: receiverGets } });
    },
  });

  browser.useWindow(0);
  const unsubscribeSender = sender.subscribe(() => {});
  await sender.load();
  browser.useWindow(1);
  const unsubscribeReceiver = receiver.subscribe(() => {});
  await receiver.load();

  const result = await sender.deleteManagedSessions(["deleted-session"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(result.deletedIds, ["deleted-session"]);
  assert.deepEqual(localEvents, [["deleted-session"]]);
  assert.deepEqual(remoteEvents, [["deleted-session"]], "duplicate channel/storage delivery emits once");
  assert.equal(receiverGets, 2, "the receiver refreshes metadata after the delete event");
  assert.equal(receiver.getSnapshot().state.revision, 2);

  const messages = browser.storageWrites.map(({ value }) => JSON.parse(value));
  assert.equal(messages.length, 1, "the receiver does not rebroadcast a remote event");
  assert.deepEqual(messages[0].deletedIds, ["deleted-session"]);
  assert.equal(typeof messages[0].eventToken, "string");
  assert.ok(messages[0].eventToken.length > 0);

  browser.useWindow(0);
  unsubscribeSender();
  browser.useWindow(1);
  unsubscribeReceiver();
});

test("failed deletes do not notify or broadcast requested IDs", async (t) => {
  const browser = installFakeBrowser(t);
  const localEvents = [];
  const remoteEvents = [];
  const sender = testClient({
    storage: browser.storageFor(browser.windows[0]),
    dispatchCatalogChanged: (ids) => localEvents.push(ids),
    fetch: async (_url, init) => init.method === "GET"
      ? jsonResponse({ state: EMPTY_STATE })
      : jsonResponse({ error: "delete denied" }, 403),
  });
  let receiverGets = 0;
  const receiver = testClient({
    storage: browser.storageFor(browser.windows[1]),
    dispatchCatalogChanged: (ids) => remoteEvents.push(ids),
    fetch: async () => {
      receiverGets += 1;
      return jsonResponse({ state: EMPTY_STATE });
    },
  });

  browser.useWindow(0);
  const unsubscribeSender = sender.subscribe(() => {});
  await sender.load();
  browser.useWindow(1);
  const unsubscribeReceiver = receiver.subscribe(() => {});
  await receiver.load();
  const result = await sender.deleteManagedSessions(["not-deleted"]);

  assert.deepEqual(result.deletedIds, []);
  assert.equal(result.failures.length, 1);
  assert.deepEqual(localEvents, []);
  assert.deepEqual(remoteEvents, []);
  assert.deepEqual(browser.storageWrites, []);
  assert.equal(receiverGets, 1, "a failed request does not cause a remote refresh signal");

  browser.useWindow(0);
  unsubscribeSender();
  browser.useWindow(1);
  unsubscribeReceiver();
});

test("cross-tab messages reject invalid IDs and oversized payloads", async (t) => {
  const browser = installFakeBrowser(t);
  const remoteEvents = [];
  let receiverGets = 0;
  const receiver = testClient({
    storage: browser.storageFor(browser.windows[1]),
    dispatchCatalogChanged: (ids) => remoteEvents.push(ids),
    fetch: async () => {
      receiverGets += 1;
      return jsonResponse({ state: { ...EMPTY_STATE, revision: receiverGets } });
    },
  });

  browser.useWindow(1);
  const unsubscribeReceiver = receiver.subscribe(() => {});
  await receiver.load();
  const source = new BroadcastChannel("pi-web:session-management");
  source.postMessage({ type: "changed", revision: 2, eventToken: "invalid-id", deletedIds: ["", "bad"] });
  source.postMessage({
    type: "changed",
    revision: 2,
    eventToken: "oversized",
    deletedIds: ["valid"],
    extra: "x".repeat(64 * 1024),
  });
  source.postMessage({
    type: "changed",
    revision: 2,
    eventToken: "too-many-ids",
    deletedIds: Array.from({ length: 101 }, (_, index) => `session-${index}`),
  });
  assert.deepEqual(remoteEvents, []);
  assert.equal(receiverGets, 1);

  source.postMessage({ type: "changed", revision: 2, eventToken: "valid-event", deletedIds: ["valid"] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(remoteEvents, [["valid"]]);
  assert.equal(receiverGets, 2);
  source.close();
  browser.useWindow(1);
  unsubscribeReceiver();
});
