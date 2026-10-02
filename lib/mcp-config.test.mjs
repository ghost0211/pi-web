import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  deleteMcpServer,
  getMcpCatalog,
  isLoopbackRedirectUri,
  isProjectExplicitlyTrusted,
  maskServerConfig,
  mcpNamespace,
  McpConflictError,
  McpInvalidFileError,
  McpSecurityError,
  McpValidationError,
  MCP_SAVED_VALUE_MASK,
  MISSING_REVISION,
  putMcpServer,
  restoreAndMergeServerConfig,
  sha256Hex,
  validateMcpServerConfig,
  validateMcpServerName,
  validateOAuth,
} = await jiti.import("./mcp-config.ts");

function createTempDir(t, prefix = "pi-web-mcp-test-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("validateMcpServerName checks characters and prototype pollution", () => {
  assert.equal(validateMcpServerName("valid-server_1"), null);
  assert.equal(validateMcpServerName("server123"), null);

  assert.match(validateMcpServerName("") ?? "", /required/i);
  assert.match(validateMcpServerName("invalid name") ?? "", /invalid server name/);
  assert.match(validateMcpServerName("server@test") ?? "", /invalid server name/);

  assert.match(validateMcpServerName("__proto__") ?? "", /reserved name/);
  assert.match(validateMcpServerName("constructor") ?? "", /reserved name/);
  assert.match(validateMcpServerName("toString") ?? "", /reserved name/);
  assert.match(validateMcpServerName("prototype") ?? "", /reserved name/);
});

test("mcpNamespace and loopback redirect URI validator", () => {
  assert.equal(mcpNamespace("my-cool-server"), "mcp__my_cool_server");
  assert.equal(mcpNamespace("my_cool_server"), "mcp__my_cool_server");

  assert.equal(isLoopbackRedirectUri("http://localhost:3000/callback"), true);
  assert.equal(isLoopbackRedirectUri("http://127.0.0.1:8080"), true);
  assert.equal(isLoopbackRedirectUri("http://[::1]:9000/oauth"), true);

  assert.equal(isLoopbackRedirectUri("https://localhost:3000"), false); // HTTP only
  assert.equal(isLoopbackRedirectUri("http://example.com/callback"), false);
  assert.equal(isLoopbackRedirectUri("http://localhost:3000/callback?code=123"), false); // No query
  assert.equal(isLoopbackRedirectUri("http://localhost:3000/callback#tag"), false); // No hash
});

test("validateOAuth enforces known fields while preserving SDK-compatible unknown fields", () => {
  assert.equal(validateOAuth(undefined), null);

  const valid = {
    clientId: "client-id",
    clientSecret: "secret",
    callbackPort: 8080,
    callbackUrl: "http://127.0.0.1:8080/callback",
    scope: "read write",
    clientName: "My Client",
  };
  assert.equal(validateOAuth(valid), null);

  assert.equal(validateOAuth({ ...valid, unknownField: "preserved" }), null);
  assert.match(
    validateOAuth({ ...valid, callbackPort: 70000 }) ?? "",
    /port number between 1 and 65535/,
  );
  assert.match(
    validateOAuth({ ...valid, callbackPort: 8081 }) ?? "",
    /callbackUrl and oauth\.callbackPort name different ports/,
  );
});

