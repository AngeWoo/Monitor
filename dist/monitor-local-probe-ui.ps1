Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$baseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exePath = Join-Path $baseDir "monitor-local-probe.exe"
$cfgPath = Join-Path $baseDir "probe-config.json"
$apiBase = ""
$probeId = ""
$probeName = ""
$loopIntervalSec = 60

if (-not (Test-Path $exePath)) {
  [System.Windows.Forms.MessageBox]::Show("monitor-local-probe.exe not found.`r`n$exePath", "Monitor Local Probe") | Out-Null
  exit 1
}

if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    $apiBase = [string]$cfg.api_base
    $probeId = [string]$cfg.probe_id
    $probeName = [string]$cfg.probe_name
    if ($cfg.control_window_interval_sec) {
      $loopIntervalSec = [Math]::Max(10, [int]$cfg.control_window_interval_sec)
    }
  } catch {
  }
}

if (-not $probeId) { $probeId = "local-$env:COMPUTERNAME" }
if (-not $probeName) { $probeName = $probeId }

$form = New-Object System.Windows.Forms.Form
$form.Text = "Monitor Local Probe"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(760, 560)
$form.MinimumSize = New-Object System.Drawing.Size(720, 520)
$form.Topmost = $true

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Dock = "Top"
$statusLabel.Height = 30
$statusLabel.TextAlign = "MiddleLeft"
$statusLabel.Padding = New-Object System.Windows.Forms.Padding(12, 6, 12, 0)
$statusLabel.Text = "Status: idle"

$buttonPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonPanel.Dock = "Top"
$buttonPanel.Height = 52
$buttonPanel.Padding = New-Object System.Windows.Forms.Padding(8)
$buttonPanel.FlowDirection = "LeftToRight"

$btnRunOnce = New-Object System.Windows.Forms.Button
$btnRunOnce.Text = "Run Once"
$btnRunOnce.Width = 100
$btnRunOnce.Height = 32

$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Text = "Start Loop"
$btnStart.Width = 100
$btnStart.Height = 32

$btnStop = New-Object System.Windows.Forms.Button
$btnStop.Text = "Stop"
$btnStop.Width = 100
$btnStop.Height = 32
$btnStop.Enabled = $false

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = "Close"
$btnClose.Width = 100
$btnClose.Height = 32

$scanPanel = New-Object System.Windows.Forms.Panel
$scanPanel.Dock = "Top"
$scanPanel.Height = 110
$scanPanel.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)

$scanTitle = New-Object System.Windows.Forms.Label
$scanTitle.Text = "Port Scan"
$scanTitle.Location = New-Object System.Drawing.Point(4, 4)
$scanTitle.AutoSize = $true

$scanHint = New-Object System.Windows.Forms.Label
$scanHint.Text = "Device defaults to all services. Host=AUTO uses each service URL host. Ports come from admin settings."
$scanHint.Location = New-Object System.Drawing.Point(84, 5)
$scanHint.AutoSize = $true

$deviceLabel = New-Object System.Windows.Forms.Label
$deviceLabel.Text = "Device"
$deviceLabel.Location = New-Object System.Drawing.Point(4, 34)
$deviceLabel.AutoSize = $true

$txtDevice = New-Object System.Windows.Forms.TextBox
$txtDevice.Location = New-Object System.Drawing.Point(64, 30)
$txtDevice.Size = New-Object System.Drawing.Size(180, 24)
$txtDevice.Text = "AllServices"

$hostLabel = New-Object System.Windows.Forms.Label
$hostLabel.Text = "Host"
$hostLabel.Location = New-Object System.Drawing.Point(258, 34)
$hostLabel.AutoSize = $true

$txtHost = New-Object System.Windows.Forms.TextBox
$txtHost.Location = New-Object System.Drawing.Point(304, 30)
$txtHost.Size = New-Object System.Drawing.Size(180, 24)
$txtHost.Text = "AUTO"

$portsLabel = New-Object System.Windows.Forms.Label
$portsLabel.Text = "Ports"
$portsLabel.Location = New-Object System.Drawing.Point(498, 34)
$portsLabel.AutoSize = $true

$txtPorts = New-Object System.Windows.Forms.TextBox
$txtPorts.Location = New-Object System.Drawing.Point(542, 30)
$txtPorts.Size = New-Object System.Drawing.Size(180, 24)
$txtPorts.Text = "22,80,443,3389"

