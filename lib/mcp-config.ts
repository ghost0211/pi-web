import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";
import { samePath } from "./paths";
import {
  MCP_OVERRIDE_KEYS,
  MCP_SAVED_VALUE_MASK,
  MISSING_REVISION,
  isMcpThinOverride,
  type McpCatalogFile,
  type McpCatalogProject,
  type McpCatalogResponse,
  type McpConfigOptions,
  type McpExposure,
  type McpScope,
  type McpServerConfig,
  type DeleteMcpServerRequest,
  type PutMcpServerRequest,
} from "./mcp-types";

export { MCP_OVERRIDE_KEYS, MCP_SAVED_VALUE_MASK, MISSING_REVISION, isMcpThinOverride } from "./mcp-types";

export const MCP_EXPOSURES: readonly McpExposure[] = [
  "codemode",
  "deferred",
  "direct",
  "hidden",
] as const;

const isOverrideKey = (key: string): boolean => (MCP_OVERRIDE_KEYS as readonly string[]).includes(key);

const MCP_EXPOSURE_ALIASES: Record<string, McpExposure> = {
  "codemode-deferred": "codemode",
};

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const SERVER_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

const RESERVED_NAMES = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
]);

const KNOWN_CONFIG_KEYS = new Set([
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "oauth",
  "auth",
  "enabled",
  "exposure",
  "toolExposure",
  "timeout",
  "description",
]);

const KNOWN_OAUTH_KEYS = new Set([
  "clientId",
  "clientSecret",
  "callbackPort",
  "callbackUrl",
  "scope",
  "clientName",
  "clientRegistration",
  "authServerMetadataUrl",
]);

export class McpConflictError extends Error {
  constructor(message = "Revision conflict (409). The configuration has changed.") {
    super(message);
    this.name = "McpConflictError";
  }
}

export class McpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpValidationError";
  }
}

export class McpSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSecurityError";
  }
}

export class McpInvalidFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpInvalidFileError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string");
}

export function mcpNamespace(name: string): string {
  return `mcp__${name.replace(/-/g, "_")}`;
}

export function isLoopbackRedirectUri(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.includes(url.hostname) &&
    url.search === "" &&
    url.hash === "" && !url.username && !url.password
  );
}

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function detectIndent(rawJson: string): string {
  const match = /^([ \t]+)\S/m.exec(rawJson);
  return match ? match[1] : "  ";
}

export function validateMcpServerName(name: string): string | null {
  if (!name || typeof name !== "string" || !name.trim()) {
    return "Server name is required";
  }
  if (!SERVER_NAME_REGEX.test(name)) {
    return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
  }
  if (name.length > 200 || RESERVED_NAMES.has(name) || Object.prototype.hasOwnProperty(name)) {
    return `invalid server name "${name}": reserved name`;
  }
  return null;
}

function resolveExposureAlias(value: unknown): unknown {
  return typeof value === "string" ? (MCP_EXPOSURE_ALIASES[value] ?? value) : value;
}

function isExposure(value: unknown): value is McpExposure {
  return typeof value === "string" && (MCP_EXPOSURES as readonly string[]).includes(value);
}

export function validateOAuth(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) return "oauth must be an object";

  if (raw.clientId !== undefined && typeof raw.clientId !== "string") {
    return "oauth.clientId must be a string";
  }
  if (raw.clientSecret !== undefined && typeof raw.clientSecret !== "string") {
    return "oauth.clientSecret must be a string";
  }
  const port = raw.callbackPort;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
    return "oauth.callbackPort must be a port number between 1 and 65535";
  }
  if (raw.callbackUrl !== undefined) {
    if (typeof raw.callbackUrl !== "string" || !isLoopbackRedirectUri(raw.callbackUrl)) {
      return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
    }
    const urlPort = new URL(raw.callbackUrl).port;
    if (urlPort && port !== undefined && Number(urlPort) !== port) {
      return "oauth.callbackUrl and oauth.callbackPort name different ports";
    }
  }
  if (raw.scope !== undefined && typeof raw.scope !== "string") {
    return "oauth.scope must be a string";
  }
  if (raw.clientName !== undefined && (typeof raw.clientName !== "string" || !raw.clientName.trim())) {
    return "oauth.clientName must be a non-empty string";
  }
  if (raw.clientRegistration !== undefined && raw.clientRegistration !== "dcr") {
    if (raw.clientRegistration !== "cimd") {
      return 'oauth.clientRegistration must be "dcr" or "cimd"';
    }
    if (raw.clientId !== undefined || raw.clientName !== undefined) {
      return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
    }
    const callback = typeof raw.callbackUrl === "string" && URL.canParse(raw.callbackUrl)
      ? new URL(raw.callbackUrl)
      : undefined;
    if (callback && (callback.hostname === "[::1]" || callback.pathname !== "/callback")) {
      return 'oauth.clientRegistration "cimd" requires oauth.callbackUrl on localhost or 127.0.0.1 with path /callback';
    }
  }
  if (raw.authServerMetadataUrl !== undefined) {
    const metadata = typeof raw.authServerMetadataUrl === "string" && URL.canParse(raw.authServerMetadataUrl)
      ? new URL(raw.authServerMetadataUrl) : undefined;
    if (!metadata || metadata.username || metadata.password || !(metadata.protocol === "https:" || (metadata.protocol === "http:" && LOOPBACK_HOSTS.includes(metadata.hostname)))) {
      return "oauth.authServerMetadataUrl must use HTTPS or loopback HTTP without URL credentials";
    }
  }
  return null;
}

