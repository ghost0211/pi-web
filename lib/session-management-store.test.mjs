import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const store = await jiti.import("./session-management-store.ts");

async function isolatedStore(t, dependencies) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-management-store-"));
  const filePath = join(dir, "session-management.json");
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, filePath, options: { filePath, ...(dependencies ? { dependencies } : {}) } };
}

test("actions archive clears pins, active status retains records, and project restore is independent", async (t) => {
  const { options } = await isolatedStore(t);
  let state = await store.applySessionManagementAction({ type: "sessions", ids: ["s1"], pinned: true }, options);
  assert.deepEqual(state.sessions.s1, { status: "active", pinned: true });

  state = await store.applySessionManagementAction({ type: "sessions", ids: ["s1"], status: "archived" }, options);
  assert.deepEqual(state.sessions.s1, { status: "archived", pinned: false });
  state = await store.applySessionManagementAction({ type: "sessions", ids: ["s1"], status: "active" }, options);
  assert.deepEqual(state.sessions.s1, { status: "active", pinned: false });

  state = await store.applySessionManagementAction({ type: "project", key: "/repo", removed: true, root: "/repo" }, options);
  state = await store.applySessionManagementAction({ type: "sessions", ids: ["s1"], pinned: true }, options);
  assert.deepEqual(state.projects["/repo"], { removed: true, root: "/repo" });
  state = await store.applySessionManagementAction({ type: "sessions", ids: ["s1"], status: "active", restoreProjects: ["/repo"] }, options);
  assert.deepEqual(state.sessions.s1, { status: "active", pinned: true });
  assert.deepEqual(state.projects["/repo"], { removed: false, root: "/repo" });
  assert.equal(state.revision, 6);
});

test("deleted-session cleanup removes only that session metadata", async (t) => {
  const { options } = await isolatedStore(t);
  await store.applySessionManagementAction({ type: "sessions", ids: ["delete-me"], status: "archived" }, options);
  await store.applySessionManagementAction({ type: "project", key: "/still-removed", removed: true }, options);
  const state = await store.forgetDeletedSessionMetadata("delete-me", options);
  assert.equal(Object.hasOwn(state.sessions, "delete-me"), false);
  assert.deepEqual(state.projects["/still-removed"], { removed: true });
});

test("legacy migration unions hidden and archived records, pins only active records, and imports only unknown data", async (t) => {
  const { options, dir, filePath } = await isolatedStore(t);
  await writeFile(filePath, JSON.stringify({
    version: 1,
    revision: 7,
    sessions: { decided: { status: "active", pinned: true }, keep: { status: "archived", pinned: false } },
    projects: { "/known": { removed: false, root: "/known" } },
    migrationIds: [],
    future: { preserved: true },
  }));
  const migration = {
    migrationId: "legacy-2026-01",
    hiddenSessions: [{ id: "hidden", projectKey: "/repo" }],
    hiddenProjects: [{ key: "/gone", root: "/gone" }, { key: "/known", root: "/stale" }],
    archivedSessionIds: ["already-archived", "decided"],
    pinnedSessionIds: ["hidden", "pinned", "decided"],
    rawBackup: {
      "pi-web:hidden-sessions": "[\"hidden\"]",
      "pi-web:hidden-projects": "[\"/gone\"]",
      "pi-web:archived-sessions": "[]",
      "pi-web:pinned-sessions": "[]",
    },
  };

  const migrated = await store.migrateLegacySessionManagement(migration, options);
  assert.deepEqual(migrated.sessions.hidden, { status: "archived", pinned: false });
  assert.deepEqual(migrated.sessions["already-archived"], { status: "archived", pinned: false });
  assert.deepEqual(migrated.sessions.pinned, { status: "active", pinned: true });
  assert.deepEqual(migrated.sessions.decided, { status: "active", pinned: true });
  assert.deepEqual(migrated.projects["/gone"], { removed: true, root: "/gone" });
  assert.deepEqual(migrated.projects["/known"], { removed: false, root: "/known" });
  assert.deepEqual(migrated.future, { preserved: true });
  assert.deepEqual(migrated.migrationIds, ["legacy-2026-01"]);

  const backup = JSON.parse(await readFile(join(dir, "session-management-migration-legacy-2026-01.json"), "utf8"));
  assert.deepEqual(backup.rawBackup, migration.rawBackup);
  assert.deepEqual(backup.payload, migration);
  const retried = await store.migrateLegacySessionManagement(migration, options);
  assert.equal(retried.revision, migrated.revision);
  assert.deepEqual(retried, migrated);
});

