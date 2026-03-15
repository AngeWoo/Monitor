Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$baseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exePath = Join-Path $baseDir "monitor-local-probe.exe"
$cfgPath = Join-Path $baseDir "probe-config.json"
$apiBase = ""
$probeId = ""
$probeName = ""

if (-not (Test-Path $exePath)) {
  [System.Windows.Forms.MessageBox]::Show("monitor-local-probe.exe not found.`r`n$exePath", "Monitor Local Probe") | Out-Null
  exit 1
}

$loopIntervalSec = 60
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content -Path $cfgPath -Raw | ConvertFrom-Json
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
$scanHint.Text = "Port Scan is available only after one successful probe run."
$scanHint.Location = New-Object System.Drawing.Point(84, 5)
$scanHint.AutoSize = $true

$deviceLabel = New-Object System.Windows.Forms.Label
$deviceLabel.Text = "Device"
$deviceLabel.Location = New-Object System.Drawing.Point(4, 34)
$deviceLabel.AutoSize = $true

$txtDevice = New-Object System.Windows.Forms.TextBox
$txtDevice.Location = New-Object System.Drawing.Point(64, 30)
$txtDevice.Size = New-Object System.Drawing.Size(180, 24)
$txtDevice.Text = $env:COMPUTERNAME

$hostLabel = New-Object System.Windows.Forms.Label
$hostLabel.Text = "Host"
$hostLabel.Location = New-Object System.Drawing.Point(258, 34)
$hostLabel.AutoSize = $true

$txtHost = New-Object System.Windows.Forms.TextBox
$txtHost.Location = New-Object System.Drawing.Point(304, 30)
$txtHost.Size = New-Object System.Drawing.Size(180, 24)

$portsLabel = New-Object System.Windows.Forms.Label
$portsLabel.Text = "Ports"
$portsLabel.Location = New-Object System.Drawing.Point(498, 34)
$portsLabel.AutoSize = $true

$txtPorts = New-Object System.Windows.Forms.TextBox
$txtPorts.Location = New-Object System.Drawing.Point(542, 30)
$txtPorts.Size = New-Object System.Drawing.Size(180, 24)
$txtPorts.Text = "22,80,443,3389"

$scanNote = New-Object System.Windows.Forms.Label
$scanNote.Text = "Use comma-separated ports or ranges, for example 80,443,8080-8082"
$scanNote.Location = New-Object System.Drawing.Point(4, 68)
$scanNote.AutoSize = $true

$btnPortScan = New-Object System.Windows.Forms.Button
$btnPortScan.Text = "Scan Ports"
$btnPortScan.Location = New-Object System.Drawing.Point(622, 64)
$btnPortScan.Size = New-Object System.Drawing.Size(100, 30)
$btnPortScan.Enabled = $false

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
$script:isProbeRunning = $false
$script:isProbeOnline = $false
$script:isPortScanEnabled = $false
$script:lastStatusText = "Status: idle"
$script:probeProcess = $null
$script:activeTask = ""
$script:stdoutPath = ""
$script:stderrPath = ""
$script:stdoutOffset = 0
$script:stderrOffset = 0
$script:lastHandledSignalAt = ""

function Append-Log {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return }
  $logBox.AppendText($Text + [Environment]::NewLine)
}

function Update-Buttons {
  $btnRunOnce.Enabled = -not $script:isProbeRunning
  $btnStart.Enabled = (-not $script:isProbeRunning) -and (-not $script:isLoopEnabled)
  $btnStop.Enabled = $script:isLoopEnabled -or $script:isProbeRunning
  $btnPortScan.Enabled = $script:isProbeOnline -and $script:isPortScanEnabled -and (-not $script:isProbeRunning) -and (-not $script:isLoopEnabled)
}

function Update-Status {
  $statusLabel.Text = $script:lastStatusText
  Update-Buttons
}

