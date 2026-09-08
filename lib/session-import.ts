/**
 * Parsing/validation helpers for POST /api/sessions/import.
 * Kept separate from the route module: Next.js route files may only export
 * HTTP verbs and a fixed set of config fields.
 */

export interface ParsedSessionImport {
  header: {
    type: "session";
    id: string;
    cwd?: string;
    timestamp?: string;
    version?: number;
    [key: string]: unknown;
  };
  /** All lines; lines[0] is the serialized header and gets rewritten on save. */
  lines: string[];
}

/**
 * Parse and validate an uploaded session export. Every non-empty line must be
 * a JSON object with a string `type`; the first one must be a session header.
 */
export function parseSessionJsonl(content: string): ParsedSessionImport {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("File is empty");

  const lines = trimmed.split("\n");
  let header: ParsedSessionImport["header"];
  try {
    header = JSON.parse(lines[0]);
  } catch {
    throw new Error("First line is not valid JSON — not a pi session file");
  }
  if (header?.type !== "session" || typeof header.id !== "string" || !header.id) {
    throw new Error("First line is not a pi session header");
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let entry: { type?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`Line ${index + 1} is not valid JSON`);
    }
    if (typeof entry?.type !== "string") {
      throw new Error(`Line ${index + 1} is not a session entry`);
    }
  }
  return { header, lines };
}
