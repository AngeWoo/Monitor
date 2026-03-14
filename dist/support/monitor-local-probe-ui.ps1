Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$baseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $baseDir
$exePath = Join-Path $baseDir "monitor-local-probe-core.exe"
$cfgPath = Join-Path $rootDir "probe-config.json"
$apiBase = ""
$probeId = ""
$probeName = ""

if (-not (Test-Path $exePath)) {
  [System.Windows.Forms.MessageBox]::Show("monitor-local-probe-core.exe not found.`r`n$exePath", "Monitor Local Probe") | Out-Null
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
$form.Size = New-Object System.Drawing.Size(620, 460)
$form.MinimumSize = New-Object System.Drawing.Size(560, 400)
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

$buttonPanel.Controls.Add($btnRunOnce)
$buttonPanel.Controls.Add($btnStart)
$buttonPanel.Controls.Add($btnStop)
$buttonPanel.Controls.Add($btnClose)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = "Vertical"
$logBox.WordWrap = $false
$logBox.Dock = "Fill"
$logBox.Font = New-Object System.Drawing.Font("Consolas", 10)

$form.Controls.Add($logBox)
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
$script:lastStatusText = "Status: idle"
$script:probeProcess = $null
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
    Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] Probe finished, exit code " + $exitCode)
  }

  if ($script:isLoopEnabled) {
    $script:lastStatusText = "Status: waiting for next run every $loopIntervalSec sec"
  } else {
    $script:lastStatusText = if ($Reason) { "Status: idle" } else { "Status: finished (exit code $exitCode)" }
  }

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
    $script:probeProcess = Start-Process -FilePath $exePath -ArgumentList $argumentList -WindowStyle Hidden -PassThru -RedirectStandardOutput $script:stdoutPath -RedirectStandardError $script:stderrPath
  } catch {
    Cleanup-TempFiles
    $script:isProbeRunning = $false
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
      Finish-ProbeProcess -Reason "Current probe stopped"
      Update-ProbePresence -RunStatus "OFFLINE" -Summary "Probe stopped by user"
      return
    } catch {
      Append-Log ("Failed to stop current probe: " + $_.Exception.Message)
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
    Update-ProbePresence -RunStatus "OFFLINE" -Summary "Probe window closed"
  } catch {
  }
})

$form.Add_Shown({
  Append-Log "Control window ready."
  Append-Log "Use Run Once for a single check, or Start Loop for repeated runs."
  Append-Log "Loop interval: $loopIntervalSec sec"
  Append-Log "Remote refresh signal poll: 5 sec"
  if (-not $signalTimer.Enabled) {
    $signalTimer.Start()
  }
  Update-ProbePresence -RunStatus "IDLE" -Summary "Probe window ready"
  Update-Status
})

[void]$form.ShowDialog()