function Update-ProbePresence {
  param(
    [string]$RunStatus,
    [string]$RunError = "",
    [int]$ResultCount = 0,
    [int]$DownCount = 0,
    [string]$Summary = ""
  )

  if (-not $apiBase) { return }

  $payload = @{
    action = "upsertProbe"
    probe_id = $probeId
    probe_name = $probeName
    host_name = $env:COMPUTERNAME
    host_user = $env:USERNAME
    platform = "win32"
    platform_release = [System.Environment]::OSVersion.VersionString
    api_base = $apiBase
    last_run_status = $RunStatus
    last_run_error = $RunError
    last_result_count = $ResultCount
    last_down_count = $DownCount
    last_status_summary = $Summary
  }

  try {
    Invoke-RestMethod -Uri $apiBase -Method Post -ContentType "application/json" -Body ($payload | ConvertTo-Json -Depth 6) | Out-Null
  } catch {
  }
}

function Get-ProbeRunSignal {
  if (-not $apiBase) { return $null }
  try {
    $uriBuilder = [System.UriBuilder]::new($apiBase)
    $query = "action=getProbeRunSignal&probe_id=$([System.Uri]::EscapeDataString($probeId))"
    $uriBuilder.Query = $query
    $response = Invoke-RestMethod -Uri $uriBuilder.Uri.AbsoluteUri -Method Get
    if ($response -and $response.ok -and $response.data) {
      return $response.data
    }
  } catch {
  }
  return $null
}

function Get-PortScanConfig {
  if (-not $apiBase) { return $null }
  try {
    $uriBuilder = [System.UriBuilder]::new($apiBase)
    $uriBuilder.Query = "action=getPortScanConfig"
    $response = Invoke-RestMethod -Uri $uriBuilder.Uri.AbsoluteUri -Method Get
    if ($response -and $response.ok) {
      return $response.data
    }
  } catch {
  }
  return $null
}

function Get-ProbeState {
  if (-not $apiBase) { return $null }
  try {
    $uriBuilder = [System.UriBuilder]::new($apiBase)
    $uriBuilder.Query = "action=listProbes"
    $response = Invoke-RestMethod -Uri $uriBuilder.Uri.AbsoluteUri -Method Get
    if (-not ($response -and $response.ok -and $response.data)) {
      return $null
    }

    foreach ($probe in @($response.data)) {
      $candidateId = [string]$probe.probe_id
      if (-not [string]::Equals($candidateId.Trim(), $probeId.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
        continue
      }

      $lastSeenAt = $null
      try {
        $lastSeenAt = [datetime]::Parse([string]$probe.last_seen_at)
      } catch {
        $lastSeenAt = $null
      }

      $isOnline = $false
      if ($lastSeenAt) {
        $elapsed = ([datetime]::UtcNow - $lastSeenAt.ToUniversalTime()).TotalMinutes
        $isOnline = $elapsed -le 3.0
      }

      return @{
        online = $isOnline
        last_run_status = [string]$probe.last_run_status
        last_seen_at = [string]$probe.last_seen_at
      }
    }
  } catch {
  }
  return $null
}

function Refresh-ProbeState {
  param(
    [bool]$LogResult = $true
  )

  $probeState = Get-ProbeState
  if ($probeState) {
    $script:isProbeOnline = [bool]$probeState.online
    if ($script:isProbeOnline) {
      $script:lastStatusText = "Status: probe online"
      if ($LogResult) {
        Append-Log ("Probe state restored from server. Last seen: " + [string]$probeState.last_seen_at)
      }
    } else {
      if ($LogResult) {
        Append-Log "Probe is currently offline. Run Probe once to enable Port Scan."
      }
    }
  } elseif ($LogResult) {
    Append-Log "Failed to load current probe state from server."
  }
  Update-Status
}

function Apply-PortScanConfig {
  param(
    [object]$Config
  )

  $enabled = $false
  $ports = ""
  if ($Config) {
    $enabled = [System.Convert]::ToBoolean($Config.enabled)
    $ports = [string]$Config.ports
  }

  $script:isPortScanEnabled = $enabled -and (-not [string]::IsNullOrWhiteSpace($ports))

  if (-not [string]::IsNullOrWhiteSpace($ports)) {
    $txtPorts.Text = $ports.Trim()
  }
  if ([string]::IsNullOrWhiteSpace([string]$txtHost.Text)) {
    $txtHost.Text = "127.0.0.1"
  }
  if ([string]::IsNullOrWhiteSpace([string]$txtDevice.Text)) {
    $txtDevice.Text = $env:COMPUTERNAME
  }

  if ($script:isPortScanEnabled) {
    $scanHint.Text = "Global Port Scan config loaded. Scan is available after this probe reports online."
    $scanNote.Text = "Scanning localhost using admin-configured ports: " + $ports.Trim()
  } elseif (-not [string]::IsNullOrWhiteSpace($ports)) {
    $scanHint.Text = "Global Port Scan is disabled in admin settings."
    $scanNote.Text = "Configured ports: " + $ports.Trim()
  } else {
    $scanHint.Text = "Port Scan config not loaded. Check admin settings or API access."
    $scanNote.Text = "Use comma-separated ports or ranges, for example 80,443,8080-8082"
  }
}

function Load-PortScanConfig {
  param(
    [bool]$LogResult = $true
  )

  $config = Get-PortScanConfig
  if ($config) {
    Apply-PortScanConfig -Config $config
    if ($LogResult) {
      if ($script:isPortScanEnabled) {
        Append-Log ("Loaded global Port Scan ports: " + [string]$config.ports)
      } else {
        Append-Log "Global Port Scan is currently disabled in admin settings."
      }
    }
  } else {
    Apply-PortScanConfig -Config $null
    if ($LogResult) {
      Append-Log "Failed to load global Port Scan config."
    }
  }
  Update-Status
}

function Cleanup-TempFiles {
  foreach ($path in @($script:stdoutPath, $script:stderrPath)) {
    if ($path -and (Test-Path $path)) {
      Remove-Item -Path $path -Force -ErrorAction SilentlyContinue
    }
  }
  $script:stdoutPath = ""
  $script:stderrPath = ""
  $script:stdoutOffset = 0
  $script:stderrOffset = 0
}

function Read-NewLogChunk {
  param(
    [string]$Path,
    [int]$Offset
  )

  if (-not $Path -or -not (Test-Path $Path)) {
    return @{ Offset = $Offset; Text = "" }
  }

  try {
    $text = Get-Content -Path $Path -Raw -Encoding UTF8 -ErrorAction Stop
  } catch {
    return @{ Offset = $Offset; Text = "" }
  }

  if ($null -eq $text) { $text = "" }
  if ($text.Length -le $Offset) {
    return @{ Offset = $text.Length; Text = "" }
  }

  return @{
    Offset = $text.Length
    Text = $text.Substring($Offset)
  }
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

function Finish-ProbeProcess {
  param(
    [string]$Reason = ""
  )

  if ($pollTimer.Enabled) {
    $pollTimer.Stop()
  }

  Flush-ProcessLogs

  $taskName = if ($script:activeTask -eq "portscan") { "Port Scan" } else { "Probe" }
  $exitCode = 0
  if ($script:probeProcess) {
    try {
      if ($script:probeProcess.HasExited) {
        $exitCode = $script:probeProcess.ExitCode
      }
    } catch {
      $exitCode = -1
    }
    try {
      $script:probeProcess.Dispose()
    } catch {
    }
  }

  $script:probeProcess = $null
  $script:isProbeRunning = $false

  if ($Reason) {
    Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $Reason)
  } else {
    Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $taskName + " finished, exit code " + $exitCode)
  }

  if ($script:activeTask -eq "probe") {
    $script:isProbeOnline = ($exitCode -eq 0)
  }

  if ($script:isLoopEnabled) {
    $script:lastStatusText = "Status: waiting for next run every $loopIntervalSec sec"
  } else {
    if ($script:activeTask -eq "portscan") {
      $script:lastStatusText = if ($script:isProbeOnline) { "Status: probe online" } else { "Status: idle" }
    } elseif ($script:activeTask -eq "probe" -and -not $Reason -and $exitCode -eq 0) {
      $script:lastStatusText = "Status: probe online"
    } else {
      $displayExitCode = if ($null -eq $exitCode -or $exitCode -eq "") { "unknown" } else { $exitCode }
      $script:lastStatusText = if ($Reason) { "Status: idle" } else { "Status: finished (exit code $displayExitCode)" }
    }
  }

  $script:activeTask = ""
  Cleanup-TempFiles
  Update-Status
}

