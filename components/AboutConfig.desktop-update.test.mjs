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
    return options.fetch ? options.fetch(url, init, info) : Response.json(info);
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
  const button = (key) => harness.button(`${key === "about.checkUpdates" || key === "about.statusChecking" ? "↻" : ""}${ctx.messages[key]}`);
  const refresh = async () => { await tick(); harness.render(); };
  return { harness, ctx, hero, status, actions, button, refresh };
}

test("one shared check follows the app identity, with parenthesized desktop status before the version", async (t) => {
  const f = await fixture(t);
  assert.equal(f.ctx.checks, 1, "opening About still checks automatically");
  const header = f.harness.find((node) => node.props.className === "about-hero-header");
  assert.equal(header.props.children[0].props.className, "about-hero-identity");
  assert.equal(header.props.children[1].props.className, "about-hero-update-actions");
  assert.equal((f.harness.text().match(/检查更新/g) ?? []).length, 1, "the kernel section no longer repeats the check button");
  assert.equal(f.status().props.role, "status");
  assert.equal(text(f.status()), "(已是最新版本)");
  assert.match(text(f.hero()), /Pi Desktop\(已是最新版本\)v0\.9\.53/);
  assert.doesNotMatch(f.harness.text(), /桌面端更新/);
  assert.ok(f.button("about.checkUpdates"));
  assert.equal(f.button("about.desktopInstallUpdate"), undefined);
  f.button("about.checkUpdates").props.onClick();
  await f.refresh();
  assert.equal(f.ctx.checks, 2, "the shared button checks the native updater");
  assert.deepEqual(f.ctx.fetches.map(({ url }) => url), ["/api/about", "/api/about?force=true"], "and forces the runtime registry check");
});

test("browser About uses the shared hero check for the runtime only", async (t) => {
  const f = await fixture(t, { desktop: false });
  assert.equal(f.ctx.checks, 0);
  assert.ok(f.actions());
  assert.equal(f.status(), undefined);
  assert.match(text(f.hero()), /Pi Webv0\.9\.53/);
  assert.equal(f.button("about.desktopInstallUpdate"), undefined);
  assert.equal((f.harness.text().match(/检查更新/g) ?? []).length, 1);
  f.button("about.checkUpdates").props.onClick();
  await f.refresh();
  assert.equal(f.ctx.checks, 0, "web never calls the native updater");
  assert.deepEqual(f.ctx.fetches.map(({ url }) => url), ["/api/about", "/api/about?force=true"]);
});