export function validateMcpServerConfig(
  name: string,
  raw: unknown,
  scope: McpScope = "global",
  baseConfig?: Record<string, unknown>,
): { valid: true; config: McpServerConfig } | { valid: false; error: string } {
  const nameError = validateMcpServerName(name);
  if (nameError) return { valid: false, error: nameError };

  if (!isRecord(raw)) return { valid: false, error: `server "${name}" must be an object` };

  const value = { ...raw };
  if (value.exposure !== undefined) {
    value.exposure = resolveExposureAlias(value.exposure);
  }
  if (isRecord(value.toolExposure)) {
    value.toolExposure = Object.fromEntries(
      Object.entries(value.toolExposure).map(([tool, exp]) => [tool, resolveExposureAlias(exp)]),
    );
  }

  const { type, exposure, toolExposure, enabled, timeout, description } = value;
  const exposuresText = MCP_EXPOSURES.map((v) => `"${v}"`).join(", ");

  if (exposure !== undefined && !isExposure(exposure)) {
    return { valid: false, error: `server "${name}": exposure must be one of ${exposuresText}` };
  }

  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure)) {
      return { valid: false, error: `server "${name}": toolExposure must map tool names to exposures` };
    }
    for (const [tool, exp] of Object.entries(toolExposure)) {
      if (!isExposure(exp)) {
        return { valid: false, error: `server "${name}": toolExposure "${tool}" must be one of ${exposuresText}` };
      }
    }
  }

  if (enabled !== undefined && typeof enabled !== "boolean") {
    return { valid: false, error: `server "${name}": enabled must be a boolean` };
  }

  if (description !== undefined && typeof description !== "string") {
    return { valid: false, error: `server "${name}": description must be a string` };
  }

  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)) {
    return { valid: false, error: `server "${name}": timeout must be a positive number of seconds` };
  }

  if (type === "sse") {
    return { valid: false, error: `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL` };
  }

  const isOverride = isMcpThinOverride(value);
  if (isOverride) {
    if (scope !== "project") {
      return { valid: false, error: `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)` };
    }
    const extra = Object.keys(raw).filter((k) => !isOverrideKey(k));
    if (extra.length > 0) {
      return { valid: false, error: `server "${name}": an override can only set ${MCP_OVERRIDE_KEYS.join(", ")}` };
    }
    if (!baseConfig) {
      return { valid: false, error: `server "${name}" needs "command" or "url", or a global server to override` };
    }
    const baseValidation = validateMcpServerConfig(name, baseConfig, "global");
    if (!baseValidation.valid) {
      return { valid: false, error: baseValidation.error };
    }
    const merged = { ...baseValidation.config, ...value };
    const mergedValidation = validateMcpServerConfig(name, merged, "global");
    if (!mergedValidation.valid) {
      return { valid: false, error: mergedValidation.error };
    }
    return { valid: true, config: value as unknown as McpServerConfig };
  }

  const command = value.command;
  const urlValue = value.url;
  const hasCommand = typeof command === "string";
  const hasUrl = typeof urlValue === "string";

  if (hasCommand && hasUrl) {
    return { valid: false, error: `server "${name}" cannot specify both "command" and "url"` };
  }

  if (!hasCommand && !hasUrl) {
    return { valid: false, error: `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)` };
  }

  if (hasCommand) {
    if (type !== undefined && type !== "stdio") {
      return { valid: false, error: `server "${name}": invalid transport type for command` };
    }
    if (!command.trim()) {
      return { valid: false, error: `server "${name}": command cannot be empty` };
    }
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string")) {
        return { valid: false, error: `server "${name}": args must be an array of strings` };
      }
    }
    if (value.env !== undefined && !isStringRecord(value.env)) {
      return { valid: false, error: `server "${name}": env must map names to strings` };
    }
    if (value.cwd !== undefined && typeof value.cwd !== "string") {
      return { valid: false, error: `server "${name}": cwd must be a string` };
    }
    if (value.url !== undefined || value.headers !== undefined || value.oauth !== undefined || value.auth !== undefined) {
      return { valid: false, error: `server "${name}": stdio server cannot specify HTTP properties` };
    }
    return { valid: true, config: value as unknown as McpServerConfig };
  }

  // HTTP Transport
  if (type !== undefined && type !== "http" && type !== "streamable-http") {
    return { valid: false, error: `server "${name}": invalid transport type for url` };
  }
  if (typeof urlValue !== "string" || !URL.canParse(urlValue) || !/^https?:$/.test(new URL(urlValue).protocol)) {
    return { valid: false, error: `server "${name}": url must be an http or https URL` };
  }
  if (value.headers !== undefined && !isStringRecord(value.headers)) {
    return { valid: false, error: `server "${name}": headers must map names to strings` };
  }

  const oauthError = validateOAuth(value.oauth);
  if (oauthError) {
    return { valid: false, error: `server "${name}": ${oauthError}` };
  }

  if (value.auth !== undefined) {
    if (!isRecord(value.auth) || typeof value.auth.provider !== "string" || !value.auth.provider.trim()) {
      return { valid: false, error: `server "${name}": auth.provider must be a provider name` };
    }
    if (scope === "project") {
      return { valid: false, error: `server "${name}": auth is only allowed in the global mcp.json` };
    }
    const parsedUrl = new URL(urlValue);
    if (parsedUrl.protocol !== "https:" && !LOOPBACK_HOSTS.includes(parsedUrl.hostname)) {
      return { valid: false, error: `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]` };
    }
    if (value.oauth !== undefined) {
      return { valid: false, error: `server "${name}": auth cannot be used with oauth` };
    }
    if (value.headers !== undefined) {
      const hasAuthHeader = Object.keys(value.headers).some(
        (key) => key.toLowerCase() === "authorization",
      );
      if (hasAuthHeader) {
        return { valid: false, error: `server "${name}": auth cannot be used with Authorization header` };
      }
    }
  }

  if (value.command !== undefined || value.args !== undefined || value.cwd !== undefined) {
    return { valid: false, error: `server "${name}": HTTP server cannot specify stdio properties` };
  }

  return { valid: true, config: value as unknown as McpServerConfig };
}

