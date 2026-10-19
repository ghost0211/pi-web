import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

function request(body, headers = { "Content-Type": "application/json" }) {
  return new Request("http://localhost/api/cwd/mkdir", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("creates one folder inside the parent and returns its canonical path", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pi-web-mkdir-route-"));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const response = await POST(request({ parent, name: "浦东数据稽核" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(path.basename(body.path), "浦东数据稽核");
  assert.equal(existsSync(body.path), true);
});

test("rejects a folder name that would escape the browsed directory", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pi-web-mkdir-escape-"));
  t.after(() => rm(parent, { recursive: true, force: true }));

  for (const name of ["../outside", "nested/child", "a\\b", "", "  "]) {
    const response = await POST(request({ parent, name }));
    assert.equal(response.status, 400, `${JSON.stringify(name)} must be rejected`);
    const body = await response.json();
    assert.equal(typeof body.code, "string");
  }
  assert.equal(existsSync(path.join(parent, "..", "outside")), false);
});

test("reports an existing target as a conflict instead of overwriting it", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pi-web-mkdir-conflict-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(path.join(parent, "taken"));

  const response = await POST(request({ parent, name: "taken" }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "already-exists");
});

test("rejects a missing parent directory without creating it", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pi-web-mkdir-missing-"));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const response = await POST(request({ parent: path.join(parent, "nope", "deep"), name: "child" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "parent-missing");
  assert.equal(existsSync(path.join(parent, "nope")), false);
});

test("requires a JSON content type and a parent path", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pi-web-mkdir-guards-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeFile(path.join(parent, "file.txt"), "x", "utf8");

  assert.equal((await POST(request({ parent, name: "child" }, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await POST(request({ name: "child" }))).status, 400);
  assert.equal((await POST(request({ parent: path.join(parent, "file.txt"), name: "child" }))).status, 400);
});