test("checking and check failures replace the latest label, with error details in the same hero", async (t) => {
  let pending;
  const f = await fixture(t, { check: () => pending ? pending.promise : null });
  pending = deferred();
  f.button("about.checkUpdates").props.onClick();
  f.harness.render();
  assert.equal(text(f.status()), "(正在检查更新…)");
  assert.equal(f.button("about.statusChecking").props.disabled, true);
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
  assert.match(text(f.actions()), /↻检查更新下载并安装更新/);
  f.button("about.desktopInstallUpdate").props.onClick();
  f.harness.render();
  assert.deepEqual(f.ctx.installs, [update]);
  assert.match(f.ctx.confirmations[0], /v0\.9\.54/);
  assert.equal(f.button("about.checkUpdates").props.disabled, true);
  assert.equal(f.button("about.updateCli").props.disabled, true);
  assert.equal(f.button("about.updateSdk").props.disabled, true);
  f.button("about.checkUpdates").props.onClick();
  f.button("about.updateCli").props.onClick();
  assert.equal(f.ctx.checks, 1, "checking is blocked during desktop installation");
  assert.equal(f.ctx.fetches.length, 1, "runtime checking/updating is also blocked");
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

test("shared checking waits for both sources and rejects repeated clicks before rendering", async (t) => {
  for (const first of ["desktop", "runtime"]) {
    await t.test(`${first} finishes first`, async (t) => {
      let pendingDesktop, pendingRuntime;
      const f = await fixture(t, {
        check: () => pendingDesktop ? pendingDesktop.promise : null,
        fetch: (url, init, info) => url.includes("force=true") ? pendingRuntime.promise : Response.json(info),
      });
      pendingDesktop = deferred();
      pendingRuntime = deferred();
      const check = f.button("about.checkUpdates");
      check.props.onClick();
      check.props.onClick();
      f.harness.render();
      assert.equal(f.ctx.checks, 2);
      assert.equal(f.ctx.fetches.length, 2, "both requests start without waiting for either result");
      assert.equal(f.button("about.statusChecking").props.disabled, true);
      assert.equal(f.button("about.updateCli").props.disabled, true);
      assert.equal(f.button("about.updateSdk").props.disabled, true);
      const runtimeResult = Response.json({
        appName: "Pi Desktop", appVersion: "0.9.53", isDesktop: true,
        piAgent: { installedVersion: "1.1.0", currentVersion: "1.1.0", latestVersion: "1.2.0", updateAvailable: true },
        system: {}, gitRepo: {},
      });
      if (first === "desktop") pendingDesktop.resolve({ version: "0.9.54" });
      else pendingRuntime.resolve(runtimeResult);
      await f.refresh();
      assert.equal(f.button("about.statusChecking").props.disabled, true, "the slower source still owns the shared busy state");
      if (first === "desktop") {
        assert.equal(text(f.status()), "(发现新版本 v0.9.54)");
        assert.equal(f.button("about.desktopInstallUpdate").props.disabled, true);
      } else {
        assert.match(f.harness.text(), /v1\.2\.0/);
        assert.equal(text(f.status()), "(正在检查更新…)");
      }
      if (first === "desktop") pendingRuntime.resolve(runtimeResult);
      else pendingDesktop.resolve({ version: "0.9.54" });
      await f.refresh();
      assert.equal(f.button("about.checkUpdates").props.disabled, false);
      assert.equal(f.button("about.desktopInstallUpdate").props.disabled, false);
      assert.equal(f.button("about.updateCli").props.disabled, false);
      assert.equal(f.button("about.updateSdk").props.disabled, false);
      assert.match(f.harness.text(), /v1\.2\.0/);
    });
  }
});

test("a desktop check failure does not suppress a successful runtime result", async (t) => {
  let manual = false;
  const f = await fixture(t, {
    check: () => { if (manual) throw new Error("desktop source offline"); return null; },
    fetch: (url, init, info) => Response.json(url.includes("force=true") ? {
      ...info, piAgent: { ...info.piAgent, latestVersion: "1.2.0", updateAvailable: true },
    } : info),
  });
  manual = true;
  f.button("about.checkUpdates").props.onClick();
  await f.refresh();
  assert.equal(text(f.status()), "(检查更新失败)");
  assert.match(text(f.hero()), /desktop source offline/);
  assert.match(f.harness.text(), /v1\.2\.0/);
  assert.equal(f.button("about.checkUpdates").props.disabled, false);
});

test("a runtime failure does not hide an available desktop release and can be retried", async (t) => {
  let fail = true;
  const f = await fixture(t, {
    check: () => ({ version: "0.9.54", body: "Fixture release notes" }),
    fetch: (url, init, info) => url.includes("force=true") && fail ? new Response(null, { status: 503 }) : Response.json(info),
  });
  f.button("about.checkUpdates").props.onClick();
  await f.refresh();
  assert.match(f.harness.text(), /HTTP 503/);
  assert.equal(text(f.status()), "(发现新版本 v0.9.54)");
  assert.equal(f.button("about.desktopInstallUpdate").props.disabled, false);
  assert.match(text(f.hero()), /Fixture release notes/);
  fail = false;
  f.button("about.checkUpdates").props.onClick();
  await f.refresh();
  assert.doesNotMatch(f.harness.text(), /HTTP 503/);
  assert.equal(f.ctx.checks, 3);
  assert.equal(f.button("about.checkUpdates").props.disabled, false);
});

test("HTTP 200 runtime registry failures keep their own failed status beside desktop success", async (t) => {
  const f = await fixture(t, {
    check: () => ({ version: "0.9.54" }),
    fetch: (url, init, info) => Response.json(url.includes("force=true") ? {
      ...info, piAgent: { ...info.piAgent, latestVersion: null, error: "registry offline", updateAvailable: false },
    } : info),
  });
  f.button("about.checkUpdates").props.onClick();
  await f.refresh();
  const runtimeStatus = f.harness.find(node => node.props.className === "about-status-pill is-check-failed");
  assert.equal(text(runtimeStatus), "检查更新失败");
  assert.equal(runtimeStatus.props.title, "registry offline");
  assert.equal(text(f.status()), "(发现新版本 v0.9.54)");
  assert.equal(f.button("about.checkUpdates").props.disabled, false);
});

test("closing while both sources are pending still handles their rejections", async (t) => {
  let desktopPending, runtimePending;
  const f = await fixture(t, {
    check: () => desktopPending ? desktopPending.promise : null,
    fetch: (url, init, info) => url.includes("force=true") ? runtimePending.promise : Response.json(info),
  });
  desktopPending = deferred();
  runtimePending = deferred();
  f.button("about.checkUpdates").props.onClick();
  f.harness.cleanup();
  desktopPending.reject(new Error("native check offline after close"));
  runtimePending.reject(new Error("runtime offline after close"));
  await tick();
  assert.equal(f.ctx.checks, 2);
  assert.equal(f.ctx.fetches.length, 2);
});

test("runtime installation keeps its target and blocks shared checking and desktop installation", async (t) => {
  for (const target of ["global", "local"]) {
    await t.test(target, async (t) => {
      const pending = deferred();
      const f = await fixture(t, {
        check: () => ({ version: "0.9.54" }),
        fetch: (url, init, info) => init?.method === "POST" ? pending.promise : Response.json(info),
      });
      f.button(target === "global" ? "about.updateCli" : "about.updateSdk").props.onClick();
      f.harness.render();
      assert.equal(f.button("about.checkUpdates").props.disabled, true);
      assert.equal(f.button("about.desktopInstallUpdate").props.disabled, true);
      f.button("about.checkUpdates").props.onClick();
      f.button("about.desktopInstallUpdate").props.onClick();
      assert.equal(f.ctx.checks, 1);
      assert.equal(f.ctx.confirmations.length, 0);
      assert.equal(f.ctx.installs.length, 0);
      assert.equal(f.ctx.fetches.length, 2);
      assert.deepEqual(JSON.parse(f.ctx.fetches[1].init.body), { target });
      pending.resolve(Response.json({ success: true, target, newVersion: "1.2.0" }));
      await f.refresh();
      assert.equal(f.ctx.fetches[2].url, "/api/about?force=true", "runtime post-install refresh remains runtime-only");
      assert.equal(f.ctx.checks, 1);
      assert.equal(f.button("about.checkUpdates").props.disabled, false);
    });
  }
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
      assert.ok(f.button("about.checkUpdates"));
    });
  }
});
