import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { buildChatMessageGroups, findFinalAssistantIndex, needsStreamingFollowUpLabel } = await createJiti(import.meta.url).import("./chat-message-groups.ts");
const user = (text = "Task") => ({ role: "user", content: text });
const answer = (text) => ({ role: "assistant", content: [{ type: "text", text }] });
const process = () => ({ role: "assistant", content: [{ type: "toolCall", toolCallId: "c", toolName: "read", input: {} }] });
const report = (text) => ({ role: "custom", customType: "pi-web:subagent-notification", content: text, display: true });
const compact = () => ({ role: "custom", customType: "compaction", content: "# Goal\nContinue", display: true });

function finalIndices(messages) {
  return buildChatMessageGroups(messages).map((group) => findFinalAssistantIndex(messages, group.contentStartIndex - 1, group.endIndex));
}

test("main final answer cannot be folded into a later report follow-up", () => {
  const messages = [user(), process(), answer("Main conclusion"), report("Review notes"), answer("Main supplement")];
  const original = structuredClone(messages);
  assert.deepEqual(finalIndices(messages), [2, 4]);
  const groups = buildChatMessageGroups(messages);
  assert.deepEqual(groups.map((group) => [group.kind, group.startIndex, group.endIndex, group.parentFollowUp]), [
    ["prompt", 0, 3, false], ["subagent-report", 3, 5, true],
  ]);
  assert.deepEqual(messages, original, "grouping never reorders or edits persisted messages");
});

test("concurrent reports retain delivery order and stay above the parent's combined supplement", () => {
  const messages = [user(), answer("Main"), report("B finished first"), report("A review"), process(), answer("Combined supplement")];
  const groups = buildChatMessageGroups(messages);
  assert.equal(groups[1].startIndex, 2);
  assert.equal(groups[1].contentStartIndex, 4, "both report cards are visible anchors, not process messages");
  assert.deepEqual(finalIndices(messages), [1, 5]);
  const covered = groups.flatMap((group) => Array.from({ length: group.endIndex - group.startIndex }, (_, index) => group.startIndex + index));
  assert.deepEqual(covered, [0, 1, 2, 3, 4, 5]);
});

test("separate late completions cannot replace the main answer or earlier supplements", () => {
  const messages = [user(), answer("Main"), report("A"), answer("A supplement"), report("B"), answer("B supplement"), user("Next"), answer("Next answer")];
  assert.deepEqual(finalIndices(messages), [1, 3, 5, 7]);
  assert.deepEqual(buildChatMessageGroups(messages).map((group) => group.parentFollowUp), [false, true, true, false]);
});

test("failed/empty reports remain boundaries even without details or a parent reply", () => {
  const messages = [user(), answer("Main"), report(""), user("Next")];
  const groups = buildChatMessageGroups(messages);
  assert.deepEqual(finalIndices(messages), [1, -1, -1]);
  assert.equal(groups[1].parentFollowUp, true);
  assert.equal(groups[2].parentFollowUp, false);
});

test("compaction preserves grouping and follow-up attribution without introducing a user prompt", () => {
  const messages = [user(), answer("Main"), report("Review"), process(), compact(), process(), answer("Supplement after compression")];
  assert.deepEqual(buildChatMessageGroups(messages).map((group) => [group.kind, group.parentFollowUp]), [
    ["prompt", false], ["subagent-report", true], ["compaction", true],
  ]);
  assert.deepEqual(finalIndices(messages), [1, 3, 6]);
});

test("history windows do not invent follow-up provenance for unknown prefixes or generic extensions", () => {
  const messages = [answer("Head continuation"), { role: "custom", customType: "extension-note", content: "Note", display: true }, user(), answer("Main")];
  assert.deepEqual(buildChatMessageGroups(messages).map((group) => [group.kind, group.parentFollowUp]), [["standalone", false], ["prompt", false]]);
});

test("streaming follow-up label appears once and never labels a new user reply", () => {
  const messages = [user(), answer("Main"), report("Review")];
  assert.equal(needsStreamingFollowUpLabel(messages, buildChatMessageGroups(messages).at(-1)), true);
  messages.push(process());
  assert.equal(needsStreamingFollowUpLabel(messages, buildChatMessageGroups(messages).at(-1)), false);
  messages.push(user("New task"));
  assert.equal(needsStreamingFollowUpLabel(messages, buildChatMessageGroups(messages).at(-1)), false);
  assert.equal(needsStreamingFollowUpLabel([], undefined), false);
});