export function maskServerConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(config)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) {
      // Unknown fields are kept in disk files, but not returned in GET to prevent credential leakage.
      continue;
    }

    const value = config[key];
    if (value === undefined) continue;

    if (key === "args" && Array.isArray(value)) {
      result.args = value.length > 0 ? [MCP_SAVED_VALUE_MASK] : [];
    } else if (key === "env" && isRecord(value)) {
      result.env = Object.fromEntries(Object.keys(value).map((key) => [key, MCP_SAVED_VALUE_MASK]));
    } else if (key === "headers" && isRecord(value)) {
      result.headers = Object.fromEntries(Object.keys(value).map((key) => [key, MCP_SAVED_VALUE_MASK]));
    } else if (key === "oauth" && isRecord(value)) {
      const maskedOAuth: Record<string, unknown> = Object.fromEntries(Object.entries(value).filter(([key]) => KNOWN_OAUTH_KEYS.has(key)));
      for (const field of ["callbackUrl", "authServerMetadataUrl"]) {
        const fieldValue = maskedOAuth[field];
        if (typeof fieldValue === "string" && URL.canParse(fieldValue)) {
          const url = new URL(fieldValue);
          if (url.username || url.password || url.search || url.hash) maskedOAuth[field] = MCP_SAVED_VALUE_MASK;
        }
      }
      if (typeof maskedOAuth.clientSecret === "string") {
        maskedOAuth.clientSecret = MCP_SAVED_VALUE_MASK;
      }
      result.oauth = maskedOAuth;
    } else if (key === "url" && typeof value === "string") {
      if (URL.canParse(value)) {
        const parsed = new URL(value);
        if (parsed.username || parsed.password || parsed.search || parsed.hash) {
          result.url = MCP_SAVED_VALUE_MASK;
        } else {
          result.url = value;
        }
      } else {
        result.url = MCP_SAVED_VALUE_MASK;
      }
    } else if (key === "auth") {
      if (isRecord(value) && typeof value.provider === "string") result.auth = { provider: value.provider };
    } else {
      result[key] = structuredClone(value);
    }
  }

  return result;
}

function hasAnyMask(value: unknown): boolean {
  if (value === MCP_SAVED_VALUE_MASK) return true;
  if (Array.isArray(value)) return value.some(hasAnyMask);
  if (isRecord(value)) return Object.values(value).some(hasAnyMask);
  return false;
}

