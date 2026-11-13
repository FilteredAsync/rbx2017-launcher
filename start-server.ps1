[CmdletBinding()]
param(
    [string] $RccServiceUrl = "http://localhost:64989/",
    [int] $PlaceId = 1818,
    [string] $JobId = "GameServer",
    [int] $MinimumPort = 49152,
    [int] $MaximumPort = 65535,
    # Domain RCC uses for its web requests (gameserver.lua's baseUrl).
    [string] $RccDomain = "localhost."
)

$ErrorActionPreference = "Stop"
$workspaceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($MinimumPort -lt 1024 -or $MaximumPort -gt 65535 -or $MinimumPort -gt $MaximumPort) {
    throw "The game-server port range is invalid."
}

$escapedJobId = [System.Security.SecurityElement]::Escape($JobId)

$soapHeaders = @{ SOAPAction = '"http://localhost./RCCServiceSoap/OpenJob"' }
$jobsEnvelope = @"
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://localhost./">
    <SOAP-ENV:Body><ns1:OpenJob><ns1:job><ns1:id>GameServer</ns1:id><ns1:expirationInSeconds>360000</ns1:expirationInSeconds><ns1:category>0</ns1:category><ns1:cores>4</ns1:cores></ns1:job><ns1:script><ns1:name>Bootstrap</ns1:name><ns1:script>return true</ns1:script><ns1:arguments /></ns1:script></ns1:OpenJob></SOAP-ENV:Body>
</SOAP-ENV:Envelope>
"@
$jobsResponse = Invoke-WebRequest -Uri $RccServiceUrl -Method Post -Headers $soapHeaders -ContentType "text/xml; charset=utf-8" -Body $jobsEnvelope -UseBasicParsing


$expectedRccPath = Join-Path $workspaceDirectory "Server\RCCService.exe"
$rccProcess = Get-Process -Name "RCCService" -ErrorAction Stop |
    Where-Object { $_.Path -eq $expectedRccPath } |
    Select-Object -First 1
if ($rccProcess -eq $null) {
    throw "The workspace RCCService process could not be identified."
}

function Test-GamePortAvailable([int] $CandidatePort) {
    $tcpListener = $null
    $udpClient = $null

    try {
        $tcpListener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $CandidatePort)
        $tcpListener.Start()
        $udpClient = New-Object System.Net.Sockets.UdpClient($CandidatePort)
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($udpClient -ne $null) { $udpClient.Close() }
        if ($tcpListener -ne $null) { $tcpListener.Stop() }
    }
}

$gamePort = $null
$portCandidates = $MinimumPort..$MaximumPort | Sort-Object { Get-Random }
foreach ($candidatePort in $portCandidates) {
    if (Test-GamePortAvailable $candidatePort) {
        $gamePort = $candidatePort
        break
    }
}

if ($gamePort -eq $null) {
    throw "No free TCP/UDP port was found in the requested range."
}

$gameScriptPath = Join-Path $workspaceDirectory "Server\gameserver.lua"
$statePath = Join-Path $workspaceDirectory "Webserver\www\game\server-state.json"
$gameScript = [System.IO.File]::ReadAllText($gameScriptPath)
# start()'s 10th argument (baseUrl) and 23rd (protocol) set RCC's web address;
# without them RCC's requests have no host and fail its trust check.
$startArgs = @("nil") * 23
$startArgs[0] = "$PlaceId"
$startArgs[1] = "$gamePort"
# 7th argument: script timeout in seconds, so one stuck game script cannot
# freeze the whole server (Roblox's own servers used about 10).
$startArgs[6] = "10"
$startArgs[9] = "`"$RccDomain`""
$startArgs[22] = "`"http://`""
$gameScript += "`r`nstart(" + ($startArgs -join ", ") + ")`r`n"
# Dresses characters in the player's avatar (RCC's own loading cannot run here).
$appearanceHook = Join-Path $workspaceDirectory "Server\appearance-hook.lua"
if (Test-Path $appearanceHook) { $gameScript += [System.IO.File]::ReadAllText($appearanceHook) + "`r`n" }
$escapedGameScript = [System.Security.SecurityElement]::Escape($gameScript)

$soapEnvelope = @"
<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="http://localhost./">
  <SOAP-ENV:Body>
    <ns1:Execute>
      <ns1:jobID>$escapedJobId</ns1:jobID>
      <ns1:script>
        <ns1:name>GameServer</ns1:name>
        <ns1:script>$escapedGameScript</ns1:script>
        <ns1:arguments />
      </ns1:script>
    </ns1:Execute>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>
"@

$state = [ordered]@{
    jobId = $JobId
    placeId = $PlaceId
    address = "localhost."
    port = $gamePort
}
$stateJson = $state | ConvertTo-Json
[System.IO.File]::WriteAllText($statePath, $stateJson + "`r`n", (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Submitting game server job '$JobId' on localhost.:$gamePort."
Write-Host "The web join endpoints now advertise this port. Keep this window open."

# Execute remains connected while RunService:Run() owns the job, so publish
# the selected port before making this intentionally long-running request.
$requestHeaders = @{ SOAPAction = '"http://localhost./RCCServiceSoap/Execute"' }
$response = Invoke-WebRequest -Uri $RccServiceUrl -Method Post -Headers $requestHeaders -ContentType "text/xml; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($soapEnvelope)) -UseBasicParsing

if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
    throw "RCCService rejected the Execute request with HTTP status $($response.StatusCode)."
}
