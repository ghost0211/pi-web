import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { componentHarness } from "./mcp-test-harness.mjs";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  MessageView,
  getTokenEstimateText,
  getToolCallInputText,
  replaceUserMessageText,
} = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("renders persisted tool execution milliseconds instead of timestamp wall time in history", () => {
  const toolCall = { type: "toolCall", toolCallId: "timed-call", toolName: "read", input: {} };
  const result = {
    role: "toolResult",
    toolCallId: toolCall.toolCallId,
    content: [{ type: "text", text: "file contents" }],
    timestamp: 101_000,
    durationMs: 1_234,
  };
  const html = renderMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    timestamp: 1_000,
    content: [toolCall],
  }, { toolResults: new Map([[toolCall.toolCallId, result]]) });

  assert.match(html, /1\.234s/);
  assert.doesNotMatch(html, /100s/);
  assert.equal(renderMessage(result), "", "tool results remain inline under their call");
});

test("shows an actual zero-millisecond tool duration", () => {
  const toolCall = { type: "toolCall", toolCallId: "zero-call", toolName: "read", input: {} };
  const result = {
    role: "toolResult",
    toolCallId: toolCall.toolCallId,
    content: [],
    timestamp: 20_000,
    durationMs: 0,
  };
  const html = renderMessage({
    role: "assistant", provider: "test", model: "test-model", timestamp: 1_000, content: [toolCall],
  }, { toolResults: new Map([[toolCall.toolCallId, result]]) });

  assert.match(html, /0s/);
  assert.doesNotMatch(html, /≈/);
});

test("marks the legacy timestamp duration fallback as approximate", () => {
  const toolCall = { type: "toolCall", toolCallId: "legacy-call", toolName: "read", input: {} };
  const result = {
    role: "toolResult",
    toolCallId: toolCall.toolCallId,
    content: [],
    timestamp: 3_800,
  };
  const html = renderMessage({
    role: "assistant", provider: "test", model: "test-model", timestamp: 1_000, content: [toolCall],
  }, { toolResults: new Map([[toolCall.toolCallId, result]]) });

  assert.match(html, /≈3s/);
});

test("expands Codemode image output as preview media, never base64 plaintext", () => {
  const result = { role: "toolResult", toolCallId: "image-call", toolName: "codemode",
    content: [{ type: "text", text: "Generated locally" }, { type: "image", data: "YWJj", mimeType: "image/png" }],
    usage: { totalTokens: 7, cost: { total: 0.03 } }, isError: false };
  const harness = componentHarness((props) => React.createElement(MessageView, props), {
    message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "image-call", toolName: "codemode", input: { code: "image(block)" } }] },
    toolResults: new Map([["image-call", result]]),
  });
  try {
    harness.render();
    assert.equal(harness.find((node) => node.type === "img"), undefined);
    harness.find((node) => node.props.onClick && node.props.style?.cursor === "pointer").props.onClick();
    harness.render();
    assert.equal(harness.find((node) => node.type === "img").props.src, "data:image/png;base64,YWJj");
    assert.ok(harness.find((node) => node.type === "button" && node.props["aria-label"] === "chat.previewImage"));
    assert.doesNotMatch(harness.text(), /YWJj/);
  } finally { harness.cleanup(); }
});

test("renders compaction summaries collapsed by default", () => {
  const html = renderMessage({
    role: "custom",
    customType: "compaction",
    content: "Detailed compacted context",
    display: true,
    timestamp: Date.now(),
  });

  assert.match(html, /<details[^>]*class="[^"]*compaction-message-details[^"]*"/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.match(html, /<summary/);
  assert.match(html, /Detailed compacted context/);
});

test("keeps streamed tool input out of collapsed markup while counting it", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-write-1",
    toolName: "write",
    input: {},
    rawInput: '{"path":"/tmp/file","content":"secret-stream-fragment',
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { isStreaming: true });

  assert.match(html, /write/);
  assert.match(html, /Generating parameters/);
  assert.doesNotMatch(html, /secret-stream-fragment/);
  assert.equal(getToolCallInputText(block), block.rawInput);
  assert.equal(getTokenEstimateText(block), block.rawInput);
});

test("renders subagents as standard tool calls with only an extra session button", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-agent-1",
    toolName: "Agent",
    input: {
      subagent_type: "Explore",
      prompt: "Find the parser",
      description: "Find parser",
    },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "Parser is in lib/parser.ts" }],
    details: {
      kind: "pi-web-subagent",
      sessionId: "child-session",
      profile: "Explore",
      description: "Find parser",
      status: "completed",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, {
    toolResults: new Map([[block.toolCallId, result]]),
    onOpenSession() {},
  });

  assert.match(html, /border:1px solid rgba\(34,197,94,0\.25\)/);
  assert.match(html, />Agent</);
  assert.match(html, />Explore</);
  assert.match(html, /aria-label="Open sub-agent session"/);
  assert.doesNotMatch(html, />completed</);
  assert.doesNotMatch(html, />Find parser</);

  const ordinaryHtml = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ ...block, toolCallId: "call-extension-1", toolName: "extension_tool" }],
  }, {
    toolResults: new Map(),
    onOpenSession() {},
  });
  assert.doesNotMatch(ordinaryHtml, /Open sub-agent session/);
});

