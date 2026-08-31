import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./hidden-sessions.ts");
  } catch {
    return import("./hidden-sessions.ts");
  }
}

const {
  readHiddenSessions,
  addHiddenSession,
  removeHiddenSession,
  removeHiddenSessionsForProject,
  writeHiddenSessions,
} = await loadSubject();

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
  };
}

test("reads, adds, and removes hidden sessions", () => {
  const storage = memoryStorage();
  assert.deepEqual(readHiddenSessions(storage), []);

  addHiddenSession({ id: "s1", projectKey: "/proj" }, storage);
  addHiddenSession({ id: "s2" }, storage);
  assert.deepEqual(readHiddenSessions(storage), [
    { id: "s1", projectKey: "/proj" },
    { id: "s2" },
  ]);

  removeHiddenSession("s1", storage);
  assert.deepEqual(readHiddenSessions(storage), [{ id: "s2" }]);
});

test("normalizes legacy bare-string entries and dedupes", () => {
  const storage = memoryStorage();
  writeHiddenSessions([{ id: "a" }, { id: "a" }, { id: "b" }], storage);
  assert.deepEqual(readHiddenSessions(storage), [{ id: "a" }, { id: "b" }]);

  storage.data.set("pi-web:hidden-sessions", JSON.stringify(["legacy1", "legacy2"]));
  assert.deepEqual(readHiddenSessions(storage), [{ id: "legacy1" }, { id: "legacy2" }]);
});

test("removes all hidden sessions of a project", () => {
  const storage = memoryStorage();
  addHiddenSession({ id: "s1", projectKey: "/proj" }, storage);
  addHiddenSession({ id: "s2", projectKey: "/proj" }, storage);
  addHiddenSession({ id: "s3" }, storage);

  removeHiddenSessionsForProject("/proj", storage);
  assert.deepEqual(readHiddenSessions(storage), [{ id: "s3" }]);
});
