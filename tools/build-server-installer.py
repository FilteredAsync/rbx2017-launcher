"""Builds share/RobloxServer-Setup-<date>.exe: one installer that moves this
whole always-on server to another PC.

    python tools/build-server-installer.py

It packs what tools/build-server-package.py packs, plus everything a fresh
server leaves out: the game library and its saves, accounts and their
sessions, avatars, friends, the host key, the Roblox API key, the menu music
and this PC's server settings (config/dedicated.json). Installing it on the
new PC copies all that to C:\\RobloxServer (by default) and runs
setup-server.ps1 there: hosts entries, Tailscale firewall rules, optionally
no sleep and start at sign-in, and checks for port 80 and Tailscale.

The installer holds keys and every account: hand it only to whoever runs
the new server, never publish it. Stop this PC's server first
(type stop in the startServer window), so the copy of the saves is complete.
Build the launcher first (cd Launcher && npm run package).
"""

import datetime
import glob
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAKENSIS = glob.glob(os.path.join(os.environ.get('LOCALAPPDATA', ''), 'electron-builder', 'Cache', 'nsis-3*', 'nsis-3*', 'Bin', 'makensis.exe'))
ICON = os.path.join(ROOT, 'Launcher', 'build', 'icon.ico')
# Already compressed: storing them as they are saves minutes of LZMA.
STORED = {'.zip', '.7z', '.rar', '.png', '.jpg', '.jpeg', '.mp3', '.ogg', '.gz', '.wav'}

sys.dont_write_bytecode = True  # no tools/__pycache__
spec = importlib.util.spec_from_file_location('server_package', os.path.join(ROOT, 'tools', 'build-server-package.py'))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


def nsis(text):
    """A string for an NSIS script (inside double quotes)."""
    return text.replace('$', '$$').replace('"', '$\\"')


def windows(rel):
    return rel.replace('/', '\\')


def read_json(*parts):
    try:
        with open(os.path.join(ROOT, *parts), encoding='utf-8-sig') as source:
            return json.load(source)
    except (OSError, ValueError):
        return None


def summary():
    places = read_json('Webserver', 'node', 'data', 'places.json') or {}
    accounts = read_json('Webserver', 'node', 'data', 'accounts.json') or {}
    games = places.get('places') or []
    return len(games), len(accounts.get('accounts') or [])


def file_lines(staging):
    """SetOutPath/File lines for every packed file, by folder."""
    by_folder = {}
    for name, src in package.entries.items():
        by_folder.setdefault(os.path.dirname(name[len(package.PREFIX):]), []).append((os.path.basename(name), src))
    for name, data in package.generated.items():
        rel = name[len(package.PREFIX):]
        staged = os.path.join(staging, windows(rel))
        os.makedirs(os.path.dirname(staged), exist_ok=True)
        with open(staged, 'wb') as out:
            out.write(data)
        by_folder.setdefault(os.path.dirname(rel), []).append((os.path.basename(rel), staged))
    lines = []
    for folder in sorted(by_folder):
        target = '$INSTDIR' + ('\\' + nsis(windows(folder)) if folder else '')
        lines.append(f'  SetOutPath "{target}"')
        for dest, src in sorted(by_folder[folder]):
            stored = os.path.splitext(dest)[1].lower() in STORED
            if stored:
                lines.append('  SetCompress off')
            if os.path.basename(src) == dest:
                lines.append(f'  File "{nsis(os.path.abspath(src))}"')
            else:
                lines.append(f'  File "/oname={nsis(dest)}" "{nsis(os.path.abspath(src))}"')
            if stored:
                lines.append('  SetCompress auto')
    for folder in sorted(package.dirs):
        rel = folder[len(package.PREFIX):].rstrip('/')
        lines.append(f'  CreateDirectory "$INSTDIR\\{nsis(windows(rel))}"')
    return lines


