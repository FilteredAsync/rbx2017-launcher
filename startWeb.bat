@echo off
title Roblox Web Server
REM Runs the local web server (Node.js) in this window. Close the window or
REM press Ctrl+C to stop it. launchServer.bat starts it for you if needed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web.ps1"
if errorlevel 1 pause
