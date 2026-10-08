"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useSessionManagement } from "@/hooks/useSessionManagement";
import { deleteManagedSessions } from "@/lib/session-management-client";
import {
  emptySessionManagementState,
  managedSessionState,
} from "@/lib/session-management-types";
import type {
  SessionManagementAction,
  SessionManagementFilter,
  SessionManagementState,
} from "@/lib/session-management-types";
import type { SessionInfo } from "@/lib/types";
import { formatRelativeTime } from "@/lib/i18n/format";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { ConfigButton, ConfigPanelShell } from "./SettingsUi";

type SessionsConfigProps = {
  onClose: () => void;
  embedded?: boolean;
  initialFilter?: SessionManagementFilter;
  initialProjectKey?: string;
  onSelectSession?: (session: SessionInfo) => void;
  onOperationBusyChange?: (busy: boolean) => void;
};

type DeleteFailure = { id: string; error: string; running: boolean };
type DeleteConfirmation = { ids: string[] };

const buttonStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  padding: "5px 9px",
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const inputStyle: React.CSSProperties = {
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  padding: "7px 9px",
  fontSize: 12,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSessionCatalog(value: unknown): SessionInfo[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new Error("The session catalog response has an invalid shape.");
  }

  const sessions: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const item of value.sessions) {
    if (
      !isRecord(item)
      || typeof item.id !== "string"
      || item.id.length === 0
      || typeof item.cwd !== "string"
      || (item.modified !== undefined && typeof item.modified !== "string")
      || (item.name !== undefined && typeof item.name !== "string")
      || (item.firstMessage !== undefined && typeof item.firstMessage !== "string")
    ) {
      throw new Error("The session catalog contains an invalid session record.");
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    sessions.push(item as unknown as SessionInfo);
  }
  return sessions;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}

function isRunningConflict(error: unknown, message = errorMessage(error)): boolean {
  return (isRecord(error) && (error.status === 409 || error.statusCode === 409 || error.code === 409))
    || /\b409\b|\brunning\b/i.test(message);
}

function readableTime(value: string | undefined, locale: string): string {
  if (!value) return "";
  try {
    return formatRelativeTime(value, locale as "en" | "zh-CN" | "zh-TW");
  } catch {
    return "";
  }
}

function sessionTitle(session: SessionInfo): string {
  return session.name || session.firstMessage?.slice(0, 72) || session.id;
}

function warningText(warning: unknown): string {
  if (typeof warning === "string") return warning;
  if (isRecord(warning)) {
    if (typeof warning.message === "string") return warning.message;
    if (typeof warning.warning === "string") return warning.warning;
    if (typeof warning.error === "string") return warning.error;
  }
  return String(warning);
}

