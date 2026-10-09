import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  buildTurnPreviews,
  isTurnAnchor,
  isTurnGroupBoundary,
  mapTurnOffsets,
  mergeNavigableTurnPreviews,
  turnSummaryFromMarkdown,
} = await jiti.import("./turn-index.ts");
function user(text, entryId) {
  return { message: { role: "user", content: text }, entryId };
}

function assistant(text, entryId) {
  return { message: { role: "assistant", content: [{ type: "text", text }] }, entryId };
}

function compaction(summary, entryId) {
  return { message: { role: "custom", customType: "compaction", content: summary }, entryId };
}

function previews(entries) {
  return buildTurnPreviews(
    entries.map((entry) => entry.message),
    entries.map((entry) => entry.entryId),
  );
}

test("flattens an answer into the preview card digest", () => {
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

test("groups a user prompt with its answer into one turn", () => {
  const turns = previews([
    user("第一个问题", "u1"),
    assistant("## 回答\n\n第一轮的结论。", "a1"),
    user("第二个问题", "u2"),
    assistant("第二轮的结论。", "a2"),
  ]);

  assert.deepEqual(turns.map((turn) => turn.entryId), ["u1", "u2"]);
  assert.deepEqual(turns.map((turn) => turn.previewText), ["第一个问题", "第二个问题"]);
  assert.equal(turns[0].summary, "回答 第一轮的结论。");
  assert.equal(turns[1].summary, "第二轮的结论。");
  assert.ok(turns.every((turn) => !turn.head));
});

test("compaction stays a display-group boundary but not a navigable turn", () => {
  const turns = previews([
    user("用户问题", "u1"),
    assistant("压缩前的过程结果。", "a1"),
    compaction("## Goal\n\n压缩上下文。", "c1"),
    assistant("压缩后的中间结果。", "a2"),
    compaction("## More context\n\n连续压缩。", "c2"),
    assistant("跨压缩后的最终回答。", "a3"),
    user("下一个问题", "u2"),
    assistant("下一轮回答。", "a4"),
  ]);

  assert.deepEqual(turns.map((turn) => turn.entryId), ["u1", "u2"]);
  assert.deepEqual(turns.map((turn) => turn.previewText), ["用户问题", "下一个问题"]);
  assert.equal(turns[0].summary, "跨压缩后的最终回答。");
  assert.equal(turns[1].summary, "下一轮回答。");
});

test("opens a head turn when the window starts mid-turn", () => {
  const turns = previews([
    assistant("我是上一轮回答的尾部。", "a9"),
    user("新问题", "u10"),
    assistant("新回答。", "a10"),
  ]);

  assert.deepEqual(turns.map((turn) => turn.entryId), ["a9", "u10"]);
  assert.equal(turns[0].head, true);
  assert.equal(turns[0].messageIndex, 0);
  assert.equal(turns[1].head, undefined);
  assert.equal(turns[1].messageIndex, 1);
});

test("distinguishes display-group boundaries from navigable turn anchors", () => {
  const userMessage = { role: "user" };
  const compactionMessage = { role: "custom", customType: "compaction" };
  const otherCustomMessage = { role: "custom", customType: "other" };

  assert.equal(isTurnAnchor(userMessage), true);
  assert.equal(isTurnGroupBoundary(userMessage), true);
  assert.equal(isTurnAnchor(compactionMessage), false);
  assert.equal(isTurnGroupBoundary(compactionMessage), true);
  assert.equal(isTurnAnchor(otherCustomMessage), false);
  assert.equal(isTurnGroupBoundary(otherCustomMessage), false);
  assert.equal(isTurnAnchor({ role: "assistant" }), false);
  assert.equal(isTurnGroupBoundary({ role: "assistant" }), false);
  assert.equal(isTurnAnchor({ role: "toolResult" }), false);
});

test("maps a mid-turn window onto the turn above its first anchor", () => {
  // Index: u1, u2, u3. Window: the tail of u2 plus u3.
  const offsets = mapTurnOffsets([{ top: 100 }, { top: 400 }], 3);
  assert.deepEqual([...offsets.entries()], [[1, 100], [2, 400]]);
});

test("lines a whole-branch window up from the start", () => {
  const offsets = mapTurnOffsets([{ top: 10 }, { top: 20 }, { top: 30 }], 3);
  assert.deepEqual([...offsets.entries()], [[0, 10], [1, 20], [2, 30]]);
});

test("compaction boundaries do not shift suffix mapping for real user turns", () => {
  const local = previews([
    user("kept user", "u2"),
    compaction("## Goal", "c1"),
    assistant("continued after compaction", "a2"),
    user("next user", "u3"),
  ]);
  assert.deepEqual(local.map((turn) => turn.entryId), ["u2", "u3"]);

  // Whole-branch index: u1, u2, u3. The compact card is not an index slot.
  const offsets = mapTurnOffsets([{ top: 250 }, { top: 500 }], 3);
  assert.deepEqual([...offsets.entries()], [[1, 250], [2, 500]]);
});

test("a trailing compaction creates no rail offset or chat-end fallback", () => {
  const local = previews([user("last user", "u1"), compaction("## Goal", "c1")]);
  assert.deepEqual(local.map((turn) => turn.entryId), ["u1"]);
  assert.deepEqual([...mapTurnOffsets([{ top: 120 }], 1).entries()], [[0, 120]]);
  assert.equal(mapTurnOffsets([{ top: null }], 1).size, 0);
});

test("keeps head fallback out of navigation while using it for suffix alignment", () => {
  const local = previews([
    compaction("## Goal", "c2"),
    assistant("continuing a turn from above", "a9"),
    user("latest user", "u10"),
  ]);
  assert.deepEqual(local.map((turn) => [turn.entryId, turn.head]), [["a9", true], ["u10", undefined]]);

  const displayed = mergeNavigableTurnPreviews([], local);
  assert.deepEqual(displayed.map((turn) => turn.entryId), ["u10"]);
  const headOnly = previews([
    compaction("## Goal", "c3"),
    assistant("post-compaction tail only", "a10"),
  ]);
  assert.deepEqual(mergeNavigableTurnPreviews([], headOnly), []);
  assert.deepEqual(mergeNavigableTurnPreviews(headOnly, headOnly), [], "a restored server head is not navigable either");
  const serverIndex = previews([
    user("old user", "u1"),
    user("middle user", "u2"),
    user("latest user", "u10"),
  ]);
  assert.deepEqual(mergeNavigableTurnPreviews(serverIndex, local), serverIndex);

  // The leading head represents the previous server turn for measurement only.
  const offsets = mapTurnOffsets([{ top: 100 }, { top: 400 }], 3);
  assert.deepEqual([...offsets.entries()], [[1, 100], [2, 400]]);
});

test("maps only the turns it can measure", () => {
  assert.equal(mapTurnOffsets([], 5).size, 0);
  const offsets = mapTurnOffsets([{ top: null }, { top: 90 }], 4);
  assert.deepEqual([...offsets.entries()], [[3, 90]]);
});
