import { randomUUID } from "node:crypto";
import {
  createMcpExtension,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionFactory,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";

export type McpAction = "login" | "logout" | "reconnect";
export type McpWebEvent =
  | { type: "notify"; level: "info" | "warning" | "error"; message: string }
  | { type: "auth"; url: string }
  | { type: "input"; token: string; title: string; placeholder: string }
  | { type: "done"; success: boolean }
  | { type: "error"; message: string };
export interface McpRuntimeStatus { available: boolean; statusText?: string; reason?: string }
export class McpRuntimeError extends Error {
  constructor(message: string, public readonly status = 409) { super(message); }
}

/** Never publish native error details: transports can include credentials and stderr. */
export function safeMcpStatus(text: string): string {
  const lines = text.split("\n").filter((line) =>
    /^[A-Za-z0-9_-]+: (?:starting|connecting|connected, \d+ tools|failed|disabled|disconnected, reconnects on next call|needs sign-in, run \/mcp login [A-Za-z0-9_-]+) \((?:codemode|deferred|direct|hidden)\)$/.test(line),
  );
  if (text.startsWith("No MCP servers configured.")) return "No MCP servers configured.";
  if (text.split("\n").some((line) => line.startsWith("config error:"))) {
    lines.push("Invalid MCP configuration; check mcp.json. Error details are not exposed here.");
  }
  return lines.join("\n") || "MCP status is unavailable. Use /mcp in the session for diagnostics.";
}

export function mcpAuthorizationUrl(message: string): string | undefined {
  if (!message.startsWith('Sign in to MCP server "')) return undefined;
  const value = message.split("\n").at(-1)?.trim();
  try {
    const url = new URL(value ?? "");
    if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return undefined;
    return url.href;
  } catch { return undefined; }
}

interface PendingInput {
  sessionId: string;
  expiresAt: number;
  finish: (value: string | undefined) => void;
}
declare global { var __piWebMcpInputs: Map<string, PendingInput> | undefined }
function inputs(): Map<string, PendingInput> {
  return globalThis.__piWebMcpInputs ??= new Map();
}
export function replyMcpInput(sessionId: string, token: string, value: string | null): boolean {
  const entry = inputs().get(token);
  if (!entry || entry.sessionId !== sessionId) return false;
  if (entry.expiresAt <= Date.now()) { entry.finish(undefined); return false; }
  entry.finish(value === null ? undefined : value);
  return true;
}
function requestInput(sessionId: string, emit: (event: McpWebEvent) => void, signals: AbortSignal[]): Promise<string | undefined> {
  if (signals.some((signal) => signal.aborted)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const token = randomUUID();
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      inputs().delete(token);
      clearTimeout(timer);
      signals.forEach((signal) => signal.removeEventListener("abort", onAbort));
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    const timer = setTimeout(onAbort, 300_000);
    timer.unref?.();
    inputs().set(token, { sessionId, expiresAt: Date.now() + 300_000, finish });
    signals.forEach((signal) => signal.addEventListener("abort", onAbort, { once: true }));
    try { emit({ type: "input", token, title: "Complete MCP sign-in", placeholder: "http://127.0.0.1:.../callback?code=..." }); }
    catch { finish(undefined); }
  });
}

type Binding = { handler: RegisteredCommand["handler"]; context: ExtensionContext };
const unsupported = (): never => { throw new McpRuntimeError("Session replacement is not available from MCP management"); };

/** A facade around the official /mcp handler, never a second MCP client or auth implementation. */
export class McpWebRuntime {
  private binding: Binding | undefined;
  private active: AbortController | undefined;
  isAvailable(): boolean { return Boolean(this.binding); }
  isBusy(): boolean { return Boolean(this.active); }
  cancel(): void { this.active?.abort(); }

  createExtension(factory: ExtensionFactory = createMcpExtension({ openUrl: () => {} })): ExtensionFactory {
    return async (pi) => {
      let handler: RegisteredCommand["handler"] | undefined;
      const facade: ExtensionAPI = {
        ...pi,
        registerCommand: (name, command) => {
          if (name === "mcp") handler = command.handler;
          pi.registerCommand(name, command);
        },
      };
      await factory(facade);
      // Resource-loader probes must not bind discarded/replaced factories.
      pi.on("session_start", (_event, context) => {
        this.cancel();
        this.binding = handler ? { handler, context } : undefined;
      });
      pi.on("session_shutdown", () => {
        if (this.binding?.handler !== handler) return;
        this.cancel();
        this.binding = undefined;
      });
    };
  }

  private context(binding: Binding, ui: ExtensionContext["ui"], signal?: AbortSignal): ExtensionCommandContext {
    // Inherit live getters rather than snapshotting model/session properties.
    return Object.assign(Object.create(binding.context), {
      ui, signal, mode: "rpc", hasUI: true,
      getSystemPromptOptions: unsupported,
      waitForIdle: async () => {}, newSession: unsupported, fork: unsupported,
      navigateTree: unsupported, switchSession: unsupported, reload: unsupported,
    }) as ExtensionCommandContext;
  }

  async status(timeoutMs = 2000): Promise<McpRuntimeStatus> {
    const binding = this.binding;
    if (!binding) return { available: false, reason: "Built-in MCP is not active in this session. It may be disabled or replaced." };
    let text = "";
    const abort = new AbortController();
    const ui = Object.assign(Object.create(binding.context.ui), {
      notify: (message: string, type?: string) => {
        if (this.binding === binding && type !== "error") text = safeMcpStatus(message);
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([
        Promise.resolve(binding.handler("", this.context(binding, ui, abort.signal))).then(() => true, () => false),
        new Promise<false>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve(false); }, timeoutMs); }),
      ]);
      if (this.binding !== binding) return { available: false, reason: "Session MCP runtime changed; refresh the status." };
      return completed ? { available: true, statusText: text || "No MCP status reported." }
        : { available: false, reason: "MCP is still connecting or its status is temporarily unavailable. Try refresh later." };
    } finally { clearTimeout(timer); abort.abort(); }
  }

  async action(sessionId: string, action: McpAction, name: string, signal: AbortSignal, emit: (event: McpWebEvent) => void): Promise<boolean> {
    if (!["login", "logout", "reconnect"].includes(action) || !/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new McpRuntimeError("Invalid MCP action or server name", 400);
    }
    const binding = this.binding;
    if (!binding) throw new McpRuntimeError("Built-in MCP is not active in this session");
    if (this.active) throw new McpRuntimeError("Another MCP action is running");
    if (signal.aborted) return false;
    const abort = new AbortController();
    this.active = abort;
    const onAbort = () => abort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let success = true;
    const send = (event: McpWebEvent) => {
      if (!abort.signal.aborted && this.binding === binding) emit(event);
    };
    const ui = Object.assign(Object.create(binding.context.ui), {
      notify: (message: string, level: "info" | "warning" | "error" = "info") => {
        if (level === "error") {
          success = false;
          send({ type: "notify", level, message: "MCP action failed. Use /mcp in the session for server-side diagnostics." });
          return;
        }
        const url = action === "login" ? mcpAuthorizationUrl(message) : undefined;
        if (url) { send({ type: "auth", url }); return; }
        if (message.startsWith('Sign in to MCP server "')) {
          success = false;
          send({ type: "error", message: "OAuth authorization requires HTTPS or loopback HTTP without embedded credentials." });
          abort.abort();
          return;
        }
        if (message === "Sign-in cancelled.") success = false;
        // Even successful native messages must not pass through future transport details.
        send({ type: "notify", level, message: message === "Sign-in cancelled." ? "Sign-in cancelled." : "MCP operation status updated." });
      },
      input: (_title: string, _placeholder?: string, options?: { signal?: AbortSignal }) =>
        requestInput(sessionId, send, [abort.signal, ...(options?.signal ? [options.signal] : [])]),
      select: async () => undefined,
      confirm: async () => false,
    });
    try {
      await binding.handler(`${action} ${name}`, this.context(binding, ui, abort.signal));
      return success && !abort.signal.aborted && this.binding === binding;
    } catch {
      send({ type: "error", message: "MCP action failed. No credentials or server error details are exposed here." });
      return false;
    } finally {
      abort.abort();
      signal.removeEventListener("abort", onAbort);
      if (this.active === abort) this.active = undefined;
    }
  }
}
