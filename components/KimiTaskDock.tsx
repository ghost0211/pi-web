"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AgentMessage, AssistantMessage, BashExecutionMessage, ToolCallContent, ToolResultMessage } from "@/lib/types";

type DockKind = "bash" | "agent" | "progress";
type DockStatus = "running" | "done" | "failed" | "queued";
type DockFilter = "recent" | "running" | "done" | "all";

interface DockItem {
  id: string;
  title: string;
  detail?: string;
  status: DockStatus;
  timestamp?: number;
}

interface PendingBashLike {
  command: string;
  excludeFromContext?: boolean;
}

interface Props {
  messages: AgentMessage[];
  pendingBash?: PendingBashLike | null;
  agentRunning?: boolean;
  onOpenSession?: (sessionId: string) => void;
}

function resolveSubagentSessionId(block: ToolCallContent, result?: ToolResultMessage): string | null {
  if (result?.details) {
    const details = result.details as Record<string, unknown>;
    if (typeof details.sessionId === "string" && details.sessionId) return details.sessionId;
    if (typeof details.agent_id === "string" && details.agent_id) return details.agent_id;
    if (typeof details.id === "string" && details.id) return details.id;
  }
  const input = block.input as Record<string, unknown> | undefined;
  if (input) {
    if (typeof input.agent_id === "string" && input.agent_id) return input.agent_id;
    if (typeof input.sessionId === "string" && input.sessionId) return input.sessionId;
    if (typeof input.session_id === "string" && input.session_id) return input.session_id;
  }
  const text = result?.content
    ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n") ?? "";
  const match = text.match(/(?:Session ID|session_id|agent_id|sessionId)[:=\s]+([0-9a-zA-Z_-]+)/i);
  if (match?.[1]) return match[1];

  return null;
}

const BASH_TOOL_NAMES = new Set([
  "bash", "shell", "powershell", "execute", "exec", "exec_command", "terminal", "run_command", "run_terminal_command",
]);
const AGENT_TOOL_NAMES = new Set([
  "agent", "subagent", "sub_agent", "run_subagent", "get_subagent_result", "steer_subagent", "spawn_agent", "call_agent", "delegate", "agentswarm", "agent_swarm",
]);
const PLAN_TOOL_NAMES = new Set([
  "todolist", "todo_list", "todo", "todos", "write_todos", "update_todos", "todo_write",
  "plan", "update_plan", "write_plan", "task", "tasks", "tasklist", "task_list", "task_create", "task_update",
  "creategoal", "create_goal", "updategoal", "update_goal", "goal", "set_goal",
]);

function textResult(message: ToolResultMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function compactText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim().replace(/\s+/g, " ");
  return text || fallback;
}

function toolTitle(block: ToolCallContent, kind: DockKind): string {
  const input = (block.input ?? {}) as Record<string, unknown>;
  if (kind === "bash") {
    return compactText(input.command ?? input.cmd ?? input.script, block.toolName);
  }
  return compactText(
    input.task ?? input.description ?? input.prompt ?? input.message ?? input.agent,
    block.toolName,
  );
}

function statusFromResult(result: ToolResultMessage | undefined, running: boolean): DockStatus {
  if (running) return "running";
  if (!result) return "queued";
  return result.isError ? "failed" : "done";
}

function normalizePlanStatus(value: unknown): DockStatus {
  const status = typeof value === "string" ? value.toLowerCase() : "queued";
  if (["done", "completed", "complete", "success", "succeeded"].includes(status)) return "done";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  if (["in_progress", "in-progress", "running", "active"].includes(status)) return "running";
  return "queued";
}

function planItemsFromInput(input: Record<string, unknown>): DockItem[] {
  if (!input || typeof input !== "object") return [];
  const candidates = [input.todos, input.plan, input.tasks, input.items, input.steps, input.goals];
  const rows = candidates.find(Array.isArray);
  if (Array.isArray(rows)) {
    return rows.flatMap((row, index) => {
      if (typeof row === "string") {
        return [{ id: `plan-${index}`, title: row, status: "queued" as DockStatus }];
      }
      if (!row || typeof row !== "object") return [];
      const item = row as Record<string, unknown>;
      const title = compactText(item.title ?? item.task ?? item.step ?? item.content ?? item.name, `Task ${index + 1}`);
      return [{
        id: `plan-${index}-${title}`,
        title,
        detail: typeof item.description === "string" ? item.description : typeof item.detail === "string" ? item.detail : undefined,
        status: normalizePlanStatus(item.status),
      }];
    });
  }
  if (typeof input.objective === "string" || typeof input.task === "string" || typeof input.content === "string") {
    const title = compactText(input.objective ?? input.task ?? input.content, "Goal");
    return [{
      id: `plan-goal-${title}`,
      title,
      detail: typeof input.completionCriterion === "string" ? input.completionCriterion : undefined,
      status: normalizePlanStatus(input.status),
    }];
  }
  return [];
}

