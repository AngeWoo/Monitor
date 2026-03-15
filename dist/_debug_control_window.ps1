
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'local-KNIGHT Control'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(760, 560)
$form.MinimumSize = New-Object System.Drawing.Size(720, 520)
$form.Topmost = $true
$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Dock = 'Top'
$statusLabel.Height = 28
$statusLabel.TextAlign = 'MiddleLeft'
$statusLabel.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 0)
$statusLabel.Text = 'Status: idle'
$buttonPanel = New-Object System.Windows.Forms.FlowLayoutPanel
$buttonPanel.Dock = 'Top'
$buttonPanel.Height = 52
$buttonPanel.Padding = New-Object System.Windows.Forms.Padding(8)
$buttonPanel.FlowDirection = 'LeftToRight'
$btnRunOnce = New-Object System.Windows.Forms.Button
$btnRunOnce.Text = 'Run Once'
$btnRunOnce.Width = 100
$btnRunOnce.Height = 32
$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Text = 'Start Loop'
$btnStart.Width = 100
$btnStart.Height = 32
$btnStop = New-Object System.Windows.Forms.Button
$btnStop.Text = 'Stop'
$btnStop.Width = 100
$btnStop.Height = 32
$btnStop.Enabled = $false
$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = 'Close'
$btnClose.Width = 100
$btnClose.Height = 32
$scanPanel = New-Object System.Windows.Forms.Panel
$scanPanel.Dock = 'Top'
$scanPanel.Height = 106
$scanPanel.Padding = New-Object System.Windows.Forms.Padding(10, 6, 10, 6)
$scanTitle = New-Object System.Windows.Forms.Label
$scanTitle.Text = 'Port Scan'
$scanTitle.Location = New-Object System.Drawing.Point(4, 4)
$scanTitle.AutoSize = $true
$scanHint = New-Object System.Windows.Forms.Label
$scanHint.Text = 'Port Scan becomes available after this probe reports online.'
$scanHint.Location = New-Object System.Drawing.Point(84, 5)
$scanHint.AutoSize = $true
$deviceLabel = New-Object System.Windows.Forms.Label
$deviceLabel.Text = 'Device'
$deviceLabel.Location = New-Object System.Drawing.Point(4, 34)
$deviceLabel.AutoSize = $true
$txtDevice = New-Object System.Windows.Forms.TextBox
$txtDevice.Location = New-Object System.Drawing.Point(64, 30)
$txtDevice.Size = New-Object System.Drawing.Size(180, 24)
$txtDevice.Text = 'KNIGHT'
$hostLabel = New-Object System.Windows.Forms.Label
$hostLabel.Text = 'Host'
$hostLabel.Location = New-Object System.Drawing.Point(258, 34)
$hostLabel.AutoSize = $true
$txtHost = New-Object System.Windows.Forms.TextBox
$txtHost.Location = New-Object System.Drawing.Point(304, 30)
$txtHost.Size = New-Object System.Drawing.Size(180, 24)
$portsLabel = New-Object System.Windows.Forms.Label
$portsLabel.Text = 'Ports'
$portsLabel.Location = New-Object System.Drawing.Point(498, 34)
$portsLabel.AutoSize = $true
$txtPorts = New-Object System.Windows.Forms.TextBox
$txtPorts.Location = New-Object System.Drawing.Point(542, 30)
$txtPorts.Size = New-Object System.Drawing.Size(180, 24)
$txtPorts.Text = '22,80,443,3389'
$scanNote = New-Object System.Windows.Forms.Label
$scanNote.Text = 'Use comma-separated ports or ranges, e.g. 80,443,8080-8082'
$scanNote.Location = New-Object System.Drawing.Point(4, 66)
$scanNote.AutoSize = $true
$btnPortScan = New-Object System.Windows.Forms.Button
$btnPortScan.Text = 'Scan Ports'
$btnPortScan.Location = New-Object System.Drawing.Point(622, 62)
$btnPortScan.Size = New-Object System.Drawing.Size(100, 30)
$btnPortScan.Enabled = $false
$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = 'Vertical'
$logBox.WordWrap = $false
$logBox.Dock = 'Fill'
$logBox.Font = New-Object System.Drawing.Font('Consolas', 10)
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
$form.Controls.Add($logBox)
$form.Controls.Add($scanPanel)
$form.Controls.Add($buttonPanel)
$form.Controls.Add($statusLabel)
$intervalTimer = New-Object System.Windows.Forms.Timer
$intervalTimer.Interval = 60000
$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 700
$script:isLoopRunning = $false
$script:isProbeRunning = $false
$script:isPortScanRunning = $false
$script:isProbeOnline = $false
$script:probeProcess = $null
$script:scanProcess = $null
function Append-Log([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return }
  $logBox.AppendText($text + [Environment]::NewLine)
}
function Quote-Arg([string]$value) {
  if ($null -eq $value) { $value = '' }
  return '"' + ($value -replace '"', '\"') + '"'
}
function Update-PortScanState() {
  $btnPortScan.Enabled = $script:isProbeOnline -and -not $script:isProbeRunning -and -not $script:isPortScanRunning -and -not $script:isLoopRunning
}
function Update-Status() {
  if ($script:isPortScanRunning) {
    $statusLabel.Text = 'Status: port scan running'
  } elseif ($script:isProbeRunning -and $script:isLoopRunning) {
    $statusLabel.Text = 'Status: running (loop enabled)'
  } elseif ($script:isProbeRunning) {
    $statusLabel.Text = 'Status: running'
  } elseif ($script:isLoopRunning) {
    $statusLabel.Text = 'Status: waiting for next loop run'
  } else {
    $statusLabel.Text = 'Status: idle'
  }
  if ($script:isProbeOnline) {
    $statusLabel.Text += ' | Probe online'
  } else {
    $statusLabel.Text += ' | Probe offline'
  }
  Update-PortScanState
}
function Start-ProbeRun() {
  if ($script:isProbeRunning -or $script:isPortScanRunning) {
    Append-Log('Probe run already in progress.')
    return
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'D:\Program Files\nodejs\node.exe'
  $psi.Arguments = '"D:\nginx2026\html\Monitor\local-probe.js" "--run-once" "--no-result-window"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $script:probeProcess = New-Object System.Diagnostics.Process
  $script:probeProcess.StartInfo = $psi
  $script:probeProcess.add_OutputDataReceived({
    param($sender, $args)
    if ($args.Data) { $form.BeginInvoke([Action[string]]{ param($line) Append-Log($line) }, $args.Data) | Out-Null }
  })
  $script:probeProcess.add_ErrorDataReceived({
    param($sender, $args)
    if ($args.Data) { $form.BeginInvoke([Action[string]]{ param($line) Append-Log($line) }, $args.Data) | Out-Null }
  })
  [void]$script:probeProcess.Start()
  $script:probeProcess.BeginOutputReadLine()
  $script:probeProcess.BeginErrorReadLine()
  $script:isProbeRunning = $true
  $btnRunOnce.Enabled = $false
  $btnStart.Enabled = $false
  $btnStop.Enabled = $script:isLoopRunning
  Append-Log(('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] Probe started'))
  Update-Status
  $pollTimer.Start()
}
function Start-PortScan() {
  if (-not $script:isProbeOnline) {
    Append-Log('Port Scan requires probe online status. Run the probe once first.')
    return
  }
  if ($script:isProbeRunning -or $script:isPortScanRunning) {
    Append-Log('Another probe task is already in progress.')
    return
  }
  $scanHost = [string]$txtHost.Text
  $scanPorts = [string]$txtPorts.Text
  $deviceName = [string]$txtDevice.Text
  if ([string]::IsNullOrWhiteSpace($scanHost)) {
    Append-Log('Port Scan host is required.')
    return
  }
  if ([string]::IsNullOrWhiteSpace($scanPorts)) {
    Append-Log('Port Scan ports are required.')
    return
  }
  if ([string]::IsNullOrWhiteSpace($deviceName)) {
    $deviceName = $scanHost
    $txtDevice.Text = $deviceName
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'D:\Program Files\nodejs\node.exe'
  $psi.Arguments = '"D:\nginx2026\html\Monitor\local-probe.js" "--port-scan" "--no-result-window"' + ' --device-name ' + (Quote-Arg $deviceName) + ' --scan-host ' + (Quote-Arg $scanHost) + ' --scan-ports ' + (Quote-Arg $scanPorts)
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $script:scanProcess = New-Object System.Diagnostics.Process
  $script:scanProcess.StartInfo = $psi
  $script:scanProcess.add_OutputDataReceived({
    param($sender, $args)
    if ($args.Data) { $form.BeginInvoke([Action[string]]{ param($line) Append-Log($line) }, $args.Data) | Out-Null }
  })
  $script:scanProcess.add_ErrorDataReceived({
    param($sender, $args)
    if ($args.Data) { $form.BeginInvoke([Action[string]]{ param($line) Append-Log($line) }, $args.Data) | Out-Null }
  })
  [void]$script:scanProcess.Start()
  $script:scanProcess.BeginOutputReadLine()
  $script:scanProcess.BeginErrorReadLine()
  $script:isPortScanRunning = $true
  $btnRunOnce.Enabled = $false
  $btnStart.Enabled = $false
  $btnStop.Enabled = $false
  Append-Log(('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] Port Scan started for ' + $deviceName + ' (' + $scanHost + ')'))
  Update-Status
  $pollTimer.Start()
}
$pollTimer.Add_Tick({
  $hasActiveProcess = $false
  if ($script:isProbeRunning -and $script:probeProcess) {
    if (-not $script:probeProcess.HasExited) {
      $hasActiveProcess = $true
    } else {
      $exitCode = $script:probeProcess.ExitCode
      $script:probeProcess.Dispose()
      $script:probeProcess = $null
      $script:isProbeRunning = $false
      $script:isProbeOnline = ($exitCode -eq 0)
      $btnRunOnce.Enabled = $true
      $btnStart.Enabled = -not $script:isLoopRunning
      $btnStop.Enabled = $script:isLoopRunning
      Append-Log(('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] Probe finished, exit code ' + $exitCode))
      Update-Status
    }
  }
  if ($script:isPortScanRunning -and $script:scanProcess) {
    if (-not $script:scanProcess.HasExited) {
      $hasActiveProcess = $true
    } else {
      $exitCode = $script:scanProcess.ExitCode
      $script:scanProcess.Dispose()
      $script:scanProcess = $null
      $script:isPortScanRunning = $false
      if ($exitCode -eq 0) { $script:isProbeOnline = $true }
      $btnRunOnce.Enabled = $true
      $btnStart.Enabled = -not $script:isLoopRunning
      $btnStop.Enabled = $script:isLoopRunning
      Append-Log(('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] Port Scan finished, exit code ' + $exitCode))
      Update-Status
    }
  }
  if (-not $hasActiveProcess -and -not $script:isProbeRunning -and -not $script:isPortScanRunning) {
    $pollTimer.Stop()
  }
})
$intervalTimer.Add_Tick({
  if (-not $script:isLoopRunning) { return }
  if ($script:isProbeRunning) { return }
  Start-ProbeRun
})
$btnRunOnce.Add_Click({ Start-ProbeRun })
$btnStart.Add_Click({
  if ($script:isLoopRunning) { return }
  $script:isLoopRunning = $true
  $intervalTimer.Start()
  $btnStart.Enabled = $false
  $btnStop.Enabled = $true
  Append-Log(('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] Loop mode started'))
  Update-Status
  if (-not $script:isProbeRunning) { Start-ProbeRun }
})
$btnStop.Add_Click({
  $script:isLoopRunning = $false
  $intervalTimer.Stop()
  $btnStart.Enabled = -not $script:isProbeRunning
  $btnStop.Enabled = $false
  Append-Log(('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] Loop mode stopped'))
  Update-Status
})
$btnPortScan.Add_Click({ Start-PortScan })
$btnClose.Add_Click({
  $intervalTimer.Stop()
  $pollTimer.Stop()
  if ($script:probeProcess -and -not $script:probeProcess.HasExited) {
    try { $script:probeProcess.Kill() } catch {}
  }
  if ($script:scanProcess -and -not $script:scanProcess.HasExited) {
    try { $script:scanProcess.Kill() } catch {}
  }
  $form.Close()
})
$form.Add_Shown({
  Append-Log('Control window ready.')
  Append-Log('Use Run Once for a single check, or Start Loop for repeated runs.')
  Append-Log('Port Scan is enabled after the probe finishes one successful check.')
  Update-Status
})
[void]$form.ShowDialog()
