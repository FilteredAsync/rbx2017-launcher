@echo off
REM Makes Windows start the always-on server (startServer.bat) at sign-in.
REM   autostartServer.bat          turn it on
REM   autostartServer.bat -Remove  turn it off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" %*
