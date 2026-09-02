/**
 * Bridge to the Pi Web Desktop (Tauri) shell.
 *
 * The desktop shell serves the web UI from a loopback HTTP origin, so the
 * only channel to Rust is `window.__TAURI__` (injected by the shell for
 * loopback origins; see src-tauri/capabilities/desktop-remote.json). In a
 * plain browser the bridge is absent and every helper degrades to a no-op.
 */

export type DesktopCloseBehavior = "minimize-to-tray" | "quit";

const CLOSE_BEHAVIOR_TRAY: DesktopCloseBehavior = "minimize-to-tray";
const CLOSE_BEHAVIOR_QUIT: DesktopCloseBehavior = "quit";

interface TauriBridge {
  core?: {
    invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  };
}

function tauriBridge(): TauriBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  if (!candidate || typeof candidate !== "object") return null;
  const bridge = candidate as TauriBridge;
  return typeof bridge.core?.invoke === "function" ? bridge : null;
}

/** True when the page runs inside the Pi Web Desktop shell. */
export function isDesktopApp(): boolean {
  return tauriBridge() !== null;
}

/** Current close behavior, or null when not running in the desktop shell. */
export async function getDesktopCloseBehavior(): Promise<DesktopCloseBehavior | null> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return null;
  const value = await invoke<string>("get_close_behavior");
  return value === CLOSE_BEHAVIOR_TRAY || value === CLOSE_BEHAVIOR_QUIT ? value : null;
}

/** Persist a new close behavior in the shell. Returns false outside the desktop app. */
export async function setDesktopCloseBehavior(behavior: DesktopCloseBehavior): Promise<boolean> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return false;
  await invoke("set_close_behavior", { behavior });
  return true;
}
