# The Windows half of lib/hoststats.js: what Node can't read itself. Started
# once by the web server; prints one JSON line every -Every milliseconds and
# exits when the web server (-Parent) is gone. Nothing here needs admin.
#
#   monitor, sensors  LibreHardwareMonitor / OpenHardwareMonitor sensors (temperature, load),
#                     while one of them runs
#   zones             ACPI thermal zones in kelvin, when there is no monitor (often none on desktops)
#   rx, tx, nics      bytes received and sent so far by the hardware network adapters
#   rcc, rccRam       RCCService processes and their working set in bytes
#   gpu               GPU usage % from the Windows GPU engine counters (-GpuCounters, no nvidia-smi)
param([int]$Parent, [int]$Every = 10000, [switch]$GpuCounters)

$ErrorActionPreference = 'SilentlyContinue'
$checked = @{}
# True when `name` was last looked for more than `minutes` ago (or never).
function Due([string]$name, [double]$minutes) {
  $now = [DateTime]::UtcNow
  if ($checked.ContainsKey($name) -and ($now - $checked[$name]).TotalMinutes -lt $minutes) { return $false }
  $checked[$name] = $now
  return $true
}

$monitor = $null
$zonesFound = $false
$acpiFound = $false
$adapters = @()
$gpuBefore = @{}

while ($true) {
  $started = [DateTime]::UtcNow
  if (-not (Get-Process -Id $Parent)) { exit }
  $out = @{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

  # Hardware monitor apps publish their sensors in WMI while they run.
  if (-not $monitor -and (Due 'monitor' 1)) {
    foreach ($ns in 'root/LibreHardwareMonitor', 'root/OpenHardwareMonitor') {
      if (@(Get-CimInstance -Namespace $ns -ClassName Hardware).Count) { $monitor = $ns; break }
    }
  }
  if ($monitor) {
    $sensors = @(Get-CimInstance -Namespace $monitor -ClassName Sensor -Filter "SensorType = 'Temperature' OR SensorType = 'Load'")
    if ($sensors.Count) {
      $out.monitor = $monitor.Substring(5)
      $out.sensors = @($sensors | ForEach-Object {
        $value = [double]$_.Value
        if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { $value = $null }
        [pscustomobject]@{ id = [string]$_.Identifier; name = [string]$_.Name; type = [string]$_.SensorType; value = $value }
      })
    } else {
      $monitor = $null
    }
  }

  # ACPI thermal zones: the performance counters need no admin; MSAcpi does.
  if (-not $out.monitor -and ($zonesFound -or (Due 'zones' 10))) {
    $zones = @(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation)
    $zonesFound = $zones.Count -gt 0
    if ($zonesFound) {
      $out.zones = @($zones | ForEach-Object { if ($_.HighPrecisionTemperature) { $_.HighPrecisionTemperature / 10.0 } else { [double]$_.Temperature } })
    }
  }
  if (-not $out.monitor -and -not $out.zones -and ($acpiFound -or (Due 'acpi' 10))) {
    $zones = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature)
    $acpiFound = $zones.Count -gt 0
    if ($acpiFound) { $out.zones = @($zones | ForEach-Object { $_.CurrentTemperature / 10.0 }) }
  }

  # Network: the hardware adapters only. Tunnels (WireGuard, Tailscale) would
  # count the same traffic twice.
  if (Due 'adapters' 10) {
    $adapters = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapter | Where-Object { $_.HardwareInterface } | ForEach-Object { $_.Name })
  }
  $rx = [double]0
  $tx = [double]0
  $nics = 0
  foreach ($stats in @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapterStatisticsSettingData)) {
    if ($adapters.Count -eq 0 -or $adapters -contains $stats.Name) {
      $rx += [double]$stats.ReceivedBytes
      $tx += [double]$stats.SentBytes
      $nics++
    }
  }
  if ($nics) { $out.rx = $rx; $out.tx = $tx; $out.nics = $nics }

  $rcc = @(Get-Process -Name RCCService)
  $out.rcc = $rcc.Count
  $out.rccRam = [double](($rcc | Measure-Object WorkingSet64 -Sum).Sum)

  # GPU usage the way Task Manager counts it: per engine, the sum over
  # processes of its busy time, and the busiest engine.
  $monitorGpu = $out.sensors | Where-Object { $_.type -eq 'Load' -and $_.id -match 'gpu' }
  if ($GpuCounters -and -not $monitorGpu) {
    $now = @{}
    $engines = @{}
    foreach ($engine in @(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine)) {
      $sample = @([double]$engine.UtilizationPercentage, [double]$engine.Timestamp_Sys100NS)
      $now[$engine.Name] = $sample
      $before = $gpuBefore[$engine.Name]
      if ($before -and $sample[1] -gt $before[1]) {
        $key = $engine.Name -replace '^pid_\d+_', ''
        $engines[$key] = [double]$engines[$key] + ($sample[0] - $before[0]) / ($sample[1] - $before[1]) * 100
      }
    }
    $gpuBefore = $now
    if ($engines.Count) { $out.gpu = [math]::Min(100, [math]::Max(0, ($engines.Values | Measure-Object -Maximum).Maximum)) }
  }

  try {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Compress -Depth 4))
    [Console]::Out.Flush()
  } catch {
    exit
  }
  $spent = ([DateTime]::UtcNow - $started).TotalMilliseconds
  Start-Sleep -Milliseconds ([int][math]::Max(1000, $Every - $spent))
}
