"use client";

import { useEffect, useState } from "react";

/** One clock per visible board, never one interval per running session. */
export function useLiveClock(enabled: boolean, now?: number): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled || now !== undefined) return;
    const update = () => setClock(Date.now());
    const interval = setInterval(update, 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible") update();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, now]);
  return now ?? clock;
}
