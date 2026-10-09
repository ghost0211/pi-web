import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  WEB_APP_DISPLAY_NAME,
  DESKTOP_APP_DISPLAY_NAME,
  appDisplayName,
} = await jiti.import("./app-brand.ts");

const sidebarSource = await readFile(new URL("../components/SessionSidebar.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const aboutServiceSource = await readFile(new URL("./about-service.ts", import.meta.url), "utf8");
const rustSource = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

test("defines separate web and desktop runtime display names", () => {
  assert.equal(WEB_APP_DISPLAY_NAME, "Pi Web");
  assert.equal(DESKTOP_APP_DISPLAY_NAME, "Pi Desktop");
  assert.equal(appDisplayName(false), "Pi Web");
  assert.equal(appDisplayName(true), "Pi Desktop");
});

test("sidebar brand switches to Pi Desktop only after hydration-safe shell detection", () => {
  assert.match(sidebarSource, /function AppBrandTitle\(\) \{\s+const desktop = useIsDesktopApp\(\);\s+const appName = appDisplayName\(desktop\);/);
  assert.match(sidebarSource, /title=\{`\$\{appName\} \$\{process\.env\.NEXT_PUBLIC_APP_VERSION \?\? ""\}`\}/);
  assert.match(sidebarSource, /<span>\{appName\}<\/span>/);
  assert.doesNotMatch(sidebarSource, /function PiWebTitle\(/);
});

test("window title and chat empty state use the same runtime brand", () => {
  assert.match(appShellSource, /const desktopShell = useIsDesktopApp\(\);\s+const appName = appDisplayName\(desktopShell\);/);
  assert.match(appShellSource, /const windowTitle = activeCwdName \? `\$\{activeCwdName\} - \$\{appName\}` : appName;/);
  assert.match(appShellSource, /\|\| appName\}/);
  assert.match(chatWindowSource, /<h1 className="mb-16 text-\[32px\] font-semibold tracking-\[-0\.03em\] text-text">\{appName\}<\/h1>/);
});

test("about data and native shell surfaces use Pi Desktop without renaming installer identity", () => {
  assert.match(aboutServiceSource, /appName: appDisplayName\(isDesktop\)/);
  assert.match(rustSource, /const DESKTOP_DISPLAY_NAME: &str = "Pi Desktop";/);
  assert.match(rustSource, /\.tooltip\(DESKTOP_DISPLAY_NAME\)/);
  assert.match(rustSource, /\.title\(DESKTOP_DISPLAY_NAME\)/);
  assert.match(rustSource, /format!\("Show \{DESKTOP_DISPLAY_NAME\}"\)/);
  // Installer, Start Menu entry, install directory, and updater asset naming stay compatible.
  assert.equal(tauriConfig.productName, "Pi Web Desktop");
});
