import { spawn } from "node:child_process";
import { jsonResponse } from "@/lib/json-response";

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 180_000;

/**
 * POST — refresh the shared pi model catalogs (`pi update --models`). Both the
 * CLI and pi-web read the same catalog cache under the agent dir, so this
 * picks up newly released models without a terminal window.
 */
export async function POST(request: Request) {
  const isWindows = process.platform === "win32";
  const result = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    spawnError?: string;
    timedOut?: boolean;
  }>((resolve) => {
    let proc;
    try {
      proc = spawn("pi", ["update", "--models"], { shell: isWindows, windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", spawnError: String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: { code: number | null; timedOut?: boolean; spawnError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...value, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish({ code: null, timedOut: true });
    }, TIMEOUT_MS);
    proc.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    proc.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    proc.on("error", (error) => finish({ code: null, spawnError: String(error) }));
    proc.on("close", (code) => finish({ code }));
  });

  const tail = (text: string) => text.trim().split(/\r?\n/).slice(-6).join("\n");
  if (result.spawnError) {
    return jsonResponse(request, {
      success: false,
      error: `pi CLI not available: ${result.spawnError}`,
    }, { status: 400 });
  }
  if (result.timedOut) {
    return jsonResponse(request, { success: false, error: "pi update --models timed out (180s)" }, { status: 504 });
  }
  if (result.code !== 0) {
    return jsonResponse(request, {
      success: false,
      error: tail(result.stderr || result.stdout) || `pi update --models exited with code ${result.code ?? "?"}`,
    }, { status: 502 });
  }
  return jsonResponse(request, { success: true, output: tail(result.stdout) });
}
