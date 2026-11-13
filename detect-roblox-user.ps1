[CmdletBinding()]
param(
    # Where placelauncher reads the active username from. Empty = auto (next to this script).
    [string] $CurrentUserFile = "",
    # Optional: pass a username to skip auto-detection entirely.
    [string] $Username = "",
    # Opt-in: also copy the local Roblox session so the asset proxy can load
    # THIS account's own avatar clothing (otherwise access-gated). Off by default.
    [switch] $LoadAvatar
)

# ---------------------------------------------------------------------------
# Detects the Roblox account currently logged in on THIS PC and records its
# username for the local server. It reads the local Roblox session cookie
# (.ROBLOSECURITY) from the registry only to ask roblox.com "who am I", then
# writes just the username to current-user.txt. The cookie itself is never
# printed, stored, or sent anywhere except to users.roblox.com.
#
# A 32-bit-safe user id is derived from the username by the web layer
# (roblox-user.php: crc32(lower(name)) & 0x7FFFFFFF); this script prints the
# same value for confirmation. Real Roblox ids exceed the 32-bit range the
# legacy client uses, which is why the id is generated from the name.
#
# Run this whenever you switch Roblox accounts, then launch the client.
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"

if ($CurrentUserFile -eq "") {
    $scriptDir = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } elseif ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
    $CurrentUserFile = Join-Path $scriptDir "Webserver\www\game\current-user.txt"
}

function Get-LocalId([string] $name) {
    # CRC-32 (IEEE), int64 math to match PHP crc32(strtolower($name)) & 0x7FFFFFFF.
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($name.ToLowerInvariant())
    $crc = [int64]0xFFFFFFFFL
    foreach ($b in $bytes) {
        $crc = $crc -bxor $b
        for ($k = 0; $k -lt 8; $k++) {
            if ($crc -band 1) { $crc = (($crc -shr 1) -bxor 0xEDB88320L) -band 0xFFFFFFFFL }
            else { $crc = ($crc -shr 1) -band 0xFFFFFFFFL }
        }
    }
    $crc = ($crc -bxor 0xFFFFFFFFL) -band 0xFFFFFFFFL
    $id = [int64]($crc -band 0x7FFFFFFF)
    if ($id -lt 16) { $id += 16 }
    return $id
}

function Save-User([string] $name) {
    # Write UTF-8 with no BOM (a BOM would corrupt the username the web layer reads).
    [System.IO.File]::WriteAllText($CurrentUserFile, $name, (New-Object System.Text.UTF8Encoding($false)))
    $id = Get-LocalId $name
    Write-Host "Active user set to '$name' (generated 32-bit id: $id)."
    Write-Host "Wrote $CurrentUserFile"
}

# Manual override.
if ($Username -ne "") { Save-User $Username; return }

# --- Preferred: read the account the Roblox app is signed in as -----------
# Modern Roblox stores the logged-in account (plaintext, no cookie) in
# LocalStorage\appStorage.json. This is the reliable "currently logged in" name.
$appStorage = Join-Path $env:LOCALAPPDATA "Roblox\LocalStorage\appStorage.json"
if (Test-Path -LiteralPath $appStorage) {
    try {
        $json = Get-Content -LiteralPath $appStorage -Raw -ErrorAction Stop | ConvertFrom-Json
        $name = $null
        foreach ($field in @("Username", "UserName", "username")) {
            if ($json.PSObject.Properties.Name -contains $field -and [string]$json.$field -ne "") { $name = [string]$json.$field; break }
        }
        if ($name) {
            $uid = $null
            foreach ($f in @("UserId", "userId")) { if ($json.PSObject.Properties.Name -contains $f) { $uid = $json.$f; break } }
            $uidText = ""
            if ($uid) { $uidText = " (userId " + $uid + ")" }
            Write-Host ("Logged-in Roblox account from appStorage.json: " + $name + $uidText)

            # Only when -LoadAvatar is given: copy the local session token so the
            # asset proxy can load THIS player's own avatar clothing (otherwise
            # access-gated). Stored outside the web root, only sent to Roblox.
            if ($LoadAvatar) {
            try {
                $raw = Get-Content -LiteralPath $appStorage -Raw -ErrorAction Stop
                if ($raw -match '(_\|WARNING:-DO-NOT-SHARE-THIS[^"\\]*)') {
                    $token = $Matches[1]
                    $wsRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $CurrentUserFile)))
                    $cacheDir = Join-Path $wsRoot "cache"
                    if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
                    [System.IO.File]::WriteAllText((Join-Path $cacheDir ".roblosecurity"), $token, (New-Object System.Text.UTF8Encoding($false)))
                    Write-Host "Enabled authenticated avatar loading for this account (session kept locally)."
                }
            } catch { }
            }

            Save-User $name
            return
        }
    } catch {
        Write-Warning ("Could not parse appStorage.json: " + $_.Exception.Message)
    }
}