export function restoreAndMergeServerConfig(
  newInput: Record<string, unknown>,
  oldConfig: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!oldConfig) {
    if (hasAnyMask(newInput)) {
      throw new McpValidationError("New server cannot use masked saved values");
    }
    const clean: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(newInput)) {
      if (v !== null && v !== undefined) clean[k] = v;
    }
    return clean;
  }

  const oldIsStdio = typeof oldConfig.command === "string";
  const oldIsHttp = typeof oldConfig.url === "string";

  const newIsStdio =
    newInput.command !== undefined && newInput.command !== null
      ? true
      : newInput.url !== undefined && newInput.url !== null
        ? false
        : oldIsStdio;

  const switchedTransport = (oldIsStdio && !newIsStdio) || (oldIsHttp && newIsStdio);

  const base: Record<string, unknown> = Object.assign(Object.create(null), structuredClone(oldConfig));

  if (switchedTransport) {
    if (newIsStdio) {
      delete base.url;
      delete base.headers;
      delete base.oauth;
      delete base.auth;
    } else {
      delete base.command;
      delete base.args;
      delete base.env;
      delete base.cwd;
    }
  }

  for (const [key, value] of Object.entries(newInput)) {
    if (value === undefined) {
      continue;
    }

    if (value === null) {
      delete base[key];
      continue;
    }

    if (key === "args") {
      if (Array.isArray(value)) {
        if (value.length === 1 && value[0] === MCP_SAVED_VALUE_MASK) {
          if (switchedTransport || !Array.isArray(oldConfig.args)) {
            throw new McpValidationError("Cannot restore masked args when no previous args exist");
          }
          base.args = structuredClone(oldConfig.args);
        } else if (value.length === 0) {
          base.args = [];
        } else {
          if (value.some((item) => item === MCP_SAVED_VALUE_MASK)) {
            throw new McpValidationError("Individual args cannot contain mask value");
          }
          base.args = [...value];
        }
      } else {
        base.args = value;
      }
      continue;
    }

    if (key === "env") {
      if (isRecord(value)) {
        if (Object.keys(value).length === 0) {
          base.env = {};
        } else {
          const restoredEnv: Record<string, string> = Object.create(null);
          const oldEnv = isRecord(oldConfig.env) ? oldConfig.env : {};
          for (const [envKey, envVal] of Object.entries(value)) {
            if (envVal === MCP_SAVED_VALUE_MASK) {
              if (switchedTransport || !Object.hasOwn(oldEnv, envKey) || typeof oldEnv[envKey] !== "string") {
                throw new McpValidationError(`Cannot restore masked env variable "${envKey}": not found in existing config`);
              }
              restoredEnv[envKey] = oldEnv[envKey];
            } else if (typeof envVal === "string") {
              restoredEnv[envKey] = envVal;
            } else { throw new McpValidationError("env values must be strings"); }
          }
          base.env = Object.fromEntries(Object.entries(restoredEnv));
        }
      } else {
        base.env = value;
      }
      continue;
    }

    if (key === "headers") {
      if (isRecord(value)) {
        if (Object.keys(value).length === 0) {
          base.headers = {};
        } else {
          const restoredHeaders: Record<string, string> = Object.create(null);
          const oldHeaders = isRecord(oldConfig.headers) ? oldConfig.headers : {};
          for (const [hKey, hVal] of Object.entries(value)) {
            if (hVal === MCP_SAVED_VALUE_MASK) {
              if (switchedTransport || !Object.hasOwn(oldHeaders, hKey) || typeof oldHeaders[hKey] !== "string") {
                throw new McpValidationError(`Cannot restore masked header "${hKey}": not found in existing config`);
              }
              restoredHeaders[hKey] = oldHeaders[hKey];
            } else if (typeof hVal === "string") {
              restoredHeaders[hKey] = hVal;
            } else { throw new McpValidationError("header values must be strings"); }
          }
          base.headers = Object.fromEntries(Object.entries(restoredHeaders));
        }
      } else {
        base.headers = value;
      }
      continue;
    }

    if (key === "oauth") {
      if (isRecord(value)) {
        if (Object.keys(value).length === 0) { base.oauth = {}; continue; }
        const oldOAuth = isRecord(oldConfig.oauth) ? oldConfig.oauth : {};
        const mergedOAuth: Record<string, unknown> = {
          ...(!switchedTransport ? oldOAuth : {}),
          ...value,
        };
        for (const field of ["clientSecret", "callbackUrl", "authServerMetadataUrl"]) {
          if (value[field] !== MCP_SAVED_VALUE_MASK) continue;
          if (switchedTransport || !Object.hasOwn(oldOAuth, field) || typeof oldOAuth[field] !== "string") {
            throw new McpValidationError(`Cannot restore masked oauth.${field}: not found in existing config`);
          }
          mergedOAuth[field] = oldOAuth[field];
        }
        for (const [oK, oV] of Object.entries(value)) {
          if (oV === null) {
            delete mergedOAuth[oK];
          }
        }
        base.oauth = mergedOAuth;
      } else {
        base.oauth = value;
      }
      continue;
    }

    if (key === "url") {
      if (value === MCP_SAVED_VALUE_MASK) {
        if (switchedTransport || typeof oldConfig.url !== "string") {
          throw new McpValidationError("Cannot restore masked url: not found in existing config");
        }
        base.url = oldConfig.url;
      } else {
        base.url = value;
      }
      continue;
    }

    if (key === "toolExposure") {
      if (isRecord(value)) {
        if (Object.keys(value).length === 0) {
          base.toolExposure = {};
        } else {
          base.toolExposure = { ...value };
        }
      } else {
        base.toolExposure = value;
      }
      continue;
    }

    base[key] = value;
  }

  return base;
}

