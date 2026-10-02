import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const originalSuiteAgentDir = process.env.PI_CODING_AGENT_DIR;
const suiteAgentDir = mkdtempSync(path.join(tmpdir(), "pi-web-mcp-route-suite-"));
process.env.PI_CODING_AGENT_DIR = suiteAgentDir;
test.after(() => {
  if (originalSuiteAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalSuiteAgentDir;
  rmSync(suiteAgentDir, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { GET, PUT, DELETE } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { MCP_SAVED_VALUE_MASK, MISSING_REVISION } = await jiti.import("../../../lib/mcp-types.ts");

function setupTestEnvironment(t) {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tempDir = mkdtempSync(path.join(tmpdir(), "pi-web-mcp-route-test-"));
  const agentDir = path.join(tempDir, "agent");
  const projectDir = path.join(tempDir, "project");

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  process.env.PI_CODING_AGENT_DIR = agentDir;
  allowFileRoot(tempDir);

  t.after(() => {
    if (originalAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  return { tempDir, agentDir, projectDir };
}

function makePutRequest(body, contentType = "application/json") {
  return new Request("http://localhost/api/mcp", {
    method: "PUT",
    headers: { "Content-Type": contentType, Host: "localhost" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeDeleteRequest(body, contentType = "application/json") {
  return new Request("http://localhost/api/mcp", {
    method: "DELETE",
    headers: { "Content-Type": contentType, Host: "localhost" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("GET /api/mcp returns global catalog and reflects project trust state", async (t) => {
  const { agentDir, projectDir } = setupTestEnvironment(t);

  // 1. GET without cwd
  const res1 = await GET(new Request("http://localhost/api/mcp", { headers: { Host: "localhost" } }));
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  assert.equal(data1.files.length, 1);
  assert.equal(data1.files[0].scope, "global");
  assert.equal(data1.files[0].revision, MISSING_REVISION);
  assert.deepEqual(data1.project, { cwd: null, trusted: false });

  // 2. GET with untrusted cwd (bare project is not implicitly trusted)
  const res2 = await GET(
    new Request(`http://localhost/api/mcp?cwd=${encodeURIComponent(projectDir)}`, {
      headers: { Host: "localhost" },
    }),
  );
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.equal(data2.files.length, 1); // Only global file returned for untrusted project
  assert.equal(data2.project.trusted, false);

  // 3. GET with explicitly trusted cwd
  new ProjectTrustStore(agentDir).set(projectDir, true);
  const res3 = await GET(
    new Request(`http://localhost/api/mcp?cwd=${encodeURIComponent(projectDir)}`, {
      headers: { Host: "localhost" },
    }),
  );
  assert.equal(res3.status, 200);
  const data3 = await res3.json();
  assert.equal(data3.files.length, 2);
  assert.equal(data3.project.trusted, true);
  assert.equal(data3.files[1].scope, "project");
});

test("PUT /api/mcp validates payload, handles mask, and manages revisions", async (t) => {
  setupTestEnvironment(t);

  // 1. Missing fields return 400
  const invalidRes = await PUT(makePutRequest({ scope: "global" }));
  assert.equal(invalidRes.status, 400);

  // 2. New entry using mask returns 400
  const maskRes = await PUT(
    makePutRequest({
      scope: "global",
      name: "test-new",
      config: { command: "node", args: [MCP_SAVED_VALUE_MASK] },
      revision: MISSING_REVISION,
    }),
  );
  assert.equal(maskRes.status, 400);

  // 3. Stale revision returns 409 conflict
  const conflictRes = await PUT(
    makePutRequest({
      scope: "global",
      name: "test-server",
      config: { command: "node", args: ["index.js"] },
      revision: "stale-revision-123",
    }),
  );
  assert.equal(conflictRes.status, 409);

  // 4. Successful global server creation
  const putRes = await PUT(
    makePutRequest({
      scope: "global",
      name: "test-server",
      config: {
        command: "node",
        args: ["index.js", "--key", "secret"],
        env: { API_KEY: "secret-key" },
      },
      revision: MISSING_REVISION,
    }),
  );
  assert.equal(putRes.status, 200);
  const catalog = await putRes.json();
  const server = catalog.files[0].servers[0];
  assert.equal(server.name, "test-server");
  assert.deepEqual(server.config.args, [MCP_SAVED_VALUE_MASK]);
  assert.deepEqual(server.config.env, { API_KEY: MCP_SAVED_VALUE_MASK });

  // 5. Updating existing server restoring masked values
  const currentRevision = catalog.files[0].revision;
  const updateRes = await PUT(
    makePutRequest({
      scope: "global",
      name: "test-server",
      config: {
        args: [MCP_SAVED_VALUE_MASK],
        env: { API_KEY: MCP_SAVED_VALUE_MASK, NEW_KEY: "val2" },
      },
      revision: currentRevision,
    }),
  );
  assert.equal(updateRes.status, 200);
  const updatedCatalog = await updateRes.json();
  assert.equal(updatedCatalog.files[0].servers[0].name, "test-server");
});

test("DELETE /api/mcp validates revision and deletes server", async (t) => {
  setupTestEnvironment(t);

  // First create a server
  const putRes = await PUT(
    makePutRequest({
      scope: "global",
      name: "to-delete",
      config: { command: "node", args: ["app.js"] },
      revision: MISSING_REVISION,
    }),
  );
  assert.equal(putRes.status, 200);
  const catalog = await putRes.json();
  const revision = catalog.files[0].revision;

  // Stale revision DELETE returns 409
  const conflictDel = await DELETE(
    makeDeleteRequest({
      scope: "global",
      name: "to-delete",
      revision: "stale-revision",
    }),
  );
  assert.equal(conflictDel.status, 409);

  // Valid revision DELETE returns 200 and removes server
  const validDel = await DELETE(
    makeDeleteRequest({
      scope: "global",
      name: "to-delete",
      revision,
    }),
  );
  assert.equal(validDel.status, 200);
  const finalCatalog = await validDel.json();
  assert.equal(finalCatalog.files[0].servers.length, 0);
});

test("project scope operations require trusted project and authorized root", async (t) => {
  const { agentDir, projectDir } = setupTestEnvironment(t);

  // 1. Untrusted project PUT rejected with 403
  const untrustedRes = await PUT(
    makePutRequest({
      scope: "project",
      cwd: projectDir,
      name: "proj-server",
      config: { command: "node", args: ["proj.js"] },
      revision: MISSING_REVISION,
    }),
  );
  assert.equal(untrustedRes.status, 403);

  // 2. Project outside allowedRoots rejected with 403
  const outsideDir = mkdtempSync(path.join(tmpdir(), "pi-outside-"));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));

  new ProjectTrustStore(agentDir).set(outsideDir, true);

  const outsideRes = await PUT(
    makePutRequest({
      scope: "project",
      cwd: outsideDir,
      name: "outside-server",
      config: { command: "node", args: ["proj.js"] },
      revision: MISSING_REVISION,
    }),
  );
  assert.equal(outsideRes.status, 403);
});
