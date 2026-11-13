@echo off
title Roblox Client Launcher
REM Pick a username and an online game, then play.
REM   playGame.bat           use the saved web server address (asks the first time)
REM   playGame.bat --setup   enter the web server address again
set "NODEEXE=node"
where node >NUL 2>&1 || set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
"%NODEEXE%" "%~dp0Webserver\node\play.js" %*
if errorlevel 1 pause
