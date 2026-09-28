/**
 * Cross-session usage & cost aggregation.
 *
 * The chat sidebar shows the running token/cost counters for the *active*
 * session. This module answers the complementary question: "where did all my
 * usage go?" — across every session on disk, grouped by project and by model.
 *
 * Cost is never recomputed. Each usage record in a session file already carries
 * the historical `usage.cost.total` that pi recorded at request time; this
 * module only sums those numbers. That keeps the totals stable even when the
 * model price catalog changes after the fact.
 *
 * Resource control (a scan runs on the shared Next.js server):
 *   - a file-size gate before parsing, so a session with huge attachments is
 *     skipped instead of being loaded into memory;
 *   - session-count and entry-count budgets;
 *   - an mtime/size-keyed LRU cache of per-session aggregates, so repeated
 *     panel opens do not re-parse unchanged files and memory stays bounded;
 *   - sessions are scanned sequentially and the event loop is yielded between
 *     them; the request's AbortSignal stops a scan whose client went away.
 *
 * Privacy: the response never contains a session file path or a raw `cwd`.
 * Projects are identified by a short opaque hash and a basename-only display
 * name, so an aggregation payload cannot leak a user's directory layout.
 *
 * Every omission is reported through `partial` / `skipped` instead of silently
 * returning smaller totals.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { projectIdentityKey } from "./project-identity";
import { sessionPathKey } from "./session-path";
import { getSessionEntries, listAllSessions } from "./session-reader";
import type { AgentUsage, SessionEntry, SessionInfo } from "./types";

/** Token buckets used across pi-web, matching `SessionFileStats["tokens"]`. */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** A single aggregation bucket (a project, a model, or the overall total). */
export interface UsageMetric {
  /** Sessions that contributed at least one usage record to this bucket. */
  sessions: number;
  /** Usage-bearing entries (assistant / tool result / compaction / summary). */
  entries: number;
  tokens: UsageTokens;
  cost: number;
}

/** Per-model aggregation. `key` is a stable `provider/model` identifier. */
export interface ModelUsage extends UsageMetric {
  key: string;
  provider: string;
  model: string;
}

/** Per-project aggregation with a model breakdown. */
export interface ProjectUsage extends UsageMetric {
  /** Short opaque id derived from the project key — never the raw path. */
  projectId: string;
  /** Basename-only display name, safe to show in the UI. */
  name: string;
  /** Newest `modified` timestamp among the project's contributing sessions. */
  lastActivity?: string;
  models: ModelUsage[];
}

/** Which scope produced a response. */
export interface UsageScope {
  projectId?: string;
  /** Basename-only display name for the scoped project. */
  name?: string;
}

/** Why sessions/files were left out of a scan. */
export interface UsageSkipSummary {
  /** Files whose size exceeded the per-file cap. */
  oversized: number;
  /** Files that could not be stat'ed or parsed. */
  unreadable: number;
  /** Sessions not reached because a scan budget was exhausted. */
  budget: number;
}

/** Response body of `GET /api/usage`. */
export interface UsageResponse {
  scope: UsageScope;
  totals: UsageMetric;
  projects: ProjectUsage[];
  models: ModelUsage[];
  /** True when any session/file was skipped or a budget cut the scan short. */
  partial: boolean;
  scannedSessions: number;
  scannedEntries: number;
  skipped: UsageSkipSummary;
  generatedAt: string;
}

/** Per-session aggregate produced by {@link computeSessionUsage}. */
export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  /** Number of usage-bearing entries in the session file. */
  entries: number;
  /** Per-model slices keyed by the normalized `provider/model` key. */
  models: Map<string, SessionUsageSlice>;
}

export interface SessionUsageSlice {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  entries: number;
}

