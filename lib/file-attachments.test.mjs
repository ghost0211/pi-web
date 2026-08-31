import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./file-attachments.ts");
  } catch {
    return import("./file-attachments.ts");
  }
}

const {
  isLikelyTextFile,
  buildMessageWithTextAttachments,
  inlineTextFileAttachment,
  sanitizeTextContent,
} = await loadSubject();

test("detects text files by extension and MIME type", () => {
  assert.equal(isLikelyTextFile("schema.sql", "application/sql"), true);
  assert.equal(isLikelyTextFile("index.ts", ""), true);
  assert.equal(isLikelyTextFile("README.md", ""), true);
  assert.equal(isLikelyTextFile("data.json", "application/json"), true);
  assert.equal(isLikelyTextFile("server.log", ""), true);
  assert.equal(isLikelyTextFile("photo.png", "image/png"), false);
  assert.equal(isLikelyTextFile("archive.zip", "application/zip"), false);
  assert.equal(isLikelyTextFile("unknown.xyz", ""), false);
});

test("sanitizes BOM and NUL bytes from inline content", () => {
  assert.equal(sanitizeTextContent("\uFEFFhello\u0000world"), "hello\uFFFDworld");
  assert.equal(sanitizeTextContent("plain"), "plain");
});

test("inlines a text file as a labeled code block", () => {
  const output = inlineTextFileAttachment({
    name: "schema.sql",
    content: "CREATE TABLE t (id INT);",
    size: 543,
  });
  assert.equal(
    output,
    "[File attachment: schema.sql (543 bytes)]\n```sql\nCREATE TABLE t (id INT);\n```",
  );
});

test("appends inlined files after user text", () => {
  const output = buildMessageWithTextAttachments("分析这个文件", [{
    name: "data.csv",
    content: "a,b\n1,2",
    size: 12,
  }]);
  assert.equal(
    output,
    "分析这个文件\n\n[File attachment: data.csv (12 bytes)]\n```csv\na,b\n1,2\n```",
  );
  // Files only (no text): just the inlined block.
  assert.equal(
    buildMessageWithTextAttachments("", [{ name: "x.log", content: "line", size: 4 }]),
    "[File attachment: x.log (4 bytes)]\n```log\nline\n```",
  );
});
