import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./session-file-references-core.ts");
}

test("detects exact external file paths referenced in session entries", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "See [/home/me/.codex/config.toml:12](/home/me/.codex/config.toml:12)",
          },
        ],
      },
    },
  ];

  assert.equal(isFilePathReferencedByEntries("/home/me/.codex/config.toml", entries), true);
});

test("does not authorize sibling files by prefix match", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "See /home/me/.codex/config.toml.bak",
          },
        ],
      },
    },
  ];

  assert.equal(isFilePathReferencedByEntries("/home/me/.codex/config.toml", entries), false);
});

test("authorizes full output only from a bash execution message", async () => {
  const { isBashOutputPathReferencedByEntries } = await loadSubject();
  const outputPath = "/tmp/pi-bash-ab12.log";
  const bashEntry = {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "bashExecution",
      command: "printf test",
      output: "test",
      fullOutputPath: outputPath,
    },
  };
  const assistantEntry = {
    type: "message",
    id: "entry-2",
    parentId: "entry-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `mentioned ${outputPath}` }],
    },
  };

  assert.equal(isBashOutputPathReferencedByEntries(outputPath, [bashEntry]), true);
  assert.equal(isBashOutputPathReferencedByEntries(outputPath, [assistantEntry]), false);
  assert.equal(isBashOutputPathReferencedByEntries("/tmp/pi-bash-other.log", [bashEntry]), false);
});

test("validates session ids before resolving session paths", async () => {
  const { isValidSessionId } = await loadSubject();

  assert.equal(isValidSessionId("not-a-session-id"), false);
  assert.equal(isValidSessionId("../../sessions/foo"), false);
  assert.equal(isValidSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
});

test("authorizes exact saved-path image reference from codemode output while denying other /tmp files", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const savedImagePath = "/tmp/pi-codemode-7a8b9c0d1e2f3a4b.png";
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "codemode",
        content: [
          {
            type: "text",
            text: `[Image saved to ${savedImagePath} (image/png, 68 B)]`,
          },
          {
            type: "image",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5f0AAAAASUVORK5CYII=",
            mimeType: "image/png",
          },
        ],
      },
    },
    {
      type: "message",
      id: "entry-2",
      parentId: "entry-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Here is your render: ![generated image](${savedImagePath})`,
          },
        ],
      },
    },
  ];

  // Exact saved-path authorized
  assert.equal(isFilePathReferencedByEntries(savedImagePath, entries), true);

  // Other /tmp files, prefixes, extensions, and directories are denied
  assert.equal(isFilePathReferencedByEntries("/tmp/pi-codemode-other.png", entries), false);
  assert.equal(isFilePathReferencedByEntries(`${savedImagePath}.bak`, entries), false);
  assert.equal(isFilePathReferencedByEntries("/tmp/pi-codemode-7a8b9c0d1e2f3a4b.png.evil", entries), false);
  assert.equal(isFilePathReferencedByEntries("/tmp", entries), false);
  assert.equal(isFilePathReferencedByEntries("/tmp/", entries), false);
  assert.equal(isFilePathReferencedByEntries("/tmp/secret.env", entries), false);
});