$scanNote = New-Object System.Windows.Forms.Label
$scanNote.Text = "Use comma-separated ports or ranges. With AllServices, Host=AUTO scans each service host."
$scanNote.Location = New-Object System.Drawing.Point(4, 68)
$scanNote.AutoSize = $true

$btnPortScan = New-Object System.Windows.Forms.Button
$btnPortScan.Text = "Scan Ports"
$btnPortScan.Location = New-Object System.Drawing.Point(622, 64)
$btnPortScan.Size = New-Object System.Drawing.Size(100, 30)

$buttonPanel.Controls.Add($btnRunOnce)
$buttonPanel.Controls.Add($btnStart)
$buttonPanel.Controls.Add($btnStop)
$buttonPanel.Controls.Add($btnClose)

$scanPanel.Controls.Add($scanTitle)
$scanPanel.Controls.Add($scanHint)
$scanPanel.Controls.Add($deviceLabel)
$scanPanel.Controls.Add($txtDevice)
$scanPanel.Controls.Add($hostLabel)
$scanPanel.Controls.Add($txtHost)
$scanPanel.Controls.Add($portsLabel)
$scanPanel.Controls.Add($txtPorts)
$scanPanel.Controls.Add($scanNote)
$scanPanel.Controls.Add($btnPortScan)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = "Vertical"
$logBox.WordWrap = $false
$logBox.Dock = "Fill"
$logBox.Font = New-Object System.Drawing.Font("Consolas", 10)

$form.Controls.Add($logBox)
$form.Controls.Add($scanPanel)
$form.Controls.Add($buttonPanel)
$form.Controls.Add($statusLabel)

$loopTimer = New-Object System.Windows.Forms.Timer
$loopTimer.Interval = $loopIntervalSec * 1000

$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 500

$signalTimer = New-Object System.Windows.Forms.Timer
$signalTimer.Interval = 5000

$script:isLoopEnabled = $false
$script:isTaskRunning = $false
$script:isProbeOnline = $false
$script:lastStatusText = "Status: idle"
$script:workerProcess = $null
$script:activeTask = ""
$script:stdoutPath = ""
$script:stderrPath = ""
$script:stdoutOffset = 0
$script:stderrOffset = 0
$script:lastHandledProbeSignal = ""
$script:lastHandledPortRequestId = ""

function Append-Log {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return }
  $logBox.AppendText($Text + [Environment]::NewLine)
}

function Update-Buttons {
  $hasPorts = -not [string]::IsNullOrWhiteSpace([string]$txtPorts.Text)
  $btnRunOnce.Enabled = -not $script:isTaskRunning
  $btnStart.Enabled = (-not $script:isTaskRunning) -and (-not $script:isLoopEnabled)
  $btnStop.Enabled = $script:isLoopEnabled -or $script:isTaskRunning
  $btnPortScan.Enabled = (-not $script:isTaskRunning) -and $hasPorts
}

function Update-Status {
  $statusLabel.Text = $script:lastStatusText
  Update-Buttons
}

function Read-Api {
  param([string]$Query)
  if (-not $apiBase) { return $null }
  try {
    $uriBuilder = [System.UriBuilder]::new($apiBase)
    $uriBuilder.Query = $Query
    return Invoke-RestMethod -Uri $uriBuilder.Uri.AbsoluteUri -Method Get
  } catch {
    return $null
  }
}

function Get-PortScanConfig {
  $response = Read-Api "action=getPortScanConfig"
  if ($response -and $response.ok) { return $response.data }
  return $null
}

function Get-PortScanSignal {
  $response = Read-Api "action=getPortScanSignal"
  if ($response -and $response.ok) { return $response.data }
  return $null
}

function Get-ProbeRunSignal {
  $response = Read-Api ("action=getProbeRunSignal&probe_id=" + [System.Uri]::EscapeDataString($probeId))
  if ($response -and $response.ok) { return $response.data }
  return $null
}

function Refresh-ProbeState {
  if (-not $apiBase) { return }
  try {
    $response = Read-Api "action=listProbes"
    if (-not ($response -and $response.ok -and $response.data)) { return }
    foreach ($probe in @($response.data)) {
      if (-not [string]::Equals(([string]$probe.probe_id).Trim(), $probeId.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
        continue
      }
      $lastSeenAt = $null
      try { $lastSeenAt = [datetime]::Parse([string]$probe.last_seen_at) } catch {}
      if ($lastSeenAt) {
        $script:isProbeOnline = (([datetime]::UtcNow - $lastSeenAt.ToUniversalTime()).TotalMinutes -le 3.0)
      }
      break
    }
  } catch {
  }
}

function Apply-PortScanConfig {
  param([object]$Config)
  $ports = ""
  if ($Config) {
    $ports = [string]$Config.ports
  }
  if (-not [string]::IsNullOrWhiteSpace($ports)) {
    $txtPorts.Text = $ports.Trim()
    $scanNote.Text = "Admin-configured ports loaded: " + $ports.Trim()
  }
}

function Load-PortScanConfig {
  $config = Get-PortScanConfig
  if ($config) {
    Apply-PortScanConfig -Config $config
    if (-not [string]::IsNullOrWhiteSpace([string]$config.ports)) {
      Append-Log ("Loaded global Port Scan ports: " + [string]$config.ports)
    }
  } else {
    Append-Log "Failed to load global Port Scan config."
  }
  Update-Buttons
}

function Cleanup-TempFiles {
  foreach ($path in @($script:stdoutPath, $script:stderrPath)) {
    if ($path -and (Test-Path $path)) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }
  $script:stdoutPath = ""
  $script:stderrPath = ""
  $script:stdoutOffset = 0
  $script:stderrOffset = 0
}

function Read-NewLogChunk {
  param([string]$Path, [int]$Offset)
  if (-not $Path -or -not (Test-Path $Path)) {
    return @{ Offset = $Offset; Text = "" }
  }
  try {
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop
  } catch {
    return @{ Offset = $Offset; Text = "" }
  }
  if ($null -eq $text) { $text = "" }
  if ($text.Length -le $Offset) {
    return @{ Offset = $text.Length; Text = "" }
  }
  return @{ Offset = $text.Length; Text = $text.Substring($Offset) }
}

function Flush-ProcessLogs {
  $stdout = Read-NewLogChunk -Path $script:stdoutPath -Offset $script:stdoutOffset
  $script:stdoutOffset = $stdout.Offset
  if ($stdout.Text) {
    foreach ($line in ($stdout.Text -split "`r?`n")) {
      if ($line) { Append-Log $line }
    }
  }

  $stderr = Read-NewLogChunk -Path $script:stderrPath -Offset $script:stderrOffset
  $script:stderrOffset = $stderr.Offset
  if ($stderr.Text) {
    foreach ($line in ($stderr.Text -split "`r?`n")) {
      if ($line) { Append-Log $line }
    }
  }
}

function Finish-Worker {
  param([string]$Reason = "")

  if ($pollTimer.Enabled) {
    $pollTimer.Stop()
  }

  Flush-ProcessLogs

  $exitCode = 0
  if ($script:workerProcess) {
    try {
      if ($script:workerProcess.HasExited) {
        $exitCode = $script:workerProcess.ExitCode
      }
    } catch {
      $exitCode = -1
    }
    try { $script:workerProcess.Dispose() } catch {}
  }

  $completedTask = $script:activeTask
  $script:workerProcess = $null
  $script:isTaskRunning = $false

  if ($completedTask -eq "probe" -and $exitCode -eq 0) {
    $script:isProbeOnline = $true
  }

  $displayExitCode = if ($null -eq $exitCode -or [string]::IsNullOrWhiteSpace([string]$exitCode)) { "unknown" } else { [string]$exitCode }

  if ($Reason) {
    Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $Reason)
  } elseif (-not ($completedTask -eq "remote-portscan" -and $exitCode -eq 3)) {
    Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $completedTask + " finished, exit code " + $displayExitCode)
  }

  if ($script:isLoopEnabled) {
    $script:lastStatusText = "Status: waiting for next loop run"
  } elseif ($completedTask -like "*portscan*" -or $script:isProbeOnline) {
    $script:lastStatusText = if ($script:isProbeOnline) { "Status: probe online" } else { "Status: idle" }
  } else {
    $script:lastStatusText = "Status: idle"
  }

  $script:activeTask = ""
  Cleanup-TempFiles
  Update-Status
}