export function isProjectExplicitlyTrusted(cwd: string, agentDir?: string): boolean {
  const store = new ProjectTrustStore(agentDir ?? getAgentDir());
  return store.get(cwd) === true;
}

function pathMetadata(filePath: string) {
  try { return lstatSync(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new McpSecurityError("Unable to inspect MCP configuration path"); }
}
function assertEditableFile(filePath: string): void {
  const stat = pathMetadata(filePath);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new McpSecurityError("MCP configuration must be a regular file, not a symlink");
  if (stat && stat.size > 10 * 1024 * 1024) throw new McpSecurityError("MCP configuration exceeds the 10 MiB editing limit");
}

export function resolveAndValidateProjectPath(
  cwd: string,
  allowedRoots?: Set<string>,
): { cwd: string; projectConfigPath: string; realCwd: string } {
  if (!cwd || typeof cwd !== "string") {
    throw new McpSecurityError("cwd must be a non-empty string");
  }
  if (!path.isAbsolute(cwd)) {
    throw new McpSecurityError(`cwd must be an absolute path: "${cwd}"`);
  }

  const resolvedCwd = path.resolve(cwd);
  if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
    throw new McpSecurityError(`Project directory does not exist: "${resolvedCwd}"`);
  }

  if (allowedRoots !== undefined) {
    if (!isExistingFilePathAllowed(resolvedCwd, allowedRoots)) {
      throw new McpSecurityError(`Project directory is outside allowed roots: "${resolvedCwd}"`);
    }
    const realCwd = realpathSync(resolvedCwd);
    if (!isFilePathAllowed(realCwd, allowedRoots)) {
      throw new McpSecurityError(`Project realpath is outside allowed roots: "${realCwd}"`);
    }
  }

  const piDir = path.join(resolvedCwd, ".pi");
  if (pathMetadata(piDir)) {
    const stat = lstatSync(piDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new McpSecurityError(`.pi must be a directory and cannot be a symbolic link: "${piDir}"`);
    }
  }

  const projectConfigPath = path.join(piDir, "mcp.json");
  if (pathMetadata(projectConfigPath)) {
    const stat = lstatSync(projectConfigPath);
    if (stat.isSymbolicLink()) {
      throw new McpSecurityError(`mcp.json file cannot be a symbolic link: "${projectConfigPath}"`);
    }
    const realConfig = realpathSync(projectConfigPath);
    const expectedDir = realpathSync(piDir);
    if (!samePath(path.dirname(realConfig), expectedDir)) {
      throw new McpSecurityError(`mcp.json realpath is outside project directory`);
    }
  }

  assertEditableFile(projectConfigPath);
  return { cwd: resolvedCwd, projectConfigPath, realCwd: realpathSync(resolvedCwd) };
}

interface LoadedConfigFileState {
  path: string;
  scope: McpScope;
  exists: boolean;
  revision: string;
  rawJson?: string;
  parsedTop?: Record<string, unknown>;
  servers: Map<string, Record<string, unknown>>;
  errors: string[];
}

function readConfigFileSafe(
  filePath: string,
  scope: McpScope,
  errors: string[],
  globalServers?: Map<string, Record<string, unknown>>,
): LoadedConfigFileState {
  const state: LoadedConfigFileState = {
    path: filePath,
    scope,
    exists: false,
    revision: MISSING_REVISION,
    servers: new Map(),
    errors,
  };

  try {
    const stat = pathMetadata(filePath);
    if (!stat) return state;
    assertEditableFile(filePath);
    if (stat.isSymbolicLink()) {
      errors.push(`${filePath}: symlinks are not allowed`);
      return state;
    }
  } catch {
    errors.push(`${filePath}: failed to read file metadata`);
    return state;
  }

  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
    state.exists = true;
    state.rawJson = text;
    state.revision = sha256Hex(text);
  } catch {
    errors.push(`${filePath}: failed to read file`);
    return state;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Return a generalized error without leaking raw parse fragments or credentials
    errors.push(`${filePath}: invalid JSON`);
    return state;
  }

  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    errors.push(`${filePath}: expected an object with an "mcpServers" object`);
    return state;
  }

  state.parsedTop = parsed;

  const rawServers = parsed.mcpServers ?? {};
  const namespaceMap = new Map<string, string>();

  for (const [name, rawConfig] of Object.entries(rawServers)) {
    let validation: { valid: true; config: McpServerConfig } | { valid: false; error: string };
    if (scope === "project" && isRecord(rawConfig) && isMcpThinOverride(rawConfig)) {
      const base = globalServers?.get(name);
      const extra = Object.keys(rawConfig).filter((k) => !isOverrideKey(k));
      if (!base) {
        errors.push(`${filePath}: server "${name}" needs "command" or "url", or a global server to override`);
        continue;
      }
      if (extra.length > 0) {
        errors.push(`${filePath}: server "${name}": an override can only set ${MCP_OVERRIDE_KEYS.join(", ")}`);
        continue;
      }
      validation = validateMcpServerConfig(name, rawConfig, scope, base);
    } else {
      validation = validateMcpServerConfig(name, rawConfig, scope);
    }

    if (!validation.valid) {
      errors.push(`${filePath}: invalid server configuration (use native /mcp for details)`);
      continue;
    }

    const ns = mcpNamespace(name);
    const existing = namespaceMap.get(ns);
    if (existing && existing !== name) {
      errors.push(`${filePath}: server "${name}" conflicts with "${existing}"`);
      continue;
    }
    namespaceMap.set(ns, name);

    state.servers.set(name, validation.config as unknown as Record<string, unknown>);
  }

  return state;
}

