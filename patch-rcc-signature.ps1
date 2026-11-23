[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int] $ProcessId
)

$ErrorActionPreference = "Stop"

if (-not ("RccSignatureMemory" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class RccSignatureMemory
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

# RCCService 0.300.0.138971 checks each client's security report against a list
# of flags and disconnects the player for any that is set. One of them is
# "Bad signature (3)": the client found its own Authenticode signature broken.
# Every game client here is byte-patched (server address, script key, registry
# key), so a 0.300.0.138971 client always reports it and was disconnected right
# after joining ("PlayerlessOther"). Older clients don't report it the same way.
#   0x00BE776B: push 8   (the flag's bit; mask 0 never matches)
# The other checks are left as they are.
$patchRva = 0x007E776C
$patchAddress = [IntPtr]($rcc.MainModule.BaseAddress.ToInt64() + $patchRva)
$oneByte = [IntPtr] 1

$processAccess = 0x0438 # QUERY_INFORMATION | VM_OPERATION | VM_READ | VM_WRITE
$processHandle = [RccSignatureMemory]::OpenProcess($processAccess, $false, $ProcessId)
if ($processHandle -eq [IntPtr]::Zero) {
    throw "OpenProcess failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
}

try {
    $around = New-Object byte[] 3
    $bytesRead = [IntPtr]::Zero
    $start = [IntPtr]($patchAddress.ToInt64() - 1)
    if (-not [RccSignatureMemory]::ReadProcessMemory($processHandle, $start, $around, 3, [ref] $bytesRead) -or $bytesRead.ToInt64() -ne 3) {
        throw "Could not read the RCC signature check."
    }
    # push imm8 (6A xx) followed by push edi (57)
    if ($around[0] -ne 0x6A -or $around[2] -ne 0x57) {
        throw ("RCC signature check did not match the expected build (found {0:X2} {1:X2} {2:X2})." -f $around[0], $around[1], $around[2])
    }
    if ($around[1] -eq 0x00) {
        Write-Host "RCC already ignores the client's bad-signature report in process $ProcessId."
        return
    }
    if ($around[1] -ne 0x08) {
        throw ("RCC signature check did not match the expected build (found mask 0x{0:X2})." -f $around[1])
    }

    $oldProtection = 0
    if (-not [RccSignatureMemory]::VirtualProtectEx($processHandle, $patchAddress, $oneByte, 0x40, [ref] $oldProtection)) {
        throw "Could not make the RCC instruction writable."
    }

    try {
        $bytesWritten = [IntPtr]::Zero
        if (-not [RccSignatureMemory]::WriteProcessMemory($processHandle, $patchAddress, [byte[]] @(0x00), 1, [ref] $bytesWritten) -or $bytesWritten.ToInt64() -ne 1) {
            throw "Could not patch the RCC signature check."
        }
        [void] [RccSignatureMemory]::FlushInstructionCache($processHandle, $patchAddress, $oneByte)
    }
    finally {
        $ignoredProtection = 0
        [void] [RccSignatureMemory]::VirtualProtectEx($processHandle, $patchAddress, $oneByte, $oldProtection, [ref] $ignoredProtection)
    }

    Write-Host "RCC process $ProcessId now ignores the client's bad-signature report (RCCService.exe was not modified)."
}
finally {
    [void] [RccSignatureMemory]::CloseHandle($processHandle)
}