export interface CollectUsageOptions {
  /**
   * Restrict the aggregation to one project. Takes precedence over `cwd`.
   * Callers that already have the server-computed key (a `SessionInfo`
   * `projectKey`) should pass it here so worktrees group with their main repo.
   */
  projectKey?: string;
  /** Project working directory; resolved to a project key before matching. */
  cwd?: string;
  /**
   * Pre-listed catalogue. Defaults to `listAllSessions()`. Callers that already
   * listed sessions (or tests) can pass it to avoid a second disk scan.
   */
  sessions?: readonly SessionInfo[];
  maxSessions?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  /** Bound for the per-session aggregate cache; defaults to the module maximum. */
  cacheLimit?: number;
  signal?: AbortSignal;
}

/** Files larger than this are skipped (large base64 attachments). */
export const USAGE_MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Upper bound on sessions visited by one request. */
export const USAGE_MAX_SESSION_SCAN = 400;
/** Upper bound on entries visited by one request. */
export const USAGE_MAX_ENTRY_SCAN = 200_000;
/** Upper bound on cached per-session aggregates (LRU eviction beyond this). */
export const USAGE_CACHE_MAX_SESSIONS = 500;
/** Maximum accepted length for the `cwd` / `projectKey` query parameter. */
export const USAGE_MAX_SCOPE_PARAM_LENGTH = 1024;

const UNKNOWN_MODEL = "unknown";

interface ModelRef {
  key: string;
  provider: string;
  model: string;
}

function emptyUsageTokens(): UsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function emptyMetric(): UsageMetric {
  return { sessions: 0, entries: 0, tokens: emptyUsageTokens(), cost: 0 };
}

function numberOr0(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Normalizes a provider/model pair into a stable aggregation key. */
export function normalizeUsageModel(provider: unknown, model: unknown): ModelRef {
  const p = typeof provider === "string" ? provider.trim() : "";
  const m = typeof model === "string" ? model.trim() : "";
  if (p === "" && m === "") {
    return { key: UNKNOWN_MODEL, provider: UNKNOWN_MODEL, model: UNKNOWN_MODEL };
  }
  const providerLabel = p || UNKNOWN_MODEL;
  const modelLabel = m || UNKNOWN_MODEL;
  return { key: `${providerLabel}/${modelLabel}`, provider: providerLabel, model: modelLabel };
}

/**
 * Sums every usage record in a session file, attributing each one to the model
 * that produced it:
 *   - an assistant message carries its own provider/model;
 *   - a tool-result message or a compaction/branch-summary entry has no model of
 *     its own, so it is attributed to the most recently seen model in file order
 *     (`model_change` entries and assistant messages both advance that cursor).
 */
export function computeSessionUsage(entries: readonly SessionEntry[]): SessionUsage {
  const usage: SessionUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    entries: 0,
    models: new Map(),
  };

  let current = normalizeUsageModel(undefined, undefined);

  for (const entry of entries) {
    switch (entry.type) {
      case "model_change":
        current = normalizeUsageModel(entry.provider, entry.modelId);
        break;
      case "message": {
        const message = entry.message;
        if (message.role === "assistant") {
          // The message's own model is authoritative for the message itself and
          // for any tool results that follow it.
          current = normalizeUsageModel(message.provider, message.model);
          if (message.usage) addUsage(usage, current, message.usage);
        } else if (message.role === "toolResult") {
          if (message.usage) addUsage(usage, current, message.usage);
        }
        break;
      }
      case "compaction":
      case "branch_summary":
        // Reads from a compaction/summary entry as well as an assistant message:
        // pi charges these summarization calls to the active model.
        if (entry.usage) addUsage(usage, current, entry.usage);
        break;
      default:
        break;
    }
  }

  finalizeUsage(usage);
  return usage;
}

function addUsage(target: SessionUsage, model: ModelRef, usage: AgentUsage): void {
  const input = numberOr0(usage.input);
  const output = numberOr0(usage.output);
  const cacheRead = numberOr0(usage.cacheRead);
  const cacheWrite = numberOr0(usage.cacheWrite);
  const cost = numberOr0(usage.cost?.total);

  target.input += input;
  target.output += output;
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  target.cost += cost;
  target.entries += 1;

  const slice = target.models.get(model.key) ?? {
    provider: model.provider,
    model: model.model,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    entries: 0,
  };
  slice.input += input;
  slice.output += output;
  slice.cacheRead += cacheRead;
  slice.cacheWrite += cacheWrite;
  slice.cost += cost;
  slice.entries += 1;
  target.models.set(model.key, slice);
}

