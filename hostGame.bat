@echo off
REM Hosts a multiplayer game: starts RCCService and lists it on the web server.
REM   hostGame.bat           use the saved settings (asks the first time)
REM   hostGame.bat --setup   answer the hosting questions again
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host-game.ps1" %*
