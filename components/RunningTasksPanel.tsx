"use client";

import { formatRelativeTime } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/types";
import type { SessionInfo } from "@/lib/types";

/**
 * Running-tasks board: a compact list of every session that is currently
 * running, with its project, start/last-activity time, and an optional
 * server-reported current step.
 *
 * AppShell wiring (existing state, no new plumbing required):
 *
 *   <RunningTasksPanel
 *     sessions={sessionCatalog}
 *     runningSessionIds={runningSessionIds}
 *     selectedSessionId={selectedSession?.id ?? null}
 *     onSelectSession={handleSelectSession}
 *     locale={locale}
 *     translate={translate}
 *   />
 *
 * `runningSessionPhases` is optional. When the shell polls `GET /api/agent/running`
 * it may pass `new Map(Object.entries(data.runningSessionPhases ?? {}))`; when
 * omitted, the panel never renders a current step at all.
 *
 * i18n keys used (English fallbacks are built in, so wiring can lag):
 *   runningTasks.title, runningTasks.count, runningTasks.empty,
 *   runningTasks.loading, runningTasks.justNow, runningTasks.subagent,
 *   runningTasks.started, runningTasks.recent,
 *   runningTasks.phase.thinking|streaming|command|compacting
 */

/**
 * Coarse, server-derived phase for a session that is currently running.
 * Kept in sync with `RunningRpcSessionPhase` in lib/rpc-manager.ts, which is
 * what `GET /api/agent/running` returns as `runningSessionPhases`.
 */
export type RunningTaskPhase = "thinking" | "streaming" | "command" | "compacting";

/** Translator shape produced by `useI18n()`. */
export type RunningTasksTranslate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export interface RunningTasksPanelProps {
  /**
   * Full session catalog owned by AppShell (its `sessionCatalog` state). The
   * panel only ever lists the subset also present in `runningSessionIds`, so
   * it can never render a running session without real project/time data.
   */
  sessions: readonly SessionInfo[];
  /** Live running-session ids owned by AppShell (its `runningSessionIds` state). */
  runningSessionIds: ReadonlySet<string>;
  /**
   * Optional per-session phase keyed by session id, sourced from
   * `GET /api/agent/running` (`runningSessionPhases`). When omitted the panel
   * hides the "current step" line entirely instead of inventing one.
   */
  runningSessionPhases?:
    | ReadonlyMap<string, RunningTaskPhase>
    | Readonly<Record<string, RunningTaskPhase>>;
  /** Id of the session currently open in the shell, highlighted in the list. */
  selectedSessionId?: string | null;
  /** Jump to a running session. Wire to AppShell's `handleSelectSession`. */
  onSelectSession: (session: SessionInfo) => void;
  /** Show the empty state as "loading" while the first catalog fetch is in flight. */
  loading?: boolean;
  /** Injected clock (epoch ms) for deterministic relative-time output in tests. */
  now?: number;
  /** Active UI locale, passed from `useI18n()`. Defaults to English. */
  locale?: Locale;
  /** Active translator, passed from `useI18n()`. Defaults to built-in English labels. */
  translate?: RunningTasksTranslate;
}

const DEFAULT_LOCALE: Locale = "en";
/** Below this distance a relative timestamp reads better as "just now". */
const JUST_NOW_WINDOW_MS = 10_000;

const PHASE_META: Record<RunningTaskPhase, { key: string; fallback: string }> = {
  thinking: { key: "runningTasks.phase.thinking", fallback: "Thinking…" },
  streaming: { key: "runningTasks.phase.streaming", fallback: "Responding…" },
  command: { key: "runningTasks.phase.command", fallback: "Running command…" },
  compacting: { key: "runningTasks.phase.compacting", fallback: "Compacting…" },
};

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{([\w.-]+)\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}

/** Default clock for relative timestamps; kept out of render for purity lint. */
function resolveNow(now?: number): number {
  return now ?? Date.now();
}

function sessionTitle(session: SessionInfo): string {
  const relation = session.relation?.kind === "subagent" ? session.relation : null;
  return relation?.description || session.name || session.firstMessage || session.id.slice(0, 12);
}

/** Best-effort project display name: the last path segment of the repo root/cwd. */
function projectName(session: SessionInfo): string {
  const root = (session.projectRoot ?? session.cwd ?? "").replace(/[\\/]+$/, "");
  if (!root) return "—";
  const segments = root.split(/[\\/]/);
  return segments[segments.length - 1] || root;
}

/**
 * Resolve a phase for one session from either a Map or a plain object. Unknown
 * or missing values stay null so the UI never shows a fabricated step.
 */
export function resolveRunningTaskPhase(
  source:
    | ReadonlyMap<string, RunningTaskPhase>
    | Readonly<Record<string, RunningTaskPhase>>
    | undefined,
  sessionId: string,
): RunningTaskPhase | null {
  if (!source) return null;
  if (source instanceof Map) return source.get(sessionId) ?? null;
  return (source as Readonly<Record<string, RunningTaskPhase>>)[sessionId] ?? null;
}

