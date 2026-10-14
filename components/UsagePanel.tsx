"use client";

/**
 * Usage & Cost dashboard.
 *
 * Renders the cross-session aggregation produced by `GET /api/usage`: total
 * recorded tokens/cost, a trend series, a per-provider breakdown with nested
 * models, and a per-project breakdown — all filterable to an arbitrary time
 * period (presets or a custom from/to date range in the browser's timezone).
 *
 * The two scope props are optional. Omit both for the "all projects" view; pass
 * either a `projectKey` (preferred, groups worktrees with their main repo) or a
 * `cwd` to restrict the scan. Paths are only ever sent to the server, never
 * rendered — the response carries a basename-only project name instead.
 */

import { useEffect, useId, useMemo, useState } from "react";
import {
  type ModelUsage,
  type ProjectUsage,
  type ProviderUsage,
  type UsageResponse,
  type UsageSeriesPoint,
} from "@/lib/session-usage";
import { formatUsageCost, formatUsageTokens } from "@/lib/usage-format";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface UsagePanelProps {
  /** Fill the settings section instead of applying the standalone height cap. */
  embedded?: boolean;
  /** Restrict the aggregation to one project directory. Optional. */
  cwd?: string;
  /** Stable server-computed project key. Takes precedence over `cwd`. Optional. */
  projectKey?: string;
  /**
   * Optional translator. Falls back to built-in English labels when a key is
   * missing, so the panel renders correctly even before i18n keys are wired.
   */
  translate?: Translate;
}

/** Built-in English labels used until the panel is wired into the i18n catalog. */
const FALLBACK_LABELS: Record<string, string> = {
  "usage.title": "Usage & Cost",
  "usage.subtitle": "Recorded historical tokens and cost across sessions",
  "usage.loading": "Loading usage…",
  "usage.error": "Failed to load usage",
  "usage.retry": "Retry",
  "usage.refresh": "Refresh",
  "usage.empty": "No usage recorded yet",
  "usage.allProjects": "All projects",
  "usage.totalCost": "Total cost",
  "usage.totalTokens": "Total tokens",
  "usage.sessions": "Sessions",
  "usage.requests": "Requests",
  "usage.input": "Input",
  "usage.output": "Output",
  "usage.cacheRead": "Cache read",
  "usage.cacheWrite": "Cache write",
  "usage.byProject": "By project",
  "usage.byModel": "By model",
  "usage.project": "Project",
  "usage.model": "Model",
  "usage.cost": "Cost",
  "usage.tokens": "Tokens",
  "usage.partial": "Partial: some large or unreadable sessions were skipped",
  "usage.scanned": "{count} sessions scanned",
  "usage.range.all": "All time",
  "usage.range.today": "Today",
  "usage.range.last7": "Last 7 days",
  "usage.range.last30": "Last 30 days",
  "usage.range.custom": "Custom",
  "usage.range.from": "From",
  "usage.range.to": "To",
  "usage.range.apply": "Apply",
  "usage.trend": "Token trend",
  "usage.byProvider": "By provider",
  "usage.provider": "Provider",
  "usage.untimestamped": "{count} records without timestamps were excluded from the time filter",
};