def script(out, staging, made):
    games, accounts = summary()
    size_kb = (sum(os.path.getsize(src) for src in package.entries.values()) + 1023) // 1024
    welcome = (
        f'This sets up the always-on Roblox server on this PC, with everything from the current server '
        f'(copied {made}):$\\r$\\n$\\r$\\n'
        f'    {games} games and their saves$\\r$\\n'
        f'    {accounts} accounts, with their avatars and friends$\\r$\\n'
        f'    the server keys, settings, cache and game files for players$\\r$\\n$\\r$\\n'
        'It also sets Windows up to run it: hosts entries, firewall rules for Tailscale players, '
        'and if you want, no sleep and starting with Windows.$\\r$\\n$\\r$\\n'
        'Tailscale is not part of this: install it and sign in, before or after.')
    replace = (
        'There is already a server in $INSTDIR.$\\r$\\n$\\r$\\n'
        f'Installing replaces its games, accounts and saves with this installer\'s copy from {made}; '
        'anything newer there is lost. Stop that server first (type stop in its window).$\\r$\\n$\\r$\\nReplace it?')
    head = f'''; Made by tools/build-server-installer.py on {made}. Do not edit; build again.
Unicode true
ManifestDPIAware true
SetCompressor lzma
SetCompressorDictSize 32
RequestExecutionLevel admin
Name "Roblox Server"
Caption "Roblox Server Setup"
OutFile "{nsis(out)}"
InstallDir "C:\\RobloxServer"
InstallDirRegKey HKLM "Software\\RobloxServer" "InstallDir"
BrandingText "RobloxClient always-on server, {made}"
ShowInstDetails show
ShowUninstDetails show

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define UNINSTALLER "Uninstall Roblox Server.exe"
!define ARP "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RobloxServer"
!define MUI_ICON "{nsis(ICON)}"
!define MUI_UNICON "{nsis(ICON)}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Roblox Server"
!define MUI_WELCOMEPAGE_TEXT "{welcome}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirectoryLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Start the server now"
!define MUI_FINISHPAGE_RUN_FUNCTION StartServer
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\\setup-notes.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Show what is left to do"
!insertmacro MUI_PAGE_FINISH
!define MUI_UNCONFIRMPAGE_TEXT_TOP "Stop the server first: type stop in its window. Removing it also removes its hosts entries and firewall rules. You choose afterwards whether to keep its games, accounts and saves."
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var KeepAwake

Function DirectoryLeave
  ${{If}} ${{FileExists}} "$INSTDIR\\startServer.bat"
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "{replace}" IDYES replaceIt
    Abort
    replaceIt:
  ${{EndIf}}
FunctionEnd

Function StartServer
  ; Through Explorer, so the server runs as the signed-in user, not as administrator.
  Exec '"$WINDIR\\explorer.exe" "$INSTDIR\\startServer.bat"'
FunctionEnd

!macro PowerShell
  ${{If}} ${{RunningX64}}
    StrCpy $0 "$WINDIR\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe"
  ${{Else}}
    StrCpy $0 "$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe"
  ${{EndIf}}
!macroend

Section "Roblox server, with games, accounts and saves" SecServer
  SectionIn RO
'''
    tail = f'''
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\\${{UNINSTALLER}}"
  WriteRegStr HKLM "Software\\RobloxServer" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${{ARP}}" "DisplayName" "Roblox Server"
  WriteRegStr HKLM "${{ARP}}" "DisplayVersion" "{made}"
  WriteRegStr HKLM "${{ARP}}" "Publisher" "RobloxClient"
  WriteRegStr HKLM "${{ARP}}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${{ARP}}" "UninstallString" '"$INSTDIR\\${{UNINSTALLER}}"'
  WriteRegStr HKLM "${{ARP}}" "DisplayIcon" "$INSTDIR\\${{UNINSTALLER}}"
  WriteRegDWORD HKLM "${{ARP}}" "EstimatedSize" {size_kb}
  WriteRegDWORD HKLM "${{ARP}}" "NoModify" 1
  WriteRegDWORD HKLM "${{ARP}}" "NoRepair" 1
  SetShellVarContext all
  CreateDirectory "$SMPROGRAMS\\Roblox Server"
  CreateShortCut "$SMPROGRAMS\\Roblox Server\\Start the server.lnk" "$INSTDIR\\startServer.bat"
  WriteINIStr "$SMPROGRAMS\\Roblox Server\\Manage games.url" "InternetShortcut" "URL" "http://localhost/manage"
  CreateShortCut "$SMPROGRAMS\\Roblox Server\\Server folder.lnk" "$INSTDIR"
  CreateShortCut "$SMPROGRAMS\\Roblox Server\\Read me.lnk" "$INSTDIR\\README-SERVER.txt"
  CreateShortCut "$SMPROGRAMS\\Roblox Server\\Uninstall Roblox Server.lnk" "$INSTDIR\\${{UNINSTALLER}}"
SectionEnd

Section "Keep this PC awake (no sleep on mains power)" SecAwake
  StrCpy $KeepAwake "-KeepAwake"
SectionEnd

Section "Start the server when Windows signs in" SecAutostart
  ; The same shortcut autostart.ps1 makes (autostartServer.bat -Remove takes it away).
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  CreateShortCut "$SMSTARTUP\\Roblox always-on server.lnk" "$INSTDIR\\startServer.bat" "" "" "" SW_SHOWMINIMIZED "" "Roblox always-on server (web server and games)"
SectionEnd

Section "-Set up Windows"
  DetailPrint "Setting up Windows for the server (setup-server.ps1)..."
  !insertmacro PowerShell
  nsExec::ExecToLog '"$0" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\\setup-server.ps1" $KeepAwake'
  Pop $1
  ${{If}} $1 != 0
    DetailPrint "setup-server.ps1 ended with $1; see setup-log.txt"
  ${{EndIf}}
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${{SecServer}} "The server, its game library and saves, accounts, avatars, friends, keys and settings."
  !insertmacro MUI_DESCRIPTION_TEXT ${{SecAwake}} "Sets sleep and hibernate to Never while plugged in, so games keep running. Uninstalling puts the old settings back."
  !insertmacro MUI_DESCRIPTION_TEXT ${{SecAutostart}} "Starts the server (minimized) when this Windows account signs in."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  !insertmacro PowerShell
  ${{If}} ${{FileExists}} "$INSTDIR\\setup-server.ps1"
    nsExec::ExecToLog '"$0" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\\setup-server.ps1" -Remove'
    Pop $1
  ${{EndIf}}
  SetShellVarContext current
  Delete "$SMSTARTUP\\Roblox always-on server.lnk"
  SetShellVarContext all
  RMDir /r "$SMPROGRAMS\\Roblox Server"
  DeleteRegKey HKLM "${{ARP}}"
  DeleteRegKey HKLM "Software\\RobloxServer"
  Delete "$INSTDIR\\${{UNINSTALLER}}"
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Also delete $INSTDIR, with every game, account and save in it? This cannot be undone.$\\r$\\n$\\r$\\nNo keeps the folder; startServer.bat in it still runs the server." IDYES deleteAll
  Goto done
  deleteAll:
    SetOutPath "$TEMP"
    RMDir /r /REBOOTOK "$INSTDIR"
  done:
SectionEnd
'''
    return head + '\n'.join(file_lines(staging)) + '\n' + tail


