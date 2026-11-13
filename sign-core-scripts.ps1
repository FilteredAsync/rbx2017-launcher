[CmdletBinding()]
param(
    [string] $ScriptsDirectory = "$PSScriptRoot\Server\content\scripts",
    [string] $PrivateKeyPath = "$PSScriptRoot\rbxsig_private.pem",
    [string] $PublicKeyPath = "$PSScriptRoot\rbxsig_public.pub",
    [string] $BackupDirectory = "$PSScriptRoot\Server\content\scripts-unsigned-backup"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $BackupDirectory)) {
    Copy-Item -LiteralPath $ScriptsDirectory -Destination $BackupDirectory -Recurse
}

$privateRsa = [System.Security.Cryptography.RSA]::Create()
$publicRsa = [System.Security.Cryptography.RSA]::Create()
$privateRsa.ImportFromPem([IO.File]::ReadAllText($PrivateKeyPath))
$publicRsa.ImportFromPem([IO.File]::ReadAllText($PublicKeyPath))
$ascii = [Text.Encoding]::ASCII
$signedCount = 0

try {
    foreach ($file in Get-ChildItem -LiteralPath $ScriptsDirectory -Recurse -File -Filter "*.lua") {
        $payload = [IO.File]::ReadAllBytes($file.FullName)

        # Make reruns idempotent by removing an existing rbxsig header first.
        if ($payload.Length -ge 9 -and $ascii.GetString($payload, 0, 9) -eq "--rbxsig%") {
            $lineFeed = [Array]::IndexOf($payload, [byte] 10)
            if ($lineFeed -lt 0) {
                throw "Malformed rbxsig header in $($file.FullName)"
            }
            $payload = $payload[($lineFeed + 1)..($payload.Length - 1)]
        }

        # Legacy --rbxsig verification includes the CRLF separating the
        # signature header from the Lua source in the signed byte range.
        $separator = $ascii.GetBytes("`r`n")
        $signedPayload = New-Object byte[] ($separator.Length + $payload.Length)
        [Array]::Copy($separator, 0, $signedPayload, 0, $separator.Length)
        [Array]::Copy($payload, 0, $signedPayload, $separator.Length, $payload.Length)

        $signature = $privateRsa.SignData(
            $signedPayload,
            [Security.Cryptography.HashAlgorithmName]::SHA1,
            [Security.Cryptography.RSASignaturePadding]::Pkcs1
        )

        if (-not $publicRsa.VerifyData(
            $signedPayload,
            $signature,
            [Security.Cryptography.HashAlgorithmName]::SHA1,
            [Security.Cryptography.RSASignaturePadding]::Pkcs1
        )) {
            throw "Signature verification failed for $($file.FullName)"
        }

        $header = $ascii.GetBytes("--rbxsig%$([Convert]::ToBase64String($signature))%")
        $signedSource = New-Object byte[] ($header.Length + $signedPayload.Length)
        [Array]::Copy($header, 0, $signedSource, 0, $header.Length)
        [Array]::Copy($signedPayload, 0, $signedSource, $header.Length, $signedPayload.Length)
        [IO.File]::WriteAllBytes($file.FullName, $signedSource)
        $signedCount++
    }
}
finally {
    $privateRsa.Dispose()
    $publicRsa.Dispose()
}

Write-Host "Signed and verified $signedCount RCC Lua core scripts."
Write-Host "Unsigned backup: $BackupDirectory"