function finalizeUsage(usage: SessionUsage): void {
  usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  for (const slice of usage.models.values()) {
    slice.total = slice.input + slice.output + slice.cacheRead + slice.cacheWrite;
  }
}

// ============================================================================
// Per-session aggregate cache. Stored in globalThis for hot-reload safety, and
// bounded by an LRU so a long-lived server cannot grow it without limit.
// ============================================================================

interface CachedSessionUsage {
  size: number;
  mtimeMs: number;
  entryCount: number;
  usage: SessionUsage;
}

declare global {
  var __piSessionUsageCache: Map<string, CachedSessionUsage> | undefined;
}

function getUsageCache(): Map<string, CachedSessionUsage> {
  if (!globalThis.__piSessionUsageCache) globalThis.__piSessionUsageCache = new Map();
  return globalThis.__piSessionUsageCache;
}

/** Test/diagnostic helper: number of per-session aggregates currently cached. */
export function getSessionUsageCacheSize(): number {
  return getUsageCache().size;
}

/** Test/diagnostic helper: drop all cached per-session aggregates. */
export function clearSessionUsageCache(): void {
  getUsageCache().clear();
}

type SessionLoadResult =
  | { kind: "ok"; usage: SessionUsage; entryCount: number }
  | { kind: "oversized" }
  | { kind: "unreadable" };

function loadSessionUsage(filePath: string, maxFileBytes: number, cacheLimit: number): SessionLoadResult {
  if (!filePath) return { kind: "unreadable" };

  let size: number;
  let mtimeMs: number;
  try {
    const stat = statSync(filePath);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    return { kind: "unreadable" };
  }
  if (size > maxFileBytes) return { kind: "oversized" };

  const cache = getUsageCache();
  const cacheKey = sessionPathKey(filePath);
  const cached = cache.get(cacheKey);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    // LRU touch: re-insert so the most recently used entry is evicted last.
    cache.delete(cacheKey);
    cache.set(cacheKey, cached);
    return { kind: "ok", usage: cached.usage, entryCount: cached.entryCount };
  }

  let entries: SessionEntry[];
  try {
    entries = getSessionEntries(filePath);
  } catch {
    return { kind: "unreadable" };
  }

  const usage = computeSessionUsage(entries);
  const entryCount = entries.length;
  if (cached) cache.delete(cacheKey);
  cache.set(cacheKey, { size, mtimeMs, entryCount, usage });
  evictUsageCache(cache, cacheLimit);
  return { kind: "ok", usage, entryCount };
}