function StatusIcon({ status }: { status: DockStatus }) {
  if (status === "running") return <span className="kimi-dock-status is-running" aria-label="Running" />;
  if (status === "done") {
    return (
      <svg className="kimi-dock-status-icon is-done" viewBox="0 0 16 16" aria-label="Done">
        <circle cx="8" cy="8" r="6.25" />
        <path d="m4.8 8.1 2 2 4.4-4.5" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg className="kimi-dock-status-icon is-failed" viewBox="0 0 16 16" aria-label="Failed">
        <path d="m4.5 4.5 7 7m0-7-7 7" />
      </svg>
    );
  }
  return <span className="kimi-dock-status is-queued" aria-label="Queued" />;
}

function DockIcon({ kind }: { kind: DockKind }) {
  if (kind === "bash") {
    return <svg viewBox="0 0 20 20"><rect x="2.5" y="3" width="15" height="14" rx="2"/><path d="m5.5 7 2.5 2.5L5.5 12M10 12h4"/></svg>;
  }
  if (kind === "agent") {
    return <svg viewBox="0 0 20 20"><circle cx="5" cy="4.5" r="2"/><circle cx="15" cy="4.5" r="2"/><circle cx="10" cy="15.5" r="2"/><path d="M5 6.5v3h10v-3M10 9.5v4"/></svg>;
  }
  return <svg viewBox="0 0 20 20"><path d="m3.5 5 1.4 1.4L7.5 4M9.5 5H17M3.5 10l1.4 1.4L7.5 9M9.5 10H17M3.5 15l1.4 1.4L7.5 14M9.5 15H17"/></svg>;
}

function filterItems(items: DockItem[], filter: DockFilter): DockItem[] {
  if (filter === "running") return items.filter((item) => item.status === "running" || item.status === "queued");
  if (filter === "done") return items.filter((item) => item.status === "done" || item.status === "failed");
  if (filter === "recent") return items.slice(-8).reverse();
  return [...items].reverse();
}

