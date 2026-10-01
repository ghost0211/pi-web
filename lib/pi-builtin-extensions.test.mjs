import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";

const { createPiBuiltinExtensions } = await createJiti(import.meta.url).import("./pi-builtin-extensions.ts");

async function fixture(settings = {}, projectSettings = {}, extraFactories = [], loaderOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-builtins-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(projectSettings));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noSkills: true, noThemes: true, noContextFiles: true,
    ...loaderOptions,
    extensionFactories: [...createPiBuiltinExtensions(), ...extraFactories],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  return { root, cwd, agentDir, session, resourceLoader, async dispose() {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  } };
}

test("official builtins have stable names and remain replaceable", () => {
  assert.deepEqual(createPiBuiltinExtensions().map(({ name, builtin, replaceable }) => ({ name, builtin, replaceable })), [
    { name: "codemode", builtin: true, replaceable: true },
    { name: "tool-search", builtin: true, replaceable: true },
    { name: "mcp", builtin: true, replaceable: true },
  ]);
});

test("codemode and tool search are registered but opt-in; MCP command is available", async () => {
  const f = await fixture();
  try {
    const names = f.session.getAllTools().map((tool) => tool.name);
    assert.ok(names.includes("codemode"));
    assert.ok(names.includes("tool_search"));
    assert.ok(!f.session.getActiveToolNames().includes("codemode"));
    assert.ok(!f.session.getActiveToolNames().includes("tool_search"));
    assert.ok(f.session.extensionRunner.getRegisteredCommands().some((command) => command.name === "mcp"));
  } finally { await f.dispose(); }
});

test("defaultTools additions and codemode settings are honored", async () => {
  const f = await fixture({ defaultTools: ["+codemode", "+tool_search"], codemode: { mode: "only" } });
  try {
    assert.ok(f.session.getActiveToolNames().includes("read"));
    assert.ok(f.session.getActiveToolNames().includes("codemode"));
    assert.ok(f.session.getActiveToolNames().includes("tool_search"));
    assert.match(f.session.systemPrompt, /codemode/);
  } finally { await f.dispose(); }
});

test("noExtensions keeps all new builtins out of Chat-only resource loading", async () => {
  const f = await fixture({}, {}, [], { noExtensions: true });
  try {
    const names = f.session.getAllTools().map((tool) => tool.name);
    assert.ok(!names.includes("codemode"));
    assert.ok(!names.includes("tool_search"));
    assert.ok(!f.session.extensionRunner.getRegisteredCommands().some((command) => command.name === "mcp"));
  } finally { await f.dispose(); }
});

test("SDK reload enables new defaultTools additions without re-enabling a tool switched off by the user", async () => {
  const f = await fixture({ defaultTools: ["+codemode"] });
  try {
    f.session.setActiveToolsByName(f.session.getActiveToolNames().filter((name) => name !== "codemode"));
    await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultTools: ["+codemode", "+tool_search"] }));
    await f.session.reload();
    assert.ok(f.session.getActiveToolNames().includes("tool_search"));
    assert.ok(!f.session.getActiveToolNames().includes("codemode"));
  } finally { await f.dispose(); }
});

test("builtin exclusions in settings are respected", async () => {
  const f = await fixture({ extensions: ["-builtin:codemode", "-builtin:tool-search", "-builtin:mcp"] });
  try {
    const names = f.session.getAllTools().map((tool) => tool.name);
    assert.ok(!names.includes("codemode"));
    assert.ok(!names.includes("tool_search"));
    assert.ok(!f.session.extensionRunner.getRegisteredCommands().some((command) => command.name === "mcp"));
  } finally { await f.dispose(); }
});

test("an installed replacement wins without duplicate-tool conflicts", async () => {
  const f = await fixture({}, {}, [(pi) => pi.registerTool({
    name: "codemode", description: "replacement", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "replacement" }], details: undefined }),
  })]);
  try {
    assert.equal(f.resourceLoader.getExtensions().errors.length, 0);
    const tools = f.session.getAllTools().filter((tool) => tool.name === "codemode");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].description, "replacement");
  } finally { await f.dispose(); }
});

