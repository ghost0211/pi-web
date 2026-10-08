; Pi Web Desktop NSIS installer hooks.
;
; NSIS /UPDATE overlays resources without uninstalling the old version.
; Stage our generated payloads outside their live paths so stale nested
; node_modules cannot shadow new hoisted dependencies. Keep the old files
; until both directories have been staged and the new payload is installed.
; Never remove $INSTDIR itself or any user settings/session directories.
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

; The stock tauri-bundler template skips shortcut creation in /UPDATE mode.
; Recreate a missing desktop shortcut, but leave existing shortcuts alone.
!macro NSIS_HOOK_POSTINSTALL
  !insertmacro PI_WEB_CLEANUP_PREVIOUS_PAYLOADS
  ${If} $UpdateMode = 1
    ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend
