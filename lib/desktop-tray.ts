import type { SessionInfo } from "./types";
import type { SessionManagementState } from "./session-management-types";

export interface DesktopTrayLabels {
  show: string;
  newSession: string;
  recentSessions: string;
  emptyRecent: string;
  minimizeOnClose: string;
  quit: string;
}
export interface DesktopTraySession { id: string; title: string }
export interface DesktopTrayMenu {
  locale: string;
  labels: DesktopTrayLabels;
  recentSessions: DesktopTraySession[];
}
export type DesktopTrayAction = { type: "new-session" } | { type: "open-session"; sessionId: string };

export function safeTrayId(value: unknown): value is string {
  return typeof value === "string" && value !== "." && value !== ".." && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
export function trayText(value: string, limit: number): string {
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").split(/\s+/u).filter(Boolean).join(" "))
    .slice(0, limit).join("");
}

/** Normal conversations only; project removal is sidebar-only, not archiving. */
export function recentDesktopTraySessions(
  sessions: SessionInfo[], state: SessionManagementState | null,
): DesktopTraySession[] {
  if (!state) return [];
  const unique = new Map<string, SessionInfo>();
  for (const session of sessions) {
    if (!safeTrayId(session.id) || session.relation?.kind === "subagent" || state.sessions[session.id]?.status === "archived") continue;
    const previous = unique.get(session.id);
    if (!previous || session.modified > previous.modified) unique.set(session.id, session);
  }
  return [...unique.values()].sort((a, b) => b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id))
    .slice(0, 3).map((session) => ({ id: session.id, title: trayText(session.name || session.firstMessage || session.id, 80) || session.id }));
}

export function normalizeTrayAction(value: unknown): DesktopTrayAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  if (action.type === "new-session" && action.sessionId === undefined) return { type: "new-session" };
  if (action.type === "open-session" && safeTrayId(action.sessionId)) return { type: "open-session", sessionId: action.sessionId };
  return null;
}

export function isTrayMenu(raw: unknown): raw is DesktopTrayMenu {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  if (typeof value.locale !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(value.locale)
    || !Array.isArray(value.recentSessions) || value.recentSessions.length > 3
    || !value.labels || typeof value.labels !== "object" || Array.isArray(value.labels)) return false;
  const labels = value.labels as Record<string, unknown>;
  const seen = new Set<string>();
  return ["show", "newSession", "recentSessions", "emptyRecent", "minimizeOnClose", "quit"]
    .every((key) => typeof labels[key] === "string" && String(labels[key]).trim().length > 0 && Array.from(String(labels[key])).length <= 120)
    && value.recentSessions.every((rawSession) => {
      if (!rawSession || typeof rawSession !== "object" || Array.isArray(rawSession)) return false;
      const session = rawSession as Record<string, unknown>;
      if (!safeTrayId(session.id) || seen.has(session.id) || typeof session.title !== "string"
        || !session.title.trim() || Array.from(session.title).length > 80) return false;
      seen.add(session.id); return true;
    });
}

/** Serialized, resumable consumption: a blocked settings operation never loses an explicit tray click. */
export function createTrayActionPump(options: {
  take: () => Promise<DesktopTrayAction | null>;
  canHandle: () => boolean;
  handle: (action: DesktopTrayAction) => Promise<void | boolean>;
  onError: (error: unknown) => void;
}) {
  let active = false;
  let running = false;
  let requested = false;
  let pending: DesktopTrayAction | null = null;
  const resume = async (): Promise<void> => {
    requested = true;
    if (!active || running || !options.canHandle()) return;
    running = true;
    try {
      while (active && options.canHandle()) {
        requested = false;
        pending ??= await options.take();
        if (!pending || !active || !options.canHandle()) break;
        const action = pending;
        pending = null;
        if (await options.handle(action) === false) { pending = action; break; }
      }
    } catch (error) {
      options.onError(error);
    } finally {
      running = false;
      if (requested && active && options.canHandle()) void resume();
    }
  };
  return { start() { active = true; void resume(); }, stop() { active = false; }, resume };
}

/** One native write at a time; a slow English update cannot overwrite a newer Chinese selection. */
export function createTrayMenuSink(sync: (menu: DesktopTrayMenu) => Promise<boolean>) {
  let running = false;
  let desired: DesktopTrayMenu | null = null;
  let acceptedKey: string | null = null;
  const flush = async () => {
    if (running) return;
    running = true;
    try {
      while (desired) {
        const current = desired;
        const key = JSON.stringify(current);
        if (key === acceptedKey) break;
        const accepted = await sync(current);
        if (accepted) acceptedKey = key;
        if (desired === current) break;
      }
    } finally { running = false; }
  };
  return { update(menu: DesktopTrayMenu) { desired = menu; return flush(); } };
}