function Start-Worker {
  param(
    [string]$TaskName,
    [string[]]$ArgumentList,
    [string]$StartMessage,
    [string]$RunningStatus
  )

  if ($script:isTaskRunning) {
    Append-Log "Another task is already in progress."
    return $false
  }

  $script:stdoutPath = [System.IO.Path]::GetTempFileName()
  $script:stderrPath = [System.IO.Path]::GetTempFileName()
  $script:stdoutOffset = 0
  $script:stderrOffset = 0

  try {
    $script:activeTask = $TaskName
    $script:workerProcess = Start-Process -FilePath $exePath -ArgumentList $ArgumentList -WindowStyle Hidden -PassThru -RedirectStandardOutput $script:stdoutPath -RedirectStandardError $script:stderrPath
  } catch {
    Cleanup-TempFiles
    $script:activeTask = ""
    $script:isTaskRunning = $false
    $script:lastStatusText = "Status: start failed"
    Append-Log ("Failed to start " + $TaskName + ": " + $_.Exception.Message)
    Update-Status
    return $false
  }

  $script:isTaskRunning = $true
  $script:lastStatusText = $RunningStatus
  Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $StartMessage)
  Update-Status
  if (-not $pollTimer.Enabled) {
    $pollTimer.Start()
  }
  return $true
}

function Start-ProbeProcess {
  param([string]$ForceServiceId = "", [string]$TriggerLabel = "")

  $args = @("--run-once", "--no-result-window")
  if (Test-Path $cfgPath) {
    $args += @("--config", $cfgPath)
  }
  if (-not [string]::IsNullOrWhiteSpace($ForceServiceId)) {
    $args += @("--service-id", $ForceServiceId)
  }

  $label = if ([string]::IsNullOrWhiteSpace($TriggerLabel)) { "Probe started" } else { $TriggerLabel }
  [void](Start-Worker -TaskName "probe" -ArgumentList $args -StartMessage $label -RunningStatus "Status: running")
}

function Start-PortScanProcess {
  Load-PortScanConfig
  $deviceName = [string]$txtDevice.Text
  $scanHost = [string]$txtHost.Text
  $scanPorts = [string]$txtPorts.Text
  $normalizedDeviceName = ($deviceName -replace '[\s_\-:]+', '')
  $isAllServices = [string]::Equals($normalizedDeviceName, 'AllServices', [System.StringComparison]::OrdinalIgnoreCase) -or ($normalizedDeviceName -eq '所有測試項') -or [string]::Equals($normalizedDeviceName, 'All', [System.StringComparison]::OrdinalIgnoreCase)

  if ((-not $isAllServices) -and [string]::IsNullOrWhiteSpace($scanHost)) {
    Append-Log "Port Scan host is required."
    return
  }
  if ([string]::IsNullOrWhiteSpace($scanPorts)) {
    Append-Log "Port Scan ports are required."
    return
  }
  if ([string]::IsNullOrWhiteSpace($deviceName)) {
    $deviceName = $scanHost
    $txtDevice.Text = $deviceName
  }
  if ($isAllServices -and [string]::IsNullOrWhiteSpace($scanHost)) {
    $scanHost = "AUTO"
    $txtHost.Text = $scanHost
  }

  $safeDeviceName = '"' + ($deviceName -replace '"', '\"') + '"'
  $safeScanHost = '"' + ($scanHost -replace '"', '\"') + '"'
  $safeScanPorts = '"' + ($scanPorts -replace '"', '\"') + '"'
  $args = @("--port-scan", "--scan-host", $safeScanHost, "--scan-ports", $safeScanPorts, "--device-name", $safeDeviceName)
  if (Test-Path $cfgPath) {
    $safeCfgPath = '"' + ($cfgPath -replace '"', '\"') + '"'
    $args += @("--config", $safeCfgPath)
  }

  [void](Start-Worker -TaskName "manual-portscan" -ArgumentList $args -StartMessage ("Port Scan started for " + $deviceName + " (" + $scanHost + ")") -RunningStatus "Status: port scan running")
}

function Start-RequestedPortScanProcess {
  $args = @("--claim-port-scan-request", "--no-result-window")
  if (Test-Path $cfgPath) {
    $args += @("--config", $cfgPath)
  }

  [void](Start-Worker -TaskName "remote-portscan" -ArgumentList $args -StartMessage "Remote Port Scan requested" -RunningStatus "Status: port scan running")
}

function Test-RecentSignal {
  param([string]$RequestedAt, [int]$MaxAgeSeconds = 180)
  if ([string]::IsNullOrWhiteSpace($RequestedAt)) { return $false }
  try {
    $requestedTime = [datetime]::Parse($RequestedAt).ToUniversalTime()
    $ageSeconds = ([datetime]::UtcNow - $requestedTime).TotalSeconds
    return $ageSeconds -ge 0 -and $ageSeconds -le $MaxAgeSeconds
  } catch {
    return $false
  }
}

