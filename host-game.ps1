[CmdletBinding()]
param(
    # Pass --setup to answer the hosting questions again.
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $NodeArgs
)

# Hosts a multiplayer game: starts RCCService and lists the game on the
# central web server (Webserver\node\host.js). RCCService runs as
# administrator, as with launchServer.bat, so this asks for elevation.

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $relaunch = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    if ($NodeArgs) { $relaunch += $NodeArgs }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $relaunch
    exit
}

$root = Split-Path -Parent $PSCommandPath
$host.UI.RawUI.WindowTitle = "Roblox Game Host"

$node = $null
$command = Get-Command node -ErrorAction SilentlyContinue
if ($command) { $node = $command.Source }
elseif (Test-Path "$env:ProgramFiles\nodejs\node.exe") { $node = "$env:ProgramFiles\nodejs\node.exe" }

if (-not $node) {
    Write-Host "Node.js was not found. Install Node.js 18 or newer from https://nodejs.org." -ForegroundColor Red
} else {
    & $node (Join-Path $root "Webserver\node\host.js") @NodeArgs
}
Read-Host "`nHosting stopped. Press Enter to close"
