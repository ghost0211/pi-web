import { getAllowedFileRoots } from "./file-access";
import {
  deleteMcpServer, getMcpCatalog, putMcpServer, resolveAndValidateProjectPath,
  McpConflictError, McpInvalidFileError, McpSecurityError, McpValidationError,
} from "./mcp-config";
import type { McpConfigOptions, DeleteMcpServerRequest } from "./mcp-types";
import { hasJsonContentType, isApiRequestAllowed } from "./request-security";

function failure(error: unknown): Response {
  const status = error instanceof McpConflictError ? 409 : error instanceof McpSecurityError ? 403
    : error instanceof McpValidationError || error instanceof McpInvalidFileError ? 400 : 500;
  return Response.json({ error: status === 500 ? "Failed to access MCP configuration" : (error as Error).message }, { status });
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export async function handleGet(request: Request, options?: McpConfigOptions): Promise<Response> {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const cwd = new URL(request.url).searchParams.get("cwd") ?? options?.cwd;
    const allowedRoots = options?.allowedRoots ?? await getAllowedFileRoots();
    if (cwd) resolveAndValidateProjectPath(cwd, allowedRoots);
    return Response.json(await getMcpCatalog({ cwd, agentDir: options?.agentDir, allowedRoots }));
  } catch (error) { return failure(error); }
}

async function mutate(request: Request, remove: boolean, options?: McpConfigOptions): Promise<Response> {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let value: unknown;
  try { value = await request.json(); }
  catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (!record(value)) return Response.json({ error: "Expected a JSON object" }, { status: 400 });
  const { scope, cwd, name, config, revision } = value;
  if ((scope !== "global" && scope !== "project") || typeof name !== "string" || name.length > 200 || typeof revision !== "string"
    || (cwd !== undefined && cwd !== null && typeof cwd !== "string") || (!remove && !record(config))) {
    return Response.json({ error: "Valid scope, name, revision, cwd and configuration required" }, { status: 400 });
  }
  try {
    const resolvedOptions = { agentDir: options?.agentDir, allowedRoots: options?.allowedRoots ?? await getAllowedFileRoots() };
    const params: DeleteMcpServerRequest = { scope, cwd: typeof cwd === "string" ? cwd : null, name, revision };
    const data = remove ? await deleteMcpServer(params, resolvedOptions)
      : await putMcpServer({ ...params, config: config as Record<string, unknown> }, resolvedOptions);
    return Response.json(data);
  } catch (error) { return failure(error); }
}
export function handlePut(request: Request, options?: McpConfigOptions): Promise<Response> { return mutate(request, false, options); }
export function handleDelete(request: Request, options?: McpConfigOptions): Promise<Response> { return mutate(request, true, options); }
