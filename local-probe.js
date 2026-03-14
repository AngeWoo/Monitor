const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PROBE_SCRIPT_VERSION = "20260314-a001";
const DEFAULT_API_BASE = "https://script.google.com/macros/s/AKfycbxPm5VWcnXe5b2u6oi1gqLIBCjK6raQtI-4ya1Gd1umDUEYhBGSOHpq9XBS9zZ7iBCq/exec";
const DEFAULT_API_REDIRECTS = 5;
const DEFAULT_CONTROL_INTERVAL_SEC = 60;

function parseCliArgs(argv) {
  const parsed = {
    configPath: "",
    controlMode: false,
    runOnceMode: false,
    noResultWindow: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "").trim();
    if (!arg) continue;
    if (arg === "--control") {
      parsed.controlMode = true;
      continue;
    }
    if (arg === "--run-once") {
      parsed.runOnceMode = true;
      continue;
    }
    if (arg === "--no-result-window") {
      parsed.noResultWindow = true;
      continue;
    }
    if (arg === "--config" && argv[i + 1]) {
      parsed.configPath = path.resolve(String(argv[i + 1]));
      i += 1;
      continue;
    }
    if (!arg.startsWith("--") && !parsed.configPath) {
      parsed.configPath = path.resolve(arg);
    }
  }

  return parsed;
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  return String(value || "").trim().toLowerCase() === "true";
}

