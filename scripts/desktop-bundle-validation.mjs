import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PI_AI_LAYOUTS = [
  ["@earendil-works", "pi-ai"],
  ["@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai"],
];

/**
 * Verify every installed pi-ai runtime keeps all OAuth modules in the desktop
 * standalone bundle. pi-ai loads the flow implementations through variable
 * dynamic imports, which Next/@vercel/nft deliberately cannot discover.
 */
export function validatePiAiOAuthModules({ sourceNodeModulesDir, bundleNodeModulesDir }) {
  let checkedPiAiRuntimes = 0;

  for (const layout of PI_AI_LAYOUTS) {
    const sourceOauthDir = join(sourceNodeModulesDir, ...layout, "dist", "auth", "oauth");
    if (!existsSync(join(sourceOauthDir, "load.js"))) continue;
    checkedPiAiRuntimes += 1;

    const bundleOauthDir = join(bundleNodeModulesDir, ...layout, "dist", "auth", "oauth");
    const expectedModules = readdirSync(sourceOauthDir)
      .filter((name) => name.endsWith(".js"))
      .sort();
    for (const moduleName of expectedModules) {
      const modulePath = join(bundleOauthDir, moduleName);
      if (!existsSync(modulePath)) {
        throw new Error(
          `standalone output is missing dynamic pi-ai module ${modulePath} — check outputFileTracingIncludes`,
        );
      }
    }
  }

  if (checkedPiAiRuntimes === 0) {
    throw new Error("standalone output contains no installed pi-ai OAuth runtime to validate");
  }
  return checkedPiAiRuntimes;
}

/** QuickJS's WASM is resolved dynamically by Codemode, outside the SDK dist tree. */
export function validatePiCodemodeAssets({ sourceNodeModulesDir, bundleNodeModulesDir }) {
  const layouts = [
    ["quickjs-wasi"],
    ["@earendil-works", "pi-coding-agent", "node_modules", "quickjs-wasi"],
  ];
  let checkedRuntimes = 0;
  for (const layout of layouts) {
    const sourcePath = join(sourceNodeModulesDir, ...layout, "quickjs.wasm");
    if (!existsSync(sourcePath)) continue;
    checkedRuntimes += 1;
    const bundlePath = join(bundleNodeModulesDir, ...layout, "quickjs.wasm");
    const source = statSync(sourcePath);
    const bundle = existsSync(bundlePath) ? statSync(bundlePath) : undefined;
    if (!source.isFile() || source.size === 0 || !bundle?.isFile() || bundle.size !== source.size) {
      throw new Error(
        `standalone output has missing or incomplete Codemode asset ${bundlePath} — check outputFileTracingIncludes`,
      );
    }
  }
  if (checkedRuntimes === 0) {
    throw new Error("source installation contains no installed QuickJS Codemode runtime to validate");
  }
  return checkedRuntimes;
}
