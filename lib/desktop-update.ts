import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { isDesktopApp } from "./desktop";

export type DesktopUpdate = Update;
export type DesktopUpdateProgress = DownloadEvent;

/** Only the native desktop WebView may invoke the signed Tauri updater. */
export async function checkDesktopUpdate(): Promise<DesktopUpdate | null> {
  if (!isDesktopApp()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  return check({ timeout: 15_000 });
}

/** On Windows the updater exits the app after launching the NSIS installer. */
export async function installDesktopUpdate(
  update: DesktopUpdate,
  onProgress: (event: DesktopUpdateProgress) => void,
): Promise<void> {
  await update.downloadAndInstall(onProgress);
}
