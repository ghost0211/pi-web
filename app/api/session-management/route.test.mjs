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
const { GET, PATCH, POST } = await jiti.import("./route.ts");

async function withAgentDir(t, callback) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-session-management-api-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await callback(dir);
}

function jsonRequest(method, body) {
  return new Request("http://localhost/api/session-management", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("GET/PATCH expose validated state with no-store response semantics", async (t) => {
  await withAgentDir(t, async () => {
    const initial = await GET();
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await initial.json(), {
      state: { version: 1, revision: 0, sessions: {}, projects: {}, migrationIds: [] },
    });

    const changed = await PATCH(jsonRequest("PATCH", {
      type: "sessions", ids: ["api-session"], status: "archived", pinned: true,
    }));
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get("Cache-Control"), "no-store");
    assert.deepEqual((await changed.json()).state.sessions["api-session"], {
      status: "archived", pinned: false,
    });
    const reread = await GET();
    assert.equal((await reread.json()).state.revision, 1);
  });
});

test("POST backs up legacy payload and imports once", async (t) => {
  await withAgentDir(t, async (dir) => {
    const payload = {
      migrationId: "api-migration",
      hiddenSessions: [{ id: "api-hidden" }],
      hiddenProjects: [{ key: "/api-project" }],
      archivedSessionIds: ["api-archived"],
      pinnedSessionIds: ["api-hidden", "api-pinned"],
      rawBackup: { "pi-web:hidden-sessions": "[\"api-hidden\"]" },
    };
    const migrated = await POST(jsonRequest("POST", payload));
    assert.equal(migrated.status, 200);
    assert.equal(migrated.headers.get("Cache-Control"), "no-store");
    const state = (await migrated.json()).state;
    assert.deepEqual(state.sessions["api-hidden"], { status: "archived", pinned: false });
    assert.deepEqual(state.sessions["api-pinned"], { status: "active", pinned: true });
    assert.deepEqual(state.projects["/api-project"], { removed: true });
    assert.deepEqual(state.migrationIds, ["api-migration"]);
    const backup = JSON.parse(await readFile(join(dir, "pi-web", "session-management-migration-api-migration.json"), "utf8"));
    assert.deepEqual(backup.rawBackup, payload.rawBackup);

    const retried = await POST(jsonRequest("POST", payload));
    assert.deepEqual((await retried.json()).state, state);
  });
});

test("invalid JSON and invalid actions return no-store 400 responses", async (t) => {
  await withAgentDir(t, async () => {
    const malformed = await PATCH(new Request("http://localhost/api/session-management", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{",
    }));
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get("Cache-Control"), "no-store");
    assert.match((await malformed.json()).error, /valid JSON/i);

    const invalid = await PATCH(jsonRequest("PATCH", { type: "project", key: "__proto__", removed: true }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get("Cache-Control"), "no-store");
  });
});

test("corrupt on-disk state fails closed instead of returning defaults", async (t) => {
  await withAgentDir(t, async (dir) => {
    const statePath = join(dir, "pi-web", "session-management.json");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(dir, "pi-web"), { recursive: true }));
    const content = "not-json";
    await writeFile(statePath, content);
    const response = await GET();
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match((await response.json()).error, /storage operation failed/i);
    assert.equal(await readFile(statePath, "utf8"), content);
  });
});
