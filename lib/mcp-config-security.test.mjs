import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import lockfile from "proper-lockfile";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const {
  getMcpCatalog, putMcpServer, maskServerConfig, restoreAndMergeServerConfig, sha256Hex, McpSecurityError, validateOAuth,
  MCP_SAVED_VALUE_MASK: mask,
} = await createJiti(import.meta.url).import("./mcp-config.ts");
const { serverToMcpForm, formToMcpServerPatch } = await createJiti(import.meta.url).import("./mcp-client.ts");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-mcp-security-"));
  const agentDir = join(root, "agent"); const cwd = join(root, "project"); const piDir = join(cwd, ".pi");
  mkdirSync(agentDir); mkdirSync(cwd); mkdirSync(piDir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, agentDir, cwd, piDir, options: { agentDir, allowedRoots: new Set([root]) } };
}
test("redaction drops unknown OAuth/auth credentials and masks URL fragments", () => {
  const output = maskServerConfig({ url: "https://example.test/mcp#private-token", oauth: { clientId: "public", clientSecret: "secret", futureToken: "hidden" }, auth: { provider: "public", token: "hidden" }, extensionSecret: "hidden" });
  assert.equal(output.url, mask); assert.equal(output.oauth.clientSecret, mask);
  assert.equal(output.oauth.futureToken, undefined); assert.equal(output.auth.token, undefined);
  assert.equal(output.extensionSecret, undefined);
});
test("OAuth metadata override is validated and redacted values round-trip without leaking secrets", async (t) => {
  const f = fixture(t); const file = join(f.agentDir, "mcp.json");
  const url = "https://issuer.example/metadata?token=synthetic-private#secret";
  writeFileSync(file, JSON.stringify({ mcpServers: { demo: { url: "https://example.test/mcp", oauth: { authServerMetadataUrl: url, future: true } } } }));
  const catalog = await getMcpCatalog(f.options);
  assert.equal(catalog.files[0].servers[0].config.oauth.authServerMetadataUrl, mask);
  assert.doesNotMatch(JSON.stringify(catalog), /synthetic-private/);
  const form = serverToMcpForm("global", catalog.files[0].servers[0]);
  await putMcpServer({ scope: "global", name: "demo", revision: catalog.files[0].revision,
    config: formToMcpServerPatch({ ...form, oauth: JSON.stringify({ authServerMetadataUrl: mask, clientName: "fixture" }) }) }, f.options);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).mcpServers.demo.oauth.authServerMetadataUrl, url);
  const refreshed = await getMcpCatalog(f.options);
  await putMcpServer({ scope: "global", name: "demo", revision: refreshed.files[0].revision,
    config: { oauth: { authServerMetadataUrl: null } } }, f.options);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).mcpServers.demo.oauth.authServerMetadataUrl, undefined);
  for (const valid of ["https://issuer.example/.well-known/oauth-authorization-server", "http://localhost:4321/metadata", "http://127.0.0.1/metadata", "http://[::1]/metadata"]) {
    assert.equal(validateOAuth({ authServerMetadataUrl: valid }), null);
  }
  for (const invalid of ["http://issuer.example/metadata", "file:///secret", "https://user:secret@issuer.example", "http://localhost.example/metadata", "bad", "", 1]) {
    assert.match(validateOAuth({ authServerMetadataUrl: invalid }), /authServerMetadataUrl/);
    const latest = await getMcpCatalog(f.options);
    await assert.rejects(putMcpServer({ scope: "global", name: "bad", revision: latest.files[0].revision, config: { url: "https://example.test", oauth: { authServerMetadataUrl: invalid } } }, f.options), /authServerMetadataUrl/);
  }
  const latest = await getMcpCatalog(f.options);
  await assert.rejects(putMcpServer({ scope: "global", name: "new", revision: latest.files[0].revision, config: { url: "https://example.test", oauth: { authServerMetadataUrl: mask } } }, f.options), /masked saved values/);
});