def main():
    if not MAKENSIS:
        sys.exit('makensis not found: build the launcher installer once (cd Launcher && npm run dist) so electron-builder downloads NSIS')
    package.collect(move=True)
    sample = '--sample' in sys.argv
    if sample:
        # A small installer for trying the setup steps: no game or client files.
        big = ('Server/', 'Launcher/', 'downloads/', 'cache/', 'Webserver/www/', 'Client/')
        for name in [n for n in package.entries if n[len(package.PREFIX):].startswith(big)]:
            del package.entries[name]
    if not any(name.endswith('/Webserver/node/data/accounts.json') for name in package.entries):
        sys.exit('no accounts.json to move (Webserver/node/data)')
    made = datetime.date.today().isoformat()
    out = os.path.join(ROOT, 'share', f'RobloxServer-Setup-{made}{"-sample" if sample else ""}.exe')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    staging = tempfile.mkdtemp(prefix='server-installer-')
    try:
        nsi = os.path.join(staging, 'RobloxServer.nsi')
        with open(nsi, 'w', encoding='utf-8-sig', newline='\r\n') as target:
            target.write(script(out + '.new', staging, made))
        total = sum(os.path.getsize(src) for src in package.entries.values())
        print(f'packing {len(package.entries)} files, {round(total / 1e6)} MB (takes several minutes)...', flush=True)
        result = subprocess.run([MAKENSIS[0], '-V2', '-NOCD', nsi])
        if result.returncode != 0:
            sys.exit(f'makensis failed ({result.returncode}); script kept at {nsi}')
        os.replace(out + '.new', out)
        print(f'{out}: {round(os.path.getsize(out) / 1e6)} MB')
    finally:
        if os.path.exists(out + '.new'):
            os.remove(out + '.new')
        if os.path.exists(out):
            shutil.rmtree(staging, ignore_errors=True)


if __name__ == '__main__':
    main()
