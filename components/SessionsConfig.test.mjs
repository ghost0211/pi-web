import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { componentHarness, tick } from "./mcp-test-harness.mjs";

const tempModules = await mkdtemp(join(tmpdir(), "pi-sessions-config-test-"));
const hookMockPath = join(tempModules, "session-management-hook.cjs");
const clientMockPath = join(tempModules, "session-management-client.cjs");
const i18nMockPath = join(tempModules, "i18n.cjs");
await writeFile(hookMockPath, `module.exports = { useSessionManagement: () => globalThis.__sessionsConfigTest.management };`);
await writeFile(clientMockPath, `module.exports = { deleteManagedSessions: (ids) => globalThis.__sessionsConfigTest.deleteManagedSessions(ids) };`);
await writeFile(i18nMockPath, `module.exports = { useI18n: () => ({ locale: "en", t: (key, params = {}) => String(globalThis.__sessionsConfigTest.messages[key] ?? key).replace(/\\{([\\w.-]+)\\}/g, (token, name) => params[name] === undefined ? token : String(params[name])) }) };`);

const loader = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  moduleCache: false,
  alias: {
    "@/hooks/useSessionManagement": hookMockPath,
    "@/lib/session-management-client": clientMockPath,
    "@/hooks/useI18n": i18nMockPath,
    "@/lib/session-management-types": join(process.cwd(), "lib/session-management-types.ts"),
    "@/lib/i18n/format": join(process.cwd(), "lib/i18n/format.ts"),
    "@/lib/workspace-memory": join(process.cwd(), "lib/workspace-memory.ts"),
  },
});
const [{ SessionsConfig }, messages] = await Promise.all([
  loader.import("./SessionsConfig.tsx"),
  loader.import("../lib/session-management-messages.ts"),
]);
const { sessionsManagerMessagesEn, sessionsManagerMessagesZhCN, sessionsManagerMessagesZhTW } = messages;

const projectOne = "C:\\work\\project-one";
const projectTwo = "C:\\work\\project-two";
function makeSession(id, projectKey, name, extra = {}) {
  const cwd = projectKey === "project-one" ? projectOne : projectTwo;
  return {
    id,
    path: `${cwd}\\${id}.jsonl`,
    cwd,
    projectKey,
    projectRoot: cwd,
    created: "2025-01-01T00:00:00.000Z",
    modified: "2025-01-02T00:00:00.000Z",
    name,
    firstMessage: `${name} first prompt`,
    messageCount: 4,
    ...extra,
  };
}
const defaultCatalog = [
  makeSession("session-active", "project-one", "Active session"),
  makeSession("session-archived", "project-two", "Archived session", {
    relation: { kind: "fork", originSessionId: "root-session" },
  }),
  makeSession("session-subagent", "project-one", "Sub-agent", {
    relation: { kind: "subagent", parentSessionId: "session-active", profile: "reviewer", description: "Review", status: "completed" },
  }),
];

function makeState() {
  return {
    version: 1,
    revision: 1,
    sessions: {
      "session-active": { status: "active", pinned: false },
      "session-archived": { status: "archived", pinned: true },
      "session-subagent": { status: "active", pinned: false },
    },
    projects: {
      "project-one": { removed: false, root: projectOne },
      "project-two": { removed: true, root: projectTwo },
      "removed-empty-project": { removed: true, root: "C:\\work\\empty-project" },
    },
    migrationIds: [],
  };
}

function applyAction(state, action) {
  const next = structuredClone(state);
  if (action.type === "project") {
    next.projects[action.key] = { removed: action.removed, ...(action.root ? { root: action.root } : {}) };
    return next;
  }
  for (const id of action.ids) {
    next.sessions[id] ??= { status: "active", pinned: false };
    if (action.status) next.sessions[id].status = action.status;
    if (action.pinned !== undefined) next.sessions[id].pinned = action.pinned;
  }
  for (const key of action.restoreProjects ?? []) {
    next.projects[key] = { ...(next.projects[key] ?? {}), removed: false };
  }
  return next;
}

