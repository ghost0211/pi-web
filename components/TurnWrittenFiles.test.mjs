import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TurnWrittenFiles, DEFAULT_TURN_DIFF_NOTICE } = await jiti.import("./TurnWrittenFiles.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const source = await readFile(new URL("./TurnWrittenFiles.tsx", import.meta.url), "utf8");

function render(props) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(TurnWrittenFiles, props)),
  );
}

test("renders a button per file showing the basename and full path", () => {
  const html = render({
    files: [{ filePath: "/abs/out/report.html" }, { filePath: "/abs/out/data.json" }],
    onOpenFile() {},
  });
  assert.match(html, /<button/);
  assert.match(html, /report\.html/);
  assert.match(html, /data\.json/);
  assert.match(html, /title="\/abs\/out\/report\.html"/);
  assert.match(html, /title="\/abs\/out\/data\.json"/);
});

test("renders nothing when no files were written", () => {
  assert.equal(render({ files: [], onOpenFile() {} }), "");
});

test("offers a git diff entry per file only when a diff handler is wired", () => {
  const files = [{ filePath: "/abs/out/report.html" }, { filePath: "/abs/out/data.json" }];

  const withoutHandler = render({ files, onOpenFile() {} });
  assert.doesNotMatch(withoutHandler, /Compare working tree with HEAD/);
  assert.doesNotMatch(withoutHandler, /Git diff compares/);

  const withHandler = render({ files, onOpenFile() {}, onOpenGitDiff() {} });
  const diffTitles = withHandler.match(/title="Compare working tree with HEAD"/g) ?? [];
  assert.equal(diffTitles.length, 2);
  assert.match(withHandler, /aria-label="Diff · report\.html"/);
  assert.match(withHandler, /aria-label="Diff · data\.json"/);
});

test("the diff entry carries a repository-level scope notice", () => {
  const html = render({
    files: [{ filePath: "/abs/out/report.html" }],
    onOpenFile() {},
    onOpenGitDiff() {},
  });
  assert.match(html, new RegExp(DEFAULT_TURN_DIFF_NOTICE.slice(0, 32)));
  // The notice must not claim the diff only contains this turn's changes.
  assert.doesNotMatch(html, /only (the )?changes (from )?this turn/i);
});

test("a localized diff notice replaces the default text", () => {
  const html = render({
    files: [{ filePath: "/abs/out/report.html" }],
    onOpenFile() {},
    onOpenGitDiff() {},
    diffNotice: "自定义差异提示",
  });
  assert.match(html, /自定义差异提示/);
  assert.doesNotMatch(html, /Git diff compares/);
});

test("the diff button forwards the file it belongs to", () => {
  // renderToStaticMarkup drops event handlers, so assert the wiring in source.
  assert.match(source, /onClick=\{\(\) => onOpenGitDiff\(filePath\)\}/);
});
