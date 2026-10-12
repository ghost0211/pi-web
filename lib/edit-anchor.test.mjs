// "Edit from here" truncates the branch to a user message's parent entry.
// Anchoring on the previous *assistant* message hid the action whenever a
// transcript system message (never rendered), a compaction card, a sub-agent
// report or a bash execution sat between the previous answer and the prompt.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, interopDefault: true });
const { resolveEditAnchorEntryId } = await jiti.import("./edit-anchor.ts");

const assistant = (id) => ({ role: "assistant", id });
const user = (id) => ({ role: "user", id });
const system = (id) => ({ role: "system", id });
const card = (id) => ({ role: "custom", id });

test("anchors on the previous assistant entry", () => {
  const messages = [assistant("a1"), user("u1"), assistant("a2"), user("u2")];
  const entryIds = ["e-a1", "e-u1", "e-a2", "e-u2"];
  assert.equal(resolveEditAnchorEntryId(messages, entryIds, 1), "e-a1");
  assert.equal(resolveEditAnchorEntryId(messages, entryIds, 3), "e-a2");
});

test("anchors on non-assistant slots that still own the parent position", () => {
  // Transcript system messages render nothing but still occupy a slot; the
  // prompt's parent is that entry, so it must be the navigation target.
  assert.equal(
    resolveEditAnchorEntryId([assistant("a1"), system("s1"), user("u1")], ["e-a1", "e-s1", "e-u1"], 2),
    "e-s1",
  );
  // Compaction summaries, sub-agent reports and bash executions render as
  // cards between the previous answer and the prompt.
  for (const view of [card("c1"), { role: "bashExecution", id: "b1" }]) {
    assert.equal(
      resolveEditAnchorEntryId([assistant("a1"), view, user("u1")], ["e-a1", "e-card", "e-u1"], 2),
      "e-card",
    );
  }
});

test("skips slots the client appended before the server assigned an entry", () => {
  const messages = [assistant("a1"), user("u1"), { role: "assistant" }, user("u2")];
  const entryIds = ["e-a1", "e-u1", undefined, undefined];
  // The live reply above u2 has no id yet; u1 is a user prompt, so walking past
  // it would truncate a turn the user never asked to remove.
  assert.equal(resolveEditAnchorEntryId(messages, entryIds, 3), undefined);
  assert.equal(resolveEditAnchorEntryId(messages, entryIds, 1), "e-a1");
});

test("stops at an earlier prompt and ignores non-user messages", () => {
  const messages = [system("s1"), user("u1"), card("c1"), user("u2")];
  const entryIds = ["e-s1", "e-u1", "e-c1", "e-u2"];
  assert.equal(resolveEditAnchorEntryId(messages, entryIds, 3), "e-c1");
  assert.equal(resolveEditAnchorEntryId([card("c1"), user("u1")], [undefined, "e-u1"], 1), undefined);
  assert.equal(resolveEditAnchorEntryId(messages, entryIds, 0), undefined, "only user prompts can be edited");
  assert.equal(resolveEditAnchorEntryId([], [], 0), undefined);
});

test("uses the window's parent entry only for the very first message", () => {
  assert.equal(
    resolveEditAnchorEntryId([user("u1"), assistant("a1")], ["e-u1", "e-a1"], 0, { firstEntryParentId: "e-root" }),
    "e-root",
  );
  assert.equal(
    resolveEditAnchorEntryId([user("u1")], ["e-u1"], 0, { hasEarlierMessages: true, firstEntryParentId: "e-root" }),
    undefined,
    "a window that starts mid-branch keeps its parent for suffix alignment only",
  );
  assert.equal(resolveEditAnchorEntryId([user("u1")], ["e-u1"], 0, { firstEntryParentId: null }), undefined);
});

test("ChatWindow renders the resolved anchor instead of the previous-assistant guess", async () => {
  const windowSource = (await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const viewSource = (await readFile(new URL("../components/MessageView.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(windowSource, /const editAnchorEntryId = resolveEditAnchorEntryId\(messages, entryIds, idx, \{/);
  assert.match(windowSource, /editAnchorEntryId=\{isReadOnlyConversation \|\| sessionBusy \? undefined : editAnchorEntryId\}/);
  assert.match(viewSource, /const canNavigate = !!editAnchorEntryId && !!onNavigate;/);
  assert.match(viewSource, /onNavigate!\(editAnchorEntryId!\)/);
  assert.doesNotMatch(windowSource, /messages\[idx - 1\]\.role === "assistant"/);
});
