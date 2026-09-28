import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { RunningTasksPanel, resolveRunningTaskPhase } = await jiti.import("./RunningTasksPanel.tsx");

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

test("wires clicks to the shell selection callback", () => {
  assert.match(source, /onClick=\{\(\) => onSelectSession\(session\)\}/);
  assert.match(source, /onSelectSession: \(session: SessionInfo\) => void/);
  assert.match(source, /aria-current=\{selected \? "true" : undefined\}/);
  // The phase prop is optional so the panel depends only on the existing
  // sessionCatalog + runningSessionIds props.
  assert.match(source, /runningSessionPhases\?/);
});
