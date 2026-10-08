import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

function hookOptions() {
  const start = source.indexOf("useAgentSession({");
  assert.notEqual(start, -1, "useAgentSession options not found");
  const end = source.indexOf("\n  });", start);
  assert.notEqual(end, -1, "useAgentSession options end not found");
  return source.slice(start, end);
}

test("archived sessions expose the parent-owned restore controls without changing subagent mode", () => {
  assert.match(source, /archived\?: boolean;/);
  assert.match(source, /archivedRestoring\?: boolean;/);
  assert.match(source, /onRestoreArchived\?: \(\) => void;/);
  assert.match(source, /t\("sessionSidebar\.archivedReadOnly"\)/);
  assert.match(source, /t\("sessionSidebar\.restoreContinue"\)/);
  assert.match(source, /onClick=\{onRestoreArchived\} disabled=\{archivedRestoring \|\| !onRestoreArchived\}/);
  assert.match(source, /sessionBusy && !isReadOnlySubagent && \([\s\S]*?onClick=\{handleAbort\}[\s\S]*?t\("chat\.stopAgent"\)/);
  assert.match(source, /const isReadOnlySubagent = readOnly \|\| session\?\.relation\?\.kind === "subagent";/);
  assert.match(source, /const isReadOnlyConversation = isReadOnlySubagent \|\| archived \|\| managementPending;/);
});

test("archived UI unmounts the composer but guards late sends and preserves the session draft key", () => {
  assert.match(source, /const handleConversationSend = useCallback\(async \(\.\.\.args: Parameters<typeof handleSend>\) => \{\s*if \(isReadOnlyConversationRef\.current\) return;\s*await handleSend\(\.\.\.args\);/);
  assert.match(source, /ref=\{chatInputRef\}[\s\S]*?onSend=\{handleConversationSend\}/);
  assert.match(source, /draftKey=\{session\?\.id \?\? newSessionDraftKey \?\? undefined\}/);
  assert.match(source, /archived \? archivedReadOnlyNotice : isReadOnlySubagent \? readOnlyNotice : chatInputElement/);
  assert.match(source, /archived \? archivedReadOnlyNotice : isReadOnlySubagent \? readOnlyNotice : \([\s\S]*?\{chatInputElement\}/);
});

test("archived conversations disable sends, drops, fork, edit, and branch navigation", () => {
  assert.match(source, /onDragEnter=\{isReadOnlyConversation \? undefined : handleDragEnter\}/);
  assert.match(source, /if \(!isReadOnlyConversationRef\.current\) chatInputRef\?\.current\?\.addFiles\(files\)/);
  assert.match(source, /onFork=\{isReadOnlyConversation \|\| sessionBusy \|\| isNew \? undefined : handleConversationFork\}/);
  assert.match(source, /onNavigate=\{isReadOnlyConversation \|\| sessionBusy \? undefined : handleConversationNavigate\}/);
  assert.match(source, /prevAssistantEntryId=\{isReadOnlyConversation \|\| sessionBusy \? undefined : prevAssistantEntryId\}/);
  assert.match(source, /onEditContent=\{isReadOnlyConversation \? undefined : handleEditContent\}/);
});

test("archived subagent views do not acquire stop or restore-and-send controls", () => {
  assert.match(source, /sessionBusy && !isReadOnlySubagent && \(/);
  assert.match(source, /!isReadOnlySubagent && \([\s\S]*?onClick=\{onRestoreArchived\}/);
});

test("metadata loading cannot briefly expose a composer before legacy migration completes", () => {
  assert.match(source, /managementPending\?: boolean;/);
  assert.match(source, /data-session-status-pending="true"/);
  assert.match(source, /managementPending \? managementPendingNotice : archived \? archivedReadOnlyNotice/);
  assert.match(source, /t\("sessionSidebar\.checkingStatus"\)/);
});

test("archived live sessions keep notification, Escape-abort, reconciliation, and extension-response behavior", () => {
  assert.match(source, /const completionNotificationsEnabled = !isReadOnlySubagent;/);
  assert.match(source, /if \(!isReadOnlySubagent\) registerAbortHandler\(sessionBusy \? handleAbort : null\)/);
  assert.match(source, /!isReadOnlySubagent && extensionDialog/);
  assert.match(source, /!isReadOnlySubagent && extensionCustomUi/);
  assert.doesNotMatch(hookOptions(), /\barchived\b|\breadOnly\s*:/);
});
