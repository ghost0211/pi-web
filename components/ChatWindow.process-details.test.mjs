import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("sub-agent panes stay observational, including tabs without relation metadata", () => {
  assert.match(appShellSource, /key=\{activeFileTab\.subagentSessionId\}\s+readOnly\s+archived=\{[^\n]+\}\s+managementPending=\{!management\.ready\}\s+session=/);
  assert.match(source, /const isReadOnlySubagent = readOnly \|\| session\?\.relation\?\.kind === "subagent"/);
  assert.match(source, /const readOnlyNotice = \([\s\S]*?data-subagent-read-only="true"/);
  assert.match(source, /archived \? archivedReadOnlyNotice : isReadOnlySubagent \? readOnlyNotice : \(\s*<>\s*\{chatInputElement\}/);
  assert.match(source, /onFork=\{isReadOnlyConversation \|\| sessionBusy \|\| isNew \? undefined : handleConversationFork\}/);
  assert.match(source, /if \(!isReadOnlySubagent\) registerAbortHandler/);
});

test("uses report boundaries so a late supplement never hides the original main answer", () => {
  assert.match(source, /const messageGroups = useMemo\(\(\) => buildChatMessageGroups\(messages\), \[messages\]\)/);
  assert.match(source, /for \(const group of messageGroups\)/);
  assert.match(source, /findFinalAssistantIndex\(messages, contentStartIndex - 1, endIdx\)/);
  assert.match(source, /for \(let anchorIdx = userIdx; anchorIdx < contentStartIndex; anchorIdx\+\+\)/);
  assert.match(source, /for \(let processIdx = contentStartIndex; processIdx < finalAssistantIdx; processIdx\+\+\)/);
  assert.match(source, /messageOverride: finalAnswerMessage, parentFollowUp: group\.parentFollowUp/);
});

test("labels parent supplements in both live and historical views without altering message content", () => {
  assert.match(source, /data-parent-follow-up="true">\{t\("subagent\.parentFollowUp"\)\}/);
  assert.match(source, /needsStreamingFollowUpLabel\(messages, messageGroups\.at\(-1\)\)/);
  assert.match(source, /group\.parentFollowUp && !labeled && messages\[renderIdx\]\.role === "assistant"/);
});

test("expands process details when a completed turn has no final answer", () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(defaultExpanded\)/);
  assert.match(
    source,
    /<ProcessDetailsGroup[\s\S]*?defaultExpanded=\{!finalAnswerMessage\}/,
  );
});
