@echo off
REM Lets players on your Tailscale network reach this PC's web server and game
REM port through Windows Firewall (asks for administrator).
REM   tailscaleFirewall.bat           add the rules
REM   tailscaleFirewall.bat -Remove   remove them
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tailscale-firewall.ps1" %*
