# Points the *.localhost names RCCService uses at this PC, so RCC can reach
# the local web server (or the multiplayer proxy) for characters, saves,
# place validation and settings. Windows does not resolve subdomains of
# localhost by itself, and the hosts file has no wildcards, so each name RCC
# builds is listed.
#
# Run it once on every PC that hosts games (it asks for administrator).
# It keeps a backup (hosts.robloxclient.bak) and only touches the block
# between the "RobloxClient" marker lines, so running it again is safe.
#   add-hosts-entries.ps1           add or refresh the block
#   add-hosts-entries.ps1 -Remove   remove the block

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

$names = @(
    "www.localhost", "api.localhost", "data.localhost", "assetgame.localhost",
    "versioncompatibility.api.localhost", "clientsettings.api.localhost",
    "ephemeralcounters.api.localhost", "gamepersistence.api.localhost",
    "setup.localhost", "chat.localhost", "avatar.localhost", "thumbnails.localhost"
)
$begin = "# >>> RobloxClient local web server (add-hosts-entries.ps1)"
$end = "# <<< RobloxClient local web server"
$hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"

try {
    $lines = @(Get-Content -LiteralPath $hostsPath -ErrorAction Stop)
    $kept = New-Object System.Collections.Generic.List[string]
    $inside = $false
    foreach ($line in $lines) {
        if ($line -eq $begin) { $inside = $true; continue }
        if ($line -eq $end) { $inside = $false; continue }
        if (-not $inside) { $kept.Add($line) }
    }
    while ($kept.Count -gt 0 -and $kept[$kept.Count - 1].Trim() -eq "") { $kept.RemoveAt($kept.Count - 1) }

    if (-not $Remove) {
        $kept.Add("")
        $kept.Add($begin)
        foreach ($name in $names) { $kept.Add("127.0.0.1`t$name") }
        $kept.Add($end)
    }

    $backup = "$hostsPath.robloxclient.bak"
    if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $hostsPath -Destination $backup }
    [System.IO.File]::WriteAllLines($hostsPath, $kept.ToArray(), (New-Object System.Text.UTF8Encoding($false)))
    ipconfig /flushdns | Out-Null

    if ($Remove) {
        Write-Host "Removed the RobloxClient entries from the hosts file."
    } else {
        Write-Host "Added these names for 127.0.0.1:"
        foreach ($name in $names) {
            try {
                $ip = ([System.Net.Dns]::GetHostAddresses($name) | Select-Object -First 1).IPAddressToString
                Write-Host ("  {0,-40} -> {1}" -f $name, $ip)
            } catch {
                Write-Host ("  {0,-40} -> does not resolve yet" -f $name) -ForegroundColor Yellow
            }
        }
    }
    Write-Host "Backup of the original hosts file: $backup"
} catch {
    Write-Host "Could not update the hosts file: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Security software (e.g. Windows Security) may be blocking changes to it."
}
if (-not $NoPause) { Read-Host "`nPress Enter to close" }
