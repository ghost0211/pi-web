"use client";

import { useEffect, useMemo, useRef } from "react";
import { isDesktopApp, listenDesktopTrayActions, syncDesktopTrayMenu, takeDesktopTrayAction } from "@/lib/desktop";
import { createTrayActionPump, createTrayMenuSink, recentDesktopTraySessions, type DesktopTrayAction, type DesktopTrayMenu } from "@/lib/desktop-tray";
import type { SessionInfo } from "@/lib/types";
import type { SessionManagementState } from "@/lib/session-management-types";

export function useDesktopTray(options: {
  locale: string;
  localeReady: boolean;
  translate: (key: string) => string;
  sessions: SessionInfo[];
  management: SessionManagementState | null;
  enabled: boolean;
  onAction: (action: DesktopTrayAction) => Promise<void | boolean>;
  onError: (error: unknown) => void;
}) {
  const current = useRef(options);
  current.current = options;
  const pump = useMemo(() => createTrayActionPump({
    take: takeDesktopTrayAction,
    canHandle: () => current.current.enabled,
    handle: (action) => current.current.onAction(action),
    onError: (error) => current.current.onError(error),
  }), []);
  const sink = useMemo(() => createTrayMenuSink(syncDesktopTrayMenu), []);
  const { translate } = options;
  const menu = useMemo<DesktopTrayMenu>(() => ({
    locale: options.locale,
    labels: {
      show: translate("desktopTray.show"),
      newSession: translate("desktopTray.newSession"),
      recentSessions: translate("desktopTray.recentSessions"),
      emptyRecent: translate("desktopTray.emptyRecent"),
      minimizeOnClose: translate("desktopTray.minimizeOnClose"),
      quit: translate("desktopTray.quit"),
    },
    recentSessions: recentDesktopTraySessions(options.sessions, options.management),
  }), [options.locale, options.management, options.sessions, translate]);

  useEffect(() => {
    if (isDesktopApp() && options.localeReady) void sink.update(menu);
  }, [menu, options.localeReady, sink]);

  useEffect(() => {
    if (!isDesktopApp()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const wake = () => { void pump.resume(); };
    void listenDesktopTrayActions(wake).then((listener) => {
      if (disposed) listener?.(); else unlisten = listener;
    });
    // Focus only drains previously queued explicit tray clicks. Toasts/focus
    // alone never create a target and never change the selected conversation.
    window.addEventListener("focus", wake);
    pump.start();
    return () => { disposed = true; pump.stop(); unlisten?.(); window.removeEventListener("focus", wake); };
  }, [pump]);

  useEffect(() => {
    if (options.enabled && isDesktopApp()) void pump.resume();
  }, [options.enabled, pump]);
}
