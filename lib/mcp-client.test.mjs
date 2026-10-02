import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const {
  isSafeUrl, isSafeAuthorizationUrl, validateMcpServerName, isMcpServerShadowed, hasMaskedArgs,
  serverToMcpForm, formToMcpServerPatch, parseSseStream, saveMcpServer, fetchMcpCatalog,
  fetchMcpRuntime, performMcpRuntimeAction, RevisionConflictError, MCP_SAVED_VALUE_MASK,
} = await createJiti(import.meta.url).import("./mcp-client.ts");
const catalog = { files: [{ scope: "global", path: "/fixture/mcp.json", revision: "r1", servers: [] }], project: { cwd: "/fixture", trusted: true }, errors: [] };

 test("authorization URLs accept HTTP(S), reject unsafe schemes and embedded credentials", () => {
  for (const url of ["https://example.test/auth?state=fixture", "http://127.0.0.1/callback"]) assert.equal(isSafeUrl(url), true);
  for (const url of ["javascript:alert(1)", "data:text/html,hi", "file:///private", "https://user:secret@example.test/", "invalid"]) assert.equal(isSafeUrl(url), false);
});
test("OAuth links require HTTPS except for loopback development endpoints", () => {
  assert.equal(isSafeAuthorizationUrl("https://example.test/auth"), true);
  assert.equal(isSafeAuthorizationUrl("http://127.0.0.1:1234/auth"), true);
  assert.equal(isSafeAuthorizationUrl("http://example.test/auth"), false);
});
test("unchanged hidden authentication options are omitted, while explicit edits can clear them", () => {
  const form = serverToMcpForm("global", { name: "http", config: { url: "https://example.test", oauth: {} } });
  assert.equal(formToMcpServerPatch({ ...form, description: "changed" }).oauth, undefined);
  assert.equal(formToMcpServerPatch({ ...form, oauth: "null" }).oauth, null);
  assert.throws(() => formToMcpServerPatch({ ...form, oauth: "[]" }), /errorInvalidJson/);
  const provider = serverToMcpForm("global", { name: "http", config: { url: "https://example.test", auth: { provider: "old" } } });
  assert.equal(formToMcpServerPatch(provider).auth, undefined);
  assert.equal(formToMcpServerPatch({ ...provider, authProvider: "" }).auth, null);
  assert.throws(() => formToMcpServerPatch({ ...provider, scope: "project" }), /projectAuthForbidden/);
});
test("names and shadowing are case-sensitive; namespace aliases are conflicts, not overrides", () => {
  assert.equal(validateMcpServerName("normal-name_1"), null);
  assert.ok(validateMcpServerName("__proto__"));
  assert.ok(validateMcpServerName("bad/name"));
  const data = { ...catalog, files: [...catalog.files, { scope: "project", servers: [{ name: "foo-bar", config: { command: "node" } }] }] };
  assert.equal(isMcpServerShadowed("foo-bar", "global", data), true);
  assert.equal(isMcpServerShadowed("foo_bar", "global", data), false);
  assert.equal(isMcpServerShadowed("FOO-bar", "global", data), false);
  assert.equal(isMcpServerShadowed("foo-bar", "project", data), false);
  assert.equal(isMcpServerShadowed("foo-bar", "global", { ...data, project: { trusted: false } }), false);
});
test("form defaults use Codemode and infer implicit HTTP transport", () => {
  assert.equal(serverToMcpForm("global").exposure, "codemode");
  assert.equal(serverToMcpForm("global", { name: "http", config: { url: "https://example.test/mcp" } }).type, "http");
  assert.equal(serverToMcpForm("global", { name: "old", config: { command: "node", exposure: "codemode-deferred" } }).exposure, "codemode");
});
test("form patches preserve masks and explicitly clear empty containers and optional fields", () => {
  const form = serverToMcpForm("global", { name: "stdio", config: { command: "node", args: [MCP_SAVED_VALUE_MASK], env: { TOKEN: MCP_SAVED_VALUE_MASK }, description: "old" } });
  let patch = formToMcpServerPatch(form);
  assert.equal(hasMaskedArgs(patch.args), true);
  assert.equal(patch.env.TOKEN, MCP_SAVED_VALUE_MASK);
  patch = formToMcpServerPatch({ ...form, args: "[]", env: "{}", description: "", cwd: "", timeout: "", toolExposure: "{}" });
  assert.deepEqual(patch.args, []); assert.deepEqual(patch.env, {}); assert.deepEqual(patch.toolExposure, {});
  assert.equal(patch.description, null); assert.equal(patch.cwd, null); assert.equal(patch.timeout, null);
});
test("HTTP patches preserve stored URLs/secrets and support clearing OAuth/provider settings", () => {
  const form = serverToMcpForm("global", { name: "http", config: { url: MCP_SAVED_VALUE_MASK, headers: { Key: MCP_SAVED_VALUE_MASK }, oauth: { clientSecret: MCP_SAVED_VALUE_MASK } } });
  const patch = formToMcpServerPatch(form);
  assert.equal(patch.url, MCP_SAVED_VALUE_MASK); assert.equal(patch.oauth, undefined); // unchanged redacted auth is preserved
  const edited = formToMcpServerPatch({ ...form, oauth: JSON.stringify({ clientSecret: MCP_SAVED_VALUE_MASK, clientName: "new" }) });
  assert.equal(edited.oauth.clientSecret, MCP_SAVED_VALUE_MASK);
  const cleared = formToMcpServerPatch({ ...form, headers: "{}", oauth: "{}" });
  assert.deepEqual(cleared.headers, {}); assert.equal(cleared.oauth, null); assert.equal(cleared.auth, undefined);
  assert.deepEqual(formToMcpServerPatch({ ...form, oauth: "{}", authProvider: "openai" }).auth, { provider: "openai" });
});
test("form JSON rejects null, arrays, non-string args and invalid timeouts without crashing", () => {
  const form = { ...serverToMcpForm("global"), command: "node" };
  for (const key of ["env", "toolExposure"]) for (const value of ["null", "[]", "invalid"]) assert.throws(() => formToMcpServerPatch({ ...form, [key]: value }), /InvalidJson/);
  for (const value of ["[1]", "null"]) assert.throws(() => formToMcpServerPatch({ ...form, args: value }), /InvalidJson/);
  for (const value of ["0", "-1", "Infinity", "NaN"]) assert.throws(() => formToMcpServerPatch({ ...form, timeout: value }), /Timeout/);
});
test("SSE handles split UTF-8, CRLF, comments, multiline events and trailing data", async () => {
  const bytes = new TextEncoder().encode(':keepalive\r\ndata: {"type":"notify",\r\ndata: "level":"info","message":"测试"}\r\n\r\ndata: {"type":"done","success":false}');
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } });
  const events = [];
  for await (const event of parseSseStream(stream)) events.push(event);
  assert.deepEqual(events, [{ type: "notify", level: "info", message: "测试" }, { type: "done", success: false }]);
});
test("aborting SSE cancels a genuinely blocked reader and releases its lock", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const abort = new AbortController();
  const next = parseSseStream(stream, abort.signal).next();
  abort.abort();
  assert.equal((await next).done, true);
  assert.equal(cancelled, true); assert.equal(stream.locked, false);
});
test("client operations pass revisions, cwd and cancellation without leaking plaintext HTTP failures", async (t) => {
  const before = globalThis.fetch; t.after(() => { globalThis.fetch = before; });
  const calls = []; const abort = new AbortController();
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return Response.json(catalog); };
  await saveMcpServer({ scope: "global", cwd: "/fixture", name: "x", config: { command: "node" }, revision: "r1" }, abort.signal);
  assert.equal(JSON.parse(calls[0].options.body).cwd, "/fixture"); assert.equal(calls[0].options.signal, abort.signal);
  await fetchMcpCatalog("/fixture", abort.signal); assert.match(calls[1].url, /cwd=%2Ffixture/);
  globalThis.fetch = async () => new Response("Database error with sensitive data", { status: 500 });
  await assert.rejects(fetchMcpCatalog(), /HTTP 500/);
  globalThis.fetch = async () => Response.json({}, { status: 409 });
  await assert.rejects(saveMcpServer({ scope: "global", name: "x", config: {}, revision: "r1" }), RevisionConflictError);
});
test("runtime reads and SSE actions preserve the public session contract", async (t) => {
  const before = globalThis.fetch; t.after(() => { globalThis.fetch = before; });
  globalThis.fetch = async () => Response.json({ available: false, live: false });
  assert.deepEqual(await fetchMcpRuntime("sid"), { available: false, live: false });
  globalThis.fetch = async () => new Response('data: {"type":"done","success":false}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  const events = [];
  await performMcpRuntimeAction({ sessionId: "sid", action: "reconnect", name: "x", onEvent: (event) => events.push(event) });
  assert.deepEqual(events, [{ type: "done", success: false }]);
});
