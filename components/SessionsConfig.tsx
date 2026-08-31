"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  readHiddenProjects,
  removeHiddenProject,
} from "@/lib/hidden-projects";
import {
  ConfigPanelShell,
  ConfigSplitView,
  ConfigSidebar,
  ConfigDetail,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigButton,
} from "./SettingsUi";

export function SessionsConfig({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const { t } = useI18n();
  const [projects, setProjects] = useState(() => readHiddenProjects());

  const restore = (key: string) => {
    const next = removeHiddenProject(key);
    setProjects(next);
  };

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.sessions")} subtitle="pi-web:hidden-projects" closeLabel={t("i18n.close")} onClose={onClose}>
      <ConfigSplitView>
        <ConfigSidebar>
          <div style={{ padding: "8px 10px", fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {t("sidebar.hiddenProjects")}
          </div>
        </ConfigSidebar>
        <ConfigDetail>
          <ConfigDetailStack>
            {projects.length === 0 ? (
              <ConfigEmptyState>{t("settings.noHiddenProjects")}</ConfigEmptyState>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  {t("settings.hiddenProjectsDescription")}
                </div>
                {projects.map((project) => (
                  <div
                    key={project.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      background: "var(--bg-panel)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={project.root ?? project.key}
                      >
                        {project.root ?? project.key}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {project.key}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => restore(project.key)}
                      style={{
                        flexShrink: 0,
                        padding: "4px 10px",
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        background: "var(--bg)",
                        color: "var(--text)",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      {t("settings.restoreProject")}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>

      <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
        {!embedded && <ConfigButton onClick={onClose}>{t("i18n.cancel")}</ConfigButton>}
      </div>
    </ConfigPanelShell>
  );
}
