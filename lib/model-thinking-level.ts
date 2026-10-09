import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { normalizeThinkingLevelOption, type ThinkingLevelOption } from "./thinking-level-options";

/** Resolve a model's own preference without inheriting the active model's level. */
export function resolveModelThinkingLevel(
  model: Model<Api>,
  preference: ThinkingLevelOption = "auto",
  modelDefault?: string,
): ModelThinkingLevel {
  const available = getSupportedThinkingLevels(model);
  const selected = normalizeThinkingLevelOption(preference, available);
  if (selected !== "auto") return selected;
  const configured = normalizeThinkingLevelOption(modelDefault, available);
  // SDK default is medium; its native clamp understands each model's map.
  return configured !== "auto" ? configured : clampThinkingLevel(model, "medium");
}
