import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { componentHarness } from "./mcp-test-harness.mjs";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ProcessDetailsGroup } = await jiti.import("./ProcessDetailsGroup.tsx");
const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");
const t = (key, params = {}) => (zhCNLocale.messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name]));

test("a completed process keeps the duration in its collapsed summary and when expanded", () => {
  const h = componentHarness(ProcessDetailsGroup, { messageCount: 37, toolCallCount: 50, durationText: "本轮耗时 4分03秒", t, children: "process content" });
  try {
    h.render();
    assert.equal(h.text(), "处理详情 · 37 条消息 · 50 次工具调用 · 本轮耗时 4分03秒");
    h.button(h.text()).props.onClick();
    h.render();
    assert.match(h.text(), /本轮耗时 4分03秒process content/);
    assert.equal(h.find(node => node.type === "button").props["aria-expanded"], true);
  } finally { h.cleanup(); }
});

test("a simple answer shows its duration without an empty disclosure or invented process counts", () => {
  const h = componentHarness(ProcessDetailsGroup, { messageCount: 0, toolCallCount: 0, durationText: "本轮耗时 2秒", t });
  try {
    h.render();
    assert.equal(h.text(), "处理详情 · 本轮耗时 2秒");
    assert.equal(h.find(node => node.type === "button"), undefined);
  } finally { h.cleanup(); }
});

test("legacy estimation is explicitly labelled and unanswered groups stay expanded", () => {
  const h = componentHarness(ProcessDetailsGroup, { messageCount: 1, toolCallCount: 0, defaultExpanded: true, durationText: "本轮耗时约 5秒", t, children: "error details" });
  try {
    h.render();
    assert.match(h.text(), /本轮耗时约 5秒error details/);
    assert.equal(h.find(node => node.type === "button").props["aria-expanded"], true);
  } finally { h.cleanup(); }
});

test("ChatWindow supplies duration after settlement including process-free answers", async () => {
  const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(source, /getGroupRunDuration\(messages, contentStartIndex, endIdx\)/);
  assert.match(source, /if \(processCount > 0 \|\| durationText\)/);
  assert.match(source, /durationText=\{durationText\}/);
  assert.match(source, /const isLiveTail = \(sessionBusy \|\| streamState\.isStreaming\)/);
  assert.match(source, /runDuration\.estimated \? "chat.runDurationEstimated" : "chat.runDuration"/);
});
