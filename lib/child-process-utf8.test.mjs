import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { applyUtf8ChildProcessDefaults, UTF8_CHILD_ENV_DEFAULTS } = await createJiti(import.meta.url).import("./child-process-utf8.ts");

test("sets Java and Python UTF-8 defaults on Windows", () => {
  const env = applyUtf8ChildProcessDefaults({}, "win32");
  assert.match(env.JAVA_TOOL_OPTIONS, /-Dstdout\.encoding=UTF-8/);
  assert.match(env.JAVA_TOOL_OPTIONS, /-Dsun\.stdout\.encoding=UTF-8/);
  assert.equal(env.PYTHONIOENCODING, "utf-8");
});

test("leaves other platforms untouched", () => {
  const env = applyUtf8ChildProcessDefaults({ PATH: "/usr/bin" }, "linux");
  assert.deepEqual(env, { PATH: "/usr/bin" });
  const mac = applyUtf8ChildProcessDefaults({}, "darwin");
  assert.deepEqual(mac, {});
});

test("keeps a user-supplied JAVA_TOOL_OPTIONS and appends only missing flags", () => {
  const env = applyUtf8ChildProcessDefaults({ JAVA_TOOL_OPTIONS: "-Xmx2g" }, "win32");
  assert.ok(env.JAVA_TOOL_OPTIONS.startsWith("-Xmx2g "), env.JAVA_TOOL_OPTIONS);
  assert.match(env.JAVA_TOOL_OPTIONS, /-Dstdout\.encoding=UTF-8/);

  const already = applyUtf8ChildProcessDefaults({ JAVA_TOOL_OPTIONS: "-Dstdout.encoding=UTF-8" }, "win32");
  assert.equal((already.JAVA_TOOL_OPTIONS.match(/-Dstdout\.encoding=UTF-8/g) ?? []).length, 1);
});

test("finds an existing lowercase key instead of duplicating it", () => {
  const env = { pythonioencoding: "gbk" };
  applyUtf8ChildProcessDefaults(env, "win32");
  assert.equal(env.pythonioencoding, "gbk", "an explicit value wins");
  assert.equal(env.PYTHONIOENCODING, undefined, "no duplicate key");
});

test("does not overwrite an explicit PYTHONIOENCODING", () => {
  const env = applyUtf8ChildProcessDefaults({ PYTHONIOENCODING: "gbk" }, "win32");
  assert.equal(env.PYTHONIOENCODING, "gbk");
});

test("is idempotent", () => {
  const env = applyUtf8ChildProcessDefaults({}, "win32");
  const first = { ...env };
  applyUtf8ChildProcessDefaults(env, "win32");
  assert.deepEqual(env, first);
});

test("defaults are the documented flags", () => {
  assert.equal(UTF8_CHILD_ENV_DEFAULTS.PYTHONIOENCODING, "utf-8");
  assert.equal(UTF8_CHILD_ENV_DEFAULTS.JAVA_TOOL_OPTIONS.split(" ").length, 4);
});

// The regression this module fixes: a JVM on a zh-CN Windows writes GBK into a
// piped stdout, while the shell tool decodes as UTF-8. Gated on a machine that
// actually has both PowerShell and a JDK.
function hasExecutable(name) {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", windowsHide: true });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

const JAVA_SOURCE = `public class EncodingProbe {
  public static void main(String[] args) {
    System.out.println("10\\u6708 20, 2026 5:15:14 \\u4e0b\\u5348 org.postgresql \\u4e2d\\u6587\\u65e5\\u5fd7");
  }
}`;

test("an unconfigured JVM mangles Chinese and the defaults fix it", { skip: process.platform !== "win32" || !hasExecutable("pwsh") || !hasExecutable("java") }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-utf8-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "EncodingProbe.java");
  writeFileSync(source, JAVA_SOURCE, "utf8");

  const prefix = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
  const run = (env) => {
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `${prefix}& java "${source}"`], {
      encoding: "buffer",
      windowsHide: true,
      env,
    });
    return (result.stdout ?? Buffer.alloc(0)).toString("utf8");
  };

  const withoutDefaults = { ...process.env };
  delete withoutDefaults.JAVA_TOOL_OPTIONS;
  const broken = run(withoutDefaults);
  // The JVM's own encoding decides this; when it already emits UTF-8 there is
  // nothing to fix and the assertion below is the only meaningful one.
  const wasBroken = broken.includes("\uFFFD");

  const withDefaults = applyUtf8ChildProcessDefaults({ ...withoutDefaults }, "win32");
  const fixed = run(withDefaults);
  assert.ok(!fixed.includes("\uFFFD"), `expected readable output, got ${JSON.stringify(fixed)}`);
  assert.match(fixed, /\u4e2d\u6587\u65e5\u5fd7/);
  if (wasBroken) assert.doesNotMatch(broken, /\u4e2d\u6587\u65e5\u5fd7/);
});
