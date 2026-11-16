# Lets the VPS relay (tools/vps/setup-vps.sh) reach this PC's web server
# (TCP 80) and game servers (UDP, config\dedicated.json, default 53640-53659)
# through Windows Firewall. The rules accept only the VPS's address on the
# WireGuard tunnel (10.66.0.1), so nothing opens to your home network.
#
# Run it once on the server PC after importing the WireGuard tunnel (it asks
# for administrator).
#   wireguard-firewall.ps1           add or refresh the rules
#   wireguard-firewall.ps1 -Remove   remove them

param([switch] $Remove, [switch] $NoPause)

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $relaunch = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($Remove) { $relaunch += "-Remove" }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $relaunch
    exit
}

$group = "RobloxClient (VPS relay)"
$relay = "10.66.0.1"

try {
    Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    if ($Remove) {
        Write-Host "Removed the RobloxClient VPS relay firewall rules."
    } else {
        $first = 53640
        $count = 20
        $dedicatedConfig = Join-Path $PSScriptRoot "config\dedicated.json"
        if (Test-Path -LiteralPath $dedicatedConfig) {
            $dedicated = Get-Content -LiteralPath $dedicatedConfig -Raw | ConvertFrom-Json
            if ($dedicated.gamePortFirst) { $first = [int] $dedicated.gamePortFirst }
            if ($dedicated.gamePortCount) { $count = [int] $dedicated.gamePortCount }
        }
        $gamePorts = "$first-$($first + $count - 1)"
        New-NetFirewallRule -Group $group -DisplayName "RobloxClient web server (VPS relay)" `
            -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80 -RemoteAddress $relay -Profile Any | Out-Null
        New-NetFirewallRule -Group $group -DisplayName "RobloxClient game server (VPS relay)" `
            -Direction Inbound -Action Allow -Protocol UDP -LocalPort $gamePorts -RemoteAddress $relay -Profile Any | Out-Null
        Write-Host "Allowed the VPS relay: TCP 80 (web server) and UDP $gamePorts (games)."

        $tunnel = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like "10.66.0.*" }
        if (-not $tunnel) {
            Write-Host "Note: the WireGuard tunnel is not connected yet. Activate it in WireGuard, then restart the server (restartServer.bat)." -ForegroundColor Yellow
        }
    }
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
}

if (-not $NoPause) { Read-Host "`nPress Enter to close" }
