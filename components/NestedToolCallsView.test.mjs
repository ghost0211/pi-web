import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { NestedToolCallsView } = await jiti.import("./NestedToolCallsView.tsx");

function render(record) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(NestedToolCallsView, { record })));
}

test("nested calls are collapsed, show statuses and durations, and escape arguments/errors", () => {
  const html = render({ complete: true, calls: [
    { id: "code/0", name: "read", arguments: { path: "<script>" }, status: "ok", durationMs: 12 },
    { id: "code/1", name: "mcp__server__x", status: "error", error: "<danger>", durationMs: 0 },
  ] });
  assert.match(html, /2 nested tool calls/);
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.match(html, /read/);
  assert.match(html, /12ms/);
  assert.match(html, /mcp__server__x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;danger&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("incomplete records and omitted arguments are not presented as complete", () => {
  const html = render({ complete: false, calls: [
    { id: "code/0", name: "bash", status: "unfinished", argumentsBytes: 9000 },
  ] });
  assert.match(html, /Partial record/);
  assert.match(html, /unfinished/);
  assert.match(html, /9000/);
  assert.match(render({ complete: false, calls: [] }), /Partial record/);
  assert.equal(render({ complete: true, calls: [] }), "");
});
