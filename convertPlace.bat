@echo off
title Convert a place file for the 2017 client
REM Drag a .rbxlx place file onto this file, or run:
REM   convertPlace.bat MyPlace.rbxlx [--from-place <Roblox place ID>] [--install]
REM Writes MyPlace.2017.rbxlx next to it. The launcher's Setup tab does the same.
if "%~1"=="" (
  echo Drag a .rbxlx place file onto convertPlace.bat.
  pause
  exit /b 1
)
set "NODEEXE=node"
where node >NUL 2>&1 || set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODEEXE%" if not "%NODEEXE%"=="node" (
  set "ELECTRON_RUN_AS_NODE=1"
  set "NODEEXE=%~dp0Launcher\dist\RobloxClient Launcher-win32-x64\RobloxClient Launcher.exe"
)
"%NODEEXE%" "%~dp0Webserver\node\convert-place.js" %*
pause
