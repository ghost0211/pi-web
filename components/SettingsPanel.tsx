"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme, type ThemePreference } from "@/hooks/useTheme";
import { useFontSize, type FontSizePreference } from "@/hooks/useFontSize";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  getDesktopCloseBehavior,
  isDesktopApp,
  setDesktopCloseBehavior,
  type DesktopCloseBehavior,
} from "@/lib/desktop";
import type { ShellToolSettingsResponse } from "@/lib/api-types";
import {
  setLastSettingsSection,
  type SettingsSection,
} from "@/lib/settings-navigation";
import { ModelsConfig } from "./ModelsConfig";
import { SessionsConfig } from "./SessionsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { ConfigSwitch } from "./SettingsUi";

interface Props {
  cwd: string | null;
  sessionId: string | null;
  initialSection: SettingsSection;
  onClose: () => void;
  onSessionReloaded: () => void;
}

export function SettingsSectionIcon({ section, size = 16, strokeWidth = 1.8 }: { section: SettingsSection; size?: number; strokeWidth?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "settings-section-icon",
  };

  if (section === "general") return <svg {...common}><path d="M20 7h-9M14 17H5" /><circle cx="7" cy="7" r="3" /><circle cx="17" cy="17" r="3" /></svg>;
  if (section === "models") return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3" /></svg>;
  if (section === "sessions") return <svg {...common}><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></svg>;
  if (section === "skills") return <svg {...common}><path d="m12 2-10 5 10 5 10-5-10-5Z" /><path d="m2 12 10 5 10-5M2 17l10 5 10-5" /></svg>;
  if (section === "agents") return <svg {...common} className="settings-section-icon is-agent"><rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" /></svg>;
  return <svg {...common}><path d="M9 7V2M15 7V2M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0ZM12 19v3" /></svg>;
}

function ThemeIcon({ preference }: { preference: ThemePreference }) {
  if (preference === "light") {
    return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.41M17.66 6.34l1.41-1.41" /></svg>;
  }
  if (preference === "dark") {
    return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" /></svg>;
  }
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
}

type GeneralSubTab = "appearance" | "automation" | "environment" | "desktop";

interface GeneralSettingsData {
  theme?: string;
  defaultThinkingLevel?: string;
  compactionEnabled?: boolean;
  retryEnabled?: boolean;
  quietStartup?: boolean;
  hideThinkingBlock?: boolean;
  defaultProjectTrust?: string;
  enableSkillCommands?: boolean;
}

