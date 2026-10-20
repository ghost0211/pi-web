import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parsePresentFilesDetails, presentPathKey, PRESENT_FILES_DETAILS_KIND } = await jiti.import("./present-files.ts");
const { classifyPresentKind } = await jiti.import("./present-files-extension.ts");
const { buildTurnOutcome, extractTurnDeliverables } = await jiti.import("./turn-outcome.ts");

const item = (overrides = {}) => ({
  name: "init.sql",
  path: "sql/init.sql",
  abs: "D:/proj/pd/sql/init.sql",
  kind: "text",
  ...overrides,
});

const details = (items, extra = {}) => ({ kind: PRESENT_FILES_DETAILS_KIND, version: 1, items, ...extra });

test("parses a well-formed declaration and keeps captions, size and kind", () => {
  const parsed = parsePresentFilesDetails(details([
    item({ caption: "最终迁移脚本", size: 266_240, mtime: 1_700_000_000_000 }),
  ], { title: "迁移脚本", note: "见文件" }));
  assert.ok(parsed);
  assert.equal(parsed.title, "迁移脚本");
  assert.equal(parsed.note, "见文件");
  assert.deepEqual(parsed.items, [{
    name: "init.sql",
    path: "sql/init.sql",
    abs: "D:/proj/pd/sql/init.sql",
    kind: "text",
    caption: "最终迁移脚本",
    size: 266_240,
    mtime: 1_700_000_000_000,
  }]);
});

test("rejects a payload without this version's marker", () => {
  assert.equal(parsePresentFilesDetails({ items: [item()] }), null);
  assert.equal(parsePresentFilesDetails({ kind: "pi-web-present-files", items: [item()] }), null);
  assert.equal(parsePresentFilesDetails({ kind: PRESENT_FILES_DETAILS_KIND, items: [] }), null);
  assert.equal(parsePresentFilesDetails(null), null);
  assert.equal(parsePresentFilesDetails([item()]), null);
});

test("drops missing entries instead of presenting an unverified path", () => {
  const parsed = parsePresentFilesDetails(details([item({ kind: "missing" }), item({ abs: "D:/proj/pd/ok.sql" })]));
  assert.deepEqual(parsed?.items.map((entry) => entry.abs), ["D:/proj/pd/ok.sql"]);
  // All-missing is nothing to show, not an empty card.
  assert.equal(parsePresentFilesDetails(details([item({ kind: "missing" })])), null);
});

test("rejects unknown kinds, non-string paths and malformed entries", () => {
  const parsed = parsePresentFilesDetails(details([
    item({ kind: "executable" }),
    item({ abs: 42 }),
    item({ abs: "   " }),
    "not-an-object",
    null,
  ]));
  assert.equal(parsed, null);
});

test("deduplicates the same artifact across separators and case", () => {
  const parsed = parsePresentFilesDetails(details([
    item({ abs: "D:/proj/pd/sql/init.sql" }),
    item({ abs: "D:\\proj\\pd\\sql\\INIT.sql" }),
  ]));
  assert.equal(parsed?.items.length, 1);
});

test("caps the number of items and string lengths", () => {
  const many = Array.from({ length: 30 }, (_, index) => item({ abs: `D:/proj/pd/f${index}.sql`, name: `f${index}.sql` }));
  assert.equal(parsePresentFilesDetails(details(many))?.items.length, 12);
  const parsed = parsePresentFilesDetails(details([item({ caption: "x".repeat(900), name: "n".repeat(400) })], { title: "t".repeat(400) }));
  assert.equal(parsed?.title?.length, 200);
  assert.equal(parsed?.items[0].caption?.length, 300);
  assert.equal(parsed?.items[0].name.length, 255);
});

test("classifies artifacts by extension only", () => {
  assert.equal(classifyPresentKind("report.md"), "markdown");
  assert.equal(classifyPresentKind("report.html"), "html");
  assert.equal(classifyPresentKind("report.pdf"), "pdf");
  assert.equal(classifyPresentKind("chart.png"), "image");
  assert.equal(classifyPresentKind("clip.mp4"), "video");
  assert.equal(classifyPresentKind("voice.mp3"), "audio");
  assert.equal(classifyPresentKind("init.sql"), "text");
  assert.equal(classifyPresentKind("payload.zip"), "binary");
  // No extension: the viewer opens it as text, so the chip says text.
  assert.equal(classifyPresentKind("Makefile"), "text");
});

test("presentPathKey normalizes separators, case and trailing slashes", () => {
  assert.equal(presentPathKey("D:\\A\\B.sql"), presentPathKey("d:/a/b.sql"));
  assert.equal(presentPathKey("/a/b/"), presentPathKey("/a/b"));
});

const toolResult = (overrides = {}) => ({
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "present_files",
  content: [{ type: "text", text: "ok" }],
  ...overrides,
});

test("only a successful present_files result with the marker becomes deliverables", () => {
  const good = toolResult({ details: details([item()]) });
  assert.ok(extractTurnDeliverables([good]));
  // An errored call, another tool's result, or a forged payload shows nothing.
  assert.equal(extractTurnDeliverables([toolResult({ isError: true, details: details([item()]) })]), null);
  assert.equal(extractTurnDeliverables([toolResult({ toolName: "write", details: details([item()]) })]), null);
  assert.equal(extractTurnDeliverables([toolResult({ details: { items: [item()] } })]), null);
});

test("a later declaration supersedes an earlier one in the same turn", () => {
  const first = toolResult({ details: details([item({ abs: "D:/a.sql", name: "a.sql" })]) });
  const second = toolResult({ details: details([item({ abs: "D:/b.sql", name: "b.sql" })]) });
  assert.deepEqual(extractTurnDeliverables([first, second])?.items.map((entry) => entry.name), ["b.sql"]);
});

test("declared deliverables lead the outcome and never repeat in secondary rows", () => {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", toolCallId: "w1", toolName: "write", input: { path: "work/build.py" } }] },
    { role: "toolResult", toolCallId: "w1", content: [{ type: "text", text: "ok" }] },
    { role: "assistant", content: [{ type: "toolCall", toolCallId: "w2", toolName: "write", input: { path: "sql/init.sql" } }] },
    { role: "toolResult", toolCallId: "w2", content: [{ type: "text", text: "ok" }] },
    toolResult({
      toolCallId: "p1",
      details: details([item({ abs: "/project/sql/init.sql", name: "init.sql" })]),
    }),
    { role: "assistant", content: [{ type: "text", text: "生成 `sql/init.sql` 与 `work/other.sql`" }] },
  ];
  const outcome = buildTurnOutcome(messages, "/project");
  assert.deepEqual(outcome.deliverables?.items.map((entry) => entry.name), ["init.sql"]);
  // The declared SQL is not repeated as an "other changed file".
  assert.deepEqual(outcome.files.map((entry) => entry.filePath), ["/project/work/build.py"]);
  // And it is not repeated as a reply-text claim.
  assert.deepEqual(outcome.claimed.map((entry) => entry.filePath), ["/project/work/other.sql"]);
});

test("a turn without a declaration keeps the previous behaviour", () => {
  const outcome = buildTurnOutcome([
    { role: "assistant", content: [{ type: "toolCall", toolCallId: "w1", toolName: "write", input: { path: "a.ts" } }] },
    { role: "toolResult", toolCallId: "w1", content: [{ type: "text", text: "ok" }] },
  ], "/project");
  assert.equal(outcome.deliverables, null);
  assert.deepEqual(outcome.files.map((entry) => entry.filePath), ["/project/a.ts"]);
});
