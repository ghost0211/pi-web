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
  removeHiddenSessionsForProject,
} from "@/lib/hidden-sessions";
import type { SessionInfo } from "@/lib/types";
import { workspaceKeyOf } from "@/lib/workspace-memory";
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
  const [projects, setProjects] = useState<string[]>([]);
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

  // Refresh hide state (settings panel and sidebar share localStorage).
  const refreshProjects = useCallback(() => {
    const hiddenProjectKeys = new Set(readHiddenProjects().map((entry) => entry.key));
    const sessionProjectKeys = new Set(
      readHiddenSessions().map((entry) => entry.projectKey).filter((key): key is string => Boolean(key)),
    );
    const merged = Array.from(new Set([...hiddenProjectKeys, ...sessionProjectKeys]));
    setProjects(merged);
    setHiddenSessions(new Set(readHiddenSessions().map((entry) => entry.id)));
    setSelectedProject((current) => current && merged.includes(current) ? current : (merged[0] ?? null));
  }, []);

  const projectRoots = new Map(readHiddenProjects().map((entry) => [entry.key, entry.root]));

  useEffect(() => {
    void loadSessions();
    refreshProjects();
    const onStateChange = () => refreshProjects();
    window.addEventListener("pi-web:hidden-state-changed", onStateChange);
    return () => window.removeEventListener("pi-web:hidden-state-changed", onStateChange);
  }, [loadSessions, refreshProjects]);

  const selectedProjectKey = selectedProject;
  const projectSessions = useMemo(() => (
    selectedProjectKey
      ? sessions
          .filter((session) => workspaceKeyOf(session) === selectedProjectKey)
          .sort((a, b) => b.modified.localeCompare(a.modified))
      : []
  ), [sessions, selectedProjectKey]);

  const projectHidden = selectedProjectKey
    ? readHiddenProjects().some((entry) => entry.key === selectedProjectKey)
    : false;

  const restoreProject = (key: string) => {
    removeHiddenProject(key);
    removeHiddenSessionsForProject(key);
    refreshProjects();
  };

  const removeProjectPermanently = async (key: string) => {
    const toDelete = sessions.filter((session) => workspaceKeyOf(session) === key);
    await Promise.allSettled(toDelete.map((session) => (
      fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" })
    )));
    removeHiddenSessionsForProject(key);
    removeHiddenProject(key);
    refreshProjects();
    await loadSessions();
  };

  const restoreSession = (sessionId: string) => {
    // Restoring one session also un-hides its project so the session is
    // visible in the main sidebar again.
    removeHiddenSession(sessionId);
    if (selectedProjectKey) removeHiddenProject(selectedProjectKey);
    refreshProjects();
  };

  const deleteSession = async (sessionId: string) => {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    removeHiddenSession(sessionId);
    refreshProjects();
    await loadSessions();
  };

  const humanPath = (key: string) => projectRoots.get(key) ?? key;

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.sessions")} subtitle="pi-web:hidden-*" closeLabel={t("i18n.close")} onClose={onClose}>
      <ConfigSplitView>
        {/* Left: projects with any hidden content (project hidden or hidden sessions) */}
        <ConfigSidebar>
          <div style={{ padding: "8px 10px", fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {t("settings.hiddenProjects")}
          </div>
          {projects.length === 0 ? (
            <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("settings.noHiddenProjects")}
            </div>
          ) : projects.map((key) => (
            <ConfigSidebarItem
              key={key}
              active={selectedProject === key}
              onClick={() => setSelectedProject(key)}
            >
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {humanPath(key)}
              </span>
            </ConfigSidebarItem>
          ))}
        </ConfigSidebar>

        {/* Right: sessions of the selected project */}
        <ConfigDetail>
          <ConfigDetailStack>
            {!selectedProjectKey ? (
              <ConfigEmptyState>{t("settings.selectHiddenProject")}</ConfigEmptyState>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }} title={humanPath(selectedProjectKey)}>
                      {humanPath(selectedProjectKey)}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                      {selectedProjectKey}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {projectHidden && (
                      <ConfigButton onClick={() => restoreProject(selectedProjectKey)}>
                        {t("settings.restoreProject")}
                      </ConfigButton>
                    )}
                    <ConfigButton
                      variant="danger"
                      onClick={() => { void removeProjectPermanently(selectedProjectKey); }}
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
                      const displayFirstMessage = session.firstMessage ?? "";
                      const title = session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);
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
                            opacity: hidden ? 0.55 : 1,
                          }}
                        >
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={title}>
                              {title}
                            </div>
                            <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
                              {formatRelativeTime(session.modified, locale)} · {session.messageCount} msgs{hidden ? ` · ${t("settings.sessionHidden")}` : ""}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => restoreSession(session.id)}
                            title={t("settings.restoreSession")}
                            style={{
                              flexShrink: 0, padding: "3px 8px", fontSize: 10,
                              border: "1px solid var(--border)", borderRadius: 4,
                              background: "var(--bg)", color: "var(--text)", cursor: "pointer",
                            }}
                          >
                            {t("settings.restoreSession")}
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
