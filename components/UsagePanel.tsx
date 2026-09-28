"use client";

/**
 * Usage & Cost panel.
 *
 * Renders the cross-session aggregation produced by `GET /api/usage`: total
 * recorded tokens/cost, a per-project breakdown and a per-model breakdown.
 *
 * The two scope props are optional. Omit both for the "all projects" view; pass
 * either a `projectKey` (preferred, groups worktrees with their main repo) or a
 * `cwd` to restrict the scan. Paths are only ever sent to the server, never
 * rendered — the response carries a basename-only project name instead.
 */

import { useEffect, useMemo, useState } from "react";
import {
  formatUsageCost,
  formatUsageTokens,
  type ModelUsage,
  type ProjectUsage,
  type UsageResponse,
} from "@/lib/session-usage";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface UsagePanelProps {
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

export function UsagePanel({ cwd, projectKey, translate }: UsagePanelProps) {
  const t = useMemo(() => createTranslator(translate), [translate]);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);

    const query = new URLSearchParams();
    if (projectKey) query.set("projectKey", projectKey);
    else if (cwd) query.set("cwd", cwd);
    const suffix = query.toString();

    fetch(`/api/usage${suffix ? `?${suffix}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`usage request failed: ${response.status}`);
        return (await response.json()) as UsageResponse;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setData(payload);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError(true);
        setLoading(false);
      });

    return () => controller.abort();
  }, [cwd, projectKey, reloadKey]);

  const scopeLabel = data?.scope?.name ?? t("usage.allProjects");
  const models = useMemo(
    () => (data ? (data.models.length > 0 ? data.models : []) : []),
    [data],
  );

  return (
    <section className="usage-panel" aria-label={t("usage.title")}>
      <header className="usage-header">
        <div className="usage-heading">
          <strong>{t("usage.title")}</strong>
          <span className="usage-scope">{scopeLabel}</span>
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

      <div className="usage-scroll">
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

            {data.projects.length === 0 && models.length === 0 ? (
              <div className="usage-status">{t("usage.empty")}</div>
            ) : (
              <>
                {data.projects.length > 0 && (
                  <section className="usage-section">
                    <h3>{t("usage.byProject")}</h3>
                    <ul className="usage-project-list">
                      {data.projects.map((project) => (
                        <li key={project.projectId} className="usage-project-row">
                          <div className="usage-project-head">
                            <span className="usage-project-name" title={project.name}>{project.name}</span>
                            <span className="usage-project-cost">{formatUsageCost(project.cost)}</span>
                          </div>
                          <div className="usage-project-meta">
                            <span>{formatUsageTokens(project.tokens.total)} {t("usage.tokens").toLowerCase()}</span>
                            <span>{project.sessions} {t("usage.sessions").toLowerCase()}</span>
                          </div>
                          <TokenBreakdown tokens={project.tokens} t={t} />
                          <ModelRows models={project.models} t={t} />
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {models.length > 0 && (
                  <section className="usage-section">
                    <h3>{t("usage.byModel")}</h3>
                    <ModelRows models={models} t={t} />
                  </section>
                )}
              </>
            )}
          </>
        )}
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
        .usage-header {
          flex-shrink: 0;
          min-height: 44px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 7px 14px;
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
        .usage-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
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
        .usage-project-list, .usage-model-list {
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
