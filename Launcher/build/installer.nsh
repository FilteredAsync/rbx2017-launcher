; Extra steps for the RobloxClient Launcher installer (electron-builder NSIS).
;
; Installing a new version first removes the old one. Normally that deletes
; the whole install folder, which would lose each player's settings
; (config\client.json: server address and username), the download cache and
; the game files and Roblox Studio the launcher downloaded (Client\, Studio\).
; On an update this keeps config\, cache\, Client\ and Studio\ (the full
; installer then lays its own client files over it); a real uninstall still
; removes everything. The install
; folder is always the launcher's own subfolder (the installer adds it to
; whatever folder is picked).
;
; A real uninstall also removes what the launcher kept outside its folder:
; its app data (%APPDATA%\RobloxClient Launcher, with launcher.log; done by
; "deleteAppDataOnUninstall" in package.json), its update downloads
; (%LOCALAPPDATA%\robloxclient-launcher-updater), and the logs and crash
; reports the 2017 game and Studio wrote to %LOCALAPPDATA%\Roblox\logs. That
; folder is shared with the real Roblox, so only the 2017 names go
; (log_<hex>_<n>.txt and "log_<hex> 0, 299, 0, <build>.*"; today's Roblox
; names its logs <version>_<time>_..._last.log). Keep in step with cleanup.js.

!macro removeOld2017Logs DIR
  Delete "${DIR}\log_*_*.txt"
  Delete "${DIR}\log_* 0, 299, 0, *"
  Delete "${DIR}\log_* 0, 300, 0, *"
!macroend

!macro customRemoveFiles
  SetOutPath $TEMP
  ${if} ${isUpdated}
    FindFirst $R0 $R1 "$INSTDIR\*.*"
    ${DoUntil} $R1 == ""
      ${If} $R1 != "."
      ${AndIf} $R1 != ".."
      ${AndIf} $R1 != "config"
      ${AndIf} $R1 != "cache"
      ${AndIf} $R1 != "Client"
      ${AndIf} $R1 != "Studio"
        ${If} ${FileExists} "$INSTDIR\$R1\*.*"
          RMDir /r "$INSTDIR\$R1"
        ${Else}
          Delete "$INSTDIR\$R1"
        ${EndIf}
      ${EndIf}
      FindNext $R0 $R1
    ${Loop}
    FindClose $R0
  ${else}
    RMDir /r $INSTDIR
    ; Per-user folders (the launcher installs per user).
    RMDir /r "$LOCALAPPDATA\robloxclient-launcher-updater"
    !insertmacro removeOld2017Logs "$LOCALAPPDATA\Roblox\logs"
    !insertmacro removeOld2017Logs "$LOCALAPPDATA\Roblox\logs\archive"
  ${endif}
!macroend
