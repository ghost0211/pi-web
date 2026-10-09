// The About panel must label the registry comparison target as "current
// version". Showing the latest registry version next to an "update available"
// pill for that same version reads as a contradiction.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./AboutConfig.tsx", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

function rowFor(labelKey) {
  const start = source.indexOf(`t("${labelKey}")`);
  assert.notEqual(start, -1, `missing row labeled ${labelKey}`);
  // The row ends where the next labeled property row begins.
  const next = source.indexOf("about-property-label", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("labels the comparison target as the current version", () => {
  const row = rowFor("about.currentVersion");
  assert.match(row, /info\?\.piAgent\.currentVersion \? `v\$\{info\.piAgent\.currentVersion\}`/);
  // The status pill lives in the current-version row, not the latest-version one.
  assert.match(row, /about-status-pill/);
  assert.match(row, /about\.statusUpdateAvailable/);
  assert.match(row, /about\.statusUpToDate/);
});

test("does not repeat the registry version in a row of its own", () => {
  // The current-version row's pill already names the latest registry version,
  // so a separate "latest version" row would only restate it.
  assert.equal(source.includes('t("about.latestVersion")'), false);
  assert.equal(source.includes("about.latestVersion"), false);
  const row = rowFor("about.currentVersion");
  assert.match(row, /t\("about\.statusUpdateAvailable", \{ version: `v\$\{info\.piAgent\.latestVersion\}` \}\)/);
});

test("reports the source of the current version without new translation keys", () => {
  const row = rowFor("about.currentVersion");
  assert.match(row, /currentVersionSource === "cli"[\s\S]{0,80}t\("about\.globalCli"\)/);
  assert.match(row, /currentVersionSource === "sdk"[\s\S]{0,80}t\("about\.embeddedKernel"\)/);
});

test("shows the check-failed state instead of a stale pill", () => {
  const row = rowFor("about.currentVersion");
  assert.match(row, /!info\?\.piAgent\.latestVersion && info\?\.piAgent\.error/);
  assert.match(row, /about\.statusCheckFailed/);
});

test("uses the shorter runtime brand only for the desktop shell", () => {
  assert.match(source, /const desktopApp = useIsDesktopApp\(\)/);
  assert.match(source, /const appName = info\?\.appName \?\? appDisplayName\(desktopApp\)/);
  assert.match(source, /`### \$\{appName\} Diagnostics`/);
  assert.match(source, /subtitle=\{appName\}/);
  assert.match(source, /<h2 className="about-app-title">\{appName\}<\/h2>/);
});

test("copies the current version and its source into diagnostics", () => {
  assert.match(source, /`- \*\*Pi Agent Current Version:\*\* \$\{info\.piAgent\.currentVersion \?\? "unknown"\}/);
  assert.match(source, /`- \*\*Pi Agent Latest Registry:\*\* \$\{info\.piAgent\.latestVersion \?\? "unknown"\}`/);
});

test("shows the install root only for desktop and keeps diagnostics cwd distinct", () => {
  assert.match(source, /const installationDir = info\?\.isDesktop \? info\.system\.installationDir : null;/);
  assert.match(source, /installationDir \? t\("about\.installationDir"\) : t\("about\.cwd"\)/);
  assert.match(source, /installationDir \?\? info\?\.system\.cwd \?\? "-"/);
  assert.match(source, /installationDir \? \[`- \*\*\$\{t\("about\.installationDir"\)\}:\*\* \$\{installationDir\}`\] : \[\]/);
  assert.match(source, /`- \*\*\$\{t\("about\.cwd"\)\}:\*\* \$\{info\.system\.cwd\}`/);
});

test("defines installation and runtime working-directory labels in all supported locales", async () => {
  const locales = [
    { file: "../lib/i18n/messages/en.ts", installation: "Application Installation Directory", cwd: "Runtime Working Directory" },
    { file: "../lib/i18n/messages/zh-CN.ts", installation: "应用安装目录", cwd: "运行时工作目录" },
    { file: "../lib/i18n/messages/zh-TW.ts", installation: "應用程式安裝目錄", cwd: "執行時工作目錄" },
  ];

  for (const locale of locales) {
    const messages = await readFile(new URL(locale.file, import.meta.url), "utf8");
    assert.ok(messages.includes(`"about.installationDir": "${locale.installation}"`));
    assert.ok(messages.includes(`"about.cwd": "${locale.cwd}"`));
  }
});
