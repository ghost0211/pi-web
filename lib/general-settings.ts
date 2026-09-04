import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";

const THINKING_LEVELS = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PROJECT_TRUST_VALUES = new Set(["prompt", "auto", "never"]);

export interface GeneralSettings {
  theme: string;
  defaultThinkingLevel: string;
  compactionEnabled: boolean;
  retryEnabled: boolean;
  quietStartup: boolean;
  hideThinkingBlock: boolean;
  defaultProjectTrust: "prompt" | "auto" | "never";
  enableSkillCommands: boolean;
}

export type GeneralSettingsPatch = Partial<Omit<GeneralSettings, "theme">>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("Invalid settings.json: expected an object");
  return parsed;
}

function nestedEnabled(
  settings: Record<string, unknown>,
  nestedKey: "compaction" | "retry",
  legacyKey: "compactionEnabled" | "retryEnabled",
): boolean {
  const nested = settings[nestedKey];
  if (isRecord(nested) && typeof nested.enabled === "boolean") return nested.enabled;
  return settings[legacyKey] !== false;
}

export function toGeneralSettings(settings: Record<string, unknown>): GeneralSettings {
  const storedThinking = settings.defaultThinkingLevel;
  const storedTrust = settings.defaultProjectTrust;
  return {
    theme: typeof settings.theme === "string" ? settings.theme : "auto",
    defaultThinkingLevel: typeof storedThinking === "string" && THINKING_LEVELS.has(storedThinking)
      ? storedThinking
      : "auto",
    compactionEnabled: nestedEnabled(settings, "compaction", "compactionEnabled"),
    retryEnabled: nestedEnabled(settings, "retry", "retryEnabled"),
    quietStartup: settings.quietStartup === true,
    hideThinkingBlock: settings.hideThinkingBlock === true,
    defaultProjectTrust: storedTrust === "always" || storedTrust === "auto"
      ? "auto"
      : storedTrust === "never"
        ? "never"
        : "prompt",
    enableSkillCommands: settings.enableSkillCommands !== false,
  };
}

function requireBoolean(body: Record<string, unknown>, key: keyof GeneralSettingsPatch): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

export function parseGeneralSettingsPatch(value: unknown): GeneralSettingsPatch {
  if (!isRecord(value)) throw new Error("Expected a JSON object");

  const patch: GeneralSettingsPatch = {};
  if (value.defaultThinkingLevel !== undefined) {
    if (typeof value.defaultThinkingLevel !== "string" || !THINKING_LEVELS.has(value.defaultThinkingLevel)) {
      throw new Error("defaultThinkingLevel is invalid");
    }
    patch.defaultThinkingLevel = value.defaultThinkingLevel;
  }
  if (value.defaultProjectTrust !== undefined) {
    if (typeof value.defaultProjectTrust !== "string" || !PROJECT_TRUST_VALUES.has(value.defaultProjectTrust)) {
      throw new Error("defaultProjectTrust is invalid");
    }
    patch.defaultProjectTrust = value.defaultProjectTrust as GeneralSettings["defaultProjectTrust"];
  }

  for (const key of [
    "compactionEnabled",
    "retryEnabled",
    "quietStartup",
    "hideThinkingBlock",
    "enableSkillCommands",
  ] as const) {
    const setting = requireBoolean(value, key);
    if (setting !== undefined) patch[key] = setting;
  }
  return patch;
}

function applyPatch(settings: Record<string, unknown>, patch: GeneralSettingsPatch): Record<string, unknown> {
  const next = { ...settings };

  if (patch.defaultThinkingLevel !== undefined) {
    if (patch.defaultThinkingLevel === "auto") delete next.defaultThinkingLevel;
    else next.defaultThinkingLevel = patch.defaultThinkingLevel;
  }
  if (patch.compactionEnabled !== undefined) {
    const current = isRecord(next.compaction) ? next.compaction : {};
    next.compaction = { ...current, enabled: patch.compactionEnabled };
    delete next.compactionEnabled;
  }
  if (patch.retryEnabled !== undefined) {
    const current = isRecord(next.retry) ? next.retry : {};
    next.retry = { ...current, enabled: patch.retryEnabled };
    delete next.retryEnabled;
  }
  if (patch.quietStartup !== undefined) next.quietStartup = patch.quietStartup;
  if (patch.hideThinkingBlock !== undefined) next.hideThinkingBlock = patch.hideThinkingBlock;
  if (patch.enableSkillCommands !== undefined) next.enableSkillCommands = patch.enableSkillCommands;
  if (patch.defaultProjectTrust !== undefined) {
    next.defaultProjectTrust = patch.defaultProjectTrust === "auto"
      ? "always"
      : patch.defaultProjectTrust === "prompt"
        ? "ask"
        : "never";
  }
  return next;
}

export async function readGeneralSettings(path: string): Promise<GeneralSettings> {
  if (!existsSync(path)) return toGeneralSettings({});
  const release = await lockfile.lock(path, { realpath: false, retries: 10 });
  try {
    return toGeneralSettings(parseSettings(path));
  } finally {
    await release();
  }
}

export async function updateGeneralSettings(
  path: string,
  patch: GeneralSettingsPatch,
): Promise<GeneralSettings> {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, "{}", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const release = await lockfile.lock(path, { realpath: false, retries: 10 });
  try {
    const next = applyPatch(parseSettings(path), patch);
    writePrivateFileAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`);
    return toGeneralSettings(next);
  } finally {
    await release();
  }
}
