import { resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Settings-editor helpers for the `enabledModels` model scope (the persisted
 * form of pi's `/scoped-models` selection).
 *
 * Semantics mirrored from the TUI selector:
 * - Setting absent/undefined → every available model is offered.
 * - A stored list restricts the selector to those models; models from
 *   providers added later stay unselected until explicitly checked.
 * - Persisting with every available model checked clears the setting
 *   (writes `undefined`), which is the "no restriction" state.
 */

export interface ResolvedModelScopeSelection {
  /** `null` means "no stored selection" — all models are effectively enabled. */
  enabledIds: string[] | null;
  /** Patterns in the stored selection that matched no available model. */
  warnings: string[];
}

/** Resolve stored `enabledModels` patterns to concrete `provider/modelId` ids. */
export async function resolveEnabledModelIds(
  patterns: readonly string[] | undefined,
  allModels: readonly Model<Api>[],
): Promise<ResolvedModelScopeSelection> {
  if (!patterns || patterns.length === 0) return { enabledIds: null, warnings: [] };
  // Same snapshot-runtime approach as resolveVisibleModels: the exported
  // resolver takes a ModelRuntime, so feed it the already-loaded list.
  const snapshotRuntime = {
    getAvailable: async () => allModels,
  } as Parameters<typeof resolveModelScopeWithDiagnostics>[1];
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics([...patterns], snapshotRuntime);
  const enabledIds = [
    ...new Set(scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)),
  ];
  // Match pi's /scoped-models selector: keep no-match entries visible as
  // unavailable selections so a temporary auth/provider outage does not
  // silently delete them the next time the user saves.
  for (const diagnostic of diagnostics) {
    if (diagnostic.code === "no-match" && !enabledIds.includes(diagnostic.pattern)) {
      enabledIds.push(diagnostic.pattern);
    }
  }
  return { enabledIds, warnings: diagnostics.map((diagnostic) => diagnostic.message) };
}

/**
 * Normalize a checkbox selection for persistence.
 * A full (or empty) selection stores `undefined` — both states resolve to
 * "all models" at runtime (see lib/model-scope.ts fallback), and `undefined`
 * keeps the settings file in the canonical unrestricted form.
 */
export function computeEnabledModelsForSave(
  enabledIds: readonly string[],
  allIds: readonly string[],
): string[] | undefined {
  const enabledSet = new Set(enabledIds);
  const allSet = new Set(allIds);
  const unavailablePatterns = enabledIds.filter((id) => !allSet.has(id));
  const allEnabled = allIds.length > 0
    && allIds.every((id) => enabledSet.has(id));
  if ((allEnabled && unavailablePatterns.length === 0) || enabledSet.size === 0) return undefined;
  // Preserve model catalog order (which controls cycling/startup fallback),
  // followed by unavailable patterns in their original stored order.
  return [
    ...allIds.filter((id) => enabledSet.has(id)),
    ...unavailablePatterns,
  ];
}
