import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => String(key) });",
    };
  },
});

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { TurnRailView, cardTopFor, layoutBars, nextRailIndex, railContentHeight } = await jiti.import("./ChatMinimap.tsx");

function turn(previewText, summary = "") {
  return { entryId: `e-${previewText}`, previewText, summary };
}

test("lays turns out on a fixed 15px pitch, centered in the rail", () => {
  const bars = layoutBars([turn("a"), turn("b"), turn("c")], 800);
  assert.deepEqual(bars.map((bar) => bar.top), [385, 400, 415]);
  assert.deepEqual(bars.map((bar) => bar.index), [0, 1, 2]);
});

test("scrolls long histories at a fixed pitch without dropping old turns", () => {
  assert.deepEqual(layoutBars([turn("only")], 800).map((bar) => bar.top), [400]);

  const turns = Array.from({ length: 10_000 }, (_, index) => turn(`t${index}`));
  const railHeight = 300;
  const contentHeight = railContentHeight(turns.length, railHeight);
  assert.ok(contentHeight > railHeight);
  const first = layoutBars(turns, railHeight);
  assert.equal(first[0].index, 0);
  assert.equal(first[0].top, 12);
  assert.ok(first.length < 30, "mount only bars near the viewport");
  assert.equal(first[1].top - first[0].top, 15);

  const last = layoutBars(turns, railHeight, contentHeight - railHeight);
  assert.equal(last.at(-1).index, 9_999);
  assert.equal(last.at(-1).top, 12 + 9_999 * 15);
  assert.ok(last.length < 30);
  assert.ok(last[0].index > 9_970);
  assert.ok(layoutBars(turns, railHeight, contentHeight / 2).some((bar) => bar.index > 4_990 && bar.index < 5_010));
});

test("does not create a scroll area until the bars no longer fit", () => {
  const turns = Array.from({ length: 19 }, (_, index) => turn(`t${index}`));
  assert.equal(railContentHeight(turns.length, 300), 300);
  assert.equal(layoutBars(turns, 300).length, 19);
  turns.push(turn("overflow"));
  assert.ok(railContentHeight(turns.length, 300) > 300);
  assert.equal(layoutBars(turns, 300)[0].top, 12);
});

test("keyboard stepping can reach every turn, including the first and last", () => {
  assert.equal(nextRailIndex("Home", 9999, 10_000, 300), 0);
  assert.equal(nextRailIndex("End", 0, 10_000, 300), 9_999);
  assert.equal(nextRailIndex("ArrowDown", 0, 10_000, 300), 1);
  assert.equal(nextRailIndex("ArrowUp", 0, 10_000, 300), 0);
  assert.equal(nextRailIndex("ArrowDown", 9_999, 10_000, 300), 9_999);
  assert.equal(nextRailIndex("PageUp", 30, 10_000, 300), 12);
  assert.equal(nextRailIndex("PageDown", 30, 10_000, 300), 48);
  assert.equal(nextRailIndex("Enter", 30, 10_000, 300), null);
  assert.equal(nextRailIndex("Home", 0, 0, 300), null);
});

test("renders only visible bars of long sessions with one keyboard stop", () => {
  const turns = Array.from({ length: 10_000 }, (_, i) => turn(`t${i}`));
  const html = renderToStaticMarkup(React.createElement(TurnRailView, {
    turns,
    railHeight: 300,
    activeIndex: 9_999,
    hoveredIndex: null,
    onHoverBar() {},
    onLeaveRail() {},
    onJump() {},
  }));
  assert.ok((html.match(/data-turn-index=/g) ?? []).length < 30);
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1);
  assert.match(html, /data-scrollable="true"/);
});

test("renders one bar per turn and the hover preview card", () => {
  const turns = [turn("第一轮"), turn("第二轮", "回答摘要"), turn("第三轮")];
  const render = (hoveredIndex) => renderToStaticMarkup(
    React.createElement(TurnRailView, {
      turns,
      railHeight: 800,
      activeIndex: 1,
      hoveredIndex,
      onHoverBar() {},
      onLeaveRail() {},
      onJump() {},
    }),
  );

  const hovered = render(1);
  assert.equal((hovered.match(/data-turn-index=/g) ?? []).length, 3);
  assert.match(hovered, /data-active="true"/);
  assert.match(hovered, /data-hovered="true"/);
  assert.match(hovered, /data-turn-preview="1"/);
  assert.match(hovered, /第二轮/);
  assert.match(hovered, /回答摘要/);
  assert.match(hovered, /2 \/ 3/);
  // Lens: the hovered bar grows to 39px, its neighbours taper to 30px.
  assert.match(hovered, /width:39px/);
  assert.match(hovered, /width:30px/);

  const idle = render(null);
  assert.doesNotMatch(idle, /data-turn-preview/);
  assert.equal((idle.match(/width:9px/g) ?? []).length, 3);
});

test("clamps the preview card inside the chat area", () => {
  assert.equal(cardTopFor(12, 800), 92);
  assert.equal(cardTopFor(400, 800), 400);
  assert.equal(cardTopFor(790, 800), 708);
  assert.equal(cardTopFor(12, 100), 50);
});
