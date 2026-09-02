import { homedir } from "os";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { invalidateModelsCache } from "@/lib/models-cache";
import { computeEnabledModelsForSave, resolveEnabledModelIds } from "@/lib/model-scope-setting";

export const dynamic = "force-dynamic";

/**
 * GET/PUT the global `enabledModels` model scope (pi's `/scoped-models`).
 *
 * The scope is global, so services use the home directory and GET reads
 * getGlobalSettings() explicitly; otherwise a project-level override could be
 * shown while PUT silently wrote a different global value.
 */

interface ScopeModelEntry {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
}

async function createScopeServices() {
  return createAgentSessionServices({ cwd: homedir(), agentDir: getAgentDir() });
}

function toEntries(models: readonly { provider: string; id: string; name: string; contextWindow?: number }[]): ScopeModelEntry[] {
  return models
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || (a.name || a.id).localeCompare(b.name || b.id));
}

export async function GET() {
  try {
    const services = await createScopeServices();
    const allModels = await services.modelRuntime.getAvailable();
    const patterns = services.settingsManager.getGlobalSettings().enabledModels;
    const { enabledIds, warnings } = await resolveEnabledModelIds(patterns, allModels);
    return Response.json({
      models: toEntries(allModels),
      enabledIds,
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch {
    return Response.json({ error: "Model scope is temporarily unavailable." }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Response.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  const enabledIds = (parsed as { enabledIds?: unknown }).enabledIds;
  if (
    enabledIds !== null
    && (!Array.isArray(enabledIds) || enabledIds.some((id) => typeof id !== "string" || !id.trim()))
  ) {
    return Response.json({ error: "enabledIds must be null or an array of non-empty strings" }, { status: 400 });
  }

  try {
    const services = await createScopeServices();
    const allModels = await services.modelRuntime.getAvailable();
    const allIds = allModels.map((model) => `${model.provider}/${model.id}`);
    const patterns = enabledIds === null
      ? undefined
      : computeEnabledModelsForSave(enabledIds as string[], allIds);

    // SettingsManager queues writes and records failures instead of throwing.
    // A load error makes later setters no-op, so reject existing diagnostics
    // instead of clearing them and falsely reporting a successful save.
    if (services.settingsManager.drainErrors().length > 0) {
      return Response.json({ error: "Failed to load the model scope settings." }, { status: 500 });
    }
    services.settingsManager.setEnabledModels(patterns ? [...patterns] : undefined);
    await services.settingsManager.flush();
    if (services.settingsManager.drainErrors().length > 0) {
      return Response.json({ error: "Failed to save the model scope." }, { status: 500 });
    }

    invalidateModelsCache();
    const next = await resolveEnabledModelIds(patterns, allModels);
    return Response.json({
      success: true,
      enabledIds: next.enabledIds,
      ...(next.warnings.length > 0 ? { warnings: next.warnings } : {}),
    });
  } catch {
    return Response.json({ error: "Failed to save the model scope." }, { status: 500 });
  }
}