export async function getMcpCatalog(options?: McpConfigOptions): Promise<McpCatalogResponse> {
  const agentDir = options?.agentDir ?? getAgentDir();
  const globalConfigPath = path.join(agentDir, "mcp.json");
  const errors: string[] = [];

  const globalState = readConfigFileSafe(globalConfigPath, "global", errors);

  const globalFile: McpCatalogFile = {
    scope: "global",
    path: globalConfigPath,
    revision: globalState.revision,
    servers: [...globalState.servers.entries()].map(([name, config]) => ({
      name,
      config: maskServerConfig(config),
    })),
  };

  let projectCwd: string | null = null;
  let projectTrusted = false;
  let projectFile: McpCatalogFile | null = null;

  if (options?.cwd) {
    try {
      const { cwd: resolvedCwd, projectConfigPath } = resolveAndValidateProjectPath(
        options.cwd,
        options.allowedRoots,
      );
      projectCwd = resolvedCwd;
      projectTrusted = isProjectExplicitlyTrusted(resolvedCwd, agentDir);

      if (projectTrusted) {
        const projectState = readConfigFileSafe(projectConfigPath, "project", errors, globalState.servers);

        // Cross-check namespace conflicts between project and global:
        // Same original name: project overrides global (allowed).
        // Different original name with same namespace: conflict!
        for (const [projName] of projectState.servers) {
          const projNs = mcpNamespace(projName);
          for (const [globName] of globalState.servers) {
            if (projName !== globName && projNs === mcpNamespace(globName)) {
              errors.push(
                `${projectConfigPath}: server "${projName}" conflicts with global server "${globName}"`,
              );
            }
          }
        }

        projectFile = {
          scope: "project",
          path: projectConfigPath,
          revision: projectState.revision,
          servers: [...projectState.servers.entries()].map(([name, config]) => ({
            name,
            config: maskServerConfig(config),
            isOverride: isMcpThinOverride(config),
          })),
        };
      }
    } catch (err) {
      if (err instanceof McpSecurityError) {
        errors.push(err.message);
      } else {
        errors.push("Invalid project configuration");
      }
      projectCwd = null;
      projectTrusted = false;
    }
  }

  const files: McpCatalogFile[] = [globalFile];
  if (projectFile) {
    files.push(projectFile);
  }

  const project: McpCatalogProject = {
    cwd: projectCwd,
    trusted: projectTrusted,
  };

  return {
    files,
    project,
    errors,
  };
}

async function withFileLock<T>(
  filePath: string,
  fn: (fileInfo: {
    exists: boolean;
    content: string | null;
    revision: string;
  }) => Promise<T>,
  revalidate: () => void,
): Promise<T> {
  revalidate();
  const parentDir = path.dirname(filePath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  }

  const lockfilePath = `${filePath}.lock`;
  if (pathMetadata(lockfilePath)?.isSymbolicLink()) throw new McpSecurityError("MCP lock path cannot be a symlink");
  const release = await lockfile.lock(parentDir, {
    realpath: false,
    lockfilePath,
    retries: {
      retries: 10,
      factor: 2,
      minTimeout: 50,
      maxTimeout: 2000,
      randomize: true,
    },
    stale: 10_000,
  });

  try {
    revalidate(); // The path and trust may have changed while awaiting a contended lock.
    let exists = false;
    let content: string | null = null;
    let revision = MISSING_REVISION;

    if (existsSync(filePath)) {
      exists = true;
      content = readFileSync(filePath, "utf8");
      revision = sha256Hex(content);
    }

    return await fn({ exists, content, revision });
  } finally {
    try {
      await release();
    } catch {
      // Ignore release error
    }
  }
}

