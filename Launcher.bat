@echo off
REM Starts the RobloxClient Launcher (Play, Host, Web server, Setup).
set "APP=%~dp0Launcher\dist\RobloxClient Launcher-win32-x64\RobloxClient Launcher.exe"
if exist "%APP%" (
    start "" "%APP%"
    exit /b 0
)
REM Not packaged yet: run it with the Electron in Launcher\node_modules.
if exist "%~dp0Launcher\node_modules\electron\dist\electron.exe" (
    start "" "%~dp0Launcher\node_modules\electron\dist\electron.exe" "%~dp0Launcher"
    exit /b 0
)
echo The launcher is not installed. In the Launcher folder run: npm install, then npm run package
pause
