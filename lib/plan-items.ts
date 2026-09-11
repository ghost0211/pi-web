/**
 * Shared helpers for identifying and extracting plan/todo items
 * across sessions, history pagination, and UI docks.
 */

export const PLAN_TOOL_NAMES = new Set([
  "todolist", "todo_list", "todo", "todos", "write_todos", "update_todos", "todo_write",
  "plan", "update_plan", "write_plan", "task", "tasks", "tasklist", "task_list", "task_create", "task_update",
  "creategoal", "create_goal", "updategoal", "update_goal", "goal", "set_goal",
]);

export interface PlanItem {
  id: string;
  title: string;
  detail?: string;
  status: "queued" | "running" | "done" | "failed";
}

function compactText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim().replace(/\s+/g, " ");
  return text || fallback;
}

export function normalizePlanStatus(value: unknown): PlanItem["status"] {
  const status = typeof value === "string" ? value.toLowerCase() : "queued";
  if (["done", "completed", "complete", "success", "succeeded"].includes(status)) return "done";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  if (["in_progress", "in-progress", "running", "active"].includes(status)) return "running";
  return "queued";
}

export function planItemsFromInput(input: unknown): PlanItem[] {
  if (!input || typeof input !== "object") return [];
  const rec = input as Record<string, unknown>;
  const candidates = [rec.todos, rec.plan, rec.tasks, rec.items, rec.steps, rec.goals];
  const rows = candidates.find(Array.isArray);
  if (Array.isArray(rows)) {
    return rows.flatMap((row, index): PlanItem[] => {
      if (typeof row === "string") {
        return [{ id: `plan-${index}`, title: row, status: "queued" }];
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
  if (typeof rec.objective === "string" || typeof rec.task === "string" || typeof rec.content === "string") {
    const title = compactText(rec.objective ?? rec.task ?? rec.content, "Goal");
    return [{
      id: `plan-goal-${title}`,
      title,
      detail: typeof rec.completionCriterion === "string" ? rec.completionCriterion : undefined,
      status: normalizePlanStatus(rec.status),
    }];
  }
  return [];
}
