import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const source = await readFile(new URL("./proxy.ts", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("./proxy.ts");
const { getAuthRetryAfterMs, recordAuthSuccess } = await import("./lib/auth-throttle.ts");

const originalPassword = process.env.PI_WEB_PASSWORD;
const originalDesktop = process.env.PI_WEB_DESKTOP;

beforeEach(() => {
  recordAuthSuccess();
});

after(() => {
  recordAuthSuccess();
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
  if (originalDesktop === undefined) delete process.env.PI_WEB_DESKTOP;
  else process.env.PI_WEB_DESKTOP = originalDesktop;
});

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Host: "localhost", ...headers },
  });
}

function basic(password) {
  return `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
}

test("desktop health bypasses Basic Auth only in desktop mode", () => {
  assert.match(source, /process\.env\.PI_WEB_DESKTOP === "1"[\s\S]*?request\.nextUrl\.pathname === "\/api\/desktop-health"/);
  assert.match(source, /!isDesktopHealth\s*&& isWebPasswordEnabled\(password\)/);
});

test("the desktop health exemption remains behind trusted-host validation", () => {
  const trustIndex = source.indexOf("if (!isTrustedRequest)");
  const exemptionIndex = source.indexOf("const isDesktopHealth");
  assert.ok(trustIndex >= 0 && exemptionIndex > trustIndex);
});

test("a wrong Basic password blocks further attempts, even with the right password", () => {
  process.env.PI_WEB_PASSWORD = "secret";
  delete process.env.PI_WEB_DESKTOP;

  assert.equal(proxy(request("/api/test", { Authorization: basic("guess") })).status, 401);
  assert.ok(getAuthRetryAfterMs() > 0);

  const blockedResponse = proxy(request("/api/test", { Authorization: basic("secret") }));
  assert.equal(blockedResponse.status, 429);
  assert.equal(blockedResponse.headers.get("retry-after"), "1");
  assert.equal(blockedResponse.headers.get("cache-control"), "no-store");
});

test("desktop health requests bypass Basic Auth and throttling when in desktop mode", () => {
  process.env.PI_WEB_PASSWORD = "secret";
  process.env.PI_WEB_DESKTOP = "1";

  // Even if auth is currently throttled due to a failed attempt elsewhere:
  proxy(request("/api/test", { Authorization: basic("guess") }));
  assert.ok(getAuthRetryAfterMs() > 0);

  const healthResponse = proxy(request("/api/desktop-health"));
  assert.equal(healthResponse.status, 200);
});

test("only Basic credentials count as password attempts", () => {
  process.env.PI_WEB_PASSWORD = "secret";
  delete process.env.PI_WEB_DESKTOP;

  assert.equal(proxy(request("/api/test", { Authorization: "Bearer token" })).status, 401);
  assert.equal(getAuthRetryAfterMs(), 0);
});

test("successful Basic authentication passes through when credentials match", () => {
  process.env.PI_WEB_PASSWORD = "secret";
  delete process.env.PI_WEB_DESKTOP;

  const response = proxy(request("/api/test", { Authorization: basic("secret") }));
  assert.equal(response.status, 200);
});
