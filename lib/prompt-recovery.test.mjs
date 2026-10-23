import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { userMessageKey, mergeDeliveredUserMessage, mergeSnapshotWithDeliveredUserMessages } = await createJiti(import.meta.url).import("./prompt-recovery.ts");

function textMessage(content) {
  return { role: "user", content, timestamp: 1 };
}

test("builds stable keys for matching optimistic text messages", () => {
  assert.equal(userMessageKey(textMessage("repeat this")), userMessageKey(textMessage("repeat this")));
  assert.notEqual(userMessageKey(textMessage("first")), userMessageKey(textMessage("second")));
});

test("reconciles a persisted prompt with its late SSE completion without duplicating it", () => {
  const delivered = { role: "user", content: "same prompt", timestamp: 1002 };
  const persisted = [{ role: "user", content: "same prompt", timestamp: 1002 }];
  assert.equal(mergeDeliveredUserMessage(persisted, delivered, null), persisted);
  assert.equal(mergeDeliveredUserMessage(persisted, delivered, userMessageKey(textMessage("same prompt"))), persisted);

  const withAssistant = [...persisted, { role: "assistant", content: [], timestamp: 1003 }];
  assert.equal(mergeDeliveredUserMessage(withAssistant, delivered, null), withAssistant);
  assert.equal(mergeDeliveredUserMessage(withAssistant, delivered, userMessageKey(textMessage("same prompt"))), withAssistant);
});

test("reconciles optimistic bubbles but preserves later identical queued prompts", () => {
  const optimistic = { role: "user", content: "same prompt", timestamp: 1000 };
  const delivered = { ...optimistic, timestamp: 1002 };
  const key = userMessageKey(optimistic);
  assert.deepEqual(mergeDeliveredUserMessage([optimistic], delivered, key), [optimistic]);
  const repeated = { ...delivered, timestamp: 1010 };
  assert.deepEqual(mergeDeliveredUserMessage([delivered], repeated, null), [delivered, repeated]);
});

test("includes attached images in optimistic message keys", () => {
  const submitted = {
    role: "user",
    content: [
      { type: "text", text: "inspect" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
    timestamp: 1,
  };
  const differentImage = {
    ...submitted,
    content: [
      { type: "text", text: "inspect" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BAUG" } },
    ],
  };
  assert.notEqual(userMessageKey(submitted), userMessageKey(differentImage));
});

test("text normalization makes optimistic and persisted keys match", () => {
  assert.equal(
    userMessageKey(textMessage("paste with trailing newline\r\n")),
    userMessageKey(textMessage("paste with trailing newline")),
  );
});

test("merges the optimistic bubble even after streaming started", () => {
  const optimistic = { role: "user", content: "long prompt with image", timestamp: 1000 };
  const key = userMessageKey(optimistic);
  // The assistant started streaming before the prompt's message_end arrived.
  const streaming = {
    role: "assistant",
    content: [{ type: "text", text: "partial…" }],
    model: "m",
    provider: "p",
    timestamp: 1001,
  };
  const delivered = { ...optimistic, timestamp: 1002 };
  // Identical content: keep the optimistic bubble in place, no duplicate.
  const merged = mergeDeliveredUserMessage([optimistic, streaming], delivered, key);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], optimistic);
  assert.equal(merged[1], streaming);
  // Normalized-away differences compare equal: the bubble stays, no duplicate.
  const trimmed = { ...optimistic, content: "long prompt with image\r\n", timestamp: 1002 };
  const kept = mergeDeliveredUserMessage([optimistic, streaming], trimmed, key);
  assert.equal(kept.length, 2);
  assert.equal(kept[0], optimistic);
  // Genuinely different content replaces the bubble in place, not appends.
  const changed = { ...optimistic, content: "edited long prompt with image", timestamp: 1002 };
  const replaced = mergeDeliveredUserMessage([optimistic, streaming], changed, key);
  assert.equal(replaced.length, 2);
  assert.equal(replaced[0], changed);
  assert.equal(replaced[1], streaming);
});

test("whitespace-normalized content still dedupes by timestamp after reconcile", () => {
  const persisted = [{ role: "user", content: "same prompt", timestamp: 1002 }];
  const delivered = { role: "user", content: "same prompt\n", timestamp: 1002 };
  assert.equal(mergeDeliveredUserMessage(persisted, delivered, null).length, 1);
});

test("a follow-up delivered during a running turn survives a stale history snapshot", () => {
  // agent_end refreshes history from disk while the queued follow-up is being
  // delivered; the response can predate that entry.
  const assistant = { role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 1001 };
  const staleSnapshot = [{ role: "user", content: "first prompt", timestamp: 1000 }, assistant];
  const followUp = { role: "user", content: "queued follow-up", timestamp: 1002 };

  const merged = mergeSnapshotWithDeliveredUserMessages(staleSnapshot, [followUp]);
  assert.deepEqual(merged.messages, [...staleSnapshot, followUp]);
  assert.deepEqual(merged.pending, [followUp], "still unconfirmed, so a later refresh keeps it");
});

test("a snapshot that already contains the delivery retires it without duplicating", () => {
  const followUp = { role: "user", content: "queued follow-up", timestamp: 1002 };
  const snapshot = [{ role: "user", content: "first prompt", timestamp: 1000 }, followUp];

  const merged = mergeSnapshotWithDeliveredUserMessages(snapshot, [followUp]);
  assert.deepEqual(merged.messages, snapshot);
  assert.deepEqual(merged.pending, [], "confirmed by disk, nothing left pending");
});

test("a repeated prompt with a different timestamp is not mistaken for the pending delivery", () => {
  const pending = { role: "user", content: "run tests", timestamp: 2000 };
  const snapshot = [{ role: "user", content: "run tests", timestamp: 1000 }];
  const merged = mergeSnapshotWithDeliveredUserMessages(snapshot, [pending]);
  assert.equal(merged.messages.length, 2, "same text but a different prompt must stay visible");
  assert.equal(merged.messages[1], pending);
});

test("no pending deliveries leaves the snapshot untouched", () => {
  const snapshot = [{ role: "user", content: "prompt", timestamp: 1000 }];
  const merged = mergeSnapshotWithDeliveredUserMessages(snapshot, []);
  assert.equal(merged.messages, snapshot);
  assert.deepEqual(merged.pending, []);
});
