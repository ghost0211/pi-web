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

interface TauriEvent<T> {
  payload: T;
}

type DesktopUnlisten = () => void;

interface TauriBridge {
  core?: {
    invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  };
  event?: {
    listen?: <T>(event: string, handler: (event: TauriEvent<T>) => void) => Promise<DesktopUnlisten>;
  };
}

export interface DesktopFileDropHandlers {
  onEnter: () => void;
  onOver: () => void;
  onLeave: () => void;
  onDrop: (paths: string[]) => void;
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

/**
 * Open the shell's native multi-file picker. `null` means no desktop dialog is
 * available (so callers should fall back to an HTML file input); `[]` means
 * the user cancelled the native dialog.
 */
export async function pickDesktopAttachmentPaths(): Promise<string[] | null> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return null;
  const selected = await invoke<unknown>("pick_attachment_paths");
  if (!Array.isArray(selected)) return [];
  return selected.filter((path): path is string => typeof path === "string" && path.length > 0);
}

/** Listen for Tauri's native file-drop events, which carry absolute paths. */
export async function listenDesktopFileDrop(
  handlers: DesktopFileDropHandlers,
): Promise<DesktopUnlisten | null> {
  const listen = tauriBridge()?.event?.listen;
  if (!listen) return null;

  const unlisteners: DesktopUnlisten[] = [];
  try {
    unlisteners.push(await listen<{ paths?: unknown }>("tauri://drag-enter", () => handlers.onEnter()));
    unlisteners.push(await listen("tauri://drag-over", () => handlers.onOver()));
    unlisteners.push(await listen("tauri://drag-leave", () => handlers.onLeave()));
    unlisteners.push(await listen<{ paths?: unknown }>("tauri://drag-drop", (event) => {
      const paths = Array.isArray(event.payload?.paths)
        ? event.payload.paths.filter((path): path is string => typeof path === "string" && path.length > 0)
        : [];
      handlers.onDrop(paths);
    }));
  } catch {
    unlisteners.forEach((unlisten) => unlisten());
    return null;
  }

  return () => unlisteners.forEach((unlisten) => unlisten());
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
