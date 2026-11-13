# Lets players on your Tailscale network reach this PC's web server (TCP 80)
# and game port (UDP, from config\host.json, default 53640) through Windows
# Firewall. The rules only accept Tailscale addresses (100.64.0.0/10 and
# fd7a:115c:a1e0::/48), so nothing opens to your home network or the
# internet.
#
# Run it once on the PC that hosts (it asks for administrator).
#   tailscale-firewall.ps1           add or refresh the rules
#   tailscale-firewall.ps1 -Remove   remove them

param([switch] $Remove)

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $relaunch = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($Remove) { $relaunch += "-Remove" }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $relaunch
    exit
}

$group = "RobloxClient (Tailscale)"
$tailnet = @("100.64.0.0/10", "fd7a:115c:a1e0::/48")

try {
    Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    if ($Remove) {
        Write-Host "Removed the RobloxClient Tailscale firewall rules."
    } else {
        # Game ports: the always-on server's range (config\dedicated.json:
        # gamePortFirst, gamePortCount; 53640-53659 by default), so new games
        # need no new rule, plus the launcher Host tab's port (config\host.json).
        $first = 53640
        $count = 20
        $dedicatedConfig = Join-Path $PSScriptRoot "config\dedicated.json"
        if (Test-Path -LiteralPath $dedicatedConfig) {
            $dedicated = Get-Content -LiteralPath $dedicatedConfig -Raw | ConvertFrom-Json
            if ($dedicated.gamePortFirst) { $first = [int] $dedicated.gamePortFirst }
            if ($dedicated.gamePortCount) { $count = [int] $dedicated.gamePortCount }
        }
        $gamePorts = New-Object System.Collections.Generic.List[string]
        $gamePorts.Add("$first-$($first + $count - 1)")
        $hostConfig = Join-Path $PSScriptRoot "config\host.json"
        if (Test-Path -LiteralPath $hostConfig) {
            $saved = Get-Content -LiteralPath $hostConfig -Raw | ConvertFrom-Json
            if ($saved.gamePort -and ([int] $saved.gamePort -lt $first -or [int] $saved.gamePort -ge $first + $count)) { $gamePorts.Add([string] [int] $saved.gamePort) }
        }
        New-NetFirewallRule -Group $group -DisplayName "RobloxClient web server (Tailscale)" `
            -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80 -RemoteAddress $tailnet -Profile Any | Out-Null
        New-NetFirewallRule -Group $group -DisplayName "RobloxClient game server (Tailscale)" `
            -Direction Inbound -Action Allow -Protocol UDP -LocalPort $gamePorts.ToArray() -RemoteAddress $tailnet -Profile Any | Out-Null
        Write-Host "Allowed Tailscale players: TCP 80 (web server) and UDP $($gamePorts -join ', ') (games)."

        # A "Block" rule for node.exe or RCCService.exe (from clicking Cancel
        # on a Windows Firewall prompt) wins over these rules; point it out.
        $blocked = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
            Where-Object { $_.Program -match '\\(node|RCCService)\.exe$' } |
            ForEach-Object { $_ | Get-NetFirewallRule } |
            Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' }
        foreach ($rule in $blocked) {
            Write-Host "Warning: the firewall rule '$($rule.DisplayName)' blocks this program; remove it in Windows Defender Firewall > Inbound Rules." -ForegroundColor Yellow
        }
    }
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
}

Read-Host "`nPress Enter to close"
