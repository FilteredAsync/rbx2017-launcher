@echo off
REM Stops the local web server (Node.js), plus the old UwAmp/Apache/MySQL
REM server if it is still running from before the switch to Node.
set "FINDEXE=%SystemRoot%\System32\find.exe"

if exist "%~dp0Webserver\node\server.pid" (
    for /f "usebackq delims=" %%p in ("%~dp0Webserver\node\server.pid") do (
        tasklist /FI "PID eq %%p" /FI "IMAGENAME eq node.exe" 2>NUL | "%FINDEXE%" /I "node.exe" >NUL && taskkill /PID %%p /F >NUL
    )
    del "%~dp0Webserver\node\server.pid" 2>NUL
)

tasklist /fi "ImageName eq UwAmp.exe" /fo csv 2>NUL | "%FINDEXE%" /I "UwAmp.exe">NUL
if "%ERRORLEVEL%"=="0" Taskkill /IM UwAmp.exe /F
tasklist /fi "ImageName eq mysqld.exe" /fo csv 2>NUL | "%FINDEXE%" /I "mysqld.exe">NUL
if "%ERRORLEVEL%"=="0" Taskkill /IM mysqld.exe /F
tasklist /fi "ImageName eq httpd.exe" /fo csv 2>NUL | "%FINDEXE%" /I "httpd.exe">NUL
if "%ERRORLEVEL%"=="0" Taskkill /IM httpd.exe /F
tasklist /fi "ImageName eq httpd.exe" /fo csv 2>NUL | "%FINDEXE%" /I "httpd.exe">NUL
if "%ERRORLEVEL%"=="0" Taskkill /IM httpd.exe /F
tasklist /fi "ImageName eq httpd.exe" /fo csv 2>NUL | "%FINDEXE%" /I "httpd.exe">NUL
if "%ERRORLEVEL%"=="0" Taskkill /IM httpd.exe /F
tasklist /fi "ImageName eq httpd.exe" /fo csv 2>NUL | "%FINDEXE%" /I "httpd.exe">NUL
if "%ERRORLEVEL%"=="0" Taskkill /IM httpd.exe /F
