# Starts the always-on server (startServer.bat) when this Windows account
# signs in, through a shortcut in the account's Startup folder. No
# administrator needed.
#   autostart.ps1           add the shortcut
#   autostart.ps1 -Remove   remove it
# For a PC nobody signs in to, turn on automatic sign-in for this account
# (netplwiz), or the server only starts once someone signs in.

param([switch] $Remove, [switch] $NoPause)

$startup = [Environment]::GetFolderPath("Startup")
$shortcut = Join-Path $startup "Roblox always-on server.lnk"

if ($Remove) {
    if (Test-Path -LiteralPath $shortcut) {
        Remove-Item -LiteralPath $shortcut
        Write-Host "Removed: the always-on server no longer starts at sign-in."
    } else {
        Write-Host "It was not set to start at sign-in."
    }
} else {
    $target = Join-Path $PSScriptRoot "startServer.bat"
    if (-not (Test-Path -LiteralPath $target)) { throw "startServer.bat not found next to autostart.ps1." }
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = $target
    $link.WorkingDirectory = $PSScriptRoot
    $link.WindowStyle = 7  # minimized
    $link.Description = "Roblox always-on server (web server and games)"
    $link.Save()
    Write-Host "Done: the always-on server starts (minimized) when $env:USERNAME signs in."
    Write-Host "Shortcut: $shortcut"
}
if (-not $NoPause) { Read-Host "`nPress Enter to close" }
