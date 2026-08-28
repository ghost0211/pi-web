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
