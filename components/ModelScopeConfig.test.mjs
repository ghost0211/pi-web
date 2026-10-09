import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./ModelScopeConfig.tsx", import.meta.url), "utf8");

test("an empty model scope explains the disabled Save in visible, associated text", () => {
  assert.match(source, /const emptySelectionNoteId = useId\(\)/);
  assert.match(source, /disabled=\{loading \|\| saving \|\| !dirty \|\| emptySelection\}/);
  assert.match(source, /aria-describedby=\{emptySelection && !loading \? emptySelectionNoteId : undefined\}/);
  assert.match(source, /emptySelection && !loading && \([\s\S]*?<div id=\{emptySelectionNoteId\}[^>]*role="status">\s*\{t\("modelScope\.emptySaveHint"\)\}/);
});
