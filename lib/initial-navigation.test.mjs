import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./initial-navigation.ts");
}

test("uses cwd instead of session when both parameters are present", async () => {
  const { getInitialNavigation } = await loadSubject();
  const result = getInitialNavigation(new URLSearchParams({
    cwd: " /work/project ",
    session: "saved-session",
  }));

  assert.deepEqual(result, {
    requestedCwd: "/work/project",
    sessionId: null,
    entryId: null,
  });
});

test("restores session when cwd is absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ session: "saved-session", entry: "abcd1234" })),
    { requestedCwd: null, sessionId: "saved-session", entryId: "abcd1234" },
  );
});

test("treats an empty cwd as absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ cwd: "  ", session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session", entryId: null },
  );
});

test("preserves a URL-encoded Windows path", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams("cwd=C%3A%5CProjects%5Cpi-web")),
    { requestedCwd: "C:\\Projects\\pi-web", sessionId: null, entryId: null },
  );
});
