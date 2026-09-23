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
const { TurnRailView, cardTopFor, layoutBars } = await jiti.import("./ChatMinimap.tsx");

function turn(previewText, summary = "") {
  return { entryId: `e-${previewText}`, previewText, summary };
}

test("lays turns out on a fixed 15px pitch, centered in the rail", () => {
  const bars = layoutBars([turn("a"), turn("b"), turn("c")], 800);
  assert.deepEqual(bars.map((bar) => bar.top), [385, 400, 415]);
  assert.deepEqual(bars.map((bar) => bar.index), [0, 1, 2]);
});

test("centers a lone turn and a rail-filling list", () => {
  assert.deepEqual(layoutBars([turn("only")], 800).map((bar) => bar.top), [400]);

  const turns = Array.from({ length: 100 }, (_, index) => turn(`t${index}`));
  const bars = layoutBars(turns, 300);
  assert.ok(bars[1].top - bars[0].top < 15);
  assert.equal(bars[0].top, 12);
  assert.ok(bars[99].top <= 300 - 12 + 0.001);
});

test("renders one bar per turn and the hover preview card", () => {
  const bars = layoutBars([turn("第一轮"), turn("第二轮", "回答摘要"), turn("第三轮")], 800);
  const render = (hoveredIndex) => renderToStaticMarkup(
    React.createElement(TurnRailView, {
      bars,
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
