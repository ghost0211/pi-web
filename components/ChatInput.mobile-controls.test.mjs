import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const input = await readFile(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const model = await readFile(new URL('./ModelSelector.tsx', import.meta.url), 'utf8');
const advance = await readFile(new URL('./AutoAdvanceControl.tsx', import.meta.url), 'utf8');
test('mobile composer respects the bottom safe area without changing desktop padding',()=>{
  assert.match(input,/padding: isMobile \? "0 8px max\(8px, env\(safe-area-inset-bottom\)\)" : "0 16px 16px"/);
});
test('the mobile controls trigger is an accessible 44px icon, not a long text button',()=>{
  assert.match(input,/data-composer-more="true"[\s\S]*?aria-label=\{t\(controlsMenuOpen \? "chat.collapseControls" : "chat.moreControls"\)\}[\s\S]*?width: 44,[\s\S]*?height: 44/);
  assert.match(input,/className=\{isMobile \? "mobile-composer-controls" : undefined\}[\s\S]*?role=\{isMobile \? "group" : undefined\}/);
});
test('the model shares the first row with the context ring, and secondary controls wrap below',()=>{
  assert.match(css,/\.mobile-composer-controls \.model-selector \{ flex: 1 1 calc\(100% - 52px\) !important; \}/);
  assert.match(css,/\.mobile-composer-controls \.model-selector > button \{[\s\S]*?min-height: 44px !important/);
});
test('Escape closes the parent only after a child handles its own popup, restoring visible trigger focus',()=>{
  assert.match(input,/event\.key !== "Escape" \|\| event\.defaultPrevented/);
  assert.match(input,/requestAnimationFrame\(\(\) => controlsTriggerRef\.current\?\.focus\(\{ preventScroll: true \}\)\)/);
  assert.match(input,/\.mobile-composer-controls button:not\(:disabled\)/);
});
test('outside dismissal excludes the model and auto-advance portals',()=>{
  assert.match(input,/closest\?\.\('\[data-composer-controls-portal\]'\)/);
  assert.match(input,/!controlsMenuRef\.current\.contains\(e.target as Node\) && !inControlsPortal/);
  assert.match(model,/data-composer-controls-portal="model"/);
  assert.match(advance,/data-composer-controls-portal="auto-advance"/);
});
