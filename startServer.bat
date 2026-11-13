@echo off
title Roblox always-on server
REM Runs the web server and every game in config\dedicated.json, and keeps
REM them running (restarts crashed or stuck games, daily restart, memory limit).
REM In this window type: status, restart, restart <place ID>, stop.
REM Stop it with "stop" or Ctrl+C, which saves the players first; closing the
REM window stops everything at once.
cd /d "%~dp0"
set "NODEEXE=node"
where node >NUL 2>&1 || set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODEEXE%" if not "%NODEEXE%"=="node" (
  set "ELECTRON_RUN_AS_NODE=1"
  set "NODEEXE=%~dp0Launcher\dist\RobloxClient Launcher-win32-x64\RobloxClient Launcher.exe"
)
"%NODEEXE%" "%~dp0Webserver\node\dedicated.js" %*
if errorlevel 1 pause
