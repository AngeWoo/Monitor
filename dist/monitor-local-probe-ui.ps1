Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$baseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exePath = Join-Path $baseDir "monitor-local-probe.exe"
$cfgPath = Join-Path $baseDir "probe-config.json"
$apiBase = ""
$probeId = ""
$probeName = ""
$loopIntervalSec = 60
$defaultDeviceName = ""
$defaultScanHost = ""
$defaultScanPorts = "22,80,443,3389"

if (-not (Test-Path $exePath)) {
  [System.Windows.Forms.MessageBox]::Show("monitor-local-probe.exe not found.`r`n$exePath", "Monitor Local Probe") | Out-Null
  exit 1
}

if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    $apiBase   = [string]$cfg.api_base
    $probeId   = [string]$cfg.probe_id
    $probeName = [string]$cfg.probe_name
    if ($cfg.control_window_interval_sec) {
      $loopIntervalSec = [Math]::Max(10, [int]$cfg.control_window_interval_sec)
    }
    if ($cfg.scan_device_name) { $defaultDeviceName = [string]$cfg.scan_device_name }
    if ($cfg.scan_host)        { $defaultScanHost   = [string]$cfg.scan_host }
    if ($cfg.scan_ports)       { $defaultScanPorts  = [string]$cfg.scan_ports }
  } catch {}
}

if (-not $probeId)           { $probeId = "local-$env:COMPUTERNAME" }
if (-not $probeName)         { $probeName = $probeId }
if (-not $defaultDeviceName) { $defaultDeviceName = $env:COMPUTERNAME }

# ── Async signal state (shared between UI thread and background runspace) ─────
$script:sigState = [hashtable]::Synchronized(@{
  PortSignal  = $null
  SecSignal   = $null
  ProbeSignal = $null
  Stop        = $false
})

# ── Start background runspace for signal polling (no UI thread blocking) ──────
$sigRunspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
$sigRunspace.Open()
$sigRunspace.SessionStateProxy.SetVariable('sigState', $script:sigState)
$sigRunspace.SessionStateProxy.SetVariable('apiBase',  $apiBase)
$sigRunspace.SessionStateProxy.SetVariable('probeId',  $probeId)

$sigPS = [System.Management.Automation.PowerShell]::Create()
$sigPS.Runspace = $sigRunspace
[void]$sigPS.AddScript({
  function Fetch-Json {
    param([string]$Url)
    try {
      $req = [System.Net.WebRequest]::Create($Url)
      $req.Timeout = 8000
      $resp = $req.GetResponse()
      $sr   = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $body = $sr.ReadToEnd()
      $sr.Dispose(); $resp.Dispose()
      return $body | ConvertFrom-Json
    } catch { return $null }
  }

  while (-not $sigState.Stop) {
    if ($apiBase) {
      try {
        $r = Fetch-Json ($apiBase + "?action=getPortScanSignal")
        $sigState.PortSignal = if ($r -and $r.ok) { $r.data } else { $null }
      } catch { $sigState.PortSignal = $null }

      try {
        $r = Fetch-Json ($apiBase + "?action=getSecurityScanSignal")
        $sigState.SecSignal = if ($r -and $r.ok) { $r.data } else { $null }
      } catch { $sigState.SecSignal = $null }

      try {
        $pid2 = [System.Uri]::EscapeDataString($probeId)
        $r = Fetch-Json ($apiBase + "?action=getProbeRunSignal&probe_id=" + $pid2)
        $sigState.ProbeSignal = if ($r -and $r.ok) { $r.data } else { $null }
      } catch { $sigState.ProbeSignal = $null }
    }
    # Sleep 5 s in 100ms slices so Stop flag is checked promptly
    for ($i = 0; $i -lt 50 -and -not $sigState.Stop; $i++) {
      Start-Sleep -Milliseconds 100
    }
  }
})
$sigPS.BeginInvoke() | Out-Null

try {

# ── Form ──────────────────────────────────────────────────────────────────────
$form = New-Object System.Windows.Forms.Form
$form.Text = "Monitor Local Probe"
$form.StartPosition = "CenterScreen"
$form.Size = New-Object System.Drawing.Size(760, 560)
$form.MinimumSize = New-Object System.Drawing.Size(640, 460)
$form.Topmost = $true

# Status bar
$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Dock = "Top"
$statusLabel.Height = 28
$statusLabel.TextAlign = "MiddleLeft"
$statusLabel.Padding = New-Object System.Windows.Forms.Padding(10, 0, 10, 0)
$statusLabel.Text = "Status: idle"

# Main button panel
$buttonPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonPanel.Dock = "Top"
$buttonPanel.Height = 48
$buttonPanel.Padding = New-Object System.Windows.Forms.Padding(6)
$buttonPanel.FlowDirection = "LeftToRight"

$btnRunOnce      = New-Object System.Windows.Forms.Button
$btnRunOnce.Text  = "Run Once";  $btnRunOnce.Width = 96;  $btnRunOnce.Height = 32

$btnStart        = New-Object System.Windows.Forms.Button
$btnStart.Text    = "Start Loop"; $btnStart.Width = 96; $btnStart.Height = 32

$btnStop         = New-Object System.Windows.Forms.Button
$btnStop.Text     = "Stop";       $btnStop.Width = 80;  $btnStop.Height = 32
$btnStop.Enabled  = $false

$btnPortScan     = New-Object System.Windows.Forms.Button
$btnPortScan.Text = "Port Scan";  $btnPortScan.Width = 96; $btnPortScan.Height = 32

$btnSecurityScan      = New-Object System.Windows.Forms.Button
$btnSecurityScan.Text  = "Security Scan"; $btnSecurityScan.Width = 110; $btnSecurityScan.Height = 32

$btnClose        = New-Object System.Windows.Forms.Button
$btnClose.Text    = "Close";      $btnClose.Width = 80; $btnClose.Height = 32

$buttonPanel.Controls.AddRange(@($btnRunOnce, $btnStart, $btnStop, $btnPortScan, $btnSecurityScan, $btnClose))

# Port scan config row
$scanPanel = New-Object System.Windows.Forms.TableLayoutPanel
$scanPanel.Dock = "Top"
$scanPanel.Height = 38
$scanPanel.Padding = New-Object System.Windows.Forms.Padding(6, 4, 6, 0)
$scanPanel.ColumnCount = 6
$scanPanel.RowCount = 1
[void]$scanPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
[void]$scanPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 28)))
[void]$scanPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
[void]$scanPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 40)))
[void]$scanPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::AutoSize)))
[void]$scanPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 32)))

$lblDevice = New-Object System.Windows.Forms.Label; $lblDevice.Text = "Device:"; $lblDevice.Anchor = "Left"; $lblDevice.AutoSize = $true
$txtDevice = New-Object System.Windows.Forms.TextBox; $txtDevice.Text = $defaultDeviceName; $txtDevice.Dock = "Fill"
$lblHost   = New-Object System.Windows.Forms.Label; $lblHost.Text = "  Host:";   $lblHost.Anchor = "Left";   $lblHost.AutoSize = $true
$txtHost   = New-Object System.Windows.Forms.TextBox; $txtHost.Text = $defaultScanHost; $txtHost.Dock = "Fill"
$lblPorts  = New-Object System.Windows.Forms.Label; $lblPorts.Text = "  Ports:"; $lblPorts.Anchor = "Left";  $lblPorts.AutoSize = $true
$txtPorts  = New-Object System.Windows.Forms.TextBox; $txtPorts.Text = $defaultScanPorts; $txtPorts.Dock = "Fill"

$scanPanel.Controls.Add($lblDevice, 0, 0); $scanPanel.Controls.Add($txtDevice, 1, 0)
$scanPanel.Controls.Add($lblHost,   2, 0); $scanPanel.Controls.Add($txtHost,   3, 0)
$scanPanel.Controls.Add($lblPorts,  4, 0); $scanPanel.Controls.Add($txtPorts,  5, 0)

# Log box
$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true; $logBox.ReadOnly = $true
$logBox.ScrollBars = "Vertical"; $logBox.WordWrap = $false; $logBox.Dock = "Fill"
$logBox.Font = New-Object System.Drawing.Font("Consolas", 10)

$form.Controls.Add($logBox)
$form.Controls.Add($scanPanel)
$form.Controls.Add($buttonPanel)
$form.Controls.Add($statusLabel)

# ── Timers ────────────────────────────────────────────────────────────────────
$loopTimer         = New-Object System.Windows.Forms.Timer; $loopTimer.Interval = $loopIntervalSec * 1000
$pollTimer         = New-Object System.Windows.Forms.Timer; $pollTimer.Interval = 500
# signalTimer only reads cached state from background runspace - never blocks UI
$signalTimer       = New-Object System.Windows.Forms.Timer; $signalTimer.Interval = 1000

# ── State ─────────────────────────────────────────────────────────────────────
$script:isLoopEnabled               = $false
$script:isTaskRunning               = $false
$script:isProbeOnline               = $false
$script:lastStatusText              = "Status: idle"
$script:workerProcess               = $null
$script:activeTask                  = ""
$script:stdoutPath                  = ""
$script:stderrPath                  = ""
$script:stdoutOffset                = 0
$script:stderrOffset                = 0
$script:lastHandledProbeSignal      = ""
$script:lastHandledPortRequestId    = ""
$script:lastHandledSecurityScanId   = ""

# ── UI helpers ────────────────────────────────────────────────────────────────
function Append-Log {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return }
  $logBox.AppendText($Text + [Environment]::NewLine)
}

function Update-Buttons {
  $busy = $script:isTaskRunning
  $btnRunOnce.Enabled      = -not $busy
  $btnStart.Enabled        = (-not $busy) -and (-not $script:isLoopEnabled)
  $btnStop.Enabled         = $script:isLoopEnabled -or $busy
  $btnPortScan.Enabled     = -not $busy
  $btnSecurityScan.Enabled = -not $busy
}

function Update-Status {
  $statusLabel.Text = $script:lastStatusText
  Update-Buttons
}

# ── Temp file helpers ─────────────────────────────────────────────────────────
function Cleanup-TempFiles {
  foreach ($p in @($script:stdoutPath, $script:stderrPath)) {
    if ($p -and (Test-Path $p)) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
  }
  $script:stdoutPath = ""; $script:stderrPath = ""; $script:stdoutOffset = 0; $script:stderrOffset = 0
}

function Read-NewLogChunk {
  param([string]$Path, [int]$Offset)
  if (-not $Path -or -not (Test-Path $Path)) { return @{ Offset = $Offset; Text = "" } }
  try { $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop } catch { return @{ Offset = $Offset; Text = "" } }
  if ($null -eq $text) { $text = "" }
  if ($text.Length -le $Offset) { return @{ Offset = $text.Length; Text = "" } }
  return @{ Offset = $text.Length; Text = $text.Substring($Offset) }
}

function Flush-ProcessLogs {
  $o = Read-NewLogChunk -Path $script:stdoutPath -Offset $script:stdoutOffset
  $script:stdoutOffset = $o.Offset
  if ($o.Text) { foreach ($ln in ($o.Text -split "`r?`n")) { if ($ln) { Append-Log $ln } } }
  $e = Read-NewLogChunk -Path $script:stderrPath -Offset $script:stderrOffset
  $script:stderrOffset = $e.Offset
  if ($e.Text) { foreach ($ln in ($e.Text -split "`r?`n")) { if ($ln) { Append-Log $ln } } }
}

