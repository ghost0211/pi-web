import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { collectUpdaterArtifacts, createDesktopUpdateManifest } from "./scripts/create-desktop-update-manifest.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { checkDesktopUpdate } = await jiti.import("./lib/desktop-update.ts");

test("regular browsers cannot check or install native desktop updates", async (t) => {
  const oldWindow = globalThis.window;
  globalThis.window = {};
  t.after(() => { if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; });
  assert.equal(await checkDesktopUpdate(), null);
});

test("desktop update manifest covers the signed Windows and Linux bundles", async () => {
  const version = "0.9.21";
  const tag = `desktop-v${version}`;
  const dir = join(tmpdir(), `pi-web-updater-${process.pid}`);
  const nsis = join(dir, "nsis");
  const linux = join(dir, "appimage");
  await mkdir(nsis, { recursive: true });
  await mkdir(linux, { recursive: true });
  try {
    const exe = `Pi Web Desktop_${version}_x64-setup.exe`;
    const appimage = `Pi Web Desktop_${version}_x86_64.AppImage`;
    await writeFile(join(nsis, exe), "exe");
    await writeFile(join(nsis, `${exe}.sig`), "untrusted comment: signed update\nWINDOWS");
    await writeFile(join(linux, appimage), "appimage");
    await writeFile(join(linux, `${appimage}.sig`), "untrusted comment: signed update\nLINUX");
    // The .deb ships to repositories but is not the updater target.
    await writeFile(join(dir, `Pi Web Desktop_${version}_amd64.deb`), "deb");

    const artifacts = [
      ...collectUpdaterArtifacts(nsis),
      ...collectUpdaterArtifacts(linux),
    ].sort((a, b) => a.platform.localeCompare(b.platform));
    assert.deepEqual(artifacts.map((a) => a.platform).sort(), ["linux-x86_64", "windows-x86_64"]);

    const manifest = createDesktopUpdateManifest({ version, tag, platforms: artifacts });
    assert.equal(manifest.version, version);
    assert.equal(
      manifest.platforms["windows-x86_64"].url,
      `https://github.com/ghost0211/pi-web/releases/download/${tag}/Pi.Web.Desktop_${version}_x64-setup.exe`,
    );
    assert.equal(
      manifest.platforms["linux-x86_64"].url,
      `https://github.com/ghost0211/pi-web/releases/download/${tag}/Pi.Web.Desktop_${version}_x86_64.AppImage`,
    );
    assert.equal(manifest.platforms["windows-x86_64"].signature, "untrusted comment: signed update\nWINDOWS");
    assert.equal(manifest.platforms["linux-x86_64"].signature, "untrusted comment: signed update\nLINUX");
    assert.throws(
      () => createDesktopUpdateManifest({ version, tag: "desktop-v0.9.19", platforms: artifacts }),
      /tag/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  assert.ok(workflow.includes('notes_file="docs/releases/v${version}.md"'));
  assert.ok(workflow.includes('notes_args=(--generate-notes)'));
  assert.ok(workflow.includes('notes_args=(--notes-file "$notes_file")'));
  assert.ok(workflow.includes('"${notes_args[@]}"'));
  assert.ok(workflow.includes('gh release edit "$GITHUB_REF_NAME" --notes-file "$notes_file"'));
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""/);
  assert.match(about, /installDesktopUpdate\(desktopUpdate/);
  assert.match(shell, /<DesktopUpdatePrompt \/>/);
});
