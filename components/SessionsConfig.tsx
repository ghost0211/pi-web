"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  readHiddenProjects,
  removeHiddenProject,
} from "@/lib/hidden-projects";
import {
  readHiddenSessions,
  removeHiddenSession,
  addHiddenSession,
  removeHiddenSessionsForProject,
} from "@/lib/hidden-sessions";
import type { SessionInfo } from "@/lib/types";
import { formatRelativeTime } from "@/lib/i18n/format";
import {
  ConfigPanelShell,
  ConfigSplitView,
  ConfigSidebar,
  ConfigDetail,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigButton,
  ConfigSidebarItem,
} from "./SettingsUi";

export function SessionsConfig({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const { t, locale } = useI18n();
  const [projects, setProjects] = useState(() => readHiddenProjects());
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [hiddenSessions, setHiddenSessions] = useState<Set<string>>(() => (
    new Set(readHiddenSessions().map((entry) => entry.id))
  ));

  // Load all sessions so the selected project's sessions can be listed.
  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await fetch("/api/sessions");
      const data = await res.json() as { sessions?: SessionInfo[] };
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch {
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => { void loadSessions(); }, [loadSessions]);

  useEffect(() => {
    if (!selectedProject && projects.length > 0) setSelectedProject(projects[0].key);
  }, [projects, selectedProject]);

  const selectedHiddenProject = projects.find((project) => project.key === selectedProject);
  const projectSessions = useMemo(() => (
    selectedProject
      ? sessions
          .filter((session) => session.cwd === selectedProject)
          .sort((a, b) => b.modified.localeCompare(a.modified))
      : []
  ), [sessions, selectedProject]);

  const restoreProject = (key: string) => {
    const next = removeHiddenProject(key);
    setProjects(next);
    if (selectedProject === key) setSelectedProject(next[0]?.key ?? null);
    // Sessions stay hidden individually; only the project is restored.
    const hidden = new Set(readHiddenSessions().map((entry) => entry.id));
    setHiddenSessions(hidden);
  };

  const removeProjectPermanently = async (key: string) => {
    const toDelete = sessions.filter((session) => session.cwd === key);
    await Promise.allSettled(toDelete.map((session) => (
      fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" })
    )));
    removeHiddenSessionsForProject(key);
    const next = removeHiddenProject(key);
    setProjects(next);
    setHiddenSessions(new Set(readHiddenSessions().map((entry) => entry.id)));
    await loadSessions();
  };

  const toggleSessionHidden = (sessionId: string) => {
    if (hiddenSessions.has(sessionId)) {
      removeHiddenSession(sessionId);
      setHiddenSessions((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    } else {
      addHiddenSession({ id: sessionId, projectKey: selectedProject ?? undefined });
      setHiddenSessions((prev) => new Set(prev).add(sessionId));
    }
  };

  const deleteSession = async (sessionId: string) => {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    removeHiddenSession(sessionId);
    setHiddenSessions((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
    await loadSessions();
  };

  const humanPath = (root?: string) => root ?? "";

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.sessions")} subtitle="pi-web:hidden-*" closeLabel={t("i18n.close")} onClose={onClose}>
      <ConfigSplitView>
        {/* Left: hidden projects */}
        <ConfigSidebar>
          <div style={{ padding: "8px 10px", fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {t("sidebar.hiddenProjects")}
          </div>
          {projects.length === 0 ? (
            <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("settings.noHiddenProjects")}
            </div>
          ) : projects.map((project) => (
            <ConfigSidebarItem
              key={project.key}
              active={selectedProject === project.key}
              onClick={() => setSelectedProject(project.key)}
            >
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {humanPath(project.root)}
              </span>
            </ConfigSidebarItem>
          ))}
        </ConfigSidebar>

        {/* Right: sessions of the selected project */}
        <ConfigDetail>
          <ConfigDetailStack>
            {!selectedHiddenProject ? (
              <ConfigEmptyState>{t("settings.selectHiddenProject")}</ConfigEmptyState>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }} title={humanPath(selectedHiddenProject.root)}>
                      {humanPath(selectedHiddenProject.root)}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                      {selectedHiddenProject.key}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <ConfigButton onClick={() => restoreProject(selectedHiddenProject.key)}>
                      {t("settings.restoreProject")}
                    </ConfigButton>
                    <ConfigButton
                      variant="danger"
                      onClick={() => { void removeProjectPermanently(selectedHiddenProject.key); }}
                    >
                      {t("settings.removeProjectPermanently")}
                    </ConfigButton>
                  </div>
                </div>

                {sessionsLoading ? (
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("i18n.loading")}</div>
                ) : projectSessions.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("settings.noSessionsForProject")}</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {projectSessions.map((session) => {
                      const hidden = hiddenSessions.has(session.id);
                      return (
                        <div
                          key={session.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 10px",
                            background: "var(--bg-panel)",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                          }}
                        >
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: hidden ? 0.5 : 1 }}>
                              {session.name ?? session.id.slice(0, 8)}
                            </div>
                            <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
                              {formatRelativeTime(session.modified, locale)} · {session.messageCount} msgs · {hidden ? t("settings.sessionHidden") : ""}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => toggleSessionHidden(session.id)}
                            title={hidden ? t("settings.restoreSession") : t("sidebar.hideSession")}
                            style={{
                              flexShrink: 0, padding: "3px 8px", fontSize: 10,
                              border: "1px solid var(--border)", borderRadius: 4,
                              background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer",
                            }}
                          >
                            {hidden ? t("settings.restoreSession") : t("sidebar.hideSession")}
                          </button>
                          <button
                            type="button"
                            onClick={() => { void deleteSession(session.id); }}
                            title={t("i18n.delete")}
                            style={{
                              flexShrink: 0, padding: "3px 8px", fontSize: 10,
                              border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4,
                              background: "none", color: "#ef4444", cursor: "pointer",
                            }}
                          >
                            {t("i18n.delete")}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
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
