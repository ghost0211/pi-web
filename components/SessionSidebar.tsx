"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { listSessionFamilies } from "@/lib/session-family";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { getProjectActivity, getRecentProjects, sessionsForProject } from "@/lib/project-groups";
import { readHiddenProjects, addHiddenProject } from "@/lib/hidden-projects";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { formatRelativeTime } from "@/lib/i18n/format";
import { getFileName } from "@/lib/file-paths";
import { useI18n } from "@/hooks/useI18n";
import { DirectoryPicker } from "./DirectoryPicker";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

function ToolbarIconButton({
  onClick,
  title,
  disabled,
  skipHover,
  color,
  background = "none",
  marginRight,
  ariaPressed,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  skipHover?: boolean;
  color: string;
  background?: string;
  marginRight?: number;
  ariaPressed?: boolean;
  children: ReactNode;
}) {
  const enter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = "var(--text-muted)";
    e.currentTarget.style.background = "var(--bg-hover)";
  };
  const leave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = color;
    e.currentTarget.style.background = background;
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={ariaPressed}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, marginRight,
        background,
        border: "none",
        color,
        cursor: disabled ? "default" : "pointer",
        borderRadius: 5,
        flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
        transition: "color 0.3s, background 0.3s",
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {children}
    </button>
  );
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
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
  onBackgroundTaskDone?: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
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
    <div className="kimi-sidebar-brand" title={`Pi Web ${process.env.NEXT_PUBLIC_APP_VERSION ?? ""}`}>
      <span className="kimi-sidebar-brand-mark pi-brand-logo">
        <span className="pi-brand-symbol">π</span>
      </span>
      <span>Pi Web</span>
    </div>
  );
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionsChange, onToggleSidebar }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [wtFilter, setWtFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
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
  const [expandedProjectSessions, setExpandedProjectSessions] = useState<Set<string>>(() => new Set());
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [listMenuOpen, setListMenuOpen] = useState(false);
  const listMenuRef = useRef<HTMLDivElement>(null);

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
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSessions = useCallback(async (showLoading = false, force = false) => {
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
      setAllSessions(data.sessions);
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
        data.sessions
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
    } catch (e) {
      setError(String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst, !isFirst);
  }, [loadSessions, refreshKey]);


  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
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
          completionNotificationSuppressedSessionIds?: string[];
        };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
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
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

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
      (id) => !previousSuppressedCompletionSessionIdsRef.current.has(id) && !knownSubagentIds.has(id),
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
      onBackgroundTaskDone?.();
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
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);
  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        setCustomPathOpen(false);
        setCustomPathError(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
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
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
      }
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
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s);
  }, [onSelectSession]);

  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [openProjectMenuKey, setOpenProjectMenuKey] = useState<string | null>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const [hiddenProjects, setHiddenProjects] = useState<Set<string>>(() => {
    // Normalized over the legacy bare-array format; only keys matter here.
    return new Set(readHiddenProjects().map((entry) => entry.key));
  });

  useEffect(() => {
    if (!openProjectMenuKey) return;
    const handleOutside = (e: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setOpenProjectMenuKey(null);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [openProjectMenuKey]);

  const handleRemoveProject = useCallback((projectKey: string, root?: string) => {
    addHiddenProject({ key: projectKey, ...(root ? { root } : {}) });
    setHiddenProjects((prev) => new Set(prev).add(projectKey));
    setOpenProjectMenuKey(null);
  }, []);

  const handleCopyProjectPath = useCallback(async (root: string) => {
    setOpenProjectMenuKey(null);
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

  const recentProjects = getRecentProjects(allSessions);
  const showProjectFilter = recentProjects.length > 8;
  const visibleProjects = projectFilter.trim()
    ? recentProjects.filter((project) => project.root.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects;

  // Sessions of every worktree in the selected project are shown together
  const selectedProject = projectFor(selectedCwd);

  const allProjects = useMemo(() => {
    const list = [...recentProjects];
    if (selectedProject && !list.some((p) => p.key === selectedProject.key)) {
      list.unshift({ key: selectedProject.key, root: selectedProject.root });
    }
    return list.filter((p) => !hiddenProjects.has(p.key));
  }, [recentProjects, selectedProject, hiddenProjects]);

  // Per-project activity counts (running / unread) for the workspace selector.
  // Uses the same stable server key as the project list and filtering.
  const projectActivity = useMemo(
    () => getProjectActivity(allSessions, runningSessionIds, unreadSessionIds),
    [allSessions, runningSessionIds, unreadSessionIds],
  );

  // Any activity in a project other than the one currently selected — shown as
  // a dot on the (collapsed) selector button so it is visible without opening
  // the dropdown.
  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(
      ([key, { running, unread }]) => key !== selectedProject?.key && (running > 0 || unread > 0),
    ),
    [projectActivity, selectedProject],
  );

  const filteredSessions = selectedProject
    ? sessionsForProject(allSessions, selectedProject.key)
    : allSessions;
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

  const sessionFamilies = listSessionFamilies(filteredSessions);

  const searchedSessionFamilies = useMemo(() => {
    if (!sessionSearch.trim()) return sessionFamilies;
    const q = sessionSearch.trim().toLowerCase();
    return sessionFamilies.filter((family) => {
      const familySessions = [family.root, ...family.subagents];
      return familySessions.some((s) => {
        const name = (s.name ?? "").toLowerCase();
        const firstMsg = (s.firstMessage ?? "").toLowerCase();
        const id = s.id.toLowerCase();
        return name.includes(q) || firstMsg.includes(q) || id.includes(q);
      });
    });
  }, [sessionFamilies, sessionSearch]);

  const timeGroupedFamilies = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;
    const sevenDaysAgoStart = todayStart - 6 * 86400000;

    const groups = {
      today: [] as typeof sessionFamilies,
      yesterday: [] as typeof sessionFamilies,
      last7Days: [] as typeof sessionFamilies,
      earlier: [] as typeof sessionFamilies,
    };

    for (const family of searchedSessionFamilies) {
      const rawTime = family.latestModified || family.root.modified || family.root.created;
      const time = rawTime ? new Date(rawTime).getTime() : 0;
      if (!time || isNaN(time)) {
        groups.earlier.push(family);
      } else if (time >= todayStart) {
        groups.today.push(family);
      } else if (time >= yesterdayStart) {
        groups.yesterday.push(family);
      } else if (time >= sevenDaysAgoStart) {
        groups.last7Days.push(family);
      } else {
        groups.earlier.push(family);
      }
    }

    return [
      { key: "today", labelKey: "sidebar.today", families: groups.today },
      { key: "yesterday", labelKey: "sidebar.yesterday", families: groups.yesterday },
      { key: "last7Days", labelKey: "sidebar.last7Days", families: groups.last7Days },
      { key: "earlier", labelKey: "sidebar.earlier", families: groups.earlier },
    ].filter((g) => g.families.length > 0);
  }, [searchedSessionFamilies]);

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
        </div>

        {/* Session Search Input */}
        <div style={{ position: "relative", marginBottom: 5 }}>
          <svg style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none" }} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={sessionSearch}
            onChange={(e) => setSessionSearch(e.target.value)}
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
      </div>








      {/* Project & Session list */}
      <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "0 0 4px", minHeight: 80 }}>
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
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.loading")}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && allProjects.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.noSessions")}
          </div>
        )}
        {allProjects.map((project) => {
          const isCurrentProject = selectedProject?.key === project.key;
          const isCollapsed = collapsedProjects.has(project.key);
          const projectSessions = sessionsForProject(allSessions, project.key);
          const projectFamilies = listSessionFamilies(projectSessions);

          const visibleProjectFamilies = sessionSearch.trim()
            ? projectFamilies.filter((family) => {
                const q = sessionSearch.trim().toLowerCase();
                const familySessions = [family.root, ...family.subagents];
                return familySessions.some((s) => {
                  const name = (s.name ?? "").toLowerCase();
                  const firstMsg = (s.firstMessage ?? "").toLowerCase();
                  const id = s.id.toLowerCase();
                  return name.includes(q) || firstMsg.includes(q) || id.includes(q);
                });
              })
            : projectFamilies;

          if (sessionSearch.trim() && visibleProjectFamilies.length === 0) {
            return null;
          }

          return (
            <div
              key={project.key}
              style={{
                marginBottom: 4,
              }}
            >
              {/* Project Header Row */}
              <div style={{ position: "relative" }}>
                <div
                  onClick={() => {
                    toggleProjectCollapse(project.key);
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
                        setOpenProjectMenuKey(openProjectMenuKey === project.key ? null : project.key);
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
                        background: openProjectMenuKey === project.key ? "var(--bg-hover)" : "none",
                        border: "none",
                        borderRadius: 4,
                        color: openProjectMenuKey === project.key ? "var(--text)" : "var(--text-dim)",
                        cursor: "pointer",
                        transition: "color 0.12s, background 0.12s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "var(--text)";
                        e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (openProjectMenuKey !== project.key) {
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

                {/* Project Options Dropdown Menu */}
                {openProjectMenuKey === project.key && (
                  <div
                    ref={projectMenuRef}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      position: "absolute",
                      top: "calc(100% + 2px)",
                      right: 12,
                      zIndex: 80,
                      minWidth: 152,
                      padding: 4,
                      background: "var(--bg-panel)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.24)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setOpenProjectMenuKey(null);
                        startNewSessionForCwd(project.root);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        padding: "6px 10px",
                        background: "none",
                        border: "none",
                        borderRadius: 6,
                        color: "var(--text)",
                        fontSize: 12,
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      <span>{t("sidebar.newSessionHere")}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        void handleCopyProjectPath(project.root);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        padding: "6px 10px",
                        background: "none",
                        border: "none",
                        borderRadius: 6,
                        color: "var(--text)",
                        fontSize: 12,
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      <span>{t("sidebar.copyPath")}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        handleRemoveProject(project.key, project.root);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        padding: "6px 10px",
                        background: "none",
                        border: "none",
                        borderRadius: 6,
                        color: "#ef4444",
                        fontSize: 12,
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239, 68, 68, 0.1)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                      <span>{t("sidebar.removeFromList")}</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Sessions List under this Project */}
              {!isCollapsed && (
                <div style={{ marginTop: 2 }}>
                  {visibleProjectFamilies.length === 0 ? (
                    <div style={{ padding: "6px 28px", fontSize: 11, color: "var(--text-dim)" }}>
                      {t("sidebar.noSessions")}
                    </div>
                  ) : (
                    <>
                    {(sessionSearch.trim() || expandedProjectSessions.has(project.key)
                      ? visibleProjectFamilies
                      : visibleProjectFamilies.slice(0, 6)
                    ).map((family) => {
                      const familySessions = [family.root, ...family.subagents];
                      const displaySession = family.latestModified === family.root.modified
                        ? family.root
                        : { ...family.root, modified: family.latestModified };
                      return (
                        <SessionItem
                          key={family.root.id}
                          session={displaySession}
                          isSelected={familySessions.some((session) => session.id === selectedSessionId)}
                          isRunning={familySessions.some((session) => runningSessionIds.has(session.id))}
                          isUnread={familySessions.some((session) => unreadSessionIds.has(session.id))}
                          onClick={() => handleSelectSessionFromList(family.root)}
                          onRenamed={loadSessions}
                          onDeleted={(id) => {
                            onSessionDeleted?.(id);
                            loadSessions();
                          }}
                        />
                      );
                    })}
                    {!sessionSearch.trim() && visibleProjectFamilies.length > 6 && (
                      <button
                        type="button"
                        className="kimi-show-more"
                        onClick={() => setExpandedProjectSessions((current) => {
                          const next = new Set(current);
                          if (next.has(project.key)) next.delete(project.key);
                          else next.add(project.key);
                          return next;
                        })}
                      >
                        <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expandedProjectSessions.has(project.key) ? "rotate(180deg)" : undefined }}>
                          <polyline points="2 3.5 5 6.5 8 3.5" />
                        </svg>
                        <span>{expandedProjectSessions.has(project.key) ? t("sidebar.showLess") : t("sidebar.showMore")}</span>
                      </button>
                    )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
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
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { locale, t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
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

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (session.transient) return;
    setRenameValue(session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12));
    setRenaming(true);
  }, [session.name, session.transient, displayFirstMessage, session.id]);

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

  const performDelete = useCallback(async () => {
    if (session.transient) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, session.transient, onDeleted]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey) {
      void performDelete();
    } else {
      setConfirmDelete(true);
    }
  }, [performDelete]);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

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
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  }, [onRenamed, session.cwd, session.id, session.name, session.path]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = 34;

  return (
    <div
      onClick={confirmDelete || renaming ? undefined : onClick}
      onContextMenu={confirmDelete || renaming ? undefined : handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        margin: "1px 8px",
        paddingLeft: depth > 0 ? depth * 12 + 8 : 10,
        paddingRight: 8,
        borderRadius: 6,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.08)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        transition: "background 0.12s ease",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.deleteSession", { title: title.slice(0, 22) + (title.length > 22 ? "…" : "") })}
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("sidebar.delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
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

          {/* Action buttons — shown on hover */}
          {hovered && !session.transient && (
            <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
              <button
                onClick={startRename}
                title={t("sidebar.rename")}
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
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                onClick={handleDeleteClick}
                title={t("sidebar.deleteWithShiftClick")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 24, height: 24, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 5, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "all 0.12s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.12)";
                  e.currentTarget.style.color = "#ef4444";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
