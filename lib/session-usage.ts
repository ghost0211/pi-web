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

/** Per-provider aggregation with a model breakdown. */
export interface ProviderUsage extends UsageMetric {
  provider: string;
  models: ModelUsage[];
}

/** One point of the trend series; `date` is `YYYY-MM-DD` or `YYYY-MM`. */
export interface UsageSeriesPoint {
  date: string;
  tokens: UsageTokens;
  cost: number;
  entries: number;
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
  /** Per-provider grouping with nested model breakdowns, sorted by cost. */
  providers: ProviderUsage[];
  /** Trend series over the applied range, oldest first. */
  series: UsageSeriesPoint[];
  /** Bucket width of `series`: days for spans up to 92 days, months beyond. */
  seriesGranularity: "day" | "month";
  /** The applied time filter, echoed as `YYYY-MM-DD` dates. */
  range?: { from?: string; to?: string };
  /**
   * Usage records excluded from a ranged query because their entries carry no
   * usable timestamp. Only reported when a range filter is active.
   */
  untimestampedRecords?: number;
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
  /**
   * Per-record samples, one per usage-bearing entry, in file order. They power
   * the dashboard's arbitrary time-range filtering and trend series; the cached
   * per-session aggregate stores them so different ranges reuse one parse.
   */
  records: UsageRecord[];
}

/**
 * One usage-bearing entry as a compact sample. `at` is epoch milliseconds from
 * the entry (or message) timestamp; 0 marks a record without a usable
 * timestamp, which ranged queries exclude and report.
 */
export interface UsageRecord {
  at: number;
  /** Normalized `provider/model` key, matching `SessionUsage.models`. */
  modelKey: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
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
  /** Inclusive absolute time bounds (epoch ms) for the dashboard range filter. */
  fromMs?: number;
  toMs?: number;
  /**
   * Client timezone offset in minutes (`Date.getTimezoneOffset()`), used for
   * day/month bucket labels. Defaults to UTC.
   */
  tzOffsetMinutes?: number;
  /** Applied range echoed back in the response, as `YYYY-MM-DD` dates. */
  rangeLabel?: { from?: string; to?: string };
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
 * Sums every usage record in a session file into per-model slices. The same
 * parse also emits the timestamped per-record samples the dashboard filters by.
 * Each record is attributed to the model that produced it:
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
    records: [],
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
          if (message.usage) addUsage(usage, current, message.usage, entryTimestampMs(entry));
        } else if (message.role === "toolResult") {
          if (message.usage) addUsage(usage, current, message.usage, entryTimestampMs(entry));
        }
        break;
      }
      case "compaction":
      case "branch_summary":
        // Reads from a compaction/summary entry as well as an assistant message:
        // pi charges these summarization calls to the active model.
        if (entry.usage) addUsage(usage, current, entry.usage, entryTimestampMs(entry));
        break;
      default:
        break;
    }
  }

  finalizeUsage(usage);
  return usage;
}

/**
 * Best-effort epoch milliseconds for one entry: the entry's own timestamp,
 * falling back to the message's numeric timestamp. Returns 0 when neither is
 * usable; ranged queries exclude such records instead of guessing a bucket.
 */