function evictUsageCache(cache: Map<string, CachedSessionUsage>, limit: number): void {
  const max = Math.max(1, Math.floor(limit));
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// ============================================================================
// Scanning
// ============================================================================

/**
 * Lists sessions on disk, sums their recorded usage, and groups the result by
 * project and by model. Never throws for a single bad session — problems are
 * reported through `skipped` / `partial`.
 */
export async function collectUsage(options: CollectUsageOptions = {}): Promise<UsageResponse> {
  const maxSessions = options.maxSessions ?? USAGE_MAX_SESSION_SCAN;
  const maxEntries = options.maxEntries ?? USAGE_MAX_ENTRY_SCAN;
  const maxFileBytes = options.maxFileBytes ?? USAGE_MAX_FILE_BYTES;
  const cacheLimit = options.cacheLimit ?? USAGE_CACHE_MAX_SESSIONS;
  const signal = options.signal;

  const scopeKey = options.projectKey
    ? projectIdentityKey(options.projectKey)
    : options.cwd
      ? projectIdentityKey(options.cwd)
      : undefined;

  const catalogue = options.sessions ?? (await listAllSessions());
  // Newest sessions first: the scan order (and therefore which sessions fit in a
  // budget) follows "most recently active" rather than filesystem order.
  const ordered = [...catalogue]
    .filter((session) => sessionInScope(session, scopeKey))
    .sort((a, b) => String(b.modified ?? "").localeCompare(String(a.modified ?? "")));

  const projects = new Map<string, ProjectAccumulator>();
  const models = new Map<string, ModelAccumulator>();
  const skipped: UsageSkipSummary = { oversized: 0, unreadable: 0, budget: 0 };
  let scannedSessions = 0;
  let scannedEntries = 0;

  for (const session of ordered) {
    if (scannedSessions >= maxSessions || scannedEntries >= maxEntries) break;
    if (signal?.aborted) break;

    const result = loadSessionUsage(session.path, maxFileBytes, cacheLimit);
    if (result.kind === "oversized") {
      skipped.oversized += 1;
      continue;
    }
    if (result.kind === "unreadable") {
      skipped.unreadable += 1;
      continue;
    }

    scannedSessions += 1;
    scannedEntries += result.entryCount;

    // Sessions with no recorded usage never create an empty bucket row.
    if (!hasUsage(result.usage)) continue;

    const projectId = hashProjectId(projectKeyForSession(session));
    const project = projects.get(projectId) ?? {
      projectId,
      name: projectDisplayName(session),
      lastActivity: session.modified,
      sessions: 0,
      usage: emptySessionUsage(),
      models: new Map<string, ModelAccumulator>(),
    };
    if (session.modified && (!project.lastActivity || session.modified > project.lastActivity)) {
      project.lastActivity = session.modified;
    }
    project.sessions += 1;
    addSessionTotals(project.usage, result.usage);
    for (const [key, slice] of result.usage.models) {
      mergeModel(project.models, key, slice);
      mergeModel(models, key, slice);
    }
    projects.set(projectId, project);

    // Sequential scan keeps at most one session's entries in memory, and the
    // yield keeps a large catalogue from blocking the server's event loop.
    await yieldToEventLoop();
  }

  const remaining = ordered.length - scannedSessions - skipped.oversized - skipped.unreadable;
  if (remaining > 0) skipped.budget = remaining;
  const partial = skipped.oversized > 0 || skipped.unreadable > 0 || skipped.budget > 0;

  const finalProjects = [...projects.values()]
    .map((project) => finalizeProject(project))
    .sort(compareProjectUsage);
  const finalModels = [...models.values()]
    .map((model) => finalizeModel(model))
    .sort(compareModelUsage);

  const totals = combineUsageMetrics(finalProjects);

  return {
    scope: buildScope(scopeKey, finalProjects),
    totals,
    projects: finalProjects,
    models: finalModels,
    partial,
    scannedSessions,
    scannedEntries,
    skipped,
    generatedAt: new Date().toISOString(),
  };
}

interface ProjectAccumulator {
  projectId: string;
  name: string;
  lastActivity?: string;
  /** Number of contributing sessions in this project. */
  sessions: number;
  usage: SessionUsage;
  models: Map<string, ModelAccumulator>;
}

interface ModelAccumulator extends SessionUsageSlice {
  sessions: number;
}

function emptySessionUsage(): SessionUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    entries: 0,
    models: new Map(),
  };
}

function hasUsage(usage: SessionUsage): boolean {
  return usage.entries > 0;
}

function projectKeyForSession(session: SessionInfo): string {
  return session.projectKey
    ?? projectIdentityKey(session.projectRoot ?? session.cwd ?? "");
}

function projectDisplayName(session: SessionInfo): string {
  return displayNameFromPath(session.projectRoot ?? session.cwd ?? "");
}

/** Basename-only label; falls back to a placeholder when there is no basename. */
function displayNameFromPath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const base = trimmed ? basename(trimmed) : "";
  return base || "Unknown project";
}

/**
 * Short, stable, non-reversible identifier for a project key. Keeps the JSON
 * payload free of the user's directory structure while still giving React a
 * stable list key and giving the UI a way to dedupe.
 */
function hashProjectId(projectKey: string): string {
  return createHash("sha1").update(projectKey).digest("hex").slice(0, 12);
}

function sessionInScope(session: SessionInfo, scopeKey: string | undefined): boolean {
  if (!scopeKey) return true;
  const candidates = [session.projectKey, session.projectRoot, session.cwd];
  return candidates.some((candidate) => candidate && projectIdentityKey(candidate) === scopeKey);
}

/** Adds a session's totals to a project's running total. */
function addSessionTotals(target: SessionUsage, source: SessionUsage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.entries += source.entries;
  target.total = target.input + target.output + target.cacheRead + target.cacheWrite;
}

/**
 * Merges one session's per-model slice into a model bucket. The caller invokes
 * this once per session, so `sessions` effectively counts the sessions that
 * used the model — both globally and within a single project.
 */
function mergeModel(models: Map<string, ModelAccumulator>, key: string, slice: SessionUsageSlice): void {
  const existing = models.get(key);
  if (!existing) {
    models.set(key, { ...slice, sessions: 1 });
    return;
  }
  existing.sessions += 1;
  existing.input += slice.input;
  existing.output += slice.output;
  existing.cacheRead += slice.cacheRead;
  existing.cacheWrite += slice.cacheWrite;
  existing.total += slice.total;
  existing.cost += slice.cost;
  existing.entries += slice.entries;
}

function sliceKey(slice: SessionUsageSlice): string {
  return `${slice.provider}/${slice.model}`;
}

function finalizeModel(model: ModelAccumulator): ModelUsage {
  return {
    key: sliceKey(model),
    provider: model.provider,
    model: model.model,
    sessions: model.sessions,
    entries: model.entries,
    tokens: {
      input: model.input,
      output: model.output,
      cacheRead: model.cacheRead,
      cacheWrite: model.cacheWrite,
      total: model.total,
    },
    cost: model.cost,
  };
}

function finalizeProject(project: ProjectAccumulator): ProjectUsage {
  return {
    projectId: project.projectId,
    name: project.name,
    ...(project.lastActivity ? { lastActivity: project.lastActivity } : {}),
    sessions: project.sessions,
    entries: project.usage.entries,
    tokens: {
      input: project.usage.input,
      output: project.usage.output,
      cacheRead: project.usage.cacheRead,
      cacheWrite: project.usage.cacheWrite,
      total: project.usage.total,
    },
    cost: project.usage.cost,
    models: [...project.models.values()].map(finalizeModel).sort(compareModelUsage),
  };
}

function combineUsageMetrics(items: UsageMetric[]): UsageMetric {
  const total = emptyMetric();
  for (const item of items) {
    total.sessions += item.sessions;
    total.entries += item.entries;
    total.tokens.input += item.tokens.input;
    total.tokens.output += item.tokens.output;
    total.tokens.cacheRead += item.tokens.cacheRead;
    total.tokens.cacheWrite += item.tokens.cacheWrite;
    total.tokens.total += item.tokens.total;
    total.cost += item.cost;
  }
  return total;
}

function buildScope(scopeKey: string | undefined, projects: ProjectUsage[]): UsageScope {
  if (!scopeKey) return {};
  if (projects.length === 1) {
    return { projectId: projects[0].projectId, name: projects[0].name };
  }
  // No matching sessions: still echo a basename-only name for the filter hint.
  return { projectId: hashProjectId(scopeKey), name: displayNameFromPath(scopeKey) };
}

function compareProjectUsage(a: ProjectUsage, b: ProjectUsage): number {
  return b.cost - a.cost
    || b.tokens.total - a.tokens.total
    || a.name.localeCompare(b.name)
    || a.projectId.localeCompare(b.projectId);
}

function compareModelUsage(a: ModelUsage, b: ModelUsage): number {
  return b.cost - a.cost
    || b.tokens.total - a.tokens.total
    || a.key.localeCompare(b.key);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ============================================================================
// Display formatting
//
// Re-exported from a client-safe module: `UsagePanel` is a client component and
// must not pull this server-only file (session file access) into the browser
// bundle just to format numbers.
// ============================================================================

export { formatUsageCost, formatUsageTokens } from "./usage-format";
