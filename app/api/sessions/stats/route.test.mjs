import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

const SESSION_A = "01a11fe6-75a0-7748-b30b-db3e71f06c71";
const SESSION_B = "01a12e3a-1111-7748-b30b-db3e71f06c71";

function request(body, headers = { "Content-Type": "application/json" }) {
  return new Request("http://localhost/api/sessions/stats", {
    method: "POST",
    // A constructed Request carries no Host header; the API guard requires one.
    headers: { Host: "localhost", Origin: "http://localhost", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("rejects untrusted origins, wrong content types and oversized bodies", async () => {
  assert.equal((await POST(request({ ids: [SESSION_A] }, { Origin: "http://evil.example" }))).status, 403);
  assert.equal((await POST(request({ ids: [SESSION_A] }, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await POST(request({ ids: [SESSION_A], pad: "x".repeat(9 * 1024) }))).status, 413);
});

test("validates ids, roles and the request size", async () => {
  for (const body of [
    {},
    { ids: [] },
    { ids: "not-an-array" },
    { ids: [1] },
    { ids: ["not-a-uuid"] },
    { ids: [SESSION_A, "../etc/passwd"] },
    { ids: Array.from({ length: 33 }, (_, index) => `01a11fe6-75a0-7748-b30b-db3e71f06c${String(index).padStart(2, "0")}`) },
  ]) {
    const response = await POST(request(body));
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
  }
});

test("an unknown session reports unreadable instead of fabricated zeros", async () => {
  const response = await POST(request({ ids: [SESSION_B] }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stats[SESSION_B].unreadable, true);
  assert.equal(body.stats[SESSION_B].tokens, 0);
  assert.equal(body.stats[SESSION_B].cost, 0);
});

test("the response never carries paths, cwd or message text", async () => {
  const response = await POST(request({ ids: [SESSION_B], roles: { [SESSION_B]: "subagent" } }));
  const text = await response.text();
  assert.doesNotMatch(text, /jsonl|\/sessions\/|cwd/);
  const body = JSON.parse(text);
  assert.equal(body.stats[SESSION_B].role, "subagent");
});