function entryTimestampMs(entry: SessionEntry): number {
  const raw = (entry as { timestamp?: unknown }).timestamp;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  const message = (entry as { message?: { timestamp?: unknown } }).message;
  if (message && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  return 0;
}

function addUsage(target: SessionUsage, model: ModelRef, usage: AgentUsage, at: number): void {
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
  target.records.push({ at, modelKey: model.key, input, output, cacheRead, cacheWrite, cost });

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
 * Lists sessions on disk, sums their recorded usage within the applied time
 * range, and groups the result by project, by model, and by provider, plus a
 * day/month trend series. Never throws for a single bad session — problems are
 * reported through `skipped` / `partial`.
 */
export async function collectUsage(options: CollectUsageOptions = {}): Promise<UsageResponse> {
  const maxSessions = options.maxSessions ?? USAGE_MAX_SESSION_SCAN;
  const maxEntries = options.maxEntries ?? USAGE_MAX_ENTRY_SCAN;
  const maxFileBytes = options.maxFileBytes ?? USAGE_MAX_FILE_BYTES;
  const cacheLimit = options.cacheLimit ?? USAGE_CACHE_MAX_SESSIONS;
  const signal = options.signal;
  const { fromMs, toMs } = options;
  const rangeActive = fromMs !== undefined || toMs !== undefined;
  const tzOffsetMinutes = normalizeTzOffsetMinutes(options.tzOffsetMinutes);

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
  const models = new Map<string, ModelBucket>();
  const providers = new Map<string, ProviderAccumulator>();
  const series = new Map<string, UsageBucket>();
  const totals = newSessionBucket();
  const skipped: UsageSkipSummary = { oversized: 0, unreadable: 0, budget: 0 };
  let untimestampedRecords = 0;
  let scannedSessions = 0;
  let scannedEntries = 0;

  for (let sessionIndex = 0; sessionIndex < ordered.length; sessionIndex += 1) {
    if (scannedSessions >= maxSessions || scannedEntries >= maxEntries) break;
    if (signal?.aborted) break;
    const session = ordered[sessionIndex];

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

    // Records within the applied range. Untimestamped records are excluded from
    // ranged queries and reported, never silently dropped or guessed.
    let records = result.usage.records;
    if (rangeActive) {
      const inRange: UsageRecord[] = [];
      for (const record of records) {
        if (record.at === 0) {
          untimestampedRecords += 1;
          continue;
        }
        if (fromMs !== undefined && record.at < fromMs) continue;
        if (toMs !== undefined && record.at > toMs) continue;
        inRange.push(record);
      }
      records = inRange;
    }

    // Sessions with no recorded usage in range never create an empty bucket row.
    if (records.length === 0) continue;

    const projectId = hashProjectId(projectKeyForSession(session));
    let project = projects.get(projectId);
    if (!project) {
      project = {
        projectId,
        name: projectDisplayName(session),
        lastActivity: session.modified,
        ...newSessionBucket(),
        models: new Map<string, ModelBucket>(),
      };
      projects.set(projectId, project);
    }
    if (session.modified && (!project.lastActivity || session.modified > project.lastActivity)) {
      project.lastActivity = session.modified;
    }

    for (const record of records) {
      const slice = result.usage.models.get(record.modelKey);
      const provider = slice?.provider ?? UNKNOWN_MODEL;
      const model = slice?.model ?? UNKNOWN_MODEL;

      addRecord(totals, record);
      totals.sessions.add(sessionIndex);
      addModelRecord(models, record, provider, model, sessionIndex);
      addModelRecord(project.models, record, provider, model, sessionIndex);
      addRecord(project, record);
      project.sessions.add(sessionIndex);

      let providerBucket = providers.get(provider);
      if (!providerBucket) {
        providerBucket = { provider, ...newSessionBucket(), models: new Map<string, ModelBucket>() };
        providers.set(provider, providerBucket);
      }
      addRecord(providerBucket, record);
      providerBucket.sessions.add(sessionIndex);
      addModelRecord(providerBucket.models, record, provider, model, sessionIndex);

      if (record.at !== 0) {
        const key = dayBucketKey(record.at, tzOffsetMinutes);
        let bucket = series.get(key);
        if (!bucket) {
          bucket = newUsageBucket();
          series.set(key, bucket);
        }
        addRecord(bucket, record);
      }
    }

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
  const finalProviders = [...providers.values()]
    .map((provider) => finalizeProvider(provider))
    .sort(compareProviderUsage);
  const trend = finalizeSeries(series);

  return {
    scope: buildScope(scopeKey, finalProjects),
    totals: finalizeSessionBucket(totals),
    projects: finalProjects,
    models: finalModels,
    providers: finalProviders,
    series: trend.points,
    seriesGranularity: trend.granularity,
    ...(options.rangeLabel ? { range: options.rangeLabel } : {}),
    ...(rangeActive && untimestampedRecords > 0 ? { untimestampedRecords } : {}),
    partial,
    scannedSessions,
    scannedEntries,
    skipped,
    generatedAt: new Date().toISOString(),
  };
}

interface ProjectAccumulator extends SessionBucket {
  projectId: string;
  name: string;
  lastActivity?: string;
  models: Map<string, ModelBucket>;
}

interface ProviderAccumulator extends SessionBucket {
  provider: string;
  models: Map<string, ModelBucket>;
}

/** Numeric sums for one aggregation bucket. */
interface UsageBucket {
  entries: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** A bucket that also tracks which scanned sessions contributed to it. */
interface SessionBucket extends UsageBucket {
  sessions: Set<number>;
}

interface ModelBucket extends SessionBucket {
  provider: string;
  model: string;
}

function newUsageBucket(): UsageBucket {
  return { entries: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function newSessionBucket(): SessionBucket {
  return { ...newUsageBucket(), sessions: new Set<number>() };
}

function addRecord(bucket: UsageBucket, record: UsageRecord): void {
  bucket.entries += 1;
  bucket.input += record.input;
  bucket.output += record.output;
  bucket.cacheRead += record.cacheRead;
  bucket.cacheWrite += record.cacheWrite;
  bucket.cost += record.cost;
}

function addModelRecord(models: Map<string, ModelBucket>, record: UsageRecord, provider: string, model: string, sessionIndex: number): void {
  let bucket = models.get(record.modelKey);
  if (!bucket) {
    bucket = { ...newSessionBucket(), provider, model };
    models.set(record.modelKey, bucket);
  }
  addRecord(bucket, record);
  bucket.sessions.add(sessionIndex);
}

/** Client-local calendar day label (`YYYY-MM-DD`) for one record. */
function dayBucketKey(at: number, tzOffsetMinutes: number): string {
  // Shifting by the client's offset makes the UTC fields read as local time.
  return new Date(at - tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function normalizeTzOffsetMinutes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  // Real-world offsets stay within UTC±14:00.
  return Math.max(-840, Math.min(840, Math.trunc(value)));
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

function finalizeModel(model: ModelBucket): ModelUsage {
  return {
    key: `${model.provider}/${model.model}`,
    provider: model.provider,
    model: model.model,
    sessions: model.sessions.size,
    entries: model.entries,
    tokens: {
      input: model.input,
      output: model.output,
      cacheRead: model.cacheRead,
      cacheWrite: model.cacheWrite,
      total: model.input + model.output + model.cacheRead + model.cacheWrite,
    },
    cost: model.cost,
  };
}

function finalizeSessionBucket(bucket: SessionBucket): UsageMetric {
  return {
    sessions: bucket.sessions.size,
    entries: bucket.entries,
    tokens: {
      input: bucket.input,
      output: bucket.output,
      cacheRead: bucket.cacheRead,
      cacheWrite: bucket.cacheWrite,
      total: bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite,
    },
    cost: bucket.cost,
  };
}

function finalizeProject(project: ProjectAccumulator): ProjectUsage {
  return {
    projectId: project.projectId,
    name: project.name,
    ...(project.lastActivity ? { lastActivity: project.lastActivity } : {}),
    ...finalizeSessionBucket(project),
    models: [...project.models.values()].map(finalizeModel).sort(compareModelUsage),
  };
}

function finalizeProvider(provider: ProviderAccumulator): ProviderUsage {
  return {
    provider: provider.provider,
    ...finalizeSessionBucket(provider),
    models: [...provider.models.values()].map(finalizeModel).sort(compareModelUsage),
  };
}

/** Day-span threshold beyond which the trend series switches to months. */
const SERIES_MAX_DAY_SPAN = 92;

function finalizeSeries(days: Map<string, UsageBucket>): { points: UsageSeriesPoint[]; granularity: "day" | "month" } {
  const keys = [...days.keys()].sort();
  if (keys.length === 0) return { points: [], granularity: "day" };
  const spanDays = (Date.parse(`${keys[keys.length - 1]}T00:00:00.000Z`) - Date.parse(`${keys[0]}T00:00:00.000Z`)) / 86_400_000;
  if (spanDays <= SERIES_MAX_DAY_SPAN) {
    return { points: keys.map((date) => seriesPoint(date, days.get(date)!)), granularity: "day" };
  }
  const months = new Map<string, UsageBucket>();
  for (const [day, bucket] of days) {
    const key = day.slice(0, 7);
    let month = months.get(key);
    if (!month) {
      month = newUsageBucket();
      months.set(key, month);
    }
    addBucket(month, bucket);
  }
  return {
    points: [...months.keys()].sort().map((date) => seriesPoint(date, months.get(date)!)),
    granularity: "month",
  };
}

function addBucket(target: UsageBucket, source: UsageBucket): void {
  target.entries += source.entries;
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
}

function seriesPoint(date: string, bucket: UsageBucket): UsageSeriesPoint {
  return {
    date,
    tokens: {
      input: bucket.input,
      output: bucket.output,
      cacheRead: bucket.cacheRead,
      cacheWrite: bucket.cacheWrite,
      total: bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite,
    },
    cost: bucket.cost,
    entries: bucket.entries,
  };
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

function compareProviderUsage(a: ProviderUsage, b: ProviderUsage): number {
  return b.cost - a.cost
    || b.tokens.total - a.tokens.total
    || a.provider.localeCompare(b.provider);
}

// ============================================================================
// Time-range parameter parsing (shared by the API route, unit-testable)
// ============================================================================

/** Parsed and validated time-range query parameters. */
export interface UsageRangeParams {
  /** Inclusive absolute bounds in epoch ms; absent sides mean open-ended. */
  fromMs?: number;
  toMs?: number;
  /** Client timezone offset in minutes (`Date.getTimezoneOffset()` semantics). */
  tzOffsetMinutes: number;
  /** Original `YYYY-MM-DD` values to echo back in the response. */
  rangeLabel?: { from?: string; to?: string };
}

const DATE_PARAM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TZ_PARAM_PATTERN = /^-?\d{1,4}$/;
const DAY_MS = 86_400_000;

/**
 * Parses `from` / `to` (`YYYY-MM-DD`, client-local calendar days) and `tz`
 * (client `Date.getTimezoneOffset()` minutes) into absolute epoch-ms bounds.
 * Returns an error string for any invalid parameter instead of guessing.
 */
export function parseUsageRangeParams(searchParams: URLSearchParams): UsageRangeParams | { error: string } {
  const from = searchParams.get("from")?.trim() || undefined;
  const to = searchParams.get("to")?.trim() || undefined;

  let tzOffsetMinutes = 0;
  const tzRaw = searchParams.get("tz");
  if (tzRaw !== null && tzRaw !== "") {
    if (!TZ_PARAM_PATTERN.test(tzRaw)) return { error: "Invalid tz parameter" };
    const parsed = Number.parseInt(tzRaw, 10);
    // Real-world offsets stay within UTC±14:00.
    if (!Number.isFinite(parsed) || Math.abs(parsed) > 14 * 60) return { error: "Invalid tz parameter" };
    tzOffsetMinutes = parsed;
  }

  for (const [name, value] of [["from", from], ["to", to]] as const) {
    if (value === undefined) continue;
    if (!DATE_PARAM_PATTERN.test(value)) return { error: `Invalid ${name} parameter` };
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    // Round-trip rejects impossible calendar dates like 2026-02-30.
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
      return { error: `Invalid ${name} parameter` };
    }
  }
  if (from !== undefined && to !== undefined && from > to) return { error: "from must not be after to" };

  const tzMs = tzOffsetMinutes * 60_000;
  return {
    ...(from !== undefined ? { fromMs: Date.parse(`${from}T00:00:00.000Z`) + tzMs } : {}),
    ...(to !== undefined ? { toMs: Date.parse(`${to}T00:00:00.000Z`) + tzMs + DAY_MS - 1 } : {}),
    tzOffsetMinutes,
    ...(from !== undefined || to !== undefined
      ? { rangeLabel: { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) } }
      : {}),
  };
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
