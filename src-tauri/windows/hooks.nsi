; Pi Web Desktop NSIS installer hooks.
;
; NSIS_HOOK_POSTINSTALL: The stock tauri-bundler template skips shortcut
; creation entirely in /UPDATE mode ("Skip creating shortcut if in update
; mode") and nothing else re-creates a missing desktop shortcut, so an icon
; lost to a shortcut cleanup, icon-cache rebuild, or a manual delete never
; comes back when updating. Recreate it if — and only if — it is missing.

!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode = 1
    ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend
