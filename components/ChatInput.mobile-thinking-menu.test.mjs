import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const selectorSource = await readFile(new URL("./ThinkingLevelSelector.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("mobile reasoning uses a body portal instead of an ancestor-clipped popup", () => {
  assert.match(selectorSource, /isMobile && typeof document !== "undefined" \? createPortal\(/);
  assert.match(selectorSource, /<MobileComposerSheet[\s\S]*?document.body/);
  assert.match(selectorSource, /!rootRef.current\?\.contains\(event.target as Node\) && !panelRef.current\?\.contains/);
  assert.match(selectorSource, /if \(!open \|\| isMobile \|\| !rootRef.current/);
});
test("composer passes mobile state and keeps the selected reasoning level readable", () => {
  assert.match(chatInputSource, /<ThinkingLevelSelector[\s\S]*?isMobile=\{isMobile\}\s+showLabel/);
  assert.match(selectorSource, /height: isMobile \? 44 : 28/);
  assert.match(selectorSource, /minHeight: isMobile \? 48 : undefined/);
  assert.doesNotMatch(chatInputSource, /thinkingDropdownOpen/);
});
