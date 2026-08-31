/**
 * Built-in binary-attachment extension.
 *
 * pi-web inlines non-image files into the user message as a labeled base64
 * block (see lib/file-attachments.ts). This extension listens for the `input`
 * event, decodes those blocks, writes them under `<cwd>/.pi-web-attachments/`,
 * and rewrites the message so the agent can read/parse the file with its own
 * tools (read text/known types, bash for PDFs/archives, etc.).
 *
 * Attachment URL:  [pi-web binary attachment: name="report.pdf" size="12345" encoding="base64"]...[/pi-web binary attachment]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

export const ATTACHMENT_DIR_NAME = ".pi-web-attachments";
export const ATTACHMENT_OPEN_TAG = "[pi-web binary attachment:";
export const ATTACHMENT_CLOSE_TAG = "[/pi-web binary attachment]";

const ATTACHMENT_LINE_RE = /^\[pi-web binary attachment:([^\]]*)\]$/;
const ATTACHMENT_FIELD_RE = /(\w+)=(?:"([^"]*)"|([^\s]+))/g;

/** Parse attachment metadata line: `name="x.pdf" size=123 encoding=base64`. */
export function parseAttachmentHeader(line: string): { name: string; size: number; encoding: string } | null {
  const match = line.match(ATTACHMENT_LINE_RE);
  if (!match) return null;
  const fields: Record<string, string> = {};
  const src = match[1];
  let fieldMatch: RegExpExecArray | null;
  ATTACHMENT_FIELD_RE.lastIndex = 0;
  while ((fieldMatch = ATTACHMENT_FIELD_RE.exec(src)) !== null) {
    fields[fieldMatch[1]] = fieldMatch[2] ?? fieldMatch[3] ?? "";
  }
  const name = fields.name || "attachment";
  const size = Number.parseInt(fields.size ?? "0", 10);
  const encoding = fields.encoding || "base64";
  if (encoding !== "base64") return null;
  return { name, size: Number.isFinite(size) ? size : 0, encoding: "base64" };
}

/** Extract `[pi-web binary attachment: ...]...[/...]` blocks from a message. */
export function extractAttachmentBlocks(text: string): { blocks: { header: string; data: string }[]; rest: string } {
  const blocks: { header: string; data: string }[] = [];
  let rest = text;
  let openIndex = rest.indexOf(ATTACHMENT_OPEN_TAG);
  while (openIndex !== -1) {
    const closeIndex = rest.indexOf(ATTACHMENT_CLOSE_TAG, openIndex);
    if (closeIndex === -1) break;
    const headerEnd = rest.indexOf("\n", openIndex);
    const header = headerEnd !== -1
      ? rest.slice(openIndex, headerEnd)
      : rest.slice(openIndex, closeIndex);
    const dataStart = headerEnd !== -1 ? headerEnd + 1 : closeIndex;
    blocks.push({
      header: header.trim(),
      data: rest.slice(dataStart, closeIndex).trim(),
    });
    rest = rest.slice(0, openIndex) + rest.slice(closeIndex + ATTACHMENT_CLOSE_TAG.length);
    openIndex = rest.indexOf(ATTACHMENT_OPEN_TAG);
  }
  return { blocks, rest };
}

function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[^\w.\- ]/g, "_").slice(0, 120);
  return base || "attachment";
}

function decodeBase64(data: string): Buffer | null {
  const normalized = data.replace(/\s+/g, "");
  if (!normalized) return null;
  try {
    return Buffer.from(normalized, "base64");
  } catch {
    return null;
  }
}

export function createBinaryAttachmentExtension(): InlineExtension {
  return {
    name: "pi-web-binary-attachments",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("input", async (event, ctx) => {
        const { blocks, rest } = extractAttachmentBlocks(event.text);
        if (blocks.length === 0 || event.source === "extension") {
          return { action: "continue" };
        }

        const dir = join(ctx.cwd, ATTACHMENT_DIR_NAME);
        try {
          await mkdir(dir, { recursive: true });
        } catch {
          // Directory creation is best-effort; individual writes report failure.
        }

        const saved: string[] = [];
        let failed = false;
        for (const block of blocks) {
          const header = parseAttachmentHeader(block.header);
          if (!header) {
            failed = true;
            continue;
          }
          const buffer = decodeBase64(block.data);
          if (!buffer) {
            failed = true;
            continue;
          }
          const fileName = `${randomUUID().slice(0, 8)}-${sanitizeFileName(header.name)}`;
          try {
            await writeFile(join(dir, fileName), buffer);
            saved.push(`${ATTACHMENT_DIR_NAME}/${fileName}`);
          } catch {
            failed = true;
          }
        }

        const originalText = rest.trim();
        const attachmentNote = saved.length
          ? saved.map((path) => `[Attachment saved: ${path}]`).join("\n") + "\n"
          : "";
        const failureNote = failed ? "[Warning: one or more attachments could not be saved.]\n" : "";
        const guide = "Attached files are on disk. Read or parse them with your tools (read for text; bash for archives/PDFs/binary). ";
        const text = `${guide}${failureNote}${attachmentNote}${originalText ? `\n\n${originalText}` : ""}`.trim();
        return { action: "transform", text };
      });
    },
  };
}
