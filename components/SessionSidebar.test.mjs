import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { getVisibleRowIndices } = await jiti.import("./SessionSidebar.tsx");

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

function rowsOfHeights(count, height) {
  return Array.from({ length: count }, (_, i) => ({ key: `r${i}`, top: i * height, height }));
}

test("windowing mounts the visible slice and pins the focused row", () => {
  for (const [scrollTop, pinned] of [[0, "r1999"], [10000, "r0"]]) {
    const rows = rowsOfHeights(2000, 34);
    const indices = getVisibleRowIndices(rows, scrollTop, 335, pinned);
    const firstVisible = Math.floor(scrollTop / 34);
    const lastVisible = Math.ceil((scrollTop + 335) / 34) - 1;
    for (let index = firstVisible; index <= lastVisible; index++) assert.ok(indices.includes(index));
    assert.ok(indices.includes(Number(pinned.slice(1))));
    assert.equal(new Set(indices).size, indices.length);
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
    // Overscan keeps the window bounded even with a pinned out-of-view row.
    assert.ok(indices.length < 40);
  }
  // Mixed heights: every row intersecting the viewport is mounted.
  const mixed = [];
  let top = 0;
  for (let i = 0; i < 500; i++) {
    const height = i % 3 === 0 ? 34 : 33;
    mixed.push({ key: `m${i}`, top, height });
    top += height;
  }
  const indices = getVisibleRowIndices(mixed, 2000, 335, null);
  for (let i = 0; i < mixed.length; i++) {
    const row = mixed[i];
    if (row.top + row.height > 2000 && row.top < 2000 + 335) assert.ok(indices.includes(i), `row ${i}`);
  }
});

test("row windows stay valid after the list shrinks and before the viewport is measured", () => {
  assert.deepEqual(getVisibleRowIndices(rowsOfHeights(5, 34), 80000, 335, "r1999"), [0, 1, 2, 3, 4]);
  assert.deepEqual(getVisibleRowIndices([], 80000, 335, "r1999"), []);
  // viewport 0 falls back to a 600px guess
  assert.ok(getVisibleRowIndices(rowsOfHeights(2000, 34), 0, 0).length > 0);
});

test("only Shift+click bypasses session hide confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
  // The row action now hides instead of deleting.
  assert.match(sessionItemSource, /onHide\?: \(id: string\) => void/);
  assert.doesNotMatch(sessionItemSource, /fetch\(`\/api\/sessions\/[^`]+`\).*DELETE/);
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("polls running sessions while visible, and keeps polling in the desktop tray window", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  // Hidden browser tabs stop polling; the Desktop shell keeps polling while
  // minimized to the tray so background completions can raise native toasts.
  assert.match(source, /const desktop = isDesktopApp\(\)/);
  assert.match(source, /desktop \|\| document\.visibilityState === "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("exposes the polled running-session set to the shell", () => {
  assert.match(source, /onRunningSessionIdsChange\?: \(ids: Set<string>, phases: Record<string, RunningTaskPhase>\) => void/);
  assert.match(source, /onRunningSessionIdsChange\?\.\(runningSessionIds, runningSessionPhases\)/);
});

test("exposes the loaded session catalog to the shell", () => {
  assert.match(source, /onSessionsChange\?: \(sessions: SessionInfo\[\]\) => void/);
  assert.match(source, /onSessionsChange\?\.\(allSessions\)/);
});

test("subagent completion stays silent and never becomes unread", () => {
  assert.match(source, /completionNotificationSuppressedSessionIds\?: string\[\]/);
  assert.match(
    source,
    /completedWithNotifications = completedInBackground\.filter\([\s\S]*?!previousSuppressedCompletionSessionIdsRef\.current\.has\(id\)[\s\S]*?!knownSubagentIds\.has\(id\)/,
  );
  assert.match(source, /completedWithNotifications\.forEach\(\(id\) => next\.add\(id\)\)/);
  assert.match(source, /if \(completedWithNotifications\.length > 0\) \{\s*onBackgroundTaskDone\?\.\(completedWithNotifications\)/);
  assert.match(
    source,
    /filter\(\(session\) => session\.relation\?\.kind !== "subagent"\)[\s\S]*?unreadEligibleIds\.has\(id\)/,
  );
});

test("includes project activity counts in accessible labels", () => {
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{activity\.running\}\)`\}/,
  );
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{activity\.unread\}\)`\}/,
  );
});

test("formats session timestamps with the active locale", () => {
  assert.match(source, /import \{ formatRelativeTime \} from "@\/lib\/i18n\/format"/);
  assert.match(sessionItemSource, /const \{ locale, t \} = useI18n\(\)/);
  assert.match(sessionItemSource, /formatRelativeTime\(session\.modified, locale\)/);
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});

test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});

test("manual and lifecycle refreshes bypass the server session-list cache", () => {
  assert.match(source, /force \? "\/api\/sessions\?force=1" : "\/api\/sessions"/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /loadSessions\(isFirst, !isFirst\)/);
  assert.match(source, /onClick=\{\(\) => onToggleSidebar \? onToggleSidebar\(\) : loadSessions\(false, true\)\}/);
  assert.match(source, /loadSessions\(false, true\);[\s\S]*?onBackgroundTaskDone/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{!session\.transient && \(/);
  assert.match(sessionItemSource, /className="session-row-actions"/);
});

test("hides subagent rows and aggregates their state into the main session row", () => {
  assert.match(source, /const projectFamilies = listSessionFamilies\(projectSessions\)/);
  assert.match(source, /familySessions\.some\(\(session\) => session\.id === selectedSessionId\)/);
  assert.match(source, /familySessions\.some\(\(session\) => runningSessionIds\.has\(session\.id\)\)/);
  assert.doesNotMatch(source, /function SessionTreeItem/);
});

test("keeps the file explorer hidden from the sidebar", () => {
  assert.doesNotMatch(source, /from "\.\/FileExplorer"/);
  assert.doesNotMatch(source, /<FileExplorer/);
  assert.doesNotMatch(source, /t\("files\.explorer"\)/);
});
