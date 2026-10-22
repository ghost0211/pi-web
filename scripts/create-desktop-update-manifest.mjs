import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseBaseUrl = "https://github.com/ghost0211/pi-web/releases/download";

/**
 * Static Tauri updater feed for a desktop release, one entry per published
 * platform. Windows keeps its historical `windows-x86_64` entry; Linux adds
 * `linux-x86_64` with the AppImage bundle.
 */
export function createDesktopUpdateManifest({ version, tag, platforms }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `desktop-v${version}`) {
    throw new Error("Updater tag must match the desktop package version");
  }
  const entries = {};
  for (const platform of platforms) {
    const releaseAssetName = platform.installerName.replaceAll(" ", ".");
    entries[platform.platform] = {
      signature: platform.signature.trim(),
      url: `${releaseBaseUrl}/${encodeURIComponent(tag)}/${encodeURIComponent(releaseAssetName)}`,
    };
  }
  return { version, platforms: entries };
}

/**
 * Read every signed updater artifact under the bundle directory. The Windows
 * NSIS installer and the Linux AppImage both produce `*.sig` next to the
 * bundle when `createUpdaterArtifacts` is on.
 */
export function collectUpdaterArtifacts(bundleDir) {
  const artifacts = [];
  if (!existsSync(bundleDir)) return artifacts;
  for (const entry of readdirSync(bundleDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sig")) continue;
    const installerName = entry.name.slice(0, -".sig".length);
    const installerPath = join(bundleDir, installerName);
    if (!existsSync(installerPath)) continue;
    const platform = /x64-setup\.exe$/.test(installerName)
      ? "windows-x86_64"
      : /x86_64\.AppImage$/.test(installerName)
        ? "linux-x86_64"
        : /x86_64\.deb$/.test(installerName)
          ? null // .deb is distribution-only; the updater feed points at AppImage.
          : null;
    if (!platform) continue;
    artifacts.push({
      platform,
      installerName,
      installerPath,
      signature: readFileSync(installerPath + ".sig", "utf8"),
    });
  }
  return artifacts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
  const tag = process.env.GITHUB_REF_NAME;
  const bundleDir = resolve(process.argv[2] ?? join(repoRoot, "src-tauri/target/release/bundle/nsis"));
  const artifacts = collectUpdaterArtifacts(bundleDir);
  if (artifacts.length === 0) {
    throw new Error(`No signed updater artifacts under ${bundleDir}`);
  }
  const manifest = createDesktopUpdateManifest({ version, tag, platforms: artifacts });
  writeFileSync(join(bundleDir, "desktop-latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updater manifest ready for ${tag}: ${artifacts.map((a) => basename(a.installerName)).join(", ")}`);
}
