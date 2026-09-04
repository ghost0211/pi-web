import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const configDir = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(configDir, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(configDir, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const allowedDevOrigins = [
  "127.0.0.1",
  ...(process.env.PI_WEB_ALLOWED_DEV_ORIGINS?.split(",") ?? []),
]
  .map((origin) => origin.trim())
  .filter((origin) => origin && !/[\s/@\\]/.test(origin));

const nextConfig: NextConfig = {
  outputFileTracingRoot: configDir,
  // Only the desktop (Tauri) build needs the self-contained standalone server;
  // keep it out of the npm release build so `next start` output stays as-is.
  ...(process.env.PI_WEB_STANDALONE_BUILD === "1" ? { output: "standalone" as const } : {}),
  // The pi SDK reads theme JSONs and other assets via dynamically computed
  // paths, which @vercel/nft cannot statically detect — force-include the SDK
  // dist trees so the standalone (desktop) server is complete. Only affects
  // server trace output; regular `next build` / `next start` are unaffected.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@earendil-works/pi-coding-agent/dist/**/*",
      // pi-ai intentionally hides OAuth/Bedrock flow imports behind variable
      // specifiers. npm currently installs this runtime as a nested dependency
      // of pi-coding-agent, so the top-level pi-ai include below is not enough.
      "./node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/**/*",
      "./node_modules/@earendil-works/pi-agent-core/dist/**/*",
      "./node_modules/@earendil-works/pi-ai/dist/**/*",
      "./node_modules/@earendil-works/pi-tui/dist/**/*",
      "./node_modules/@earendil-works/pi-telemetry/dist/**/*",
    ],
  },
  serverExternalPackages: [
    "undici",
    "web-push",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  // Next 16 blocks cross-origin development requests by default. Keep the
  // default narrow and require operators to opt additional hosts in.
  allowedDevOrigins,
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
