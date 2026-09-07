import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { TurnOutcomeCard } = await jiti.import("./TurnOutcomeCard.tsx");
const render = (outcome) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(TurnOutcomeCard, { outcome, onOpenFile() {} })));

test("ordinary conversations do not get an empty results card", () => {
  assert.equal(render({ files: [], commands: [] }), "");
});

test("renders file navigation and failed command output with safe escaping", () => {
  const html = render({
    files: [{ filePath: "/project/app.ts" }],
    commands: [{ id: "1", command: "npm test", status: "failed", output: "<script>alert(1)</script>", truncated: false }],
  });
  assert.match(html, /Turn results/);
  assert.match(html, /title="\/project\/app.ts"/);
  assert.match(html, /Some commands failed/);
  assert.match(html, /npm test/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<details open/);
});

test("missing results are not presented as successful commands", () => {
  const html = render({ files: [], commands: [{ id: "1", command: "npm test", status: "unknown", output: "", truncated: false }] });
  assert.match(html, /No result recorded/);
  assert.doesNotMatch(html, /Completed/);
});
