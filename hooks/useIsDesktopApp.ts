"use client";

import { useSyncExternalStore } from "react";
import { isDesktopApp } from "@/lib/desktop";

const subscribe = () => () => {};
const getClientSnapshot = () => isDesktopApp();
const getServerSnapshot = () => false;

/**
 * Hydration-safe desktop detection.
 *
 * The Tauri bridge only exists in the WebView, so reading it during the first
 * render would make the client markup disagree with the prerendered HTML.
 * `useSyncExternalStore` renders the server snapshot (false) while hydrating and
 * switches right after, so desktop-only controls never break hydration.
 */
export function useIsDesktopApp(): boolean {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}