export function SessionsConfig({
  onClose,
  embedded = false,
  initialFilter = "all",
  initialProjectKey,
  onSelectSession,
  onOperationBusyChange,
}: SessionsConfigProps) {
  const { t, locale } = useI18n();
  const {
    state,
    ready,
    loading: managementLoading,
    error: managementError,
    refresh: refreshManagement,
    update,
  } = useSessionManagement();
  const managementState: SessionManagementState = state ?? emptySessionManagementState();

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SessionManagementFilter>(initialFilter);
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState(initialProjectKey ?? "");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [operationBusy, setOperationBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteFailures, setDeleteFailures] = useState<DeleteFailure[]>([]);
  const [deleteWarnings, setDeleteWarnings] = useState<string[]>([]);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmation | null>(null);
  const mountedRef = useRef(false);
  const catalogRequestRef = useRef<AbortController | null>(null);
  // Keep confirmed batches observable: the containing Settings panel blocks
  // dismissal/tab switching until their full per-item result is displayed.
  useEffect(() => {
    onOperationBusyChange?.(operationBusy);
    return () => onOperationBusyChange?.(false);
  }, [onOperationBusyChange, operationBusy]);

  const refreshCatalog = useCallback(async (): Promise<SessionInfo[] | null> => {
    catalogRequestRef.current?.abort();
    const controller = new AbortController();
    catalogRequestRef.current = controller;
    setCatalogLoading(true);
    setCatalogError(null);

    try {
      const response = await fetch("/api/sessions", { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nextSessions = parseSessionCatalog(await response.json());
      if (!mountedRef.current || controller.signal.aborted || catalogRequestRef.current !== controller) return null;
      const nextIds = new Set(nextSessions.map((session) => session.id));
      setSessions(nextSessions);
      setCatalogLoaded(true);
      setSelectedIds((current) => current.filter((id) => nextIds.has(id)));
      return nextSessions;
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current || catalogRequestRef.current !== controller) return null;
      setCatalogError(errorMessage(error));
      return null;
    } finally {
      if (mountedRef.current && catalogRequestRef.current === controller) {
        catalogRequestRef.current = null;
        setCatalogLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshCatalog();
    return () => {
      mountedRef.current = false;
      catalogRequestRef.current?.abort();
      catalogRequestRef.current = null;
    };
  }, [refreshCatalog]);

  const projectInfo = useMemo(() => {
    const info = new Map<string, { label: string; root?: string }>();
    for (const session of sessions) {
      const key = workspaceKeyOf(session);
      const root = session.projectRoot ?? session.cwd;
      const previous = info.get(key);
      if (!previous || previous.label === key) info.set(key, { label: root || key, root });
    }
    for (const [key, project] of Object.entries(managementState.projects ?? {})) {
      const previous = info.get(key);
      const root = project?.root ?? previous?.root;
      info.set(key, { label: previous?.label && previous.label !== key ? previous.label : root ?? key, root });
    }
    return info;
  }, [managementState.projects, sessions]);

  const projectKeys = useMemo(
    () => [...projectInfo.keys()].sort((left, right) => {
      const a = projectInfo.get(left)?.label ?? left;
      const b = projectInfo.get(right)?.label ?? right;
      return a.localeCompare(b, locale);
    }),
    [locale, projectInfo],
  );
  const projectFilterIsKnown = projectFilter === "" || projectInfo.has(projectFilter);
  const projectSessions = useMemo(
    () => sessions.filter((session) => projectFilter === "" || workspaceKeyOf(session) === projectFilter),
    [projectFilter, sessions],
  );
  const projectCounts = useMemo(() => ({
    all: projectSessions.length,
    active: projectSessions.filter((session) => managedSessionState(managementState, session.id).status !== "archived").length,
    archived: projectSessions.filter((session) => managedSessionState(managementState, session.id).status === "archived").length,
  }), [managementState, projectSessions]);

  const filteredSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(locale);
    return projectSessions
      .filter((session) => {
        const status = managedSessionState(managementState, session.id).status === "archived" ? "archived" : "active";
        if (filter !== "all" && status !== filter) return false;
        if (!normalizedQuery) return true;
        const title = sessionTitle(session);
        const projectLabel = projectInfo.get(workspaceKeyOf(session))?.label ?? workspaceKeyOf(session);
        return [title, session.id, session.name, session.firstMessage, projectLabel, workspaceKeyOf(session)]
          .some((part) => typeof part === "string" && part.toLocaleLowerCase(locale).includes(normalizedQuery));
      })
      .sort((left, right) => (right.modified ?? "").localeCompare(left.modified ?? ""));
  }, [filter, locale, managementState, projectInfo, projectSessions, query]);

  const visibleIds = useMemo(() => new Set(filteredSessions.map((session) => session.id)), [filteredSessions]);
  const selectedVisibleSessions = filteredSessions.filter((session) => selectedIds.includes(session.id));
  const selectedActiveIds = selectedVisibleSessions
    .filter((session) => managedSessionState(managementState, session.id).status !== "archived")
    .map((session) => session.id);
  const selectedArchivedIds = selectedVisibleSessions
    .filter((session) => managedSessionState(managementState, session.id).status === "archived")
    .map((session) => session.id);
  const canMutate = Boolean(
    catalogLoaded
    && !catalogError
    && ready
    && !catalogLoading
    && !managementLoading
    && !operationBusy
    && state,
  );
  const controlsBusy = catalogLoading || managementLoading || operationBusy;
  const selectedProjectState = projectFilter ? managementState.projects?.[projectFilter] : undefined;
  const selectedProjectLabel = projectFilter ? projectInfo.get(projectFilter)?.label ?? projectFilter : "";
  const selectedProjectSessions = projectFilter ? sessions.filter((session) => workspaceKeyOf(session) === projectFilter) : [];
  const selectedProjectActive = selectedProjectSessions.filter(
    (session) => managedSessionState(managementState, session.id).status !== "archived",
  );
  const isAllVisibleSelected = filteredSessions.length > 0 && filteredSessions.every((session) => selectedIds.includes(session.id));

  const clearSelectionForFilterChange = () => {
    setSelectedIds([]);
    setDeleteConfirmation(null);
  };

  const retry = async () => {
    setActionError(null);
    setNotice(null);
    try {
      await Promise.all([refreshCatalog(), refreshManagement()]);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  };

  const presentMutationError = (error: unknown) => {
    const message = errorMessage(error);
    return isRunningConflict(error, message)
      ? `${t("sessionsManager.runningRefusal")} ${message}`
      : message;
  };

  const applyAction = async (action: SessionManagementAction): Promise<boolean> => {
    if (!canMutate) {
      setActionError(t("sessionsManager.catalogNotReady"));
      return false;
    }
    setActionError(null);
    setNotice(null);
    setOperationBusy(true);
    try {
      await update(action);
      setSelectedIds([]);
      setNotice(t("sessionsManager.saved"));
      return true;
    } catch (error) {
      setActionError(presentMutationError(error));
      return false;
    } finally {
      setOperationBusy(false);
    }
  };

  const setSessionStatus = (session: SessionInfo, status: "active" | "archived") => {
    const action: SessionManagementAction = status === "active"
      ? { type: "sessions", ids: [session.id], status, restoreProjects: [workspaceKeyOf(session)] }
      : { type: "sessions", ids: [session.id], status };
    void applyAction(action);
  };

  const togglePinned = (session: SessionInfo) => {
    const pinned = !managedSessionState(managementState, session.id).pinned;
    void applyAction({ type: "sessions", ids: [session.id], pinned });
  };

  const setProjectRemoved = (removed: boolean) => {
    if (!canMutate || !projectFilter || !projectFilterIsKnown) {
      setActionError(t("sessionsManager.catalogNotReady"));
      return;
    }
    const root = projectInfo.get(projectFilter)?.root ?? selectedProjectState?.root;
    void applyAction({ type: "project", key: projectFilter, removed, ...(root ? { root } : {}) });
  };

  const archiveSelectedProjectSessions = () => {
    if (!canMutate || !projectFilter || selectedProjectActive.length === 0) return;
    void applyAction({ type: "sessions", ids: selectedProjectActive.map((session) => session.id), status: "archived" });
  };

  const toggleSessionSelection = (id: string, checked: boolean) => {
    if (!visibleIds.has(id)) return;
    setSelectedIds((current) => checked
      ? [...new Set([...current.filter((currentId) => visibleIds.has(currentId)), id])]
      : current.filter((currentId) => currentId !== id));
  };

  const toggleAllVisible = (checked: boolean) => {
    setSelectedIds(checked ? filteredSessions.map((session) => session.id) : []);
  };

  const beginDeleteConfirmation = () => {
    if (!canMutate || selectedVisibleSessions.length === 0) {
      setActionError(t("sessionsManager.catalogNotReady"));
      return;
    }
    setActionError(null);
    setDeleteConfirmation({ ids: selectedVisibleSessions.map((session) => session.id) });
  };

  const confirmDeletion = async () => {
    if (!deleteConfirmation || !canMutate) return;
    const ids = deleteConfirmation.ids.filter((id) => selectedIds.includes(id) && visibleIds.has(id) && sessions.some((session) => session.id === id));
    if (ids.length === 0) {
      setDeleteConfirmation(null);
      setActionError(t("sessionsManager.catalogNotReady"));
      return;
    }

    const originalRows = new Map(sessions.filter((session) => ids.includes(session.id)).map((session) => [session.id, session]));
    setActionError(null);
    setNotice(null);
    setDeleteWarnings([]);
    setOperationBusy(true);
    try {
      const result = await deleteManagedSessions(ids);
      const deletedIds = Array.isArray(result.deletedIds) ? result.deletedIds.filter((id) => ids.includes(id)) : [];
      const failures = Array.isArray(result.failures) ? result.failures.filter((failure) => ids.includes(failure.id)) : [];
      const reportedIds = new Set([...deletedIds, ...failures.map((failure) => failure.id)]);
      const allFailures: DeleteFailure[] = [
        ...failures.map((failure) => ({
          id: failure.id,
          error: failure.error,
          running: isRunningConflict(failure.error),
        })),
        ...ids.filter((id) => !reportedIds.has(id)).map((id) => ({
          id,
          error: t("sessionsManager.deleteMissingResult"),
          running: false,
        })),
      ];
      const failedIds = new Set(allFailures.map((failure) => failure.id));
      setSessions((current) => current.filter((session) => !deletedIds.includes(session.id)));
      setDeleteFailures((current) => [
        ...current.filter((failure) => !ids.includes(failure.id)),
        ...allFailures,
      ]);
      setSelectedIds([...failedIds]);
      setNotice(t("sessionsManager.deleteResult", { deleted: deletedIds.length, failed: allFailures.length }));
      setDeleteWarnings(Array.isArray(result.warnings) ? result.warnings.map(warningText) : []);
      setDeleteConfirmation(null);

      await refreshCatalog();
      if (allFailures.length > 0) {
        setSessions((current) => {
          const byId = new Map(current.map((session) => [session.id, session]));
          for (const failure of allFailures) {
            const original = originalRows.get(failure.id);
            if (original && !byId.has(failure.id)) byId.set(failure.id, original);
          }
          return [...byId.values()];
        });
        setSelectedIds([...failedIds]);
      }
    } catch (error) {
      setActionError(presentMutationError(error));
    } finally {
      setOperationBusy(false);
    }
  };

  const onSearchChange = (value: string) => {
    setQuery(value);
    clearSelectionForFilterChange();
  };

  const projectRemoved = selectedProjectState?.removed === true;
  const dangerButtonLabel = t("sessionsManager.deleteSelected", { count: selectedVisibleSessions.length });

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={t("sessionsManager.title")}
      subtitle={t("sessionsManager.subtitle")}
      closeLabel={t("sessionsManager.close")}
      onClose={() => { if (!operationBusy) onClose(); }}
      width={1080}
      height="84vh"
    >
      <div className="sessions-manager" style={{ display: "flex", flexDirection: "column", minHeight: 0, maxHeight: embedded ? "78vh" : "calc(84vh - 54px)" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 18px 10px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 650, color: "var(--text)" }}>{t("sessionsManager.heading")}</div>
            <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-dim)" }}>{t("sessionsManager.description")}</div>
          </div>
          <button type="button" style={buttonStyle} disabled={controlsBusy} onClick={() => void retry()}>
            {controlsBusy ? t("sessionsManager.loading") : t("sessionsManager.refresh")}
          </button>
        </header>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 18px 8px" }}>
          <input
            type="search"
            aria-label={t("sessionsManager.search")}
            placeholder={t("sessionsManager.searchPlaceholder")}
            value={query}
            onChange={(event) => onSearchChange(event.target.value)}
            style={{ ...inputStyle, flex: "1 1 230px" }}
          />
          <select
            aria-label={t("sessionsManager.projectFilter")}
            value={projectFilter}
            onChange={(event) => {
              setProjectFilter(event.target.value);
              clearSelectionForFilterChange();
            }}
            style={{ ...inputStyle, flex: "1 1 210px", maxWidth: 420 }}
          >
            <option value="">{t("sessionsManager.allProjects")}</option>
            {projectKeys.map((key) => {
              const removed = managementState.projects?.[key]?.removed === true;
              const label = projectInfo.get(key)?.label ?? key;
              return <option key={key} value={key}>{removed ? `${label} · ${t("sessionsManager.projectRemoved")}` : label}</option>;
            })}
          </select>
        </div>

        <nav aria-label={t("sessionsManager.filters")} style={{ display: "flex", gap: 6, padding: "0 18px 12px", borderBottom: "1px solid var(--border)" }}>
          {(["all", "active", "archived"] as const).map((status) => (
            <button
              type="button"
              key={status}
              aria-pressed={filter === status}
              style={{ ...buttonStyle, background: filter === status ? "var(--bg-panel)" : "var(--bg)", fontWeight: filter === status ? 650 : 400 }}
              onClick={() => {
                setFilter(status);
                clearSelectionForFilterChange();
              }}
            >
              {t(`sessionsManager.filter.${status}`)} <span aria-label={t("sessionsManager.count", { count: projectCounts[status] })}>({projectCounts[status]})</span>
            </button>
          ))}
        </nav>

        {projectFilter && projectFilterIsKnown && (
          <section aria-label={t("sessionsManager.projectManagement")} style={{ display: "flex", alignItems: "center", flexWrap: "wrap", justifyContent: "space-between", gap: 10, padding: "11px 18px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "var(--text)", fontSize: 12, fontWeight: 600, overflowWrap: "anywhere" }}>
                {selectedProjectLabel}
                {projectRemoved && <span style={{ marginLeft: 7, color: "var(--text-dim)", fontSize: 10 }}>{t("sessionsManager.projectRemoved")}</span>}
              </div>
              <div style={{ color: "var(--text-dim)", fontSize: 10, marginTop: 3 }}>{t("sessionsManager.projectActionDescription")}</div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <button type="button" style={buttonStyle} disabled={!canMutate || selectedProjectActive.length === 0} onClick={archiveSelectedProjectSessions}>
                {t("sessionsManager.archiveProjectActive", { count: selectedProjectActive.length })}
              </button>
              <button type="button" style={buttonStyle} disabled={!canMutate} onClick={() => setProjectRemoved(!projectRemoved)}>
                {projectRemoved ? t("sessionsManager.restoreProject") : t("sessionsManager.hideProject")}
              </button>
            </div>
          </section>
        )}

        <main style={{ minHeight: 120, overflow: "auto", padding: "12px 18px", flex: "1 1 auto" }}>
          {catalogError && (
            <div role="alert" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, padding: 10, marginBottom: 10, border: "1px solid rgba(239,68,68,.35)", borderRadius: 6, color: "#ef4444" }}>
              <span>{t("sessionsManager.catalogError")}: {catalogError}</span>
              <button type="button" style={buttonStyle} disabled={controlsBusy} onClick={() => void retry()}>{t("sessionsManager.retry")}</button>
            </div>
          )}
          {managementError && (
            <div role="alert" style={{ padding: 10, marginBottom: 10, border: "1px solid rgba(239,68,68,.35)", borderRadius: 6, color: "#ef4444" }}>
              {t("sessionsManager.metadataError")}: {errorMessage(managementError)}
            </div>
          )}
          {actionError && (
            <div role="alert" style={{ padding: 10, marginBottom: 10, border: "1px solid rgba(239,68,68,.35)", borderRadius: 6, color: "#ef4444" }}>
              {t("sessionsManager.actionError")}: {actionError}
            </div>
          )}
          {deleteFailures.length > 0 && (
            <div role="alert" style={{ padding: 10, marginBottom: 10, border: "1px solid rgba(239,68,68,.35)", borderRadius: 6, color: "#ef4444" }}>
              {t("sessionsManager.deleteFailures", { count: deleteFailures.length })}
            </div>
          )}
          {notice && <div role="status" style={{ padding: "7px 10px", marginBottom: 10, borderRadius: 5, background: "var(--bg-panel)", color: "var(--text)" }}>{notice}</div>}
          {deleteWarnings.length > 0 && (
            <ul aria-label={t("sessionsManager.warnings")} style={{ margin: "0 0 10px", padding: "8px 10px 8px 28px", color: "var(--text-dim)", fontSize: 11 }}>
              {deleteWarnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
            </ul>
          )}

          {!catalogLoaded && (catalogLoading || !catalogError) && <div style={{ padding: 20, color: "var(--text-dim)", textAlign: "center" }}>{t("sessionsManager.loadingCatalog")}</div>}
          {catalogLoaded && filteredSessions.length === 0 && (
            <div style={{ padding: 24, color: "var(--text-dim)", textAlign: "center" }}>
              {query.trim() ? t("sessionsManager.noMatches") : t("sessionsManager.noSessions")}
            </div>
          )}

          {filteredSessions.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 9 }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-dim)", fontSize: 11 }}>
                  <input type="checkbox" aria-label={t("sessionsManager.selectVisible")} checked={isAllVisibleSelected} onChange={(event) => toggleAllVisible(event.target.checked)} disabled={controlsBusy} />
                  {t("sessionsManager.selectVisible")}
                </label>
                <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("sessionsManager.selectedCount", { count: selectedVisibleSessions.length })}</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginLeft: "auto" }}>
                  {selectedActiveIds.length > 0 && <button type="button" style={buttonStyle} disabled={!canMutate} onClick={() => void applyAction({ type: "sessions", ids: selectedActiveIds, status: "archived" })}>{t("sessionsManager.archiveSelected", { count: selectedActiveIds.length })}</button>}
                  {selectedArchivedIds.length > 0 && <button type="button" style={buttonStyle} disabled={!canMutate} onClick={() => void applyAction({ type: "sessions", ids: selectedArchivedIds, status: "active", restoreProjects: [...new Set(selectedVisibleSessions.filter((session) => selectedArchivedIds.includes(session.id)).map(workspaceKeyOf))] })}>{t("sessionsManager.restoreSelected", { count: selectedArchivedIds.length })}</button>}
                </div>
              </div>

              <div role="list" aria-label={t("sessionsManager.sessionList")} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {filteredSessions.map((session) => {
                  const managed = managedSessionState(managementState, session.id);
                  const status = managed.status === "archived" ? "archived" : "active";
                  const title = sessionTitle(session);
                  const projectKey = workspaceKeyOf(session);
                  const projectLabel = projectInfo.get(projectKey)?.label ?? projectKey;
                  const failure = deleteFailures.find((item) => item.id === session.id);
                  const relationKind = session.relation?.kind;
                  return (
                    <article key={session.id} role="listitem" style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)" }}>
                      <input
                        type="checkbox"
                        aria-label={t("sessionsManager.selectSession", { title })}
                        checked={selectedIds.includes(session.id)}
                        onChange={(event) => toggleSessionSelection(session.id, event.target.checked)}
                        disabled={controlsBusy}
                      />
                      <div style={{ minWidth: 0, flex: "1 1 auto" }}>
                        <div title={title} style={{ color: "var(--text)", fontSize: 12, fontWeight: 550, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
                        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5, marginTop: 4, color: "var(--text-dim)", fontSize: 10 }}>
                          <span title={projectKey} style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{projectLabel}</span>
                          <span>· {t("sessionsManager.messageCount", { count: session.messageCount ?? 0 })}</span>
                          {session.modified && <span>· {readableTime(session.modified, locale)}</span>}
                          {session.transient && <span>· {t("sessionsManager.transient")}</span>}
                          {relationKind === "subagent" && <span>· {t("sessionsManager.subagent")}{session.relation?.kind === "subagent" && session.relation.profile ? ` (${session.relation.profile})` : ""}</span>}
                          {relationKind === "fork" && <span>· {t("sessionsManager.fork")}</span>}
                          {failure && <span role="alert" style={{ flexBasis: "100%", color: "#ef4444" }}>{failure.running ? `${t("sessionsManager.runningRefusal")} ` : ""}{failure.error}</span>}
                        </div>
                      </div>
                      <span style={{ flexShrink: 0, padding: "3px 6px", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text-dim)", fontSize: 10 }}>{t(`sessionsManager.status.${status}`)}</span>
                      {managed.pinned && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sessionsManager.pinned")}</span>}
                      <div style={{ display: "flex", flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end", gap: 5 }}>
                        {onSelectSession && <button type="button" style={buttonStyle} disabled={controlsBusy} onClick={() => onSelectSession(session)}>{t("sessionsManager.open")}</button>}
                        <button type="button" style={buttonStyle} disabled={!canMutate || status === "archived"} onClick={() => togglePinned(session)}>{managed.pinned ? t("sessionsManager.unpin") : t("sessionsManager.pin")}</button>
                        <button type="button" style={buttonStyle} disabled={!canMutate} onClick={() => setSessionStatus(session, status === "archived" ? "active" : "archived")}>
                          {status === "archived" ? t("sessionsManager.restore") : t("sessionsManager.archive")}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </main>

        <section aria-label={t("sessionsManager.dangerZone")} style={{ padding: "12px 18px", borderTop: "1px solid rgba(239,68,68,.35)", background: "rgba(239,68,68,.035)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ color: "#ef4444", fontSize: 12, fontWeight: 650 }}>{t("sessionsManager.dangerZone")}</div>
              <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 10 }}>{t("sessionsManager.dangerDescription")}</div>
            </div>
            <button
              type="button"
              disabled={!canMutate || selectedVisibleSessions.length === 0}
              onClick={beginDeleteConfirmation}
              style={{ ...buttonStyle, borderColor: "rgba(239,68,68,.5)", color: "#ef4444", opacity: !canMutate || selectedVisibleSessions.length === 0 ? 0.55 : 1 }}
            >
              {dangerButtonLabel}
            </button>
          </div>
        </section>

        {!embedded && <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 18px", borderTop: "1px solid var(--border)" }}><ConfigButton onClick={onClose}>{t("sessionsManager.close")}</ConfigButton></div>}
      </div>

      {deleteConfirmation && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="sessions-manager-delete-title" style={{ position: "fixed", inset: 0, zIndex: 10000, display: "grid", placeItems: "center", padding: 20, background: "rgba(0,0,0,.55)" }}>
          <div style={{ width: "min(520px, 100%)", maxHeight: "80vh", overflow: "auto", padding: 18, border: "1px solid rgba(239,68,68,.5)", borderRadius: 9, background: "var(--bg)", boxShadow: "0 16px 48px rgba(0,0,0,.35)" }}>
            <h2 id="sessions-manager-delete-title" style={{ margin: "0 0 10px", color: "#ef4444", fontSize: 15 }}>{t("sessionsManager.deleteConfirmTitle", { count: deleteConfirmation.ids.length })}</h2>
            <p style={{ margin: "0 0 8px", color: "var(--text)", fontSize: 12 }}>{t("sessionsManager.deleteConfirmBody", { count: deleteConfirmation.ids.length })}</p>
            <ul style={{ maxHeight: 100, overflow: "auto", paddingLeft: 22, color: "var(--text-dim)", fontSize: 11 }}>
              {deleteConfirmation.ids.map((id) => {
                const session = sessions.find((item) => item.id === id);
                return <li key={id}>{session ? sessionTitle(session) : id}</li>;
              })}
            </ul>
            <p style={{ margin: "8px 0", color: "var(--text-dim)", fontSize: 11 }}>{t("sessionsManager.deleteProjectFiles")}</p>
            <p style={{ margin: "8px 0 16px", color: "var(--text-dim)", fontSize: 11 }}>{t("sessionsManager.deleteChildren")}</p>
            {actionError && <div role="alert" style={{ marginBottom: 12, color: "#ef4444", fontSize: 11 }}>{t("sessionsManager.actionError")}: {actionError}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 7 }}>
              <button type="button" style={buttonStyle} disabled={operationBusy} onClick={() => setDeleteConfirmation(null)}>{t("sessionsManager.cancel")}</button>
              <button type="button" disabled={operationBusy || !canMutate} onClick={() => void confirmDeletion()} style={{ ...buttonStyle, borderColor: "rgba(239,68,68,.55)", background: "#b91c1c", color: "white", opacity: operationBusy || !canMutate ? 0.55 : 1 }}>
                {operationBusy ? t("sessionsManager.deleting") : t("sessionsManager.confirmDelete", { count: deleteConfirmation.ids.length })}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfigPanelShell>
  );
}
