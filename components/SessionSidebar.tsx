"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { listSessionFamilies, type SessionFamily } from "@/lib/session-family";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { orderFamiliesWithPinned } from "@/lib/pinned-sessions";
import { useSessionManagement } from "@/hooks/useSessionManagement";
import { SESSION_CATALOG_CHANGED_EVENT } from "@/lib/session-management-client";
import {
  OPEN_SESSION_MANAGEMENT_EVENT,
  emptySessionManagementState,
  type OpenSessionManagementDetail,
  type SessionManagementAction,
} from "@/lib/session-management-types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { getProjectActivity, getRecentProjects } from "@/lib/project-groups";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { formatRelativeTime } from "@/lib/i18n/format";
import { getFileName } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";
import { DirectoryPicker } from "./DirectoryPicker";
import { isDesktopApp } from "@/lib/desktop";
import type { RunningTaskPhase } from "./RunningTasksPanel";

// Fixed row heights for the sidebar list. Every row renders at exactly its
// declared height, so the list can be windowed (only the visible slice is
// mounted) over a flat model of project headers, session rows and
// expand/empty rows.
const SESSION_LIST_ITEM_HEIGHT = 34;
const PROJECT_HEADER_HEIGHT = 34;
const PROJECT_EMPTY_HEIGHT = 28;
const SHOW_MORE_HEIGHT = 30;
const PROJECT_TRAILING_HEIGHT = 4;
const VIRTUAL_OVERSCAN_PX = SESSION_LIST_ITEM_HEIGHT * 8;

export interface SidebarVirtualRow {
  key: string;
  top: number;
  height: number;
}

/**
 * Windowed rendering over rows with mixed heights: binary-search the first
 * row intersecting [scrollTop - overscan, scrollTop + viewport + overscan],
 * mount that slice, and keep the pinned (focused) row mounted so scrolling
 * cannot discard an inline rename.
 */
export function getVisibleRowIndices(
  rows: readonly SidebarVirtualRow[],
  scrollTop: number,
  viewportHeight: number,
  pinnedKey?: string | null,
): number[] {
  if (rows.length === 0) return [];
  const totalHeight = rows[rows.length - 1].top + rows[rows.length - 1].height;
  const clampedScrollTop = Math.min(scrollTop, Math.max(0, totalHeight - (viewportHeight || 600)));
  const lower = Math.max(0, clampedScrollTop - VIRTUAL_OVERSCAN_PX);
  const upper = clampedScrollTop + (viewportHeight || 600) + VIRTUAL_OVERSCAN_PX;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top + rows[mid].height <= lower) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  const indices: number[] = [];
  let pinnedIndex = -1;
  for (let i = start; i < rows.length; i++) {
    if (rows[i].top >= upper) break;
    if (pinnedKey && rows[i].key === pinnedKey) pinnedIndex = indices.length;
    indices.push(i);
  }
  if (pinnedKey && pinnedIndex === -1) {
    const pinned = rows.findIndex((row) => row.key === pinnedKey);
    if (pinned >= 0) {
      const position = indices.findIndex((i) => i > pinned);
      if (position === -1) indices.push(pinned);
      else indices.splice(position, 0, pinned);
    }
  }
  return indices;
}

type SidebarRow = SidebarVirtualRow & (
  | { kind: "project"; project: { key: string; root: string }; isCollapsed: boolean }
  | { kind: "session"; family: SessionFamily; projectKey: string }
  | { kind: "empty"; projectKey: string }
  | { kind: "more"; projectKey: string; expanded: boolean }
);

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean, entryId?: string) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  selectedCwd?: string | null;
  onCwdChange?: (
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => void;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Fired when a session that is not currently selected finishes running.
   *  Lets the app play a cross-workspace completion tone. */
  onBackgroundTaskDone?: (sessionIds: string[]) => void;
  onRunningSessionIdsChange?: (ids: Set<string>, phases: Record<string, RunningTaskPhase>) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
  onToggleSidebar?: () => void;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  /** Stable server-computed identity; never derive OS path semantics here. */
  projectKey: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

interface ProjectSelection {
  root: string;
  key: string;
}

interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";
const RUNNING_SESSIONS_POLL_MS = 2500;

function loadLastCustomCwd(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastCustomCwd(cwd: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CUSTOM_CWD_STORAGE_KEY, cwd);
  } catch {
    // Persistence is best-effort.
  }
}

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}



