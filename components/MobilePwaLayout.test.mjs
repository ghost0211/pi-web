import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const layoutSource = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
const settingsCssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const messageViewSource = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const toolPanelSource = await readFile(new URL("./ToolDefinitionsPanel.tsx", import.meta.url), "utf8");
const directoryPickerSource = await readFile(new URL("./DirectoryPicker.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const viewportHookSource = await readFile(new URL("../hooks/useViewportHeight.ts", import.meta.url), "utf8");

test("configures iOS standalone mode to use the full screen", () => {
  assert.match(layoutSource, /statusBarStyle: "black-translucent"/);
  assert.match(layoutSource, /viewportFit: "cover"/);
  assert.match(layoutSource, /interactiveWidget: "resizes-content"/);
  assert.match(cssSource, /@media \(display-mode: standalone\) \{[\s\S]*?--app-viewport-height: 100vh;/);
});

test("tracks the visual viewport while the software keyboard is open", () => {
  assert.match(appShellSource, /useViewportHeight\(\)/);
  assert.match(appShellSource, /paddingTop: "env\(safe-area-inset-top\)"/);
  assert.match(appShellSource, /paddingBottom: "env\(safe-area-inset-bottom\)"/);
  assert.match(appShellSource, /paddingLeft: "env\(safe-area-inset-left\)"/);
  assert.match(appShellSource, /paddingRight: "env\(safe-area-inset-right\)"/);
  assert.match(appShellSource, /height: "calc\(36px \+ env\(safe-area-inset-top\)\)"/);
  assert.match(appShellSource, /\/\* Right panel tab bar \*\/[\s\S]*?height: "calc\(36px \+ env\(safe-area-inset-top\)\)"/);
  assert.match(appShellSource, /height: "var\(--app-viewport-height, 100dvh\)"/);
  assert.match(appShellSource, /data-mobile-toolbar-file=\{mobile \? "true" : undefined\}/);
  assert.match(viewportHookSource, /window\.visualViewport/);
  assert.match(viewportHookSource, /window\.requestAnimationFrame\(update\)/);
  assert.match(viewportHookSource, /window\.addEventListener\("resize", scheduleUpdate\)/);
  assert.match(viewportHookSource, /window\.addEventListener\("focusout", scheduleUpdate\)/);
  assert.match(viewportHookSource, /--app-viewport-height/);
  assert.match(viewportHookSource, /window\.scrollTo\(0, 0\)/);
  assert.match(cssSource, /height: var\(--app-viewport-height, 100dvh\)/);
  assert.match(cssSource, /left: env\(safe-area-inset-left\)/);
  assert.match(chatWindowSource, /paddingBottom: "env\(safe-area-inset-bottom\)"/);
});

test("contains chat content and inputs within the mobile viewport", () => {
  assert.match(cssSource, /\.markdown-body \{[\s\S]*?min-width: 0;[\s\S]*?max-width: 100%;[\s\S]*?overflow-x: hidden;/);
  assert.match(cssSource, /\.markdown-code-block \{[\s\S]*?min-width: 0;[\s\S]*?max-width: 100%;/);
  assert.match(chatWindowSource, /overflow-x-hidden overflow-y-auto/);
  assert.match(chatWindowSource, /maxHeight: "min\(760px, 100%\)"/);
  assert.match(chatInputSource, /flex: 1,\s*minWidth: 0,\s*width: "100%",/);
});

test("prevents iOS focus zoom from widening the layout", () => {
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?textarea,[\s\S]*?input,[\s\S]*?select \{\s*font-size: 16px !important;/);
});

test("makes settings usable in a narrow viewport", () => {
  assert.match(settingsCssSource, /@media \(max-width: 640px\) \{[\s\S]*?\.settings-dialog-sidebar \{\s*display: none;/);
  assert.match(settingsCssSource, /\.settings-dialog-header \{\s*position: relative;[\s\S]*?justify-content: space-between;/);
  assert.match(settingsCssSource, /height: calc\(var\(--app-viewport-height, 100dvh\) - 12px\)/);
});

test("keeps mobile message and session actions reachable without hover", () => {
  assert.match(cssSource, /@media \(hover: none\) \{[\s\S]*?\.session-row-actions \{ display: flex; \}/);
  assert.match(cssSource, /\.touch-message-action \{ opacity: 1 !important; pointer-events: auto !important; \}/);
  assert.match(messageViewSource, /className="touch-message-actions"/);
  assert.match(messageViewSource, /className="scrollable-split-diff"/);
  assert.match(cssSource, /\.scrollable-split-diff > div \{ min-width: 640px !important; \}/);
  assert.match(sidebarSource, /className="session-row-actions"/);
  assert.match(appShellSource, /isMobile && activeTopPanel && topPanelPos && \([\s\S]*?onClick=\{\(\) => setActiveTopPanel\(null\)\}/);
});

test("keeps the send button outside the mobile controls popover", () => {
  assert.match(chatInputSource, /bottom: "calc\(100% \+ 8px\)"[\s\S]*?flexWrap: "wrap"/);
  assert.match(chatInputSource, /setControlsMenuOpen\(false\);[\s\S]*?<\/div>\s*<div style=\{\{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0/);
});

test("stacks tool details and extension status on phones", () => {
  assert.match(toolPanelSource, /@media \(max-width: 640px\) \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\);/);
  assert.match(toolPanelSource, /\.tool-definition-field \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(cssSource, /\.extension-status-shelf\.has-widgets\.has-status \.extension-status-line \{[\s\S]*?width: 100%;/);
  assert.match(settingsCssSource, /\.model-identity-fields \{\s*grid-template-columns: minmax\(0, 1fr\) !important;/);
});

test("sizes touch targets and picker to the mobile keyboard viewport", () => {
  assert.match(cssSource, /\.branch-tree-row \.branch-bookmark-button \{[\s\S]*?opacity: 1 !important;/);
  assert.match(cssSource, /\.file-mention-option \{ min-height: 44px; \}/);
  assert.match(directoryPickerSource, /maxHeight: "calc\(var\(--app-viewport-height, 100dvh\) - 16px\)"/);
  assert.match(appShellSource, /maxHeight: `calc\(var\(--app-viewport-height, 100dvh\) - \$\{topPanelPos\.top\}px\)`/);
});

test("keeps modal dialogs clear of the iOS status bar in standalone mode", () => {
  assert.match(settingsCssSource, /@supports \(-webkit-touch-callout: none\) \{[\s\S]*?@media \(display-mode: standalone\) \{/);
  assert.match(settingsCssSource, /padding-top: max\(59px, env\(safe-area-inset-top\)\);[\s\S]*?padding-right: max\(8px, env\(safe-area-inset-right\)\);[\s\S]*?padding-bottom: max\(24px, env\(safe-area-inset-bottom\)\);[\s\S]*?padding-left: max\(8px, env\(safe-area-inset-left\)\);/);
  assert.match(settingsCssSource, /@media \(display-mode: standalone\) and \(orientation: landscape\) \{[\s\S]*?padding-top: max\(8px, env\(safe-area-inset-top\)\);[\s\S]*?padding-right: max\(59px, env\(safe-area-inset-right\)\);[\s\S]*?padding-bottom: max\(8px, env\(safe-area-inset-bottom\)\);[\s\S]*?padding-left: max\(59px, env\(safe-area-inset-left\)\);/);
  assert.match(settingsCssSource, /\.settings-dialog-surface,[\s\S]*?\.config-panel-root\.is-modal > \.config-panel-surface \{[\s\S]*?max-width: 100%;[\s\S]*?max-height: 100%;/);
});
