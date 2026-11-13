[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int] $ProcessId
)

# Lets RCC's LuaWebService calls (IsInGroup, GetRankInGroup, GetRoleInGroup,
# IsFriendsWith) and its other "secure" web addresses (teleports through
# Game/PlaceLauncher.ashx, load-place-info, ...) reach the local web server.
#
# RCCService 0.300.0.138971 blocks them twice, and scripts only ever see
# "LuaWebService error":
#   1. A helper turns those addresses into https:// ("http:/" -> "https:/"),
#      and the trust check refuses every https:// address.
#   2. LuaWebService checks addresses like HttpService does, which refuses
#      the game's own site (localhost. here, roblox.com originally).
# Two small changes in RCC's memory fix both; RCCService.exe on disk is
# untouched. Each is checked against the expected bytes before writing.

$ErrorActionPreference = "Stop"

if (-not ("RccHttpUrlsMemory" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class RccHttpUrlsMemory
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr written);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool VirtualProtectEx(IntPtr process, IntPtr address, IntPtr size, uint protection, out uint oldProtection);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FlushInstructionCache(IntPtr process, IntPtr address, IntPtr size);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
}
'@
}

$patches = @(
    @{
        # The https helper. eax = position of "http:/" in the address (-1 if none).
        #   cmp esi, -1 ; jnz +31h   found -> build the https:// copy
        # becomes
        #   or eax, -1 ; nop ; nop   always the "not found" path, which copies
        #                            the whole address (length -1 = all)
        Name = "https helper"
        Rva = 0x0013C6D9
        Original = [byte[]] @(0x83, 0xFE, 0xFF, 0x75, 0x31)
        Patched = [byte[]] @(0x83, 0xC8, 0xFF, 0x90, 0x90)
    },
    @{
        # The HttpService-style check: trusted = http:// and the host is not
        # localhost. and not robloxlabs.com. The localhost. match now jumps to
        # "trusted" (mov bl, 1) instead of "refused"; https:// stays refused.
        #   test al, al ; jnz +18h   -> refused
        # becomes
        #   test al, al ; jnz +14h   -> trusted
        Name = "LuaWebService trust check"
        Rva = 0x001036E4
        Original = [byte[]] @(0x84, 0xC0, 0x75, 0x18)
        Patched = [byte[]] @(0x84, 0xC0, 0x75, 0x14)
    }
)

$rcc = Get-Process -Id $ProcessId -ErrorAction Stop
if ($rcc.ProcessName -ne "RCCService") {
    throw "Process $ProcessId is '$($rcc.ProcessName)', not RCCService."
}
$base = $rcc.MainModule.BaseAddress.ToInt64()
$processHandle = [RccHttpUrlsMemory]::OpenProcess(0x0438, $false, $ProcessId)
if ($processHandle -eq [IntPtr]::Zero) {
    throw "OpenProcess failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
}

try {
    # Check every patch site first, so nothing is written to an unexpected build.
    $todo = @()
    foreach ($patch in $patches) {
        $address = [IntPtr]($base + $patch.Rva)
        $size = $patch.Original.Length
        $current = New-Object byte[] $size
        $bytesRead = [IntPtr]::Zero
        if (-not [RccHttpUrlsMemory]::ReadProcessMemory($processHandle, $address, $current, $size, [ref] $bytesRead) -or $bytesRead.ToInt64() -ne $size) {
            throw "Could not read the RCC $($patch.Name)."
        }
        $now = [BitConverter]::ToString($current)
        if ($now -eq [BitConverter]::ToString($patch.Patched)) { continue }
        if ($now -ne [BitConverter]::ToString($patch.Original)) {
            throw ("RCC $($patch.Name) did not match the expected build (found {0})." -f $now)
        }
        $todo += , @($patch, $address)
    }
    if ($todo.Count -eq 0) {
        Write-Host "RCC process $ProcessId already reaches the web server for LuaWebService calls."
        return
    }

    foreach ($item in $todo) {
        $patch = $item[0]
        $address = $item[1]
        $size = $patch.Patched.Length
        $sizePtr = [IntPtr] $size
        $oldProtection = 0
        if (-not [RccHttpUrlsMemory]::VirtualProtectEx($processHandle, $address, $sizePtr, 0x40, [ref] $oldProtection)) {
            throw "Could not make the RCC $($patch.Name) writable."
        }
        try {
            $bytesWritten = [IntPtr]::Zero
            if (-not [RccHttpUrlsMemory]::WriteProcessMemory($processHandle, $address, $patch.Patched, $size, [ref] $bytesWritten) -or $bytesWritten.ToInt64() -ne $size) {
                throw "Could not patch the RCC $($patch.Name)."
            }
            [void] [RccHttpUrlsMemory]::FlushInstructionCache($processHandle, $address, $sizePtr)
        }
        finally {
            $ignoredProtection = 0
            [void] [RccHttpUrlsMemory]::VirtualProtectEx($processHandle, $address, $sizePtr, $oldProtection, [ref] $ignoredProtection)
        }
    }

    Write-Host "LuaWebService calls in RCC process $ProcessId now reach the web server (RCCService.exe was not modified)."
}
finally {
    [void] [RccHttpUrlsMemory]::CloseHandle($processHandle)
}
