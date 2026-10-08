/** Pi Web-owned metadata; never part of the SDK session JSONL or settings.json. */
export type ManagedSessionStatus = "active" | "archived";

export interface ManagedSessionState {
  status: ManagedSessionStatus;
  pinned: boolean;
}

export interface ManagedProjectState {
  removed: boolean;
  root?: string;
}

export interface SessionManagementState {
  version: 1;
  revision: number;
  sessions: Record<string, ManagedSessionState>;
  projects: Record<string, ManagedProjectState>;
  migrationIds: string[];
}

export type SessionManagementAction =
  | {
      type: "sessions";
      ids: string[];
      status?: ManagedSessionStatus;
      pinned?: boolean;
      /** Explicit restoration also makes these project entries visible. */
      restoreProjects?: string[];
    }
  | { type: "project"; key: string; removed: boolean; root?: string };

export interface LegacySessionManagementMigration {
  migrationId: string;
  hiddenSessions: { id: string; projectKey?: string }[];
  hiddenProjects: { key: string; root?: string }[];
  archivedSessionIds: string[];
  pinnedSessionIds: string[];
  /** Preserve exact old storage values for rollback, including malformed ones. */
  rawBackup: Record<string, string | null>;
}

export function emptySessionManagementState(): SessionManagementState {
  return { version: 1, revision: 0, sessions: {}, projects: {}, migrationIds: [] };
}

export function managedSessionState(state: SessionManagementState, id: string): ManagedSessionState {
  return state.sessions[id] ?? { status: "active", pinned: false };
}

/** Shared sidebar/settings entry point (not a second archived-in-sidebar filter). */
export const OPEN_SESSION_MANAGEMENT_EVENT = "pi-web:open-session-management";
export type SessionManagementFilter = "all" | "active" | "archived";
export interface OpenSessionManagementDetail {
  filter: SessionManagementFilter;
  projectKey?: string;
}
