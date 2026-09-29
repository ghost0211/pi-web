import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { extractAssistantSnippet, plainNotificationText } = await jiti.import("./notification-text.ts");

test("plainNotificationText flattens markdown into one line", () => {
  const raw = "结果如下：\n\n```js\nconst a = 1;\n```\n\n- 修复了 [链接](https://example.com) 的 `bug`\n> 引用\n## 标题";
  const flat = plainNotificationText(raw);
  assert.equal(flat.includes("```"), false);
  assert.equal(flat.includes("https://example.com"), false);
  assert.equal(flat.includes("链接"), true);
  assert.equal(flat.includes("\n"), false);
});

test("plainNotificationText truncates long text with an ellipsis", () => {
  const long = "词 ".repeat(200);
  const flat = plainNotificationText(long, 80);
  assert.ok(flat.length <= 81);
  assert.ok(flat.endsWith("…"));
});

test("extractAssistantSnippet returns the latest assistant text", () => {
  const messages = [
    { role: "user", content: "改一下通知" },
    { role: "assistant", content: [{ type: "text", text: "第一条回复" }], model: "m", provider: "p" },
    { role: "user", content: "继续" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "…" },
        { type: "text", text: "最终结论：已完成。" },
      ],
      model: "m",
      provider: "p",
    },
  ];
  assert.equal(extractAssistantSnippet(messages), "最终结论：已完成。");
});

test("extractAssistantSnippet skips assistant messages without text", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "有文本" }], model: "m", provider: "p" },
    { role: "assistant", content: [{ type: "thinking", thinking: "只有思考" }], model: "m", provider: "p" },
  ];
  assert.equal(extractAssistantSnippet(messages), "有文本");
  assert.equal(extractAssistantSnippet([]), null);
});
