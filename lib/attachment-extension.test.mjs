import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./attachment-extension.ts");
  } catch {
    return import("./attachment-extension.ts");
  }
}

const {
  parseAttachmentHeader,
  extractAttachmentBlocks,
  ATTACHMENT_OPEN_TAG,
  ATTACHMENT_CLOSE_TAG,
} = await loadSubject();

test("parses attachment header fields", () => {
  assert.deepEqual(
    parseAttachmentHeader('[pi-web binary attachment: name="report.pdf" size="12345" encoding="base64"]'),
    { name: "report.pdf", size: 12345, encoding: "base64" },
  );
  assert.deepEqual(
    parseAttachmentHeader('[pi-web binary attachment: name=data.bin encoding=base64]'),
    { name: "data.bin", size: 0, encoding: "base64" },
  );
  assert.equal(parseAttachmentHeader("not an attachment"), null);
  assert.equal(parseAttachmentHeader('[pi-web binary attachment: name="x" encoding="hex"]'), null);
});

test("extracts one or more attachment blocks and strips them from the message", () => {
  const message = [
    "Analyze this PDF",
    "",
    "[pi-web binary attachment: name=\"a.pdf\" size=\"10\" encoding=\"base64\"]",
    "AAAA",
    "[/pi-web binary attachment]",
    "",
    "[pi-web binary attachment: name=\"b.zip\" size=\"20\" encoding=\"base64\"]",
    "BBBB",
    "[/pi-web binary attachment]",
  ].join("\n");

  const { blocks, rest } = extractAttachmentBlocks(message);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].header, '[pi-web binary attachment: name="a.pdf" size="10" encoding="base64"]');
  assert.equal(blocks[0].data, "AAAA");
  assert.equal(blocks[1].data, "BBBB");
  assert.equal(rest.trim(), "Analyze this PDF");
});

test("does not split when the close tag is missing", () => {
  const message = `${ATTACHMENT_OPEN_TAG} name="x" encoding="base64"]\nAAAA`;
  const { blocks } = extractAttachmentBlocks(message);
  assert.equal(blocks.length, 0);
});

test("round-trips without blocks", () => {
  const { blocks, rest } = extractAttachmentBlocks("hello world");
  assert.equal(blocks.length, 0);
  assert.equal(rest, "hello world");
});

test("block tags are exported constants", () => {
  assert.equal(ATTACHMENT_OPEN_TAG, "[pi-web binary attachment:");
  assert.equal(ATTACHMENT_CLOSE_TAG, "[/pi-web binary attachment]");
});
