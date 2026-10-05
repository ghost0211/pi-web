import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { normalizeDisplayMath } = await jiti.import("../lib/markdown.ts");

function renderMarkdown(markdown) {
  return renderToStaticMarkup(
    React.createElement(MarkdownBody, {
      cwd: "/home/me/project",
      onOpenFile() {},
    }, markdown),
  );
}

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("keeps local file markdown links in the app", () => {
  const html = renderMarkdown("[file](components/MarkdownBody.tsx)");

  assert.match(html, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(html, /target=|rel=|\snode=/);
});

test("preserveLineBreaks renders single newlines as hard breaks (user messages)", () => {
  const plain = renderMarkdown("第一行\n第二行");
  assert.doesNotMatch(plain, /<br/);

  const withBreaks = renderToStaticMarkup(
    React.createElement(MarkdownBody, {
      cwd: "/home/me/project",
      preserveLineBreaks: true,
      onOpenFile() {},
    }, "第一行\n第二行"),
  );
  assert.match(withBreaks, /第一行<br\/>\n?第二行/);
});

test("keeps single-tilde CJK numeric ranges literal instead of striking them", () => {
  const html = renderMarkdown("5~7U 保证金 × 100~200倍杠杆");

  assert.doesNotMatch(html, /<del>/);
  assert.match(html, /5~7U/);
  assert.match(html, /100~200倍/);
});

test("still renders double-tilde strikethrough", () => {
  const html = renderMarkdown("~~gone~~");

  assert.match(html, /<del>gone<\/del>/);
});

test("renders LaTeX parenthesis delimiters as inline math", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("renders paired LaTeX bracket delimiters as display math", () => {
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("renders model-emitted bracket-only formula lines as display math", () => {
  const html = renderMarkdown(String.raw`平均一致性：

[ C(x) = \frac{2}{T(T-1)} \sum_{i<j} S(\hat{y}^{(i)}, \hat{y}^{(j)}) ]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /\\sum/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});

test("attaches sessionId to local image url when sessionId is provided", () => {
  const html = renderToStaticMarkup(
    React.createElement(MarkdownBody, {
      cwd: "/home/me/project",
      sessionId: "session-abc-123",
      onOpenFile() {},
    }, "![local image](/tmp/pi-codemode-foo.png)"),
  );

  assert.match(
    html,
    /<img(?=[^>]*src="\/api\/files\/tmp\/pi-codemode-foo\.png\?type=read&amp;sessionId=session-abc-123")[^>]*>/,
  );
});

test("does not add sessionId query parameter when sessionId is not provided", () => {
  const html = renderToStaticMarkup(
    React.createElement(MarkdownBody, {
      cwd: "/home/me/project",
      onOpenFile() {},
    }, "![local image](/tmp/pi-codemode-foo.png)"),
  );

  assert.match(
    html,
    /<img(?=[^>]*src="\/api\/files\/tmp\/pi-codemode-foo\.png\?type=read")[^>]*>/,
  );
  assert.doesNotMatch(html, /sessionId=/);
});

test("keeps remote images unproxied and preserves Markdown data URL sanitization", () => {
  const remote = renderToStaticMarkup(
    React.createElement(MarkdownBody, {
      cwd: "/home/me/project",
      sessionId: "session-abc-123",
      onOpenFile() {},
    }, "![remote](https://example.com/photo.png)"),
  );
  assert.match(remote, /<img(?=[^>]*src="https:\/\/example\.com\/photo\.png")[^>]*>/);
  assert.doesNotMatch(remote, /\/api\/files/);
  assert.doesNotMatch(remote, /sessionId=/);

  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5f0AAAAASUVORK5CYII=";
  const data = renderToStaticMarkup(
    React.createElement(MarkdownBody, {
      cwd: "/home/me/project",
      sessionId: "session-abc-123",
      onOpenFile() {},
    }, `![data](${dataUrl})`),
  );
  assert.doesNotMatch(data, /src="data:/);
  assert.doesNotMatch(data, /\/api\/files/);
  assert.doesNotMatch(data, /sessionId=/);
});
