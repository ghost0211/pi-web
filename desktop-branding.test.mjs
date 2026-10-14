import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hooksPath = fileURLToPath(new URL("./src-tauri/windows/hooks.nsi", import.meta.url));
const hooks = readFileSync(hooksPath, "utf8");
const shortcuts = readFileSync(new URL("./src-tauri/windows/shortcut-name.nsh", import.meta.url), "utf8");

test("desktop startup page uses Pi Desktop without changing readiness diagnostics", () => {
  const html = readFileSync(new URL("./desktop/loading/index.html", import.meta.url), "utf8");
  assert.match(html, /<title>Pi Desktop<\/title>/);
  assert.match(html, /<h1>Starting Pi Desktop…<\/h1>/);
  assert.doesNotMatch(html, /Pi Web Desktop/);
  assert.match(html, /com\.github\.ghost0211\.pi-web\\logs\\pi-web-server\.log/);
  assert.match(html, /20000/);
});

test("pi desktop shortcut is separate from the stable installer and runtime identities", () => {
  const config = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const cargo = readFileSync(new URL("./src-tauri/Cargo.toml", import.meta.url), "utf8");
  const brand = readFileSync(new URL("./lib/app-brand.ts", import.meta.url), "utf8");
  assert.equal(config.productName, "Pi Web Desktop");
  assert.equal(config.identifier, "com.github.ghost0211.pi-web");
  assert.equal(config.bundle.windows.nsis.installerHooks, "./windows/hooks.nsi");
  assert.match(brand, /DESKTOP_APP_DISPLAY_NAME = "Pi Desktop"/);
  assert.match(shortcuts, /PI_WEB_DESKTOP_SHORTCUT_NAME "pi"/);
  assert.ok(shortcuts.includes(`PI_WEB_DESKTOP_LEGACY_NAME "${config.productName}"`));
  const binaryName = cargo.match(/\[package\][\s\S]*?\bname = "([^"]+)"/)?.[1];
  assert.ok(shortcuts.includes(`PI_WEB_DESKTOP_BINARY_NAME "${binaryName}.exe"`));
  assert.match(hooks, /!include "\$\{__FILEDIR__\}\\shortcut-name\.nsh"/);
});

test("shortcut migration covers late GUI creation and only cleans successful real uninstalls", () => {
  assert.match(shortcuts, /Function \.onGUIEnd\s+\$\{If\} \$PiWebInstallationFinished = 1\s+Call PiWebMigrateDesktopShortcut/);
  const post = hooks.match(/!macro NSIS_HOOK_POSTINSTALL\b([\s\S]*?)!macroend/)?.[1] ?? "";
  assert.ok(post.indexOf("Call PiWebMigrateDesktopShortcut") < post.indexOf("CreateShortcut"), "rename before repair to retain link arguments");
  assert.match(post, /\$UpdateMode = 1/);
  assert.match(post, /SetLnkAppUserModelId/);
  assert.match(hooks, /!macro NSIS_HOOK_POSTUNINSTALL[\s\S]*?\$UpdateMode <> 1[\s\S]*?Call un\.PiWebRemoveDesktopShortcut/);
  assert.doesNotMatch(hooks, /!macro NSIS_HOOK_PREUNINSTALL/);
  assert.match(shortcuts, /IsShortcutTarget/);
  assert.match(shortcuts, /Rename/);
  assert.match(shortcuts, /UnpinShortcut/);
});

const makensis = process.env.PI_WEB_TEST_MAKENSIS
  ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "tauri", "NSIS", "makensis.exe") : "");

