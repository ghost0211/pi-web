import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("reserves mobile header space for the session name at every phone width", () => {
  assert.match(source, /data-mobile-session-title="true"/);
  assert.match(source, /selectedSession\?\.name \|\| selectedSession\?\.firstMessage \|\| translate\("sidebar\.newSession"\)/);
  assert.doesNotMatch(source, /isNarrowMobile/);
  assert.match(css, /\.mobile-chat-title \{[\s\S]*?flex: 1;[\s\S]*?min-width: 0;[\s\S]*?text-overflow: ellipsis/);
});

test("uses a labelled multi-row grid rather than squeezing action icons across the header", () => {
  assert.match(source, /data-mobile-toolbar="true"[\s\S]*?flex: 1,[\s\S]*?minWidth: 0/);
  assert.match(source, /data-mobile-toolbar-actions="true"\s*className="mobile-toolbar-actions-panel"/);
  assert.match(css, /\.mobile-toolbar-actions-panel \{[\s\S]*?top: calc\(100% \+ 6px\)/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 360px\)[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.equal((source.match(/mobile-toolbar-action-label/g) ?? []).length, 9);
  assert.match(css, /width: 44px !important;[\s\S]*?height: 44px !important/);

  for (const action of ["history", "name", "agents", "branches", "system", "tools", "theme", "language"]) {
    assert.match(source, new RegExp(`data-mobile-toolbar-action=(?:\\{mobile \\? )?"${action}"`));
  }
});

test("only renders the Agents switcher when the active session family has subagents", () => {
  assert.match(source, /const hasSubagentSessions = Boolean\(activeSessionFamily\?\.subagents\.length\)/);
  assert.match(source, /\{hasSubagentSessions && \(\s*<button[\s\S]*?toggleTopPanel\("agents", mobile\)/);
  assert.match(source, /activeTopPanel === "agents" && activeSessionFamily && selectedSession/);
});

test("opens subagents in the right panel while keeping the main session in the center", () => {
  assert.match(source, /const AGENT_PANEL_WIDTH = 420/);
  assert.match(
    source,
    /if \(activeTopPanel === "agents" \|\| activeTopPanel === "tasks"\)[\s\S]*?left: topBarRect\.left[\s\S]*?width: Math\.min\(AGENT_PANEL_WIDTH, topBarRect\.width\)/,
  );
  assert.match(
    source,
    /const handleAgentSessionSelect = useCallback[\s\S]*?session\.relation\?\.kind === "subagent"[\s\S]*?openSubagentSessionTab\(session\)[\s\S]*?handleSelectSession\(session\)/,
  );
  assert.match(source, /<AgentSessionPanel[\s\S]*?onSelectSession=\{handleAgentSessionSelect\}/);
  assert.match(source, /subagentSession: info/);
  assert.match(source, /session=\{activeFileTab\.subagentSession \?\?/);
  assert.match(source, /subagentSessions=\{activeSessionFamily\?\.subagents \?\? \[\]\}/);
  assert.match(source, /runningSessionIds=\{runningSessionIds\}/);
});

test("renders branch toolbar controls whenever a session tree exists", () => {
  // The branch panel is reachable for any session with a tree: branched
  // sessions get navigation, linear sessions get search and bookmarks.
  assert.match(source, /\{branchTree\.length > 0 && \(mobile \? \(/);
  assert.match(source, /\{isMobile && branchTree\.length > 0 && \(/);
  assert.match(source, /panel === "branches" \? null : panel/);
});

test("never covers the statistics or file controls with the mobile grid", () => {
  assert.doesNotMatch(source, /const covered/);
  assert.match(source, /data-mobile-toolbar-stats="true"[\s\S]*?setMobileToolbarMoreOpen\(false\); toggleTopPanel\("session"\)/);
  assert.match(source, /data-mobile-toolbar-file=\{mobile \? "true" : undefined\}/);
});

test("closes the mobile action layer on outside click, Escape, layout changes, and session changes", () => {
  assert.match(source, /event\.composedPath\(\)\.includes\(toolbar\)/);
  assert.match(source, /document\.addEventListener\("pointerdown", handlePointerDown, true\)/);
  assert.match(source, /event\.key !== "Escape"[\s\S]*?setMobileToolbarMoreOpen\(false\)/);
  assert.match(source, /mobileToolbarMoreRef\.current\?\.focus\(\)/);
  assert.match(source, /\[data-mobile-toolbar-actions\] button:not\(:disabled\)/);
  assert.match(source, /\}, \[isMobile, selectedSession\?\.id, newSessionDraftId\]\);/);
});

test("replaces the mobile action grid when an action opens a secondary panel", () => {
  const toggleTopPanel = source.match(/const toggleTopPanel = useCallback\([\s\S]*?\n  \}, \[isMobile\]\);/)?.[0];
  const themeHandler = source.match(/const renderThemeButton =[\s\S]*?onClick=\{\(event\) => \{[\s\S]*?toggleTheme\([\s\S]*?\n      \}\}/)?.[0];
  const historyHandler = source.match(/onClick=\{\(\) => \{[\s\S]*?handleViewFullHistory\(\);[\s\S]*?\n          \}\}/)?.[0];
  const autoNameHandler = source.match(/onClick=\{\(\) => \{[\s\S]*?void handleAutoName\(\);[\s\S]*?\n              \}\}/)?.[0];

  for (const handler of [toggleTopPanel, themeHandler, historyHandler, autoNameHandler]) {
    assert.ok(handler);
    assert.match(handler, /setMobileToolbarMoreOpen\(false\)/);
    assert.doesNotMatch(handler, /setMobileToolbarMoreOpen\(true\)/);
  }

  assert.match(source, /toggleTopPanel\("branches", true\)/);
  assert.match(source, /handleSystemInfoToggle\("system", mobile\)/);
  assert.match(source, /handleSystemInfoToggle\("tools", mobile\)/);
  assert.match(source, /toggleTopPanel\("language", mobile\)/);
  assert.match(source, /onClick=\{\(\) => toggleTopPanel\("session"\)\}/);
});

test("folds lifetime usage into an icon and keeps the context warning accessible", () => {
  assert.doesNotMatch(source, /mobile-session-stat-io|mobile-session-stat-cost/);
  assert.match(source, /contextUsage\?\.percent != null && contextUsage\.percent > 70 && <span className="mobile-context-alert"/);
  assert.match(source, /if \(percent !== null && percent > 90\) contextColor = "#ef4444"/);
  assert.match(source, /aria-label=\{`\$\{translate\("session.title"\)\}[\s\S]*?contextUsage\.percent\.toFixed\(0\)/);
});

test("places trust warnings below the mobile toolbar and the file toggle in toolbar flow", () => {
  assert.match(source, /\{isMobile && renderProjectTrustWarning\(true\)\}/);
  assert.match(source, /data-mobile-trust-banner=\{mobileBanner \? "true" : undefined\}/);
  assert.doesNotMatch(source, /File panel toggle — always visible at top-right/);
  assert.doesNotMatch(source, /position: "fixed", top: "env\(safe-area-inset-top\)"/);
});
