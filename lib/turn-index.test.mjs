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
  mapTurnOffsets,
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

test("anchors a turn on a compaction summary", () => {
  const turns = previews([
    user("旧问题", "u1"),
    compaction("## 已完成的上下文\n\n前面聊了很多。", "c1"),
    assistant("压缩后的回答。", "a1"),
  ]);

  assert.deepEqual(turns.map((turn) => turn.entryId), ["u1", "c1"]);
  assert.equal(turns[1].previewText, "已完成的上下文");
  assert.equal(turns[1].summary, "压缩后的回答。");
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

test("treats user prompts and compaction summaries as turn anchors", () => {
  assert.equal(isTurnAnchor({ role: "user" }), true);
  assert.equal(isTurnAnchor({ role: "custom", customType: "compaction" }), true);
  assert.equal(isTurnAnchor({ role: "custom", customType: "other" }), false);
  assert.equal(isTurnAnchor({ role: "assistant" }), false);
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

test("lends the next measured offset to a compaction anchor", () => {
  const offsets = mapTurnOffsets([{ top: null, borrowNext: true }, { top: 250 }], 2);
  assert.deepEqual([...offsets.entries()], [[1, 250], [0, 250]]);
});

test("maps only the turns it can measure", () => {
  assert.equal(mapTurnOffsets([], 5).size, 0);
  const offsets = mapTurnOffsets([{ top: null }, { top: 90 }], 4);
  assert.deepEqual([...offsets.entries()], [[3, 90]]);
});
