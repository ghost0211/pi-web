/**
 * Boot the packaged desktop server and require it to answer a real API request.
 *
 * The v0.9.68 bundle copied only the standalone trace, which omitted an async
 * chunk that the instrumentation hook imports at startup. Nothing in the build
 * noticed: the files were present, tsc and the unit suite passed, and the
 * installer was produced — the breakage only appeared when a *.jsonl session
 * list was requested (`HTTP 500`, `Cannot find module './chunks/6429.js'`).
 *
 * A copy comparison cannot catch that, because the traced subset is internally
 * consistent. Only loading the server the way the desktop shell does proves the
 * bundle runs, so this script starts it on a scratch port and calls
 * `/api/session-management`.
 *
 * Usage: node scripts/desktop-server-smoke.mjs <serverDir> [timeoutMs]
 * Exit 0 = the packaged server answered; 1 = it did not (reason on stderr).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const serverDir = process.argv[2];
const timeoutMs = Number(process.argv[3] ?? 60_000);
if (!serverDir) {
  console.error("desktop-server-smoke: pass the packaged server directory");
  process.exit(1);
}
const entry = join(serverDir, "server.js");
if (!existsSync(entry)) {
  console.error(`desktop-server-smoke: ${entry} is missing`);
  process.exit(1);
}

// A high port that CI runners are unlikely to occupy; the smoke retries once.
const basePort = 39_000 + (process.pid % 500);
const probePath = "/api/session-management";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(port, signal) {
  const response = await fetch(`http://127.0.0.1:${port}${probePath}`, { signal });
  const body = await response.text();
  return { status: response.status, body: body.slice(0, 400) };
}

let child;
let output = "";
function startServer(port) {
  output = "";
  child = spawn(process.execPath, ["server.js"], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), PI_WEB_NO_OPEN: "1", PI_WEB_SKIP_VERSION_CHECK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    output += String(chunk);
    if (output.length > 20_000) output = output.slice(-20_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (error) => {
    output += `\nspawn error: ${error instanceof Error ? error.message : String(error)}`;
  });
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill();
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    wait(5_000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

async function attempt(port) {
  startServer(port);
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      lastError = `server exited with ${child.exitCode}`;
      break;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const result = await probe(port, controller.signal);
      if (result.status === 200) return { ok: true };
      // 500 with a module error is the regression this guards; retry a 5xx
      // briefly in case the server is still warming up, then report it.
      lastError = `HTTP ${result.status}: ${result.body}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    await wait(500);
  }
  return { ok: false, error: lastError };
}

let result = await attempt(basePort);
await stopServer();
if (!result.ok && /EADDRINUSE/i.test(output)) {
  result = await attempt(basePort + 501);
  await stopServer();
}

if (result.ok) {
  console.log(`desktop-server-smoke: ${probePath} answered 200 from the packaged server`);
  process.exit(0);
}

console.error(`desktop-server-smoke: the packaged server did not answer ${probePath}: ${result.error}`);
console.error("--- server output (tail) ---");
console.error(output.slice(-4_000));
process.exit(1);
