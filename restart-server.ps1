# Restarts the always-on server (startServer.bat): stops it the way "stop"
# in its window does (players are kicked with a message and saved first,
# Team Create places saved), waits for it to finish, closes its old window
# and starts it again in a new one. Not running? It just starts it.
# Run it as the account that runs the server, not as administrator.
#   restart-server.ps1            restart
#   restart-server.ps1 -StopOnly  only stop it
#   -Root <folder>                the server folder (default: this script's)

param([switch] $StopOnly, [string] $Root = $PSScriptRoot)

$here = $Root
$pidFile = Join-Path $here "Webserver\node\dedicated.pid"
$stopTimeout = 120  # seconds; saving waits about 10 per game, all at once

function Get-Runner {
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    $id = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref] $id)) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if ($process -and $process.CommandLine -match 'dedicated\.js') { return $process }
    return $null
}

$runner = Get-Runner
if ($runner) {
    Write-Host "Stopping the server (PID $($runner.ProcessId)): saving players first..."
    # Ctrl+C in the server's window, sent by a hidden helper so this window is
    # not affected (a program can only send it to a console it is attached to).
    $helper = @'
param([uint32] $Target)
Add-Type -Namespace Win -Name Console -MemberDefinition @"
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint processId);
[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);
[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
"@
[void][Win.Console]::FreeConsole()
if (-not [Win.Console]::AttachConsole($Target)) { exit 2 }
[void][Win.Console]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
if (-not [Win.Console]::GenerateConsoleCtrlEvent(0, 0)) { exit 3 }
Start-Sleep -Milliseconds 300
exit 0
'@
    $helperFile = Join-Path $env:TEMP "robloxserver-ctrl-c.ps1"
    Set-Content -LiteralPath $helperFile -Value $helper -Encoding ASCII
    $sent = Start-Process powershell.exe -WindowStyle Hidden -Wait -PassThru -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$helperFile`"", "-Target", $runner.ProcessId)
    Remove-Item -LiteralPath $helperFile -ErrorAction SilentlyContinue

    $stopped = $false
    if ($sent.ExitCode -eq 0) {
        for ($i = 0; $i -lt $stopTimeout; $i++) {
            if (-not (Get-Process -Id $runner.ProcessId -ErrorAction SilentlyContinue)) { $stopped = $true; break }
            Start-Sleep -Seconds 1
        }
    }
    if ($stopped) {
        Write-Host "Stopped."
    } else {
        Write-Host "It did not stop by itself; ending it (players in games now may lose their last progress)." -ForegroundColor Yellow
        taskkill /PID $runner.ProcessId /T /F | Out-Null
        Start-Sleep -Seconds 2
    }
    # Its old window (cmd running startServer.bat) may wait at "Terminate batch job (Y/N)?".
    $window = Get-CimInstance Win32_Process -Filter "ProcessId=$($runner.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($window -and $window.Name -eq "cmd.exe" -and $window.CommandLine -match 'startServer\.bat') {
        Stop-Process -Id $window.ProcessId -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "The server is not running."
}

if ($StopOnly) { exit 0 }

Write-Host "Starting the server..."
# Through Explorer, as a double-click does: the window then takes Ctrl+C (a
# window started from here would ignore it, so the next restart could not
# save players), and the server never runs as administrator.
Start-Process -FilePath "$env:WINDIR\explorer.exe" -ArgumentList "`"$(Join-Path $here 'startServer.bat')`""
for ($i = 0; $i -lt 60; $i++) {
    try {
        $answer = Invoke-WebRequest -Uri "http://127.0.0.1/api/games" -UseBasicParsing -TimeoutSec 2
        if ($answer.StatusCode -eq 200) { Write-Host "Running again (the games come online within a minute)."; exit 0 }
    } catch {}
    Start-Sleep -Seconds 1
}
Write-Host "Started, but the web server is not answering yet; look at the server window (taskbar)." -ForegroundColor Yellow
exit 1