function readShortcut(path) {
  const escaped = path.replaceAll("'", "''");
  const command = `$ErrorActionPreference = 'Stop'; $ws = New-Object -ComObject WScript.Shell; try { $link = $ws.CreateShortcut('${escaped}'); [pscustomobject]@{ target = $link.TargetPath; arguments = $link.Arguments; workingDirectory = $link.WorkingDirectory } | ConvertTo-Json -Compress } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($ws) }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test("compiled NSIS hooks rename owned desktop shortcuts and preserve unrelated links", {
  skip: process.platform !== "win32" || !existsSync(makensis),
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-shortcut-brand-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installDir = join(root, "installation with spaces");
  const desktopDir = join(root, "isolated desktop");
  const scriptPath = join(root, "branding.nsi");
  const installer = join(root, "branding.exe");
  const mainBinary = join(installDir, "pi-web-desktop.exe");
  const foreignBinary = join(installDir, "foreign.exe");
  const oldLink = join(desktopDir, "Pi Web Desktop.lnk");
  const piLink = join(desktopDir, "pi.lnk");

  // The same COM implementation used by Tauri's IsShortcutTarget helper.
  // Only process checks, AppUserModelId setting and unpinning are stubbed: this
  // fixture tests our real hook code, never real user shortcuts or registry.
  writeFileSync(scriptPath, `
Unicode true
!include LogicLib.nsh
!include FileFunc.nsh
!include "Win\\COM.nsh"
!include "Win\\Propkey.nsh"
!define /ifndef MAX_PATH 260
!define /ifndef SLGP_RAWPATH 0x4
!macro IsShortcutTarget shortcut target
  StrCpy $3 0
  !insertmacro ComHlpr_CreateInProcInstance \${CLSID_ShellLink} \${IID_IShellLink} r0 ""
  \${If} $0 P<> 0
    \${IUnknown::QueryInterface} $0 '("\${IID_IPersistFile}", .r1)'
    \${If} $1 P<> 0
      \${IPersistFile::Load} $1 '("\${shortcut}", \${STGM_READ})'
      System::Alloc MAX_PATH
      Pop $2
      \${IShellLink::GetPath} $0 '(.r2, \${MAX_PATH}, 0, \${SLGP_RAWPATH})'
      \${If} $2 == "\${target}"
        StrCpy $3 1
      \${EndIf}
      System::Free $2
      \${IUnknown::Release} $1 ""
    \${EndIf}
    \${IUnknown::Release} $0 ""
  \${EndIf}
  Push $3
!macroend
!macro CheckIfAppIsRunning mainBinary productName
!macroend
!macro SetLnkAppUserModelId link
!macroend
!macro UnpinShortcut link
!macroend
!define PI_WEB_DESKTOP_ROOT "${desktopDir}"
; Match Tauri's include ordering: product/binary definitions come after hooks.
!include "${hooksPath}"
!define PRODUCTNAME "Pi Web Desktop"
!define MAINBINARYNAME "pi-web-desktop"
Var UpdateMode
Var TestCase
Name "Pi Web Shortcut Test"
OutFile "${installer}"
InstallDir "${installDir}"
RequestExecutionLevel user
SilentInstall silent
Function un.onInit
  \${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  \${IfNot} \${Errors}
    StrCpy $UpdateMode 1
  \${EndIf}
  ClearErrors
FunctionEnd
Section
  \${GetOptions} $CMDLINE "/CASE=" $TestCase
  \${If} $TestCase == "update-legacy"
  \${OrIf} $TestCase == "update-missing"
  \${OrIf} $TestCase == "already-pi"
  \${OrIf} $TestCase == "collision"
    StrCpy $UpdateMode 1
  \${EndIf}
  SetOutPath $INSTDIR
  WriteUninstaller "$INSTDIR\\uninstall.exe"
  \${If} $TestCase == "fresh"
  \${OrIf} $TestCase == "update-legacy"
  \${OrIf} $TestCase == "duplicate"
  \${OrIf} $TestCase == "collision"
  \${OrIf} $TestCase == "failed-gui"
    CreateShortcut "${oldLink}" "${mainBinary}" "--keep-argument"
  \${EndIf}
  \${If} $TestCase == "foreign-legacy"
    CreateShortcut "${oldLink}" "${foreignBinary}" "--foreign"
  \${EndIf}
  \${If} $TestCase == "duplicate"
  \${OrIf} $TestCase == "already-pi"
  \${OrIf} $TestCase == "owned-uninstall"
    CreateShortcut "${piLink}" "${mainBinary}" "--keep-pi"
  \${EndIf}
  \${If} $TestCase == "collision"
  \${OrIf} $TestCase == "foreign-uninstall"
    CreateShortcut "${piLink}" "${foreignBinary}" "--foreign"
  \${EndIf}
  \${If} $TestCase == "failed-gui"
    ; Closing a failed/aborted installer must not migrate existing links.
    StrCpy $PiWebInstallationFinished 0
    Call .onGUIEnd
  \${Else}
    !insertmacro NSIS_HOOK_POSTINSTALL
    \${If} $TestCase == "late-gui"
      ; The real GUI finish checkbox creates this AFTER POSTINSTALL.
      CreateShortcut "${oldLink}" "${mainBinary}" "--keep-argument"
      Call .onGUIEnd
    \${EndIf}
  \${EndIf}
SectionEnd
Section Uninstall
  ; Raw stored target checks still work after the executable is removed.
  Delete "$INSTDIR\\pi-web-desktop.exe"
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
`);
  const compile = spawnSync(makensis, ["/V2", scriptPath], { encoding: "utf8", timeout: 30_000 });
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);

  const reset = () => {
    rmSync(installDir, { recursive: true, force: true });
    rmSync(desktopDir, { recursive: true, force: true });
    mkdirSync(installDir, { recursive: true });
    mkdirSync(desktopDir, { recursive: true });
    writeFileSync(mainBinary, "shortcut target fixture");
    writeFileSync(foreignBinary, "unrelated shortcut target");
  };
  const run = (scenario) => {
    reset();
    const result = spawnSync(installer, ["/S", `/CASE=${scenario}`], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };
  const assertOwnedPi = (argumentsValue) => {
    assert.equal(existsSync(oldLink), false);
    assert.equal(existsSync(piLink), true);
    const link = readShortcut(piLink);
    assert.equal(link.target.toLowerCase(), mainBinary.toLowerCase());
    assert.equal(link.arguments, argumentsValue);
    assert.equal(link.workingDirectory.toLowerCase(), installDir.toLowerCase());
  };

  for (const scenario of ["fresh", "update-legacy", "late-gui"]) {
    await t.test(`${scenario} preserves arguments and working directory`, () => {
      run(scenario);
      assertOwnedPi("--keep-argument");
    });
  }
  await t.test("updater repairs a missing shortcut as pi", () => {
    run("update-missing");
    assertOwnedPi("");
  });
  for (const scenario of ["duplicate", "already-pi"]) {
    await t.test(`${scenario} retains the existing pi link settings`, () => {
      run(scenario);
      assertOwnedPi("--keep-pi");
    });
  }
  await t.test("pi name collision never overwrites an unrelated shortcut", () => {
    run("collision");
    assert.equal(existsSync(oldLink), true);
    assert.equal(readShortcut(oldLink).arguments, "--keep-argument");
    assert.equal(readShortcut(piLink).target.toLowerCase(), foreignBinary.toLowerCase());
    assert.equal(readShortcut(piLink).arguments, "--foreign");
  });
  await t.test("an unrelated legacy-name shortcut is not renamed", () => {
    run("foreign-legacy");
    assert.equal(existsSync(piLink), false);
    assert.equal(readShortcut(oldLink).target.toLowerCase(), foreignBinary.toLowerCase());
  });
  await t.test("a failed installation leaves the existing shortcut unchanged", () => {
    run("failed-gui");
    assert.equal(existsSync(piLink), false);
    assert.equal(readShortcut(oldLink).arguments, "--keep-argument");
  });
  for (const [scenario, update, expected] of [["owned-uninstall", false, false], ["owned-uninstall", true, true], ["foreign-uninstall", false, true]]) {
    await t.test(`${scenario}${update ? " /UPDATE" : ""} cleans only an owned link after success`, () => {
      run(scenario);
      // NSIS parses _?= as the unquoted command-line tail, even with spaces.
      // Quoting this argument makes it fork a temp uninstaller and return early.
      const result = spawnSync(join(installDir, "uninstall.exe"), ["/S", ...(update ? ["/UPDATE"] : []), `_?=${installDir}`], { encoding: "utf8", timeout: 30_000, windowsVerbatimArguments: true });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(existsSync(mainBinary), false);
      assert.equal(existsSync(piLink), expected);
      if (scenario === "foreign-uninstall") {
        assert.equal(readShortcut(piLink).target.toLowerCase(), foreignBinary.toLowerCase());
      }
    });
  }
});