$pollTimer.Add_Tick({
  if (-not $script:workerProcess) {
    $pollTimer.Stop()
    return
  }
  Flush-ProcessLogs
  try {
    if (-not $script:workerProcess.HasExited) { return }
  } catch {
    return
  }
  Finish-Worker
})

$signalTimer.Add_Tick({
  if ($script:isTaskRunning) { return }

  $portSignal = Get-PortScanSignal
  if ($portSignal) {
    $requestId = [string]$portSignal.request_id
    $status = [string]$portSignal.status
    $requestedAt = [string]$portSignal.requested_at
    if ($requestId -and ($requestId -ne $script:lastHandledPortRequestId) -and [string]::Equals($status, "pending", [System.StringComparison]::OrdinalIgnoreCase) -and (Test-RecentSignal -RequestedAt $requestedAt)) {
      $script:lastHandledPortRequestId = $requestId
      Start-RequestedPortScanProcess
      return
    }
  }

  $signal = Get-ProbeRunSignal
  if (-not $signal) { return }
  $requestedAt = [string]$signal.requested_at
  if ([string]::IsNullOrWhiteSpace($requestedAt)) { return }
  if ($requestedAt -eq $script:lastHandledProbeSignal) { return }
  if (-not (Test-RecentSignal -RequestedAt $requestedAt)) { return }

  $script:lastHandledProbeSignal = $requestedAt
  $serviceName = [string]$signal.service_name
  if ([string]::IsNullOrWhiteSpace($serviceName)) { $serviceName = "all services" }
  Start-ProbeProcess -ForceServiceId ([string]$signal.service_id) -TriggerLabel ("Remote refresh requested: " + $serviceName)
})

$loopTimer.Add_Tick({
  if (-not $script:isLoopEnabled) { return }
  if ($script:isTaskRunning) { return }
  Start-ProbeProcess
})

$btnRunOnce.Add_Click({
  Start-ProbeProcess
})

$btnPortScan.Add_Click({
  Start-PortScanProcess
})

$btnStart.Add_Click({
  if ($script:isLoopEnabled) { return }
  $script:isLoopEnabled = $true
  $script:lastStatusText = "Status: waiting for next loop run"
  Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] Loop mode started")
  Update-Status
  $loopTimer.Start()
  if (-not $signalTimer.Enabled) {
    $signalTimer.Start()
  }
  if (-not $script:isTaskRunning) {
    Start-ProbeProcess
  }
})

$btnStop.Add_Click({
  if ($script:isLoopEnabled) {
    $script:isLoopEnabled = $false
    $loopTimer.Stop()
    Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] Loop mode stopped")
  }

  if ($script:isTaskRunning -and $script:workerProcess) {
    try {
      Stop-Process -Id $script:workerProcess.Id -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 120
      Finish-Worker -Reason "Current task stopped"
      return
    } catch {
      Append-Log ("Failed to stop current task: " + $_.Exception.Message)
    }
  }

  $script:lastStatusText = "Status: idle"
  Update-Status
})

$btnClose.Add_Click({
  $loopTimer.Stop()
  $signalTimer.Stop()
  if ($script:isTaskRunning -and $script:workerProcess) {
    try { Stop-Process -Id $script:workerProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
  Finish-Worker -Reason "Window closed"
  $form.Close()
})

$form.Add_FormClosing({
  try {
    $loopTimer.Stop()
    $signalTimer.Stop()
    if ($script:isTaskRunning -and $script:workerProcess) {
      Stop-Process -Id $script:workerProcess.Id -Force -ErrorAction SilentlyContinue
    }
  } catch {
  }
})

$form.Add_Shown({
  Append-Log "Control window ready."
  Append-Log "Use Run Once for a single check, or Start Loop for repeated runs."
Append-Log "Port Scan is ready with Device=AllServices, Host=AUTO(service hosts), and Ports from admin config when available."
  Append-Log "Admin-triggered port scan requests are polled automatically while this window is open."
  Append-Log ("Loop interval: " + $loopIntervalSec + " sec")
  Append-Log "Remote refresh signal poll: 5 sec"
  Load-PortScanConfig
  Refresh-ProbeState
  if (-not $signalTimer.Enabled) {
    $signalTimer.Start()
  }
  Update-Status
})

[void]$form.ShowDialog()