function Finish-Worker {
  param([string]$Reason = "")
  if ($pollTimer.Enabled) { $pollTimer.Stop() }
  Flush-ProcessLogs
  $exitCode = 0
  if ($script:workerProcess) {
    try { if ($script:workerProcess.HasExited) { $exitCode = $script:workerProcess.ExitCode } } catch { $exitCode = -1 }
    try { $script:workerProcess.Dispose() } catch {}
  }
  $completedTask = $script:activeTask
  $script:workerProcess = $null
  $script:isTaskRunning = $false
  if ($completedTask -eq "probe" -and $exitCode -eq 0) { $script:isProbeOnline = $true }
  $ec = if ([string]::IsNullOrWhiteSpace([string]$exitCode)) { "unknown" } else { [string]$exitCode }
  if ($Reason) {
    Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $Reason)
  } elseif (-not (($completedTask -eq "remote-portscan" -or $completedTask -eq "remote-securityscan") -and $exitCode -eq 3)) {
    $lbl = switch ($completedTask) {
      "probe"               { "Probe run" }
      "port-scan"           { "Port Scan" }
      "security-scan"       { "Security Scan" }
      "remote-portscan"     { "Remote Port Scan" }
      "remote-securityscan" { "Remote Security Scan" }
      default               { $completedTask }
    }
    Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $lbl + " finished, exit code " + $ec)
  }
  $script:lastStatusText = if ($script:isLoopEnabled) { "Status: waiting for next loop run" } `
    elseif ($script:isProbeOnline) { "Status: probe online" } else { "Status: idle" }
  $script:activeTask = ""
  Cleanup-TempFiles
  Update-Status
}

# 套用 worker 暫存的更新：worker 會把新版下載並驗證後存成 <exe>.new。
# 只有在沒有 worker 執行時（exe 未被占用）才換檔，避免邊跑邊覆蓋。
function Apply-StagedUpdate {
  $stagedPath = "$exePath.new"
  if (-not (Test-Path -LiteralPath $stagedPath)) { return }
  if ($script:isTaskRunning) { return }
  $backupPath = "$exePath.bak"
  try {
    if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $exePath)    { Move-Item -LiteralPath $exePath -Destination $backupPath -Force }
    Move-Item -LiteralPath $stagedPath -Destination $exePath -Force
    Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] 已套用 probe 更新（monitor-local-probe.exe）。")
  } catch {
    Append-Log ("[UPDATE] 套用更新失敗: " + $_.Exception.Message)
    try {
      if ((Test-Path -LiteralPath $backupPath) -and -not (Test-Path -LiteralPath $exePath)) {
        Move-Item -LiteralPath $backupPath -Destination $exePath -Force
      }
    } catch {}
  }
}

function Start-Worker {
  param([string]$TaskName, [string[]]$ArgumentList, [string]$StartMessage, [string]$RunningStatus)
  if ($script:isTaskRunning) { Append-Log "Another task is already in progress."; return $false }
  Apply-StagedUpdate
  $script:stdoutPath = [System.IO.Path]::GetTempFileName()
  $script:stderrPath = [System.IO.Path]::GetTempFileName()
  $script:stdoutOffset = 0; $script:stderrOffset = 0
  try {
    $script:activeTask    = $TaskName
    $script:workerProcess = Start-Process -FilePath $exePath `
      -ArgumentList $ArgumentList `
      -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $script:stdoutPath `
      -RedirectStandardError  $script:stderrPath
  } catch {
    Cleanup-TempFiles
    $script:activeTask = ""; $script:isTaskRunning = $false
    $script:lastStatusText = "Status: start failed"
    Append-Log ("Failed to start " + $TaskName + ": " + $_.Exception.Message)
    Update-Status; return $false
  }
  $script:isTaskRunning  = $true
  $script:lastStatusText = $RunningStatus
  Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $StartMessage)
  Update-Status
  if (-not $pollTimer.Enabled) { $pollTimer.Start() }
  return $true
}

