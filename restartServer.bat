@echo off
title Restart the Roblox server
REM Restarts the always-on server: saves players, stops it, starts it again
REM (restart-server.ps1). Double-click it; no administrator needed.
REM   restartServer.bat -StopOnly   only stop it
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-server.ps1" %*
timeout /t 8
