import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { RunningTasksPanel, resolveRunningTaskPhase, resolveRunningStartedAt } = await jiti.import("./RunningTasksPanel.tsx");

const source = await readFile(new URL("./RunningTasksPanel.tsx", import.meta.url), "utf8");
const NOW = new Date("2026-01-01T00:10:00.000Z").getTime();

function makeSession(overrides) {
  const id = overrides.id;
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/project/alpha",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:05:00.000Z",
    messageCount: 3,
    firstMessage: `task ${id}`,
    ...overrides,
  };
}

const render = (props) =>
  renderToStaticMarkup(
    React.createElement(RunningTasksPanel, {
      sessions: [],
      runningSessionIds: new Set(),
      onSelectSession() {},
      now: NOW,
      locale: "en",
      ...props,
    }),
  );

test("shows an honest empty state when nothing is running", () => {
  const html = render({ sessions: [makeSession({ id: "idle" })] });
  assert.match(html, /Running tasks/);
  assert.match(html, /No running tasks/);
  assert.doesNotMatch(html, /task idle/);
  // No fabricated current step without server phase data.
  assert.doesNotMatch(html, /Thinking|Responding|Running command|Compacting/);
});

test("renders the loading empty state while the catalog is still loading", () => {
  const html = render({ loading: true });
  assert.match(html, /Loading sessions/);
  assert.doesNotMatch(html, /No running tasks/);
});

test("lists only running sessions, newest activity first, with project and times", () => {
  const sessions = [
    makeSession({ id: "old", firstMessage: "Session Old", modified: "2026-01-01T00:04:00.000Z" }),
    makeSession({
      id: "idle",
      firstMessage: "Session Idle",
      cwd: "/project/beta",
      modified: "2026-01-01T00:09:00.000Z",
    }),
    makeSession({
      id: "new",
      firstMessage: "Session New",
      projectRoot: "/work/gamma",
      modified: "2026-01-01T00:06:00.000Z",
    }),
  ];
  const html = render({
    sessions,
    runningSessionIds: new Set(["old", "new"]),
  });
  assert.match(html, /Session Old/);
  assert.match(html, /Session New/);
  assert.doesNotMatch(html, /Session Idle/);
  assert.match(html, /gamma/);
  // Newest running entry (new) precedes the older one (old).
  assert.ok(html.indexOf("Session New") < html.indexOf("Session Old"));
  // Both start and last-activity times are shown.
  assert.match(html, /Started/);
  assert.match(html, /Last/);
});

test("renders a real server phase only when one is supplied", () => {
  const sessions = [makeSession({ id: "s1", firstMessage: "Phase Task" })];
  const withoutPhase = render({ sessions, runningSessionIds: new Set(["s1"]) });
  assert.doesNotMatch(withoutPhase, /Running command/);

  const withPhase = render({
    sessions,
    runningSessionIds: new Set(["s1"]),
    runningSessionPhases: new Map([["s1", "command"]]),
  });
  assert.match(withPhase, /Running command/);

  const asRecord = render({
    sessions,
    runningSessionIds: new Set(["s1"]),
    runningSessionPhases: { s1: "compacting" },
  });
  assert.match(asRecord, /Compacting/);
});

test("labels subagent sessions and marks the selected row", () => {
  const sessions = [
    makeSession({
      id: "sub1",
      firstMessage: "Sub task",
      relation: { kind: "subagent", parentSessionId: "root", profile: "scout", description: "Explore repo", status: "running" },
    }),
  ];
  const html = render({
    sessions,
    runningSessionIds: new Set(["sub1"]),
    selectedSessionId: "sub1",
  });
  assert.match(html, /Explore repo/);
  assert.match(html, /Sub-agent/);
  assert.match(html, /aria-current="true"/);
});

test("resolveRunningTaskPhase handles Map, record, and missing sources", () => {
  assert.equal(resolveRunningTaskPhase(new Map([["a", "thinking"]]), "a"), "thinking");
  assert.equal(resolveRunningTaskPhase({ b: "streaming" }, "b"), "streaming");
  assert.equal(resolveRunningTaskPhase(undefined, "a"), null);
  assert.equal(resolveRunningTaskPhase(new Map(), "a"), null);
});

test("shows the current run rather than the session age and updates from the supplied clock", () => {
  const props = {
    sessions: [makeSession({ id: "s1" })], runningSessionIds: new Set(["s1"]),
    runningSessionStartedAt: { s1: NOW - 65_000 },
  };
  assert.match(render(props), /This run 1m 05s/);
  assert.match(render({ ...props, now: NOW + 1000 }), /This run 1m 06s/);
  assert.match(render(props), /data-running-duration="s1"/);
  assert.match(render(props), /aria-live="off"/);
  assert.doesNotMatch(render({ ...props, runningSessionStartedAt: undefined }), /This run/);
  assert.match(render({ ...props, runningSessionStartedAt: { s1: NOW + 1000 } }), /This run 0s/);
});

test("separate sessions/rounds use separate server starts, including reopening the same task", () => {
  const sessions = [makeSession({ id: "s1" }), makeSession({ id: "s2" })];
  const props = { sessions, runningSessionIds: new Set(["s1", "s2"]), runningSessionStartedAt: { s1: NOW - 2000, s2: NOW - 120_000 } };
  assert.match(render(props), /This run 2s/);
  assert.match(render(props), /This run 2m 00s/);
  const reopened = render({ ...props, now: NOW + 10_000 });
  assert.match(reopened, /This run 12s/);
  const newRound = render({ ...props, runningSessionStartedAt: { s1: NOW - 1000 } });
  assert.match(newRound, /This run 1s/);
  assert.doesNotMatch(newRound, /This run 2m/);
});

test("missing or malformed timing never uses catalog timestamps as a fabricated start", () => {
  for (const value of [undefined, null, "123", NaN, Infinity, -1, 0]) {
    assert.equal(resolveRunningStartedAt({ s1: value }, "s1"), undefined);
    assert.doesNotMatch(render({ sessions: [makeSession({ id: "s1" })], runningSessionIds: new Set(["s1"]), runningSessionStartedAt: { s1: value } }), /This run/);
  }
  assert.equal(resolveRunningStartedAt(undefined, "s1"), undefined);
});

test("shell/sidebar forwards the server timestamp instead of resetting on each poll", async () => {
  const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /setRunningSessionStartedAt\(data\.runningSessionStartedAt \?\? \{\}\)/);
  assert.match(sidebar, /onRunningSessionIdsChange\?\.\(runningSessionIds, runningSessionPhases, runningSessionStartedAt\)/);
  assert.match(shell, /runningSessionStartedAt=\{runningSessionStartedAt\}/);
});

test("wires clicks to the shell selection callback", () => {
  assert.match(source, /onClick=\{\(\) => onSelectSession\(session\)\}/);
  assert.match(source, /onSelectSession: \(session: SessionInfo\) => void/);
  assert.match(source, /aria-current=\{selected \? "true" : undefined\}/);
  // The phase prop is optional so the panel depends only on the existing
  // sessionCatalog + runningSessionIds props.
  assert.match(source, /runningSessionPhases\?/);
});