function createRevalidator(scope: McpScope, cwd: string | null, filePath: string, agentDir: string, roots?: Set<string>): () => void {
  const identity = cwd ? resolveAndValidateProjectPath(cwd, roots).realCwd : undefined;
  return () => {
    assertEditableFile(filePath);
    if (cwd) {
      const current = resolveAndValidateProjectPath(cwd, roots);
      if (!samePath(current.realCwd, identity!)) throw new McpSecurityError("Project path changed while waiting for the configuration lock");
      if (scope === "project" && !isProjectExplicitlyTrusted(cwd, agentDir)) throw new McpSecurityError("Project is no longer explicitly trusted");
    }
  };
}

export async function putMcpServer(
  request: PutMcpServerRequest,
  options?: McpConfigOptions,
): Promise<McpCatalogResponse> {
  const { scope, cwd, name, config, revision } = request;
  if (typeof revision !== "string") throw new McpValidationError("revision must be a string");

  if (scope !== "global" && scope !== "project") {
    throw new McpValidationError('scope must be "global" or "project"');
  }

  const nameError = validateMcpServerName(name);
  if (nameError) {
    throw new McpValidationError(nameError);
  }

  if (!isRecord(config)) {
    throw new McpValidationError("config must be an object");
  }

  const agentDir = options?.agentDir ?? getAgentDir();
  let targetPath: string;
  let effectiveCwd: string | null = null;

  if (scope === "project") {
    if (!cwd) {
      throw new McpValidationError("cwd is required for project scope");
    }
    const resolved = resolveAndValidateProjectPath(cwd, options?.allowedRoots);
    effectiveCwd = resolved.cwd;
    if (!isProjectExplicitlyTrusted(effectiveCwd, agentDir)) {
      throw new McpSecurityError("Project is not explicitly trusted");
    }
    targetPath = resolved.projectConfigPath;
  } else {
    targetPath = path.join(agentDir, "mcp.json");
    if (cwd) {
      try {
        const resolved = resolveAndValidateProjectPath(cwd, options?.allowedRoots);
        effectiveCwd = resolved.cwd;
      } catch {
        throw new McpSecurityError("Invalid project context for global write");
      }
    }
  }

  const revalidate = createRevalidator(scope, effectiveCwd, targetPath, agentDir, options?.allowedRoots);
  await withFileLock(targetPath, async ({ exists, content, revision: currentRevision }) => {
    if (revision !== currentRevision) {
      throw new McpConflictError(
        `Revision conflict: expected "${revision}", found "${currentRevision}"`,
      );
    }

    let parsed: Record<string, unknown> = {};
    let indent = "  ";

    if (exists && content !== null) {
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new McpInvalidFileError(
          "Existing MCP config contains invalid JSON; aborting write to prevent data loss",
        );
      }
      if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
        throw new McpInvalidFileError(
          "Existing MCP config is not an object with an optional mcpServers record",
        );
      }
      indent = detectIndent(content);
    }

    const currentServers = isRecord(parsed.mcpServers) ? (parsed.mcpServers as Record<string, unknown>) : {};
    const oldServerConfig = isRecord(currentServers[name])
      ? (currentServers[name] as Record<string, unknown>)
      : undefined;

    const restored = restoreAndMergeServerConfig(config, oldServerConfig);
    const isOverride = scope === "project" && isMcpThinOverride(restored);

    let globalBase: Record<string, unknown> | undefined;
    let globalState: LoadedConfigFileState | undefined;

    if (scope === "project") {
      // Re-read global configuration safely under the project lock.
      // Cooperative race boundary: the global file may change concurrently without global lock acquisition,
      // but re-reading safely here ensures up-to-date validation before writing the project override.
      // Project configurations must only persist thin override keys and never store shared credentials.
      const globalConfigPath = path.join(agentDir, "mcp.json");
      assertEditableFile(globalConfigPath);
      const globalErrors: string[] = [];
      globalState = readConfigFileSafe(globalConfigPath, "global", globalErrors);

      if (isOverride) {
        globalBase = globalState.servers.get(name);
        if (!globalBase) {
          throw new McpValidationError(`server "${name}" needs "command" or "url", or a global server to override`);
        }
        const extra = Object.keys(restored).filter((k) => !isOverrideKey(k));
        if (extra.length > 0) {
          throw new McpValidationError(`server "${name}": an override can only set ${MCP_OVERRIDE_KEYS.join(", ")}`);
        }
      }
    }

    const validation = isOverride
      ? validateMcpServerConfig(name, restored, scope, globalBase)
      : validateMcpServerConfig(name, restored, scope);

    if (!validation.valid) {
      throw new McpValidationError(validation.error);
    }

    // Check same-file namespace clash (different name, same namespace)
    const newNs = mcpNamespace(name);
    for (const otherName of Object.keys(currentServers)) {
      if (otherName !== name && mcpNamespace(otherName) === newNs) {
        throw new McpValidationError(
          `Server "${name}" conflicts with existing server "${otherName}" in the same scope`,
        );
      }
    }

    // If writing project scope, check against global servers for alias clash
    if (scope === "project" && globalState) {
      const globalServerNames = isRecord(globalState.parsedTop?.mcpServers)
        ? Object.keys(globalState.parsedTop.mcpServers)
        : [...globalState.servers.keys()];
      for (const globName of globalServerNames) {
        if (globName !== name && mcpNamespace(globName) === newNs) {
          throw new McpValidationError(
            `Project server "${name}" conflicts with global server "${globName}" namespace`,
          );
        }
      }
    }

    // If writing global scope and we know effectiveCwd and it's trusted, check against project servers
    if (scope === "global" && effectiveCwd && isProjectExplicitlyTrusted(effectiveCwd, agentDir)) {
      const projConfigPath = path.join(effectiveCwd, ".pi", "mcp.json");
      if (existsSync(projConfigPath)) {
        try {
          assertEditableFile(projConfigPath);
          const projState = readConfigFileSafe(projConfigPath, "project", []);
          const projServerNames = isRecord(projState.parsedTop?.mcpServers)
            ? Object.keys(projState.parsedTop.mcpServers)
            : [...projState.servers.keys()];
          for (const projName of projServerNames) {
            if (projName !== name && mcpNamespace(projName) === newNs) {
              throw new McpValidationError(
                `Global server "${name}" conflicts with project server "${projName}" namespace`,
              );
            }
          }
        } catch (e) {
          if (e instanceof McpValidationError) throw e;
        }
      }
    }

    const persisted = { ...validation.config };
    if (!isOverride) {
      if (persisted.enabled === true) delete persisted.enabled;
      if (persisted.exposure === "codemode") delete persisted.exposure;
    }
    const nextServers = { ...currentServers, [name]: persisted };
    parsed.mcpServers = nextServers;

    mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(targetPath, `${JSON.stringify(parsed, null, indent)}\n`);
  }, revalidate);

  return getMcpCatalog({
    cwd: effectiveCwd ?? cwd,
    agentDir,
    allowedRoots: options?.allowedRoots,
  });
}

