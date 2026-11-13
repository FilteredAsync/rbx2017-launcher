[CmdletBinding()]
param(
    # Start in its own minimized window and return (used by launch-server.ps1).
    # Without it the server runs in this window until you close it or press Ctrl+C.
    [switch] $Background
)

# Starts the local web server (Webserver\node\server.js, Node.js 18+).
# It replaces UwAmp (Apache + PHP + MySQL), which is no longer started.
# Settings: config\server.json and config\assets.json (see config\README.txt).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSCommandPath
$server = Join-Path $root "Webserver\node\server.js"
$pidFile = Join-Path $root "Webserver\node\server.pid"

function Find-Node {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

function Get-RunningServer {
    if (-not (Test-Path $pidFile)) { return $null }
    try {
        $serverPid = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim())
        $process = Get-Process -Id $serverPid -ErrorAction Stop
        if ($process.ProcessName -eq "node") { return $process }
    } catch { }
    return $null
}

$running = Get-RunningServer
if ($running) {
    Write-Host "Web server already running (PID $($running.Id))."
    return
}

$node = Find-Node
if (-not $node) {
    throw "Node.js was not found. Install Node.js 18 or newer from https://nodejs.org and try again."
}

if ($Background) {
    Start-Process -FilePath $node -ArgumentList "`"$server`"" -WorkingDirectory $root -WindowStyle Minimized
} else {
    & $node $server
}
