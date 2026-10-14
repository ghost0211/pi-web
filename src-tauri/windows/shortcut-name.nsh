; Keep the installer identity stable, but display the desktop shortcut as pi.
; Tauri includes installer hooks before defining PRODUCTNAME/MAINBINARYNAME,
; so these legacy identities are explicit and checked by desktop-branding tests.
!define /ifndef PI_WEB_DESKTOP_ROOT "$DESKTOP"
!define PI_WEB_DESKTOP_SHORTCUT_NAME "pi"
!define PI_WEB_DESKTOP_LEGACY_NAME "Pi Web Desktop"
!define PI_WEB_DESKTOP_BINARY_NAME "pi-web-desktop.exe"

; Tauri supplies the COM-based target and unpin helpers. Minimal payload-only
; installer harnesses do not, and must not touch the user's real shortcuts.
!ifmacrodef IsShortcutTarget
Var PiWebInstallationFinished

Function PiWebMigrateDesktopShortcut
  Push $0
  Push $1
  Push $2
  Push $3
  !insertmacro IsShortcutTarget "${PI_WEB_DESKTOP_ROOT}\${PI_WEB_DESKTOP_LEGACY_NAME}.lnk" "$INSTDIR\${PI_WEB_DESKTOP_BINARY_NAME}"
  Pop $0
  ${If} $0 = 1
    ${If} ${FileExists} "${PI_WEB_DESKTOP_ROOT}\${PI_WEB_DESKTOP_SHORTCUT_NAME}.lnk"
      !insertmacro IsShortcutTarget "${PI_WEB_DESKTOP_ROOT}\${PI_WEB_DESKTOP_SHORTCUT_NAME}.lnk" "$INSTDIR\${PI_WEB_DESKTOP_BINARY_NAME}"
      Pop $0
      ${If} $0 = 1
        ; Keep the already-renamed link; remove only our duplicate legacy link.
        Delete "${PI_WEB_DESKTOP_ROOT}\${PI_WEB_DESKTOP_LEGACY_NAME}.lnk"
      ${Else}
        DetailPrint "Desktop shortcut name pi is already in use; keeping the existing shortcuts."
      ${EndIf}
    ${Else}
      ; Rename preserves shortcut arguments, working directory and AppUserModelId.
      ClearErrors
      Rename "${PI_WEB_DESKTOP_ROOT}\${PI_WEB_DESKTOP_LEGACY_NAME}.lnk" "${PI_WEB_DESKTOP_ROOT}\${PI_WEB_DESKTOP_SHORTCUT_NAME}.lnk"
      ${If} ${Errors}
        DetailPrint "Could not rename the desktop shortcut; the original link was preserved."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; An interactive installer creates its desktop link on the finish page, AFTER
; POSTINSTALL. Migrate that late link too, but never after a failed installation.
Function .onGUIEnd
  ${If} $PiWebInstallationFinished = 1
    Call PiWebMigrateDesktopShortcut
  ${EndIf}
FunctionEnd

Function un.PiWebRemoveDesktopShortcut
  Push $0
  Push $1
  Push $2
  Push $3
  !insertmacro IsShortcutTarget "${PI_WEB_DESKTOP_ROOT}\${PI_WEB_DESKTOP_SHORTCUT_NAME}.lnk" "$INSTDIR\${PI_WEB_DESKTOP_BINARY_NAME}"
  Pop $0
  ${If} $0 = 1
    !insertmacro UnpinShortcut "${PI_WEB_DESKTOP_ROOT}\${PI_WEB_DESKTOP_SHORTCUT_NAME}.lnk"
    Delete "${PI_WEB_DESKTOP_ROOT}\${PI_WEB_DESKTOP_SHORTCUT_NAME}.lnk"
  ${EndIf}
  ClearErrors
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif
