# Run by RobloxServer-Setup.exe, as administrator, once it has copied the
# server here. Sets this PC up to run it, without questions:
#   - the hosts entries RCC needs (add-hosts-entries.ps1)
#   - firewall rules that let Tailscale players in (tailscale-firewall.ps1)
#   - with -KeepAwake: no sleep or hibernation on mains power (the previous
#     settings are kept in config\power-before.json for -Remove)
# and checks what it cannot fix by itself: port 80 and Tailscale.
# What it did goes to setup-log.txt; what still needs doing to
# setup-notes.txt. Running it again is safe.
#   setup-server.ps1 [-KeepAwake]
#   setup-server.ps1 -Remove        undo it (the uninstaller runs this)
#   setup-server.ps1 -CheckOnly     only check port 80 and Tailscale again
#                                   (no administrator needed)

param([switch] $KeepAwake, [switch] $Remove, [switch] $CheckOnly)

$here = $PSScriptRoot
$notes = New-Object System.Collections.Generic.List[string]
try { Start-Transcript -LiteralPath (Join-Path $here "setup-log.txt") -Append | Out-Null } catch {}

function Step($title) { Write-Host ""; Write-Host "== $title" }
function Note($text) { Write-Host "NOTE: $text"; $notes.Add($text) }

$powerFile = Join-Path $here "config\power-before.json"
# Sleep and hibernate after (seconds) on mains power, in the active power plan.
function Get-AcTimeout($setting) {
    $text = powercfg /query SCHEME_CURRENT SUB_SLEEP $setting | Out-String
    $match = [regex]::Match($text, "AC Power Setting Index:\s*0x([0-9a-fA-F]+)")
    if ($match.Success) { return [Convert]::ToInt64($match.Groups[1].Value, 16) }
    return $null
}
function Set-AcTimeout($setting, $seconds) {
    powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP $setting $seconds | Out-Null
}

if ($Remove) {
    Step "Removing the firewall rules"
    & (Join-Path $here "tailscale-firewall.ps1") -Remove -NoPause
    Step "Removing the hosts entries"
    & (Join-Path $here "add-hosts-entries.ps1") -Remove -NoPause
    if (Test-Path -LiteralPath $powerFile) {
        Step "Putting the sleep settings back"
        try {
            $before = Get-Content -LiteralPath $powerFile -Raw | ConvertFrom-Json
            if ($null -ne $before.standby) { Set-AcTimeout STANDBYIDLE $before.standby }
            if ($null -ne $before.hibernate) { Set-AcTimeout HIBERNATEIDLE $before.hibernate }
            powercfg /setactive SCHEME_CURRENT | Out-Null
            Remove-Item -LiteralPath $powerFile
            Write-Host "Sleep after $($before.standby) s and hibernate after $($before.hibernate) s on mains power, as before."
        } catch {
            Write-Host "Could not restore them: $($_.Exception.Message)"
        }
    }
    try { Stop-Transcript | Out-Null } catch {}
    exit 0
}

if (-not $CheckOnly) {
    Step "Hosts entries for RCC"
    & (Join-Path $here "add-hosts-entries.ps1") -NoPause

    Step "Firewall rules for Tailscale players"
    & (Join-Path $here "tailscale-firewall.ps1") -NoPause
}

if ($KeepAwake -and -not $CheckOnly) {
    Step "Keeping this PC awake on mains power"
    try {
        if (-not (Test-Path -LiteralPath $powerFile)) {
            $before = @{ standby = (Get-AcTimeout STANDBYIDLE); hibernate = (Get-AcTimeout HIBERNATEIDLE) }
            ($before | ConvertTo-Json) | Set-Content -LiteralPath $powerFile -Encoding ASCII
        }
        Set-AcTimeout STANDBYIDLE 0
        Set-AcTimeout HIBERNATEIDLE 0
        powercfg /setactive SCHEME_CURRENT | Out-Null
        Write-Host "Sleep and hibernate: never on mains power (the screen may still turn off)."
    } catch {
        Note "Could not change the sleep settings ($($_.Exception.Message)). Set Settings > System > Power > Sleep to Never yourself."
    }
}

Step "Port 80 (the web server)"
$ours = @("node", "RobloxClient Launcher")
$listeners = @(Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -eq 0) {
    Write-Host "Port 80 is free."
} else {
    foreach ($listener in ($listeners | Sort-Object OwningProcess -Unique)) {
        $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
        $name = if ($process) { $process.ProcessName } else { "process $($listener.OwningProcess)" }
        if ($listener.OwningProcess -eq 4) {
            $iis = Get-Service -Name W3SVC -ErrorAction SilentlyContinue
            if ($iis -and $iis.Status -eq "Running") {
                Note "IIS (the 'World Wide Web Publishing Service') uses port 80. Stop it and set it to Disabled in services.msc, or the server cannot start."
            } else {
                Note "A Windows service uses port 80 (HTTP.sys). Find it with 'netsh http show servicestate' and stop it, or the server cannot start."
            }
        } elseif ($ours -contains $name) {
            $path = $null
            try { $path = $process.Path } catch {}
            Note "Another web server (probably RobloxClient's) is running: $path. Stop it (type stop in its window) before starting this one."
        } else {
            Note "$name uses port 80 (Apache, UwAmp, Skype or another web server?). Close it, or the server cannot start."
        }
    }
}

Step "Tailscale"
$tailscale = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
if (-not (Test-Path -LiteralPath $tailscale)) {
    Note "Tailscale is not installed. Install it (https://tailscale.com/download), sign in and share this PC with the players; until then only this PC can reach the server."
} else {
    $address = (& $tailscale ip -4 2>$null | Select-Object -First 1)
    if ($address -and $address.Trim() -match "^100\.") {
        $address = $address.Trim()
        Write-Host "Tailscale address: $address"
        Set-Content -LiteralPath (Join-Path $here "config\tailscale-address.txt") -Value "http://$address" -Encoding ASCII
        $notes.Insert(0, "Players' server address: http://$address  (on the old server, put it in config\moved.json so launchers switch by themselves)")
    } else {
        Note "Tailscale is installed but not signed in. Open it from the tray and sign in, then share this PC with the players."
    }
}

$header = @("RobloxServer setup, $(Get-Date -Format 'yyyy-MM-dd HH:mm')", "")
if ($notes.Count -eq 0) { $notes.Add("Nothing left to do.") }
Set-Content -LiteralPath (Join-Path $here "setup-notes.txt") -Value ($header + $notes) -Encoding UTF8
Write-Host ""
Write-Host "Done. Still to do (setup-notes.txt):"
foreach ($line in $notes) { Write-Host "  - $line" }
try { Stop-Transcript | Out-Null } catch {}
exit 0
