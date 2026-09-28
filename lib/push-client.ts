/**
 * Client-side Web Push subscription. Called once when the Notification
 * permission is granted; silently no-ops on unsupported browsers (e.g. iOS
 * Safari < 16.4 or non-PWA contexts) so the existing in-page notification
 * path keeps working as a fallback.
 */

import { isDesktopApp } from "./desktop";

let activeSubscriptionPromise: Promise<boolean> | null = null;

// Standard base64url → Uint8Array conversion for applicationServerKey.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isPushSupported(): boolean {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

export async function setupPushSubscription(locale: string): Promise<boolean> {
  // The desktop shell delivers completion/attention events as native toasts
  // (see lib/desktop.ts). Subscribing there would push a second copy of the
  // same event through the browser push service, so Web Push stays off.
  if (isDesktopApp()) return false;
  if (!isPushSupported() || Notification.permission !== "granted") return false;
  if (activeSubscriptionPromise) return activeSubscriptionPromise;

  activeSubscriptionPromise = (async () => {
    try {
      const configResponse = await fetch("/api/push/config");
      if (!configResponse.ok) return false;
      const { publicKey } = await configResponse.json() as { publicKey?: string };
      if (!publicKey) return false;

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON(), locale }),
      });
      return response.ok;
    } catch {
      // Retry on the next trigger (e.g. the next permission grant) rather
      // than caching a transient failure forever.
      activeSubscriptionPromise = null;
      return false;
    }
  })();

  return activeSubscriptionPromise;
}

/**
 * Drop a Web Push subscription that was created before the desktop shell
 * switched to native toasts. A stale subscription would keep pushing a second
 * copy of every session-complete event; the push service reports the dead
 * endpoint on the next send (404/410) and the server prunes it.
 *
 * Safe to call unconditionally: it no-ops outside the desktop shell.
 */
export async function teardownDesktopPushSubscription(): Promise<void> {
  if (!isDesktopApp() || !isPushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // Best effort: the native toast path is the primary delivery either way.
  }
}
