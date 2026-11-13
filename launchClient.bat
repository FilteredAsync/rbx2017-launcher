@echo off
title Roblox Client
REM Launches the local client and joins the running server.
REM   launchClient.bat            (auto-detect the signed-in Roblox account)
REM   launchClient.bat SkySkipy   (force a username)
REM It then asks which Place ID to join (leave blank to use the server's current place).
setlocal

if "%~1"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0detect-roblox-user.ps1"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0detect-roblox-user.ps1" -Username "%~1"
)

echo.
set /p PLACEID="Enter the Place ID to join (blank = server's current place): "

set "JOINURL=http://localhost./game/placelauncher.ashx/"
if not "%PLACEID%"=="" set "JOINURL=http://localhost./game/placelauncher.ashx/?placeid=%PLACEID%"

start "" "%~dp0Client\RobloxPlayerBeta.exe" --play -a "http://localhost./Login/Negotiate.ashx/" -t "Test" -j "%JOINURL%"
endlocal
