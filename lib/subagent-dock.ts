import type { SessionInfo, SubagentSessionStatus } from "./types";

export type SubagentDockStatus = "running" | "done" | "failed" | "queued";

export interface SubagentDockItem {
  id: string;
  title: string;
  detail?: string;
  status: SubagentDockStatus;
  timestamp?: number;
}

function persistedStatus(status: SubagentSessionStatus): SubagentDockStatus {
  if (status === "starting" || status === "running") return "running";
  if (status === "completed") return "done";
  return "failed";
}

function sessionDetail(session: SessionInfo): string | undefined {
  if (session.relation?.kind !== "subagent") return session.firstMessage || undefined;
  const parts = [session.relation.profile, session.firstMessage]
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Merge message-derived Agent rows with authoritative persisted subagent
 * sessions. This keeps the dock useful after compaction and for subagents
 * created without an Agent tool-call block in the active context. */
export function mergeSubagentDockItems(
  toolItems: readonly SubagentDockItem[],
  sessions: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
): SubagentDockItem[] {
  const byId = new Map(toolItems.map((item) => [item.id, { ...item }]));

  for (const session of sessions) {
    if (session.relation?.kind !== "subagent") continue;
    const existing = byId.get(session.id);
    const timestamp = Date.parse(session.modified || session.created);
    byId.set(session.id, {
      id: session.id,
      title: session.relation.description || session.name || session.firstMessage || `Agent · ${session.id.slice(0, 6)}`,
      detail: existing?.detail || sessionDetail(session),
      status: runningSessionIds.has(session.id)
        ? "running"
        : persistedStatus(session.relation.status),
      timestamp: Number.isFinite(timestamp) ? timestamp : existing?.timestamp,
    });
  }

  return [...byId.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}
