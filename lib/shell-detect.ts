/**
 * Windows shell detection for the Shell tool setting. The model-facing tools
 * are fixed by pi (`bash` and `powershell`), but the user should be able to
 * pick among what is actually installed: PowerShell (7 preferred by pi),
 * auto-detected Bash, or a specific bash.exe (Git Bash / WSL / Cygwin /
 * MSYS2) via the `shellPath` setting.
 *
 * Pure detection: injectable `exists`/`where` for tests; no writes.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface ShellOption {
  /** Stable id used by the settings UI and API. */
  id: string;
  tool: "bash" | "powershell";
  /** Explicit executable path; null means pi's own auto-detection. */
  path: string | null;
  /** i18n key suffix for the human-readable label. */
  labelKey: "powershell" | "bashAuto" | "gitBash" | "wslBash" | "bashPath";
}

export const SHELL_OPTION_POWERSHELL = "powershell";
export const SHELL_OPTION_BASH_AUTO = "bash-auto";

export function shellOptionId(tool: "bash" | "powershell", path: string | null): string {
  if (tool === "powershell") return SHELL_OPTION_POWERSHELL;
  return path ? `bash:${path}` : SHELL_OPTION_BASH_AUTO;
}

function defaultWhere(executable: string): string[] {
  try {
    const result = spawnSync("where", [executable], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export interface DetectShellDeps {
  exists?: (path: string) => boolean;
  where?: (executable: string) => string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * List shell choices that actually exist on this machine. Always includes the
 * generic entries (PowerShell auto, Bash auto-detect) so the UI stays usable
 * even when detection fails; explicit-path entries are added when found.
 */
export function detectWindowsShells(deps: DetectShellDeps = {}): ShellOption[] {
  const exists = deps.exists ?? existsSync;
  const where = deps.where ?? defaultWhere;
  const env = deps.env ?? process.env;

  const options: ShellOption[] = [
    { id: SHELL_OPTION_POWERSHELL, tool: "powershell", path: null, labelKey: "powershell" },
    { id: SHELL_OPTION_BASH_AUTO, tool: "bash", path: null, labelKey: "bashAuto" },
  ];

  const seen = new Set<string>();
  const addBash = (path: string, labelKey: ShellOption["labelKey"]) => {
    const key = path.replace(/\//g, "\\").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ id: shellOptionId("bash", path), tool: "bash", path, labelKey });
  };

  // Git Bash in the canonical install locations (pi's own lookup order).
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (!root) continue;
    const candidate = `${root}\\Git\\bin\\bash.exe`;
    if (exists(candidate)) addBash(candidate, "gitBash");
  }

  // bash.exe on PATH (Cygwin, MSYS2, ...). Skips the legacy WSL launcher,
  // which is listed separately below.
  for (const found of where("bash.exe")) {
    if (!exists(found)) continue;
    if (/^[a-z]:\\windows\\(system32|sysnative)\\bash\.exe$/i.test(found.replace(/\//g, "\\"))) continue;
    addBash(found, "bashPath");
  }

  // Legacy WSL bash launcher (pi feeds it commands over stdin).
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const wslBash = `${systemRoot}\\System32\\bash.exe`;
  if (exists(wslBash)) addBash(wslBash, "wslBash");

  return options;
}