# ── Task launchers ────────────────────────────────────────────────────────────
function Start-ProbeProcess {
  param([string]$ForceServiceId = "", [string]$TriggerLabel = "")
  $a = @("--run-once", "--no-result-window")
  if (Test-Path $cfgPath) { $a += @("--config", $cfgPath) }
  if (-not [string]::IsNullOrWhiteSpace($ForceServiceId)) { $a += @("--service-id", $ForceServiceId) }
  $lbl = if ([string]::IsNullOrWhiteSpace($TriggerLabel)) { "Probe started" } else { $TriggerLabel }
  [void](Start-Worker -TaskName "probe" -ArgumentList $a -StartMessage $lbl -RunningStatus "Status: running")
}

function Start-PortScanProcess {
  $devName  = $txtDevice.Text.Trim()
  $scanHost = $txtHost.Text.Trim()
  $ports    = $txtPorts.Text.Trim()
  if (-not $scanHost) { Append-Log "Port Scan: Host field is required."; return }
  if (-not $ports)    { $ports = "22,80,443,3389" }
  $a = @("--port-scan", "--no-result-window")
  if (Test-Path $cfgPath) { $a += @("--config", $cfgPath) }
  if ($devName) { $a += @("--device-name", $devName) }
  $a += @("--scan-host", $scanHost, "--scan-ports", $ports)
  [void](Start-Worker -TaskName "port-scan" -ArgumentList $a -StartMessage "Port Scan started ($scanHost)" -RunningStatus "Status: port scan running")
}

function Start-SecurityScanProcess {
  $a = @("--security-scan", "--no-result-window")
  if (Test-Path $cfgPath) { $a += @("--config", $cfgPath) }
  [void](Start-Worker -TaskName "security-scan" -ArgumentList $a -StartMessage "Security Scan started" -RunningStatus "Status: security scan running")
}

function Start-RequestedPortScanProcess {
  $a = @("--claim-port-scan-request", "--no-result-window")
  if (Test-Path $cfgPath) { $a += @("--config", $cfgPath) }
  [void](Start-Worker -TaskName "remote-portscan" -ArgumentList $a -StartMessage "Remote Port Scan started" -RunningStatus "Status: port scan running")
}

function Start-RequestedSecurityScanProcess {
  $a = @("--claim-security-scan-request", "--no-result-window")
  if (Test-Path $cfgPath) { $a += @("--config", $cfgPath) }
  [void](Start-Worker -TaskName "remote-securityscan" -ArgumentList $a -StartMessage "Remote Security Scan started" -RunningStatus "Status: security scan running")
}

function Test-RecentSignal {
  param([string]$RequestedAt, [int]$MaxAgeSeconds = 180)
  if ([string]::IsNullOrWhiteSpace($RequestedAt)) { return $false }
  try {
    $t = [datetime]::Parse($RequestedAt).ToUniversalTime()
    $age = ([datetime]::UtcNow - $t).TotalSeconds
    return $age -ge 0 -and $age -le $MaxAgeSeconds
  } catch { return $false }
}

# ── Timer events ──────────────────────────────────────────────────────────────
$pollTimer.Add_Tick({
  if (-not $script:workerProcess) { $pollTimer.Stop(); return }
  Flush-ProcessLogs
  try { if (-not $script:workerProcess.HasExited) { return } } catch { return }
  Finish-Worker
})

