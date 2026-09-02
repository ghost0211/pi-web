import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configSource = await readFile(new URL("./SessionsConfig.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("hidden project management matches sessions by stable workspace identity", () => {
  assert.match(configSource, /workspaceKeyOf\(session\) === selectedProjectKey/);
  assert.match(configSource, /workspaceKeyOf\(session\) === key/);
  assert.match(sidebarSource, /workspaceKeyOf\(session\) === projectKey/);
  assert.doesNotMatch(configSource, /session\.cwd === (selectedProjectKey|key)/);
  assert.doesNotMatch(sidebarSource, /session\.cwd === projectKey/);
});

test("hiding the active session or project closes the stale chat selection", () => {
  assert.match(sidebarSource, /handleHideSession[\s\S]*?onSessionDeleted\?\.\(sessionId\)/);
  assert.match(sidebarSource, /sessionsInProject\.some\(\(session\) => session\.id === selectedSessionId\)[\s\S]*?onSessionDeleted\?\.\(selectedSessionId\)/);
});