function Start-ProbeProcess {
  param(
    [string]$ForceServiceId = "",
    [string]$TriggerLabel = ""
  )

  if ($script:isProbeRunning) {
    Append-Log "Probe run already in progress."
    return
  }

  $script:stdoutPath = [System.IO.Path]::GetTempFileName()
  $script:stderrPath = [System.IO.Path]::GetTempFileName()
  $script:stdoutOffset = 0
  $script:stderrOffset = 0

  $argumentList = @("--run-once", "--no-result-window")
  if (Test-Path $cfgPath) {
    $argumentList += @("--config", $cfgPath)
  }
  if (-not [string]::IsNullOrWhiteSpace($ForceServiceId)) {
    $argumentList += @("--service-id", $ForceServiceId)
  }

  try {
    $script:activeTask = "probe"
    $script:probeProcess = Start-Process -FilePath $exePath -ArgumentList $argumentList -WindowStyle Hidden -PassThru -RedirectStandardOutput $script:stdoutPath -RedirectStandardError $script:stderrPath
  } catch {
    Cleanup-TempFiles
    $script:isProbeRunning = $false
    $script:activeTask = ""
    $script:lastStatusText = "Status: start failed"
    Append-Log ("Failed to start probe: " + $_.Exception.Message)
    Update-Status
    return
  }

  $script:isProbeRunning = $true
  $script:lastStatusText = if ($script:isLoopEnabled) { "Status: running (loop enabled)" } else { "Status: running" }
  $runLabel = if ([string]::IsNullOrWhiteSpace($TriggerLabel)) { "Probe started" } else { $TriggerLabel }
  Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $runLabel)
  Update-Status

  if (-not $pollTimer.Enabled) {
    $pollTimer.Start()
  }
}

function Start-PortScanProcess {
  Load-PortScanConfig -LogResult $false

  if (-not $script:isPortScanEnabled) {
    Append-Log "Port Scan is disabled or not configured in admin settings."
    return
  }

  if (-not $script:isProbeOnline) {
    Append-Log "Port Scan requires the probe to be online first. Run Probe once successfully before scanning."
    return
  }

  if ($script:isProbeRunning) {
    Append-Log "Another task is already in progress."
    return
  }

  $deviceName = [string]$txtDevice.Text
  $scanHost = [string]$txtHost.Text
  $scanPorts = [string]$txtPorts.Text

  if ([string]::IsNullOrWhiteSpace($scanHost)) {
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

  $script:stdoutPath = [System.IO.Path]::GetTempFileName()
  $script:stderrPath = [System.IO.Path]::GetTempFileName()
  $script:stdoutOffset = 0
  $script:stderrOffset = 0

  $argumentList = @(
    "--port-scan",
    "--scan-host", $scanHost,
    "--scan-ports", $scanPorts,
    "--device-name", $deviceName
  )
  if (Test-Path $cfgPath) {
    $argumentList += @("--config", $cfgPath)
  }

  try {
    $script:activeTask = "portscan"
    $script:probeProcess = Start-Process -FilePath $exePath -ArgumentList $argumentList -WindowStyle Hidden -PassThru -RedirectStandardOutput $script:stdoutPath -RedirectStandardError $script:stderrPath
  } catch {
    Cleanup-TempFiles
    $script:isProbeRunning = $false
    $script:activeTask = ""
    $script:lastStatusText = "Status: port scan start failed"
    Append-Log ("Failed to start port scan: " + $_.Exception.Message)
    Update-Status
    return
  }

  $script:isProbeRunning = $true
  $script:lastStatusText = "Status: port scan running"
  Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] Port Scan started for " + $deviceName + " (" + $scanHost + ")")
  Update-Status

  if (-not $pollTimer.Enabled) {
    $pollTimer.Start()
  }
}

$pollTimer.Add_Tick({
  if (-not $script:probeProcess) {
    $pollTimer.Stop()
    return
  }

  Flush-ProcessLogs

  try {
    if (-not $script:probeProcess.HasExited) { return }
  } catch {
    return
  }

  Finish-ProbeProcess
})

