import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { createJiti } from "jiti";
import { createMcpExtension } from "@earendil-works/pi-coding-agent";
const { McpWebRuntime, replyMcpInput } = await createJiti(import.meta.url).import("./mcp-web-runtime.ts");

for (const override of [false, true]) test(`official SDK OAuth login/input/logout shares its credential store using a loopback fixture${override ? " with a metadata override" : ""}`,  { timeout: 20000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-mcp-oauth-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(root, { recursive: true, force: true }); });
  let base;
  let exchanges = 0;
  let overrideRequests = 0;
  let discoveryRequests = 0;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, base).pathname;
    res.setHeader("Content-Type", "application/json");
    if (path.includes("oauth-protected-resource")) {
      res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["mcp"] }));
    } else if (path === "/metadata-override" || path.includes("oauth-authorization-server") || path.includes("openid-configuration")) {
      if (path === "/metadata-override") overrideRequests++; else discoveryRequests++;
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
    } else if (path === "/token") {
      let data = "";
      for await (const chunk of req) data += chunk;
      const form = new URLSearchParams(data);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "fixture-code");
      assert.ok(form.get("code_verifier"));
      exchanges += 1;
      res.end(JSON.stringify({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", expires_in: 3600, token_type: "Bearer" }));
    } else if (path === "/mcp") {
      if (req.headers.authorization !== "Bearer fixture-access-token") {
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.method !== "POST") { res.statusCode = 405; res.end("{}"); return; }
      let data = "";
      for await (const chunk of req) data += chunk;
      const message = JSON.parse(data);
      if (message.id === undefined) { res.statusCode = 202; res.end(); return; }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : message.method === "tools/list" ? { tools: [] } : {};
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const hooks = new Map();
  const runtime = new McpWebRuntime();
  const context = { cwd: root, ui: { notify() {} }, mode: "rpc", isProjectTrusted: () => false, modelRegistry: {} };
  const api = {
    registerCommand() {}, on(name, fn) { const list = hooks.get(name) ?? []; list.push(fn); hooks.set(name, list); },
    getMcpServers: () => [], getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, registerTool() {},
  };
  await runtime.createExtension(createMcpExtension({
    loadConfig: () => ({ servers: [{ name: "oauth", source: "fixture", scope: "global", config: { type: "http", url: `${base}/mcp`, timeout: 3, oauth: { clientId: "fixture-client", ...(override ? { authServerMetadataUrl: `${base}/metadata-override` } : {}) } } }], errors: [] }),
    logPath: join(root, "mcp.log"), openUrl: () => {}, // The production bridge supplies this same browserless option.
  }))(api);
  const emit = async (name) => { for (const fn of hooks.get(name) ?? []) await fn({ type: name }, context); };
  t.after(() => emit("session_shutdown"));
  await emit("session_start");
  assert.match((await runtime.status(5000)).statusText, /needs sign-in/);
  const events = [];
  const login = runtime.action("oauth-session", "login", "oauth", new AbortController().signal, (event) => {
    events.push(event);
    if (event.type === "input") {
      const auth = new URL(events.find((value) => value.type === "auth").url);
      const redirect = new URL(auth.searchParams.get("redirect_uri"));
      redirect.searchParams.set("code", "fixture-code");
      redirect.searchParams.set("state", auth.searchParams.get("state"));
      assert.equal(replyMcpInput("oauth-session", event.token, redirect.href), true);
    }
  });
  assert.equal(await login, true, JSON.stringify(events));
  assert.equal(exchanges, 1);
  if (override) { assert.ok(overrideRequests > 0); assert.equal(discoveryRequests, 0); }
  else { assert.equal(overrideRequests, 0); assert.ok(discoveryRequests > 0); }
  assert.match((await runtime.status()).statusText, /oauth: connected/);
  const authPath = join(root, "mcp-auth.json");
  assert.equal(existsSync(authPath), true);
  assert.match(readFileSync(authPath, "utf8"), /fixture-access-token/);
  assert.doesNotMatch(JSON.stringify(events), /fixture-access-token|fixture-refresh-token/);
  assert.equal(await runtime.action("oauth-session", "logout", "oauth", new AbortController().signal, () => {}), true);
  assert.doesNotMatch(readFileSync(authPath, "utf8"), /fixture-access-token|fixture-refresh-token/);
  await emit("session_shutdown");
});
