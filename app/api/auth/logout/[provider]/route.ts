import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { invalidateModelsCache } from "@/lib/models-cache";
import { removeStoredCredentialIfType } from "@/lib/provider-credential-store";
import { projectTrustReloadOptions } from "@/lib/project-trust";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  // Use createAgentSessionServices (not ModelRuntime.create()) so
  // extension-registered OAuth providers (e.g. pi-commandcode-provider) are
  // recognized here exactly like in GET /api/auth/providers — a plain
  // ModelRuntime does not load extensions and rejects them as unknown (#logout).
  const cwd = process.cwd() || process.env.PI_WEB_CWD || "";
  const agentDir = getAgentDir();
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const modelRuntime = services.modelRuntime;
  if (!modelRuntime.getProvider(provider)?.auth.oauth) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }
  const removal = await removeStoredCredentialIfType(provider, "oauth");
  if (removal.status === "type_mismatch") {
    return Response.json({ error: `${provider} is authenticated with an API key, not OAuth` }, { status: 409 });
  }
  invalidateModelsCache();
  return Response.json({ ok: true });
}
