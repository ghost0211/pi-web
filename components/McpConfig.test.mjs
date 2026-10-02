import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { componentHarness, tick } from "./mcp-test-harness.mjs";
const { McpConfig } = await createJiti(import.meta.url, { tsconfigPaths: true, jsx: true }).import("./McpConfig.tsx");
const data = () => ({ files: [{ scope: "global", path: "/fixture/agent/mcp.json", revision: "r1", servers: [{ name: "demo", config: { command: "node", args: ["__PI_WEB_SAVED_VALUE__"], env: { TOKEN: "__PI_WEB_SAVED_VALUE__" } } }] }], project: { cwd: "/fixture", trusted: false }, errors: [] });
function setup(t, fetcher) {
  const original = globalThis.fetch; globalThis.fetch = fetcher;
  const props = { cwd: "/fixture", sessionId: "sid", embedded: true, onClose() {}, onSessionReloaded() {} };
  const harness = componentHarness(McpConfig, props);
  t.after(() => { harness.cleanup(); globalThis.fetch = original; });
  harness.render(); return { harness, props };
}
const initial = (url) => Response.json(url.startsWith("/api/mcp/runtime") ? { available: true, live: true, statusText: "demo: failed (codemode)" } : data());

test("management renders real native status, sensitive markers, paths and explicit trust gating", async (t) => {
  const { harness } = setup(t, async (url) => initial(url));
  await tick(); harness.render();
  assert.match(harness.text(), /demo: failed \(codemode\)/);
  assert.match(harness.text(), /\/fixture\/agent\/mcp.json/);
  assert.equal(harness.input("mcp.env").props.value.includes("__PI_WEB_SAVED_VALUE__"), true);
  assert.equal(harness.button("mcp.addProjectServer").props.disabled, true);
  assert.equal(harness.button("mcp.login"), undefined); // stdio is not an OAuth login target
});

test("saving keeps cwd/revision, masks and explicit clearing semantics; it never auto-reloads", async (t) => {
  const calls = [];
  const { harness } = setup(t, async (url, options = {}) => { calls.push({ url, options }); return initial(url); });
  await tick(); harness.render();
  harness.input("mcp.args").props.onChange({ target: { value: "[]" } });
  harness.input("mcp.env").props.onChange({ target: { value: "{}" } });
  harness.render(); harness.button("mcp.save").props.onClick();
  await tick(); harness.render();
  const save = calls.find((call) => call.options.method === "PUT");
  const body = JSON.parse(save.options.body);
  assert.equal(body.cwd, "/fixture"); assert.equal(body.revision, "r1");
  assert.deepEqual(body.config.args, []); assert.deepEqual(body.config.env, {});
  assert.equal(body.config.description, null);
  assert.match(harness.text(), /mcp.needsReloadNotice/);
  assert.equal(calls.some((call) => call.url.startsWith("/api/agent")), false);
});

test("SSE failure is shown as failure and terminal actions release the busy state", async (t) => {
  const { harness } = setup(t, async (url, options = {}) => options.method === "POST"
    ? new Response('data: {"type":"done","success":false}\n\n') : initial(url));
  await tick(); harness.render();
  harness.button("mcp.reconnect").props.onClick(); await tick(); harness.render();
  assert.match(harness.text(), /mcp.actionFailed/);
  assert.equal(harness.button("mcp.reconnect").props.disabled, false);
});

test("session/cwd changes abort stale save requests and ignore late responses", async (t) => {
  let finish; let signal;
  const { harness, props } = setup(t, async (url, options = {}) => {
    if (options.method === "PUT") { signal = options.signal; return new Promise((resolve) => { finish = resolve; }); }
    return initial(url);
  });
  await tick(); harness.render(); harness.button("mcp.save").props.onClick();
  harness.render({ ...props, cwd: "/other", sessionId: "other-sid" }); await tick(); harness.render();
  assert.equal(signal.aborted, true);
  finish(Response.json({ ...data(), files: [{ ...data().files[0], servers: [{ name: "STALE", config: { command: "node" } }] }] }));
  await tick(); harness.render();
  assert.doesNotMatch(harness.text(), /STALE|mcp.saveSuccess/);
});

test("trust is not automatic and requires a second explicit confirmation", async (t) => {
  const calls = [];
  const { harness } = setup(t, async (url, options = {}) => {
    calls.push({ url, options });
    return url === "/api/project-trust" ? Response.json({ trusted: true }) : initial(url);
  });
  await tick(); harness.render();
  assert.equal(calls.some((call) => call.options.method === "POST"), false);
  harness.button("mcp.trustProject").props.onClick(); harness.render();
  assert.match(harness.text(), /mcp.trustWarning/);
  assert.equal(calls.some((call) => call.options.method === "POST"), false);
  harness.button("mcp.confirmTrust").props.onClick(); await tick(); harness.render();
  const request = calls.find((call) => call.url === "/api/project-trust");
  assert.deepEqual(JSON.parse(request.options.body), { cwd: "/fixture", purpose: "mcp" });
});

test("OAuth replies stay inside the busy action and cannot race save/reload", async (t) => {
  const calls = []; let streamController;
  const httpData = () => ({ ...data(), files: [{ ...data().files[0], servers: [{ name: "demo", config: { url: "https://example.test/mcp" } }] }] });
  const { harness } = setup(t, async (url, options = {}) => {
    calls.push({ url, options });
    if (url === "/api/mcp/runtime" && options.method === "POST") return new Response(new ReadableStream({ start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode('data: {"type":"auth","url":"https://example.test/auth"}\n\ndata: {"type":"input","token":"fixture"}\n\n'));
    } }));
    if (url === "/api/mcp/runtime/input") {
      streamController.enqueue(new TextEncoder().encode('data: {"type":"done","success":true}\n\n')); streamController.close();
      return Response.json({ success: true });
    }
    return Response.json(url.startsWith("/api/mcp/runtime") ? { available: true, live: true, statusText: "demo: needs sign-in, run /mcp login demo (codemode)" } : httpData());
  });
  await tick(); harness.render(); harness.button("mcp.login").props.onClick(); await tick(); harness.render();
  assert.equal(harness.button("mcp.reloadSession").props.disabled, true);
  harness.button("mcp.save").props.onClick();
  assert.equal(calls.some((call) => call.options.method === "PUT"), false);
  harness.input("mcp.authPrompt").props.onChange({ target: { value: "http://127.0.0.1/callback?code=fixture" } });
  harness.render(); harness.button("mcp.submit").props.onClick(); await tick(); harness.render();
  assert.equal(harness.button("mcp.login").props.disabled, false);
  assert.match(harness.text(), /mcp.actionSuccess/);
});

test("reload only targets an already live session and is explicitly marked no-start", async (t) => {
  const calls = []; let reloaded = 0;
  const { harness, props } = setup(t, async (url, options = {}) => {
    calls.push({ url, options });
    return url.startsWith("/api/agent") ? Response.json({ success: true, data: {} }) : initial(url);
  });
  harness.render({ ...props, onSessionReloaded() { reloaded += 1; } });
  await tick(); harness.render();
  harness.button("mcp.reloadSession").props.onClick(); await tick(); harness.render();
  const request = calls.find((call) => call.url.startsWith("/api/agent"));
  assert.deepEqual(JSON.parse(request.options.body), { type: "reload", requireLiveSession: true });
  assert.equal(reloaded, 1);
});
