"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { isDesktopApp } from "@/lib/desktop";
import { checkDesktopUpdate, installDesktopUpdate, type DesktopUpdate } from "@/lib/desktop-update";

/** Startup notice for a signed desktop release; never runs in a normal browser. */
export function DesktopUpdatePrompt() {
  const { t } = useI18n();
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktopApp()) return;
    let active = true;
    void checkDesktopUpdate().then((found) => {
      if (active) setUpdate(found);
      else if (found) void found.close().catch(() => {});
    }).catch(() => {
      // The About page offers a manual retry and displays the actual error.
    });
    return () => { active = false; };
  }, []);

  if (!update || dismissed) return null;

  const install = async () => {
    if (installing || !window.confirm(t("about.desktopUpdateConfirm", { version: update.version }))) return;
    setInstalling(true);
    setError(null);
    try {
      await installDesktopUpdate(update, () => {});
      // On Windows, the plugin exits this app after launching the installer.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setInstalling(false);
    }
  };

  return (
    <aside className="desktop-update-prompt" aria-label={t("about.desktopUpdateTitle")}>
      <strong>{t("about.desktopUpdateAvailable", { version: update.version })}</strong>
      <span>{t("about.desktopUpdateRestartNote")}</span>
      {error && <span role="alert">{t("about.desktopUpdateError", { error })}</span>}
      <div className="desktop-update-prompt-actions">
        <button type="button" disabled={installing} onClick={() => void install()}>
          {installing ? t("about.desktopInstalling") : t("about.desktopInstallUpdate")}
        </button>
        <button type="button" disabled={installing} onClick={() => setDismissed(true)}>{t("i18n.close")}</button>
      </div>
    </aside>
  );
}