test("validateMcpServerConfig rejects legacy SSE transport", () => {
  const result = validateMcpServerConfig("sse-server", {
    type: "sse",
    url: "https://example.com/sse",
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /legacy SSE transport is not supported/);
});

test("validateMcpServerConfig validates stdio configurations", () => {
  const valid = validateMcpServerConfig("stdio-server", {
    command: "node",
    args: ["index.js"],
    env: { FOO: "bar" },
    cwd: "/path/to/cwd",
    timeout: 30,
    exposure: "codemode-deferred", // alias normalization
    toolExposure: { "tool-1": "codemode-deferred" },
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.config.exposure, "codemode");
  assert.equal(valid.config.toolExposure["tool-1"], "codemode");

  const invalidCommand = validateMcpServerConfig("bad-cmd", { command: "   " });
  assert.equal(invalidCommand.valid, false);
  assert.match(invalidCommand.error, /command cannot be empty/);

  const mixed = validateMcpServerConfig("mixed", {
    command: "node",
    url: "https://example.com",
  });
  assert.equal(mixed.valid, false);
  assert.match(mixed.error, /cannot specify both/);

  const neither = validateMcpServerConfig("neither", {});
  assert.equal(neither.valid, false);
  assert.match(neither.error, /needs either "command" \(stdio\) or "url"/);
});

test("validateMcpServerConfig validates HTTP and auth rules", () => {
  const validHttp = validateMcpServerConfig("http-server", {
    url: "https://mcp.example.com",
    headers: { Authorization: "Bearer xyz" },
  });
  assert.equal(validHttp.valid, true);

  // auth.provider in project scope is rejected
  const projectAuth = validateMcpServerConfig(
    "auth-server",
    {
      url: "https://mcp.example.com",
      auth: { provider: "github" },
    },
    "project",
  );
  assert.equal(projectAuth.valid, false);
  assert.match(projectAuth.error, /auth is only allowed in the global mcp\.json/);

  // auth on non-secure non-loopback HTTP is rejected
  const insecureAuth = validateMcpServerConfig("auth-server", {
    url: "http://example.com/mcp",
    auth: { provider: "github" },
  });
  assert.equal(insecureAuth.valid, false);
  assert.match(insecureAuth.error, /auth requires an https URL, or http on localhost/);

  // auth on loopback HTTP is allowed
  const loopbackAuth = validateMcpServerConfig("auth-server", {
    url: "http://localhost:3000/mcp",
    auth: { provider: "github" },
  });
  assert.equal(loopbackAuth.valid, true);

  // auth conflicting with oauth
  const authWithOauth = validateMcpServerConfig("auth-conflict", {
    url: "https://example.com/mcp",
    auth: { provider: "github" },
    oauth: { clientId: "id" },
  });
  assert.equal(authWithOauth.valid, false);
  assert.match(authWithOauth.error, /auth cannot be used with oauth/);

  // auth conflicting with Authorization header
  const authWithHeader = validateMcpServerConfig("auth-conflict", {
    url: "https://example.com/mcp",
    auth: { provider: "github" },
    headers: { authorization: "Bearer foo" },
  });
  assert.equal(authWithHeader.valid, false);
  assert.match(authWithHeader.error, /auth cannot be used with Authorization header/);
});

test("maskServerConfig masks env, headers, secrets, credentials, queries, and args", () => {
  const original = {
    command: "npx",
    args: ["-y", "mcp-pkg", "secret-token"],
    env: { API_KEY: "secret123", PUBLIC_VAR: "visible" },
    cwd: "/home/user",
    url: "https://user:password@example.com/mcp?token=xyz",
    headers: { Authorization: "Bearer token", "X-Custom": "val" },
    oauth: {
      clientId: "client-id",
      clientSecret: "super-secret",
      callbackPort: 3000,
    },
    unknownProp: "hidden-value",
  };

  const masked = maskServerConfig(original);

  assert.deepEqual(masked.args, [MCP_SAVED_VALUE_MASK]);
  assert.deepEqual(masked.env, {
    API_KEY: MCP_SAVED_VALUE_MASK,
    PUBLIC_VAR: MCP_SAVED_VALUE_MASK,
  });
  assert.deepEqual(masked.headers, {
    Authorization: MCP_SAVED_VALUE_MASK,
    "X-Custom": MCP_SAVED_VALUE_MASK,
  });
  assert.equal(masked.url, MCP_SAVED_VALUE_MASK);
  assert.equal(masked.oauth.clientId, "client-id");
  assert.equal(masked.oauth.clientSecret, MCP_SAVED_VALUE_MASK);
  assert.equal(masked.oauth.callbackPort, 3000);
  assert.equal(masked.command, "npx");
  assert.equal(masked.cwd, "/home/user");
  assert.equal("unknownProp" in masked, false); // Unknown properties filtered out in GET
});

test("maskServerConfig keeps clean URLs unchanged and empty args as []", () => {
  const config = {
    url: "https://example.com/mcp",
    args: [],
  };
  const masked = maskServerConfig(config);
  assert.equal(masked.url, "https://example.com/mcp");
  assert.deepEqual(masked.args, []);
});

test("restoreAndMergeServerConfig rejects masked values on new server entries", () => {
  assert.throws(
    () =>
      restoreAndMergeServerConfig(
        {
          command: "node",
          args: [MCP_SAVED_VALUE_MASK],
        },
        undefined,
        "global",
      ),
    (err) => err instanceof McpValidationError && /New server cannot use masked/.test(err.message),
  );
});

test("restoreAndMergeServerConfig restores masked values from existing entries", () => {
  const oldConfig = {
    command: "node",
    args: ["index.js", "--secret", "123"],
    env: { KEY1: "val1", KEY2: "val2" },
    customUnknown: "kept",
  };

  const restored = restoreAndMergeServerConfig(
    {
      command: "node",
      args: [MCP_SAVED_VALUE_MASK],
      env: { KEY1: MCP_SAVED_VALUE_MASK, KEY2: "new-val2" },
    },
    oldConfig,
    "global",
  );

  assert.deepEqual(restored.args, ["index.js", "--secret", "123"]);
  assert.deepEqual(restored.env, { KEY1: "val1", KEY2: "new-val2" });
  assert.equal(restored.customUnknown, "kept");
});

test("restoreAndMergeServerConfig supports clearing fields with null or empty structures", () => {
  const oldConfig = {
    command: "node",
    args: ["index.js"],
    env: { KEY: "val" },
    description: "old description",
  };

  const updated = restoreAndMergeServerConfig(
    {
      description: null,
      env: {},
      args: [],
    },
    oldConfig,
    "global",
  );

  assert.equal("description" in updated, false);
  assert.deepEqual(updated.env, {});
  assert.deepEqual(updated.args, []);
  assert.equal(updated.command, "node"); // omitted command preserved
});

test("restoreAndMergeServerConfig clears transport fields when transport switches", () => {
  const oldStdio = {
    command: "node",
    args: ["server.js"],
    env: { A: "1" },
    cwd: "/app",
  };

  const switchedToHttp = restoreAndMergeServerConfig(
    {
      url: "https://example.com/mcp",
    },
    oldStdio,
    "global",
  );

  assert.equal(switchedToHttp.url, "https://example.com/mcp");
  assert.equal("command" in switchedToHttp, false);
  assert.equal("args" in switchedToHttp, false);
  assert.equal("env" in switchedToHttp, false);
  assert.equal("cwd" in switchedToHttp, false);
});

test("lock, revision verification, and corrupt JSON fail-closed protection", async (t) => {
  const tempDir = createTempDir(t);
  const agentDir = path.join(tempDir, "agent");
  mkdirSync(agentDir, { recursive: true });

  const mcpJson = path.join(agentDir, "mcp.json");
  writeFileSync(mcpJson, "{ bad json }", "utf8");
  const corruptRevision = sha256Hex("{ bad json }");

  // Attempting PUT on corrupt JSON must fail-closed and not overwrite file
  await assert.rejects(
    putMcpServer(
      {
        scope: "global",
        name: "test-server",
        config: { command: "node", args: ["test.js"] },
        revision: corruptRevision,
      },
      { agentDir },
    ),
    (err) => err instanceof McpInvalidFileError,
  );

  // File content remained intact
  assert.equal(readFileSync(mcpJson, "utf8"), "{ bad json }");

  // Revision conflict on write
  writeFileSync(mcpJson, JSON.stringify({ mcpServers: {} }, null, 2), "utf8");
  await assert.rejects(
    putMcpServer(
      {
        scope: "global",
        name: "test-server",
        config: { command: "node", args: ["test.js"] },
        revision: "stale-revision",
      },
      { agentDir },
    ),
    (err) => err instanceof McpConflictError,
  );
});

test("getMcpCatalog, putMcpServer, and deleteMcpServer lifecycle", async (t) => {
  const tempDir = createTempDir(t);
  const agentDir = path.join(tempDir, "agent");
  const projectDir = path.join(tempDir, "my-project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  const allowedRoots = new Set([tempDir]);

  // Initial catalog: global mcp.json missing
  let catalog = await getMcpCatalog({ agentDir, cwd: projectDir, allowedRoots });
  assert.equal(catalog.files.length, 1);
  assert.equal(catalog.files[0].scope, "global");
  assert.equal(catalog.files[0].revision, MISSING_REVISION);
  assert.equal(catalog.files[0].servers.length, 0);
  assert.equal(catalog.project.trusted, false); // Project not trusted yet

  // 1. Add global server
  catalog = await putMcpServer(
    {
      scope: "global",
      name: "global-stdio",
      config: {
        command: "npx",
        args: ["-y", "global-tool"],
        env: { SECRET: "g-secret" },
      },
      revision: MISSING_REVISION,
    },
    { agentDir, cwd: projectDir, allowedRoots },
  );

  assert.equal(catalog.files[0].servers.length, 1);
  const server = catalog.files[0].servers[0];
  assert.equal(server.name, "global-stdio");
  assert.deepEqual(server.config.args, [MCP_SAVED_VALUE_MASK]);
  assert.equal(server.config.env.SECRET, MCP_SAVED_VALUE_MASK);

  const globalRevision = catalog.files[0].revision;
  assert.notEqual(globalRevision, MISSING_REVISION);

  // Trust the project explicitly
  new ProjectTrustStore(agentDir).set(projectDir, true);
  assert.equal(isProjectExplicitlyTrusted(projectDir, agentDir), true);

  // 2. Add project server
  catalog = await putMcpServer(
    {
      scope: "project",
      cwd: projectDir,
      name: "proj-server",
      config: {
        url: "https://project.example.com/mcp",
        headers: { "X-Token": "p-token" },
      },
      revision: MISSING_REVISION,
    },
    { agentDir, cwd: projectDir, allowedRoots },
  );

  assert.equal(catalog.files.length, 2);
  assert.equal(catalog.project.trusted, true);
  const projectFile = catalog.files.find((f) => f.scope === "project");
  assert.ok(projectFile);
  assert.equal(projectFile.servers.length, 1);
  assert.equal(projectFile.servers[0].name, "proj-server");
  assert.equal(projectFile.servers[0].config.headers["X-Token"], MCP_SAVED_VALUE_MASK);

  // 3. Delete server
  const projRevision = projectFile.revision;
  catalog = await deleteMcpServer(
    {
      scope: "project",
      cwd: projectDir,
      name: "proj-server",
      revision: projRevision,
    },
    { agentDir, cwd: projectDir, allowedRoots },
  );

  const updatedProjFile = catalog.files.find((f) => f.scope === "project");
  assert.equal(updatedProjFile.servers.length, 0);
});

test("project with same-name overrides global, but different-name alias triggers conflict error", async (t) => {
  const tempDir = createTempDir(t);
  const agentDir = path.join(tempDir, "agent");
  const projectDir = path.join(tempDir, "my-project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const allowedRoots = new Set([tempDir]);

  new ProjectTrustStore(agentDir).set(projectDir, true);

  // Add global server named "foo-bar"
  let catalog = await putMcpServer(
    {
      scope: "global",
      name: "foo-bar",
      config: { command: "node", args: ["foo.js"] },
      revision: MISSING_REVISION,
    },
    { agentDir, cwd: projectDir, allowedRoots },
  );

  // 1. Same original name "foo-bar" in project overrides global -> allowed
  catalog = await putMcpServer(
    {
      scope: "project",
      cwd: projectDir,
      name: "foo-bar",
      config: { command: "node", args: ["override.js"] },
      revision: MISSING_REVISION,
    },
    { agentDir, cwd: projectDir, allowedRoots },
  );
  assert.equal(catalog.errors.length, 0);

  // 2. Different name with same namespace (e.g. global "baz-qux", project "baz_qux") -> alias conflict!
  const globalRev = catalog.files.find((f) => f.scope === "global").revision;
  await putMcpServer(
    {
      scope: "global",
      name: "baz-qux",
      config: { command: "node", args: ["baz.js"] },
      revision: globalRev,
    },
    { agentDir, cwd: projectDir, allowedRoots },
  );

  const projRev = catalog.files.find((f) => f.scope === "project").revision;
  await assert.rejects(
    putMcpServer(
      {
        scope: "project",
        cwd: projectDir,
        name: "baz_qux",
        config: { command: "node", args: ["alias.js"] },
        revision: projRev,
      },
      { agentDir, cwd: projectDir, allowedRoots },
    ),
    (err) => err instanceof McpValidationError && /conflicts with global server/i.test(err.message),
  );
});

test("rejects symlinked .pi directory or mcp.json file to prevent path traversal", async (t) => {
  const tempDir = createTempDir(t);
  const agentDir = path.join(tempDir, "agent");
  const projectDir = path.join(tempDir, "project");
  const outsideDir = path.join(tempDir, "outside");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const allowedRoots = new Set([tempDir]);
  new ProjectTrustStore(agentDir).set(projectDir, true);

  // Create symlink for .pi pointing outside
  symlinkSync(outsideDir, path.join(projectDir, ".pi"), "dir");

  await assert.rejects(
    putMcpServer(
      {
        scope: "project",
        cwd: projectDir,
        name: "evil-server",
        config: { command: "node", args: ["1.js"] },
        revision: MISSING_REVISION,
      },
      { agentDir, cwd: projectDir, allowedRoots },
    ),
    (err) => err instanceof McpSecurityError && /cannot be a symbolic link/.test(err.message),
  );
});