function setup(t, options = {}) {
  const oldFetch = globalThis.fetch;
  const oldContext = globalThis.__sessionsConfigTest;
  const context = {
    messages: sessionsManagerMessagesEn,
    catalog: structuredClone(options.catalog ?? defaultCatalog),
    fetchCalls: [],
    updateCalls: [],
    deleteCalls: [],
    fetchCatalog: options.fetchCatalog,
    updateError: null,
    deleteManagedSessions: async (ids) => {
      context.deleteCalls.push([...ids]);
      if (options.deleteManagedSessions) return options.deleteManagedSessions([...ids], context);
      return { deletedIds: [...ids], failures: [] };
    },
  };
  context.management = {
    state: makeState(),
    ready: true,
    loading: false,
    error: null,
    async refresh() {},
    async update(action) {
      context.updateCalls.push(structuredClone(action));
      if (context.updateError) throw context.updateError;
      context.management.state = applyAction(context.management.state, action);
      return context.management.state;
    },
  };
  globalThis.__sessionsConfigTest = context;
  globalThis.fetch = async (url, init = {}) => {
    context.fetchCalls.push({ url: String(url), init });
    if (context.fetchCatalog) return context.fetchCatalog(context.fetchCalls.length, context);
    return Response.json({ sessions: context.catalog });
  };
  t.after(async () => {
    globalThis.fetch = oldFetch;
    if (oldContext === undefined) delete globalThis.__sessionsConfigTest;
    else globalThis.__sessionsConfigTest = oldContext;
  });
  const harness = componentHarness(SessionsConfig, { onClose() {}, embedded: true, ...options.props });
  t.after(() => harness.cleanup());
  return { context, harness };
}

async function settle(harness, passes = 4) {
  for (let index = 0; index < passes; index += 1) {
    await tick();
    harness.render();
  }
}

function clickButton(harness, label) {
  const button = harness.button(label);
  assert.ok(button, `expected button: ${label}`);
  assert.notEqual(button.props.disabled, true, `button unexpectedly disabled: ${label}`);
  button.props.onClick();
}

function findButton(harness, predicate, message = "expected matching button") {
  const button = harness.find((node) => node.type === "button" && predicate(node));
  assert.ok(button, message);
  return button;
}

test("shows all sessions, filters statuses, and keeps project filtering inclusive of removed projects", async (t) => {
  const { harness, context } = setup(t);
  harness.render();
  await settle(harness);
  assert.match(harness.text(), /Active session/);
  assert.match(harness.text(), /Archived session/);
  assert.match(harness.text(), /Sub-agent session/);

  const projectSelect = harness.find((node) => node.type === "select");
  assert.ok(projectSelect.props.children.some((option) => option.props?.value === "removed-empty-project"));
  assert.ok(projectSelect.props.children.some((option) => option.props?.value === "project-two" && /Removed from sidebar/.test(option.props.children)));

  clickButton(harness, "Archived (1)");
  harness.render();
  assert.match(harness.text(), /Archived session/);
  assert.doesNotMatch(harness.text(), /Active session/);
  assert.doesNotMatch(harness.text(), /Sub-agent/);
  harness.input("Select visible sessions").props.onChange({ target: { checked: true } });
  harness.render();
  clickButton(harness, "Restore 1 selected");
  await settle(harness);
  assert.deepEqual(context.updateCalls[0], {
    type: "sessions",
    ids: ["session-archived"],
    status: "active",
    restoreProjects: ["project-two"],
  });
});