function toNum(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

function getRuntimeBaseDir() {
  return process.pkg ? path.dirname(process.execPath) : __dirname;
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read config: ${filePath} (${error.message})`);
  }
}

function loadRuntimeConfig() {
  const baseDir = getRuntimeBaseDir();
  const cli = parseCliArgs(process.argv.slice(2));
  const argvConfigPath = cli.configPath || "";
  const defaultConfigPath = path.join(baseDir, "probe-config.json");
  const fileConfig = argvConfigPath
    ? readJsonIfExists(argvConfigPath)
    : readJsonIfExists(defaultConfigPath);
  const hasShowWindowConfig = Object.prototype.hasOwnProperty.call(fileConfig, "show_result_window");
  const hasShowWindowOnErrorOnlyConfig = Object.prototype.hasOwnProperty.call(fileConfig, "show_result_window_on_error_only");
  const hasControlWindowConfig = Object.prototype.hasOwnProperty.call(fileConfig, "show_control_window");

  const probeId = process.env.MONITOR_PROBE_ID || fileConfig.probe_id || `local-${os.hostname()}`;
  const probeName = process.env.MONITOR_PROBE_NAME || fileConfig.probe_name || probeId;
  const apiBase = process.env.MONITOR_API_BASE || fileConfig.api_base || DEFAULT_API_BASE;
  const requestTimeoutMs = Math.max(1000, Number(process.env.MONITOR_REQUEST_TIMEOUT_MS || fileConfig.request_timeout_ms || 15000));
  const userAgent = process.env.MONITOR_USER_AGENT || fileConfig.user_agent || `MonitorLocalProbe/1.0 (${probeId})`;
  const showResultWindow = cli.noResultWindow
    ? false
    : toBool(
      process.env.MONITOR_SHOW_RESULT_WINDOW !== undefined
        ? process.env.MONITOR_SHOW_RESULT_WINDOW
        : hasShowWindowConfig
          ? fileConfig.show_result_window
          : !!process.pkg
    );
  const showResultWindowOnErrorOnly = toBool(
    process.env.MONITOR_SHOW_RESULT_WINDOW_ON_ERROR_ONLY !== undefined
      ? process.env.MONITOR_SHOW_RESULT_WINDOW_ON_ERROR_ONLY
      : hasShowWindowOnErrorOnlyConfig
        ? fileConfig.show_result_window_on_error_only
        : true
  );
  const showControlWindow = process.env.MONITOR_SHOW_CONTROL_WINDOW !== undefined
    ? toBool(process.env.MONITOR_SHOW_CONTROL_WINDOW)
    : cli.controlMode || (hasControlWindowConfig ? toBool(fileConfig.show_control_window) : !!process.pkg);
  const controlWindowIntervalSec = Math.max(
    10,
    toNum(
      process.env.MONITOR_CONTROL_WINDOW_INTERVAL_SEC !== undefined
        ? process.env.MONITOR_CONTROL_WINDOW_INTERVAL_SEC
        : fileConfig.control_window_interval_sec,
      DEFAULT_CONTROL_INTERVAL_SEC
    )
  );

  return {
    cli,
    baseDir,
    configPath: argvConfigPath || defaultConfigPath,
    probeId,
    probeName,
    apiBase,
    requestTimeoutMs,
    userAgent,
    showResultWindow,
    showResultWindowOnErrorOnly,
    showControlWindow,
    controlWindowIntervalSec,
    appVersion: String(process.env.MONITOR_APP_VERSION || fileConfig.app_version || "").trim(),
    metadata: {
      probe_id: probeId,
      probe_name: probeName,
      host_name: process.env.MONITOR_HOST_NAME || fileConfig.host_name || os.hostname(),
      host_user: process.env.USERNAME || process.env.USER || fileConfig.host_user || "",
      platform: fileConfig.platform || process.platform,
      platform_release: fileConfig.platform_release || os.release(),
      app_version: String(process.env.MONITOR_APP_VERSION || fileConfig.app_version || "").trim(),
      probe_version: PROBE_SCRIPT_VERSION,
      api_base: apiBase
    }
  };
}

const RUNTIME = loadRuntimeConfig();

function defaultServiceConfig() {
  return {
    check_type: "status_code",
    expected_keyword: "",
    forbidden_keyword: "",
    expected_final_url: "",
    secondary_url: "",
    allow_redirects: true,
    max_redirects: 5,
    latency_warn_ms: 5000,
    fail_threshold: 2,
    retry_count: 2,
    retry_delay_ms: 1200,
    consecutive_failures: 0
  };
}

function normalizeServiceConfig(service) {
  const merged = { ...defaultServiceConfig(), ...(service || {}) };
  return {
    check_type: String(merged.check_type || "status_code").trim().toLowerCase() === "keyword" ? "keyword" : "status_code",
    expected_keyword: String(merged.expected_keyword || "").trim(),
    forbidden_keyword: String(merged.forbidden_keyword || "").trim(),
    expected_final_url: String(merged.expected_final_url || "").trim(),
    secondary_url: String(merged.secondary_url || "").trim(),
    allow_redirects: toBool(merged.allow_redirects),
    max_redirects: Math.max(0, Math.min(10, toNum(merged.max_redirects, 5))),
    latency_warn_ms: Math.max(0, toNum(merged.latency_warn_ms, 5000)),
    fail_threshold: Math.max(1, toNum(merged.fail_threshold, 2)),
    retry_count: Math.max(1, Math.min(5, toNum(merged.retry_count, 2))),
    retry_delay_ms: Math.max(0, Math.min(10000, toNum(merged.retry_delay_ms, 1200))),
    consecutive_failures: Math.max(0, toNum(merged.consecutive_failures, 0))
  };
}

async function apiGet(params) {
  const url = new URL(RUNTIME.apiBase);
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    url.searchParams.set(key, String(value));
  });
  return requestJson(url.toString(), {
    method: "GET",
    headers: { "User-Agent": RUNTIME.userAgent }
  });
}

async function apiPost(payload) {
  return requestJson(RUNTIME.apiBase, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": RUNTIME.userAgent
    },
    body: JSON.stringify(payload)
  });
}

async function upsertProbe(payload) {
  const response = await apiPost({
    action: "upsertProbe",
    ...RUNTIME.metadata,
    ...payload
  });
  if (!response.ok) {
    throw new Error(response.error || "upsertProbe failed");
  }
  return response;
}

function classifyFetchError(error) {
  const text = String(error || "");
  if (/timed out|timeout|aborted|deadline/i.test(text)) return "TIMEOUT";
  if (/dns|resolve|host/i.test(text)) return "DNS_ERROR";
  if (/ssl|tls|certificate|handshake/i.test(text)) return "TLS_ERROR";
  if (/refused|reset|connect|socket|network|unreachable/i.test(text)) return "NETWORK_ERROR";
  return "FETCH_ERROR";
}

function classifyHttpFailure(code, bodyText) {
  const body = String(bodyText || "");
  if (code === 401) return "";
  if (code === 403 && /access denied|forbidden|captcha|cloudflare|just a moment/i.test(body)) return "BLOCKED";
  if (code === 403) return "";
  if (code === 429) return "RATE_LIMIT";
  if (code >= 500) return "HTTP_5XX";
  if (code >= 400) return "HTTP_4XX";
  return "";
}

async function fetchWithRedirectTrace(url, config) {
  let currentUrl = url;
  let redirects = 0;

  while (true) {
    const response = await requestText(currentUrl, {
      method: "GET",
      headers: { "User-Agent": RUNTIME.userAgent }
    });
    const location = String(response.headers.location || "").trim();
    const isRedirect = response.statusCode >= 300 && response.statusCode < 400 && !!location;
    if (!isRedirect) {
      return { response, finalUrl: currentUrl, redirects, exceeded: false };
    }
    if (!config.allow_redirects) {
      return { response, finalUrl: currentUrl, redirects, exceeded: false };
    }
    if (redirects >= config.max_redirects) {
      return { response, finalUrl: currentUrl, redirects, exceeded: true };
    }

    currentUrl = String(new URL(location, currentUrl));
    redirects += 1;
  }
}

async function runSingleCheckAttempt(url, config) {
  const start = Date.now();

  try {
    const trace = await fetchWithRedirectTrace(url, config);
    const response = trace.response;
    const code = Number(response.statusCode || 0);
    const latency = Date.now() - start;
    const finalUrl = String(trace.finalUrl || url).trim();
    const bodyText = String(response.bodyText || "");

    if (trace.exceeded) {
      return {
        ok: false,
        status: "DOWN",
        httpCode: code,
        latencyMs: latency,
        errorType: "REDIRECT_ERROR",
        error: `Redirects exceeded limit ${config.max_redirects}`,
        finalUrl,
        observedUrl: url
      };
    }

    if (!config.allow_redirects && code >= 300 && code < 400) {
      return {
        ok: false,
        status: "DOWN",
        httpCode: code,
        latencyMs: latency,
        errorType: "REDIRECT_ERROR",
        error: `Unexpected redirect from ${url}`,
        finalUrl,
        observedUrl: url
      };
    }

    const httpErrorType = classifyHttpFailure(code, bodyText);
    const isHttpOk = (code >= 200 && code < 400) || code === 401 || code === 403;

    if (httpErrorType === "BLOCKED") {
      return {
        ok: false,
        status: "DOWN",
        httpCode: code,
        latencyMs: latency,
        errorType: "BLOCKED",
        error: `Request blocked with HTTP ${code}`,
        finalUrl: finalUrl || url,
        observedUrl: url
      };
    }

    if (!isHttpOk) {
      return {
        ok: false,
        status: "DOWN",
        httpCode: code,
        latencyMs: latency,
        errorType: httpErrorType || "HTTP_ERROR",
        error: `HTTP ${code}`,
        finalUrl: finalUrl || url,
        observedUrl: url
      };
    }

    if (config.expected_final_url) {
      const actual = finalUrl || url;
      if (actual !== config.expected_final_url) {
        return {
          ok: false,
          status: "DOWN",
          httpCode: code,
          latencyMs: latency,
          errorType: "REDIRECT_ERROR",
          error: `Final URL mismatch: ${actual}`,
          finalUrl: actual,
          observedUrl: url
        };
      }
    }

    if (config.check_type === "keyword") {
      if (config.expected_keyword && !bodyText.includes(config.expected_keyword)) {
        return {
          ok: false,
          status: "DOWN",
          httpCode: code,
          latencyMs: latency,
          errorType: "CONTENT_MISMATCH",
          error: `Missing keyword: ${config.expected_keyword}`,
          finalUrl: finalUrl || url,
          observedUrl: url
        };
      }
      if (config.forbidden_keyword && bodyText.includes(config.forbidden_keyword)) {
        return {
          ok: false,
          status: "DOWN",
          httpCode: code,
          latencyMs: latency,
          errorType: "CONTENT_MISMATCH",
          error: `Forbidden keyword found: ${config.forbidden_keyword}`,
          finalUrl: finalUrl || url,
          observedUrl: url
        };
      }
    }

    if (config.latency_warn_ms > 0 && latency > config.latency_warn_ms) {
      return {
        ok: true,
        status: "SLOW",
        httpCode: code,
        latencyMs: latency,
        errorType: "SLOW",
        error: `Latency ${latency} ms exceeded ${config.latency_warn_ms} ms`,
        finalUrl: finalUrl || url,
        observedUrl: url
      };
    }

    return {
      ok: true,
      status: "UP",
      httpCode: code,
      latencyMs: latency,
      errorType: "",
      error: "",
      finalUrl: finalUrl || url,
      observedUrl: url
    };
  } catch (error) {
    return {
      ok: false,
      status: "DOWN",
      httpCode: 0,
      latencyMs: Date.now() - start,
      errorType: classifyFetchError(error),
      error: String(error && error.message ? error.message : error),
      finalUrl: "",
      observedUrl: url
    };
  }
}

function requestText(urlString, options) {
  const opts = options || {};
  const target = new URL(urlString);
  const client = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: opts.method || "GET",
      headers: opts.headers || {}
    }, (res) => {
      let bodyText = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        bodyText += chunk;
      });
      res.on("end", () => {
        resolve({
          statusCode: Number(res.statusCode || 0),
          headers: res.headers || {},
          bodyText
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(RUNTIME.requestTimeoutMs, () => {
      req.destroy(new Error(`timeout after ${RUNTIME.requestTimeoutMs} ms`));
    });

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

async function requestJson(urlString, options) {
  const response = await requestTextFollowRedirects(urlString, options, DEFAULT_API_REDIRECTS);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`API request failed: ${response.statusCode}`);
  }
  try {
    return JSON.parse(response.bodyText || "{}");
  } catch (error) {
    throw new Error(`Invalid JSON response: ${error.message}`);
  }
}

async function requestTextFollowRedirects(urlString, options, maxRedirects) {
  const redirectLimit = Math.max(0, toNum(maxRedirects, DEFAULT_API_REDIRECTS));
  const baseOptions = { ...(options || {}) };
  let currentUrl = String(urlString || "");
  let currentMethod = String(baseOptions.method || "GET").toUpperCase();
  let currentBody = baseOptions.body;
  let currentHeaders = { ...(baseOptions.headers || {}) };

  for (let redirects = 0; redirects <= redirectLimit; redirects += 1) {
    const response = await requestText(currentUrl, {
      ...baseOptions,
      method: currentMethod,
      headers: currentHeaders,
      body: currentBody
    });
    const location = String(response.headers.location || "").trim();
    const isRedirect = response.statusCode >= 300 && response.statusCode < 400 && !!location;
    if (!isRedirect) {
      return response;
    }
    if (redirects >= redirectLimit) {
      throw new Error(`API redirect exceeded limit ${redirectLimit}`);
    }

    currentUrl = String(new URL(location, currentUrl));
    if (response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && currentMethod !== "GET" && currentMethod !== "HEAD")) {
      currentMethod = "GET";
      currentBody = undefined;
      delete currentHeaders["Content-Length"];
      delete currentHeaders["content-length"];
      delete currentHeaders["Content-Type"];
      delete currentHeaders["content-type"];
    }
  }

  throw new Error(`API redirect exceeded limit ${redirectLimit}`);
}

function summarizeSampleResults(results) {
  return results.map((item, index) => {
    const part = `#${index + 1} ${item.observedUrl} => ${item.status} HTTP ${item.httpCode || 0}`;
    return item.error ? `${part} (${item.error})` : part;
  }).join(" | ");
}

