@echo off
REM Adds the *.localhost names RCCService needs to the Windows hosts file
REM (asks for administrator). Run once on every PC that hosts games.
REM   addHostsEntries.bat           add or refresh the entries
REM   addHostsEntries.bat -Remove   remove them again
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0add-hosts-entries.ps1" %*
