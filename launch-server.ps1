[CmdletBinding()]
param(
    # A place file to host. Set automatically when you drag a .rbxlx/.rbxl onto
    # launchServer.bat. Empty = keep the current Server\content\place.rbxlx.
    [string] $PlaceFile = "",
    # The Place ID to host as. 0 = ask when a place file is dragged, else 1818.
    [int] $PlaceId = 0
)

# One-shot local server bring-up:
#   1. Web server (Node.js, start-web.ps1) if it is not already running.
#      The old UwAmp/Apache server is stopped if it is still running.
#   2. RCCService.exe (opens the "Test" job and loads the place).
#   3. The runtime place-auth patch (patches process MEMORY only, so
#      RCCService.exe on disk is never modified).
#   4. Submits gameserver.lua on a random free port; it owns the job while the
#      server runs.

# --- Self-elevate (RCC + the patch need administrator) ---------------------
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $relaunch = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($PlaceFile -ne "") { $relaunch += @("-PlaceFile", "`"$PlaceFile`"") }
    if ($PlaceId -gt 0)    { $relaunch += @("-PlaceId", "$PlaceId") }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $relaunch
    exit
}

$root = Split-Path -Parent $PSCommandPath

function Test-Port([string] $HostName, [int] $Port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect($HostName, $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(400)
        if ($ok -and $c.Connected) { $c.Close(); return $true }
        $c.Close()
    } catch { }
    return $false
}

try {
    # --- 0. Optional dragged place file + Place ID -------------------------
    $placeDest = Join-Path $root "Server\content\place.rbxlx"
    if ($PlaceFile -ne "") {
        if (-not (Test-Path -LiteralPath $PlaceFile)) { throw "Place file not found: $PlaceFile" }
        $ext = [IO.Path]::GetExtension($PlaceFile).ToLowerInvariant()
        if ($ext -ne ".rbxlx" -and $ext -ne ".rbxl") {
            throw "Not a place file (expected .rbxlx or .rbxl): $PlaceFile"
        }
        if ($PlaceId -le 0) {
            $name = [IO.Path]::GetFileName($PlaceFile)
            $entered = Read-Host "Enter the Place ID to host '$name' as (e.g. 606849621)"
            if (-not [int]::TryParse($entered, [ref] $PlaceId) -or $PlaceId -le 0) {
                throw "Invalid Place ID."
            }
        }
        # Keep a one-time backup of whatever place was there before.
        if ((Test-Path $placeDest) -and -not (Test-Path "$placeDest.orig")) {
            Copy-Item -LiteralPath $placeDest -Destination "$placeDest.orig" -Force
        }
        Copy-Item -LiteralPath $PlaceFile -Destination $placeDest -Force
        Write-Host "Hosting '$([IO.Path]::GetFileName($PlaceFile))' as Place ID $PlaceId."
    }
    if ($PlaceId -le 0) { $PlaceId = 1818 }

    # --- 1. Web server (Node.js; replaces UwAmp) ---------------------------
    # Stop this folder's old UwAmp/Apache/MySQL if they are still running, so
    # the Node server can take port 80.
    $webserverDir = Join-Path $root "Webserver"
    $oldServer = @(Get-Process UwAmp, httpd, mysqld -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path.StartsWith($webserverDir, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($oldServer.Count -gt 0) {
        Write-Host "      Stopping the old UwAmp/Apache server..."
        $oldServer | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    $pidFile = Join-Path $root "Webserver\node\server.pid"
    $nodeRunning = $false
    if (Test-Path $pidFile) {
        try {
            $nodeRunning = (Get-Process -Id ([int]((Get-Content -LiteralPath $pidFile -Raw).Trim())) -ErrorAction Stop).ProcessName -eq "node"
        } catch { }
    }
    if ($nodeRunning) {
        Write-Host "[1/4] Web server already running."
    } elseif (Test-Port "127.0.0.1" 80) {
        Write-Warning "Another program is already using port 80, so the game may talk to it instead of this web server. Run killWeb.bat or close it, then launch again."
    } else {
        Write-Host "[1/4] Starting the web server (Node.js)..."
        & (Join-Path $root "start-web.ps1") -Background
        $ready = $false
        for ($i = 0; $i -lt 20; $i++) {
            if (Test-Port "127.0.0.1" 80) { $ready = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { throw "The web server did not start. Run startWeb.bat to see why." }
    }

    # --- 2. RCCService -----------------------------------------------------
    $rccExe = Join-Path $root "Server\RCCService.exe"
    if (-not (Test-Path $rccExe)) { throw "RCCService.exe not found at $rccExe" }

    Get-Process RCCService -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "      Stopping a previous RCCService (PID $($_.Id)) for a clean start..."
        try { $_ | Stop-Process -Force } catch { }
    }
    Start-Sleep -Seconds 1

    Write-Host "[2/4] Starting RCCService (Place ID $PlaceId)..."
    Start-Process -FilePath $rccExe `
        -ArgumentList @("-Console", "-Start", "-verbose", "-PlaceId:$PlaceId") `
        -WorkingDirectory (Split-Path $rccExe)

    $rcc = $null
    for ($i = 0; $i -lt 40; $i++) {
        $rcc = Get-Process RCCService -ErrorAction SilentlyContinue |
            Where-Object { $_.Path -eq $rccExe } | Select-Object -First 1
        if ($rcc -and (Test-Port "127.0.0.1" 64989)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $rcc) { throw "RCCService did not start." }

    # --- 3. Runtime place-auth patch (memory only) -------------------------
    # Needed again now that start-server.ps1 gives RCC its web address: RCC
    # then holds every player as "not authenticated" without this patch.
    Write-Host "[3/4] Authorizing local place join on RCC PID $($rcc.Id)..."
    try { & (Join-Path $root "patch-rcc-place-auth.ps1") -ProcessId $rcc.Id }
    catch { Write-Warning "Place-auth patch failed: $($_.Exception.Message)" }

    # --- 4. Game server job (random free port) -----------------------------
    Write-Host "[4/4] Submitting the game server. Keep this window open while playing."
    Write-Host ""
    & (Join-Path $root "start-server.ps1") -PlaceId $PlaceId
}
catch {
    Write-Host ""
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
}

Read-Host "`nServer stopped. Press Enter to close"
