import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-general-settings-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const settingsPath = join(testAgentDir, "settings.json");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  const { rm } = await import("node:fs/promises");
  await rm(testAgentDir, { recursive: true, force: true });
});

function request(body, contentType = "application/json") {
  return new Request("http://localhost/api/settings", {
    method: "PUT",
    headers: { "Content-Type": contentType, Host: "localhost" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("settings route validates and persists the SDK-compatible format", async () => {
  let response = await GET();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).defaultProjectTrust, "prompt");

  response = await PUT(request({
    compactionEnabled: false,
    retryEnabled: false,
    defaultThinkingLevel: "auto",
    defaultProjectTrust: "auto",
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    compaction: { enabled: false },
    retry: { enabled: false },
    defaultProjectTrust: "always",
  });

  response = await PUT(request({ retryEnabled: "no" }));
  assert.equal(response.status, 400);
  response = await PUT(request("{", "application/json"));
  assert.equal(response.status, 400);
  response = await PUT(request({}, "text/plain"));
  assert.equal(response.status, 415);
});

test("settings route refuses to overwrite malformed configuration", async () => {
  await writeFile(settingsPath, "{");
  const response = await PUT(request({ retryEnabled: true }));
  assert.equal(response.status, 500);
  assert.equal(await readFile(settingsPath, "utf8"), "{");
});