# Reads cached signal state from background runspace - no HTTP on UI thread
$signalTimer.Add_Tick({
  if ($script:isTaskRunning) { return }
  try {
    # Port scan signal
    $portSig = $script:sigState.PortSignal
    if ($portSig) {
      $rid   = [string]$portSig.request_id
      $stat  = [string]$portSig.status
      $reqAt = [string]$portSig.requested_at
      if ($rid -and $rid -ne $script:lastHandledPortRequestId -and
          [string]::Equals($stat, "pending", [System.StringComparison]::OrdinalIgnoreCase) -and
          (Test-RecentSignal -RequestedAt $reqAt)) {
        $script:lastHandledPortRequestId = $rid
        Start-RequestedPortScanProcess
        return
      }
    }
    # Security scan signal
    $secSig = $script:sigState.SecSignal
    if ($secSig) {
      $rid   = [string]$secSig.request_id
      $stat  = [string]$secSig.status
      $reqAt = [string]$secSig.requested_at
      if ($rid -and $rid -ne $script:lastHandledSecurityScanId -and
          [string]::Equals($stat, "pending", [System.StringComparison]::OrdinalIgnoreCase) -and
          (Test-RecentSignal -RequestedAt $reqAt)) {
        $script:lastHandledSecurityScanId = $rid
        Start-RequestedSecurityScanProcess
        return
      }
    }
    # Probe run signal
    $probeSig = $script:sigState.ProbeSignal
    if (-not $probeSig) { return }
    $reqAt = [string]$probeSig.requested_at
    if ([string]::IsNullOrWhiteSpace($reqAt)) { return }
    if ($reqAt -eq $script:lastHandledProbeSignal) { return }
    if (-not (Test-RecentSignal -RequestedAt $reqAt)) { return }
    $script:lastHandledProbeSignal = $reqAt
    $svcName = [string]$probeSig.service_name
    if ([string]::IsNullOrWhiteSpace($svcName)) { $svcName = "all services" }
    Start-ProbeProcess -ForceServiceId ([string]$probeSig.service_id) -TriggerLabel ("Remote refresh: " + $svcName)
  } catch {}
})

$loopTimer.Add_Tick({
  if (-not $script:isLoopEnabled) { return }
  if ($script:isTaskRunning) { return }
  Start-ProbeProcess
})

# ── Button events ─────────────────────────────────────────────────────────────
$btnRunOnce.Add_Click({ Start-ProbeProcess })

$btnStart.Add_Click({
  if ($script:isLoopEnabled) { return }
  $script:isLoopEnabled  = $true
  $script:lastStatusText = "Status: waiting for next loop run"
  Append-Log ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] Loop mode started")
  Update-Status
  $loopTimer.Start()
  if (-not $signalTimer.Enabled) { $signalTimer.Start() }
  if (-not $script:isTaskRunning) { Start-ProbeProcess }
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
    } catch { Append-Log ("Failed to stop: " + $_.Exception.Message) }
  }
  $script:lastStatusText = "Status: idle"
  Update-Status
})

$btnPortScan.Add_Click({ Start-PortScanProcess })

$btnSecurityScan.Add_Click({ Start-SecurityScanProcess })

$btnClose.Add_Click({
  $loopTimer.Stop(); $signalTimer.Stop()
  if ($script:isTaskRunning -and $script:workerProcess) {
    try { Stop-Process -Id $script:workerProcess.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
  Finish-Worker -Reason "Window closed"
  $form.Close()
})

$form.Add_FormClosing({
  try {
    $loopTimer.Stop(); $signalTimer.Stop()
    $script:sigState.Stop = $true
    if ($script:isTaskRunning -and $script:workerProcess) {
      Stop-Process -Id $script:workerProcess.Id -Force -ErrorAction SilentlyContinue
    }
  } catch {}
})

$form.Add_Shown({
  Append-Log "Probe control window ready."
  Append-Log "Run Once: single check  |  Start Loop: timed loop"
  Append-Log "Port Scan: fill Device/Host/Ports then click Port Scan"
  Append-Log "Security Scan: scans all monitored hosts"
  Append-Log "Admin-triggered scans polled every 5 sec in background."
  Append-Log ("Loop interval: " + $loopIntervalSec + " sec")
  $signalTimer.Start()
  Update-Status
})

[void]$form.ShowDialog()

} catch {
  $script:sigState.Stop = $true
  [System.Windows.Forms.MessageBox]::Show(
    "Startup error:`r`n" + $_.Exception.Message + "`r`n`r`n" + $_.ScriptStackTrace,
    "Monitor Local Probe - Error",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
}

# Cleanup background runspace
try { $script:sigState.Stop = $true; Start-Sleep -Milliseconds 300 } catch {}
try { $sigPS.Stop(); $sigPS.Dispose() } catch {}
try { $sigRunspace.Close(); $sigRunspace.Dispose() } catch {}