function GeneralSettings({ sessionId, onSessionReloaded }: Pick<Props, "sessionId" | "onSessionReloaded">) {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const { preference, setThemePreference } = useTheme();
  const { fontSize, setFontSize } = useFontSize();
  const [subTab, setSubTab] = useState<GeneralSubTab>("appearance");
  const [generalSettings, setGeneralSettings] = useState<GeneralSettingsData | null>(null);
  const [shellSettings, setShellSettings] = useState<ShellToolSettingsResponse | null>(null);
  const [shellSaving, setShellSaving] = useState(false);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Desktop-shell integration: the subtab only exists when the page runs
  // inside Pi Web Desktop (window.__TAURI__ bridge present).
  const [desktopApp] = useState(() => isDesktopApp());
  const [closeBehavior, setCloseBehavior] = useState<DesktopCloseBehavior | null>(null);
  const [closeBehaviorSaving, setCloseBehaviorSaving] = useState(false);

  const themeOptions: { id: ThemePreference; label: string }[] = [
    { id: "light", label: t("settings.themeLight") },
    { id: "dark", label: t("settings.themeDark") },
    { id: "auto", label: t("settings.themeSystem") },
  ];

  const fontSizeOptions: { id: FontSizePreference; label: string; size: string }[] = [
    { id: "small", label: t("settings.fontSizeSmall"), size: "13px" },
    { id: "medium", label: t("settings.fontSizeMedium"), size: "14px" },
    { id: "large", label: t("settings.fontSizeLarge"), size: "15px" },
    { id: "xlarge", label: t("settings.fontSizeXLarge"), size: "16px" },
  ];

  const thinkingOptions = [
    { id: "auto", label: "auto" },
    { id: "off", label: "off" },
    { id: "minimal", label: "minimal" },
    { id: "low", label: "low" },
    { id: "medium", label: "medium" },
    { id: "high", label: "high" },
    { id: "max", label: "max" },
  ];

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/settings").then((r) => r.ok ? r.json() : null),
      fetch("/api/tools/settings").then((r) => r.ok ? r.json() : null),
    ]).then(([gen, shell]) => {
      if (cancelled) return;
      if (gen) setGeneralSettings(gen as GeneralSettingsData);
      if (shell) setShellSettings(shell as ShellToolSettingsResponse);
    }).catch((cause) => {
      if (!cancelled) setErrorMsg(cause instanceof Error ? cause.message : String(cause));
    });
    if (desktopApp) {
      void getDesktopCloseBehavior()
        .then((behavior) => { if (!cancelled) setCloseBehavior(behavior); })
        .catch((cause) => { if (!cancelled) setErrorMsg(cause instanceof Error ? cause.message : String(cause)); });
    }
    return () => { cancelled = true; };
  }, [desktopApp]);

  const updateSetting = async (field: keyof GeneralSettingsData, value: unknown) => {
    setSavingField(String(field));
    setErrorMsg(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      const data = await response.json() as { success?: boolean; settings?: GeneralSettingsData; error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (data.settings) setGeneralSettings(data.settings);
    } catch (cause) {
      setErrorMsg(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingField(null);
    }
  };

  const togglePowerShell = async (enabled: boolean) => {
    setShellSaving(true);
    setErrorMsg(null);
    try {
      const response = await fetch("/api/tools/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as ShellToolSettingsResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setShellSettings(data);
      if (sessionId) {
        await sendAgentCommand(sessionId, { type: "reload" });
        onSessionReloaded();
      }
    } catch (cause) {
      setErrorMsg(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setShellSaving(false);
    }
  };

  const updateCloseBehavior = async (value: DesktopCloseBehavior) => {
    setCloseBehaviorSaving(true);
    setErrorMsg(null);
    try {
      await setDesktopCloseBehavior(value);
      setCloseBehavior(value);
    } catch (cause) {
      setErrorMsg(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCloseBehaviorSaving(false);
    }
  };

  return (
    <div className="settings-general">
      <div className="settings-subtab-bar">
        <button
          type="button"
          className={`settings-subtab-pill ${subTab === "appearance" ? "is-active" : ""}`}
          onClick={() => setSubTab("appearance")}
        >
          {t("settings.tabAppearance")}
        </button>
        <button
          type="button"
          className={`settings-subtab-pill ${subTab === "automation" ? "is-active" : ""}`}
          onClick={() => setSubTab("automation")}
        >
          {t("settings.tabAutomation")}
        </button>
        <button
          type="button"
          className={`settings-subtab-pill ${subTab === "environment" ? "is-active" : ""}`}
          onClick={() => setSubTab("environment")}
        >
          {t("settings.tabEnvironment")}
        </button>
        {desktopApp && (
          <button
            type="button"
            className={`settings-subtab-pill ${subTab === "desktop" ? "is-active" : ""}`}
            onClick={() => setSubTab("desktop")}
          >
            {t("settings.tabDesktop")}
          </button>
        )}
      </div>

      <div className="settings-general-content">
        {subTab === "appearance" && (
          <>
            <section className="settings-general-section">
              <h3 className="settings-general-heading">{t("settings.appearance")}</h3>
              <p className="settings-general-description">{t("settings.appearanceDescription")}</p>
              <div role="radiogroup" aria-label={t("settings.appearance")} className="settings-theme-options">
                {themeOptions.map((option) => {
                  const selected = preference === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setThemePreference(option.id)}
                      className="settings-theme-option"
                    >
                      <ThemeIcon preference={option.id} />
                      <span className="settings-theme-option-label">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="settings-general-section">
              <h3 className="settings-general-heading">{t("settings.fontSize")}</h3>
              <p className="settings-general-description">{t("settings.fontSizeDescription")}</p>
              <div role="radiogroup" aria-label={t("settings.fontSize")} className="settings-font-options">
                {fontSizeOptions.map((option) => {
                  const selected = fontSize === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setFontSize(option.id)}
                      className="settings-theme-option"
                    >
                      <span className="settings-font-option-content">
                        <span>{option.label}</span>
                        <span className="settings-font-option-size">{option.size}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="settings-general-section">
              <h3 className="settings-general-heading">{t("common.language")}</h3>
              <p className="settings-general-description">{t("settings.languageDescription")}</p>
              <div role="radiogroup" aria-label={t("common.language")} className="settings-language-options">
                {supportedLocales.map((plugin) => {
                  const selected = locale === plugin.id;
                  return (
                    <button
                      key={plugin.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setLocale(plugin.id as typeof locale)}
                      className="settings-language-option"
                    >
                      <span className="settings-language-radio">
                        {selected && <span className="settings-language-radio-dot" />}
                      </span>
                      <span className="settings-language-label">{plugin.label}</span>
                      <span className="settings-language-code">{plugin.id}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="settings-general-section">
              <div className="settings-card-row">
                <div className="settings-card-row-info">
                  <h4 className="settings-card-row-title">{t("settings.hideThinking")}</h4>
                  <p className="settings-card-row-desc">{t("settings.hideThinkingDescription")}</p>
                </div>
                <ConfigSwitch
                  checked={generalSettings?.hideThinkingBlock ?? false}
                  loading={savingField === "hideThinkingBlock"}
                  label={t("settings.hideThinking")}
                  onChange={(val) => void updateSetting("hideThinkingBlock", val)}
                />
              </div>
            </section>
          </>
        )}

        {subTab === "automation" && (
          <>
            <section className="settings-general-section">
              <div className="settings-card-row">
                <div className="settings-card-row-info">
                  <h4 className="settings-card-row-title">{t("settings.autoCompaction")}</h4>
                  <p className="settings-card-row-desc">{t("settings.autoCompactionDescription")}</p>
                </div>
                <ConfigSwitch
                  checked={generalSettings?.compactionEnabled ?? true}
                  loading={savingField === "compactionEnabled"}
                  label={t("settings.autoCompaction")}
                  onChange={(val) => void updateSetting("compactionEnabled", val)}
                />
              </div>
            </section>

            <section className="settings-general-section">
              <div className="settings-card-row">
                <div className="settings-card-row-info">
                  <h4 className="settings-card-row-title">{t("settings.autoRetry")}</h4>
                  <p className="settings-card-row-desc">{t("settings.autoRetryDescription")}</p>
                </div>
                <ConfigSwitch
                  checked={generalSettings?.retryEnabled ?? true}
                  loading={savingField === "retryEnabled"}
                  label={t("settings.autoRetry")}
                  onChange={(val) => void updateSetting("retryEnabled", val)}
                />
              </div>
            </section>

            <section className="settings-general-section">
              <h3 className="settings-general-heading">{t("settings.defaultReasoning")}</h3>
              <p className="settings-general-description">{t("settings.defaultReasoningDescription")}</p>
              <div className="settings-reasoning-options">
                {thinkingOptions.map((opt) => {
                  const selected = (generalSettings?.defaultThinkingLevel ?? "auto") === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={`settings-reasoning-pill ${selected ? "is-active" : ""}`}
                      onClick={() => void updateSetting("defaultThinkingLevel", opt.id)}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="settings-general-section">
              <div className="settings-card-row">
                <div className="settings-card-row-info">
                  <h4 className="settings-card-row-title">{t("settings.quietStartup")}</h4>
                  <p className="settings-card-row-desc">{t("settings.quietStartupDescription")}</p>
                </div>
                <ConfigSwitch
                  checked={generalSettings?.quietStartup ?? false}
                  loading={savingField === "quietStartup"}
                  label={t("settings.quietStartup")}
                  onChange={(val) => void updateSetting("quietStartup", val)}
                />
              </div>
            </section>
          </>
        )}

        {subTab === "environment" && (
          <>
            {shellSettings?.isWindows && (
              <section className="settings-general-section">
                <h3 className="settings-general-heading">{t("settings.shellTool")}</h3>
                <p className="settings-general-description">{t("settings.shellToolDescription")}</p>
                <div className="settings-shell-option">
                  <span>{t("settings.usePowerShell")}</span>
                  <ConfigSwitch
                    checked={shellSettings.powerShellEnabled}
                    loading={shellSaving}
                    label={t("settings.usePowerShell")}
                    onChange={(enabled) => void togglePowerShell(enabled)}
                  />
                </div>
              </section>
            )}

            <section className="settings-general-section">
              <div className="settings-card-row">
                <div className="settings-card-row-info">
                  <h4 className="settings-card-row-title">{t("settings.enableSkillCommands")}</h4>
                  <p className="settings-card-row-desc">{t("settings.enableSkillCommandsDescription")}</p>
                </div>
                <ConfigSwitch
                  checked={generalSettings?.enableSkillCommands ?? true}
                  loading={savingField === "enableSkillCommands"}
                  label={t("settings.enableSkillCommands")}
                  onChange={(val) => void updateSetting("enableSkillCommands", val)}
                />
              </div>
            </section>

            <section className="settings-general-section">
              <h3 className="settings-general-heading">{t("settings.projectTrust")}</h3>
              <p className="settings-general-description">{t("settings.projectTrustDescription")}</p>
              <div className="settings-theme-options is-compact">
                {[
                  { id: "prompt", label: t("settings.trustPrompt") },
                  { id: "auto", label: t("settings.trustAuto") },
                ].map((opt) => {
                  const selected = (generalSettings?.defaultProjectTrust ?? "prompt") === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className="settings-theme-option"
                      aria-checked={selected}
                      onClick={() => void updateSetting("defaultProjectTrust", opt.id)}
                    >
                      <span className="settings-theme-option-label">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          </>
        )}

        {subTab === "desktop" && desktopApp && (
          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("settings.closeBehavior")}</h3>
            <p className="settings-general-description">{t("settings.closeBehaviorDescription")}</p>
            <div role="radiogroup" aria-label={t("settings.closeBehavior")} className="settings-language-options">
              {([
                { id: "minimize-to-tray" as DesktopCloseBehavior, label: t("settings.closeBehaviorTray") },
                { id: "quit" as DesktopCloseBehavior, label: t("settings.closeBehaviorQuit") },
              ]).map((option) => {
                const selected = closeBehavior === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={closeBehaviorSaving}
                    onClick={() => void updateCloseBehavior(option.id)}
                    className="settings-language-option"
                  >
                    <span className="settings-language-radio">
                      {selected && <span className="settings-language-radio-dot" />}
                    </span>
                    <span className="settings-language-label">{option.label}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {errorMsg && <p role="alert" className="settings-general-error">{errorMsg}</p>}
      </div>
    </div>
  );
}

export function SettingsPanel({ cwd, sessionId, initialSection, onClose, onSessionReloaded }: Props) {
  const { t } = useI18n();
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [mountedSections, setMountedSections] = useState<ReadonlySet<SettingsSection>>(
    () => new Set([section]),
  );
  const sections: { id: SettingsSection; label: string; requiresProject: boolean }[] = [
    { id: "general", label: t("settings.general"), requiresProject: false },
    { id: "models", label: t("common.models"), requiresProject: false },
    { id: "sessions", label: t("common.sessions"), requiresProject: false },
    { id: "skills", label: t("common.skills"), requiresProject: true },
    { id: "plugins", label: t("common.plugins"), requiresProject: true },
  ];

  useEffect(() => setLastSettingsSection(initialSection), [initialSection]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (cwd || (section !== "skills" && section !== "plugins")) return;
    setSection("general");
    setMountedSections((current) => new Set(current).add("general"));
    setLastSettingsSection("general");
  }, [cwd, section]);

  const activateSection = (nextSection: SettingsSection) => {
    setMountedSections((current) => new Set(current).add(nextSection));
    setSection(nextSection);
    setLastSettingsSection(nextSection);
  };

  const sectionHost = (id: SettingsSection, content: ReactNode) => mountedSections.has(id) ? (
    <div
      key={id}
      hidden={section !== id}
      className="settings-section-host"
    >
      {content}
    </div>
  ) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className="settings-dialog-backdrop"
    >
      <div className="settings-dialog-surface">
        <aside className="settings-dialog-sidebar">
          <div className="settings-dialog-sidebar-head">
            <strong className="settings-dialog-title">{t("settings.title")}</strong>
          </div>
          <nav aria-label={t("settings.title")} className="settings-section-tabs">
            {sections.map((item) => {
              const selected = section === item.id;
              const disabled = item.requiresProject && !cwd;
              return (
                <button
                  key={item.id}
                  type="button"
                  className="settings-section-tab"
                  disabled={disabled}
                  title={disabled ? t("settings.projectRequired") : item.label}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => activateSection(item.id)}
                >
                  <SettingsSectionIcon section={item.id} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="settings-dialog-body">
          <div className="settings-dialog-header">
            <select
              aria-label={t("settings.title")}
              value={section}
              onChange={(event) => activateSection(event.target.value as SettingsSection)}
              className="settings-mobile-section-picker"
            >
              {sections.map((item) => (
                <option key={item.id} value={item.id} disabled={item.requiresProject && !cwd}>
                  {item.label}
                </option>
              ))}
            </select>
            <button type="button" onClick={onClose} title={t("i18n.close")} aria-label={t("i18n.close")} className="config-close-button settings-dialog-close">×</button>
          </div>

          <main className="settings-dialog-main">
            {sectionHost("general", <GeneralSettings sessionId={sessionId} onSessionReloaded={onSessionReloaded} />)}
            {sectionHost("models", <ModelsConfig embedded onClose={onClose} />)}
            {sectionHost("sessions", <SessionsConfig embedded onClose={onClose} />)}
            {cwd && sectionHost("skills", <SkillsConfig embedded key={cwd} cwd={cwd} onClose={onClose} />)}
            {cwd && sectionHost("plugins", <PluginsConfig embedded key={cwd} cwd={cwd} sessionId={sessionId} onClose={onClose} onReloaded={onSessionReloaded} />)}
          </main>
        </div>
      </div>
    </div>
  );
}
