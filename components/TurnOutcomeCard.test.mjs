import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { TurnOutcomeCard } = await jiti.import("./TurnOutcomeCard.tsx");

const source = await readFile(new URL("./TurnOutcomeCard.tsx", import.meta.url), "utf8");

const render = (outcome, props = {}) => renderToStaticMarkup(
  React.createElement(
    I18nProvider,
    null,
    React.createElement(TurnOutcomeCard, { outcome, onOpenFile() {}, ...props }),
  ),
);

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

test("shows the per-file diff entry and scope notice only when wired", () => {
  const outcome = { files: [{ filePath: "/project/app.ts" }], commands: [{ id: "1", command: "npm test", status: "completed", output: "ok", truncated: false }] };

  // Current host wiring (onOpenFile only) stays free of dormant diff UI.
  const baseline = render(outcome);
  assert.doesNotMatch(baseline, /Compare working tree with HEAD/);
  assert.doesNotMatch(baseline, /Git diff compares/);

  const reviewed = render(outcome, { onOpenGitDiff() {} });
  assert.match(reviewed, /title="Compare working tree with HEAD"/);
  assert.match(reviewed, /Git diff compares the working tree with HEAD/);
  // The command results remain visible next to the review entry.
  assert.match(reviewed, /npm test/);
});

test("forwards a localized diff notice through to the file list", () => {
  const html = render(
    { files: [{ filePath: "/project/app.ts" }], commands: [] },
    { onOpenGitDiff() {}, diffNotice: "仓库级差异，可能包含本轮之外的改动" },
  );
  assert.match(html, /仓库级差异，可能包含本轮之外的改动/);
});

test("passes the diff handler down without opening the file itself", () => {
  assert.match(source, /onOpenGitDiff=\{onOpenGitDiff\}/);
  assert.match(source, /diffNotice=\{diffNotice\}/);
});
