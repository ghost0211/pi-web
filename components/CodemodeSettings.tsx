"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import { ConfigButton, ConfigField, ConfigSectionTitle } from "./SettingsUi";

interface Props { sessionId: string | null; onSessionReloaded: () => void }

export function parseCodemodeBudget(value: string): number | undefined {
  const budget = Number(value);
  return value.trim() !== "" && Number.isSafeInteger(budget) && budget >= 0 ? budget : undefined;
}

export function CodemodeSettings({ sessionId, onSessionReloaded }: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"on" | "only">("on");
  const [budget, setBudget] = useState("3000");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [saved, setSaved] = useState(false);
  const lifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setLoading(true);
    setReady(false);
    setBusy(false);
    setError(null);
    setNeedsReload(false);
    setSaved(false);
    void (async () => {
      try {
        const response = await fetch("/api/settings", { signal: controller.signal });
        if (!response.ok) throw new Error("load");
        const data = await response.json();
        if (controller.signal.aborted) return;
        setReady(true);
        setMode(data.codemodeMode === "only" ? "only" : "on");
        setBudget(String(Number.isSafeInteger(data.codemodeInlineBudget) && data.codemodeInlineBudget >= 0 ? data.codemodeInlineBudget : 3000));
      } catch { if (!controller.signal.aborted) setError(t("settings.codemode.loadError")); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [sessionId, t, retry]);

  const save = async () => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || busy || loading || !ready) return;
    const parsed = parseCodemodeBudget(budget);
    if (parsed === undefined) { setError(t("settings.codemode.budgetError")); return; }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ codemodeMode: mode, codemodeInlineBudget: parsed }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error("save");
      if (controller.signal.aborted) return;
      setMode(data.settings.codemodeMode);
      setBudget(String(data.settings.codemodeInlineBudget));
      setSaved(true);
      setNeedsReload(Boolean(sessionId));
    } catch { if (!controller.signal.aborted) setError(t("settings.codemode.saveError")); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };

  const reload = async () => {
    const controller = lifetime.current;
    if (!sessionId || !controller || controller.signal.aborted || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/mcp/runtime?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal });
      const runtime = await response.json();
      if (!response.ok || runtime.live !== true || controller.signal.aborted) throw new Error("No live session");
      await sendAgentCommand(sessionId, { type: "reload", requireLiveSession: true }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setNeedsReload(false);
      onSessionReloaded();
    } catch { if (!controller.signal.aborted) setError(t("settings.codemode.reloadError")); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };

  return (
    <section style={{ marginTop: 16 }} aria-label={t("settings.codemode.title")}>
      <ConfigSectionTitle>{t("settings.codemode.title")}</ConfigSectionTitle>
      <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>{t("settings.codemode.description")}</p>
      {loading ? <p>{t("settings.codemode.loading")}</p> : (
        <fieldset disabled={busy || !ready} style={{ border: 0, margin: 0, padding: 0 }}>
          <ConfigField label={t("settings.codemode.mode")}>
            <select aria-label={t("settings.codemode.mode")} value={mode} onChange={(event) => { setMode(event.target.value as "on" | "only"); setSaved(false); }}>
              <option value="on">{t("settings.codemode.modeOn")}</option>
              <option value="only">{t("settings.codemode.modeOnly")}</option>
            </select>
          </ConfigField>
          <ConfigField label={t("settings.codemode.budget")}>
            <input aria-label={t("settings.codemode.budget")} type="number" min={0} step={1} value={budget} onChange={(event) => { setBudget(event.target.value); setSaved(false); }} />
          </ConfigField>
          <p style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("settings.codemode.budgetHint")}</p>
          <ConfigButton onClick={() => void save()}>{busy ? t("settings.codemode.busy") : t("settings.codemode.save")}</ConfigButton>
        </fieldset>
      )}
      {error && <p role="alert" style={{ color: "var(--error, #ef4444)", fontSize: 12 }}>{error}</p>}
      {!loading && !ready && <ConfigButton onClick={() => setRetry((value) => value + 1)}>{t("settings.codemode.retry")}</ConfigButton>}
      {saved && <p role="status" style={{ fontSize: 12 }}>{t("settings.codemode.saved")}</p>}
      {needsReload && <div style={{ fontSize: 12, marginTop: 8 }}>
        <p>{t("settings.codemode.reloadHint")}</p>
        <ConfigButton disabled={busy} onClick={() => void reload()}>{t("settings.codemode.reload")}</ConfigButton>
      </div>}
    </section>
  );
}
