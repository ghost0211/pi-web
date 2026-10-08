import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { formatToolExecutionDuration, getToolExecutionDuration } = await jiti.import("./tool-duration.ts");
const { normalizeToolCalls, normalizeStreamingToolCalls } = await jiti.import("./normalize.ts");
const { buildSessionHistory } = await jiti.import("./session-reader.ts");

test("uses finite nonnegative SDK durationMs values, including zero", () => {
  assert.deepEqual(getToolExecutionDuration({ durationMs: 1_234, timestamp: 100_000 }, 1_000), {
    seconds: 1.234,
    approximate: false,
  });
  assert.deepEqual(getToolExecutionDuration({ durationMs: 0, timestamp: 100_000 }, 1_000), {
    seconds: 0,
    approximate: false,
  });
  assert.equal(formatToolExecutionDuration({ seconds: 1.234, approximate: false }), "1.234s");
  assert.equal(formatToolExecutionDuration({ seconds: 0, approximate: false }), "0s");
});

test("uses the rounded legacy timestamp fallback only when durationMs is absent or invalid", () => {
  const expected = { seconds: 3, approximate: true };
  assert.deepEqual(getToolExecutionDuration({ timestamp: 3_800 }, 1_000), expected);
  for (const durationMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, "1000", null]) {
    assert.deepEqual(getToolExecutionDuration({ durationMs, timestamp: 3_800 }, 1_000), expected);
  }
});

test("omits unavailable or nonpositive legacy timestamp estimates", () => {
  assert.equal(getToolExecutionDuration(undefined, 1_000), undefined);
  assert.equal(getToolExecutionDuration({ timestamp: 1_000 }, 1_000), undefined);
  assert.equal(getToolExecutionDuration({ timestamp: 900 }, 1_000), undefined);
  assert.equal(getToolExecutionDuration({ timestamp: Number.POSITIVE_INFINITY }, 1_000), undefined);
  assert.equal(getToolExecutionDuration({ timestamp: 2_000 }), undefined);
});

test("final results retain recorded duration through streaming normalization and history image deferral", () => {
  for (const durationMs of [0, 1_234]) {
    const message = {
      role: "toolResult",
      toolCallId: "timed-image-call",
      toolName: "codemode",
      content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
      isError: false,
      timestamp: 101_000,
      durationMs,
    };
    assert.equal(normalizeToolCalls(message).durationMs, durationMs);
    assert.equal(normalizeStreamingToolCalls(message).durationMs, durationMs);
    const history = buildSessionHistory([{
      type: "message", id: "timed-result", parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z", message,
    }], undefined, { sessionId: "duration-fixture", deferToolResultImages: true });
    assert.equal(history.messages[0].durationMs, durationMs);
    assert.match(history.messages[0].content[0].source.url, /tool-result-image\?blockIndex=0$/);
    assert.equal(getToolExecutionDuration(history.messages[0], 1_000).approximate, false);
  }
});
