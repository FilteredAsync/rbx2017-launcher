@echo off
title Roblox Local Server
REM Launches the whole local server: web server + RCCService + place-auth patch
REM + game server job (on a random free port). Prompts for administrator rights.
REM
REM   Double-click            -> hosts the current Server\content\place.rbxlx as 1818
REM   Drag a .rbxlx/.rbxl on it -> hosts that place; it asks you for a Place ID
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch-server.ps1" -PlaceFile "%~1"
