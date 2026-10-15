; Pi Web Desktop NSIS installer hooks.
;
; NSIS /UPDATE overlays resources without uninstalling the old version.
; Stage our generated payloads outside their live paths so stale nested
; node_modules cannot shadow new hoisted dependencies. Keep the old files
; until both directories have been staged and the new payload is installed.
; Never remove $INSTDIR itself or any user settings/session directories.

!include "${__FILEDIR__}\shortcut-name.nsh"

; Kill bundled sidecar node.exe processes by exact image path. The
; running-app check only covers the main binary: a force-quit app (or an
; updater race) can orphan the sidecar, and the running node.exe image keeps
; payload files locked, which previously left undeletable *.previous
; remnants behind and blocked the next install. Matching the full path keeps
; unrelated Node.js processes (dev tools, other apps) untouched. Best effort:
; failures never abort the install, the guards below still apply.
!macro PI_WEB_KILL_BUNDLED_NODE
  Push $8
  Push $9
  FileOpen $9 "$PLUGINSDIR\pi-web-kill-node.ps1" w
  FileWrite $9 "param([string]$$InstallDir)$\n"
  FileWrite $9 "$$targets = @((Join-Path $$InstallDir 'node\node.exe'), (Join-Path $$InstallDir 'node.previous\node.exe'))$\n"
  FileWrite $9 "$$deadline = (Get-Date).AddSeconds(10)$\n"
  FileWrite $9 "do {$\n"
  FileWrite $9 "  $$victims = @(Get-CimInstance Win32_Process -Filter $\"Name = 'node.exe'$\" | Where-Object { $$targets -contains $$_.ExecutablePath })$\n"
  FileWrite $9 "  if ($$victims.Count -eq 0) { break }$\n"
  FileWrite $9 "  foreach ($$victim in $$victims) { Stop-Process -Id $$victim.ProcessId -Force -ErrorAction SilentlyContinue }$\n"
  FileWrite $9 "  Start-Sleep -Milliseconds 200$\n"
  FileWrite $9 "} while ((Get-Date) -lt $$deadline)$\n"
  FileClose $9
  nsExec::ExecToStack "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $\"$PLUGINSDIR\pi-web-kill-node.ps1$\" $\"$INSTDIR$\""
  Pop $8 ; exit code
  Pop $9 ; output (unused)
  ${If} $8 != 0
    DetailPrint "Bundled sidecar cleanup helper returned $8; continuing anyway."
  ${EndIf}
  Pop $9
  Pop $8
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Tauri calls this hook BEFORE its own running-app check.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Release payload locks held by an orphaned sidecar before touching files.
  !insertmacro PI_WEB_KILL_BUNDLED_NODE

  ; With both live payloads intact, existing *.previous directories are pure
  ; cleanup remnants (a sidecar lock blocked their deletion), not recovery
  ; copies: remove them here instead of forcing the user to do it by hand.
  ; When a live payload is missing the remnant may be the only good copy, so
  ; the guard below still aborts in that case. A remnant that is still locked
  ; survives this attempt and is caught by the same guard.
  ${If} ${FileExists} "$INSTDIR\server"
  ${AndIf} ${FileExists} "$INSTDIR\node"
    RMDir /r "$INSTDIR\server.previous"
    RMDir /r "$INSTDIR\node.previous"
    ClearErrors
  ${EndIf}

  ; Do not overwrite recovery copies left by an interrupted installation.
  ${If} ${FileExists} "$INSTDIR\server.previous"
  ${OrIf} ${FileExists} "$INSTDIR\node.previous"
    SetErrorLevel 2
    Abort "A previous installation left recovery payloads. Quit Pi Web Desktop and restore or move server.previous/node.previous before retrying."
  ${EndIf}

  ${If} ${FileExists} "$INSTDIR\server"
    ClearErrors
    Rename "$INSTDIR\server" "$INSTDIR\server.previous"
    ${If} ${Errors}
      SetErrorLevel 2
      Abort "Cannot stage the server payload. Quit Pi Web Desktop and its sidecar, then retry the installation."
    ${EndIf}
  ${EndIf}

  ${If} ${FileExists} "$INSTDIR\node"
    ClearErrors
    Rename "$INSTDIR\node" "$INSTDIR\node.previous"
    ${If} ${Errors}
      ; The second rename failed: restore the first payload before aborting.
      ${If} ${FileExists} "$INSTDIR\server.previous"
        ClearErrors
        Rename "$INSTDIR\server.previous" "$INSTDIR\server"
        ${If} ${Errors}
          SetErrorLevel 2
          Abort "Cannot restore the server payload. The old files are preserved in server.previous; quit Pi Web Desktop and restore that directory before retrying."
        ${EndIf}
      ${EndIf}
      SetErrorLevel 2
      Abort "Cannot stage the Node.js payload. The old installation was preserved; quit Pi Web Desktop and its sidecar, then retry the installation."
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

; Delete recovery payloads only AFTER the new files have been copied. A
; sidecar killed in preinstall can take a moment to release its image, so
; sweep once more first. Whatever is still locked is scheduled for deletion
; on reboot instead of lingering as a remnant that would block the next
; install. Never schedule a live payload for deletion.
!macro PI_WEB_CLEANUP_PREVIOUS_PAYLOADS
  ${If} ${FileExists} "$INSTDIR\server.previous"
  ${OrIf} ${FileExists} "$INSTDIR\node.previous"
    !insertmacro PI_WEB_KILL_BUNDLED_NODE
  ${EndIf}
  RMDir /r /REBOOTOK "$INSTDIR\server.previous"
  ${If} ${FileExists} "$INSTDIR\server.previous"
    DetailPrint "Previous server payload retained in server.previous until reboot; quit any old sidecar to remove it sooner."
  ${EndIf}
  RMDir /r /REBOOTOK "$INSTDIR\node.previous"
  ${If} ${FileExists} "$INSTDIR\node.previous"
    DetailPrint "Previous Node.js payload retained in node.previous until reboot; quit any old sidecar to remove it sooner."
  ${EndIf}
  ClearErrors
!macroend

; Migrate before repairing a missing link so existing shortcut settings survive.
; The stock tauri-bundler template skips shortcut creation in /UPDATE mode.
!macro NSIS_HOOK_POSTINSTALL
  !insertmacro PI_WEB_CLEANUP_PREVIOUS_PAYLOADS
  !ifmacrodef IsShortcutTarget
    StrCpy $PiWebInstallationFinished 1
    Call PiWebMigrateDesktopShortcut
  !endif
  ${If} $UpdateMode = 1
    ${IfNot} ${FileExists} "${PI_WEB_DESKTOP_ROOT}\${PI_WEB_DESKTOP_SHORTCUT_NAME}.lnk"
      CreateShortcut "${PI_WEB_DESKTOP_ROOT}\${PI_WEB_DESKTOP_SHORTCUT_NAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "${PI_WEB_DESKTOP_ROOT}\${PI_WEB_DESKTOP_SHORTCUT_NAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend

; The native template only knows the legacy product-name shortcut. Remove our
; renamed link AFTER a real uninstall, not if it is cancelled; preserve /UPDATE.
!macro NSIS_HOOK_POSTUNINSTALL
  !ifmacrodef IsShortcutTarget
    ${If} $UpdateMode <> 1
      Call un.PiWebRemoveDesktopShortcut
    ${EndIf}
  !endif
!macroend