test("restore is explicit and makes the session's removed project reachable; opening is read-only", async (t) => {
  let selected;
  const { harness, context } = setup(t, {
    props: { initialFilter: "archived", initialProjectKey: "project-two", onSelectSession: (session) => { selected = session; } },
  });
  harness.render();
  await settle(harness);
  assert.match(harness.text(), /Archived session/);
  assert.match(harness.text(), /Removed from sidebar/);

  clickButton(harness, "Open");
  assert.equal(selected.id, "session-archived");
  assert.equal(context.updateCalls.length, 0, "read-open must not restore or otherwise mutate metadata");

  clickButton(harness, "Restore");
  await settle(harness);
  assert.deepEqual(context.updateCalls[0], {
    type: "sessions",
    ids: ["session-archived"],
    status: "active",
    restoreProjects: ["project-two"],
  });
  assert.equal(context.management.state.projects["project-two"].removed, false);
  assert.equal(context.management.state.sessions["session-archived"].status, "active");
});

test("project archive-all reports its count and changes only active sessions", async (t) => {
  const { harness, context } = setup(t, { props: { initialProjectKey: "project-one" } });
  harness.render();
  await settle(harness);
  clickButton(harness, "Archive all 2 normal sessions");
  await settle(harness);
  assert.deepEqual(context.updateCalls[0], {
    type: "sessions",
    ids: ["session-active", "session-subagent"],
    status: "archived",
  });
  assert.equal(context.updateCalls[0].type, "sessions");
});

test("project remove/restore is a project-only action and never archives its sessions", async (t) => {
  const { harness, context } = setup(t, { props: { initialProjectKey: "project-two" } });
  harness.render();
  await settle(harness);
  clickButton(harness, "Restore project");
  await settle(harness);
  assert.deepEqual(context.updateCalls[0], {
    type: "project",
    key: "project-two",
    removed: false,
    root: projectTwo,
  });
  assert.equal(context.management.state.sessions["session-archived"].status, "archived");
  clickButton(harness, "Remove from sidebar");
  await settle(harness);
  assert.deepEqual(context.updateCalls[1], {
    type: "project",
    key: "project-two",
    removed: true,
    root: projectTwo,
  });
  assert.equal(context.management.state.sessions["session-archived"].status, "archived");
});

test("permanent delete requires confirmation, explains scope, and exposes partial failures per row", async (t) => {
  const { harness, context } = setup(t, {
    deleteManagedSessions: async (ids, testContext) => {
      testContext.catalog = testContext.catalog.filter((session) => !ids.includes(session.id) || session.id === "session-archived");
      return {
        deletedIds: ["session-active"],
        failures: [{ id: "session-archived", error: "HTTP 409: session is running" }],
        warnings: ["Some related records were retained."],
      };
    },
  });
  harness.render();
  await settle(harness);
  harness.input("Select visible sessions").props.onChange({ target: { checked: true } });
  harness.render();
  clickButton(harness, "Permanently delete 3 selected session(s)");
  harness.render();
  assert.match(harness.text(), /Permanently delete 3 session\(s\)\?/);
  assert.match(harness.text(), /unrecoverable/);
  assert.match(harness.text(), /Project files are not deleted/);
  assert.match(harness.text(), /Child sessions are retained and reparented/);
  assert.equal(context.deleteCalls.length, 0, "opening the confirmation dialog must not delete");

  clickButton(harness, "Cancel");
  harness.render();
  assert.equal(context.deleteCalls.length, 0, "cancel must not call the delete client");

  clickButton(harness, "Permanently delete 3 selected session(s)");
  harness.render();
  clickButton(harness, "Permanently delete 3");
  await settle(harness, 6);
  assert.deepEqual(context.deleteCalls, [["session-active", "session-archived", "session-subagent"]]);
  assert.match(harness.text(), /Deletion complete: 1 permanently deleted; 2 failed/);
  assert.match(harness.text(), /Deletion is blocked until/i);
  assert.match(harness.text(), /HTTP 409: session is running/);
  assert.match(harness.text(), /Some related records were retained/);
  assert.doesNotMatch(harness.text(), /Permanently delete 3 session\(s\)\?/);
  assert.doesNotMatch(harness.text(), /Active session/);
  assert.match(harness.text(), /Archived session/);
  assert.ok(context.fetchCalls.length >= 2, "catalog should reload after the delete attempt");
});

