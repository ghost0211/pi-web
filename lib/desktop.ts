/**
 * Bridge to the Pi Web Desktop (Tauri) shell.
 *
 * The desktop shell serves the web UI from a loopback HTTP origin, so the
 * only channel to Rust is `window.__TAURI__` (injected by the shell for
 * loopback origins; see src-tauri/capabilities/desktop-remote.json). In a
 * plain browser the bridge is absent and every helper degrades to a no-op.
 */

import { isTrayMenu, normalizeTrayAction, type DesktopTrayAction, type DesktopTrayMenu } from "./desktop-tray";

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

/* ── Custom titlebar window controls ───────────────────────────────────────
 * The desktop window is undecorated (see `build_main_window` in main.rs), so
 * the web UI renders its own minimize/maximize/close buttons. All of these
 * no-op outside the desktop shell.
 */

export async function desktopWindowMinimize(): Promise<void> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return;
  try { await invoke("plugin:window|minimize"); } catch { /* shell gone */ }
}

export async function desktopWindowToggleMaximize(): Promise<void> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return;
  try { await invoke("plugin:window|toggle_maximize"); } catch { /* shell gone */ }
}

/** Close goes through CloseRequested, so the close-behavior setting applies. */
export async function desktopWindowClose(): Promise<void> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return;
  try { await invoke("plugin:window|close"); } catch { /* shell gone */ }
}

export async function desktopWindowIsMaximized(): Promise<boolean> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return false;
  try { return (await invoke<boolean>("plugin:window|is_maximized")) === true; } catch { return false; }
}

/** Fires on every window resize; maximize state changes are observed through it. */
export async function listenDesktopWindowResize(handler: () => void): Promise<DesktopUnlisten | null> {
  const listen = tauriBridge()?.event?.listen;
  if (!listen) return null;
  try {
    return await listen("tauri://resize", () => handler());
  } catch {
    return null;
  }
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

export type DesktopOpenMode = "default" | "chooser";

/**
 * Ask the desktop shell to open a local file. `default` uses the remembered
 * system association; `chooser` opens the OS "open with" dialog. Returns false
 * outside the desktop shell so callers can keep their browser behavior, and
 * surfaces shell failures as a rejected promise.
 */
export async function openDesktopPath(path: string, mode: DesktopOpenMode = "default"): Promise<boolean> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return false;
  await invoke(mode === "chooser" ? "open_local_path_with" : "open_local_path", { path });
  return true;
}

/** Reveal a local file in the platform file manager. Returns false outside desktop. */
export async function revealDesktopPath(path: string): Promise<boolean> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return false;
  await invoke("reveal_local_path", { path });
  return true;
}

/** Sync bounded, translated native menu data; old shells and ordinary browsers are harmless no-ops. */
export async function syncDesktopTrayMenu(menu: DesktopTrayMenu): Promise<boolean> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke || !isTrayMenu(menu)) return false;
  try { await invoke("sync_tray_menu", { menu }); return true; } catch { return false; }
}

/** Consume only an action explicitly requested from the native tray menu. */
export async function takeDesktopTrayAction(): Promise<DesktopTrayAction | null> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return null;
  try { return normalizeTrayAction(await invoke("take_tray_action")); } catch { return null; }
}

export async function listenDesktopTrayActions(wake: () => void): Promise<DesktopUnlisten | null> {
  const listen = tauriBridge()?.event?.listen;
  if (!listen) return null;
  try { return await listen("pi-web:tray-action", wake); } catch { return null; }
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

/*
 * Native (Windows toast) notifications.
 *
 * The desktop shell renders these through `tauri-plugin-notification`, which is
 * more reliable in WebView2 than the Web Notification API and keeps working
 * while the window is hidden in the tray. The bridge deliberately accepts only
 * bounded text and opaque identifiers: it can never open a URL, path, file, or
 * shell command.
 *
 * Click activation is *not* delivered by the plugin's desktop backend (see
 * desktop/README.md), so `sessionId` is only a best-effort deep-link target for
 * the main thread to consume when the app is activated by another route.
 */

// Kept identical to `MAX_NOTIFICATION_*` in src-tauri/src/main.rs; the Rust side
// re-validates, this is only the fast client-side guard.
const NOTIFICATION_TITLE_MAX_CHARS = 120;
const NOTIFICATION_BODY_MAX_CHARS = 400;
const NOTIFICATION_ID_MAX_CHARS = 128;
const NOTIFICATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface DesktopNotificationInput {
  title: string;
  body: string;
  /** Opaque session id for deep-linking; never a URL or path. */
  sessionId?: string;
  /** Stable dedup key; defaults to the session id (then to "pi-web"). */
  tag?: string;
}

/**
 * Collapse whitespace/control characters and truncate to `maxChars` code
 * points, mirroring the Rust `sanitize_notification_text` helper.
 */
export function sanitizeDesktopNotificationText(raw: string, maxChars: number): string {
  const flattened = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  const collapsed = flattened.split(/\s+/u).filter((part) => part.length > 0).join(" ");
  const codePoints = Array.from(collapsed);
  return codePoints.length <= maxChars ? collapsed : codePoints.slice(0, maxChars).join("");
}

/** Accept only bounded opaque ids; anything path- or URL-shaped returns null. */
export function normalizeDesktopNotificationId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > NOTIFICATION_ID_MAX_CHARS) return null;
  return NOTIFICATION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Show a native toast. Returns false outside the desktop shell (callers fall
 * back to the browser notification path) and also when the shell suppressed a
 * duplicate `tag` inside its dedup window. Shell failures degrade to false
 * rather than rejecting, because notifications are fire-and-forget UI.
 */
export async function showDesktopNotification(input: DesktopNotificationInput): Promise<boolean> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return false;

  const title = sanitizeDesktopNotificationText(input.title, NOTIFICATION_TITLE_MAX_CHARS);
  if (!title) return false;
  const body = sanitizeDesktopNotificationText(input.body, NOTIFICATION_BODY_MAX_CHARS);
  const sessionId = normalizeDesktopNotificationId(input.sessionId);
  const tag = normalizeDesktopNotificationId(input.tag) ?? sessionId;

  try {
    const shown = await invoke<boolean>("send_desktop_notification", {
      title,
      body,
      sessionId,
      tag,
    });
    return shown === true;
  } catch {
    // Windows may refuse toasts (focus assist, policy); fall back to quiet.
    return false;
  }
}

/**
 * Stop the bundled Node sidecar before the updater runs. The NSIS installer
 * force-quits the app process, which can orphan node.exe and leave install-dir
 * files locked ("file in use" update failures). The shell kills and reaps the
 * child synchronously, so by the time the installer starts nothing holds the
 * files open. No-op outside the desktop shell.
 */
export async function prepareDesktopUpdate(): Promise<boolean> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return false;
  try {
    return (await invoke<boolean>("prepare_desktop_update")) === true;
  } catch {
    return false;
  }
}

/**
 * Whether the desktop web service listens on all interfaces (LAN-reachable)
 * instead of loopback only. Persisted by the shell; applied on next launch.
 * Returns null outside the desktop app.
 */
export async function getDesktopLanAccess(): Promise<boolean | null> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return null;
  try {
    return (await invoke<boolean>("get_lan_access")) === true;
  } catch {
    return null;
  }
}

export async function setDesktopLanAccess(enabled: boolean): Promise<boolean> {
  const invoke = tauriBridge()?.core?.invoke;
  if (!invoke) return false;
  try {
    return (await invoke<boolean>("set_lan_access", { enabled })) === true;
  } catch {
    return false;
  }
}