const COMPLETE_SKILL_EXPANSION = `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Review the supplied files.
</skill>

src/main.ts`;

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("renders a complete SDK skill expansion as a compact command", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION,
  });

  assert.match(html, /\/skill:review/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Review the supplied files/);
});

test("does not collapse incomplete skill-looking user text", () => {
  const html = renderMessage({
    role: "user",
    content: '<skill name="review" location="/skills/review/SKILL.md">\nordinary user text',
  });

  assert.match(html, /ordinary user text/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("keeps attached images when restoring a compact command for editing", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const restored = replaceUserMessageText({
    role: "user",
    content: [{ type: "text", text: COMPLETE_SKILL_EXPANSION }, image],
  }, "/skill:review src/main.ts");

  assert.deepEqual(restored.content, [
    { type: "text", text: "/skill:review src/main.ts" },
    image,
  ]);
});

test("renders attached images outside the text bubble as uniform thumbnails", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /<div class="user-message-images">/);
  assert.equal((html.match(/user-message-image-button/g) ?? []).length, 2);
  assert.equal((html.match(/user-message-image/g) ?? []).length >= 2, true);
  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"[^>]+class="user-message-image"/);
  assert.match(html, /<img[^>]+src="data:image\/jpeg;base64,QUJD"[^>]+class="user-message-image"/);
  assert.ok(html.indexOf("user-message-images") < html.indexOf("inspect this"), "gallery renders above the text bubble");
  assert.ok(html.indexOf("data:image/png") < html.indexOf("background:var(--user-bg)"), "image data is outside the text bubble");
});

test("renders image-only user messages without an empty text bubble", () => {
  const html = renderMessage({
    role: "user",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: Date.now(),
  });

  assert.match(html, /user-message-images/);
  assert.match(html, /data:image\/png;base64,YWJj/);
  assert.doesNotMatch(html, /markdown-user-message/);
  assert.doesNotMatch(html, /background:var\(--user-bg\)/);
});

test("keeps skill command text inside the bubble while its attachments stay outside", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: COMPLETE_SKILL_EXPANSION },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
  });

  assert.match(html, /user-message-images/);
  assert.match(html, /\/skill:review/);
  assert.match(html, /aria-expanded="false"/);
  assert.ok(html.indexOf("user-message-images") < html.indexOf("/skill:review"));
});

test("defines same-size responsive attached-image thumbnails", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.user-message-images \{[\s\S]*?justify-content: flex-end;[\s\S]*?max-width: 85%;/);
  assert.match(css, /\.user-message-image-button \{[\s\S]*?width: 160px;[\s\S]*?height: 108px;[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.user-message-image \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?object-fit: cover;/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*?\.user-message-image-button \{[\s\S]*?width: 112px;[\s\S]*?height: 80px;/);
});

test("marks apply_patch returned failures as errors even when isError is unset", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-patch-1",
    toolName: "apply_patch",
    input: {
      input: "*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new\n*** End Patch",
    },
  };
  const failed = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "apply_patch failed.\nRecovery: MUST read src/a.ts before retrying." }],
    details: {
      result: { appliedFiles: [], failures: [{ filePath: "src/a.ts", message: "context mismatch" }] },
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [block],
  }, { toolResults: new Map([[block.toolCallId, failed]]) });

  assert.match(html, /border:1px solid rgba\(248,113,113,0\.45\)/);
  assert.match(html, />apply_patch</);
  assert.doesNotMatch(html, /border:1px solid rgba\(34,197,94,0\.25\)/);
});

test("renders custom-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "custom",
    customType: "extension",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="Preview image"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("threads sessionId through TextBlock and SafeMarkdownBody to MarkdownBody for local images", () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const assistantHtml = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Look at the generated image: ![chart](/tmp/pi-codemode-output.png)" }],
  }, { sessionId });

  assert.match(
    assistantHtml,
    new RegExp(`<img(?=[^>]*src="\\/api\\/files\\/tmp\\/pi-codemode-output\\.png\\?type=read&amp;sessionId=${sessionId}")[^>]*>`),
  );

  const withoutSessionHtml = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Look at the generated image: ![chart](/tmp/pi-codemode-output.png)" }],
  });

  assert.match(
    withoutSessionHtml,
    /<img(?=[^>]*src="\/api\/files\/tmp\/pi-codemode-output\.png\?type=read")[^>]*>/,
  );
  assert.doesNotMatch(withoutSessionHtml, /sessionId=/);
});

test("threads sessionId to user message markdown bodies", () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const userHtml = renderMessage({
    role: "user",
    content: "Here is an image: ![user photo](/tmp/user-photo.png)",
    timestamp: Date.now(),
  }, { sessionId });

  assert.match(
    userHtml,
    new RegExp(`<img(?=[^>]*src="\\/api\\/files\\/tmp\\/user-photo\\.png\\?type=read&amp;sessionId=${sessionId}")[^>]*>`),
  );
});

test("leaves remote image URLs unproxied in MessageView assistant text", () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const remoteHtml = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Remote: ![pic](https://example.com/pic.png)" }],
  }, { sessionId });

  assert.match(remoteHtml, /<img(?=[^>]*src="https:\/\/example\.com\/pic\.png")[^>]*>/);
  assert.doesNotMatch(remoteHtml, /\/api\/files/);
  assert.doesNotMatch(remoteHtml, /sessionId=/);
});
