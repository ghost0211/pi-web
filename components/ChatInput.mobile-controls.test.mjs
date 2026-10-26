import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const input = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const model = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");
const sheet = await readFile(new URL("./MobileComposerSheet.tsx", import.meta.url), "utf8");

test("mobile composer respects the bottom safe area without changing desktop padding", () => {
  assert.match(input, /padding: isMobile \? "0 8px max\(8px, env\(safe-area-inset-bottom\)\)" : "0 16px 16px"/);
});
test("frequent selectors have a separate row from quick actions and sending", () => {
  assert.match(css, /grid-template-areas: "model model model" "thinking quick send"/);
  assert.match(css, /\.mobile-composer-primary-controls \{ display: contents; \}/);
  assert.match(input, /display: isMobile && isStreaming \? "none" : "contents"/);
  for (const area of ["primary-controls", "quick-actions", "send-actions"]) {
    assert.ok(input.includes(`"mobile-composer-${area}"`));
  }
  assert.doesNotMatch(css, /\.mobile-composer-controls[^{}]*span\s*\{\s*display: none/);
  assert.doesNotMatch(input, /data-mobile-inline/);
});
test("secondary options use a 44px More button both idle and streaming", () => {
  assert.match(input, /\{isMobile && \([\s\S]*?data-composer-more="true"[\s\S]*?width: 44,[\s\S]*?height: 44/);
  assert.match(input, /display: isMobile && !controlsMenuOpen \? "none" : "flex"/);
  assert.match(css, /\.mobile-composer-controls > div > button \{ min-height: 44px !important; min-width: 44px !important/);
  assert.match(input, /setToolDropdownOpen\(false\); setControlsMenuOpen/);
});
test("Escape closes the parent after its child, restoring visible trigger focus", () => {
  assert.match(input, /event\.key !== "Escape" \|\| event\.defaultPrevented/);
  assert.match(input, /requestAnimationFrame\(\(\) => controlsTriggerRef\.current\?\.focus\(\{ preventScroll: true \}\)\)/);
});
test("models remain readable and searching is explicit on mobile", () => {
  assert.match(model, /minHeight: isMobile \? 44 : 28/);
  assert.match(model, /autoFocus=\{!isMobile\}/);
  assert.match(model, /fontSize: isMobile \? 16 : 11/);
  assert.match(model, /<MobileComposerSheet/);
  assert.match(css, /\.mobile-composer-primary-controls \.model-selector \{ grid-area: model; width: 100% !important; min-width: 0; \}/);
  assert.match(css, /\.mobile-composer-primary-controls \[data-thinking-selector\] \{ grid-area: thinking;/);
});
test("mobile pickers follow the visual viewport and focus a non-editor control", () => {
  assert.match(sheet, /closeRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(sheet, /visualViewport\?\.addEventListener\("resize", update\)/);
  assert.match(sheet, /visualViewport\?\.addEventListener\("scroll", update\)/);
  assert.match(sheet, /role="dialog" aria-modal="true"/);
  assert.match(sheet, /data-composer-controls-portal="picker"/);
  assert.match(input, /!controlsMenuRef\.current\.contains\(e.target as Node\) && !inControlsPortal/);
});
