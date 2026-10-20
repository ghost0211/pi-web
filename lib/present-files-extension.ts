/**
 * `present_files` inline extension.
 *
 * Registers a model-only tool that lets the model *declare* which produced
 * files are the user-facing deliverables. The tool only probes: it stats each
 * path (inside the existing file-access allow-list, after resolving symlinks)
 * and returns a bounded `details` payload the chat renders as the primary
 * results row. It never reads file contents, never opens a window, and never
 * widens the file-access roots.
 *
 * Deliberately absent:
 * - no auto-open of a preview (`focus`): the user decides what to open;
 * - no file text in the model-facing result: pasting a report again is exactly
 *   the duplication this replaces;
 * - no extra model turn: the value is the transcript entry, not a notification.
 */
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";
import { resolveLocalFilePath } from "./file-links";
import { getAudioMime, getFileExt, getImageMime } from "./file-types";
import {
  MAX_PRESENT_CAPTION_LENGTH,
  MAX_PRESENT_ITEMS,
  MAX_PRESENT_PATH_LENGTH,
  MAX_PRESENT_TITLE_LENGTH,
  PRESENT_FILES_DETAILS_KIND,
  PRESENT_FILES_TOOL_NAME,
  type PresentFilesDetails,
  type PresentItem,
  type PresentKind,
} from "./present-files";

export const HOST_PRESENT_FILES_EXTENSION_NAME = "pi-web-present-files";

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);
const HTML_EXTS = new Set(["html", "htm", "xhtml"]);
/** Archives and executables: clearly not text, so the chip says so. */
const BINARY_EXTS = new Set([
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "exe", "dll", "so", "dylib", "bin", "jar", "class", "wasm",
  "xlsx", "xls", "doc", "ppt", "pptx", "odt", "ods",
]);

/**
 * Classify by extension only.
 *
 * The kind is a chip label, not a promise: the viewer decides what it can
 * render. Anything not recognised falls back to `text` because that is how the
 * viewer opens an unknown file (byte-capped, with its own binary notice).
 */
export function classifyPresentKind(filePath: string): PresentKind {
  const ext = getFileExt(filePath);
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (HTML_EXTS.has(ext)) return "html";
  if (ext === "pdf") return "pdf";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (getImageMime(filePath)) return "image";
  if (getAudioMime(filePath)) return "audio";
  if (BINARY_EXTS.has(ext)) return "binary";
  return "text";
}

function toWirePath(nativePath: string): string {
  return nativePath.replace(/\\/g, "/");
}

function summarize(items: readonly PresentItem[]): string {
  return items
    .map((item) => `- ${item.path}${item.caption ? ` (${item.caption})` : ""}`)
    .join("\n");
}

export interface PresentFilesExtensionOptions {
  /** Runtime switch re-checked per call, so a disabled feature cannot be used by a stale call. */
  enabled?: () => boolean;
  /** Session cwd used for workspace-relative paths when the tool context has none. */
  fallbackCwd?: string;
}