function countByStatus(results) {
  return results.reduce((acc, item) => {
    const key = String(item.status || "UNKNOWN").toUpperCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildRunSummaryText(payload) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const counts = countByStatus(results);
  const lines = [
    `Probe: ${payload.probeName || payload.probeId || "-"}`,
    `Probe ID: ${payload.probeId || "-"}`,
    `開始時間: ${payload.startedAt || "-"}`,
    `結束時間: ${payload.finishedAt || "-"}`,
    `執行狀態: ${payload.runStatus || "-"}`,
    `服務數量: ${results.length}`,
    `UP: ${counts.UP || 0} | SLOW: ${counts.SLOW || 0} | UNSTABLE: ${counts.UNSTABLE || 0} | DOWN: ${counts.DOWN || 0}`,
    ""
  ];

  if (payload.errorMessage) {
    lines.push(`錯誤: ${payload.errorMessage}`);
    lines.push("");
  }

  lines.push("檢查結果:");
  if (!results.length) {
    lines.push("- 無資料");
  } else {
    results.forEach((item) => {
      const extra = item.error ? ` | ${item.error}` : "";
      lines.push(`- ${item.service} | ${item.status} | HTTP ${item.httpCode}${extra}`);
    });
  }

  return lines.join("\r\n");
}

function showWindowsResultWindow(title, bodyText) {
  const safeTitle = String(title || "Monitor Local Probe").replace(/'/g, "''");
  const safeBody = String(bodyText || "").replace(/\r/g, "");
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = '${safeTitle}'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(860, 560)
$form.MinimumSize = New-Object System.Drawing.Size(640, 420)
$form.Topmost = $true
$textbox = New-Object System.Windows.Forms.TextBox
$textbox.Multiline = $true
$textbox.ReadOnly = $true
$textbox.ScrollBars = 'Vertical'
$textbox.WordWrap = $false
$textbox.Dock = 'Fill'
$textbox.Font = New-Object System.Drawing.Font('Consolas', 10)
$textbox.Text = @'
${safeBody}
'@
$button = New-Object System.Windows.Forms.Button
$button.Text = '關閉'
$button.Dock = 'Bottom'
$button.Height = 42
$button.Add_Click({ $form.Close() })
$form.Controls.Add($textbox)
$form.Controls.Add($button)
[void]$form.ShowDialog()
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    stdio: "ignore",
    windowsHide: false
  });
}

function maybeShowRunSummaryWindow(payload) {
  if (!RUNTIME.showResultWindow) return;
  const results = Array.isArray(payload.results) ? payload.results : [];
  const hasIssue = results.some((item) => String(item.status || "").toUpperCase() === "DOWN");
  const shouldShow = !RUNTIME.showResultWindowOnErrorOnly || hasIssue || payload.runStatus !== "OK" || !!payload.errorMessage;
  if (!shouldShow) return;

  try {
    const title = payload.runStatus === "OK" ? "Monitor Local Probe 結果" : "Monitor Local Probe 錯誤";
    showWindowsResultWindow(title, buildRunSummaryText(payload));
  } catch (error) {
    console.error(`show result window failed: ${error.message}`);
  }
}

function buildControlWindowCommand() {
  const childFile = process.pkg ? process.execPath : process.execPath;
  const childArgs = process.pkg
    ? ["--run-once", "--no-result-window"]
    : [path.resolve(__filename), "--run-once", "--no-result-window"];

  if (RUNTIME.configPath && fs.existsSync(RUNTIME.configPath)) {
    childArgs.push("--config", RUNTIME.configPath);
  }

  const launchArgs = childArgs.map((item) => `"${String(item).replace(/"/g, '\\"')}"`).join(" ");
  const title = `${RUNTIME.probeName} Control`;
  const intervalMs = Math.max(10000, RUNTIME.controlWindowIntervalSec * 1000);
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = '${String(title).replace(/'/g, "''")}'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(560, 420)
$form.MinimumSize = New-Object System.Drawing.Size(520, 360)
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
$form.Controls.Add($logBox)
$form.Controls.Add($buttonPanel)
$form.Controls.Add($statusLabel)
$intervalTimer = New-Object System.Windows.Forms.Timer
$intervalTimer.Interval = ${intervalMs}
$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 700
$script:isLoopRunning = $false
$script:isProbeRunning = $false
$script:probeProcess = $null
function Append-Log([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return }
  $logBox.AppendText($text + [Environment]::NewLine)
}
function Update-Status() {
  if ($script:isProbeRunning -and $script:isLoopRunning) {
    $statusLabel.Text = 'Status: running (loop enabled)'
  } elseif ($script:isProbeRunning) {
    $statusLabel.Text = 'Status: running'
  } elseif ($script:isLoopRunning) {
    $statusLabel.Text = 'Status: waiting for next loop run'
  } else {
    $statusLabel.Text = 'Status: idle'
  }
}
function Start-ProbeRun() {
  if ($script:isProbeRunning) {
    Append-Log('Probe run already in progress.')
    return
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = '${String(childFile).replace(/'/g, "''")}'
  $psi.Arguments = '${launchArgs.replace(/'/g, "''")}'
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
$pollTimer.Add_Tick({
  if (-not $script:isProbeRunning -or -not $script:probeProcess) { return }
  if (-not $script:probeProcess.HasExited) { return }
  $pollTimer.Stop()
  $exitCode = $script:probeProcess.ExitCode
  $script:probeProcess.Dispose()
  $script:probeProcess = $null
  $script:isProbeRunning = $false
  $btnRunOnce.Enabled = $true
  $btnStart.Enabled = -not $script:isLoopRunning
  $btnStop.Enabled = $script:isLoopRunning
  Append-Log(('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] Probe finished, exit code ' + $exitCode))
  Update-Status
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
$btnClose.Add_Click({
  $intervalTimer.Stop()
  $pollTimer.Stop()
  if ($script:probeProcess -and -not $script:probeProcess.HasExited) {
    try { $script:probeProcess.Kill() } catch {}
  }
  $form.Close()
})
$form.Add_Shown({
  Append-Log('Control window ready.')
  Append-Log('Use Run Once for a single check, or Start Loop for repeated runs.')
  Update-Status
})
[void]$form.ShowDialog()
`;
}

function showWindowsControlWindow() {
  if (process.platform !== "win32") {
    throw new Error("Control window is only supported on Windows");
  }
  const encoded = Buffer.from(buildControlWindowCommand(), "utf16le").toString("base64");
  spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    stdio: "ignore",
    windowsHide: false
  });
}

async function runServiceProbe(service) {
  const config = normalizeServiceConfig(service);
  const urls = [String(service.url || "").trim()];
  if (config.secondary_url) urls.push(config.secondary_url);

  const sampleResults = [];
  for (const targetUrl of urls) {
    for (let attempt = 0; attempt < config.retry_count; attempt += 1) {
      sampleResults.push(await runSingleCheckAttempt(targetUrl, config));
      if (attempt < config.retry_count - 1) {
        await sleep(config.retry_delay_ms);
      }
    }
  }

  const successResults = sampleResults.filter((item) => item.ok);
  const failResults = sampleResults.filter((item) => !item.ok);
  const hasSlow = successResults.some((item) => item.status === "SLOW");
  const allFailed = sampleResults.length > 0 && failResults.length === sampleResults.length;
  const hadMixedResults = successResults.length > 0 && failResults.length > 0;
  const previousFailStreak = Math.max(0, toNum(service.consecutive_failures, 0));
  const nextFailStreak = allFailed ? previousFailStreak + 1 : 0;
  const representativeFailure = failResults[failResults.length - 1] || null;
  const representativeSuccess = successResults[successResults.length - 1] || null;
  const sampleSummary = summarizeSampleResults(sampleResults);

  if (hadMixedResults) {
    return {
      status: "UNSTABLE",
      httpCode: representativeFailure ? representativeFailure.httpCode : (representativeSuccess ? representativeSuccess.httpCode : 0),
      latencyMs: representativeSuccess ? representativeSuccess.latencyMs : (representativeFailure ? representativeFailure.latencyMs : 0),
      errorType: "UNSTABLE",
      error: sampleSummary,
      finalUrl: representativeSuccess ? representativeSuccess.finalUrl : (representativeFailure ? representativeFailure.finalUrl : ""),
      failStreak: previousFailStreak,
      sampleSummary
    };
  }

  if (allFailed) {
    const reachedThreshold = nextFailStreak >= config.fail_threshold;
    return {
      status: reachedThreshold ? "DOWN" : "UNSTABLE",
      httpCode: representativeFailure ? representativeFailure.httpCode : 0,
      latencyMs: representativeFailure ? representativeFailure.latencyMs : 0,
      errorType: representativeFailure ? representativeFailure.errorType : "DOWN",
      error: reachedThreshold
        ? (representativeFailure ? representativeFailure.error : "All checks failed")
        : `Failure ${nextFailStreak}/${config.fail_threshold}: ${representativeFailure ? representativeFailure.error : sampleSummary}`,
      finalUrl: representativeFailure ? representativeFailure.finalUrl : "",
      failStreak: nextFailStreak,
      sampleSummary
    };
  }

  return {
    status: hasSlow ? "SLOW" : "UP",
    httpCode: representativeSuccess ? representativeSuccess.httpCode : 0,
    latencyMs: representativeSuccess ? representativeSuccess.latencyMs : 0,
    errorType: hasSlow ? "SLOW" : "",
    error: hasSlow && representativeSuccess ? representativeSuccess.error : "",
    finalUrl: representativeSuccess ? representativeSuccess.finalUrl : "",
    failStreak: 0,
    sampleSummary
  };
}

async function runProbeOnce() {
  const startedAt = new Date().toISOString();
  await upsertProbe({
    last_run_started_at: startedAt,
    last_run_status: "RUNNING",
    last_run_error: "",
    last_result_count: 0,
    last_down_count: 0,
    last_status_summary: ""
  });

  const listResponse = await apiGet({ action: "listServices" });
  if (!listResponse.ok) {
    throw new Error(listResponse.error || "listServices failed");
  }

  const services = (listResponse.data || []).filter((item) => toBool(item.enabled));
  const results = [];

  for (const service of services) {
    const result = await runServiceProbe(service);
    const payload = {
      action: "appendProbeCheck",
      ...RUNTIME.metadata,
      probe_id: RUNTIME.probeId,
      service_id: String(service.id || "").trim(),
      service_name: String(service.name || service.url || "").trim(),
      status: result.status,
      http_code: result.httpCode,
      latency_ms: result.latencyMs,
      error_type: result.errorType || "",
      error: result.error || "",
      final_url: result.finalUrl || "",
      observed_url: String(service.url || "").trim(),
      last_run_started_at: startedAt,
      details: {
        sample_summary: result.sampleSummary || "",
        fail_streak: result.failStreak || 0
      }
    };

    const writeResponse = await apiPost(payload);
    if (!writeResponse.ok) {
      throw new Error(writeResponse.error || `appendProbeCheck failed for ${service.name || service.id}`);
    }

    results.push({
      service: service.name || service.url,
      status: result.status,
      httpCode: result.httpCode,
      errorType: result.errorType || "",
      error: result.error || ""
    });
  }

  const downCount = results.filter((item) => item.status === "DOWN").length;
  const summary = results.slice(0, 8).map((item) => `${item.service}:${item.status}`).join(" | ");
  const finishedAt = new Date().toISOString();

  await upsertProbe({
    last_run_started_at: startedAt,
    last_run_finished_at: finishedAt,
    last_run_status: "OK",
    last_run_error: "",
    last_result_count: results.length,
    last_down_count: downCount,
    last_status_summary: summary
  });

  const summaryPayload = {
    ok: true,
    probe_id: RUNTIME.probeId,
    probe_name: RUNTIME.probeName,
    config_path: RUNTIME.configPath,
    service_count: results.length,
    down_count: downCount,
    results
  };

  console.log(JSON.stringify(summaryPayload, null, 2));
  maybeShowRunSummaryWindow({
    probeId: RUNTIME.probeId,
    probeName: RUNTIME.probeName,
    startedAt,
    finishedAt,
    runStatus: "OK",
    results
  });
}

function shouldOpenControlWindow() {
  return process.platform === "win32" && !!RUNTIME.showControlWindow && !RUNTIME.cli.runOnceMode;
}

async function bootstrap() {
  if (shouldOpenControlWindow()) {
    showWindowsControlWindow();
    return;
  }
  await runProbeOnce();
}

bootstrap().catch(async (error) => {
  const message = String(error && error.message ? error.message : error);
  const finishedAt = new Date().toISOString();
  try {
    await upsertProbe({
      last_run_finished_at: finishedAt,
      last_run_status: "ERROR",
      last_run_error: message
    });
  } catch (_) {}

  const errorPayload = {
    ok: false,
    probe_id: RUNTIME.probeId,
    probe_name: RUNTIME.probeName,
    config_path: RUNTIME.configPath,
    error: message
  };
  console.error(JSON.stringify(errorPayload, null, 2));
  maybeShowRunSummaryWindow({
    probeId: RUNTIME.probeId,
    probeName: RUNTIME.probeName,
    startedAt: "",
    finishedAt,
    runStatus: "ERROR",
    errorMessage: message,
    results: []
  });
  process.exitCode = 1;
});
