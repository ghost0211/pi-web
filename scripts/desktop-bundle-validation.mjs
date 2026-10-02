import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

const PI_AI_LAYOUTS = [
  ["@earendil-works", "pi-ai"],
  ["@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai"],
];

const QUICKJS_WASM_LAYOUTS = [
  ["quickjs-wasi"],
  ["@earendil-works", "pi-coding-agent", "node_modules", "quickjs-wasi"],
  ["@earendil-works", "pi-codemode", "node_modules", "quickjs-wasi"],
  ["@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-codemode", "node_modules", "quickjs-wasi"],
];

const PHOTON_WASM_LAYOUTS = [
  ["@silvia-odwyer", "photon-node"],
  ["@earendil-works", "pi-coding-agent", "node_modules", "@silvia-odwyer", "photon-node"],
];

const PI_DOCS_LAYOUTS = [
  ["@earendil-works", "pi-coding-agent", "docs"],
];

const PI_CODEMODE_LAYOUTS = [
  ["@earendil-works", "pi-codemode"],
  ["@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-codemode"],
];

const PI_CODING_AGENT_LAYOUTS = [
  ["@earendil-works", "pi-coding-agent"],
];

export const PI_RUNTIME_PACKAGE_LAYOUTS = [
  // pi-codemode: hoisted and SDK-nested
  { name: "@earendil-works/pi-codemode", layout: ["@earendil-works", "pi-codemode"] },
  { name: "@earendil-works/pi-codemode", layout: ["@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-codemode"] },

  // pi-mcp: hoisted and SDK-nested
  { name: "@earendil-works/pi-mcp", layout: ["@earendil-works", "pi-mcp"] },
  { name: "@earendil-works/pi-mcp", layout: ["@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-mcp"] },

  // chord: hoisted and SDK-nested
  { name: "@earendil-works/chord", layout: ["@earendil-works", "chord"] },
  { name: "@earendil-works/chord", layout: ["@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "chord"] },

  // pi-telemetry: hoisted and SDK-nested
  { name: "@earendil-works/pi-telemetry", layout: ["@earendil-works", "pi-telemetry"] },
  { name: "@earendil-works/pi-telemetry", layout: ["@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-telemetry"] },

  // quickjs-wasi: hoisted, SDK-nested, and pi-codemode-nested
  { name: "quickjs-wasi", layout: ["quickjs-wasi"] },
  { name: "quickjs-wasi", layout: ["@earendil-works", "pi-coding-agent", "node_modules", "quickjs-wasi"] },
  { name: "quickjs-wasi", layout: ["@earendil-works", "pi-codemode", "node_modules", "quickjs-wasi"] },
  { name: "quickjs-wasi", layout: ["@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-codemode", "node_modules", "quickjs-wasi"] },

  // photon-node: hoisted and SDK-nested
  { name: "@silvia-odwyer/photon-node", layout: ["@silvia-odwyer", "photon-node"] },
  { name: "@silvia-odwyer/photon-node", layout: ["@earendil-works", "pi-coding-agent", "node_modules", "@silvia-odwyer", "photon-node"] },
];

function isPiRuntimeFile(relPath) {
  const base = basename(relPath);
  if (base === "package.json") return true;
  const ext = extname(relPath).toLowerCase();
  return ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".wasm" || ext === ".node";
}

function collectRuntimeFiles(dir, rel = "") {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const currentRel = rel ? join(rel, entry.name) : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRuntimeFiles(fullPath, currentRel));
    } else if (entry.isFile() && isPiRuntimeFile(currentRel)) {
      results.push(currentRel);
    }
  }
  return results;
}

function collectFiles(dir, rel = "") {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const currentRel = rel ? join(rel, entry.name) : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, currentRel));
    } else if (entry.isFile()) {
      results.push(currentRel);
    }
  }
  return results;
}

