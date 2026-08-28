import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildApiKeyProviderList, buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { projectTrustReloadOptions } from "@/lib/project-trust";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
//
// Use createAgentSessionServices (not ModelRuntime.create()) so extension-registered
// providers (e.g. pi-commandcode-provider) show up in the web auth panel, matching
// the model picker (/api/models) and the TUI. Project extensions remain gated
// behind the project-trust store, so opening an untrusted repo's .pi/extensions
// never runs here (#236).
export async function GET() {
  const cwd = process.cwd() || process.env.PI_WEB_CWD || "";
  const agentDir = getAgentDir();
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const inputs = await collectProviderListingInputs(services.modelRuntime);
  const oauthProviders = buildOAuthProviderList(inputs);
  const apiKeyProviders = buildApiKeyProviderList(inputs);
  return Response.json({ providers: oauthProviders, oauthProviders, apiKeyProviders });
}