export function createPresentFilesExtension(options: PresentFilesExtensionOptions = {}): InlineExtension {
  return {
    name: HOST_PRESENT_FILES_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      const isEnabled = options.enabled ?? (() => true);
      pi.registerTool(defineTool({
        name: PRESENT_FILES_TOOL_NAME,
        label: "Present deliverables",
        // `model-only`: the model may call it, codemode scripts may not. The
        // result is a transcript entry for the user, not a programmatic API.
        exposure: "model-only",
        description: [
          "Declare the files you produced that the user should look at first (reports, exports, generated SQL, charts, images).",
          "The chat shows them as the turn's primary results with open and diff actions.",
          `Use workspace-relative or absolute paths, at most ${MAX_PRESENT_ITEMS} items.`,
          "Only paths that exist inside the allowed workspace are shown; anything else is dropped.",
          "Do not paste the file contents again after calling this.",
        ].join(" "),
        promptSnippet: "declare the produced files that are the user-facing deliverables",
        promptGuidelines: [
          "After producing a user-facing artifact (report, export, generated SQL, chart, image, document), call present_files once with those files instead of only mentioning the path in prose.",
          "Name the artifact that answers the user's request; leave helper scripts, caches and unrelated edits out of the list.",
          "Never call it for a path you have not written or generated this turn, and never repeat the same file twice in one turn.",
        ],
        parameters: Type.Object({
          title: Type.Optional(Type.String({ description: "Short heading for the results, e.g. 'Migration script'." })),
          note: Type.Optional(Type.String({ description: "One line of context shown above the files." })),
          items: Type.Array(
            Type.Object({
              path: Type.String({ description: "Workspace-relative or absolute path of a produced file." }),
              caption: Type.Optional(Type.String({ description: "What this file is, in a few words." })),
            }),
            { description: `Deliverable files (1-${MAX_PRESENT_ITEMS}).`, minItems: 1, maxItems: MAX_PRESENT_ITEMS },
          ),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          if (!isEnabled()) {
            throw new Error("present_files is disabled for this session");
          }
          const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : options.fallbackCwd;
          if (!cwd) throw new Error("present_files needs a session working directory");

          const requested = Array.isArray(params.items) ? params.items.slice(0, MAX_PRESENT_ITEMS) : [];
          if (requested.length === 0) throw new Error("present_files needs at least one item");

          const allowedRoots = await getAllowedFileRoots();
          const probed: PresentItem[] = [];
          for (const item of requested) {
            if (signal?.aborted) throw new Error("aborted");
            const rawPath = typeof item?.path === "string" ? item.path.trim().slice(0, MAX_PRESENT_PATH_LENGTH) : "";
            if (!rawPath) continue;
            const nativePath = resolveLocalFilePath(rawPath, cwd);
            if (!nativePath) continue;
            const abs = toWirePath(nativePath);
            const name = abs.split("/").pop() || rawPath;
            const caption = typeof item.caption === "string" && item.caption.trim()
              ? item.caption.trim().slice(0, MAX_PRESENT_CAPTION_LENGTH)
              : undefined;
            const base = { name, path: rawPath, abs, ...(caption ? { caption } : {}) };

            // Two checks on purpose: the lexical one rejects traversal before
            // touching the disk, the realpath one rejects a link that escapes
            // the allow-list. Neither adds a root; a path the user cannot open
            // in the viewer is not presentable.
            if (!isFilePathAllowed(nativePath, allowedRoots)
              || !isExistingFilePathAllowed(nativePath, allowedRoots)) {
              probed.push({ ...base, kind: "missing" });
              continue;
            }
            try {
              const entryStat = await stat(realpathSync(nativePath));
              if (entryStat.isDirectory()) {
                probed.push({ ...base, kind: "dir", mtime: entryStat.mtimeMs });
              } else if (entryStat.isFile()) {
                probed.push({
                  ...base,
                  kind: classifyPresentKind(name),
                  size: entryStat.size,
                  mtime: entryStat.mtimeMs,
                });
              } else {
                probed.push({ ...base, kind: "missing" });
              }
            } catch {
              probed.push({ ...base, kind: "missing" });
            }
          }

          const shown = probed.filter((item) => item.kind !== "missing");
          const missing = probed.filter((item) => item.kind === "missing");
          if (shown.length === 0) {
            // Fail closed and tell the model why, so it can correct the path
            // instead of believing the user saw something.
            throw new Error(`No presentable file: ${missing.map((item) => item.path).join(", ")}`);
          }

          const title = typeof params.title === "string" && params.title.trim()
            ? params.title.trim().slice(0, MAX_PRESENT_TITLE_LENGTH)
            : undefined;
          const note = typeof params.note === "string" && params.note.trim()
            ? params.note.trim().slice(0, MAX_PRESENT_CAPTION_LENGTH)
            : undefined;
          const details: PresentFilesDetails = {
            kind: PRESENT_FILES_DETAILS_KIND,
            version: 1,
            items: probed,
            ...(title ? { title } : {}),
            ...(note ? { note } : {}),
          };

          return {
            content: [{
              type: "text",
              text: [
                `Shown to the user as the turn's primary results (${shown.length} file${shown.length === 1 ? "" : "s"}):`,
                summarize(shown),
                ...(missing.length > 0
                  ? [`Not shown (missing or outside the allowed workspace): ${missing.map((item) => item.path).join(", ")}`]
                  : []),
                "Do not paste these files' contents again; refer to them by name.",
              ].join("\n"),
            }],
            details,
          };
        },
      }));
    },
  };
}

/** Keep the path relative to `cwd` for display when it lives under it. */
export function relativeForDisplay(abs: string, cwd?: string): string {
  if (!cwd) return abs;
  const normalizedAbs = abs.replace(/\\/g, "/");
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedCwd) return abs;
  if (normalizedAbs === normalizedCwd) return ".";
  const prefix = `${normalizedCwd}/`;
  return normalizedAbs.startsWith(prefix) ? normalizedAbs.slice(prefix.length) : abs;
}

/** Exported for tests: the same normalization the tool applies to a path. */
export function normalizePresentPath(rawPath: string, cwd: string): string | null {
  const resolved = resolveLocalFilePath(rawPath, cwd);
  return resolved ? toWirePath(path.normalize(resolved)) : null;
}
