; Extra steps for the RobloxClient Launcher installer (electron-builder NSIS).
;
; Installing a new version first removes the old one. Normally that deletes
; the whole install folder, which would lose each player's settings
; (config\client.json: server address and username), the download cache and
; the game files the launcher downloaded (Client\). On an update this keeps
; config\, cache\ and Client\ (the full installer then lays its own client
; files over it); a real uninstall still removes everything. The install
; folder is always the launcher's own subfolder (the installer adds it to
; whatever folder is picked).

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
  ${endif}
!macroend
