import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
const { McpWebRuntime, safeMcpStatus, mcpAuthorizationUrl, replyMcpInput } = await createJiti(import.meta.url).import("./mcp-web-runtime.ts");

async function harness(runtime, handler, nativeFactory) {
  const hooks = new Map();
  const context = { ui: { notify() {} }, cwd: process.cwd(), isProjectTrusted: () => false, modelRegistry: {} };
  const api = {
    registerCommand() {},
    on(name, callback) { const list = hooks.get(name) ?? []; list.push(callback); hooks.set(name, list); },
    getMcpServers: () => [], getAllTools: () => [], getActiveTools: () => [],
    setActiveTools() {}, registerTool() {}, registerToolRenderer() {},
  };
  await runtime.createExtension(nativeFactory ?? ((pi) => pi.registerCommand("mcp", { description: "Fixture", handler })))(api);
  const emit = async (name) => { for (const callback of hooks.get(name) ?? []) await callback({ type: name }, context); };
  return { emit, context };
}

test("factory probes do not bind MCP; real startup/shutdown does", async () => {
  const runtime = new McpWebRuntime();
  const h = await harness(runtime, (_args, ctx) => ctx.ui.notify("demo: connected, 2 tools (codemode)", "info"));
  assert.equal(runtime.isAvailable(), false);
  await h.emit("session_start");
  assert.deepEqual(await runtime.status(), { available: true, statusText: "demo: connected, 2 tools (codemode)" });
  await h.emit("session_shutdown");
  assert.equal(runtime.isAvailable(), false);
});

test("status never exposes native configuration/transport error secrets", () => {
  const text = "demo: failed (codemode)\n    Authorization: Bearer secret\nconfig error: key=private-value\nother: needs sign-in, run /mcp login other (deferred)";
  const safe = safeMcpStatus(text);
  assert.match(safe, /demo: failed/);
  assert.match(safe, /other: needs sign-in/);
  assert.match(safe, /Invalid MCP configuration/);
  assert.doesNotMatch(safe, /secret|private-value|Authorization/);
  assert.equal(safeMcpStatus("No MCP servers configured. Add them to /private/path."), "No MCP servers configured.");
});

test("only an official sign-in notification can expose a safe browser URL", () => {
  assert.equal(mcpAuthorizationUrl('Sign in to MCP server "demo" in your browser:\nhttps://example.test/auth?state=fixture'), "https://example.test/auth?state=fixture");
  assert.equal(mcpAuthorizationUrl('Sign in to MCP server "demo" in your browser:\njavascript:alert(1)'), undefined);
  assert.equal(mcpAuthorizationUrl('Sign in to MCP server "demo" in your browser:\nhttps://user:password@example.test/'), undefined);
  assert.equal(mcpAuthorizationUrl("https://example.test/auth"), undefined);
});

test("status has a finite wait and ignores late stale-generation notifications", async () => {
  const runtime = new McpWebRuntime();
  let finish;
  const h = await harness(runtime, async (_args, ctx) => { await new Promise((resolve) => { finish = resolve; }); ctx.ui.notify("old: connected, 1 tools (direct)"); });
  await h.emit("session_start");
  const result = await runtime.status(5);
  assert.equal(result.available, false);
  await h.emit("session_shutdown");
  finish();
  assert.equal((await runtime.status()).available, false);
});

test("native error notifications are failures, not successful handler returns", async () => {
  const runtime = new McpWebRuntime();
  const h = await harness(runtime, (_args, ctx) => ctx.ui.notify("Bearer private-token in https://example.test/?key=secret", "error"));
  await h.emit("session_start");
  const events = [];
  assert.equal(await runtime.action("sid", "reconnect", "demo", new AbortController().signal, (event) => events.push(event)), false);
  assert.doesNotMatch(JSON.stringify(events), /private-token|key=secret/);
});

test("OAuth input tokens are session-bound, single-use, and cleaned up after reply", async () => {
  const runtime = new McpWebRuntime();
  let value;
  const h = await harness(runtime, async (_args, ctx) => { value = await ctx.ui.input("Native title"); });
  await h.emit("session_start");
  const events = [];
  const pending = runtime.action("sid", "login", "demo", new AbortController().signal, (event) => events.push(event));
  const token = events.find((event) => event.type === "input").token;
  assert.equal(replyMcpInput("wrong", token, "code"), false);
  assert.equal(replyMcpInput("sid", token, "http://127.0.0.1/callback?code=fixture"), true);
  assert.equal(await pending, true);
  assert.equal(value, "http://127.0.0.1/callback?code=fixture");
  assert.equal(replyMcpInput("sid", token, "again"), false);
});

test("disconnect and session shutdown cancel inputs and block concurrent actions", async () => {
  const runtime = new McpWebRuntime();
  const h = await harness(runtime, async (_args, ctx) => { await ctx.ui.input("Redirect URL"); });
  await h.emit("session_start");
  const events = [];
  const abort = new AbortController();
  const pending = runtime.action("sid", "login", "demo", abort.signal, (event) => events.push(event));
  await assert.rejects(runtime.action("sid", "logout", "demo", new AbortController().signal, () => {}), /Another MCP action/);
  const token = events[0].token;
  abort.abort();
  assert.equal(await pending, false);
  assert.equal(replyMcpInput("sid", token, "late"), false);
  assert.equal(runtime.isBusy(), false);
  const next = runtime.action("sid", "login", "demo", new AbortController().signal, () => {});
  await h.emit("session_shutdown");
  assert.equal(await next, false);
});

test("real official SDK stdio status/reconnect uses no model prompts and closes the server", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-mcp-runtime-"));
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; rmSync(root, { recursive: true, force: true }); });
  const file = join(root, "fixture.mjs");
  writeFileSync(file, `import readline from 'node:readline';
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});\n`);
  const runtime = new McpWebRuntime();
  const h = await harness(runtime, undefined, createMcpExtension({
    loadConfig: () => ({ servers: [{ name: "fixture", scope: "global", source: "fixture", config: { command: process.execPath, args: [file], timeout: 3 } }], errors: [] }),
    logPath: join(root, "mcp.log"), openUrl: () => {},
  }));
  t.after(() => h.emit("session_shutdown"));
  await h.emit("session_start");
  const result = await runtime.status(5000);
  assert.match(result.statusText, /fixture: connected, 0 tools/);
  assert.equal(await runtime.action("fixture-session", "reconnect", "fixture", new AbortController().signal, () => {}), true);
  assert.match((await runtime.status()).statusText, /fixture: connected/);
  await h.emit("session_shutdown");
  assert.equal(runtime.isAvailable(), false);
});
