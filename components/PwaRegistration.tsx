"use client";

import { useEffect } from "react";

export function PwaRegistration() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Check if there are stale caches from older builds and purge them
    if ("caches" in window) {
      caches.keys().then((keys) => {
        const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.9.0";
        const currentCache = `pi-web-static-${appVersion}`;
        for (const key of keys) {
          if (key.startsWith("pi-web-") && key !== currentCache) {
            caches.delete(key);
          }
        }
      }).catch(() => {});
    }

    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) {
      return;
    }

    const register = () => {
      const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.9.0";
      const scriptUrl = `/sw.js?v=${encodeURIComponent(appVersion)}`;

      void navigator.serviceWorker.register(scriptUrl, {
        scope: "/",
        updateViaCache: "none",
      }).then((reg) => {
        reg.update().catch(() => {});
      }).catch((error: unknown) => {
        console.error("Failed to register the Pi Web service worker:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
