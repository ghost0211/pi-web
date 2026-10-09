/**
 * Runtime display names for the web UI and the native desktop shell.
 *
 * The installer/package identity remains "Pi Web Desktop" for upgrade and
 * install-location compatibility; only the in-app display name is shorter.
 */
export const WEB_APP_DISPLAY_NAME = "Pi Web";
export const DESKTOP_APP_DISPLAY_NAME = "Pi Desktop";

export function appDisplayName(isDesktop: boolean): string {
  return isDesktop ? DESKTOP_APP_DISPLAY_NAME : WEB_APP_DISPLAY_NAME;
}
