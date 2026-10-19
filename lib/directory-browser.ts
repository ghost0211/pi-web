import { mkdir, readdir, realpath, stat } from "fs/promises";
import { homedir } from "os";
import path from "path";

export interface BrowsableDirectory {
  name: string;
  path: string;
}

export function shouldShowWindowsDrivePicker(
  directory?: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && !directory;
}

export function getBrowseStartDirectory(directory?: string): string {
  return directory || homedir();
}

export function getWindowsDriveCandidates(): BrowsableDirectory[] {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => ({
    name: `${letter}:`,
    path: `${letter}:\\`,
  }));
}

export async function listWindowsDrives(): Promise<BrowsableDirectory[]> {
  const candidates = await Promise.all(getWindowsDriveCandidates().map(async (drive) => {
    try {
      const driveStat = await stat(drive.path);
      return driveStat.isDirectory() ? drive : null;
    } catch {
      return null;
    }
  }));

  return candidates.filter((drive): drive is BrowsableDirectory => drive !== null);
}

export function normalizeDirectory(directory: string): string {  if (directory === "~") return homedir();
  if (directory.startsWith("~/")) return path.resolve(homedir(), directory.slice(2));
  return path.resolve(directory);
}

/**
 * Validate a single directory name typed into the picker's "new folder" row.
 *
 * Only a leaf name is accepted: the caller supplies the parent directory, so
 * separators, traversal segments, drive letters and absolute paths are all
 * rejected rather than silently reinterpreted. Returns an error code instead
 * of throwing so the route can answer with a specific 400 message.
 */
export type DirectoryNameError =
  | "empty"
  | "too-long"
  | "path-separator"
  | "relative"
  | "absolute"
  | "trailing-dot"
  | "control-character"
  | "invalid-character"
  | "reserved-name";

const MAX_DIRECTORY_NAME_LENGTH = 120;
// Windows rejects these anywhere in a file name; reject them on every platform
// so a name typed on Linux still works after syncing the folder to Windows.
const INVALID_NAME_CHARACTERS = /[<>:"|?*]/;
// DOS device names stay reserved on Windows no matter what extension follows.
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

function isWindowsReservedDeviceName(name: string): boolean {
  const stem = name.split(".", 1)[0]?.trim().toLowerCase() ?? "";
  return WINDOWS_RESERVED_DEVICE_NAMES.has(stem);
}

/** Extra rule applied only where the filesystem itself enforces it. */
export function directoryNamePlatformRulesApply(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function validateNewDirectoryName(
  name: string,
  platform: NodeJS.Platform = process.platform,
): DirectoryNameError | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (trimmed.length > MAX_DIRECTORY_NAME_LENGTH) return "too-long";
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "control-character";
  if (trimmed.includes("/") || trimmed.includes("\\")) return "path-separator";
  if (trimmed === "." || trimmed === "..") return "relative";
  if (INVALID_NAME_CHARACTERS.test(trimmed)) return "invalid-character";
  if (path.win32.isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) return "absolute";
  if (isWindowsReservedDeviceName(trimmed)) return "reserved-name";
  if (directoryNamePlatformRulesApply(platform) && /[. ]$/.test(trimmed)) return "trailing-dot";
  return null;
}

/**
 * Create one directory directly inside `parent`.
 *
 * The parent must already exist and be a directory, and the new name must not
 * exist yet: creation never builds missing ancestors and never overwrites an
 * existing path, so a typo cannot silently create a chain of folders.
 */
export async function createDirectoryIn(
  parent: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ path: string } | { error: DirectoryNameError | "parent-missing" | "already-exists" }> {
  const invalid = validateNewDirectoryName(name, platform);
  if (invalid) return { error: invalid };

  const trimmed = name.trim();
  let resolvedParent: string;
  try {
    resolvedParent = await resolveDirectory(parent);
  } catch {
    return { error: "parent-missing" };
  }
  const parentStat = await stat(resolvedParent);
  if (!parentStat.isDirectory()) return { error: "parent-missing" };

  const target = path.join(resolvedParent, trimmed);
  try {
    await mkdir(target);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return { error: "already-exists" };
    throw cause;
  }
  // Report the canonical path so the picker can navigate into it immediately.
  return { path: await resolveDirectory(target) };
}

export function getParentDirectory(directory: string): string | null {
  const pathApi = /^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith("\\\\")
    ? path.win32
    : path.posix;
  const normalized = pathApi.normalize(directory);
  const parent = pathApi.dirname(normalized);
  return parent === normalized ? null : parent;
}

export async function resolveDirectory(directory: string): Promise<string> {
  return realpath(normalizeDirectory(directory));
}

export async function listDirectories(directory: string): Promise<BrowsableDirectory[]> {  const entries = await readdir(directory, { withFileTypes: true });
  // 忽略损坏、不可访问或不指向目录的符号链接。
  const candidates = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return { name: entry.name, path: path.join(directory, entry.name) };
    }
    if (!entry.isSymbolicLink()) return null;

    try {
      const entryPath = path.join(directory, entry.name);
      const realEntryPath = await realpath(entryPath);
      const entryStat = await stat(realEntryPath);
      if (!entryStat.isDirectory()) return null;
      return { name: entry.name, path: entryPath };
    } catch {
      return null;
    }
  }));

  return candidates
    .filter((entry): entry is BrowsableDirectory => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
