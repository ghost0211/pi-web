import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const hooksPath = fileURLToPath(new URL("./src-tauri/windows/hooks.nsi", import.meta.url));
const hooks = readFileSync(hooksPath, "utf8");
const preinstall = hooks.match(/!macro NSIS_HOOK_PREINSTALL\b([\s\S]*?)!macroend/)?.[1];

test("NSIS stages only generated payloads, rolls back staging failure and cleans after installation", () => {
  const config = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(config.bundle.windows.nsis.installerHooks, "./windows/hooks.nsi");
  assert.ok(preinstall, "preinstall hook is required to prevent mixed-version resources");
  const commands = preinstall.replace(/;[^\r\n]*/g, "");
  assert.deepEqual([...commands.matchAll(/Rename\s+"([^"]+)"\s+"([^"]+)"/gi)].map((m) => [m[1], m[2]]), [
    ["$INSTDIR\\server", "$INSTDIR\\server.previous"],
    ["$INSTDIR\\node", "$INSTDIR\\node.previous"],
    ["$INSTDIR\\server.previous", "$INSTDIR\\server"],
  ]);
  assert.ok(commands.indexOf("CheckIfAppIsRunning") < commands.indexOf("Rename"));
  // A force-quit update can orphan the bundled sidecar; kill it by exact image
  // path BEFORE staging so a locked node.exe cannot leave *.previous remnants.
  assert.ok(commands.indexOf("PI_WEB_KILL_BUNDLED_NODE") > commands.indexOf("CheckIfAppIsRunning"));
  assert.ok(commands.indexOf("PI_WEB_KILL_BUNDLED_NODE") < commands.indexOf("Rename"));
  // Benign remnants from an interrupted cleanup are deleted immediately, but
  // only while BOTH live payloads are intact; preinstall never touches live
  // payloads, never schedules reboot-time deletion, and never leaves the
  // install directory.
  assert.match(commands, /\$\{If\} \$\{FileExists\} "\$INSTDIR\\server"\s*\$\{AndIf\} \$\{FileExists\} "\$INSTDIR\\node"\s*RMDir \/r "\$INSTDIR\\server\.previous"\s*RMDir \/r "\$INSTDIR\\node\.previous"\s*ClearErrors\s*\$\{EndIf\}/);
  assert.deepEqual([...commands.matchAll(/RMDir\s+\/r\s+"([^"]+)"/gi)].map((m) => m[1]).sort(), [
    "$INSTDIR\\node.previous", "$INSTDIR\\server.previous",
  ]);
  assert.doesNotMatch(commands, /UpdateMode|PassiveMode|APPDATA|LOCALAPPDATA|PROFILE|REBOOTOK/i);
  assert.equal((commands.match(/\bAbort\b/g) ?? []).length, 4, "staging/recovery failures must fail closed");
  assert.equal((commands.match(/SetErrorLevel 2/g) ?? []).length, 4, "passive updates must report failure");

  // The sidecar killer is best-effort and strictly scoped to this install:
  // exact node.exe image paths, a bounded wait, and it never aborts.
  const kill = hooks.match(/!macro PI_WEB_KILL_BUNDLED_NODE\b([\s\S]*?)!macroend/)?.[1];
  assert.ok(kill, "orphaned sidecar cleanup is required");
  assert.match(kill, /Join-Path \$+InstallDir 'node\\node\.exe'/);
  assert.match(kill, /Join-Path \$+InstallDir 'node\.previous\\node\.exe'/);
  assert.match(kill, /Name = 'node\.exe'/);
  assert.match(kill, /\$\$targets -contains \$\$_\.ExecutablePath/);
  assert.match(kill, /AddSeconds\(10\)/);
  assert.doesNotMatch(kill, /\bAbort\b/);

  const cleanup = hooks.match(/!macro PI_WEB_CLEANUP_PREVIOUS_PAYLOADS\b([\s\S]*?)!macroend/)?.[1];
  assert.ok(cleanup);
  assert.ok(cleanup.indexOf("PI_WEB_KILL_BUNDLED_NODE") < cleanup.indexOf("RMDir"), "kill before cleanup");
  // Locked remnants are scheduled for deletion on reboot instead of blocking
  // the next install; live payloads and the install root are never scheduled.
  assert.deepEqual([...cleanup.matchAll(/RMDir\s+\/r\s+\/REBOOTOK\s+"([^"]+)"/gi)].map((m) => m[1]), [
    "$INSTDIR\\server.previous", "$INSTDIR\\node.previous",
  ]);
  assert.doesNotMatch(cleanup, /\bAbort\b/);
  assert.deepEqual([...hooks.matchAll(/\/REBOOTOK/g)].length > 0, true);
  assert.doesNotMatch(commands, /\/REBOOTOK/);
  assert.match(hooks, /!macro NSIS_HOOK_POSTINSTALL\s+!insertmacro PI_WEB_CLEANUP_PREVIOUS_PAYLOADS[\s\S]*?CreateShortcut/);
});

