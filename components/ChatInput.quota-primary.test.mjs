import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

for (const busy of [true, false]) {
  test(`${busy ? "temporary backup execution" : "completed backup run"} keeps primary GPT/xhigh controls and distinct context limits`, () => {
    const model = { provider: "fixture", modelId: "gpt-sol" };
    const backup = { provider: "fixture", modelId: "deepseek", thinkingLevel: "low" };
    const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onModelChange() {}, onThinkingLevelChange() {}, onFallbackModelChange() {}, onFallbackThinkingLevelChange() {},
      isStreaming: busy, model, contextModel: busy ? backup : model, fallbackModel: backup,
      modelList: [{ provider: "fixture", id: "gpt-sol", name: "GPT-6.1 Sol", contextWindow: 1000000 }, { provider: "fixture", id: "deepseek", name: "deepseek-v4.1-flash", contextWindow: 100000 }],
      thinkingLevel: "xhigh", availableThinkingLevels: ["high", "xhigh"],
      fallbackThinkingLevel: "low", fallbackAvailableThinkingLevels: ["low", "high"],
      contextUsage: { tokens: 50000, contextWindow: busy ? 100000 : 1000000, percent: busy ? 50 : 5 },
    })));
    assert.match(html, /GPT-6\.1 Sol/);
    assert.match(html, /Thinking: xhigh/);
    assert.equal((html.match(/data-thinking-selector="combined"/g) ?? []).length, 1);
    assert.match(html, new RegExp(`aria-valuenow="${busy ? 50 : 5}"`));
    if (!busy) assert.match(html, /title="Change model"/);
  });
}
