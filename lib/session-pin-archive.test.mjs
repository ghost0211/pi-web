import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const pinned = await jiti.import("../lib/pinned-sessions.ts");
const archived = await jiti.import("../lib/archived-sessions.ts");

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

test("pinned sessions toggle and persist", () => {
  const storage = memoryStorage();
  assert.deepEqual(pinned.readPinnedSessionIds(storage), []);
  assert.equal(pinned.togglePinnedSession("a", storage), true);
  assert.equal(pinned.togglePinnedSession("b", storage), true);
  assert.deepEqual(pinned.readPinnedSessionIds(storage), ["a", "b"]);
  assert.equal(pinned.isSessionPinned("a", storage), true);
  // Toggling again unpins.
  assert.equal(pinned.togglePinnedSession("a", storage), false);
  assert.deepEqual(pinned.readPinnedSessionIds(storage), ["b"]);
  pinned.removePinnedSession("b", storage);
  assert.deepEqual(pinned.readPinnedSessionIds(storage), []);
});

test("pinned store tolerates malformed content", () => {
  const storage = memoryStorage();
  storage.setItem("pi-web:pinned-sessions", "{not json");
  assert.deepEqual(pinned.readPinnedSessionIds(storage), []);
  storage.setItem("pi-web:pinned-sessions", JSON.stringify(["a", 1, "", "a", null, "b"]));
  assert.deepEqual(pinned.readPinnedSessionIds(storage), ["a", "b"]);
});

test("orderFamiliesWithPinned keeps pinned families first, stable within groups", () => {
  const families = ["a", "b", "c", "d"].map((id) => ({ root: { id } }));
  const ordered = pinned.orderFamiliesWithPinned(families, new Set(["c", "a"]));
  assert.deepEqual(ordered.map((family) => family.root.id), ["a", "c", "b", "d"]);
  // No pins -> input order preserved; input array is not mutated.
  const same = pinned.orderFamiliesWithPinned(families, new Set());
  assert.deepEqual(same.map((family) => family.root.id), ["a", "b", "c", "d"]);
  assert.deepEqual(families.map((family) => family.root.id), ["a", "b", "c", "d"]);
});

test("archived sessions toggle and show-archived flag round-trips", () => {
  const storage = memoryStorage();
  assert.equal(archived.readShowArchivedSessions(storage), false);
  assert.equal(archived.toggleArchivedSession("s1", storage), true);
  assert.equal(archived.isSessionArchived("s1", storage), true);
  archived.writeShowArchivedSessions(true, storage);
  assert.equal(archived.readShowArchivedSessions(storage), true);
  assert.equal(archived.toggleArchivedSession("s1", storage), false);
  assert.deepEqual(archived.readArchivedSessionIds(storage), []);
  archived.removeArchivedSession("s1", storage); // no-op, must not throw
  assert.deepEqual(archived.readArchivedSessionIds(storage), []);
});

test("archived store tolerates malformed content", () => {
  const storage = memoryStorage();
  storage.setItem("pi-web:archived-sessions", JSON.stringify({ nope: true }));
  assert.deepEqual(archived.readArchivedSessionIds(storage), []);
  storage.setItem("pi-web:show-archived-sessions", "yes");
  assert.equal(archived.readShowArchivedSessions(storage), false);
});
