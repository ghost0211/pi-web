export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
  parameters?: Record<string, unknown>;
  promptGuidelines?: string[];
}

export const TOOL_PRESET_VALUES = ["none", "read-only", "default", "full"] as const;
export type ToolPreset = typeof TOOL_PRESET_VALUES[number];

export const PRESET_NONE: string[] = [];
export const PRESET_READ_ONLY: string[] = ["read", "grep", "find", "ls"];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write"];
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls"];

export const BUILTIN_TOOL_NAMES = new Set([...PRESET_FULL, "powershell"]);

/** Every built-in tool the custom picker can toggle individually. */
export const BUILTIN_SELECTABLE_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

/** "custom": an arbitrary user-picked combination that matches no preset. */
export const CUSTOM_TOOL_PRESET = "custom" as const;
export type ToolPresetSelection = ToolPreset | typeof CUSTOM_TOOL_PRESET;

export function isToolPreset(value: unknown): value is ToolPreset {
  return typeof value === "string" && (TOOL_PRESET_VALUES as readonly string[]).includes(value);
}

function builtinSelectionKey(toolNames: readonly string[]): string {
  return toolNames
    .map((name) => name === "powershell" ? "bash" : name)
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
    .sort()
    .join(",");
}

/**
 * Like {@link getPresetFromToolNames}, but reports combinations that match no
 * preset as "custom" instead of falling back to "default".
 */
export function matchToolPresetOrCustom(toolNames: readonly string[]): ToolPresetSelection {
  if (toolNames.length === 0) return "none";
  const active = builtinSelectionKey(toolNames);
  if (active === [...PRESET_READ_ONLY].sort().join(",")) return "read-only";
  if (active === [...PRESET_DEFAULT].sort().join(",")) return "default";
  if (active === [...PRESET_FULL].sort().join(",")) return "full";
  return "custom";
}

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = tools.filter((t) => t.active);
  return getPresetFromToolNames(activeTools.map((tool) => tool.name));
}

export function getPresetFromToolNames(toolNames: readonly string[]): ToolPreset {
  const matched = matchToolPresetOrCustom(toolNames);
  return matched === "custom" ? "default" : matched;
}

export function getToolNamesForPreset(preset: ToolPreset): string[] {
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "read-only") return [...PRESET_READ_ONLY];
  if (preset === "full") return [...PRESET_FULL];
  return [...PRESET_DEFAULT];
}
