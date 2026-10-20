/**
 * Structured deliverables declared by the model through `present_files`.
 *
 * The turn's "results" card used to infer deliverables from reply text and
 * from write/edit calls, which cannot tell a final artifact apart from the
 * helper script that produced it. This contract lets the model say what it
 * actually produced; the card shows those first and keeps everything else
 * secondary.
 *
 * Only the tool's own `details` payload is trusted, and only after the server
 * probed each path. Anything malformed, unknown, or "missing" fails closed so a
 * stale or forged payload cannot fabricate a deliverable.
 */

export const PRESENT_FILES_TOOL_NAME = "present_files";
export const PRESENT_FILES_DETAILS_KIND = "pi-web-present-files/v1";
export const MAX_PRESENT_ITEMS = 12;
export const MAX_PRESENT_TITLE_LENGTH = 200;
export const MAX_PRESENT_CAPTION_LENGTH = 300;
export const MAX_PRESENT_PATH_LENGTH = 2048;

/** How the artifact can be shown. Server-classified; never model-supplied. */
export type PresentKind =
  | "image"
  | "video"
  | "audio"
  | "markdown"
  | "html"
  | "pdf"
  | "text"
  | "binary"
  | "dir"
  | "missing";

const PRESENT_KINDS = new Set<string>([
  "image", "video", "audio", "markdown", "html", "pdf", "text", "binary", "dir", "missing",
]);

export interface PresentItem {
  /** File name only, for the chip label. */
  name: string;
  /** Path as the model wrote it, kept for display when it is relative. */
  path: string;
  /** Absolute path in wire form (forward slashes) — what the viewer and API use. */
  abs: string;
  kind: PresentKind;
  caption?: string;
  /** Bytes, for files the server could stat. */
  size?: number;
  /** Modification time in epoch ms. */
  mtime?: number;
}

export interface PresentFilesDetails {
  kind: typeof PRESENT_FILES_DETAILS_KIND;
  version: 1;
  title?: string;
  note?: string;
  items: PresentItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Decode the tool's `details` payload.
 *
 * Returns null unless the payload carries the exact `kind` marker this version
 * wrote. `missing` items are dropped — the model asked to show them but the
 * server could not verify them, and showing an unverified path as a deliverable
 * is worse than showing nothing.
 */
export function parsePresentFilesDetails(details: unknown): PresentFilesDetails | null {
  if (!isRecord(details) || details.kind !== PRESENT_FILES_DETAILS_KIND) return null;
  if (!Array.isArray(details.items)) return null;

  const seen = new Set<string>();
  const items: PresentItem[] = [];
  for (const raw of details.items) {
    if (!isRecord(raw)) continue;
    if (typeof raw.kind !== "string" || !PRESENT_KINDS.has(raw.kind)) continue;
    if (raw.kind === "missing") continue;
    if (typeof raw.abs !== "string") continue;
    const abs = raw.abs.trim().slice(0, MAX_PRESENT_PATH_LENGTH);
    if (!abs) continue;
    // The same artifact declared twice is one deliverable.
    const key = abs.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const name = boundedString(raw.name, 255) ?? abs.replace(/\\/g, "/").split("/").pop() ?? abs;
    const path = boundedString(raw.path, MAX_PRESENT_PATH_LENGTH) ?? abs;
    items.push({
      name,
      path,
      abs,
      kind: raw.kind as PresentKind,
      ...(boundedString(raw.caption, MAX_PRESENT_CAPTION_LENGTH) ? { caption: boundedString(raw.caption, MAX_PRESENT_CAPTION_LENGTH)! } : {}),
      ...(nonNegativeNumber(raw.size) !== undefined ? { size: nonNegativeNumber(raw.size)! } : {}),
      ...(nonNegativeNumber(raw.mtime) !== undefined ? { mtime: nonNegativeNumber(raw.mtime)! } : {}),
    });
    if (items.length >= MAX_PRESENT_ITEMS) break;
  }

  if (items.length === 0) return null;
  const title = boundedString(details.title, MAX_PRESENT_TITLE_LENGTH);
  const note = boundedString(details.note, MAX_PRESENT_CAPTION_LENGTH);
  return {
    kind: PRESENT_FILES_DETAILS_KIND,
    version: 1,
    items,
    ...(title ? { title } : {}),
    ...(note ? { note } : {}),
  };
}

/** Normalized path key for cross-referencing other file sources. */
export function presentPathKey(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