function PiWebTitle() {
  return (
    <div className="kimi-sidebar-brand" data-tauri-drag-region title={`Pi Web ${process.env.NEXT_PUBLIC_APP_VERSION ?? ""}`}>
      <span className="kimi-sidebar-brand-mark pi-brand-logo">
        <svg width="22" height="22" viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <rect width="48" height="48" rx="12" fill="var(--bg)" stroke="var(--border)" strokeWidth="2.4" />
          <path
            d="M14 16h20M19 16v18M29 16v18c0 2 2 3 4 2"
            stroke="var(--accent)"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span>Pi Web</span>
    </div>
  );
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, selectedCwd: selectedCwdProp, onCwdChange, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionsChange, onToggleSidebar }: Props) {
  const { t } = useI18n();
  const management = useSessionManagement();
  const { ready: managementReady, update: updateManagement } = management;
  const managementState = useMemo(() => management.state ?? emptySessionManagementState(), [management.state]);
  const [managementBusy, setManagementBusy] = useState(false);
  const [managementActionError, setManagementActionError] = useState<string | null>(null);
  const managementBusyRef = useRef(false);
  const pinnedSessionIds = useMemo(() => new Set(Object.entries(managementState.sessions)
    .filter(([, state]) => state.status === "active" && state.pinned).map(([id]) => id)), [managementState]);
  const archivedSessionIds = useMemo(() => new Set(Object.entries(managementState.sessions)
    .filter(([, state]) => state.status === "archived").map(([id]) => id)), [managementState]);
  const removedProjects = useMemo(() => new Set(Object.entries(managementState.projects)
    .filter(([, state]) => state.removed).map(([key]) => key)), [managementState]);
  const runManagementAction = useCallback(async (action: SessionManagementAction) => {
    if (!managementReady || managementBusyRef.current) return;
    managementBusyRef.current = true;
    setManagementBusy(true);
    setManagementActionError(null);
    try { await updateManagement(action); }
    catch (cause) { setManagementActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { managementBusyRef.current = false; setManagementBusy(false); }
  }, [managementReady, updateManagement]);
  const openSessionManagement = useCallback((detail: OpenSessionManagementDetail) => {
    window.dispatchEvent(new CustomEvent(OPEN_SESSION_MANAGEMENT_EVENT, { detail }));
  }, []);
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const deletedSessionIdsRef = useRef(new Set<string>());
  const visibleSearchSessionIds = useMemo(() => new Set(listSessionFamilies(allSessions)
    .filter((family) => !archivedSessionIds.has(family.root.id) && !removedProjects.has(workspaceKeyOf(family.root)))
    .flatMap((family) => [family.root, ...family.subagents]).filter((session) => !archivedSessionIds.has(session.id)).map((session) => session.id)),
  [allSessions, archivedSessionIds, removedProjects]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [wtFilter, setWtFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [contentMatches, setContentMatches] = useState<{ sessionId: string; entryId: string; turnEntryId: string; role: string; snippet: string }[]>([]);
  const [contentSearchBusy, setContentSearchBusy] = useState(false);
  const [contentSearchError, setContentSearchError] = useState(false);
  const [contentSearchPartial, setContentSearchPartial] = useState(false);
  useEffect(() => {
    const q = sessionSearch.trim();
    if (q.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setContentSearchBusy(true);
      setContentSearchError(false);
      try {
        const response = await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { results: typeof contentMatches; truncated?: boolean; partial?: boolean };
        if (!controller.signal.aborted) {
          setContentMatches(data.results);
          setContentSearchPartial(Boolean(data.truncated || data.partial));
        }
      } catch {
        if (!controller.signal.aborted) setContentSearchError(true);
      } finally {
        if (!controller.signal.aborted) setContentSearchBusy(false);
      }
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [sessionSearch]);
  const [expandedProjectSessions, setExpandedProjectSessions] = useState<Set<string>>(() => new Set());
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [listMenuOpen, setListMenuOpen] = useState(false);
  const listMenuRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importBusy, setImportBusy] = useState(false);

  useEffect(() => {
    if (!listMenuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (listMenuRef.current && !listMenuRef.current.contains(e.target as Node)) {
        setListMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [listMenuOpen]);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [runningSessionPhases, setRunningSessionPhases] = useState<Record<string, RunningTaskPhase>>({});
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Virtualized session list: only the visible window of rows is mounted.
  const listScrollRef = useRef<HTMLDivElement>(null);
  const [listViewportH, setListViewportH] = useState(0);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const listScrollRafRef = useRef<number | null>(null);
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    if (listScrollRafRef.current != null) return;
    listScrollRafRef.current = requestAnimationFrame(() => {
      listScrollRafRef.current = null;
      setListScrollTop(top);
    });
  }, []);
  useLayoutEffect(() => {
    const el = listScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setListViewportH(entry.contentRect.height);
    });
    ro.observe(el);
    setListViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const loadSessions = useCallback(async (showLoading = false, force = false): Promise<SessionInfo[]> => {
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(force ? "/api/sessions?force=1" : "/api/sessions", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        sessions: SessionInfo[];
        runningSessionIds?: string[];
        completionNotificationSuppressedSessionIds?: string[];
      };
      const loadedSessions = data.sessions.filter((session) => !deletedSessionIdsRef.current.has(session.id));
      setAllSessions(loadedSessions);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop markers for deleted sessions and for subagents, whose completion
      // is intentionally silent even if an older client marked them unread.
      const unreadEligibleIds = new Set(
        loadedSessions
          .filter((session) => session.relation?.kind !== "subagent")
          .map((session) => session.id),
      );
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => unreadEligibleIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
      return loadedSessions;
    } catch (e) {
      setError(String(e));
      return [];
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onCatalogChanged = (event: Event) => {
      const ids = (event as CustomEvent<{ deletedIds: string[] }>).detail?.deletedIds;
      if (!Array.isArray(ids)) return;
      ids.forEach((id) => deletedSessionIdsRef.current.add(id));
      setAllSessions((current) => current.filter((session) => !deletedSessionIdsRef.current.has(session.id)));
      setRunningSessionIds((current) => new Set([...current].filter((id) => !deletedSessionIdsRef.current.has(id))));
      setUnreadSessionIds((current) => new Set([...current].filter((id) => !deletedSessionIdsRef.current.has(id))));
    };
    window.addEventListener(SESSION_CATALOG_CHANGED_EVENT, onCatalogChanged);
    return () => window.removeEventListener(SESSION_CATALOG_CHANGED_EVENT, onCatalogChanged);
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst, !isFirst);
  }, [loadSessions, refreshKey]);

  useEffect(() => () => {
    if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
  }, []);


  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    let stopped = false;
    // The Desktop window keeps running in the tray; continue polling there so
    // background completions can trigger native notifications.
    const desktop = isDesktopApp();
    const shouldPoll = () => desktop || document.visibilityState === "visible";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || !shouldPoll()) return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || !shouldPoll()) return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as {
          runningSessionIds?: string[];
          runningSessionPhases?: Record<string, RunningTaskPhase>;
          completionNotificationSuppressedSessionIds?: string[];
        };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
        setRunningSessionPhases(data.runningSessionPhases ?? {});
      } catch {
        // Keep the last known state; the next permitted poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (shouldPoll()) {
        if (!desktop) void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds, runningSessionPhases);
  }, [onRunningSessionIdsChange, runningSessionIds, runningSessionPhases]);

  useEffect(() => {
    onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const knownSubagentIds = new Set(
      allSessions
        .filter((session) => session.relation?.kind === "subagent")
        .map((session) => session.id),
    );
    const completedWithNotifications = completedInBackground.filter(
      (id) => !previousSuppressedCompletionSessionIdsRef.current.has(id) && !knownSubagentIds.has(id) && !deletedSessionIdsRef.current.has(id),
    );
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedWithNotifications.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningSessionIds.forEach((id) => next.delete(id));
        completedWithNotifications.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      loadSessions(false, true);
    }
    if (completedWithNotifications.length > 0) {
      onBackgroundTaskDone?.(completedWithNotifications);
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
    previousSuppressedCompletionSessionIdsRef.current = new Set(
      [...runningSessionIds].filter(
        (id) => currentSuppressedCompletionSessionIdsRef.current.has(id) || knownSubagentIds.has(id),
      ),
    );
  }, [runningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);


  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  const projectSelection = useCallback((root: string, key: string): ProjectSelection => ({
    root,
    key,
  }), []);

  /** Resolve both display root and stable identity from server-provided data. */
  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    // /api/cwd/validate resolves identity before a custom path becomes active,
    // preventing one render with a raw path key from looking like a switch.
    if (validatedProject?.cwd === cwd) {
      return projectSelection(validatedProject.root, validatedProject.key);
    }
    if (worktreeState && worktreeState.forCwd === cwd) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    return match
      ? projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match))
      : projectSelection(cwd, cwd);
  }, [validatedProject, worktreeState, allSessions, projectSelection]);

  // A worktree/session refresh can hydrate the stable key without changing
  // cwd, so notify when either changes. The parent treats same-cwd key changes
  // as identity hydration rather than a workspace switch.
  const lastNotifiedProjectRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    const project = projectFor(selectedCwd);
    const previous = lastNotifiedProjectRef.current;
    if (previous?.cwd === selectedCwd && previous.key === (project?.key ?? null)) return;
    lastNotifiedProjectRef.current = { cwd: selectedCwd, key: project?.key ?? null };
    onCwdChange?.(
      selectedCwd,
      project?.root ?? null,
      project?.key ?? null,
    );
  }, [selectedCwd, onCwdChange, projectFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          projectKey: d.projectKey ?? d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
      });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) setSelectedCwd(projects[0].root);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);

  // Prefer an exact UI selection while a refetch is in flight. Once the
  // response catches up, the server-resolved path handles Windows case and
  // separator differences without teaching the browser OS path semantics.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        error?: string;
      };
      if (!res.ok || data.error || !data.cwd || !data.projectRoot || !data.projectKey) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setValidatedProject({
        cwd: data.cwd,
        root: data.projectRoot,
        key: data.projectKey,
      });
      saveLastCustomCwd(data.cwd);
      setCustomPathValue(data.cwd);
      setSelectedCwd(data.cwd);
      setCustomPathOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
  }, []);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      // Optimistically register the new worktree so projectFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        currentWorktreePath: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch, isMain: false }],
      } : prev);
      setSelectedCwd(data.path);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtConfirmRemove(null);
      if (currentWorktreePath === path) setSelectedCwd(worktreeState.projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [worktreeState, wtBusy, currentWorktreePath]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewBranch("");
        setWtError(null);
        setWtConfirmRemove(null);
        setWtFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo, entryId?: string) => {
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s, false, entryId);
  }, [onSelectSession]);

  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [projectMenu, setProjectMenu] = useState<{ key: string; root: string; x: number; y: number } | null>(null);
  const [sessionMenu, setSessionMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const rowActionsRef = useRef(new Map<string, SessionRowActions>());
  const registerSessionRowActions = useCallback((id: string, actions: SessionRowActions | null) => {
    const map = rowActionsRef.current;
    if (actions) map.set(id, actions);
    else map.delete(id);
  }, []);

  const handleTogglePinSession = useCallback((sessionId: string) => {
    void runManagementAction({ type: "sessions", ids: [sessionId], pinned: !pinnedSessionIds.has(sessionId) });
  }, [runManagementAction, pinnedSessionIds]);

  const handleArchiveSession = useCallback((sessionId: string) => {
    // Archive affects presentation only: don't close the chat or stop a run.
    void runManagementAction({ type: "sessions", ids: [sessionId], status: "archived" });
  }, [runManagementAction]);

  const handleRemoveProject = useCallback((projectKey: string, root: string) => {
    // Removing an entry never archives/deletes its sessions or closes a chat.
    void runManagementAction({ type: "project", key: projectKey, root, removed: true });
  }, [runManagementAction]);

  const handleArchiveProject = useCallback((projectKey: string) => {
    const ids = allSessions.filter((session) => workspaceKeyOf(session) === projectKey
      && !session.transient && !archivedSessionIds.has(session.id)).map((session) => session.id);
    if (ids.length) void runManagementAction({ type: "sessions", ids, status: "archived" });
  }, [allSessions, archivedSessionIds, runManagementAction]);

  const handleCopyProjectPath = useCallback(async (root: string) => {
    setProjectMenu(null);
    try {
      await navigator.clipboard.writeText(root);
    } catch {}
  }, []);

  const toggleProjectCollapse = useCallback((key: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const startNewSessionForCwd = useCallback((cwd: string) => {
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    setSelectedCwd(cwd);
    onNewSession?.(tempId, cwd);
  }, [onNewSession]);

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    startNewSessionForCwd(selectedCwd);
  }, [selectedCwd, startNewSessionForCwd]);

  // Import a pi session export (.jsonl) into the store, then open it.
  const handleImportSessionFile = useCallback(async (file: File) => {
    setImportBusy(true);
    setError(null);
    try {
      const params = selectedCwd ? `?cwd=${encodeURIComponent(selectedCwd)}` : "";
      const res = await fetch(`/api/sessions/import${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson" },
        body: file,
      });
      const data = await res.json().catch(() => ({})) as { sessionId?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await loadSessions(false, true).then((sessions) => {
        const imported = sessions.find((session) => session.id === data.sessionId);
        if (imported) onSelectSession(imported);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImportBusy(false);
    }
  }, [selectedCwd, loadSessions, onSelectSession]);

  const recentProjects = useMemo(() => getRecentProjects(allSessions), [allSessions]);

  // Sessions of every worktree in the selected project are shown together
  const selectedProject = useMemo(() => projectFor(selectedCwd), [projectFor, selectedCwd]);

  const allProjects = useMemo(() => {
    const list = [...recentProjects];
    if (selectedProject && !list.some((p) => p.key === selectedProject.key)) {
      list.unshift({ key: selectedProject.key, root: selectedProject.root });
    }
    return list.filter((p) => !removedProjects.has(p.key));
  }, [recentProjects, selectedProject, removedProjects]);

  // Per-project activity counts (running / unread) for the workspace selector.
  // Uses the same stable server key as the project list and filtering.
  const projectActivity = useMemo(
    () => getProjectActivity(allSessions, runningSessionIds, unreadSessionIds),
    [allSessions, runningSessionIds, unreadSessionIds],
  );

  const sessionsByProject = useMemo(() => {
    const byProject = new Map<string, SessionInfo[]>();
    for (const session of allSessions) {
      const key = workspaceKeyOf(session);
      const sessions = byProject.get(key);
      if (sessions) sessions.push(session);
      else byProject.set(key, [session]);
    }
    return byProject;
  }, [allSessions]);
  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject?.key === worktreeState.projectKey
  );
  const worktreeGuide = selectedCwd
    && worktreeState
    && selectedProject?.key === worktreeState.projectKey
    && !showWorktreeSwitcher
    ? (worktreeState.isGit
        ? {
             label: t("sidebar.openRepoRoot"),
             title: t("sidebar.openRepoRootTitle"),
          }
        : {
             label: t("sidebar.gitRepoRootOnly"),
             title: t("sidebar.gitRepoRootOnlyTitle"),
          })
    : null;
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd);
  const inactiveWorktreeSelector = worktreeGuide
    ?? (worktreeLoading && !showWorktreeSwitcher
      ? {
           label: t("sidebar.worktrees"),
           title: t("sidebar.checkingWorktrees"),
        }
      : null);

  // Flat row model for the windowed list: project headers, session rows and
  // expand/empty rows laid out with cumulative tops (see #626; adapted to the
  // fork's project-grouped sidebar).
  const sidebarRows = useMemo(() => {
    // Until legacy migration is acknowledged, never reveal old hidden rows.
    if (!managementReady) return { rows: [] as SidebarRow[], totalHeight: 0 };
    const rows: SidebarRow[] = [];
    let top = 0;
    const q = sessionSearch.trim().toLowerCase();
    for (const project of allProjects) {
      const isCollapsed = collapsedProjects.has(project.key);
      const projectSessions = sessionsByProject.get(project.key) ?? [];
      const projectFamilies = listSessionFamilies(projectSessions);
      const visibleProjectFamilies = orderFamiliesWithPinned(
        (q
          ? projectFamilies.filter((family) => {
              const familySessions = [family.root, ...family.subagents];
              return familySessions.some((s) => {
                const name = (s.name ?? "").toLowerCase();
                const firstMsg = (s.firstMessage ?? "").toLowerCase();
                const id = s.id.toLowerCase();
                return name.includes(q) || firstMsg.includes(q) || id.includes(q);
              });
            })
          : projectFamilies
        ).filter((family) => !archivedSessionIds.has(family.root.id)),
        pinnedSessionIds,
      );
      if (q && visibleProjectFamilies.length === 0) continue;
      rows.push({ kind: "project", key: `project:${project.key}`, top, height: PROJECT_HEADER_HEIGHT, project, isCollapsed });
      top += PROJECT_HEADER_HEIGHT;
      if (!isCollapsed) {
        if (visibleProjectFamilies.length === 0) {
          rows.push({ kind: "empty", key: `empty:${project.key}`, top, height: PROJECT_EMPTY_HEIGHT, projectKey: project.key });
          top += PROJECT_EMPTY_HEIGHT;
        } else {
          const expanded = q !== "" || expandedProjectSessions.has(project.key);
          const shown = expanded ? visibleProjectFamilies : visibleProjectFamilies.slice(0, 6);
          for (const family of shown) {
            rows.push({ kind: "session", key: `session:${family.root.id}`, top, height: SESSION_LIST_ITEM_HEIGHT, family, projectKey: project.key });
            top += SESSION_LIST_ITEM_HEIGHT;
          }
          if (!q && visibleProjectFamilies.length > 6) {
            rows.push({ kind: "more", key: `more:${project.key}`, top, height: SHOW_MORE_HEIGHT, projectKey: project.key, expanded });
            top += SHOW_MORE_HEIGHT;
          }
        }
      }
      top += PROJECT_TRAILING_HEIGHT;
    }
    return { rows, totalHeight: top };
  }, [allProjects, collapsedProjects, sessionsByProject, sessionSearch, expandedProjectSessions, pinnedSessionIds, archivedSessionIds, managementReady]);

  const visibleRowIndices = getVisibleRowIndices(sidebarRows.rows, listScrollTop, listViewportH, focusedRowKey);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {customPathOpen && (
        <DirectoryPicker
          initialPath={customPathValue}
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      {/* Header */}
      <div
        style={{
          padding: "13px 12px 7px",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 13 }}>
          <PiWebTitle />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => onToggleSidebar ? onToggleSidebar() : loadSessions(false, true)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: sessionRefreshDone ? "rgba(74,222,128,0.14)" : "transparent",
                border: "none",
                color: sessionRefreshDone ? "#4ade80" : "var(--text-muted)",
                cursor: "pointer",
                width: 28, height: 28,
                borderRadius: 6,
                padding: 0,
                flexShrink: 0,
                transition: "background 0.3s, color 0.3s, border-color 0.3s",
              }}
              onMouseEnter={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text)";
              }}
              onMouseLeave={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
               title={onToggleSidebar ? t("sidebar.hide") : t("sidebar.refresh")}
            >
              {onToggleSidebar ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <line x1="9" y1="4" x2="9" y2="20" />
                </svg>
              ) : sessionRefreshDone ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Actions row: New Session + Open Folder */}
        <div style={{ display: "flex", gap: 4, marginBottom: 3 }}>
          <button
            onClick={handleNewSession}
            disabled={!selectedCwd}
            title={selectedCwd ? t("sidebar.newSessionTitle", { path: selectedCwd }) : t("sidebar.selectProject")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flex: 1,
              height: 34,
              padding: "0 8px",
              background: "transparent",
              color: selectedCwd ? "var(--text)" : "var(--text-dim)",
              border: "none",
              borderRadius: 7,
              fontSize: 13,
              fontWeight: 400,
              cursor: selectedCwd ? "pointer" : "not-allowed",
              transition: "all 0.15s ease",
            }}
            onMouseEnter={(e) => {
              if (selectedCwd) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
              <span>{t("sidebar.newSession") || t("sidebar.new")}</span>
            </div>
            <span style={{
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              opacity: 0.55,
              lineHeight: 1.2,
            }}>
              {typeof navigator !== "undefined" && navigator.platform?.toUpperCase().includes("MAC") ? "⌘N" : "Ctrl+N"}
            </span>
          </button>
          <button
            onClick={handleCustomPathClick}
            title={t("sidebar.openDirectory")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 34,
              height: 34,
              background: "transparent",
              border: "none",
              borderRadius: 7,
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
              transition: "all 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
              <line x1="12" y1="10" x2="12" y2="16" />
              <line x1="9" y1="13" x2="15" y2="13" />
            </svg>
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".jsonl,application/x-ndjson,application/jsonl,text/plain"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleImportSessionFile(file);
            }}
          />
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={importBusy}
            title={t("sidebar.importSession")}
            aria-label={t("sidebar.importSession")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 34,
              height: 34,
              background: "transparent",
              border: "none",
              borderRadius: 7,
              color: "var(--text-muted)",
              cursor: importBusy ? "wait" : "pointer",
              flexShrink: 0,
              opacity: importBusy ? 0.5 : 1,
              transition: "all 0.15s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>

        {/* Session Search Input */}
        <div style={{ position: "relative", marginBottom: 5 }}>
          <svg style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none" }} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={sessionSearch}
            onChange={(e) => { setSessionSearch(e.target.value); setContentMatches([]); setContentSearchBusy(false); setContentSearchPartial(false); }}
            placeholder={t("sidebar.searchSessions")}
            style={{
              width: "100%",
              height: 34,
              paddingLeft: 28,
              paddingRight: sessionSearch ? 24 : 8,
              background: "transparent",
              border: "1px solid transparent",
              borderRadius: 7,
              fontSize: 13,
              color: "var(--text)",
              outline: "none",
              boxSizing: "border-box",
              transition: "border-color 0.15s ease",
            }}
            onFocus={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
            onBlur={(e) => { e.currentTarget.style.background = "transparent"; }}
          />
          {sessionSearch && (
            <button
              onClick={() => setSessionSearch("")}
              style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", border: "none", background: "transparent", color: "var(--text-dim)", cursor: "pointer", padding: 2, display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              ✕
            </button>
          )}
        </div>

        {sessionSearch.trim().length >= 2 && (
          <div aria-live="polite" style={{ margin: "4px 0 8px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ padding: "5px 9px", color: "var(--text-muted)", fontSize: 11 }}>
              {t("sidebar.contentMatches")}{contentSearchBusy ? ` · ${t("sidebar.searchingFiles")}` : ""}
              {contentSearchPartial ? ` · ${t("sidebar.searchPartial")}` : ""}
              {contentSearchError ? ` · ${t("sidebar.searchFailed")}` : ""}
            </div>
            {!contentSearchBusy && !contentSearchError && contentMatches.length === 0 && (
              <div style={{ padding: "4px 9px 9px", color: "var(--text-dim)", fontSize: 11 }}>{t("sidebar.noContentMatches")}</div>
            )}
            {contentMatches.filter((match) => managementReady && visibleSearchSessionIds.has(match.sessionId)).map((match) => {
              const found = allSessions.find((s) => s.id === match.sessionId);
              if (!found || removedProjects.has(workspaceKeyOf(found))) return null;
              return (
                <button key={`${match.sessionId}:${match.entryId}`} type="button"
                  onClick={() => handleSelectSessionFromList(found, match.turnEntryId || match.entryId)}
                  style={{ display: "block", width: "100%", padding: "7px 9px", border: 0, borderRadius: 5, background: "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                  <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--text-muted)" }}>{found.name || found.firstMessage || found.id}</span>
                  <span style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", fontSize: 12, overflowWrap: "anywhere" }}>{match.snippet}</span>
                </button>
              );
            })}
          </div>
        )}

        {showWorktreeSwitcher && worktreeState && (() => {
          const showFilter = worktreeState.worktrees.length >= 8;
          const visibleWorktrees = showFilter && wtFilter.trim()
            ? worktreeState.worktrees.filter((worktree) => (
                worktree.branch ?? displayCwd(worktree.path, homeDir)
              ).toLowerCase().includes(wtFilter.trim().toLowerCase()))
            : worktreeState.worktrees;
          return (
            <div ref={wtDropdownRef} style={{ position: "relative", marginTop: 5 }}>
              <button
                type="button"
                aria-expanded={wtDropdownOpen}
                onClick={() => setWtDropdownOpen((open) => !open)}
                title={currentWorktree ? t("sidebar.switchWorktreeTitle", { path: currentWorktree.path }) : t("sidebar.switchWorktree")}
                style={{ width: "100%", height: 30, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 6, padding: "0 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 7, cursor: "pointer", fontSize: 11, color: "var(--text-muted)", textAlign: "left" }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: currentWorktree && !currentWorktree.isMain ? "var(--accent)" : "var(--text-dim)" }}>
                  <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <PathLabel text={currentWorktree ? (currentWorktree.branch ?? displayCwd(currentWorktree.path, homeDir)) : "…"} style={{ flex: 1, fontFamily: "var(--font-mono)", color: "var(--text)" }} />
                {currentWorktree?.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>}
                {worktreeState.worktrees.length > 1 && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{worktreeState.worktrees.length}</span>}
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="2 3.5 5 6.5 8 3.5" /></svg>
              </button>

              <AnimatedDropdown
                open={wtDropdownOpen}
                style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.16)", overflow: "hidden" }}
              >
                {showFilter && (
                  <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                    <input
                      value={wtFilter}
                      onChange={(event) => setWtFilter(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setWtFilter("");
                          setWtDropdownOpen(false);
                        }
                      }}
                      placeholder={t("sidebar.filterWorktrees")}
                      aria-label={t("sidebar.filterWorktrees")}
                      style={{ width: "100%", boxSizing: "border-box", padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11 }}
                    />
                  </div>
                )}
                <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
                  {visibleWorktrees.map((worktree) => {
                    const isCurrent = worktree.path === currentWorktreePath;
                    return (
                      <div key={worktree.path} style={{ borderBottom: "1px solid var(--border)" }}>
                        {wtConfirmRemove === worktree.path ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 8px", background: "rgba(239,68,68,0.06)" }}>
                            <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("sidebar.forceRemoveCheckout")}</span>
                            <button type="button" onClick={() => void handleRemoveWorktree(worktree.path, true)} disabled={wtBusy} style={{ padding: "3px 8px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, cursor: wtBusy ? "wait" : "pointer" }}>{t("sidebar.force")}</button>
                            <button type="button" onClick={() => setWtConfirmRemove(null)} style={{ padding: "3px 8px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}>{t("sidebar.cancel")}</button>
                          </div>
                        ) : (
                          <div style={{ display: "flex", alignItems: "center" }}>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedCwd(worktree.path);
                                setWtDropdownOpen(false);
                                setWtError(null);
                                setWtFilter("");
                              }}
                              title={worktree.path}
                              style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 7, padding: "8px 10px", background: "none", border: "none", color: isCurrent ? "var(--text)" : "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11, fontFamily: "var(--font-mono)" }}
                            >
                              {isCurrent ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg> : <span style={{ width: 10, flexShrink: 0 }} />}
                              <PathLabel text={worktree.branch ?? displayCwd(worktree.path, homeDir)} style={{ flex: 1 }} />
                              {worktree.isMain && <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>}
                            </button>
                            {!worktree.isMain && (
                              <button type="button" onClick={() => void handleRemoveWorktree(worktree.path, false)} disabled={wtBusy} title={t("sidebar.removeWorktreeTitle", { path: worktree.path })} aria-label={t("sidebar.removeWorktreeTitle", { path: worktree.path })} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 32, height: 28, marginRight: 4, padding: 0, background: "none", border: "none", borderRadius: 5, color: "var(--text-dim)", cursor: wtBusy ? "wait" : "pointer" }}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {showFilter && visibleWorktrees.length === 0 && wtFilter.trim() && <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingWorktrees")}</div>}
                </div>

                {!wtNewOpen ? (
                  <button
                    type="button"
                    onClick={() => {
                      setWtNewOpen(true);
                      setWtError(null);
                      setTimeout(() => wtNewInputRef.current?.focus(), 0);
                    }}
                    title={t("sidebar.createWorktreeTitle")}
                    style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", padding: "8px 10px", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11 }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true"><line x1="5" y1="1" x2="5" y2="9" /><line x1="1" y1="5" x2="9" y2="5" /></svg>
                    {t("sidebar.newWorktree")}
                  </button>
                ) : (
                  <div style={{ padding: "6px 8px" }}>
                    <input
                      ref={wtNewInputRef}
                      value={wtNewBranch}
                      onChange={(event) => { setWtNewBranch(event.target.value); setWtError(null); }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") { event.preventDefault(); void handleCreateWorktree(); }
                        if (event.key === "Escape") { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }
                      }}
                      placeholder={t("sidebar.branchName")}
                      aria-label={t("sidebar.branchName")}
                      style={{ width: "100%", boxSizing: "border-box", padding: "5px 8px", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11 }}
                    />
                    <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                      <button type="button" onClick={() => void handleCreateWorktree()} disabled={wtBusy || !wtNewBranch.trim()} style={{ flex: 1, padding: "4px 0", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer", opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1 }}>{wtBusy ? t("sidebar.creating") : t("sidebar.create")}</button>
                      <button type="button" onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }} style={{ flex: 1, padding: "4px 0", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}>{t("sidebar.cancel")}</button>
                    </div>
                  </div>
                )}
                {wtError && <div role="alert" style={{ padding: "5px 10px 8px", color: "#dc2626", fontSize: 11, lineHeight: 1.35, overflowWrap: "anywhere" }}>{wtError}</div>}
              </AnimatedDropdown>
            </div>
          );
        })()}

        {inactiveWorktreeSelector && (
          <div title={inactiveWorktreeSelector.title} style={{ width: "100%", height: 30, boxSizing: "border-box", marginTop: 5, display: "flex", alignItems: "center", gap: 6, padding: "0 9px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-hover)", color: "var(--text-dim)", fontSize: 11, whiteSpace: "nowrap", opacity: 0.82 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{inactiveWorktreeSelector.label}</span>
          </div>
        )}
      </div>








      {/* Project & Session list */}
      <div
        ref={listScrollRef}
        onScroll={handleListScroll}
        style={{ flex: "1 1 auto", overflowY: "auto", padding: "0 0 4px", minHeight: 80 }}
      >
        {(() => {
          const allProjectsCollapsed = allProjects.length > 0 && allProjects.every((p) => collapsedProjects.has(p.key));
          const handleToggleCollapseAll = () => {
            if (allProjectsCollapsed) {
              setCollapsedProjects(new Set());
            } else {
              setCollapsedProjects(new Set(allProjects.map((p) => p.key)));
            }
          };

          return (
            <div className="kimi-sidebar-section-heading">
              <span>{t("sidebar.sessionsHeading")}</span>
              <div className="kimi-sidebar-section-actions" ref={listMenuRef} style={{ display: "flex", alignItems: "center", gap: 2, position: "relative" }}>
                <button
                  type="button"
                  onClick={handleToggleCollapseAll}
                  title={allProjectsCollapsed ? t("sidebar.expandAll") : t("sidebar.collapseAll")}
                  aria-label={allProjectsCollapsed ? t("sidebar.expandAll") : t("sidebar.collapseAll")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 22, height: 22, padding: 0,
                    background: "none", border: "none", borderRadius: 4,
                    color: "var(--text-muted)", cursor: "pointer",
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: allProjectsCollapsed ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }}>
                    <polyline points="18 15 12 9 6 15" />
                  </svg>
                </button>

                <button
                  type="button"
                  onClick={() => setListMenuOpen((prev) => !prev)}
                  title={t("sidebar.manageList")}
                  aria-label={t("sidebar.manageList")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 22, height: 22, padding: 0,
                    background: listMenuOpen ? "var(--bg-hover)" : "none", border: "none", borderRadius: 4,
                    color: "var(--text-muted)", cursor: "pointer",
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                  onMouseLeave={(e) => { if (!listMenuOpen) e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="5" cy="12" r="2" />
                    <circle cx="12" cy="12" r="2" />
                    <circle cx="19" cy="12" r="2" />
                  </svg>
                </button>

                {listMenuOpen && (
                  <div
                    style={{
                      position: "absolute",
                      top: "calc(100% + 4px)",
                      right: 0,
                      zIndex: 80,
                      width: 170,
                      padding: "4px",
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setListMenuOpen(false);
                        loadSessions(false, true);
                      }}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        width: "100%", padding: "6px 10px",
                        background: "none", border: "none", borderRadius: 6,
                        color: "var(--text)", fontSize: 12, textAlign: "left", cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                      <span>{t("sidebar.refresh")}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setListMenuOpen(false);
                        handleCustomPathClick();
                      }}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        width: "100%", padding: "6px 10px",
                        background: "none", border: "none", borderRadius: 6,
                        color: "var(--text)", fontSize: 12, textAlign: "left", cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                        <line x1="12" y1="10" x2="12" y2="16" />
                        <line x1="9" y1="13" x2="15" y2="13" />
                      </svg>
                      <span>{t("sidebar.openDirectory")}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => { setListMenuOpen(false); openSessionManagement({ filter: "all" }); }}
                      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 10px", background: "none", border: "none", borderRadius: 6, color: "var(--text)", fontSize: 12, textAlign: "left", cursor: "pointer" }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
                      <span>{t("sessionSidebar.manageSessions")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setListMenuOpen(false);
                        openSessionManagement({ filter: "archived" });
                      }}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        width: "100%", padding: "6px 10px",
                        background: "none", border: "none", borderRadius: 6,
                        color: "var(--text)", fontSize: 12, textAlign: "left", cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="3" width="20" height="5" rx="1" />
                        <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
                        <line x1="10" y1="12" x2="14" y2="12" />
                      </svg>
                      <span>{t("sessionSidebar.archivedEntry")}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setListMenuOpen(false);
                        handleToggleCollapseAll();
                      }}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        width: "100%", padding: "6px 10px",
                        background: "none", border: "none", borderRadius: 6,
                        color: "var(--text)", fontSize: 12, textAlign: "left", cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="18 15 12 9 6 15" />
                      </svg>
                      <span>{allProjectsCollapsed ? t("sidebar.expandAll") : t("sidebar.collapseAll")}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
        {(loading || management.loading) && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.loading")}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        )}
        {(management.error || managementActionError) && (
          <div role="alert" style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {managementActionError || management.error}
            <button type="button" className="config-input" onClick={() => {
              setManagementActionError(null);
              void management.refresh().catch(() => {});
            }} style={{ display: "block", marginTop: 6 }}>{t("sessionsManager.retry")}</button>
          </div>
        )}
        {!loading && managementReady && !error && allProjects.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {allSessions.length ? t("sessionSidebar.noVisibleProjects") : t("sidebar.noSessions")}
            {allSessions.length > 0 && <button type="button" onClick={() => openSessionManagement({ filter: "all" })} style={{ display: "block", marginTop: 6 }}>{t("sessionSidebar.manageSessions")}</button>}
          </div>
        )}
        {sidebarRows.rows.length > 0 && (
          <div style={{ position: "relative", height: sidebarRows.totalHeight }}>
            {visibleRowIndices.map((rowIndex) => {
              const row = sidebarRows.rows[rowIndex];
              if (row.kind === "project") {
                const project = row.project;
                const isCollapsed = row.isCollapsed;
                return (
                  <div key={row.key} style={{ position: "absolute", top: row.top, left: 0, right: 0, height: row.height }}>
                    {/* Project Header Row */}
                    <div style={{ position: "relative", height: PROJECT_HEADER_HEIGHT - 2 }}>
                      <div
                        className="project-row"
                        onClick={() => {
                          toggleProjectCollapse(project.key);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSessionMenu(null);
                          setProjectMenu({ key: project.key, root: project.root, x: e.clientX, y: e.clientY });
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "6px 8px",
                          margin: "1px 8px",
                          borderRadius: 7,
                          background: "transparent",
                          cursor: "pointer",
                          userSelect: "none",
                          transition: "background 0.12s",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = "var(--bg-hover)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = "transparent";
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{
                              color: "var(--text-dim)",
                              transform: isCollapsed ? "rotate(-90deg)" : "none",
                              transition: "transform 0.15s ease",
                              flexShrink: 0,
                            }}
                          >
                            <polyline points="2 3.5 5 6.5 8 3.5" />
                          </svg>
                          {isCollapsed ? (
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              style={{ flexShrink: 0, color: "var(--text-muted)" }}
                            >
                              <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                            </svg>
                          ) : (
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              style={{ flexShrink: 0, color: "var(--text-muted)" }}
                            >
                              <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
                            </svg>
                          )}
                          <span
                            title={project.root}
                            style={{
                              fontSize: 12,
                              fontWeight: 500,
                              color: "var(--text-muted)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {getFileName(project.root) || displayCwd(project.root, homeDir)}
                          </span>
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
                          {showProjectActivity(projectActivity.get(project.key), t)}
                          <div className="project-row-actions">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              startNewSessionForCwd(project.root);
                            }}
                            title={t("sidebar.newInProject") || t("sidebar.new")}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 22,
                              height: 22,
                              padding: 0,
                              background: "none",
                              border: "none",
                              borderRadius: 4,
                              color: "var(--text-dim)",
                              cursor: "pointer",
                              transition: "color 0.12s, background 0.12s",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.color = "var(--accent)";
                              e.currentTarget.style.background = "var(--bg-selected)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.color = "var(--text-dim)";
                              e.currentTarget.style.background = "none";
                            }}
                          >
                            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                              <line x1="6" y1="1" x2="6" y2="11" />
                              <line x1="1" y1="6" x2="11" y2="6" />
                            </svg>
                          </button>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              setSessionMenu(null);
                              setProjectMenu(projectMenu?.key === project.key
                                ? null
                                : { key: project.key, root: project.root, x: rect.right - 176, y: rect.bottom + 4 });
                            }}
                            title={t("sidebar.projectOptions")}
                            aria-label={t("sidebar.projectOptions")}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              width: 22,
                              height: 22,
                              padding: 0,
                              background: projectMenu?.key === project.key ? "var(--bg-hover)" : "none",
                              border: "none",
                              borderRadius: 4,
                              color: projectMenu?.key === project.key ? "var(--text)" : "var(--text-dim)",
                              cursor: "pointer",
                              transition: "color 0.12s, background 0.12s",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.color = "var(--text)";
                              e.currentTarget.style.background = "var(--bg-hover)";
                            }}
                            onMouseLeave={(e) => {
                              if (projectMenu?.key !== project.key) {
                                e.currentTarget.style.color = "var(--text-dim)";
                                e.currentTarget.style.background = "none";
                              }
                            }}
                          >
                            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
                              <circle cx="3" cy="8" r="1.5" />
                              <circle cx="8" cy="8" r="1.5" />
                              <circle cx="13" cy="8" r="1.5" />
                            </svg>
                          </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }
              if (row.kind === "empty") {
                return (
                  <div
                    key={row.key}
                    style={{ position: "absolute", top: row.top, left: 0, right: 0, height: row.height, display: "flex", alignItems: "center", padding: "0 28px", fontSize: 11, color: "var(--text-dim)" }}
                  >
                    <span>{t("sessionSidebar.noActiveSessions")}</span>
                    <button type="button" onClick={() => openSessionManagement({ filter: "archived", projectKey: row.projectKey })}
                      style={{ marginLeft: 8, padding: 0, border: 0, background: "none", color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}>{t("sessionSidebar.archivedEntry")}</button>
                  </div>
                );
              }
              if (row.kind === "more") {
                return (
                  <div key={row.key} style={{ position: "absolute", top: row.top, left: 0, right: 0, height: row.height }}>
                    <button
                      type="button"
                      className="kimi-show-more"
                      onClick={() => setExpandedProjectSessions((current) => {
                        const next = new Set(current);
                        if (next.has(row.projectKey)) next.delete(row.projectKey);
                        else next.add(row.projectKey);
                        return next;
                      })}
                    >
                      <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: row.expanded ? "rotate(180deg)" : undefined }}>
                        <polyline points="2 3.5 5 6.5 8 3.5" />
                      </svg>
                      <span>{row.expanded ? t("sidebar.showLess") : t("sidebar.showMore")}</span>
                    </button>
                  </div>
                );
              }
              const family = row.family;
              const familySessions = [family.root, ...family.subagents];
              const displaySession = family.latestModified === family.root.modified
                ? family.root
                : { ...family.root, modified: family.latestModified };
              // Blur bubbles after the input's save handler before unpinning the row.
              return (
                <div
                  key={row.key}
                  onFocus={() => setFocusedRowKey(row.key)}
                  onBlur={() => setFocusedRowKey(null)}
                  style={{ position: "absolute", top: row.top, left: 0, right: 0, height: row.height }}
                >
                  <SessionItem
                    session={displaySession}
                    isSelected={familySessions.some((session) => session.id === selectedSessionId)}
                    isRunning={familySessions.some((session) => runningSessionIds.has(session.id))}
                    isUnread={familySessions.some((session) => unreadSessionIds.has(session.id))}
                    onClick={() => handleSelectSessionFromList(family.root)}
                    onRenamed={loadSessions}
                    pinned={pinnedSessionIds.has(family.root.id)}
                    actionsDisabled={managementBusy}
                    onTogglePin={() => handleTogglePinSession(family.root.id)}
                    onArchive={() => handleArchiveSession(family.root.id)}
                    onContextMenuOpen={(x, y) => {
                      setProjectMenu(null);
                      setSessionMenu({ id: family.root.id, x, y });
                    }}
                    registerActions={(actions) => registerSessionRowActions(family.root.id, actions)}
                  />
                </div>
              );
            })}
          </div>
        )}
        {projectMenu && (
          <ContextMenu
            x={projectMenu.x}
            y={projectMenu.y}
            ariaLabel={t("sidebar.projectOptions")}
            onClose={() => setProjectMenu(null)}
            items={projectMenuItems({
              newSession: () => startNewSessionForCwd(projectMenu.root),
              copyPath: () => void handleCopyProjectPath(projectMenu.root),
              manageSessions: () => openSessionManagement({ filter: "all", projectKey: projectMenu.key }),
              archiveSessions: () => handleArchiveProject(projectMenu.key),
              removeProject: () => handleRemoveProject(projectMenu.key, projectMenu.root),
              sessionCount: allSessions.filter((session) => workspaceKeyOf(session) === projectMenu.key
                && !session.transient && !archivedSessionIds.has(session.id)).length,
              disabled: managementBusy || !managementReady,
            }, t)}
          />
        )}
        {sessionMenu && (
          <ContextMenu
            x={sessionMenu.x}
            y={sessionMenu.y}
            ariaLabel={sessionMenu.id}
            onClose={() => setSessionMenu(null)}
            items={sessionMenuItems({
              pinned: pinnedSessionIds.has(sessionMenu.id),
              actions: rowActionsRef.current.get(sessionMenu.id),
              togglePin: () => handleTogglePinSession(sessionMenu.id),
              archive: () => handleArchiveSession(sessionMenu.id),
              manageSessions: () => openSessionManagement({ filter: "all" }),
              disabled: managementBusy || !managementReady,
            }, t)}
          />
        )}
      </div>

    </div>
  );
}

function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.agentRunning")}
      aria-label={t("sidebar.agentRunning")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.newActivity")}
      aria-label={t("sidebar.newSessionActivity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

/** Imperative handles a session row registers so the row-level context menu
 * (rendered at the sidebar root) can trigger its in-row rename/hide flows. */
interface SessionRowActions {
  startRename: () => void;
}

const menuIconProps = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const pinIcon = (
  <svg {...menuIconProps}>
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.66L5 14.1V15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.9l-2.89-1.68A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
  </svg>
);
const archiveIcon = (
  <svg {...menuIconProps}>
    <rect x="2" y="3" width="20" height="5" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <line x1="10" y1="12" x2="14" y2="12" />
  </svg>
);

/** Items of the project-row context menu (right-click or the "..." button). */
export function projectMenuItems(
  handlers: {
    newSession: () => void;
    copyPath: () => void;
    manageSessions: () => void;
    archiveSessions: () => void;
    removeProject: () => void;
    sessionCount: number;
    disabled?: boolean;
  },
  t: (key: string) => string,
): ContextMenuItem[] {
  return [
    {
      key: "new-session",
      label: t("sidebar.newSessionHere"),
      icon: (
        <svg {...menuIconProps}>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      ),
      onSelect: handlers.newSession,
    },
    {
      key: "copy-path",
      label: t("sidebar.copyPath"),
      icon: (
        <svg {...menuIconProps}>
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      ),
      onSelect: handlers.copyPath,
    },
    {
      key: "manage-sessions",
      label: t("sessionSidebar.manageProjectSessions"),
      icon: (
        <svg {...menuIconProps}>
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
      ),
      onSelect: handlers.manageSessions,
    },
    {
      key: "archive-sessions",
      label: `${t("sessionSidebar.archiveProjectSessions")} (${handlers.sessionCount})`,
      icon: archiveIcon,
      disabled: handlers.disabled || handlers.sessionCount === 0,
      onSelect: handlers.archiveSessions,
    },
    {
      key: "remove-project",
      label: t("sessionSidebar.removeProjectEntry"),
      disabled: handlers.disabled,
      icon: (
        <svg {...menuIconProps}>
          <path d="M20 9V8a2 2 0 0 0-2-2h-6l-2-3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h8M16 15l6 6M22 15l-6 6" />
        </svg>
      ),
      onSelect: handlers.removeProject,
    },
  ];
}

/** Items of the session-row context menu. */
export function sessionMenuItems(
  options: {
    pinned: boolean;
    actions?: SessionRowActions;
    togglePin: () => void;
    archive: () => void;
    manageSessions: () => void;
    disabled?: boolean;
  },
  t: (key: string) => string,
): ContextMenuItem[] {
  return [
    {
      key: "rename",
      label: t("sidebar.rename"),
      icon: (
        <svg {...menuIconProps}>
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
      ),
      onSelect: () => options.actions?.startRename(),
    },
    {
      key: "pin",
      label: t(options.pinned ? "sidebar.unpin" : "sidebar.pin"),
      icon: pinIcon,
      disabled: options.disabled,
      onSelect: options.togglePin,
    },
    {
      key: "archive",
      label: t("sidebar.archive"),
      icon: archiveIcon,
      disabled: options.disabled,
      onSelect: options.archive,
    },
    {
      key: "manage",
      label: t("sessionSidebar.manageSessions"),
      icon: (
        <svg {...menuIconProps}>
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
      ),
      onSelect: options.manageSessions,
    },
  ];
}

/**
 * Compact per-project activity badges for the workspace selector dropdown items:
 * a spinning running icon + count and an unread dot + count. Renders nothing
 * when the project has no activity. Counts share the accent / unread colors of
 * the per-session indicators so the two stay visually consistent.
 */
function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
  t: (key: string) => string,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6 }}>
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
            </g>
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#0891b2", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  pinned = false,
  actionsDisabled = false,
  onTogglePin,
  onArchive,
  onContextMenuOpen,
  registerActions,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  pinned?: boolean;
  actionsDisabled?: boolean;
  onTogglePin?: () => void;
  onArchive?: () => void;
  onContextMenuOpen?: (x: number, y: number) => void;
  registerActions?: (actions: SessionRowActions | null) => void;
}) {
  const { locale, t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Select the whole name once the rename input is mounted (startRename's
  // immediate setTimeout can fire before the input exists).
  useEffect(() => {
    if (renaming) {
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renaming]);

  // A stored first message may be an SDK-expanded <skill> block; collapse it
  // back to the compact /skill:name args command the user typed before using
  // it as the auto-name fallback, mirroring MessageView's rendering.
  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const title = session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);

  const startRename = useCallback(() => {
    if (session.transient) return;
    setRenameValue(session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12));
    setRenaming(true);
  }, [session.name, session.transient, displayFirstMessage, session.id]);

  // The portal context menu delegates rename to the mounted row.
  useEffect(() => {
    if (!registerActions) return;
    registerActions({ startRename });
    return () => registerActions(null);
  }, [registerActions, startRename]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    // No-op when unchanged: the fallback title (first message / id) isn't a
    // real stored name, so don't persist it as one. (The rename input seeds
    // from the same collapsed displayFirstMessage, so an untouched rename of
    // a skill-invoked session stays a no-op instead of persisting raw XML.)
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed, title]);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const handled = dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: e.clientX,
      clientY: e.clientY,
      refresh: () => { onRenamed?.(); },
    });
    // An external listener (e.g. the desktop shell) claims the menu first.
    if (handled || session.transient || !onContextMenuOpen) {
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    onContextMenuOpen(e.clientX, e.clientY);
  }, [onRenamed, onContextMenuOpen, session.cwd, session.id, session.name, session.path, session.transient]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  return (
    <div
      className="session-row"
      onClick={renaming ? undefined : onClick}
      onContextMenu={renaming ? undefined : handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: SESSION_LIST_ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        margin: "1px 8px",
        paddingLeft: depth > 0 ? depth * 12 + 8 : 10,
        paddingRight: 8,
        borderRadius: 6,
        cursor: renaming ? "default" : "pointer",
        background: isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        transition: "background 0.12s ease",
        gap: 6,
        overflow: "hidden",
      }}
    >
      {renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Subagent indicator for child sessions */}
          {depth > 0 && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <rect x="5" y="7" width="14" height="11" rx="2" />
              <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                minWidth: 0,
                fontSize: 12.5,
                fontWeight: isSelected ? 500 : 400,
                lineHeight: 1.4,
                color: "var(--text)",
              }}
              title={title}
            >
              {pinned && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }}>
                  <path d="M12 17v5" />
                  <path d="M9 10.76a2 2 0 0 1-1.11 1.66L5 14.1V15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.9l-2.89-1.68A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                </svg>
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>
                {title}
              </span>
              {isRunning ? (
                <RunningSessionIndicator />
              ) : isUnread ? (
                <UnreadSessionIndicator />
              ) : (
                <span title={session.modified} style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10.5, fontWeight: 400 }}>
                  {formatRelativeTime(session.modified, locale)}
                </span>
              )}
            </div>
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={t(collapsed ? "sidebar.expandSubagents" : "sidebar.collapseSubagents")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Hover on desktop, always available to touch users. */}
          {!session.transient && (
            <div className="session-row-actions" style={{ gap: 3, flexShrink: 0 }}>
              <button
                disabled={actionsDisabled}
                onClick={(e) => { e.stopPropagation(); onTogglePin?.(); }}
                title={t(pinned ? "sidebar.unpin" : "sidebar.pin")}
                aria-label={t(pinned ? "sidebar.unpin" : "sidebar.pin")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 24, height: 24, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 5, color: pinned ? "var(--accent)" : "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "all 0.12s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = pinned ? "var(--accent)" : "var(--text-muted)";
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 17v5" />
                  <path d="M9 10.76a2 2 0 0 1-1.11 1.66L5 14.1V15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.9l-2.89-1.68A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                </svg>
              </button>
              <button
                disabled={actionsDisabled}
                onClick={(e) => { e.stopPropagation(); onArchive?.(); }}
                title={t("sidebar.archive")}
                aria-label={t("sidebar.archive")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 24, height: 24, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 5, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "all 0.12s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="5" rx="1" />
                  <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
                  <line x1="10" y1="12" x2="14" y2="12" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