# --- Fallback: read a legacy Roblox session cookie ------------------------
# The cookie may live under several Roblox registry browsers depending on
# whether you logged in with Studio, the app, or the website launcher. Scan
# every "roblox.com" store under HKCU\Software\Roblox and pull the token.
$cookie = $null
$scanned = 0
$roots = @("HKCU:\Software\Roblox", "HKCU:\Software\Roblox Corporation")
$candidateKeys = @()
foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    $candidateKeys += (Get-ChildItem -Path $root -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match 'roblox\.com' } | Select-Object -Expand PSPath)
}
# Always try the classic locations too.
$candidateKeys += "HKCU:\Software\Roblox\RobloxStudioBrowser\roblox.com"
$candidateKeys += "HKCU:\Software\Roblox\RobloxPlayerBrowser\roblox.com"
$candidateKeys = $candidateKeys | Select-Object -Unique

foreach ($p in $candidateKeys) {
    if (-not (Test-Path $p)) { continue }
    $scanned++
    $props = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue
    if (-not $props) { continue }
    foreach ($prop in $props.PSObject.Properties) {
        $name = [string]$prop.Name
        $val  = $prop.Value
        if ($val -isnot [string]) { continue }
        # The cookie is stored with the value NAME ".ROBLOSECURITY" and the value
        # DATA being "_|WARNING:...|_<token>" (which does NOT contain the word
        # ROBLOSECURITY), so match on the name or the warning marker.
        $looks = ($name -match 'ROBLOSECURITY') -or ($val -match 'ROBLOSECURITY') -or ($val -match '_\|WARNING')
        if (-not $looks) { continue }
        if ($val -match '(_\|WARNING[^"''<>\s;]*)') {
            $cookie = $Matches[1]
        } elseif ($val -match 'ROBLOSECURITY[=:]+([^;"''<>\s]+)') {
            $cookie = $Matches[1]
        } elseif ($name -match 'ROBLOSECURITY' -and $val.Trim() -ne '') {
            # Value data is the raw token; drop a leading "something=" prefix.
            $cookie = ($val -replace '^[^=]*=', '').Trim()
        }
        if ($cookie) {
            Write-Host ("Found a Roblox session cookie in value '" + $name + "' under: " + ($p -replace '^Microsoft\.PowerShell\.Core\\Registry::',''))
            break
        }
    }
    if ($cookie) { break }
}

Write-Host ("Registry roblox.com stores scanned: " + $scanned)
if (-not $cookie) {
    Write-Warning "No logged-in Roblox session cookie found in the registry."
    Write-Warning "Make sure you are signed in to Roblox Studio or the Roblox app on this PC,"
    Write-Warning "or just set the name directly:"
    Write-Warning "  .\detect-roblox-user.ps1 -Username <YourName>"
    return
}
Write-Host ("Cookie length: " + $cookie.Length + " (resolving username via roblox.com...)")

# --- Ask roblox.com who this session is -----------------------------------
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $resp = Invoke-RestMethod -Uri "https://users.roblox.com/v1/users/authenticated" `
        -Headers @{ "Cookie" = ".ROBLOSECURITY=$cookie" } -TimeoutSec 20
    if ($resp -and $resp.name) {
        Save-User ([string]$resp.name)
    } else {
        Write-Warning "roblox.com did not return a username (session may be expired). Falling back to none."
    }
} catch {
    Write-Warning ("Could not reach roblox.com to resolve the logged-in user: " + $_.Exception.Message)
    Write-Warning "Set the name manually with:  .\detect-roblox-user.ps1 -Username <YourName>"
}
