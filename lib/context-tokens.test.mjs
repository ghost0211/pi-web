import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getMessageContextTokens,
  estimateMessageTokens,
  calculateActiveContextTokens,
} = await jiti.import("./context-tokens.ts");

test("getMessageContextTokens includes input, cacheRead, and cacheWrite", () => {
  // DeepSeek / Anthropic / Gemini prompt cache usage
  const cachedUsage = {
    input: 248,
    output: 547,
    cacheRead: 166912,
    cacheWrite: 0,
  };
  assert.equal(getMessageContextTokens(cachedUsage), 167160);

  // Standard OpenAI usage
  const standardUsage = {
    input: 12000,
    output: 400,
    cacheRead: 0,
    cacheWrite: 0,
  };
  assert.equal(getMessageContextTokens(standardUsage), 12000);

  // Fallback to totalTokens
  const totalOnly = {
    totalTokens: 8500,
  };
  assert.equal(getMessageContextTokens(totalOnly), 8500);

  // Fallback to 0 for empty usage
  assert.equal(getMessageContextTokens(null), 0);
  assert.equal(getMessageContextTokens({}), 0);
});

test("calculateActiveContextTokens accurately calculates active tokens with prompt caching", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Hello, please review this code" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "Here is my analysis..." }],
      usage: {
        input: 248,
        output: 547,
        cacheRead: 166912,
        cacheWrite: 0,
      },
    },
  ];

  const result = calculateActiveContextTokens(messages, 1_048_576);
  assert.equal(result.tokens, 167160);
  assert.equal(result.contextWindow, 1_048_576);
  // 167160 / 1048576 = 15.94% -> 16%
  assert.equal(result.percent, 16);
});

test("calculateActiveContextTokens handles compaction correctly without overflowing to 100%", () => {
  const messages = [
    // Pre-compaction messages (should be ignored by active context calculation)
    { role: "user", content: [{ type: "text", text: "A very long message 1" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "Old response" }],
      usage: { input: 900000, output: 50000 },
    },
    // Compaction summary
    {
      role: "custom",
      customType: "compaction",
      content: "This is a summary of the past 1M token conversation with key decisions.",
    },
    // New user turn after compaction
    { role: "user", content: [{ type: "text", text: "Now let's work on the new feature." }] },
  ];

  const result = calculateActiveContextTokens(messages, 1_048_576);
  // Only the compaction summary (~72 chars / 4 = 18 tokens) + user prompt (~35 chars / 4 = 9 tokens) = ~27 tokens
  assert.ok(result.tokens < 200, `Expected tokens < 200 after compaction, got ${result.tokens}`);
  assert.equal(result.percent, 0);
});

test("estimateMessageTokens estimates tokens by chars heuristic", () => {
  const userMsg = { role: "user", content: "Hello world" };
  assert.equal(estimateMessageTokens(userMsg), 3);
});

test("post-compaction estimation ignores retained assistants' pre-compaction cache usage", () => {
  const rebuiltContext = [
    { role: "system", content: "S".repeat(40), sections: { instructions: "I".repeat(40) } },
    { role: "compactionSummary", summary: "C".repeat(80), tokensBefore: 950000 },
    { role: "user", content: "U".repeat(40) },
    {
      role: "assistant",
      content: [{ type: "text", text: "A".repeat(40) }],
      usage: { input: 248, cacheRead: 900000, cacheWrite: 50000, output: 10 },
    },
    { role: "toolResult", content: [{ type: "text", text: "T".repeat(40) }] },
  ];

  const result = calculateActiveContextTokens(rebuiltContext, 1000, { estimateOnly: true });
  assert.deepEqual(result, { tokens: 70, contextWindow: 1000, percent: 7 });
  // Once a new response supplies usage, the ordinary path still trusts it.
  rebuiltContext.push({ role: "assistant", content: [], usage: { input: 100, cacheRead: 50 } });
  assert.equal(calculateActiveContextTokens(rebuiltContext, 1000).tokens, 150);
});

test("estimate-only mode works with a real SDK compaction projection before the next response", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: "user", content: "old".repeat(10000), timestamp: 1 });
  const keptId = manager.appendMessage({ role: "user", content: "U".repeat(40), timestamp: 2 });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "A".repeat(40) }], timestamp: 3,
    usage: { input: 248, output: 10, cacheRead: 900000, cacheWrite: 50000, totalTokens: 950258 },
    stopReason: "stop", api: "openai-responses", provider: "test", model: "test",
  });
  manager.appendCompaction("C".repeat(80), keptId, 950000);
  const { messages } = manager.buildSessionContext();
  assert.ok(messages.some((message) => message.role === "compactionSummary"));
  const result = calculateActiveContextTokens(messages, 1000, { estimateOnly: true });
  assert.deepEqual(result, { tokens: 40, contextWindow: 1000, percent: 4 });
  assert.deepEqual(calculateActiveContextTokens(messages, 1000), result);
});

test("normalized SDK context never trusts old usage moved after the summary", () => {
  const messages = [
    { role: "custom", customType: "compaction", content: "S".repeat(40), timestamp: 100 },
    { role: "assistant", content: [{ type: "text", text: "A".repeat(40) }], usage: { input: 900000 }, timestamp: 50 },
  ];
  assert.equal(calculateActiveContextTokens(messages, 1000).tokens, 20);
  messages.push({ role: "assistant", content: [], usage: { input: 60, cacheRead: 40 }, timestamp: 101 });
  assert.equal(calculateActiveContextTokens(messages, 1000).tokens, 100);
});

test("estimation includes SDK summaries, system tools and context-visible bash only", () => {
  assert.equal(estimateMessageTokens({ role: "branchSummary", summary: "B".repeat(40) }), 10);
  assert.equal(estimateMessageTokens({ role: "compactionSummary", summary: "C".repeat(80) }), 20);
  assert.equal(estimateMessageTokens({ role: "system", content: [], toolsAdded: [{ name: "read" }] }), 5);
  const bash = { role: "bashExecution", command: "abcd", output: "O".repeat(40) };
  assert.equal(estimateMessageTokens(bash), 11);
  assert.equal(estimateMessageTokens({ ...bash, excludeFromContext: true }), 0);
  assert.ok(estimateMessageTokens({ role: "assistant", content: [{ type: "toolCall", input: { path: "file.ts" } }] }) > 0);
});

test("estimate-only mode preserves the normalized history compaction boundary", () => {
  const messages = [
    { role: "user", content: "old".repeat(10000) },
    { role: "custom", customType: "compaction", content: "S".repeat(40) },
    { role: "assistant", content: [{ type: "text", text: "A".repeat(40) }], usage: { input: 900000 } },
  ];
  assert.equal(calculateActiveContextTokens(messages, 1000, { estimateOnly: true }).tokens, 20);
});

test("calculateActiveContextTokens adds trailing messages after assistant response", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "Executing tool" }],
      usage: { input: 10000, output: 50 },
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      content: [{ type: "text", text: "A".repeat(400) }], // 400 chars = 100 tokens
    },
  ];

  const result = calculateActiveContextTokens(messages, 100_000);
  assert.equal(result.tokens, 10000 + 100);
  assert.equal(result.percent, 10);
});
