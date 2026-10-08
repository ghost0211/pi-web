import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const root = mkdtempSync(join(tmpdir(), "pi-web-live-command-"));
const rpc = join(root, "rpc.ts"); const reader = join(root, "reader.ts");
writeFileSync(rpc, `export const getRpcSession=()=>globalThis.__liveCommandFixture;
export const startRpcSession=()=>{throw new Error('must not start a session')};
export const setRpcSessionTools=()=>{throw new Error('not used')};`);
writeFileSync(reader, "export const resolveSessionPath=()=>{throw new Error('must not inspect a session file')}");
const loader = createJiti(import.meta.url, { alias: { "@/lib/rpc-manager": rpc, "@/lib/session-reader": reader, "@/lib/session-deletion-guard": join(process.cwd(), "lib/session-deletion-guard.ts") } });
const { POST } = await loader.import("./[id]/route.ts");
const { beginSessionDeletion } = await loader.import("../../../lib/session-deletion-guard.ts");
test.after(() => { delete globalThis.__liveCommandFixture; rmSync(root, { recursive: true, force: true }); });
const req = () => new Request("http://localhost/api/agent/id", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "reload", requireLiveSession: true }) });
test("no-start commands refuse missing or expired wrappers before any file lookup", async () => {
  for (const entry of [undefined, { isAlive: () => false }]) {
    globalThis.__liveCommandFixture = entry;
    assert.equal((await POST(req(), { params: Promise.resolve({ id: "id" }) })).status, 409);
  }
});
test("deletion barriers reject prompts without starting or writing a live session", async () => {
  let sends = 0;
  globalThis.__liveCommandFixture = { isAlive: () => true, send: async () => { sends += 1; } };
  const barrier = beginSessionDeletion(["id"]);
  try {
    const request = new Request("http://localhost/api/agent/id", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "prompt", message: "blocked" }) });
    const response = await POST(request, { params: Promise.resolve({ id: "id" }) });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.accepted, false);
    assert.equal(body.code, "prompt_rejected");
    assert.equal(sends, 0);
  } finally { barrier.release(); }
});

test("no-start reload uses the existing wrapper only", async () => {
  let command;
  globalThis.__liveCommandFixture = { isAlive: () => true, send: async (value) => { command = value; return {}; } };
  assert.equal((await POST(req(), { params: Promise.resolve({ id: "id" }) })).status, 200);
  assert.equal(command.requireLiveSession, true);
});
