import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./proxy.ts", import.meta.url), "utf8");

test("desktop health bypasses Basic Auth only in desktop mode", () => {
  assert.match(source, /process\.env\.PI_WEB_DESKTOP === "1"[\s\S]*?request\.nextUrl\.pathname === "\/api\/desktop-health"/);
  assert.match(source, /!isDesktopHealth\s*&& isWebPasswordEnabled\(password\)/);
});

test("the desktop health exemption remains behind trusted-host validation", () => {
  const trustIndex = source.indexOf("if (!isTrustedRequest)");
  const exemptionIndex = source.indexOf("const isDesktopHealth");
  assert.ok(trustIndex >= 0 && exemptionIndex > trustIndex);
});