function scriptedProvider(code) {
  return (pi) => pi.registerProvider("fixture", {
    baseUrl: "http://127.0.0.1:1", apiKey: "fixture", api: "openai-completions",
    models: [{ id: "script", name: "Script fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const finished = context.messages.some((message) => message.role === "toolResult");
        const message = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: finished ? [{ type: "text", text: "Done" }] : [{ type: "toolCall", id: "code-call", name: "codemode", arguments: { code } }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: finished ? "stop" : "toolUse", timestamp: Date.now(),
        };
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}

const MCP_FIXTURE = `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if (process.argv[2]) writeFileSync(process.argv[2], String(process.pid));
const reader = createInterface({ input: process.stdin });
reader.on('line', line => {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  let result = {};
  if (req.method === 'initialize') result = {
    protocolVersion: req.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: 'fixture', version: '1' }, instructions: 'Local test tools',
  };
  if (req.method === 'tools/list') result = { tools: [
    { name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
    { name: 'blocked', description: 'Hidden test tool', inputSchema: { type: 'object', properties: {} } },
  ] };
  if (req.method === 'tools/call') result = { content: [{ type: 'text', text: req.params.arguments.value }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
});
reader.on('close', () => process.exit(0));
`;

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("MCP fixture did not connect within 5 seconds");
}

test("MCP connects via stdio, auto-enables codemode, and records real nested calls without extra transcript messages", async () => {
  const code = 'const ns = await describeNamespace("fixture-server"); text(ns.instructions); text(await tools.mcp__fixture_server__echo({value:"MCP_OK"}));';
  const f = await fixture({ defaultProvider: "fixture", defaultModel: "script" }, {}, [scriptedProvider(code)]);
  const marker = join(f.root, "mcp-server.mjs");
  const pidFile = join(f.root, "mcp.pid");
  let serverPid;
  const events = [];
  try {
    await writeFile(marker, MCP_FIXTURE);
    await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
      "fixture-server": { command: process.execPath, args: [marker, pidFile], toolExposure: { blocked: "hidden" }, description: "Test echo service" },
    } }));
    await f.session.bindExtensions({ mode: "rpc" });
    await until(() => f.session.getAllTools().some((tool) => tool.name === "mcp__fixture_server__echo"));
    serverPid = Number(await readFile(pidFile, "utf8"));
    assert.ok(f.session.getActiveToolNames().includes("codemode"));
    assert.ok(!f.session.getActiveToolNames().includes("mcp__fixture_server__echo"));
    assert.ok(!f.session.getCallableToolNames().includes("mcp__fixture_server__blocked"));
    await f.session.modelRuntime.setRuntimeApiKey("fixture", "fixture-test-key");
    await f.session.setModel(f.session.modelRuntime.getModel("fixture", "script"));
    f.session.subscribe((event) => events.push(event));
    await f.session.prompt("run the fixture");
    const results = f.session.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 1, "nested calls must not become standalone transcript results");
    assert.equal(results[0].isError, false, JSON.stringify(results[0]));
    assert.match(JSON.stringify(results[0].content), /MCP_OK/);
    assert.equal(results[0].nestedCalls.calls[0].name, "mcp__fixture_server__echo");
    assert.equal(results[0].nestedCalls.calls[0].status, "ok");
    assert.ok(events.some((event) => event.type === "tool_execution_start" && event.parentToolCallId === "code-call"));
  } finally {
    await f.dispose();
    if (serverPid) await until(() => {
      try { process.kill(serverPid, 0); return false; }
      catch (error) { return error.code === "ESRCH"; }
    });
  }
});

for (const exposure of ["direct", "deferred"]) {
  test(`MCP ${exposure} exposure activates only the appropriate declarations/loader`, async () => {
    const f = await fixture();
    try {
      const marker = join(f.root, "mcp-server.mjs");
      await writeFile(marker, MCP_FIXTURE);
      await writeFile(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
        fixture: { command: process.execPath, args: [marker], exposure },
      } }));
      await f.session.bindExtensions({ mode: "rpc" });
      await until(() => f.session.getAllTools().some((tool) => tool.name === "mcp__fixture__echo"));
      const active = f.session.getActiveToolNames();
      assert.equal(active.includes("mcp__fixture__echo"), exposure === "direct");
      assert.equal(active.includes("tool_search"), exposure === "deferred");
      assert.ok(!active.includes("codemode"));
    } finally { await f.dispose(); }
  });
}

test("a project's mcp.json is ignored until that project is trusted", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: {
      project: { command: process.execPath, args: ["-e", "process.exit(1)"], exposure: "direct" },
    } }));
    f.session.settingsManager.setProjectTrusted(false);
    const notices = [];
    await f.session.bindExtensions({ mode: "rpc", uiContext: { notify: (text) => notices.push(text) } });
    await f.session.prompt("/mcp");
    assert.ok(notices.some((notice) => /No MCP servers configured/.test(notice)), JSON.stringify(notices));
    assert.ok(!f.session.getAllTools().some((tool) => tool.name.startsWith("mcp__project__")));
  } finally { await f.dispose(); }
});