test("CI keeps full Web checks on Linux and requires compiled NSIS tests before publishing", () => {
  const workflow = readFileSync(new URL("./.github/workflows/desktop-windows.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  for (const step of ["Test web app", "Typecheck web app", "Lint web app"]) {
    assert.ok(workflow.includes(`- name: ${step}\n        if: matrix.os == 'ubuntu-latest'`));
  }
  assert.match(workflow, /if \(-not \(Test-Path \$env:PI_WEB_TEST_MAKENSIS\)\).*throw/);
  assert.ok(workflow.indexOf("node --test desktop-installer.test.mjs") < workflow.indexOf("- name: Publish signed desktop release"));
});

const makensis = process.env.PI_WEB_TEST_MAKENSIS
  ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "tauri", "NSIS", "makensis.exe") : "");

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function importSdk(serverDir) {
  return spawnSync(process.execPath, ["--input-type=module", "-e",
    `await import(${JSON.stringify(pathToFileURL(join(serverDir, "node_modules/@earendil-works/pi-coding-agent/index.js")).href)});`,
  ], { encoding: "utf8", timeout: 15_000 });
}

test("compiled NSIS hook removes stale nested SDK packages without touching user data", {
  skip: process.platform !== "win32" || !existsSync(makensis),
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-installer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installDir = join(root, "installation with spaces");
  const sourceDir = join(root, "source");
  const sdkPath = "node_modules/@earendil-works/pi-coding-agent";
  const tuiPath = "node_modules/@earendil-works/pi-tui";
  const serverDir = join(installDir, "server");
  const sdkCode = 'import { setImageTranscoder } from "@earendil-works/pi-tui"; setImageTranscoder();';
  for (const path of [sdkPath, tuiPath]) {
    write(join(sourceDir, "server", path, "package.json"), '{"type":"module","main":"index.js","version":"1.0.3"}');
  }
  write(join(sourceDir, "server", sdkPath, "index.js"), sdkCode);
  write(join(sourceDir, "server", tuiPath, "index.js"), "export function setImageTranscoder() {}");
  write(join(sourceDir, "node", "runtime.txt"), "new-runtime");

  // Use the actual hook, but mock Tauri's process/shortcut macros. Compilation
  // and extraction exercise real NSIS /UPDATE semantics, not a JS imitation.
  const installer = join(root, "installer.exe");
  const script = join(root, "installer.nsi");
  write(script, `
Unicode true
!include LogicLib.nsh
!include FileFunc.nsh
!define MAINBINARYNAME "pi-web-desktop"
!define PRODUCTNAME "Pi Web Installer Test"
Var UpdateMode
!macro CheckIfAppIsRunning mainBinary productName
  FileOpen $0 "$INSTDIR\\checked-app.txt" w
  FileWrite $0 "checked-before-cleanup"
  FileClose $0
!macroend
!macro SetLnkAppUserModelId link
!macroend
!include "${hooksPath}"
Name "Pi Web Installer Test"
OutFile "${installer}"
InstallDir "${installDir}"
RequestExecutionLevel user
SilentInstall silent
Function .onInit
  \${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  \${IfNot} \${Errors}
    StrCpy $UpdateMode 1
  \${EndIf}
FunctionEnd
Section
  SetOutPath $INSTDIR
  !insertmacro NSIS_HOOK_PREINSTALL
  SetOutPath "$INSTDIR\\server"
  File /r "${join(sourceDir, "server")}\\*"
  SetOutPath "$INSTDIR\\node"
  File /r "${join(sourceDir, "node")}\\*"
  ; Exercise the real postinstall cleanup, but do not create a test shortcut
  ; on the user's desktop. /UPDATE was already exercised by preinstall.
  StrCpy $UpdateMode 0
  !insertmacro NSIS_HOOK_POSTINSTALL
  FileOpen $0 "$INSTDIR\\installed.txt" w
  FileWrite $0 "finished"
  FileClose $0
SectionEnd
`);
  const compile = spawnSync(makensis, ["/V2", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);

  for (const mode of ["fresh", "reinstall", "update"]) {
    await t.test(mode, () => {
      rmSync(installDir, { recursive: true, force: true });
      write(join(installDir, "keep-user-file.txt"), "keep-install-root");
      const userData = join(root, "user-data", ".pi", "agent", "sessions", "sample.jsonl");
      write(userData, "preserve-session-and-credentials");
      if (mode !== "fresh") {
        cpSync(sourceDir, installDir, { recursive: true });
        write(join(serverDir, sdkPath, tuiPath, "package.json"), '{"type":"module","main":"index.js","version":"0.99.1"}');
        write(join(serverDir, sdkPath, tuiPath, "index.js"), "export const legacy = true;");
        write(join(serverDir, ".next", "old-chunk.js"), "obsolete-chunk");
        write(join(installDir, "node", "obsolete.txt"), "obsolete-runtime");
        const before = importSdk(serverDir);
        assert.notEqual(before.status, 0);
        assert.match(before.stderr, /does not provide an export named 'setImageTranscoder'/);
      }
      const result = spawnSync(installer, mode === "update" ? ["/S", "/UPDATE"] : ["/S"], {
        encoding: "utf8", timeout: 30_000,
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(readFileSync(join(installDir, "checked-app.txt"), "utf8"), "checked-before-cleanup");
      assert.equal(readFileSync(join(installDir, "installed.txt"), "utf8"), "finished");
      assert.equal(existsSync(join(installDir, "server.previous")), false);
      assert.equal(existsSync(join(installDir, "node.previous")), false);
      assert.equal(existsSync(join(serverDir, sdkPath, tuiPath)), false);
      assert.equal(existsSync(join(serverDir, ".next", "old-chunk.js")), false);
      assert.equal(existsSync(join(installDir, "node", "obsolete.txt")), false);
      assert.equal(readFileSync(join(installDir, "node", "runtime.txt"), "utf8"), "new-runtime");
      assert.equal(readFileSync(join(installDir, "keep-user-file.txt"), "utf8"), "keep-install-root");
      assert.equal(readFileSync(userData, "utf8"), "preserve-session-and-credentials");
      const after = importSdk(serverDir);
      assert.equal(after.status, 0, after.stderr);
    });
  }

  for (const dir of ["server", "node"]) {
    await t.test(`locked ${dir} staging preserves BOTH old payloads`, async () => {
      rmSync(installDir, { recursive: true, force: true });
      cpSync(sourceDir, installDir, { recursive: true });
      write(join(serverDir, "old-server.txt"), "old-server");
      write(join(installDir, "node", "runtime.txt"), "old-runtime");
      assert.equal(importSdk(serverDir).status, 0, "old installation must be usable before update");
      const lockedDir = join(installDir, dir);
      // Lock the directory itself without FILE_SHARE_DELETE so its Rename
      // fails reliably, even on Windows versions that can rename open files.
      const locker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PayloadLock {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$handle = [PayloadLock]::CreateFile('${lockedDir.replaceAll("'", "''")}', 1, 0, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
if ($handle -eq [IntPtr](-1)) { throw 'Cannot lock fixture directory' }
try { [Console]::WriteLine('ready'); Start-Sleep -Seconds 30 } finally { [void][PayloadLock]::CloseHandle($handle) }
`], { stdio: ["ignore", "pipe", "pipe"] });
      const unlocked = new Promise((resolve) => { locker.once("exit", resolve); locker.once("error", resolve); });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("directory-lock fixture timed out")), 10_000);
          let output = "";
          locker.stdout.on("data", (data) => {
            output += data.toString();
            if (output.includes("ready")) { clearTimeout(timer); resolve(); }
          });
          locker.once("error", (error) => { clearTimeout(timer); reject(error); });
          locker.once("exit", () => { clearTimeout(timer); reject(new Error("directory-lock fixture exited")); });
        });
        const result = spawnSync(installer, ["/S", "/UPDATE"], { timeout: 30_000 });
        assert.equal(result.status, 2, "staging failure must return a failed installer exit code");
        assert.equal(existsSync(join(installDir, "installed.txt")), false);
      } finally {
        locker.kill();
        await unlocked;
      }
      assert.equal(readFileSync(join(serverDir, "old-server.txt"), "utf8"), "old-server");
      assert.equal(readFileSync(join(installDir, "node", "runtime.txt"), "utf8"), "old-runtime");
      assert.equal(existsSync(join(installDir, "server.previous")), false);
      assert.equal(existsSync(join(installDir, "node.previous")), false);
      assert.equal(importSdk(serverDir).status, 0, "old installation must remain usable after rollback");
    });
  }

  for (const dir of ["server", "node"]) {
    await t.test(`existing ${dir}.previous auto-cleans when live payloads are intact`, () => {
      rmSync(installDir, { recursive: true, force: true });
      cpSync(sourceDir, installDir, { recursive: true });
      const recovery = join(installDir, `${dir}.previous`, "recover.txt");
      write(recovery, "stale-cleanup-remnant");
      const result = spawnSync(installer, ["/S", "/UPDATE"], { encoding: "utf8", timeout: 30_000 });
      // Both live payloads exist, so the remnant is a leftover from an
      // interrupted cleanup, not a recovery copy: remove it and proceed.
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(existsSync(recovery), false);
      assert.equal(existsSync(join(installDir, `${dir}.previous`)), false);
      assert.equal(readFileSync(join(installDir, "installed.txt"), "utf8"), "finished");
      assert.equal(importSdk(serverDir).status, 0);
    });

    await t.test(`existing ${dir}.previous aborts when a live payload is missing`, () => {
      rmSync(installDir, { recursive: true, force: true });
      cpSync(sourceDir, installDir, { recursive: true });
      const recovery = join(installDir, `${dir}.previous`, "recover.txt");
      write(recovery, "preserve-recovery-copy");
      rmSync(join(installDir, dir), { recursive: true, force: true });
      const result = spawnSync(installer, ["/S", "/UPDATE"], { encoding: "utf8", timeout: 30_000 });
      // A live payload is missing, so the remnant may be the only good copy:
      // keep the fail-closed guard and never touch it or the other payload.
      assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
      assert.equal(readFileSync(recovery, "utf8"), "preserve-recovery-copy");
      assert.equal(existsSync(join(installDir, "installed.txt")), false);
      const other = dir === "server" ? "node" : "server";
      assert.equal(existsSync(join(installDir, other)), true, "untouched payload must remain");
      assert.equal(existsSync(join(installDir, `${other}.previous`)), false);
    });
  }

  await t.test("orphaned bundled sidecar is killed by exact image path before staging", async () => {
    rmSync(installDir, { recursive: true, force: true });
    cpSync(sourceDir, installDir, { recursive: true });
    // Pretend a previous force-quit update left a live sidecar running from
    // the install dir, plus an unrelated Node.js process that must survive.
    const sidecarExe = join(installDir, "node", "node.exe");
    cpSync(process.execPath, sidecarExe);
    const sentinelExe = join(root, "sentinel", "node.exe");
    cpSync(process.execPath, sentinelExe);
    const sidecar = spawn(sidecarExe, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const sentinel = spawn(sentinelExe, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    t.after(() => { for (const p of [sidecar, sentinel]) { if (p.exitCode === null && p.signalCode === null) p.kill(); } });
    await new Promise((resolve, reject) => {
      let started = 0;
      const timer = setTimeout(() => reject(new Error("fixture processes failed to start")), 5_000);
      for (const p of [sidecar, sentinel]) {
        p.once("spawn", () => { started += 1; if (started === 2) { clearTimeout(timer); resolve(); } });
        p.once("error", (error) => { clearTimeout(timer); reject(error); });
      }
    });
    const result = spawnSync(installer, ["/S", "/UPDATE"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    // The exact-path killer removed the fake sidecar, so the locked payload
    // could be staged, installed and cleaned up.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sidecar survived the update")), 10_000);
      if (sidecar.exitCode !== null || sidecar.signalCode !== null) { clearTimeout(timer); resolve(); return; }
      sidecar.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    assert.equal(readFileSync(join(installDir, "installed.txt"), "utf8"), "finished");
    assert.equal(existsSync(join(installDir, "server.previous")), false);
    assert.equal(existsSync(join(installDir, "node.previous")), false);
    // Exact image-path matching: the unrelated Node.js process is untouched.
    assert.equal(sentinel.exitCode, null);
    assert.equal(sentinel.signalCode, null);
    assert.equal(importSdk(serverDir).status, 0);
    // Kill and await the sentinel before temp-dir cleanup releases its exe.
    sentinel.kill();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sentinel did not exit")), 5_000);
      if (sentinel.exitCode !== null || sentinel.signalCode !== null) { clearTimeout(timer); resolve(); return; }
      sentinel.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  });
});