export async function deleteMcpServer(
  request: DeleteMcpServerRequest,
  options?: McpConfigOptions,
): Promise<McpCatalogResponse> {
  const { scope, cwd, name, revision } = request;
  if (typeof revision !== "string") throw new McpValidationError("revision must be a string");

  if (scope !== "global" && scope !== "project") {
    throw new McpValidationError('scope must be "global" or "project"');
  }

  const nameError = validateMcpServerName(name);
  if (nameError) {
    throw new McpValidationError(nameError);
  }

  const agentDir = options?.agentDir ?? getAgentDir();
  let targetPath: string;
  let effectiveCwd: string | null = null;

  if (scope === "project") {
    if (!cwd) {
      throw new McpValidationError("cwd is required for project scope");
    }
    const resolved = resolveAndValidateProjectPath(cwd, options?.allowedRoots);
    effectiveCwd = resolved.cwd;
    if (!isProjectExplicitlyTrusted(effectiveCwd, agentDir)) {
      throw new McpSecurityError("Project is not explicitly trusted");
    }
    targetPath = resolved.projectConfigPath;
  } else {
    targetPath = path.join(agentDir, "mcp.json");
    if (cwd) {
      try {
        const resolved = resolveAndValidateProjectPath(cwd, options?.allowedRoots);
        effectiveCwd = resolved.cwd;
      } catch {
        throw new McpSecurityError("Invalid project context for global deletion");      }
    }
  }

  const revalidate = createRevalidator(scope, effectiveCwd, targetPath, agentDir, options?.allowedRoots);
  await withFileLock(targetPath, async ({ exists, content, revision: currentRevision }) => {
    if (revision !== currentRevision) {
      throw new McpConflictError(
        `Revision conflict: expected "${revision}", found "${currentRevision}"`,
      );
    }

    if (!exists || content === null) {
      // Nothing to delete if file doesn't exist
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new McpInvalidFileError(
        "Existing MCP config contains invalid JSON; aborting write to prevent data loss",
      );
    }

    if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
      throw new McpInvalidFileError(
        "Existing MCP config is not an object with an optional mcpServers record",
      );
    }

    const indent = detectIndent(content);
    const currentServers = isRecord(parsed.mcpServers) ? { ...parsed.mcpServers } : {};

    if (Object.hasOwn(currentServers, name)) {
      delete currentServers[name];
      parsed.mcpServers = currentServers;

      mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      writePrivateFileAtomicSync(targetPath, `${JSON.stringify(parsed, null, indent)}\n`);
    }
  }, revalidate);

  return getMcpCatalog({
    cwd: effectiveCwd ?? cwd,
    agentDir,
    allowedRoots: options?.allowedRoots,
  });
}