test("legacy display-path keys map to catalog identities without overwriting explicit restoration", async (t) => {
  const { options, dir } = await isolatedStore(t);
  const windows = { ...options, platform: "win32" };
  await store.applySessionManagementAction({ type: "project", key: "c:\\work\\repo", removed: false, root: "C:\\Work\\Repo" }, windows);
  const raw = '["C:/WORK/Repo/","D:/Work/Hidden/"]';
  const migrated = await store.migrateLegacySessionManagement({
    migrationId: "path-key-migration", hiddenSessions: [],
    hiddenProjects: [{ key: "C:/WORK/Repo/" }, { key: "D:/Work/Hidden/" }, { key: "opaque-project", root: "D:/Other" }],
    archivedSessionIds: [], pinnedSessionIds: [], rawBackup: { "pi-web:hidden-projects": raw },
  }, windows);
  assert.equal(migrated.projects["c:\\work\\repo"].removed, false);
  assert.deepEqual(migrated.projects["d:\\work\\hidden"], { removed: true, root: "D:/Work/Hidden/" });
  assert.equal(migrated.projects["opaque-project"].removed, true);
  assert.equal(migrated.projects["C:/WORK/Repo/"], undefined);
  const backup = JSON.parse(await readFile(join(dir, "session-management-migration-path-key-migration.json"), "utf8"));
  assert.equal(backup.rawBackup["pi-web:hidden-projects"], raw);
});

test("a failed immutable backup write creates no migration marker or imported state", async (t) => {
  const { options, filePath } = await isolatedStore(t, {
    writeBackup() { throw new Error("injected backup failure"); },
  });
  const migration = {
    migrationId: "backup-fails",
    hiddenSessions: [{ id: "hidden" }],
    hiddenProjects: [],
    archivedSessionIds: [],
    pinnedSessionIds: [],
    rawBackup: { "pi-web:hidden-sessions": "broken-but-preserved" },
  };
  await assert.rejects(store.migrateLegacySessionManagement(migration, options), /injected backup failure/);
  const state = store.getSessionManagementState(options);
  assert.deepEqual(state, { version: 1, revision: 0, sessions: {}, projects: {}, migrationIds: [] });
  assert.equal(JSON.parse(await readFile(filePath, "utf8")).migrationIds.length, 0);
});

test("corrupt state fails closed and is preserved", async (t) => {
  const { options, filePath } = await isolatedStore(t);
  const corrupted = '{"version":1,"revision":"wrong"}';
  await writeFile(filePath, corrupted);
  assert.throws(() => store.getSessionManagementState(options), /invalid|corrupt/i);
  await assert.rejects(store.applySessionManagementAction({ type: "sessions", ids: ["s"], status: "archived" }, options), /invalid|corrupt/i);
  assert.equal(await readFile(filePath, "utf8"), corrupted);
});

test("project map keys accept bounded canonical paths longer than ordinary JSON keys", async (t) => {
  const { options } = await isolatedStore(t);
  const projectKey = `/${"p".repeat(300)}`;
  const state = await store.applySessionManagementAction({
    type: "project", key: projectKey, removed: true, root: projectKey,
  }, options);

  assert.equal(projectKey.length, 301);
  assert.deepEqual(state.projects[projectKey], { removed: true, root: projectKey });
  assert.deepEqual(store.getSessionManagementState(options).projects[projectKey], {
    removed: true,
    root: projectKey,
  });
});

test("unknown fields survive updates while prototype keys and unsafe IDs are rejected", async (t) => {
  const { options, filePath } = await isolatedStore(t);
  await writeFile(filePath, JSON.stringify({
    version: 1,
    revision: 2,
    sessions: { s: { status: "active", pinned: false, futureSessionField: { answer: 42 } } },
    projects: { "/repo": { removed: false, futureProjectField: "keep" } },
    migrationIds: [],
    futureRootField: ["keep"],
  }));
  const state = await store.applySessionManagementAction({ type: "sessions", ids: ["s"], pinned: true }, options);
  assert.deepEqual(state.sessions.s.futureSessionField, { answer: 42 });
  assert.equal(state.projects["/repo"].futureProjectField, "keep");
  assert.deepEqual(state.futureRootField, ["keep"]);
  await assert.rejects(store.applySessionManagementAction({ type: "sessions", ids: ["__proto__"], pinned: true }, options), /invalid session/i);
  await assert.rejects(store.applySessionManagementAction({ type: "project", key: "constructor", removed: true }, options), /invalid project/i);

  const dangerous = '{"version":1,"revision":0,"sessions":{},"projects":{},"migrationIds":[],"nested":{"__proto__":"bad"}}';
  await writeFile(filePath, dangerous);
  assert.throws(() => store.getSessionManagementState(options), /unsafe object key/i);
});

test("parallel updates serialize without losing decisions", async (t) => {
  const { options } = await isolatedStore(t);
  const updates = Array.from({ length: 12 }, (_, index) => store.applySessionManagementAction({
    type: "sessions", ids: [`s${index}`], status: index % 2 ? "active" : "archived",
  }, options));
  await Promise.all(updates);
  const state = store.getSessionManagementState(options);
  assert.equal(state.revision, 12);
  assert.equal(Object.keys(state.sessions).length, 12);
});
