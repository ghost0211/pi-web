/**
 * Client preference for task-completion notifications (browser/desktop toast).
 * Stored locally because delivery is a client-side concern; the server never
 * needs it. Default: enabled.
 */
const TASK_NOTIFY_KEY = "pi-task-notify-enabled";

export function taskNotificationsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TASK_NOTIFY_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setTaskNotificationsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TASK_NOTIFY_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore storage failures (private mode etc.).
  }
}
