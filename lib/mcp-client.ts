import type { McpCatalogResponse, McpCatalogFileServer, McpExposure, McpScope } from "./mcp-types";
export type { McpCatalogResponse, McpExposure, McpScope, McpServerConfig, McpHttpServerConfig, McpStdioServerConfig } from "./mcp-types";
export type McpCatalogServer = McpCatalogFileServer;
import { MCP_SAVED_VALUE_MASK } from "./mcp-types";
export { MCP_SAVED_VALUE_MASK } from "./mcp-types";
export interface McpRuntimeResponse { available: boolean; live?: boolean; statusText?: string; reason?: string }
export type McpRuntimeEvent =
  | { type: "notify"; level: "info" | "warning" | "error"; message: string }
  | { type: "auth"; url: string }
  | { type: "input"; token: string; title?: string; placeholder?: string }
  | { type: "done"; success: boolean }
  | { type: "error"; message: string };
export class RevisionConflictError extends Error { constructor(message = "Configuration changed; refresh before saving.") { super(message); } }
export class ConcurrentBusyError extends Error { constructor(message = "Session is busy.") { super(message); } }
export const isMaskedValue = (value: unknown): boolean => value === MCP_SAVED_VALUE_MASK;
export const hasMaskedArgs = (value: unknown): boolean => Array.isArray(value) && value.length === 1 && isMaskedValue(value[0]);
export function isSafeUrl(value: string): boolean {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
export function isSafeAuthorizationUrl(value: string): boolean {
  if (!isSafeUrl(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
export function validateMcpServerName(name: string): string | null {
  if (!name.trim()) return "mcp.errorNameRequired";
  return /^[A-Za-z0-9_-]+$/.test(name.trim()) && name.length <= 200 && name.trim() !== "prototype" && !Object.hasOwn(Object.prototype, name.trim()) ? null : "mcp.errorNameInvalidChars";
}
export function isMcpServerShadowed(name: string, scope: McpScope, catalog: McpCatalogResponse | null): boolean {
  return scope === "global" && Boolean(catalog?.project.trusted && catalog.files.find((file) => file.scope === "project")?.servers.some((server) => server.name === name));
}
export function tryParseJson<T>(value: string, fallback?: T): { ok: true; value: T } | { ok: false; error: string } {
  try { return { ok: true, value: value.trim() ? JSON.parse(value) as T : fallback ?? {} as T }; }
  catch { return { ok: false, error: "Invalid JSON" }; }
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export interface McpServerForm {
  scope: McpScope; isNew: boolean; name: string; type: "stdio" | "http"; enabled: boolean; exposure: McpExposure;
  command: string; args: string; cwd: string; env: string; url: string; headers: string; oauth: string;
  authProvider: string; description: string; timeout: string; toolExposure: string;
  savedAuthentication?: { oauth: string; provider: string };
}
export function serverToMcpForm(scope: McpScope, server?: McpCatalogFileServer): McpServerForm {
  const config = server?.config ?? {};
  const text = (key: string) => typeof config[key] === "string" ? config[key] as string : "";
  const json = (key: string, fallback: unknown) => JSON.stringify(config[key] ?? fallback, null, 2);
  const exposure = ["codemode", "deferred", "direct", "hidden"].includes(text("exposure")) ? text("exposure") as McpExposure : "codemode";
  return {
    scope, isNew: !server, name: server?.name ?? "", type: typeof config.url === "string" ? "http" : "stdio", enabled: config.enabled !== false, exposure,
    command: text("command"), args: json("args", []), cwd: text("cwd"), env: json("env", {}),
    url: text("url"), headers: json("headers", {}), oauth: json("oauth", {}),
    authProvider: record(config.auth) && typeof config.auth.provider === "string" ? config.auth.provider : "",
    description: text("description"), timeout: typeof config.timeout === "number" ? String(config.timeout) : "", toolExposure: json("toolExposure", {}),
    ...(server ? { savedAuthentication: { oauth: json("oauth", {}), provider: record(config.auth) && typeof config.auth.provider === "string" ? config.auth.provider : "" } } : {}),
  };
}
export function formToMcpServerPatch(form: McpServerForm): Record<string, unknown> {
  const object = (key: "env" | "headers" | "toolExposure") => {
    const value = tryParseJson<unknown>(form[key], {});
    if (!value.ok || !record(value.value)) throw new Error("mcp.errorInvalidJson");
    return value.value;
  };
  const timeout = form.timeout.trim() ? Number(form.timeout) : null;
  if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error("mcp.errorTimeout");
  const config: Record<string, unknown> = {
    type: form.type, enabled: form.enabled, exposure: form.exposure,
    description: form.description.trim() || null, timeout, toolExposure: object("toolExposure"),
  };
  if (form.type === "stdio") {
    if (!form.command.trim()) throw new Error("mcp.errorCommandRequired");
    const args = tryParseJson<unknown>(form.args, []);
    if (!args.ok || !Array.isArray(args.value) || !args.value.every((value) => typeof value === "string")) throw new Error("mcp.errorInvalidJson");
    Object.assign(config, { command: form.command.trim(), args: args.value, cwd: form.cwd.trim() || null, env: object("env") });
  } else {
    const url = form.url.trim();
    if (!url) throw new Error("mcp.errorUrlRequired");
    if (url !== MCP_SAVED_VALUE_MASK && !isSafeUrl(url)) throw new Error("mcp.errorInvalidUrl");
    const parsedOAuth = tryParseJson<unknown>(form.oauth, {});
    if (!parsedOAuth.ok || (parsedOAuth.value !== null && !record(parsedOAuth.value))) throw new Error("mcp.errorInvalidJson");
    const oauth = parsedOAuth.value;
    if (form.scope === "project" && form.authProvider.trim()) throw new Error("mcp.projectAuthForbidden");
    Object.assign(config, { url, headers: object("headers"), oauth: oauth && Object.keys(oauth).length ? oauth : null, auth: form.authProvider.trim() ? { provider: form.authProvider.trim() } : null });
    // Unknown authentication fields are redacted by GET; unchanged forms must not erase them.
    if (form.savedAuthentication?.oauth === form.oauth && form.savedAuthentication.provider === form.authProvider) delete config.oauth;
    if (form.savedAuthentication?.provider === form.authProvider) delete config.auth;
  }
  return config;
}

/** Cancelling a pending reader is essential: checking an abort flag cannot unblock read(). */
export async function* parseSseStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<McpRuntimeEvent> {
  const reader = stream.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const parse = (): McpRuntimeEvent | undefined => {
    const raw = data.join("\n"); data = [];
    try { const value = JSON.parse(raw); return record(value) && typeof value.type === "string" ? value as McpRuntimeEvent : undefined; }
    catch { return undefined; }
  };
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (signal?.aborted) break;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) buffer += "\n\n";
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (line === "" && data.length) { const event = parse(); if (event) yield event; }
      }
      if (done) break;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function jsonResponse(response: Response): Promise<McpCatalogResponse> {
  const value = await response.json().catch(() => ({}));
  if (response.status === 409) throw new RevisionConflictError();
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `HTTP ${response.status}`);
  return value;
}
export async function fetchMcpCatalog(cwd?: string | null, signal?: AbortSignal): Promise<McpCatalogResponse> {
  return jsonResponse(await fetch(cwd ? `/api/mcp?cwd=${encodeURIComponent(cwd)}` : "/api/mcp", { signal }));
}
export async function saveMcpServer(params: { scope: McpScope; cwd?: string | null; name: string; config: Record<string, unknown>; revision: string }, signal?: AbortSignal): Promise<McpCatalogResponse> {
  return jsonResponse(await fetch("/api/mcp", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params), signal }));
}
export async function deleteMcpServer(params: { scope: McpScope; cwd?: string | null; name: string; revision: string }, signal?: AbortSignal): Promise<McpCatalogResponse> {
  return jsonResponse(await fetch("/api/mcp", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params), signal }));
}
export async function fetchMcpRuntime(sessionId: string, signal?: AbortSignal): Promise<McpRuntimeResponse> {
  const response = await fetch(`/api/mcp/runtime?sessionId=${encodeURIComponent(sessionId)}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
export async function performMcpRuntimeAction(params: { sessionId: string; action: "login" | "logout" | "reconnect"; name: string; signal?: AbortSignal; onEvent: (event: McpRuntimeEvent) => void }): Promise<void> {
  const response = await fetch("/api/mcp/runtime", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: params.sessionId, action: params.action, name: params.name }), signal: params.signal });
  if (response.status === 409) throw new ConcurrentBusyError();
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  for await (const event of parseSseStream(response.body, params.signal)) params.onEvent(event);
}
export async function submitMcpRuntimeInput(sessionId: string, token: string, value: string | null, signal?: AbortSignal): Promise<void> {
  const response = await fetch("/api/mcp/runtime/input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, token, value }), signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
