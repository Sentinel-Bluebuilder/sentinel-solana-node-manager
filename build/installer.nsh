; ─── Uninstall cleanup ───
; Setup keeps a copy of itself in %LOCALAPPDATA%\<app>-updater\installer.exe (electron-builder
; does this for updates; this app has no auto-updater). Uninstall removes that copy and the empty
; install folder. An update (isUpdated) keeps both. The wallet and settings in %APPDATA% stay
; (deleteAppDataOnUninstall: false).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    SetShellVarContext current
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    RMDir "$LOCALAPPDATA\sentinel-node-manager-solana-updater"
    ; The uninstaller runs with $INSTDIR as its working folder, and Windows will not remove a
    ; process's working folder: move out of it first.
    SetOutPath "$TEMP"
    RMDir "$INSTDIR"
  ${endIf}
!macroend
