import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseBaseUrl = "https://github.com/ghost0211/pi-web/releases/download";

/** Static Tauri updater feed for the newest signed Windows desktop release. */
export function createDesktopUpdateManifest({ version, tag, installerName, signature }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `desktop-v${version}`) {
    throw new Error("Updater tag must match the desktop package version");
  }
  if (installerName !== `Pi Web Desktop_${version}_x64-setup.exe`) {
    throw new Error("Unexpected Windows NSIS installer name");
  }
  if (!signature.trim()) throw new Error("Missing Tauri updater signature");
  // GitHub normalizes spaces to dots in release asset filenames on upload.
  const releaseAssetName = installerName.replaceAll(" ", ".");

  return {
    version,
    platforms: {
      "windows-x86_64": {
        signature: signature.trim(),
        url: `${releaseBaseUrl}/${encodeURIComponent(tag)}/${encodeURIComponent(releaseAssetName)}`,
      },
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
  const tag = process.env.GITHUB_REF_NAME;
  const bundleDir = resolve(process.argv[2] ?? join(repoRoot, "src-tauri/target/release/bundle/nsis"));
  const installerName = `Pi Web Desktop_${version}_x64-setup.exe`;
  if (!readdirSync(bundleDir).includes(installerName)) throw new Error(`Missing ${installerName}`);
  const signature = readFileSync(join(bundleDir, `${installerName}.sig`), "utf8");
  const manifest = createDesktopUpdateManifest({ version, tag, installerName, signature });
  writeFileSync(join(bundleDir, "desktop-latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updater manifest ready for ${tag}`);
}
