[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int] $ProcessId
)

$ErrorActionPreference = "Stop"

if (-not ("RccPlaceAuthMemory" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class RccPlaceAuthMemory
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

$rcc = Get-Process -Id $ProcessId -ErrorAction Stop
$expectedName = "RCCService"
if ($rcc.ProcessName -ne $expectedName) {
    throw "Process $ProcessId is '$($rcc.ProcessName)', not $expectedName."
}

# RCCService 0.300.0.138971, ServerReplicator::dataOutStep:
# cmp dword ptr [esi+8338h], 3  -> compare against an unreachable -1.
# This leaves a valid join ticket authenticated when the retired Roblox
# validate-place-join service cannot authorize this local place.
$patchRva = 0x007DF4DC
$patchAddress = [IntPtr]($rcc.MainModule.BaseAddress.ToInt64() + $patchRva)
$oneByte = [IntPtr] 1
$processAccess = 0x0438 # QUERY_INFORMATION | VM_OPERATION | VM_READ | VM_WRITE
$processHandle = [RccPlaceAuthMemory]::OpenProcess($processAccess, $false, $ProcessId)

if ($processHandle -eq [IntPtr]::Zero) {
    throw "OpenProcess failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
}

try {
    $current = New-Object byte[] 1
    $bytesRead = [IntPtr]::Zero
    if (-not [RccPlaceAuthMemory]::ReadProcessMemory($processHandle, $patchAddress, $current, 1, [ref] $bytesRead) -or $bytesRead.ToInt64() -ne 1) {
        throw "Could not read the RCC place-auth instruction."
    }

    if ($current[0] -eq 0xFF) {
        Write-Host "RCC local place authorization is already enabled for process $ProcessId."
        return
    }
    if ($current[0] -ne 0x03) {
        throw ("RCC place-auth instruction did not match the expected build (found 0x{0:X2})." -f $current[0])
    }

    $oldProtection = 0
    if (-not [RccPlaceAuthMemory]::VirtualProtectEx($processHandle, $patchAddress, $oneByte, 0x40, [ref] $oldProtection)) {
        throw "Could not make the RCC instruction writable."
    }

    try {
        $bytesWritten = [IntPtr]::Zero
        if (-not [RccPlaceAuthMemory]::WriteProcessMemory($processHandle, $patchAddress, [byte[]] @(0xFF), 1, [ref] $bytesWritten) -or $bytesWritten.ToInt64() -ne 1) {
            throw "Could not patch the RCC place-auth instruction."
        }
        [void] [RccPlaceAuthMemory]::FlushInstructionCache($processHandle, $patchAddress, $oneByte)
    }
    finally {
        $ignoredProtection = 0
        [void] [RccPlaceAuthMemory]::VirtualProtectEx($processHandle, $patchAddress, $oneByte, $oldProtection, [ref] $ignoredProtection)
    }

    Write-Host "Enabled local place authorization in RCC process $ProcessId (RCCService.exe was not modified)."
}
finally {
    [void] [RccPlaceAuthMemory]::CloseHandle($processHandle)
}
