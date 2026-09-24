import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { createDesktopUpdateManifest } from "./scripts/create-desktop-update-manifest.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { checkDesktopUpdate } = await jiti.import("./lib/desktop-update.ts");

test("regular browsers cannot check or install native desktop updates", async (t) => {
  const oldWindow = globalThis.window;
  globalThis.window = {};
  t.after(() => { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; });
  assert.equal(await checkDesktopUpdate(), null);
});

test("desktop update manifest only names a matching signed NSIS release", () => {
  const version = "0.9.21";
  const tag = `desktop-v${version}`;
  const installerName = `Pi Web Desktop_${version}_x64-setup.exe`;
  const signature = "untrusted comment: signed update\nABC123";
  const manifest = createDesktopUpdateManifest({ version, tag, installerName, signature });
  assert.deepEqual(manifest, {
    version,
    platforms: {
      "windows-x86_64": {
        signature,
        url: `https://github.com/ghost0211/pi-web/releases/download/${tag}/Pi.Web.Desktop_${version}_x64-setup.exe`,
      },
    },
  });
  assert.throws(() => createDesktopUpdateManifest({ version, tag: "desktop-v0.9.19", installerName, signature }), /tag/);
  assert.throws(() => createDesktopUpdateManifest({ version, tag, installerName: "evil.exe", signature }), /installer name/);
  assert.throws(() => createDesktopUpdateManifest({ version, tag, installerName, signature: "" }), /signature/);
});

test("desktop updater is signed, confined to the local WebView and publishes its feed", async () => {
  const config = JSON.parse(await readFile(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const capability = JSON.parse(await readFile(new URL("./src-tauri/capabilities/desktop-remote.json", import.meta.url), "utf8"));
  const rust = await readFile(new URL("./src-tauri/src/main.rs", import.meta.url), "utf8");
  const workflow = await readFile(new URL("./.github/workflows/desktop-windows.yml", import.meta.url), "utf8");
  const about = await readFile(new URL("./components/AboutConfig.tsx", import.meta.url), "utf8");
  const shell = await readFile(new URL("./components/AppShell.tsx", import.meta.url), "utf8");

  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.match(Buffer.from(config.plugins.updater.pubkey, "base64").toString("utf8"), /minisign public key/);
  assert.deepEqual(config.plugins.updater.endpoints, ["https://github.com/ghost0211/pi-web/releases/latest/download/desktop-latest.json"]);
  assert.deepEqual(capability.remote.urls, ["http://127.0.0.1:*", "http://localhost:*"]);
  assert.ok(capability.permissions.includes("updater:default"));
  assert.match(rust, /\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\)/);
  assert.match(workflow, /secrets\.TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /src-tauri\/target\/release\/bundle\/nsis\/\*\.exe\.sig/);
  assert.match(workflow, /desktop-latest\.json/);
  assert.match(workflow, /gh release create[^\n]*[\s\S]*?--draft --verify-tag/);
  assert.match(workflow, /gh release edit "\$GITHUB_REF_NAME" --draft=false --latest/);
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""/);
  assert.match(about, /installDesktopUpdate\(desktopUpdate/);
  assert.match(shell, /<DesktopUpdatePrompt \/>/);
});