test("map prototype names survive safely and invalid values are never silently dropped", () => {
  const original = JSON.parse('{"command":"node","env":{"__proto__":"secret","constructor":"secret"}}');
  const redacted = maskServerConfig(original);
  assert.equal(Object.hasOwn(redacted.env, "__proto__"), true);
  assert.equal(redacted.env.__proto__, mask);
  const restored = restoreAndMergeServerConfig({ env: redacted.env }, original);
  assert.equal(restored.env.__proto__, "secret"); assert.equal(Object.getPrototypeOf(restored.env), Object.prototype);
  assert.throws(() => restoreAndMergeServerConfig({ env: { TOKEN: 42 } }, original), /must be strings/);
  assert.throws(() => restoreAndMergeServerConfig({ headers: { TOKEN: null } }, { url: "https://example.test" }), /must be strings/);
  assert.deepEqual(restoreAndMergeServerConfig({ oauth: {} }, { url: "https://example.test", oauth: { clientSecret: "secret" } }).oauth, {});
});
test("invalid stored values cannot leak through catalog validation diagnostics", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { demo: { type: "secret-transport-value", command: "node" } } }));
  const catalog = await getMcpCatalog(f.options);
  assert.doesNotMatch(JSON.stringify(catalog), /secret-transport-value/);
  assert.equal(catalog.errors.length, 1);
});
test("global configuration symlinks are rejected before reading or writing", async (t) => {
  const f = fixture(t); const target = join(f.root, "external.json");
  const raw = '{"mcpServers":{}}'; writeFileSync(target, raw);
  symlinkSync(target, join(f.agentDir, "mcp.json"), "file");
  await assert.rejects(putMcpServer({ scope: "global", name: "x", revision: sha256Hex(raw), config: { command: "node" } }, f.options), McpSecurityError);
  assert.equal(readFileSync(target, "utf8"), raw);
});
test("dangling project configuration symlinks are rejected, not treated as missing", async (t) => {
  const f = fixture(t); new ProjectTrustStore(f.agentDir).set(f.cwd, true);
  symlinkSync(join(f.root, "missing.json"), join(f.piDir, "mcp.json"), "file");
  await assert.rejects(putMcpServer({ scope: "project", cwd: f.cwd, name: "x", revision: "missing", config: { command: "node" } }, f.options), McpSecurityError);
});
test("trust is rechecked after waiting on the configuration lock", async (t) => {
  const f = fixture(t); const store = new ProjectTrustStore(f.agentDir); store.set(f.cwd, true);
  const file = join(f.piDir, "mcp.json"); const raw = '{"mcpServers":{}}'; writeFileSync(file, raw);
  const release = await lockfile.lock(f.piDir, { realpath: false, lockfilePath: `${file}.lock` });
  const pending = putMcpServer({ scope: "project", cwd: f.cwd, name: "x", revision: sha256Hex(raw), config: { command: "node" } }, f.options);
  const rejected = assert.rejects(pending, /no longer explicitly trusted/);
  store.set(f.cwd, false); await release(); await rejected;
  assert.equal(readFileSync(file, "utf8"), raw);
});
test("redacted form saves retain unknown auth fields, while OAuth null explicitly clears options", async (t) => {
  const f = fixture(t); const file = join(f.agentDir, "mcp.json");
  writeFileSync(file, JSON.stringify({ mcpServers: {
    oauth: { url: "https://example.test/oauth", oauth: { futureToken: "synthetic-private" } },
    provider: { url: "https://example.test/provider", auth: { provider: "fixture-provider", futureToken: "synthetic-private" } },
  } }));
  let catalog = await getMcpCatalog(f.options);
  assert.doesNotMatch(JSON.stringify(catalog), /synthetic-private/);
  for (const name of ["oauth", "provider"]) {
    const form = serverToMcpForm("global", catalog.files[0].servers.find((server) => server.name === name));
    catalog = await putMcpServer({ scope: "global", name, revision: catalog.files[0].revision, config: formToMcpServerPatch({ ...form, description: "changed" }) }, f.options);
  }
  let servers = JSON.parse(readFileSync(file, "utf8")).mcpServers;
  assert.equal(servers.oauth.oauth.futureToken, "synthetic-private");
  assert.equal(servers.provider.auth.futureToken, "synthetic-private");
  const form = serverToMcpForm("global", catalog.files[0].servers.find((server) => server.name === "oauth"));
  await putMcpServer({ scope: "global", name: "oauth", revision: catalog.files[0].revision, config: formToMcpServerPatch({ ...form, oauth: "null" }) }, f.options);
  servers = JSON.parse(readFileSync(file, "utf8")).mcpServers;
  assert.equal(servers.oauth.oauth, undefined);
  assert.equal(servers.provider.auth.futureToken, "synthetic-private");
});

test("SDK defaults are removed from persisted server fields without losing unrelated data", async (t) => {
  const f = fixture(t); const file = join(f.agentDir, "mcp.json");
  const raw = '{\n\t"future": true,\n\t"mcpServers": {"demo":{"command":"node","other":"keep"}}\n}\n';
  writeFileSync(file, raw);
  await putMcpServer({ scope: "global", name: "demo", revision: sha256Hex(raw), config: { enabled: true, exposure: "codemode" } }, f.options);
  const text = readFileSync(file, "utf8"); const parsed = JSON.parse(text);
  assert.equal(parsed.mcpServers.demo.enabled, undefined); assert.equal(parsed.mcpServers.demo.exposure, undefined);
  assert.equal(parsed.mcpServers.demo.other, "keep"); assert.equal(parsed.future, true); assert.match(text, /\n\t"future"/);
});
