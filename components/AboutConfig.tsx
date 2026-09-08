"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import type {
  AboutInfoResponse,
  UpdatePiAgentResponse,
} from "@/lib/about-service";
import {
  ConfigPanelShell,
  ConfigDetailStack,
  ConfigButton,
} from "./SettingsUi";

interface Props {
  onClose: () => void;
  embedded?: boolean;
}

export function AboutConfig({ onClose, embedded = false }: Props) {
  const { t } = useI18n();
  const [info, setInfo] = useState<AboutInfoResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateTarget, setUpdateTarget] = useState<"global" | "local">("global");
  const [updateResult, setUpdateResult] = useState<UpdatePiAgentResponse | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [copied, setCopied] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchInfo = useCallback(async (force = false) => {
    try {
      if (force) setChecking(true);
      setErrorMsg(null);
      const url = force ? "/api/about?force=true" : "/api/about";
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as AboutInfoResponse;
      setInfo(data);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void fetchInfo();
  }, [fetchInfo]);

  const handleUpdate = async () => {
    if (updating) return;
    setUpdating(true);
    setUpdateResult(null);
    setShowLog(true);
    setErrorMsg(null);

    try {
      const res = await fetch("/api/about", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: updateTarget }),
      });
      const data = (await res.json()) as UpdatePiAgentResponse;
      setUpdateResult(data);
      if (data.success) {
        // Refresh version status after successful update
        await fetchInfo(true);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setUpdateResult({
        success: false,
        output: err instanceof Error ? err.message : String(err),
        error: "Update request failed",
        previousVersion: null,
        newVersion: null,
        target: updateTarget,
      });
    } finally {
      setUpdating(false);
    }
  };

  const handleCopyDiagnostics = async () => {
    if (!info) return;
    const lines = [
      `### Pi Web Diagnostics`,
      `- **Application:** ${info.appName} v${info.appVersion} (${info.isDesktop ? "Desktop" : "Web"})`,
      `- **Pi Agent Embedded SDK:** ${info.piAgent.installedVersion ?? "unknown"}`,
      `- **Pi Agent Global CLI:** ${info.piAgent.cliVersion ?? "not installed"}`,
      `- **Pi Agent Latest Registry:** ${info.piAgent.latestVersion ?? "unknown"}`,
      `- **Node.js:** ${info.system.nodeVersion}`,
      `- **OS / Arch:** ${info.system.platform} (${info.system.arch})`,
      `- **CWD:** ${info.system.cwd}`,
    ];
    try {
      await copyText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // ignore
    }
  };

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t("about.title")}
      subtitle={info?.appName ?? "Pi Web"}
      onClose={onClose}
    >
      <div className="about-panel-container">
        {loading ? (
          <div className="about-loading-state">
            <span className="about-spinner" />
            <span>{t("about.statusChecking")}</span>
          </div>
        ) : (
          <ConfigDetailStack className="about-stack">
            {/* Header Hero */}
            <div className="about-hero-card">
              <div className="about-logo-wrapper">
                <svg
                  className="about-logo-icon"
                  viewBox="0 0 48 48"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <rect width="48" height="48" rx="12" fill="var(--bg-panel)" stroke="var(--border)" strokeWidth="2" />
                  <path
                    d="M14 16h20M19 16v18M29 16v18c0 2 2 3 4 2"
                    stroke="var(--accent)"
                    strokeWidth="3.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <div className="about-hero-details">
                <div className="about-hero-title-row">
                  <h2 className="about-app-title">{info?.appName ?? "Pi Web"}</h2>
                  <span className="about-version-badge">v{info?.appVersion ?? "0.9.10"}</span>
                  <span className="about-edition-tag">
                    {info?.isDesktop ? t("about.appEditionDesktop") : t("about.appEditionWeb")}
                  </span>
                </div>
                <p className="about-app-desc">{t("about.description")}</p>
              </div>
            </div>

            {errorMsg && (
              <div className="about-error-banner" role="alert">
                <span>{errorMsg}</span>
              </div>
            )}

            {/* Pi Agent Core & Version Updates */}
            <section className="about-section-card">
              <div className="about-section-header">
                <div className="about-section-header-left">
                  <svg className="about-section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                    <rect x="9" y="9" width="6" height="6" />
                    <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3" />
                  </svg>
                  <h3 className="about-section-title">{t("about.piAgentKernel")}</h3>
                </div>

                <div className="about-section-actions">
                  <ConfigButton
                    variant="secondary"
                    size="small"
                    disabled={checking || updating}
                    onClick={() => void fetchInfo(true)}
                  >
                    <span className={`about-refresh-icon ${checking ? "is-spinning" : ""}`}>↻</span>
                    <span>{checking ? t("about.statusChecking") : t("about.checkUpdates")}</span>
                  </ConfigButton>
                </div>
              </div>

              <div className="about-grid-properties">
                <div className="about-property-item">
                  <span className="about-property-label">{t("about.embeddedKernel")}</span>
                  <span className="about-property-value">
                    <code>{info?.piAgent.installedVersion ? `v${info.piAgent.installedVersion}` : "unknown"}</code>
                  </span>
                </div>

                <div className="about-property-item">
                  <span className="about-property-label">{t("about.globalCli")}</span>
                  <span className="about-property-value">
                    {info?.piAgent.cliVersion ? (
                      <code>v{info.piAgent.cliVersion}</code>
                    ) : (
                      <span className="about-text-dim">{t("about.cliNotInstalled")}</span>
                    )}
                  </span>
                </div>

                <div className="about-property-item">
                  <span className="about-property-label">{t("about.latestVersion")}</span>
                  <div className="about-property-value-row">
                    <code>{info?.piAgent.latestVersion ? `v${info.piAgent.latestVersion}` : "..."}</code>
                    {info?.piAgent.latestVersion && (
                      <span
                        className={`about-status-pill ${
                          info.piAgent.updateAvailable ? "is-update-available" : "is-up-to-date"
                        }`}
                      >
                        {info.piAgent.updateAvailable
                          ? t("about.statusUpdateAvailable", { version: `v${info.piAgent.latestVersion}` })
                          : t("about.statusUpToDate")}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Action and controls for update */}
              <div className="about-update-action-box">
                <div className="about-update-target-select">
                  <label htmlFor="pi-agent-update-target" className="about-target-label">
                    {t("about.updateTargetLabel")}:
                  </label>
                  <select
                    id="pi-agent-update-target"
                    value={updateTarget}
                    disabled={updating}
                    onChange={(e) => setUpdateTarget(e.target.value as "global" | "local")}
                    className="about-select-control"
                  >
                    <option value="global">{t("about.updateScopeGlobal")}</option>
                    <option value="local">{t("about.updateScopeLocal")}</option>
                  </select>
                </div>

                <ConfigButton
                  variant={info?.piAgent.updateAvailable ? "primary" : "secondary"}
                  size="default"
                  disabled={updating}
                  onClick={() => void handleUpdate()}
                  className="about-update-button"
                >
                  {updating ? (
                    <>
                      <span className="about-spinner is-small" />
                      <span>{t("about.updating")}</span>
                    </>
                  ) : (
                    <>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      <span>{t("about.updatePiAgent")}</span>
                    </>
                  )}
                </ConfigButton>
              </div>

              {/* Result & Log feedback */}
              {updateResult && (
                <div className={`about-update-result-card ${updateResult.success ? "is-success" : "is-failed"}`}>
                  <div className="about-update-result-head">
                    <span className="about-result-icon">
                      {updateResult.success ? "✓" : "⚠"}
                    </span>
                    <strong className="about-result-title">
                      {updateResult.success
                        ? t("about.updateSuccess")
                        : t("about.updateFailed")}
                    </strong>
                    {updateResult.newVersion && updateResult.success && (
                      <span className="about-result-meta">
                        {t("about.updateSuccessDetail", { version: `v${updateResult.newVersion}` })}
                      </span>
                    )}
                    <button
                      type="button"
                      className="about-log-toggle"
                      onClick={() => setShowLog((prev) => !prev)}
                    >
                      {showLog ? t("i18n.collapse") : t("about.updateOutput")}
                    </button>
                  </div>

                  {showLog && (
                    <pre className="about-terminal-output">
                      {updateResult.output || "(No output recorded)"}
                    </pre>
                  )}
                </div>
              )}
            </section>

            {/* Repository & Open Source */}
            <section className="about-section-card">
              <div className="about-section-header">
                <div className="about-section-header-left">
                  <svg className="about-section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
                    <path d="M9 18c-4.51 2-5-2-7-2" />
                  </svg>
                  <h3 className="about-section-title">{t("about.repoInfo")}</h3>
                </div>
              </div>

              <div className="about-links-grid">
                <a
                  href={info?.gitRepo.url ?? "https://github.com/ghost0211/pi-web"}
                  target="_blank"
                  rel="noreferrer"
                  className="about-link-card"
                >
                  <div className="about-link-icon">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                      <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                    </svg>
                  </div>
                  <div className="about-link-content">
                    <span className="about-link-title">{t("about.githubRepo")}</span>
                    <span className="about-link-sub">ghost0211/pi-web ↗</span>
                  </div>
                </a>

                <a
                  href={info?.gitRepo.releasesUrl ?? "https://github.com/ghost0211/pi-web/releases"}
                  target="_blank"
                  rel="noreferrer"
                  className="about-link-card"
                >
                  <div className="about-link-icon">🏷️</div>
                  <div className="about-link-content">
                    <span className="about-link-title">{t("about.releases")}</span>
                    <span className="about-link-sub">GitHub Releases ↗</span>
                  </div>
                </a>

                <a
                  href={info?.gitRepo.issuesUrl ?? "https://github.com/ghost0211/pi-web/issues"}
                  target="_blank"
                  rel="noreferrer"
                  className="about-link-card"
                >
                  <div className="about-link-icon">💬</div>
                  <div className="about-link-content">
                    <span className="about-link-title">{t("about.issues")}</span>
                    <span className="about-link-sub">Issue Tracker ↗</span>
                  </div>
                </a>

                <a
                  href={info?.piAgent.packageUrl ?? "https://www.npmjs.com/package/@earendil-works/pi-coding-agent"}
                  target="_blank"
                  rel="noreferrer"
                  className="about-link-card"
                >
                  <div className="about-link-icon">📦</div>
                  <div className="about-link-content">
                    <span className="about-link-title">Pi Agent Core SDK</span>
                    <span className="about-link-sub">@earendil-works/pi-coding-agent ↗</span>
                  </div>
                </a>
              </div>
            </section>

            {/* System Runtime & Environment */}
            <section className="about-section-card">
              <div className="about-section-header">
                <div className="about-section-header-left">
                  <svg className="about-section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                  <h3 className="about-section-title">{t("about.systemInfo")}</h3>
                </div>

                <div className="about-section-actions">
                  <ConfigButton
                    variant="ghost"
                    size="small"
                    onClick={() => void handleCopyDiagnostics()}
                  >
                    <span>{copied ? `✓ ${t("about.diagnosticsCopied")}` : t("about.copyDiagnostics")}</span>
                  </ConfigButton>
                </div>
              </div>

              <div className="about-grid-properties">
                <div className="about-property-item">
                  <span className="about-property-label">{t("about.nodeVersion")}</span>
                  <span className="about-property-value">
                    <code>{info?.system.nodeVersion ?? "unknown"}</code>
                  </span>
                </div>

                <div className="about-property-item">
                  <span className="about-property-label">{t("about.platform")}</span>
                  <span className="about-property-value">
                    <code>{info?.system.platform} ({info?.system.arch})</code>
                  </span>
                </div>

                <div className="about-property-item is-full-row">
                  <span className="about-property-label">{t("about.cwd")}</span>
                  <span className="about-property-value about-text-mono" title={info?.system.cwd}>
                    {info?.system.cwd ?? "-"}
                  </span>
                </div>
              </div>
            </section>
          </ConfigDetailStack>
        )}
      </div>
    </ConfigPanelShell>
  );
}
