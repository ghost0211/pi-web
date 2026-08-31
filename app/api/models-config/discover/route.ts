import { NextResponse } from "next/server";
import { resolveModelDiscoveryAuth } from "@/lib/model-discovery-auth";
import { buildModelsListUrl, parseDiscoveredModels, type DiscoveredModel } from "@/lib/model-discovery";
import { loadModelsDevCatalog } from "@/lib/model-catalog-cache";
import { pickCatalogMetadata } from "@/lib/model-catalog";

export const dynamic = "force-dynamic";

const DISCOVERY_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHeader(headers: Headers, name: string): boolean {
  return headers.has(name);
}

function buildHeaders(api: string, apiKey: string | undefined, configured: Record<string, string>): Headers {
  const headers = new Headers(configured);
  if (!hasHeader(headers, "accept")) headers.set("Accept", "application/json");
  if (!apiKey) return headers;

  if (api === "anthropic-messages") {
    if (!hasHeader(headers, "x-api-key")) headers.set("x-api-key", apiKey);
    if (!hasHeader(headers, "anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (api === "google-generative-ai") {
    if (!hasHeader(headers, "x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
  } else if (!hasHeader(headers, "authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { providerName?: unknown; provider?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ error: "providerName is required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ error: "provider is required" }, { status: 400 });

    const baseUrl = typeof body.provider.baseUrl === "string" ? body.provider.baseUrl.trim() : "";
    if (!baseUrl) return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    const api = typeof body.provider.api === "string" && body.provider.api
      ? body.provider.api
      : "openai-completions";

    let endpoint: URL;
    try {
      endpoint = buildModelsListUrl(baseUrl, api);
    } catch {
      return NextResponse.json({ error: "Base URL is invalid" }, { status: 400 });
    }

    const auth = await resolveModelDiscoveryAuth(providerName, body.provider);
    if (typeof body.provider.apiKey === "string" && body.provider.apiKey.trim() && !auth.apiKey) {
      return NextResponse.json({ error: `No API key found for "${providerName}"` }, { status: 400 });
    }

    const response = await fetch(endpoint, {
      cache: "no-store",
      headers: buildHeaders(api, auth.apiKey, auth.headers),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    const responseText = await response.text();
    if (!response.ok) {
      return NextResponse.json({
        error: responseText.slice(0, 500) || `Upstream returned HTTP ${response.status}`,
        status: response.status,
      }, { status: 502 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      return NextResponse.json({ error: "Upstream model list was not valid JSON" }, { status: 502 });
    }
    const models = parseDiscoveredModels(payload);
    if (models.length === 0) {
      return NextResponse.json({ error: "No models found in the upstream response" }, { status: 502 });
    }

    // Merge models.dev metadata (reasoning, thinkingLevelMap, context window,
    // max tokens) so imported models get real limits without a manual catalog
    // fill. Network/catalog failures must never fail discovery, so degrade
    // gracefully.
    let enriched = models;
    try {
      const catalog = await loadModelsDevCatalog();
      const byId = new Map<string, typeof catalog>();
      for (const entry of catalog) {
        const list = byId.get(entry.id);
        if (list) list.push(entry);
        else byId.set(entry.id, [entry]);
      }
      enriched = models.map((model) => {
        const metadata = pickCatalogMetadata(byId.get(model.id) ?? []);
        if (!metadata) return model;
        return {
          ...model,
          ...metadata,
        } as DiscoveredModel;
      });
    } catch {
      // Catalog is optional; keep the discovered model list as-is.
    }

    return NextResponse.json({ models: enriched, endpoint: endpoint.toString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof DOMException && error.name === "TimeoutError" ? 504 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
