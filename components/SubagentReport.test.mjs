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
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { getLocalePlugin } = await jiti.import("@/lib/i18n/registry");

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const makeMessage = (overrides = {}) => ({
  role: "custom",
  customType: "pi-web:subagent-notification",
  display: true,
  content: "# Original report\n\nThe raw result belongs here.",
  timestamp: Date.parse("2026-03-01T00:00:00Z"),
  details: {
    kind: "pi-web-subagent",
    sessionId: SESSION_ID,
    profile: "Explore",
    description: "Inspect the parser",
    status: "completed",
    completedAt: "2026-03-04T05:06:07.000Z",
  },
  ...overrides,
});

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(MessageView, { message, ...props }),
  ));
}

test("dispatches subagent notifications to a separate report card, folded with complete Markdown inside", () => {
  const longReport = `${"A".repeat(105_000)}\n\n**FINAL_REPORT_SENTINEL**`;
  const html = renderMessage(makeMessage({ content: longReport }), { onOpenSession() {} });

  assert.match(html, /<details class="subagent-report-details">/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.match(html, /Sub-agent report/);
  assert.match(html, /Inspect the parser/);
  assert.match(html, /Explore/);
  assert.match(html, /Completed/);
  assert.match(html, /dateTime="2026-03-04T05:06:07\.000Z"/);
  const summary = html.match(/<summary[^>]*>[\s\S]*?<\/summary>/)?.[0] ?? "";
  assert.match(summary, /This is the subagent&#x27;s original result/);
  assert.match(html, /FINAL_REPORT_SENTINEL/);
  assert.doesNotMatch(html, /largeMessageReveal/);
  assert.doesNotMatch(html, /pi-web:subagent-notification/);
  assert.doesNotMatch(html, /privateValue/);
  assert.match(html, /aria-label="Open sub-agent session"/);
});

test("uses a safe fallback for legacy notification messages without details", () => {
  const html = renderMessage(makeMessage({
    details: undefined,
    content: [
      { type: "text", text: "Legacy first block" },
      { type: "image", data: "secret-image-data" },
      { text: "legacy second block" },
    ],
  }));

  assert.match(html, /No task description provided/);
  assert.match(html, /Unknown status/);
  assert.match(html, /Legacy first block/);
  assert.match(html, /legacy second block/);
  assert.doesNotMatch(html, /subagent-report-status--completed/);
  assert.doesNotMatch(html, /secret-image-data/);
  assert.doesNotMatch(html, /Open sub-agent session/);
});

test("does not trust unknown details or infer success from their status field", () => {
  const html = renderMessage(makeMessage({
    details: { kind: "unknown", status: "completed", sessionId: SESSION_ID },
    content: "Result without trusted metadata",
  }));

  assert.match(html, /Unknown status/);
  assert.doesNotMatch(html, /class="subagent-report-status subagent-report-status--completed"/);
  assert.doesNotMatch(html, /Open sub-agent session/);
  assert.match(html, /Result without trusted metadata/);
});

test("shows only trusted raw reportText, never the model-facing integration guidance", () => {
  const guidance = "MODEL_INTEGRATION_GUIDANCE_SENTINEL";
  const knownDetails = makeMessage().details;
  const html = renderMessage(makeMessage({
    content: `${guidance}\\n\\nsource markers`,
    details: { ...knownDetails, reportText: "RAW_SUBAGENT_RESULT_SENTINEL" },
  }));
  assert.match(html, /RAW_SUBAGENT_RESULT_SENTINEL/);
  assert.doesNotMatch(html, new RegExp(guidance));

  const emptyHtml = renderMessage(makeMessage({
    content: guidance,
    details: { ...knownDetails, reportText: "" },
  }));
  assert.match(emptyHtml, /No raw result was returned/);
  assert.doesNotMatch(emptyHtml, new RegExp(guidance));

  const unknownKindHtml = renderMessage(makeMessage({
    content: guidance,
    details: { ...knownDetails, kind: "unknown", reportText: "UNTRUSTED_REPORT_TEXT_SENTINEL" },
  }));
  assert.match(unknownKindHtml, new RegExp(guidance));
  assert.doesNotMatch(unknownKindHtml, /UNTRUSTED_REPORT_TEXT_SENTINEL/);
  assert.match(unknownKindHtml, /Unknown status/);
});

test("renders failed, aborted, and interrupted statuses without reclassifying them", () => {
  for (const [status, label] of [["failed", "Failed"], ["aborted", "Aborted"], ["interrupted", "Interrupted"]]) {
    const html = renderMessage(makeMessage({ details: { ...makeMessage().details, status } }));
    assert.match(html, new RegExp(`subagent-report-status--${status}`));
    assert.match(html, new RegExp(`>${label}</span>`));
  }
});

test("open-session action only receives a valid opaque session id and stays outside summary", () => {
  const opened = [];
  const harness = componentHarness((props) => React.createElement(MessageView, props), {
    message: makeMessage(),
    onOpenSession: (sessionId) => opened.push(sessionId),
  });
  try {
    harness.render();
    const details = harness.find((node) => node.type === "details");
    const openButton = harness.find((node) => node.type === "button" && node.props["aria-label"] === "subagent.open");
    assert.ok(openButton);
    openButton.props.onClick();
    assert.deepEqual(opened, [SESSION_ID]);
    assert.equal(details.props.open, undefined, "opening the child session does not toggle the card");

    harness.render({
      message: makeMessage({ details: { ...makeMessage().details, sessionId: "../../sessions/private" } }),
      onOpenSession: (sessionId) => opened.push(sessionId),
    });
    assert.equal(harness.find((node) => node.type === "button" && node.props["aria-label"] === "subagent.open"), undefined);
    assert.deepEqual(opened, [SESSION_ID]);
  } finally {
    harness.cleanup();
  }
});

test("report Markdown keeps cwd, local-file opening, and session context", () => {
  const openedFiles = [];
  const harness = componentHarness((props) => React.createElement(MessageView, props), {
    message: makeMessage({ content: "![chart](images/chart.png)\n\n[open source](src/readme.ts)" }),
    cwd: "/workspace/project",
    sessionId: SESSION_ID,
    onOpenFile: (filePath) => openedFiles.push(filePath),
  });
  try {
    harness.render();
    const image = harness.find((node) => node.type === "img");
    assert.ok(image.props.src.includes(`/api/files/workspace/project/images/chart.png?type=read&sessionId=${SESSION_ID}`), image.props.src);

    const link = harness.find((node) => node.type === "a" && node.props.href === "src/readme.ts");
    assert.equal(typeof link.props.onClick, "function");
    let preventedDefault = false;
    link.props.onClick({
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      currentTarget: { getAttribute: () => null },
      preventDefault: () => { preventedDefault = true; },
    });
    assert.equal(preventedDefault, true);
    assert.deepEqual(openedFiles, ["/workspace/project/src/readme.ts"]);
  } finally {
    harness.cleanup();
  }
});

test("ordinary custom messages keep their existing rendering path", () => {
  const html = renderMessage({
    role: "custom",
    customType: "ordinary-extension",
    display: true,
    content: "Ordinary extension message",
    timestamp: 1,
  });

  assert.match(html, /ordinary-extension/);
  assert.match(html, /Ordinary extension message/);
  assert.doesNotMatch(html, /subagent-report-details/);
  assert.doesNotMatch(html, /Sub-agent report/);
});

test("provides the parent follow-up translation key and styling in all built-in locales", async () => {
  assert.equal(getLocalePlugin("en").messages["subagent.parentFollowUp"], "Main agent follow-up");
  assert.equal(getLocalePlugin("zh-CN").messages["subagent.parentFollowUp"], "主代理补充");
  assert.equal(getLocalePlugin("zh-TW").messages["subagent.parentFollowUp"], "主代理補充");

  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.chat-parent-follow-up\s*\{[^}]*margin-bottom:\s*7px;[^}]*color:\s*var\(--text-muted\);[^}]*font-size:\s*12px;[^}]*font-weight:\s*600;[^}]*letter-spacing:/);
});
