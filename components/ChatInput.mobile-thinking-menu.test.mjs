import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The reasoning menus moved into the shared ThinkingLevelSelector so primary and
// backup controls cannot drift apart. Mobile anchoring and label folding moved
// with them; ChatInput still decides when the mobile label is visible.
const selectorSource = await readFile(new URL("./ThinkingLevelSelector.tsx", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("anchors the mobile reasoning menu to its left edge", () => {
  assert.match(
    selectorSource,
    /\{open && \([\s\S]*?bottom: "calc\(100% \+ 6px\)"[\s\S]*?isMobile \? \{ left: 0 \} : \{ right: 0 \}/,
  );
});

test("keeps the mobile reason menu labels folded behind the more-controls button", () => {
  assert.match(chatInputSource, /showLabel=\{!isMobile \|\| controlsMenuOpen\}/);
  assert.match(selectorSource, /\{showLabel && <span>/);
  assert.doesNotMatch(chatInputSource, /thinkingDropdownOpen/);
});