function verifyAssetFile(sourcePath, bundlePath, assetLabel) {
  const source = existsSync(sourcePath) ? statSync(sourcePath) : undefined;
  const bundle = existsSync(bundlePath) ? statSync(bundlePath) : undefined;
  if (!source?.isFile() || source.size === 0 || !bundle?.isFile() || bundle.size !== source.size) {
    throw new Error(
      `standalone output has missing or incomplete ${assetLabel} ${bundlePath} — check outputFileTracingIncludes`,
    );
  }
}

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
      const sourcePath = join(sourceOauthDir, moduleName);
      const source = statSync(sourcePath);
      const bundle = statSync(modulePath);
      if (!source.isFile() || source.size === 0 || !bundle.isFile() || bundle.size !== source.size) {
        throw new Error(
          `standalone output has missing or incomplete dynamic pi-ai module ${modulePath} — check outputFileTracingIncludes`,
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
  let checkedRuntimes = 0;
  for (const layout of QUICKJS_WASM_LAYOUTS) {
    const sourcePath = join(sourceNodeModulesDir, ...layout, "quickjs.wasm");
    if (!existsSync(sourcePath)) continue;
    checkedRuntimes += 1;
    const bundlePath = join(bundleNodeModulesDir, ...layout, "quickjs.wasm");
    verifyAssetFile(sourcePath, bundlePath, "Codemode asset");
  }
  if (checkedRuntimes === 0) {
    throw new Error("source installation contains no installed QuickJS Codemode runtime to validate");
  }
  return checkedRuntimes;
}

/**
 * Validates all WASM runtime assets required by the desktop standalone bundle:
 * QuickJS WASM (used by Codemode sandbox) and Photon WASM (used by image resize/convert).
 */
export function validatePiWasmAssets({ sourceNodeModulesDir, bundleNodeModulesDir }) {
  let checkedAssets = 0;

  for (const layout of QUICKJS_WASM_LAYOUTS) {
    const sourcePath = join(sourceNodeModulesDir, ...layout, "quickjs.wasm");
    if (!existsSync(sourcePath)) continue;
    checkedAssets += 1;
    const bundlePath = join(bundleNodeModulesDir, ...layout, "quickjs.wasm");
    verifyAssetFile(sourcePath, bundlePath, "WASM asset");
  }

  for (const layout of PHOTON_WASM_LAYOUTS) {
    const sourcePath = join(sourceNodeModulesDir, ...layout, "photon_rs_bg.wasm");
    if (!existsSync(sourcePath)) continue;
    checkedAssets += 1;
    const bundlePath = join(bundleNodeModulesDir, ...layout, "photon_rs_bg.wasm");
    verifyAssetFile(sourcePath, bundlePath, "WASM asset");
  }

  if (checkedAssets === 0) {
    throw new Error("source installation contains no installed WASM runtime assets to validate");
  }
  return checkedAssets;
}

/**
 * Validates dynamic workers and their runtime entry dependencies across both
 * 1.0 (pi-codemode worker + prelude/protocol/host/index) and 0.99 layout
 * (codemode worker in pi-coding-agent), plus image-resize-worker.
 */
export function validatePiDynamicWorkers({ sourceNodeModulesDir, bundleNodeModulesDir }) {
  let checkedWorkers = 0;

  // 1. Image resize worker and 0.99 codemode worker in pi-coding-agent
  for (const layout of PI_CODING_AGENT_LAYOUTS) {
    const imageWorkerPath = join(sourceNodeModulesDir, ...layout, "dist", "utils", "image-resize-worker.js");
    if (existsSync(imageWorkerPath)) {
      checkedWorkers += 1;
      const bundleWorkerPath = join(bundleNodeModulesDir, ...layout, "dist", "utils", "image-resize-worker.js");
      verifyAssetFile(imageWorkerPath, bundleWorkerPath, "dynamic worker asset");

      // Verify sibling dependencies of image-resize-worker when present in source (backwards compatible with older SDKs)
      const siblingDeps = ["image-resize-core.js", "exif-orientation.js", "photon.js"];
      for (const dep of siblingDeps) {
        const sourceDep = join(sourceNodeModulesDir, ...layout, "dist", "utils", dep);
        if (existsSync(sourceDep)) {
          const bundleDep = join(bundleNodeModulesDir, ...layout, "dist", "utils", dep);
          verifyAssetFile(sourceDep, bundleDep, "image resize worker dependency");
        }
      }
    }

    const codemodeWorker099 = join(sourceNodeModulesDir, ...layout, "dist", "extensions", "codemode", "worker.js");
    if (existsSync(codemodeWorker099)) {
      checkedWorkers += 1;
      const bundleWorker099 = join(bundleNodeModulesDir, ...layout, "dist", "extensions", "codemode", "worker.js");
      verifyAssetFile(codemodeWorker099, bundleWorker099, "dynamic worker asset");
    }
  }

  // 2. pi-codemode dynamic worker and its runtime entry dependencies
  for (const layout of PI_CODEMODE_LAYOUTS) {
    const codemodeDir = join(sourceNodeModulesDir, ...layout);
    const workerSource = join(codemodeDir, "dist", "runtime", "worker.js");
    if (!existsSync(workerSource)) continue;

    checkedWorkers += 1;
    const workerBundle = join(bundleNodeModulesDir, ...layout, "dist", "runtime", "worker.js");
    verifyAssetFile(workerSource, workerBundle, "dynamic worker asset");

    // Trace runtime entry dependencies of pi-codemode (not just worker alone)
    const runtimeDir = join(codemodeDir, "dist", "runtime");
    if (existsSync(runtimeDir)) {
      const runtimeFiles = readdirSync(runtimeDir).filter((file) => file.endsWith(".js") && file !== "worker.js");
      for (const file of runtimeFiles) {
        const srcPath = join(runtimeDir, file);
        const bndPath = join(bundleNodeModulesDir, ...layout, "dist", "runtime", file);
        verifyAssetFile(srcPath, bndPath, `dynamic worker runtime dependency`);
      }
    }

    const indexSource = join(codemodeDir, "dist", "index.js");
    if (existsSync(indexSource)) {
      const indexBundle = join(bundleNodeModulesDir, ...layout, "dist", "index.js");
      verifyAssetFile(indexSource, indexBundle, `dynamic worker runtime entry dependency`);
    }
  }

  if (checkedWorkers === 0) {
    throw new Error("source installation contains no dynamic worker runtimes to validate");
  }
  return checkedWorkers;
}

/**
 * Validates SDK documentation assets in the desktop standalone bundle.
 * Ensures all files in the docs/ directory are present and complete.
 */
export function validatePiDocs({ sourceNodeModulesDir, bundleNodeModulesDir }) {
  let checkedDocsDirs = 0;

  for (const layout of PI_DOCS_LAYOUTS) {
    const sourceDocsDir = join(sourceNodeModulesDir, ...layout);
    if (!existsSync(sourceDocsDir)) continue;
    checkedDocsDirs += 1;

    const bundleDocsDir = join(bundleNodeModulesDir, ...layout);
    if (!existsSync(bundleDocsDir)) {
      throw new Error(
        `standalone output is missing documentation directory ${bundleDocsDir} — check outputFileTracingIncludes`,
      );
    }

    const files = collectFiles(sourceDocsDir);
    if (files.length === 0) {
      throw new Error(`source documentation directory ${sourceDocsDir} contains no documentation files to validate`);
    }

    for (const relFile of files) {
      const sourceFile = join(sourceDocsDir, relFile);
      const bundleFile = join(bundleDocsDir, relFile);
      verifyAssetFile(sourceFile, bundleFile, `documentation asset`);
    }
  }

  if (checkedDocsDirs === 0) {
    throw new Error("source installation contains no installed documentation to validate");
  }
  return checkedDocsDirs;
}

/**
 * Validates full runtime packages (pi-codemode, pi-mcp, chord, pi-telemetry,
 * quickjs-wasi, photon-node) across hoisted and SDK-nested layouts (plus
 * pi-codemode-nested quickjs-wasi).
 *
 * Verifies that package.json and all runtime JS/WASM files in source exist in
 * the bundle, are regular non-empty files, and match source file size exactly.
 * Does not traverse into nested node_modules subdirectories.
 */
export function validatePiRuntimePackages({ sourceNodeModulesDir, bundleNodeModulesDir }) {
  let checkedPackages = 0;
  let checkedFiles = 0;

  for (const item of PI_RUNTIME_PACKAGE_LAYOUTS) {
    const sourcePkgDir = join(sourceNodeModulesDir, ...item.layout);
    if (!existsSync(sourcePkgDir) || !statSync(sourcePkgDir).isDirectory()) continue;

    checkedPackages += 1;
    const bundlePkgDir = join(bundleNodeModulesDir, ...item.layout);
    if (!existsSync(bundlePkgDir) || !statSync(bundlePkgDir).isDirectory()) {
      throw new Error(
        `standalone output is missing runtime package ${bundlePkgDir} — check outputFileTracingIncludes`,
      );
    }

    const files = collectRuntimeFiles(sourcePkgDir);
    if (!files.some((file) => basename(file) !== "package.json")) {
      throw new Error(
        `source runtime package ${sourcePkgDir} contains no runtime files to validate`,
      );
    }

    const sourcePkgJson = join(sourcePkgDir, "package.json");
    verifyAssetFile(sourcePkgJson, join(bundlePkgDir, "package.json"), "runtime package manifest");

    for (const relFile of files) {
      const sourcePath = join(sourcePkgDir, relFile);
      const bundlePath = join(bundlePkgDir, relFile);
      verifyAssetFile(sourcePath, bundlePath, `runtime package asset`);
      checkedFiles += 1;
    }
  }

  if (checkedPackages === 0) {
    throw new Error("source installation contains no Pi runtime packages to validate");
  }

  return { packages: checkedPackages, files: checkedFiles };
}
