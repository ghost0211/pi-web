export function normalizeFilePathSlashes(filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

export function encodeFilePathForApi(filePath: string): string {
  return normalizeFilePathSlashes(filePath)
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

export function getFileName(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  return normalized.split("/").pop() ?? normalized;
}

export function getFileDirectory(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath).replace(/\/+$/, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return "/";
  if (lastSlash === 2 && /^[a-zA-Z]:\//.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, lastSlash);
}

export function getRelativeFilePath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;

  const normalizedFile = normalizeFilePathSlashes(filePath);
  const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
  if (normalizedFile.startsWith(normalizedCwd + "/")) {
    return normalizedFile.slice(normalizedCwd.length + 1);
  }
  return filePath;
}

export function joinFilePath(parent: string, child: string): string {
  return `${normalizeFilePathSlashes(parent).replace(/\/$/, "")}/${child}`;
}

/**
 * Resolve a viewer path into an absolute path for the desktop shell's
 * open/reveal commands. Absolute inputs (drive, UNC, POSIX) pass through;
 * workspace-relative ones are joined onto `cwd`. Returns null when the path
 * cannot be made absolute, which is why the desktop actions are hidden for it.
 */
export function toAbsoluteFilePath(filePath: string, cwd?: string | null): string | null {
  const normalized = normalizeFilePathSlashes(filePath);
  if (!normalized) return null;
  if (isAbsoluteFilePath(normalized)) return normalized;
  if (!cwd) return null;
  // Re-normalize after joining: `normalizeFilePathSlashes` only rewrites
  // separators for absolute inputs, so a relative `src\a.ts` would otherwise
  // stay mixed once the (Windows) cwd prefix is prepended.
  return normalizeFilePathSlashes(joinFilePath(cwd, normalized));
}

function isAbsoluteFilePath(normalized: string): boolean {
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//") || normalized.startsWith("/");
}
