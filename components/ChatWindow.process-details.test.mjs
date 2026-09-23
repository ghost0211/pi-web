import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("sub-agent panes stay observational, including tabs without relation metadata", () => {
  assert.match(appShellSource, /key=\{activeFileTab\.subagentSessionId\}\s+readOnly\s+session=/);
  assert.match(source, /const isReadOnlySubagent = readOnly \|\| session\?\.relation\?\.kind === "subagent"/);
  assert.match(source, /const readOnlyNotice = \([\s\S]*?data-subagent-read-only="true"/);
  assert.match(source, /isReadOnlySubagent \? readOnlyNotice : \([\s\S]*?\{chatInputElement\}/);
  assert.match(source, /onFork=\{isReadOnlySubagent \|\| sessionBusy \|\| isNew \? undefined : handleFork\}/);
  assert.match(source, /if \(!isReadOnlySubagent\) registerAbortHandler/);
});

test("expands process details when a completed turn has no final answer", () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(defaultExpanded\)/);
  assert.match(
    source,
    /<ProcessDetailsGroup[\s\S]*?defaultExpanded=\{!finalAnswerMessage\}/,
  );
});
