/**
 * Text file attachments for the composer.
 *
 * Pi's agent runtime only accepts text and image content blocks in messages,
 * so arbitrary files cannot be attached directly. Text files (code, SQL, logs,
 * markdown, etc.) are inlined into the message as a labeled code block; binary
 * files are rejected for now (see the extension-based roadmap).
 */

export const MAX_ATTACHED_TEXT_FILE_BYTES = 200 * 1024; // 200 KB
/** Binary attachments travel as base64 in a labeled block; cap keeps messages sane. */
export const MAX_ATTACHED_BINARY_FILE_BYTES = 2 * 1024 * 1024; // 2 MB
/** Never inline a binary file larger than this by bytes (encoded ×1.37). */
export const MAX_ATTACHED_BINARY_BASE64_CHARS = Math.ceil(MAX_ATTACHED_BINARY_FILE_BYTES * 4 / 3) + 16;
export const MAX_ATTACHED_TEXT_FILES = 5;
export const MAX_ATTACHED_BINARY_FILES = 3;

export interface AttachedTextFile {
  /** Original file name, e.g. "schema.sql". */
  name: string;
  /** Detected or declared text content. */
  content: string;
  /** MIME type from the file, if any (may be empty). */
  mimeType?: string;
  /** Size in bytes of the original file. */
  size: number;
}

export interface AttachedBinaryFile {
  /** Original file name, e.g. "report.pdf". */
  name: string;
  /** Base64-encoded content (no data: prefix). */
  data: string;
  /** MIME type from the file, if any (may be empty). */
  mimeType?: string;
  /** Size in bytes of the original file. */
  size: number;
}

const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/sql"];
const TEXT_EXTENSIONS = new Set([
  // Source & markup
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cs", "php", "sql", "sh", "bash", "zsh", "fish", "ps1",
  "md", "mdx", "markdown", "txt", "log", "csv", "tsv", "json", "jsonl", "xml",
  "yaml", "yml", "toml", "ini", "conf", "cfg", "env", "gitignore", "dockerfile",
  "html", "htm", "css", "scss", "less", "vue", "svelte", "astro", "graphql",
  "proto", "prisma", "lock", "diff", "patch", "rst", "tex", "org", "properties",
  "gradle", "nim", "lua", "pl", "pm", "r", "swift", "dart", "zig", "clj", "ex",
  "exs", "erl", "hrl", "fs", "fsx", "vb", "vbs", "asm", "s", "scala", "groovy",
]);

function extensionOf(name: string): string {
  return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

/** Whether the file is likely text (by MIME type or extension). */
export function isLikelyTextFile(name: string, mimeType: string | undefined): boolean {
  const ext = extensionOf(name);
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (mimeType && TEXT_MIME_PREFIXES.some((prefix) => mimeType.toLowerCase().startsWith(prefix))) return true;
  // Unknown but common text-ish MIME types.
  if (mimeType && /^application\/(x-)?(text|json|xml|sql|yaml|toml|javascript|typescript)\b/.test(mimeType.toLowerCase())) {
    return true;
  }
  return false;
}

/** Strip UTF-8 BOM and NUL bytes so inline content stays clean. */
export function sanitizeTextContent(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .replace(/\0/g, "\uFFFD");
}

/**
 * Build the message text that inlines a text file. The labeled fence gives the
 * model the file identity; `language` drives syntax highlighting and file
 * semantics (e.g. sql, json, md).
 */
export function inlineTextFileAttachment(file: AttachedTextFile): string {
  const language = extensionOf(file.name);
  const safeName = file.name.replace(/[`\n\r]/g, " ");
  return `[File attachment: ${safeName}${file.size > 0 ? ` (${file.size} bytes)` : ""}]\n\`\`\`${language}\n${sanitizeTextContent(file.content)}\n\`\`\``;
}

/** Build the message that appends inlined file attachments after user text. */
export function buildMessageWithTextAttachments(message: string, files: AttachedTextFile[]): string {
  const inlined = files.map(inlineTextFileAttachment).join("\n\n");
  if (!message.trim()) return inlined;
  return `${message.trim()}\n\n${inlined}`;
}

/**
 * Build the labeled base64 block that the attachment extension decodes and
 * writes to `<cwd>/.pi-web-attachments/` so the agent can read/parse it.
 */
export function encodeBinaryFileAttachment(file: AttachedBinaryFile): string {
  const safeName = file.name.replace(/[\n\r]/g, " ");
  const size = file.size > 0 ? ` size="${file.size}"` : "";
  return `[pi-web binary attachment: name="${safeName}"${size} encoding="base64"]\n${file.data}\n[/pi-web binary attachment]`;
}

/** Build the message that appends binary attachment blocks after user text. */
export function buildMessageWithBinaryAttachments(message: string, files: AttachedBinaryFile[]): string {
  const blocks = files.map(encodeBinaryFileAttachment).join("\n\n");
  if (!message.trim()) return blocks;
  return `${message.trim()}\n\n${blocks}`;
}
