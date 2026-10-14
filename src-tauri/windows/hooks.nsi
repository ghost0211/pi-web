; Pi Web Desktop NSIS installer hooks.
;
; NSIS /UPDATE overlays resources without uninstalling the old version.
; Stage our generated payloads outside their live paths so stale nested
; node_modules cannot shadow new hoisted dependencies. Keep the old files
; until both directories have been staged and the new payload is installed.
; Never remove $INSTDIR itself or any user settings/session directories.

!include "${__FILEDIR__}\shortcut-name.nsh"

!macro NSIS_HOOK_PREINSTALL
  ; Tauri calls this hook BEFORE its own running-app check.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

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

; Delete recovery payloads only AFTER the new files have been copied.
; A locked backup can stay for manual recovery/cleanup without mixing old
; packages into the new runtime. Never schedule a live payload for deletion.
!macro PI_WEB_CLEANUP_PREVIOUS_PAYLOADS
  RMDir /r "$INSTDIR\server.previous"
  ${If} ${FileExists} "$INSTDIR\server.previous"
    DetailPrint "Previous server payload retained in server.previous; quit any old sidecar before removing it."
  ${EndIf}
  RMDir /r "$INSTDIR\node.previous"
  ${If} ${FileExists} "$INSTDIR\node.previous"
    DetailPrint "Previous Node.js payload retained in node.previous; quit any old sidecar before removing it."
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
