import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { componentHarness, tick } from "./mcp-test-harness.mjs";

const modules = await mkdtemp(join(tmpdir(), "pi-about-update-test-"));
const desktopHook = join(modules, "desktop-hook.cjs");
const updater = join(modules, "updater.cjs");
const i18n = join(modules, "i18n.cjs");
await writeFile(desktopHook, "module.exports = { useIsDesktopApp: () => globalThis.__aboutUpdateTest.desktop };");
await writeFile(updater, "module.exports = { checkDesktopUpdate: () => globalThis.__aboutUpdateTest.check(), installDesktopUpdate: (update, progress) => globalThis.__aboutUpdateTest.install(update, progress) };");
await writeFile(i18n, `module.exports = { useI18n: () => ({ t: (key, params = {}) => String(globalThis.__aboutUpdateTest.messages[key] ?? key).replace(/\\{([\\w.-]+)\\}/g, (token, name) => params[name] === undefined ? token : String(params[name])) }) };`);
after(() => rm(modules, { recursive: true, force: true }));
const loader = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  alias: {
    "@/hooks/useIsDesktopApp": desktopHook,
    "@/lib/desktop-update": updater,
    "@/hooks/useI18n": i18n,
    "@/lib/app-brand": join(process.cwd(), "lib/app-brand.ts"),
    "@/lib/clipboard": join(process.cwd(), "lib/clipboard.ts"),
  },
});
const [{ AboutConfig }, { zhCNLocale }, { enLocale }, { zhTWLocale }] = await Promise.all([
  loader.import("./AboutConfig.tsx"),
  loader.import("../lib/i18n/messages/zh-CN.ts"),
  loader.import("../lib/i18n/messages/en.ts"),
  loader.import("../lib/i18n/messages/zh-TW.ts"),
]);

function text(node) {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object") return text(node.props?.children);
  return node === false || node === null || node === undefined ? "" : String(node);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function fixture(t, options = {}) {
  const oldFetch = globalThis.fetch;
  const oldWindow = globalThis.window;
  const oldContext = globalThis.__aboutUpdateTest;
  const ctx = {
    desktop: options.desktop ?? true,
    messages: (options.locale ?? zhCNLocale).messages,
    checks: 0,
    installs: [],
    confirmations: [],
    fetches: [],
    check: async () => { ctx.checks++; return options.check ? options.check() : null; },
    install: async (update, progress) => { ctx.installs.push(update); return options.install?.(progress); },
  };
  globalThis.__aboutUpdateTest = ctx;
  globalThis.window = { confirm: (message) => { ctx.confirmations.push(message); return options.confirm ?? true; } };
  const info = {
    appName: ctx.desktop ? "Pi Desktop" : "Pi Web", appVersion: "0.9.53", isDesktop: ctx.desktop,
    piAgent: { installedVersion: "1.1.0", cliVersion: "1.1.0", currentVersion: "1.1.0", latestVersion: "1.1.0", updateAvailable: false },
    system: { nodeVersion: "v22.19.0", platform: "win32", arch: "x64", cwd: "C:/fixture/server" },
    gitRepo: {},
  };
  globalThis.fetch = async (url, init) => {
    ctx.fetches.push({ url, init });
    return Response.json(info);
  };
  const harness = componentHarness(AboutConfig, { onClose() {}, embedded: true });
  t.after(() => {
    harness.cleanup();
    globalThis.fetch = oldFetch;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldContext === undefined) delete globalThis.__aboutUpdateTest; else globalThis.__aboutUpdateTest = oldContext;
  });
  harness.render();
  await tick();
  harness.render();
  const hero = () => harness.find((node) => node.props.className === "about-hero-card");
  const status = () => harness.find((node) => node.props.className === "about-desktop-update-status");
  const actions = () => harness.find((node) => node.props.className === "about-hero-update-actions");
  const button = (key) => harness.button(ctx.messages[key]);
  const refresh = async () => { await tick(); harness.render(); };
  return { harness, ctx, hero, status, actions, button, refresh };
}

test("desktop update controls are the leftmost hero content, with parenthesized status before the version", async (t) => {
  const f = await fixture(t);
  assert.equal(f.ctx.checks, 1, "opening About still checks automatically");
  const header = f.harness.find((node) => node.props.className === "about-hero-header");
  assert.equal(header.props.children[0].props.className, "about-hero-update-actions");
  assert.equal(f.status().props.role, "status");
  assert.equal(text(f.status()), "(已是最新版本)");
  assert.match(text(f.hero()), /Pi Desktop\(已是最新版本\)v0\.9\.53/);
  assert.doesNotMatch(f.harness.text(), /桌面端更新/);
  assert.ok(f.button("about.checkUpdates"));
  assert.equal(f.button("about.desktopInstallUpdate"), undefined);
  f.button("about.checkUpdates").props.onClick();
  await f.refresh();
  assert.equal(f.ctx.checks, 2, "hero check button uses the desktop updater, not the SDK endpoint");
  assert.equal(f.ctx.fetches.length, 1);
});

test("browser About keeps app identity but exposes no desktop controls or desktop status", async (t) => {
  const f = await fixture(t, { desktop: false });
  assert.equal(f.ctx.checks, 0);
  assert.equal(f.actions(), undefined);
  assert.equal(f.status(), undefined);
  assert.match(text(f.hero()), /Pi Webv0\.9\.53/);
  assert.equal(f.button("about.desktopInstallUpdate"), undefined);
});

test("checking and check failures replace the latest label, with error details in the same hero", async (t) => {
  let pending;
  const f = await fixture(t, { check: () => pending ? pending.promise : null });
  pending = deferred();
  f.button("about.checkUpdates").props.onClick();
  f.harness.render();
  assert.equal(text(f.status()), "(正在检查更新…)");
  assert.equal(f.harness.button("正在检查更新…").props.disabled, true);
  pending.reject(new Error("fixture offline"));
  await f.refresh();
  assert.equal(text(f.status()), "(检查更新失败)");
  assert.doesNotMatch(text(f.hero()), /已是最新版本/);
  assert.match(text(f.hero()), /fixture offline/);
  assert.ok(f.harness.find((node) => node.props.role === "alert"));
});

test("available updates keep confirmation, release notes, progress and retry feedback inside the hero", async (t) => {
  const update = { version: "0.9.54", body: "Fixture release notes" };
  const pending = deferred();
  let progress;
  const f = await fixture(t, {
    check: () => update,
    install: (callback) => { progress = callback; return pending.promise; },
  });
  assert.equal(text(f.status()), "(发现新版本 v0.9.54)");
  assert.match(text(f.hero()), /Fixture release notes/);
  assert.match(text(f.hero()), /安装时桌面端会退出/);
  assert.match(text(f.actions()), /检查更新下载并安装更新/);
  f.button("about.desktopInstallUpdate").props.onClick();
  f.harness.render();
  assert.deepEqual(f.ctx.installs, [update]);
  assert.match(f.ctx.confirmations[0], /v0\.9\.54/);
  assert.equal(f.button("about.checkUpdates").props.disabled, true);
  assert.equal(f.harness.button("正在下载更新 …").props.disabled, true);
  progress({ event: "Started", data: { contentLength: 100 } });
  progress({ event: "Progress", data: { chunkLength: 50 } });
  f.harness.render();
  assert.equal(text(f.status()), "(正在下载更新 50%)");
  progress({ event: "Finished" });
  f.harness.render();
  assert.equal(text(f.status()), "(正在安装更新…)");
  pending.reject(new Error("fixture install failed"));
  await f.refresh();
  assert.equal(text(f.status()), "(检查更新失败)");
  assert.match(text(f.hero()), /fixture install failed/);
  assert.equal(f.button("about.desktopInstallUpdate").props.disabled, false);
  assert.equal(f.button("about.checkUpdates").props.disabled, false);
});

test("cancelling confirmation never calls the native installer", async (t) => {
  const f = await fixture(t, { check: () => ({ version: "0.9.54" }), confirm: false });
  f.button("about.desktopInstallUpdate").props.onClick();
  await f.refresh();
  assert.equal(f.ctx.confirmations.length, 1);
  assert.equal(f.ctx.installs.length, 0);
  assert.equal(f.button("about.desktopInstallUpdate").props.disabled, false);
});

test("parenthesized hero status reuses all three locale labels", async (t) => {
  for (const locale of [enLocale, zhCNLocale, zhTWLocale]) {
    await t.test(locale.id, async (t) => {
      const f = await fixture(t, { locale });
      assert.equal(text(f.status()), `(${locale.messages["about.statusUpToDate"]})`);
      assert.ok(f.harness.button(locale.messages["about.checkUpdates"]));
    });
  }
});
