@echo off
REM Lets the VPS relay reach this PC's web server and game ports over the
REM WireGuard tunnel, through Windows Firewall (asks for administrator).
REM   wireguardFirewall.bat           add the rules
REM   wireguardFirewall.bat -Remove   remove them
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wireguard-firewall.ps1" %*