function interpolate(message: string, params?: Record<string, string | number>): string {
  if (!params) return message;
  return message.replace(/\{([\w.-]+)\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}

/** Uses the external translator when it resolves a key, else the built-in label. */
function createTranslator(translate?: Translate): Translate {
  return (key, params) => {
    const external = translate?.(key, params);
    if (external !== undefined && external !== key) return external;
    const fallback = FALLBACK_LABELS[key];
    return fallback !== undefined ? interpolate(fallback, params) : key;
  };
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="usage-card">
      <div className="usage-card-label">{label}</div>
      <div className="usage-card-value">{value}</div>
      {hint && <div className="usage-card-hint">{hint}</div>}
    </div>
  );
}

function TokenBreakdown({ tokens, t }: { tokens: ProjectUsage["tokens"]; t: Translate }) {
  return (
    <div className="usage-token-breakdown">
      <span>{t("usage.input")} {formatUsageTokens(tokens.input)}</span>
      <span>{t("usage.output")} {formatUsageTokens(tokens.output)}</span>
      <span>{t("usage.cacheRead")} {formatUsageTokens(tokens.cacheRead)}</span>
      <span>{t("usage.cacheWrite")} {formatUsageTokens(tokens.cacheWrite)}</span>
    </div>
  );
}

function ModelRows({ models, t }: { models: ModelUsage[]; t: Translate }) {
  if (models.length === 0) return null;
  return (
    <ul className="usage-model-list">
      {models.map((model) => (
        <li key={model.key} className="usage-model-row">
          <span className="usage-model-name" title={model.key}>
            <span className="usage-model-model">{model.model}</span>
            <span className="usage-model-provider">{model.provider}</span>
          </span>
          <span className="usage-model-tokens">
            {formatUsageTokens(model.tokens.total)} · {model.entries} {t("usage.requests").toLowerCase()}
          </span>
          <span className="usage-model-cost">{formatUsageCost(model.cost)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Time-range preset keys; "custom" is driven by the date inputs. */
type RangePreset = "all" | "today" | "last7" | "last30" | "custom";

/** Applied filter; an empty object means all time. */
interface AppliedRange {
  from?: string;
  to?: string;
}

/** Formats a Date as the `YYYY-MM-DD` value the API expects (browser-local). */
function localDateValue(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Resolves a preset to its concrete date range; "all"/"custom" stay empty. */
function presetRange(preset: RangePreset): AppliedRange {
  const today = new Date();
  const to = localDateValue(today);
  if (preset === "today") return { from: to, to };
  if (preset === "last7" || preset === "last30") {
    const from = new Date(today);
    from.setDate(from.getDate() - (preset === "last7" ? 6 : 29));
    return { from: localDateValue(from), to };
  }
  return {};
}

/**
 * CSS-only trend chart over the range: one bar per day (or month for long
 * spans). Pure presentational — every bar carries a title with exact numbers.
 */
function TrendChart({ title, points, granularity, t }: {
  title: string;
  points: UsageSeriesPoint[];
  granularity: "day" | "month";
  t: Translate;
}) {
  const max = points.reduce((best, point) => Math.max(best, point.tokens.total), 0);
  if (max <= 0) return null;
  const summary = points
    .map((point) => `${point.date}: ${formatUsageTokens(point.tokens.total)}`)
    .join(", ");
  return (
    <section className="usage-section">
      <h3>
        {title}
        <span className="usage-trend-granularity">
          {granularity === "month" ? "YYYY-MM" : "YYYY-MM-DD"}
        </span>
      </h3>
      <div className="usage-chart" role="img" aria-label={`${title}: ${summary}`}>
        {points.map((point) => (
          <div
            key={point.date}
            className="usage-chart-bar-wrap"
            title={`${point.date} · ${formatUsageTokens(point.tokens.total)} ${t("usage.tokens").toLowerCase()} · ${formatUsageCost(point.cost)}`}
          >
            <div
              className="usage-chart-bar"
              style={{ height: `${Math.max(3, Math.round((point.tokens.total / max) * 100))}%` }}
            />
          </div>
        ))}
      </div>
      <div className="usage-chart-labels">
        <span>{points[0]?.date}</span>
        <span>{points[points.length - 1]?.date}</span>
      </div>
    </section>
  );
}

/**
 * The selected provider's detail: summary row with a token-share bar, the token
 * breakdown and the provider's models sorted by cost. The full
 * `provider/model` key stays in the title.
 */
function ProviderDetail({ provider, totalTokens, t }: {
  provider: ProviderUsage;
  totalTokens: number;
  t: Translate;
}) {
  const share = totalTokens > 0 ? provider.tokens.total / totalTokens : 0;
  return (
    <div className="usage-provider-row">
      <div className="usage-project-head">
        <span className="usage-project-name" title={provider.provider}>{provider.provider}</span>
        <span className="usage-project-cost">{formatUsageCost(provider.cost)}</span>
      </div>
      <div className="usage-project-meta">
        <span>{formatUsageTokens(provider.tokens.total)} {t("usage.tokens").toLowerCase()}</span>
        <span>{Math.round(share * 100)}%</span>
        <span>{provider.entries} {t("usage.requests").toLowerCase()}</span>
        <span>{provider.sessions} {t("usage.sessions").toLowerCase()}</span>
      </div>
      <div className="usage-share" aria-hidden="true">
        <div className="usage-share-bar" style={{ width: `${Math.min(100, Math.max(1, Math.round(share * 100)))}%` }} />
      </div>
      <TokenBreakdown tokens={provider.tokens} t={t} />
      <ModelRows models={provider.models} t={t} />
    </div>
  );
}

function ProjectDetail({ project, t }: { project: ProjectUsage; t: Translate }) {
  return (
    <div className="usage-project-row">
      <div className="usage-project-head">
        <span className="usage-project-name" title={project.name}>{project.name}</span>
        <span className="usage-project-cost">{formatUsageCost(project.cost)}</span>
      </div>
      <div className="usage-project-meta">
        <span>{formatUsageTokens(project.tokens.total)} {t("usage.tokens").toLowerCase()}</span>
        <span>{project.entries} {t("usage.requests").toLowerCase()}</span>
        <span>{project.sessions} {t("usage.sessions").toLowerCase()}</span>
      </div>
      <TokenBreakdown tokens={project.tokens} t={t} />
      <ModelRows models={project.models} t={t} />
    </div>
  );
}

type DetailTab = "provider" | "project";
const DETAIL_TABS: DetailTab[] = ["provider", "project"];

export function UsagePanel({ embedded = false, cwd, projectKey, translate }: UsagePanelProps) {
  const t = useMemo(() => createTranslator(translate), [translate]);
  const detailId = useId();
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [preset, setPreset] = useState<RangePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [appliedRange, setAppliedRange] = useState<AppliedRange>({});
  const [detailTab, setDetailTab] = useState<DetailTab>("provider");
  // Empty selection means all, not the literal provider name "all". The two
  // filters remain independent when switching tabs.
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedProject, setSelectedProject] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);

    const query = new URLSearchParams();
    if (projectKey) query.set("projectKey", projectKey);
    else if (cwd) query.set("cwd", cwd);
    if (appliedRange.from) query.set("from", appliedRange.from);
    if (appliedRange.to) query.set("to", appliedRange.to);
    if (appliedRange.from || appliedRange.to) {
      // The server buckets days in the browser's timezone via this offset.
      query.set("tz", String(new Date().getTimezoneOffset()));
    }
    const suffix = query.toString();

    fetch(`/api/usage${suffix ? `?${suffix}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`usage request failed: ${response.status}`);
        return (await response.json()) as UsageResponse;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setData(payload);
        // A removed choice resets to all permanently; widening the range later
        // must not silently reactivate a filter the UI had stopped showing.
        setSelectedProvider((previous) => payload.providers.some((item) => item.provider === previous) ? previous : "");
        setSelectedProject((previous) => payload.projects.some((item) => item.projectId === previous) ? previous : "");
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError(true);
        setLoading(false);
      });

    return () => controller.abort();
  }, [cwd, projectKey, reloadKey, appliedRange]);

  const applyPreset = (next: RangePreset) => {
    setPreset(next);
    if (next !== "custom") setAppliedRange(presetRange(next));
  };

  const applyCustomRange = () => {
    if (!customFrom && !customTo) return;
    if (customFrom && customTo && customFrom > customTo) return;
    setAppliedRange({
      ...(customFrom ? { from: customFrom } : {}),
      ...(customTo ? { to: customTo } : {}),
    });
  };

  const scopeLabel = data?.scope?.name ?? t("usage.allProjects");
  const rangeLabel = appliedRange.from || appliedRange.to
    ? `${appliedRange.from ?? "…"} – ${appliedRange.to ?? "…"}`
    : t("usage.range.all");
  const PRESETS: RangePreset[] = ["all", "today", "last7", "last30", "custom"];

  // If a range change removes the chosen entry, show all rather than leaving
  // a stale dropdown value or blank detail panel. All keeps API cost order.
  const providerValue = data?.providers.some((item) => item.provider === selectedProvider)
    ? selectedProvider : "";
  const projectValue = data?.projects.some((item) => item.projectId === selectedProject)
    ? selectedProject : "";
  const visibleProviders = (data?.providers ?? []).filter((item) => providerValue === "" || item.provider === providerValue);
  const visibleProjects = (data?.projects ?? []).filter((item) => projectValue === "" || item.projectId === projectValue);

  return (
    <section className={`usage-panel${embedded ? " is-embedded" : ""}`} aria-label={t("usage.title")}>
      <header className="usage-header">
        <div className="usage-heading">
          <strong>{t("usage.title")}</strong>
          <span className="usage-scope">{scopeLabel}</span>
          <span className="usage-range-label">{rangeLabel}</span>
        </div>
        <button
          type="button"
          className="usage-refresh"
          onClick={() => setReloadKey((value) => value + 1)}
          disabled={loading}
        >
          {loading ? t("usage.loading") : t("usage.refresh")}
        </button>
      </header>

      <div className="usage-filter" role="group" aria-label={t("usage.range.custom")}>
        {PRESETS.map((key) => (
          <button
            key={key}
            type="button"
            className={`usage-filter-chip${preset === key ? " active" : ""}`}
            aria-pressed={preset === key}
            onClick={() => applyPreset(key)}
          >
            {t(`usage.range.${key}`)}
          </button>
        ))}
        {preset === "custom" && (
          <span className="usage-filter-custom">
            <input
              type="date"
              className="usage-filter-input"
              aria-label={t("usage.range.from")}
              value={customFrom}
              max={customTo || undefined}
              onChange={(event) => setCustomFrom(event.target.value)}
            />
            <span className="usage-filter-sep">–</span>
            <input
              type="date"
              className="usage-filter-input"
              aria-label={t("usage.range.to")}
              value={customTo}
              min={customFrom || undefined}
              onChange={(event) => setCustomTo(event.target.value)}
            />
            <button
              type="button"
              className="usage-filter-apply"
              onClick={applyCustomRange}
              disabled={!customFrom && !customTo}
            >
              {t("usage.range.apply")}
            </button>
          </span>
        )}
      </div>

      {/* Fixed block: filters, notices, summary cards and the trend chart stay
          put while only the detail area below scrolls. */}
      <div className="usage-fixed">
        {loading && !data && <div className="usage-status">{t("usage.loading")}</div>}

        {error && !data && (
          <div className="usage-status usage-error">
            <span>{t("usage.error")}</span>
            <button type="button" className="usage-refresh" onClick={() => setReloadKey((value) => value + 1)}>
              {t("usage.retry")}
            </button>
          </div>
        )}

        {data && (
          <>
            {data.partial && <div className="usage-banner">{t("usage.partial")}</div>}

            {data.untimestampedRecords !== undefined && data.untimestampedRecords > 0 && (
              <div className="usage-banner">{t("usage.untimestamped", { count: data.untimestampedRecords })}</div>
            )}

            <div className="usage-cards">
              <SummaryCard label={t("usage.totalCost")} value={formatUsageCost(data.totals.cost)} />
              <SummaryCard
                label={t("usage.totalTokens")}
                value={formatUsageTokens(data.totals.tokens.total)}
                hint={`${t("usage.input")} ${formatUsageTokens(data.totals.tokens.input)} · ${t("usage.output")} ${formatUsageTokens(data.totals.tokens.output)}`}
              />
              <SummaryCard
                label={t("usage.sessions")}
                value={String(data.totals.sessions)}
                hint={t("usage.scanned", { count: data.scannedSessions })}
              />
              <SummaryCard label={t("usage.requests")} value={String(data.totals.entries)} />
            </div>

            {data.series.length > 0 && (
              <TrendChart
                title={t("usage.trend")}
                points={data.series}
                granularity={data.seriesGranularity}
                t={t}
              />
            )}
          </>
        )}
      </div>

      {/* Tabs and the current dropdown stay visible while all detail cards
          scroll. Switching tabs remounts the scroll panel at its top. */}
      <div className="usage-detail-controls">
        <div className="usage-detail-tabs" role="tablist" aria-label={t("usage.title")}>
          {DETAIL_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`${detailId}-tab-${tab}`}
              data-detail-tab={tab}
              aria-selected={detailTab === tab}
              aria-controls={`${detailId}-panel`}
              tabIndex={detailTab === tab ? 0 : -1}
              onClick={() => setDetailTab(tab)}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next: DetailTab = event.key === "Home" ? "provider"
                  : event.key === "End" ? "project" : tab === "provider" ? "project" : "provider";
                setDetailTab(next);
                event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-detail-tab="${next}"]`)?.focus();
              }}
            >
              {t(tab === "provider" ? "usage.byProvider" : "usage.byProject")}
            </button>
          ))}
        </div>
        {detailTab === "provider" ? (
          <select
            key="provider"
            className="usage-select"
            aria-label={t("usage.byProvider")}
            value={providerValue}
            disabled={!data || data.providers.length === 0}
            onChange={(event) => setSelectedProvider(event.target.value)}
          >
            <option value="">all</option>
            {data && data.providers.map((provider) => (
              <option key={provider.provider} value={provider.provider}>
                {provider.provider} · {formatUsageTokens(provider.tokens.total)} · {formatUsageCost(provider.cost)}
              </option>
            ))}
          </select>
        ) : (
          <select
            key="project"
            className="usage-select"
            aria-label={t("usage.byProject")}
            value={projectValue}
            disabled={!data || data.projects.length === 0}
            onChange={(event) => setSelectedProject(event.target.value)}
          >
            <option value="">all</option>
            {data && data.projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.name} · {formatUsageTokens(project.tokens.total)} · {formatUsageCost(project.cost)}
              </option>
            ))}
          </select>
        )}
      </div>

      <div
        key={detailTab}
        className="usage-scroll"
        role="tabpanel"
        id={`${detailId}-panel`}
        aria-labelledby={`${detailId}-tab-${detailTab}`}
        tabIndex={0}
      >
        {data && (detailTab === "provider" ? (
          visibleProviders.length === 0 ? <div className="usage-status">{t("usage.empty")}</div> : (
            visibleProviders.map((provider) => (
              <ProviderDetail key={provider.provider} provider={provider} totalTokens={data.totals.tokens.total} t={t} />
            ))
          )
        ) : (
          visibleProjects.length === 0 ? <div className="usage-status">{t("usage.empty")}</div> : (
            visibleProjects.map((project) => <ProjectDetail key={project.projectId} project={project} t={t} />)
          )
        ))}
      </div>

      <style>{`
        .usage-panel {
          display: flex;
          flex-direction: column;
          height: min(600px, 75dvh);
          min-height: 220px;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
        }
        /* The settings shell owns the available height; only standalone panels
           use the viewport cap above. Give all remaining room to the details. */
        .usage-panel.is-embedded {
          width: 100%;
          height: 100%;
          min-height: 0;
          overflow: hidden;
          container-name: usage-embedded;
          container-type: size;
        }
        .usage-header {
          flex-shrink: 0;
          min-height: 44px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          /* Leave room for the settings dialog close button at the top-right. */
          padding: 7px 48px 7px 14px;
          border-bottom: 1px solid var(--border);
        }
        .usage-heading {
          display: flex;
          align-items: baseline;
          gap: 8px;
          min-width: 0;
        }
        .usage-heading strong {
          font-size: 12px;
          font-weight: 600;
        }
        .usage-scope {
          color: var(--text-dim);
          font-size: 11px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .usage-range-label {
          flex-shrink: 0;
          color: var(--text-dim);
          font-size: 10px;
          font-family: var(--font-mono);
        }
        .usage-filter {
          flex-shrink: 0;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
          padding: 8px 14px;
          border-bottom: 1px solid var(--border);
        }
        .usage-filter-chip {
          font-size: 11px;
          font-family: inherit;
          padding: 3px 10px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
        }
        .usage-filter-chip:hover {
          color: var(--text);
          background: var(--bg-hover);
        }
        .usage-filter-chip.active {
          color: var(--accent);
          border-color: var(--accent);
          background: color-mix(in srgb, var(--accent) 10%, transparent);
        }
        .usage-filter-custom {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .usage-filter-input {
          font-size: 11px;
          font-family: var(--font-mono);
          padding: 3px 6px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--bg);
          color: var(--text);
        }
        .usage-filter-sep { color: var(--text-dim); }
        .usage-filter-apply {
          font-size: 11px;
          font-family: var(--font-mono);
          background: var(--bg-panel);
          color: var(--text-muted);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 3px 9px;
          cursor: pointer;
        }
        .usage-filter-apply:hover:not(:disabled) {
          color: var(--text);
          background: var(--bg-hover);
        }
        .usage-filter-apply:disabled { opacity: 0.6; cursor: default; }
        .usage-refresh {
          flex-shrink: 0;
          font-size: 11px;
          font-family: var(--font-mono);
          background: var(--bg-panel);
          color: var(--text-muted);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 3px 9px;
          cursor: pointer;
        }
        .usage-refresh:hover:not(:disabled) {
          color: var(--text);
          background: var(--bg-hover);
        }
        .usage-refresh:disabled {
          opacity: 0.6;
          cursor: default;
        }
        .usage-fixed {
          flex-shrink: 0;
          padding: 12px 14px 0;
          border-bottom: 1px solid var(--border);
        }
        .usage-fixed .usage-banner { margin-bottom: 10px; }
        .usage-detail-controls {
          flex-shrink: 0;
          padding: 8px 14px 0;
          border-bottom: 1px solid var(--border);
        }
        .usage-detail-tabs {
          display: flex;
          gap: 16px;
          margin-bottom: 8px;
        }
        .usage-detail-tabs button {
          padding: 5px 0;
          border: 0;
          border-bottom: 2px solid transparent;
          background: transparent;
          color: var(--text-muted);
          font: inherit;
          font-size: 12px;
          cursor: pointer;
        }
        .usage-detail-tabs button[aria-selected="true"] {
          border-bottom-color: var(--accent);
          color: var(--accent);
          font-weight: 600;
        }
        .usage-detail-tabs button:hover { color: var(--accent); }
        .usage-detail-tabs button:focus-visible,
        .usage-select:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
        .usage-select {
          width: 100%;
          margin-bottom: 8px;
          padding: 4px 6px;
          font-size: 11px;
          font-family: inherit;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--bg);
          color: var(--text);
          cursor: pointer;
        }
        .usage-select:hover { background: var(--bg-hover); }
        .usage-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          overscroll-behavior: contain;
          padding: 12px 14px;
        }
        .usage-status {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 0;
          color: var(--text-dim);
          font-size: 12px;
          font-style: italic;
        }
        .usage-error { color: #dc2626; }
        .usage-banner {
          margin-bottom: 10px;
          padding: 6px 9px;
          border-radius: 4px;
          border: 1px solid color-mix(in srgb, #d97706 40%, transparent);
          background: color-mix(in srgb, #d97706 10%, transparent);
          color: #b45309;
          font-size: 11px;
        }
        .usage-cards {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
          gap: 8px;
          margin-bottom: 14px;
        }
        .usage-card {
          padding: 9px 10px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
        }
        .usage-card-label {
          color: var(--text-dim);
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }
        .usage-card-value {
          margin-top: 4px;
          font-size: 18px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
        }
        .usage-card-hint {
          margin-top: 3px;
          color: var(--text-dim);
          font-size: 10px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .usage-section { margin-bottom: 16px; }
        .usage-section h3 {
          margin: 0 0 8px;
          color: var(--text-muted);
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .usage-model-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .usage-project-row {
          padding: 9px 10px;
          margin-bottom: 8px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
        }
        .usage-project-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 8px;
        }
        .usage-project-name {
          font-size: 12px;
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .usage-project-cost {
          flex-shrink: 0;
          font-size: 12px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          color: var(--accent);
        }
        .usage-project-meta {
          display: flex;
          gap: 12px;
          margin-top: 3px;
          color: var(--text-dim);
          font-size: 11px;
        }
        .usage-token-breakdown {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 6px;
          color: var(--text-dim);
          font-size: 10px;
          font-variant-numeric: tabular-nums;
        }
        .usage-model-list { margin-top: 8px; }
        .usage-model-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto auto;
          align-items: center;
          gap: 10px;
          padding: 5px 0;
          border-top: 1px solid var(--border);
          font-size: 11px;
        }
        .usage-model-name {
          min-width: 0;
          display: flex;
          align-items: baseline;
          gap: 6px;
          overflow: hidden;
        }
        .usage-model-model {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text);
        }
        .usage-model-provider {
          flex-shrink: 0;
          color: var(--text-dim);
          font-size: 10px;
        }
        .usage-model-tokens {
          color: var(--text-dim);
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
        }
        .usage-model-cost {
          min-width: 62px;
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        .usage-chart {
          display: flex;
          align-items: flex-end;
          gap: 2px;
          /* Shrink on short viewports so the detail area below keeps usable room. */
          height: clamp(40px, 10vh, 72px);
        }
        .usage-chart-bar-wrap {
          flex: 1 1 0;
          min-width: 2px;
          height: 100%;
          display: flex;
          align-items: flex-end;
        }
        .usage-chart-bar {
          width: 100%;
          min-height: 2px;
          border-radius: 2px 2px 0 0;
          background: var(--accent);
          opacity: 0.7;
        }
        .usage-chart-bar-wrap:hover .usage-chart-bar { opacity: 1; }
        .usage-chart-labels {
          display: flex;
          justify-content: space-between;
          margin-top: 4px;
          color: var(--text-dim);
          font-size: 10px;
          font-family: var(--font-mono);
        }
        .usage-trend-granularity {
          margin-left: 6px;
          color: var(--text-dim);
          font-size: 9px;
          font-weight: 400;
          text-transform: none;
        }
        .usage-provider-row {
          padding: 9px 10px;
          margin-bottom: 8px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg);
        }
        .usage-share {
          height: 4px;
          margin-top: 6px;
          border-radius: 2px;
          background: color-mix(in srgb, var(--border) 55%, transparent);
          overflow: hidden;
        }
        .usage-share-bar {
          height: 100%;
          background: var(--accent);
          opacity: 0.65;
        }
        /* Compact spacing follows the actual section height (including the
           mobile settings toolbar), not just the outer viewport. Keep every
           summary value and the chart visible while freeing room for details. */
        @container usage-embedded (max-height: 600px) {
          .usage-header { min-height: 36px; padding-block: 4px; }
          .usage-filter { padding-block: 6px; }
          .usage-filter-chip { padding-block: 2px; }
          .usage-fixed { padding-top: 8px; }
          .usage-cards { gap: 6px; margin-bottom: 8px; }
          .usage-card { padding: 6px 8px; }
          .usage-card-value { margin-top: 2px; font-size: 16px; }
          .usage-card-hint { margin-top: 1px; }
          .usage-fixed .usage-section { margin-bottom: 8px; }
          .usage-fixed .usage-section h3 { margin-bottom: 4px; }
          .usage-chart { height: 40px; }
          .usage-chart-labels { margin-top: 2px; }
          .usage-detail-controls { padding-top: 6px; }
          .usage-detail-tabs { margin-bottom: 4px; }
          .usage-detail-tabs button { padding-block: 3px; }
          .usage-select { margin-bottom: 4px; padding-block: 3px; }
        }
        @media (max-width: 640px) {
          .usage-panel {
            height: min(600px, calc(var(--app-viewport-height, 100dvh) - 56px));
            min-height: 0;
          }
          .usage-model-row {
            grid-template-columns: minmax(0, 1fr) auto;
          }
          .usage-model-tokens { display: none; }
        }
      `}</style>
    </section>
  );
}
