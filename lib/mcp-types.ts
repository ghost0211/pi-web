import type {
  McpExposure as SdkMcpExposure,
  McpServerConfig as SdkMcpServerConfig,
} from "@earendil-works/pi-coding-agent";

export const MCP_SAVED_VALUE_MASK = "__PI_WEB_SAVED_VALUE__";
export const MISSING_REVISION = "missing";
export const MCP_OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"] as const;
export type McpOverrideKey = (typeof MCP_OVERRIDE_KEYS)[number];

export function isMcpThinOverride(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.command === undefined && record.url === undefined && record.type === undefined;
}

export type McpScope = "global" | "project";
export type McpExposure = SdkMcpExposure;
export type McpExposureAlias = "codemode-deferred";
export type McpExposureInput = McpExposure | McpExposureAlias;
// Keep the public SDK contract authoritative; file edits also preserve unknown future fields.
export type McpServerConfig = SdkMcpServerConfig & Record<string, unknown>;
export type McpStdioServerConfig = Extract<SdkMcpServerConfig, { command: string }> & Record<string, unknown>;
export type McpHttpServerConfig = Extract<SdkMcpServerConfig, { url: string }> & Record<string, unknown>;
export type McpOAuthConfig = NonNullable<McpHttpServerConfig["oauth"]> & {
  clientRegistration?: "dcr" | "cimd";
  [key: string]: unknown;
};
export type McpAuth = NonNullable<McpHttpServerConfig["auth"]>;
export interface McpCatalogFileServer { name: string; config: Record<string, unknown>; isOverride?: boolean }
export interface McpCatalogFile { scope: McpScope; path: string; revision: string; servers: McpCatalogFileServer[] }
export interface McpCatalogProject { cwd: string | null; trusted: boolean }
export interface McpCatalogResponse { files: McpCatalogFile[]; project: McpCatalogProject; errors: string[] }
export interface DeleteMcpServerRequest { scope: McpScope; cwd?: string | null; name: string; revision: string }
export interface PutMcpServerRequest extends DeleteMcpServerRequest { config: Record<string, unknown> }
export interface McpConfigOptions { cwd?: string | null; agentDir?: string; allowedRoots?: Set<string> }
