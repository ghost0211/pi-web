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
const { turnSummaryFromMarkdown, TurnRailView, cardTopFor, layoutBars } = await jiti.import("./ChatMinimap.tsx");

function turn(previewText, summary = "") {
  return { previewText, summary, scrollTop: 0 };
}

test("flattens an answer into the hover card digest", () => {
  const summary = turnSummaryFromMarkdown([
    "# 结论",
    "",
    "核心结构已经改完：物理命名统一到 **数据库规范**，参见 [命名规范](https://example.com/naming)。",
    "",
    "- 字段权限模型改回与产品侧 DDD 同一条发布链",
    "- 系统版本追踪和产品启用版本也已补齐",
    "",
    "```sql",
    "ALTER TABLE prod_menu_op RENAME COLUMN prod_optype_dict TO op_type_dict;",
    "```",
    "",
    "> 备注：见 $f_{k,t+1}$ 与 \\(x^2 + y^2\\)。",
  ].join("\n"));

  assert.match(summary, /结论/);
  assert.match(summary, /物理命名统一到 数据库规范/);
  assert.match(summary, /命名规范/);
  assert.match(summary, /字段权限模型改回与产品侧 DDD 同一条发布链/);
  assert.match(summary, /f_\{k,t\+1\}/);
  assert.match(summary, /x\^2 \+ y\^2/);
  assert.doesNotMatch(summary, /#/);
  assert.doesNotMatch(summary, /[*~|`]/);
  assert.doesNotMatch(summary, /example\.com/);
  assert.doesNotMatch(summary, /ALTER TABLE/);
  assert.doesNotMatch(summary, /\n/);
});

test("keeps plain prose untouched", () => {
  assert.equal(
    turnSummaryFromMarkdown("可以，按你的建议处理吧。我补充一点：db-gateway 已重新测试通过。"),
    "可以，按你的建议处理吧。我补充一点：db-gateway 已重新测试通过。",
  );
});

test("lays turns out on a fixed 15px pitch", () => {
  const bars = layoutBars([turn("a"), turn("b"), turn("c")], 800);
  assert.deepEqual(bars.map((bar) => bar.top), [12, 27, 42]);
  assert.deepEqual(bars.map((bar) => bar.index), [0, 1, 2]);
});

test("compresses the pitch instead of overflowing the rail", () => {
  const turns = Array.from({ length: 100 }, (_, index) => turn(`t${index}`));
  const bars = layoutBars(turns, 300);
  assert.ok(bars[1].top - bars[0].top < 15);
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