export function KimiTaskDock({ messages, pendingBash, agentRunning = false, onOpenSession }: Props) {
  const { t } = useI18n();
  const [active, setActive] = useState<DockKind | null>(null);
  const [filter, setFilter] = useState<DockFilter>("recent");
  const rootRef = useRef<HTMLDivElement>(null);

  const data = useMemo(() => {
    const results = new Map<string, ToolResultMessage>();
    for (const message of messages) {
      if (message.role === "toolResult") results.set(message.toolCallId, message);
    }

    const bash: DockItem[] = [];
    const agent: DockItem[] = [];
    let progress: DockItem[] = [];

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      if (message.role === "bashExecution") {
        const bashMessage = message as BashExecutionMessage;
        bash.push({
          id: `bash-message-${messageIndex}`,
          title: compactText(bashMessage.command, "bash"),
          detail: compactText(bashMessage.output, ""),
          status: bashMessage.cancelled || (typeof bashMessage.exitCode === "number" && bashMessage.exitCode !== 0)
            ? "failed"
            : typeof bashMessage.exitCode === "number" ? "done" : "running",
          timestamp: bashMessage.timestamp,
        });
        continue;
      }
      if (message.role !== "assistant") continue;
      for (const block of (message as AssistantMessage).content ?? []) {
        if (block.type !== "toolCall") continue;
        const normalizedName = block.toolName.toLowerCase();
        const result = results.get(block.toolCallId);
        if (BASH_TOOL_NAMES.has(normalizedName)) {
          bash.push({
            id: block.toolCallId,
            title: toolTitle(block, "bash"),
            detail: textResult(result),
            status: statusFromResult(result, agentRunning && !result),
            timestamp: message.timestamp,
          });
        }
        if (AGENT_TOOL_NAMES.has(normalizedName)) {
          const subagentSessionId = resolveSubagentSessionId(block, result);
          agent.push({
            id: subagentSessionId ?? block.toolCallId,
            title: toolTitle(block, "agent"),
            detail: textResult(result),
            status: statusFromResult(result, agentRunning && !result),
            timestamp: message.timestamp,
          });
        }
        if (PLAN_TOOL_NAMES.has(normalizedName)) {
          const next = planItemsFromInput(block.input);
          if (next.length > 0) progress = next;
        }
      }
    }

    if (pendingBash && !bash.some((item) => item.status === "running" && item.title === pendingBash.command)) {
      bash.push({ id: "pending-bash", title: pendingBash.command, status: "running" });
    }

    return { bash, agent, progress };
  }, [agentRunning, messages, pendingBash]);

  useEffect(() => {
    if (!active) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setActive(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActive(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [active]);

  const items = active ? data[active] : [];
  const visibleItems = filterItems(items, filter);
  const completed = data.progress.filter((item) => item.status === "done").length;

  const label = (kind: DockKind): string => {
    if (kind === "bash") {
      const running = data.bash.some((item) => item.status === "running");
      return running ? `${t("dock.bash")} · ${t("dock.running")}` : t("dock.bash");
    }
    if (kind === "agent") {
      const running = data.agent.some((item) => item.status === "running");
      return running ? `${t("dock.agent")} · ${t("dock.running")}` : t("dock.agent");
    }
    return data.progress.length > 0 ? `${t("dock.progress")} ${completed}/${data.progress.length}` : t("dock.progress");
  };

  const filterLabel = (entry: DockFilter): string => {
    if (entry === "recent") return t("dock.recent");
    if (entry === "running") return t("dock.running");
    if (entry === "done") return t("dock.done");
    return t("dock.all");
  };

  const statusLabel = (status: DockStatus): string => {
    if (status === "done") return t("dock.done");
    if (status === "failed") return t("dock.failed");
    if (status === "running") return t("dock.running");
    return t("dock.queued");
  };

  return (
    <div className="kimi-task-dock" ref={rootRef}>
      {active && (
        <section className={`kimi-task-panel panel-${active}`} aria-label={`${label(active)} panel`}>
          <header className="kimi-task-panel-head">
            <div className="kimi-task-panel-title"><DockIcon kind={active} />{label(active)}</div>
            {active !== "progress" && (
              <div className="kimi-task-filters" role="tablist" aria-label="Task filters">
                {(["recent", "running", "done", "all"] as DockFilter[]).map((entry) => (
                  <button
                    type="button"
                    key={entry}
                    className={filter === entry ? "is-active" : ""}
                    onClick={() => setFilter(entry)}
                  >
                    {filterLabel(entry)}
                  </button>
                ))}
              </div>
            )}
          </header>
          <div className="kimi-task-panel-body">
            {visibleItems.length === 0 ? (
              <div className="kimi-task-empty">
                {active === "bash" ? t("dock.noBash") : active === "agent" ? t("dock.noAgent") : t("dock.noProgress")}
              </div>
            ) : visibleItems.map((item, index) => {
              const isAgentRow = active === "agent" && item.id && onOpenSession;
              return (
                <article
                  className={`kimi-task-row${isAgentRow ? " is-clickable" : ""}`}
                  key={item.id}
                  onClick={() => {
                    if (isAgentRow) {
                      onOpenSession?.(item.id);
                      setActive(null);
                    }
                  }}
                  style={{ cursor: isAgentRow ? "pointer" : undefined }}
                >
                  <StatusIcon status={item.status} />
                  <span className="kimi-task-index">{String(index + 1).padStart(2, "0")}</span>
                  <div className="kimi-task-copy">
                    <div className="kimi-task-title">{item.title}</div>
                    {item.detail && <div className="kimi-task-detail">{item.detail}</div>}
                  </div>
                  <span className={`kimi-task-state is-${item.status}`}>{statusLabel(item.status)}</span>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <div className="kimi-task-pills">
        {(["bash", "agent", "progress"] as DockKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            className={`kimi-task-pill${active === kind ? " is-active" : ""}`}
            aria-label={label(kind)}
            aria-expanded={active === kind}
            onClick={() => setActive((current) => current === kind ? null : kind)}
          >
            <DockIcon kind={kind} />
            <span>{label(kind)}</span>
            {(kind === "bash" ? data.bash : kind === "agent" ? data.agent : data.progress).some((item) => item.status === "running") && (
              <span className="kimi-task-live-dot" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
