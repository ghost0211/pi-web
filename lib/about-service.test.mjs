import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getAppVersion,
  getPiAgentInstalledVersion,
  getPiAgentCliVersion,
  getAboutInfo,
} = await jiti.import("./about-service.ts");

test("returns a valid application version", () => {
  const version = getAppVersion();
  assert.ok(typeof version === "string" && version.length > 0);
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test("reads installed Pi Agent version", () => {
  const installed = getPiAgentInstalledVersion();
  // In this workspace, @earendil-works/pi-coding-agent is installed
  assert.ok(installed === null || (typeof installed === "string" && /^\d+\.\d+\.\d+/.test(installed)));
  const cli = getPiAgentCliVersion();
  assert.ok(cli === null || typeof cli === "string");
});

test("returns complete about information", async () => {
  const info = await getAboutInfo();
  assert.ok(info.appName === "Pi Web" || info.appName === "Pi Web Desktop");
  assert.ok(typeof info.appVersion === "string");
  assert.equal(info.gitRepo.name, "ghost0211/pi-web");
  assert.ok(info.gitRepo.url.includes("github.com"));
  assert.ok(info.gitRepo.releasesUrl.includes("releases"));
  assert.ok(info.gitRepo.issuesUrl.includes("issues"));

  assert.equal(info.piAgent.packageName, "@earendil-works/pi-coding-agent");
  assert.ok(typeof info.piAgent.updateAvailable === "boolean");
  assert.ok(typeof info.piAgent.lastCheckedAt === "number");

  assert.ok(info.system.nodeVersion.startsWith("v"));
  assert.ok(typeof info.system.platform === "string");
  assert.ok(typeof info.system.arch === "string");
  assert.ok(typeof info.system.cwd === "string");
});
