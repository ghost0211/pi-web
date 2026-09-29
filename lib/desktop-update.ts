import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { isDesktopApp, prepareDesktopUpdate } from "./desktop";

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
  // Download first, while the app is fully alive — a failed download leaves
  // the running server untouched. Then kill the sidecar: the NSIS installer
  // force-quits the app process, which can orphan node.exe and leave the
  // install directory locked ("file in use") until killed manually.
  await update.download(onProgress);
  await prepareDesktopUpdate();
  await update.install();
}