test("confirmed deletes keep the containing panel busy and disable read-open until results settle", async (t) => {
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const busy = [];
  const { harness } = setup(t, {
    props: { onSelectSession() {}, onOperationBusyChange: (value) => busy.push(value) },
    deleteManagedSessions: () => pending,
  });
  harness.render();
  await settle(harness);
  harness.input("Select Active session").props.onChange({ target: { checked: true } });
  harness.render();
  clickButton(harness, "Permanently delete 1 selected session(s)");
  harness.render();
  clickButton(harness, "Permanently delete 1");
  harness.render();
  assert.equal(busy.at(-1), true);
  assert.equal(harness.button("Open").props.disabled, true);
  complete({ deletedIds: [], failures: [{ id: "session-active", error: "HTTP 500: fixture failure" }] });
  await settle(harness, 6);
  assert.equal(busy.at(-1), false);
  assert.match(harness.text(), /HTTP 500: fixture failure/);
});

test("read-open never performs an implicit restoration for an archived child/fork", async (t) => {
  let selected;
  const { harness, context } = setup(t, {
    props: { initialFilter: "archived", onSelectSession: (session) => { selected = session; } },
  });
  harness.render();
  await settle(harness);
  clickButton(harness, "Open");
  assert.equal(selected.id, "session-archived");
  assert.equal(context.updateCalls.length, 0);
  assert.equal(context.deleteCalls.length, 0);
});

test("catalog failures preserve the previous catalog and disable mutations until retry succeeds", async (t) => {
  const { harness, context } = setup(t, {
    fetchCatalog: (requestNumber, testContext) => requestNumber === 2
      ? Promise.resolve(new Response("unavailable", { status: 503 }))
      : Promise.resolve(Response.json({ sessions: testContext.catalog })),
  });
  harness.render();
  await settle(harness);
  assert.match(harness.text(), /Active session/);
  clickButton(harness, "Refresh");
  await settle(harness);
  assert.match(harness.text(), /Could not load the session catalog/);
  assert.match(harness.text(), /Active session/);
  const deleteButton = findButton(harness, (button) => String(button.props.children).includes("Permanently delete"));
  assert.equal(deleteButton.props.disabled, true);
  assert.equal(context.updateCalls.length, 0);
  clickButton(harness, "Retry");
  await settle(harness);
  assert.doesNotMatch(harness.text(), /Could not load the session catalog/);
  const archiveButton = findButton(harness, (button) => button.props.children === "Archive");
  assert.notEqual(archiveButton.props.disabled, true);
});

test("exports matching flat session-manager dictionaries for all supported locales", () => {
  for (const messages of [sessionsManagerMessagesEn, sessionsManagerMessagesZhCN, sessionsManagerMessagesZhTW]) {
    assert.ok(Object.keys(messages).length > 0);
    assert.ok(Object.keys(messages).every((key) => key.startsWith("sessionsManager.")));
  }
  assert.deepEqual(Object.keys(sessionsManagerMessagesZhCN).sort(), Object.keys(sessionsManagerMessagesEn).sort());
  assert.deepEqual(Object.keys(sessionsManagerMessagesZhTW).sort(), Object.keys(sessionsManagerMessagesEn).sort());
});

test("keeps the UI server-backed and does not use legacy hidden-session localStorage", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("./SessionsConfig.tsx", import.meta.url), "utf8");
  assert.match(source, /useSessionManagement\(\)/);
  assert.match(source, /update\(action\)/);
  assert.match(source, /deleteManagedSessions\(ids\)/);
  assert.doesNotMatch(source, /readHiddenSessions|removeHiddenSession|readHiddenProjects|removeHiddenProject|localStorage/);
});

test.after(async () => {
  await rm(tempModules, { recursive: true, force: true });
});