export function RunningTasksPanel({
  sessions,
  runningSessionIds,
  runningSessionPhases,
  selectedSessionId,
  onSelectSession,
  loading = false,
  now,
  locale,
  translate,
}: RunningTasksPanelProps) {
  const activeLocale = locale ?? DEFAULT_LOCALE;
  const nowMs = resolveNow(now);

  const label = (
    key: string,
    fallback: string,
    params?: Record<string, string | number>,
  ): string => {
    const translated = translate?.(key, params);
    // `translateMessage` echoes the key when a locale has no entry yet, so fall
    // back to the built-in English label in that case.
    return translated && translated !== key ? translated : interpolate(fallback, params);
  };

  const relativeText = (value: string): string => {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return "";
    if (Math.abs(nowMs - timestamp) < JUST_NOW_WINDOW_MS) {
      return label("runningTasks.justNow", "just now");
    }
    return formatRelativeTime(value, activeLocale, new Date(nowMs));
  };

  // Most-recently-active first; the catalog is the only source of project and
  // timestamp data, so running ids with no catalog row are skipped.
  const rows = sessions
    .filter((session) => runningSessionIds.has(session.id))
    .sort((a, b) => b.modified.localeCompare(a.modified));

  return (
    <section
      className="running-tasks-panel"
      role="region"
      aria-label={label("runningTasks.title", "Running tasks")}
      style={{
        display: "flex",
        minHeight: 0,
        flexDirection: "column",
        background: "var(--bg-panel)",
        borderBottom: "1px solid var(--border)",
        boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span aria-hidden="true" style={{ display: "flex", color: "var(--accent)" }}>
          <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        <strong style={{ fontSize: 12, fontWeight: 600 }}>
          {label("runningTasks.title", "Running tasks")}
        </strong>
        <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
          {label("runningTasks.count", "{count} running", { count: rows.length })}
        </span>
      </header>

      {rows.length === 0 ? (
        <div
          role="status"
          style={{ padding: "22px 14px", textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}
        >
          {loading
            ? label("runningTasks.loading", "Loading sessions…")
            : label("runningTasks.empty", "No running tasks")}
        </div>
      ) : (
        <ul
          role="list"
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            maxHeight: "min(50dvh, 420px)",
            overflowY: "auto",
          }}
        >
          {rows.map((session) => {
            const selected = session.id === selectedSessionId;
            const isSubagent = session.relation?.kind === "subagent";
            const phase = resolveRunningTaskPhase(runningSessionPhases, session.id);
            const phaseMeta = phase ? PHASE_META[phase] : null;
            const started = relativeText(session.created);
            const recent = relativeText(session.modified);
            const fullProjectPath = session.projectRoot ?? session.cwd ?? "";

            return (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => onSelectSession(session)}
                  aria-current={selected ? "true" : undefined}
                  title={sessionTitle(session)}
                  style={{
                    width: "100%",
                    minHeight: 54,
                    display: "grid",
                    gridTemplateColumns: "18px minmax(0, 1fr) auto",
                    alignItems: "center",
                    gap: 9,
                    padding: "7px 12px",
                    border: "none",
                    borderBottom: "1px solid var(--border)",
                    borderLeft: selected ? "2px solid var(--accent)" : "2px solid transparent",
                    background: selected ? "var(--bg-selected)" : "transparent",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                  onMouseEnter={(event) => {
                    if (!selected) event.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(event) => {
                    if (!selected) event.currentTarget.style.background = "transparent";
                  }}
                >
                  <span aria-hidden="true" style={{ display: "flex", color: "var(--accent)" }}>
                    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span style={{ display: "flex", minWidth: 0, flexDirection: "column", gap: 2 }}>
                    <span
                      style={{
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 12,
                        fontWeight: selected ? 600 : 500,
                      }}
                    >
                      {sessionTitle(session)}
                      {isSubagent && (
                        <span style={{ marginLeft: 6, color: "var(--accent)", fontSize: 10 }}>
                          {label("runningTasks.subagent", "Sub-agent")}
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        display: "flex",
                        minWidth: 0,
                        alignItems: "center",
                        gap: 6,
                        fontSize: 11,
                        color: "var(--text-dim)",
                      }}
                    >
                      <span
                        title={fullProjectPath}
                        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {projectName(session)}
                      </span>
                      {phaseMeta && (
                        <span
                          style={{
                            flexShrink: 0,
                            padding: "0 5px",
                            border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                            borderRadius: 3,
                            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                            color: "var(--accent)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {label(phaseMeta.key, phaseMeta.fallback)}
                        </span>
                      )}
                    </span>
                  </span>
                  <span
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      gap: 2,
                      color: "var(--text-dim)",
                      fontSize: 10,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {started && (
                      <span>{label("runningTasks.started", "Started {time}", { time: started })}</span>
                    )}
                    {recent && (
                      <span>{label("runningTasks.recent", "Last {time}", { time: recent })}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