$signalTimer.Add_Tick({
  if ($script:isProbeRunning) { return }
  $signal = Get-ProbeRunSignal
  if (-not $signal) { return }

  $requestedAt = [string]$signal.requested_at
  if ([string]::IsNullOrWhiteSpace($requestedAt)) { return }
  if ($requestedAt -eq $script:lastHandledSignalAt) { return }

  $script:lastHandledSignalAt = $requestedAt
  $serviceName = [string]$signal.service_name
  if ([string]::IsNullOrWhiteSpace($serviceName)) { $serviceName = "all services" }
  Start-ProbeProcess -ForceServiceId ([string]$signal.service_id) -TriggerLabel ("Remote refresh requested: " + $serviceName)
})

$loopTimer.Add_Tick({
  if (-not $script:isLoopEnabled) { return }
  if ($script:isProbeRunning) { return }
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
  $script:lastStatusText = "Status: waiting for next run every $loopIntervalSec sec"
  Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] Loop mode started")
  Update-Status
  $loopTimer.Start()
  if (-not $signalTimer.Enabled) {
    $signalTimer.Start()
  }
  if (-not $script:isProbeRunning) {
    Start-ProbeProcess
  }
})

$btnStop.Add_Click({
  if ((-not $script:isLoopEnabled) -and (-not $script:isProbeRunning)) { return }
  $stoppedTask = $script:activeTask

  if ($script:isLoopEnabled) {
    $script:isLoopEnabled = $false
    $loopTimer.Stop()
    $signalTimer.Stop()
    Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] Loop mode stopped")
  }

  if ($script:isProbeRunning -and $script:probeProcess) {
    try {
      Stop-Process -Id $script:probeProcess.Id -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 120
      if ($stoppedTask -eq "portscan") {
        Finish-ProbeProcess -Reason "Current port scan stopped"
      } else {
        Finish-ProbeProcess -Reason "Current probe stopped"
        Update-ProbePresence -RunStatus "OFFLINE" -Summary "Probe stopped by user"
      }
      return
    } catch {
      $taskLabel = if ($stoppedTask -eq "portscan") { "current port scan" } else { "current probe" }
      Append-Log ("Failed to stop " + $taskLabel + ": " + $_.Exception.Message)
      $script:lastStatusText = "Status: stop failed"
      Update-Status
      return
    }
  }

  $script:lastStatusText = "Status: idle"
  Update-ProbePresence -RunStatus "OFFLINE" -Summary "Probe loop stopped by user"
  Update-Status
})

$btnClose.Add_Click({
  $loopTimer.Stop()
  $signalTimer.Stop()
  $script:isLoopEnabled = $false

  if ($script:isProbeRunning -and $script:probeProcess) {
    try {
      Stop-Process -Id $script:probeProcess.Id -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 120
    } catch {
    }
  }

  $script:isProbeOnline = $false
  Finish-ProbeProcess -Reason "Window closed"
  Update-ProbePresence -RunStatus "OFFLINE" -Summary "Probe window closed"
  $form.Close()
})

$form.Add_FormClosing({
  try {
    $loopTimer.Stop()
    $signalTimer.Stop()
    $script:isLoopEnabled = $false
    if ($script:isProbeRunning -and $script:probeProcess) {
      Stop-Process -Id $script:probeProcess.Id -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 120
    }
    $script:isProbeOnline = $false
    Update-ProbePresence -RunStatus "OFFLINE" -Summary "Probe window closed"
  } catch {
  }
})

$form.Add_Shown({
  Append-Log "Control window ready."
  Append-Log "Use Run Once for a single check, or Start Loop for repeated runs."
  Load-PortScanConfig -LogResult $true
  Refresh-ProbeState -LogResult $true
  Append-Log "Port Scan becomes available after one successful probe run."
  Append-Log "Loop interval: $loopIntervalSec sec"
  Append-Log "Remote refresh signal poll: 5 sec"
  if (-not $signalTimer.Enabled) {
    $signalTimer.Start()
  }
  Update-ProbePresence -RunStatus "IDLE" -Summary "Probe window ready"
  Update-Status
})

[void]$form.ShowDialog()
