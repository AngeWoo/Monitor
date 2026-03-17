const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PROBE_SCRIPT_VERSION = "20260315-a002";
const DEFAULT_API_BASE = "https://script.google.com/macros/s/AKfycbxPm5VWcnXe5b2u6oi1gqLIBCjK6raQtI-4ya1Gd1umDUEYhBGSOHpq9XBS9zZ7iBCq/exec";
const DEFAULT_API_REDIRECTS = 5;
const DEFAULT_CONTROL_INTERVAL_SEC = 60;
const DEFAULT_PORT_SCAN_TIMEOUT_MS = 2500;
const DEFAULT_CONTROL_SCAN_DEVICE_NAME = "所有測試項";
const DEFAULT_CONTROL_SCAN_HOST = "AUTO";
const DEFAULT_CONTROL_SCAN_PORTS = "22,80,443,3389";

function parseCliArgs(argv) {
  const parsed = {
    configPath: "",
    controlMode: false,
    runOnceMode: false,
    claimPortScanMode: false,
    noResultWindow: false,
    serviceId: "",
    portScanMode: false,
    scanHost: "",
    scanPorts: "",
    deviceName: ""
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
    if (arg === "--claim-port-scan-request") {
      parsed.claimPortScanMode = true;
      continue;
    }
    if (arg === "--no-result-window") {
      parsed.noResultWindow = true;
      continue;
    }
    if (arg === "--port-scan") {
      parsed.portScanMode = true;
      continue;
    }
    if (arg === "--config" && argv[i + 1]) {
      parsed.configPath = path.resolve(String(argv[i + 1]));
      i += 1;
      continue;
    }
    if (arg === "--service-id" && argv[i + 1]) {
      parsed.serviceId = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--scan-host" && argv[i + 1]) {
      parsed.scanHost = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--scan-ports" && argv[i + 1]) {
      parsed.scanPorts = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--device-name" && argv[i + 1]) {
      parsed.deviceName = String(argv[i + 1] || "").trim();
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

function escapePowerShellSingleQuoted(value) {
  return String(value || "").replace(/'/g, "''");
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
    forceServiceId: String(process.env.MONITOR_FORCE_SERVICE_ID || cli.serviceId || "").trim(),
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
    port_scan_enabled: false,
    port_scan_host: "",
    port_scan_ports: "",
    port_scan_device_name: "",
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
    port_scan_enabled: toBool(merged.port_scan_enabled),
    port_scan_host: String(merged.port_scan_host || "").trim(),
    port_scan_ports: String(merged.port_scan_ports || "").trim(),
    port_scan_device_name: String(merged.port_scan_device_name || "").trim(),
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

async function getPortScanConfig() {
  const response = await apiGet({ action: "getPortScanConfig" });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "getPortScanConfig failed");
  }
  return response.data || {};
}

async function claimPortScanSignal() {
  const response = await apiPost({
    action: "claimPortScanSignal",
    probe_id: RUNTIME.probeId,
    probe_name: RUNTIME.probeName
  });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "claimPortScanSignal failed");
  }
  return response.data || null;
}

async function appendPortScanSignalLog(requestId, message, level = "info") {
  if (!requestId || !message) return;
  const response = await apiPost({
    action: "appendPortScanSignalLog",
    request_id: requestId,
    probe_id: RUNTIME.probeId,
    level,
    message
  });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "appendPortScanSignalLog failed");
  }
}

async function completePortScanSignal(requestId, payload) {
  if (!requestId) return;
  const response = await apiPost({
    action: "completePortScanSignal",
    request_id: requestId,
    probe_id: RUNTIME.probeId,
    ...payload
  });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "completePortScanSignal failed");
  }
  return response.data || null;
}

function createPortScanLogger(options) {
  const opts = options || {};
  const requestId = String(opts.requestId || "").trim();
  return async (message, level = "info") => {
    const text = String(message || "").trim();
    if (!text) return;
    console.log(text);
    if (!requestId) return;
    try {
      await appendPortScanSignalLog(requestId, text, level);
    } catch (error) {
      console.error(`[PORT_SCAN_REQUEST] log write failed: ${error.message}`);
    }
  };
}

function parsePortList(rawValue) {
  const tokens = String(rawValue || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const ports = new Set();

  tokens.forEach((token) => {
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      const min = Math.max(1, Math.min(start, end));
      const max = Math.min(65535, Math.max(start, end));
      for (let port = min; port <= max; port += 1) {
        ports.add(port);
      }
      return;
    }

    const port = Number(token);
    if (Number.isFinite(port) && port >= 1 && port <= 65535) {
      ports.add(port);
    }
  });

  return [...ports].sort((left, right) => left - right);
}

function normalizeAllServicesLabel(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_\-:]+/g, "");
}

function isAllServicesSelection(value) {
  const normalized = normalizeAllServicesLabel(value);
  return normalized === "allservices" || normalized === "all";
}

function deriveServicePortScanHost(service) {
  const candidates = [
    String(service && service.secondary_url || "").trim(),
    String(service && service.url || "").trim()
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      const host = String(parsed.hostname || "").trim();
      if (host) return host;
    } catch (_) {}
  }
  return "";
}

function buildServicePortScanDeviceName(service) {
  const serviceId = String(service && service.id || "").trim();
  if (serviceId) return `service:${serviceId}`;
  return `service:${String(service && service.name || service && service.url || "unknown").trim() || "unknown"}`;
}

function scanTcpPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (status, error = "") => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve({ port, status, error });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () => finish("closed", `timeout after ${timeoutMs} ms`));
    socket.once("error", (error) => finish("closed", String(error && error.message ? error.message : error)));

    try {
      socket.connect(port, host);
    } catch (error) {
      finish("closed", String(error && error.message ? error.message : error));
    }
  });
}

async function runPortScanOnce() {
  const host = String(RUNTIME.cli.scanHost || "").trim();
  const ports = parsePortList(RUNTIME.cli.scanPorts);
  const deviceName = String(RUNTIME.cli.deviceName || host).trim();
  if (!ports.length) throw new Error("Missing valid --scan-ports");

  if (isAllServicesSelection(deviceName)) {
    const listResponse = await apiGet({ action: "listServices" });
    if (!listResponse || !listResponse.ok) {
      throw new Error(listResponse && listResponse.error ? listResponse.error : "listServices failed");
    }

    const services = Array.isArray(listResponse.data)
      ? listResponse.data.filter((item) => toBool(item && item.enabled))
      : [];
    if (!services.length) {
      throw new Error("No enabled services available for AllServices port scan");
    }

    await upsertProbe({});
    console.log(`[PORT_SCAN] mode=all-services device=${deviceName} host=AUTO(service hosts) ports=${ports.join(",")}`);
    const scanResults = await runGlobalPortScan(services, {
      force: true,
      ports: ports.join(","),
      onLog: async (message) => console.log(message.replace(/\[PORT_SCAN_AUTO\]/g, "[PORT_SCAN]"))
    });
    const successCount = scanResults.filter((item) => item && item.ok).length;
    const skippedCount = scanResults.filter((item) => item && item.skipped).length;
    console.log(`[PORT_SCAN] completed services=${successCount} skipped=${skippedCount}`);
    console.log(JSON.stringify({
      ok: true,
      probe_id: RUNTIME.probeId,
      device_name: deviceName,
      host: "AUTO(service hosts)",
      scanned_service_count: successCount,
      skipped_service_count: skippedCount,
      total_count: ports.length
    }, null, 2));
    return;
  }

  if (!host) throw new Error("Missing --scan-host");

  await upsertProbe({});

  const scannedAt = new Date().toISOString();
  const timeoutMs = Math.max(500, Math.min(RUNTIME.requestTimeoutMs, DEFAULT_PORT_SCAN_TIMEOUT_MS));
  const results = [];

  console.log(`[PORT_SCAN] device=${deviceName} host=${host} ports=${ports.join(",")}`);
  for (let index = 0; index < ports.length; index += 1) {
    const port = ports[index];
    const progressLabel = `${index + 1}/${ports.length}`;
    const progressPct = Math.round(((index + 1) / ports.length) * 100);
    console.log(`[PORT_SCAN] progress=${progressLabel} (${progressPct}%) checking ${host}:${port}`);
    const result = await scanTcpPort(host, port, timeoutMs);
    results.push(result);
    if (result.status === "open") {
      console.log(`[PORT_SCAN] progress=${progressLabel} (${progressPct}%) ${host}:${port} OPEN`);
    } else {
      console.log(`[PORT_SCAN] progress=${progressLabel} (${progressPct}%) ${host}:${port} CLOSED${result.error ? ` (${result.error})` : ""}`);
    }
  }

  const openPorts = results.filter((item) => item.status === "open").map((item) => item.port);
  const writeResponse = await apiPost({
    action: "updatePortScan",
    device_name: deviceName,
    probe_id: RUNTIME.probeId,
    host,
    open_ports: openPorts.join(","),
    scanned_at: scannedAt,
    open_count: openPorts.length,
    total_count: ports.length
  });
  if (!writeResponse || !writeResponse.ok) {
    throw new Error(writeResponse && writeResponse.error ? writeResponse.error : "updatePortScan failed");
  }
  console.log(`[PORT_SCAN] write_response=${JSON.stringify(writeResponse)}`);
  console.log(`[PORT_SCAN] completed open=${openPorts.length}/${ports.length}`);

  console.log(JSON.stringify({
    ok: true,
    probe_id: RUNTIME.probeId,
    device_name: deviceName,
    host,
    scanned_at: scannedAt,
    open_ports: openPorts,
    total_count: ports.length
  }, null, 2));
}

async function runGlobalPortScan(services, options = {}) {
  const config = getPortScanConfig ? await getPortScanConfig() : {};
  const force = toBool(options.force);
  if (!force && !toBool(config.enabled)) {
    return [];
  }

  const log = typeof options.onLog === "function" ? options.onLog : async (message) => console.log(message);
  const ports = parsePortList(options.ports || config.ports);
  if (!ports.length) {
    return [{
      ok: false,
      skipped: true,
      reason: "Missing valid global port scan ports"
    }];
  }

  const enabledServices = Array.isArray(services)
    ? services.filter((item) => String(item && item.id || "").trim())
    : [];
  if (!enabledServices.length) {
    return [];
  }

  const timeoutMs = Math.max(500, Math.min(RUNTIME.requestTimeoutMs, DEFAULT_PORT_SCAN_TIMEOUT_MS));
  const hostScanCache = new Map();
  const scanResults = [];

  for (const service of enabledServices) {
    const serviceId = String(service.id || "").trim();
    const serviceName = String(service.name || service.url || serviceId).trim() || serviceId;
    const targetHost = deriveServicePortScanHost(service);
    if (!targetHost) {
      await log(`[PORT_SCAN_AUTO] skip service=${serviceName} reason=missing host`, "warn");
      scanResults.push({
        ok: false,
        skipped: true,
        serviceId,
        serviceName,
        reason: "Missing valid service host"
      });
      continue;
    }

    let hostScan = hostScanCache.get(targetHost);
    if (!hostScan) {
      const scannedAt = new Date().toISOString();
      const hostResults = [];
      await log(`[PORT_SCAN_AUTO] service=${serviceName} host=${targetHost} ports=${ports.join(",")}`);
      for (let index = 0; index < ports.length; index += 1) {
        const port = ports[index];
        const progressLabel = `${index + 1}/${ports.length}`;
        const progressPct = Math.round(((index + 1) / ports.length) * 100);
        await log(`[PORT_SCAN_AUTO] progress=${progressLabel} (${progressPct}%) checking ${targetHost}:${port}`);
        const result = await scanTcpPort(targetHost, port, timeoutMs);
        hostResults.push(result);
        await log(`[PORT_SCAN_AUTO] progress=${progressLabel} (${progressPct}%) ${targetHost}:${port} ${String(result.status || "").toUpperCase()}`);
      }
      const openPorts = hostResults.filter((item) => item.status === "open").map((item) => item.port);
      await log(`[PORT_SCAN_AUTO] completed host=${targetHost} open=${openPorts.length}/${ports.length}`);
      hostScan = {
        host: targetHost,
        scannedAt,
        openPorts,
        totalCount: ports.length
      };
      hostScanCache.set(targetHost, hostScan);
    }

    const writeResponse = await apiPost({
      action: "updatePortScan",
      device_name: buildServicePortScanDeviceName(service),
      service_id: serviceId,
      service_name: serviceName,
      probe_id: RUNTIME.probeId,
      host: hostScan.host,
      open_ports: hostScan.openPorts.join(","),
      scanned_at: hostScan.scannedAt,
      open_count: hostScan.openPorts.length,
      total_count: hostScan.totalCount
    });
    if (!writeResponse || !writeResponse.ok) {
      throw new Error(writeResponse && writeResponse.error ? writeResponse.error : `updatePortScan failed for ${serviceName}`);
    }

    scanResults.push({
      ok: true,
      serviceId,
      serviceName,
      deviceName: buildServicePortScanDeviceName(service),
      host: hostScan.host,
      openPorts: hostScan.openPorts,
      totalCount: hostScan.totalCount,
      scannedAt: hostScan.scannedAt
    });
  }

  return scanResults;
}

async function runGlobalPortScanIfEnabled(services) {
  return runGlobalPortScan(services, { force: false });
}

async function runClaimedPortScanSession(session) {
  const requestId = String(session && session.request_id || "").trim();
  if (!requestId) {
    throw new Error("Missing request_id");
  }
  const log = createPortScanLogger({ requestId });
  const portsRaw = String(session && session.ports || "").trim();
  const requestedServiceId = String(session && session.service_id || "").trim();
  const requestedServiceName = String(session && session.service_name || requestedServiceId).trim();
  const listResponse = await apiGet({ action: "listServices" });
  if (!listResponse || !listResponse.ok) {
    throw new Error(listResponse && listResponse.error ? listResponse.error : "listServices failed");
  }

  let services = Array.isArray(listResponse.data)
    ? listResponse.data.filter((item) => toBool(item && item.enabled))
    : [];
  const ports = parsePortList(portsRaw);
  const summaryPrefix = `[PORT_SCAN_REQUEST] request=${requestId}`;
  const scopeLabel = requestedServiceId
    ? `service=${requestedServiceName || requestedServiceId}`
    : "scope=all-services";

  if (requestedServiceId) {
    services = services.filter((item) => String(item && item.id || "").trim() === requestedServiceId);
  }

  await log(`${summaryPrefix} claimed by ${RUNTIME.probeId} ${scopeLabel}`);
  if (!ports.length) {
    const summary = `${summaryPrefix} failed: no valid ports configured`;
    await log(summary, "error");
    await completePortScanSignal(requestId, {
      status: "failed",
      error: "No valid ports configured",
      result_summary: summary
    });
    return { ok: false, requestId, reason: "No valid ports configured" };
  }
  if (!services.length) {
    const summary = requestedServiceId
      ? `${summaryPrefix} completed: requested service not found or disabled`
      : `${summaryPrefix} completed: no enabled services to scan`;
    await log(summary, "warn");
    await completePortScanSignal(requestId, {
      status: "completed",
      result_summary: summary
    });
    return { ok: true, requestId, results: [] };
  }

  try {
    const scanResults = await runGlobalPortScan(services, {
      force: true,
      ports: ports.join(","),
      onLog: log
    });
    const successCount = scanResults.filter((item) => item && item.ok).length;
    const skippedCount = scanResults.filter((item) => item && item.skipped).length;
    const summary = `${summaryPrefix} completed by ${RUNTIME.probeId}: ${successCount} services scanned, ${skippedCount} skipped (${scopeLabel})`;
    await log(summary);
    await completePortScanSignal(requestId, {
      status: "completed",
      result_summary: summary
    });
    return { ok: true, requestId, results: scanResults };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const summary = `${summaryPrefix} failed: ${message}`;
    await log(summary, "error");
    await completePortScanSignal(requestId, {
      status: "failed",
      error: message,
      result_summary: summary
    });
    throw error;
  }
}

async function claimAndRunRequestedPortScan(options = {}) {
  const session = await claimPortScanSignal();
  if (!session) {
    if (!options.silentNoop) {
      console.log("[PORT_SCAN_REQUEST] no pending request");
    }
    return null;
  }
  return runClaimedPortScanSession(session);
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

async function getControlWindowDefaults() {
  const defaults = {
    deviceName: DEFAULT_CONTROL_SCAN_DEVICE_NAME,
    scanHost: DEFAULT_CONTROL_SCAN_HOST,
    scanPorts: DEFAULT_CONTROL_SCAN_PORTS
  };
  try {
    const config = await getPortScanConfig();
    const ports = parsePortList(config && config.ports);
    if (ports.length) {
      defaults.scanPorts = ports.join(",");
    }
  } catch (_) {
    // Fall back to the local defaults if the admin config cannot be read.
  }
  return defaults;
}

function buildControlWindowCommand(controlDefaults) {
  const childFile = process.execPath;
  const runOnceArgs = process.pkg
    ? ["--run-once", "--no-result-window"]
    : [path.resolve(__filename), "--run-once", "--no-result-window"];
  const claimPortScanArgs = process.pkg
    ? ["--claim-port-scan-request", "--no-result-window"]
    : [path.resolve(__filename), "--claim-port-scan-request", "--no-result-window"];
  const portScanArgs = process.pkg
    ? ["--port-scan", "--no-result-window"]
    : [path.resolve(__filename), "--port-scan", "--no-result-window"];

  if (RUNTIME.configPath && fs.existsSync(RUNTIME.configPath)) {
    runOnceArgs.push("--config", RUNTIME.configPath);
    claimPortScanArgs.push("--config", RUNTIME.configPath);
    portScanArgs.push("--config", RUNTIME.configPath);
  }

  const launchArgs = runOnceArgs.map((item) => `"${String(item).replace(/"/g, '\\"')}"`).join(" ");
  const claimPortScanLaunchArgs = claimPortScanArgs.map((item) => `"${String(item).replace(/"/g, '\\"')}"`).join(" ");
  const portScanLaunchArgs = portScanArgs.map((item) => `"${String(item).replace(/"/g, '\\"')}"`).join(" ");
  const title = `${RUNTIME.probeName} Control`;
  const intervalMs = Math.max(10000, RUNTIME.controlWindowIntervalSec * 1000);
  const defaults = controlDefaults || {};
  const defaultDeviceName = String(defaults.deviceName || DEFAULT_CONTROL_SCAN_DEVICE_NAME).trim() || DEFAULT_CONTROL_SCAN_DEVICE_NAME;
  const defaultScanHost = String(defaults.scanHost || DEFAULT_CONTROL_SCAN_HOST).trim() || DEFAULT_CONTROL_SCAN_HOST;
  const defaultScanPorts = String(defaults.scanPorts || DEFAULT_CONTROL_SCAN_PORTS).trim() || DEFAULT_CONTROL_SCAN_PORTS;
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = '${escapePowerShellSingleQuoted(title)}'
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
$scanHint.Text = 'Device 預設所有測試項，Host=AUTO 代表依各服務網址自動判斷。'
$scanHint.Location = New-Object System.Drawing.Point(84, 5)
$scanHint.AutoSize = $true
$deviceLabel = New-Object System.Windows.Forms.Label
$deviceLabel.Text = 'Device'
$deviceLabel.Location = New-Object System.Drawing.Point(4, 34)
$deviceLabel.AutoSize = $true
$txtDevice = New-Object System.Windows.Forms.TextBox
$txtDevice.Location = New-Object System.Drawing.Point(64, 30)
$txtDevice.Size = New-Object System.Drawing.Size(180, 24)
$txtDevice.Text = '${escapePowerShellSingleQuoted(defaultDeviceName)}'
$hostLabel = New-Object System.Windows.Forms.Label
$hostLabel.Text = 'Host'
$hostLabel.Location = New-Object System.Drawing.Point(258, 34)
$hostLabel.AutoSize = $true
$txtHost = New-Object System.Windows.Forms.TextBox
$txtHost.Location = New-Object System.Drawing.Point(304, 30)
$txtHost.Size = New-Object System.Drawing.Size(180, 24)
$txtHost.Text = '${escapePowerShellSingleQuoted(defaultScanHost)}'
$portsLabel = New-Object System.Windows.Forms.Label
$portsLabel.Text = 'Ports'
$portsLabel.Location = New-Object System.Drawing.Point(498, 34)
$portsLabel.AutoSize = $true
$txtPorts = New-Object System.Windows.Forms.TextBox
$txtPorts.Location = New-Object System.Drawing.Point(542, 30)
$txtPorts.Size = New-Object System.Drawing.Size(180, 24)
$txtPorts.Text = '${escapePowerShellSingleQuoted(defaultScanPorts)}'
$scanNote = New-Object System.Windows.Forms.Label
$scanNote.Text = 'Use comma-separated ports or ranges, e.g. 80,443,8080-8082'
$scanNote.Location = New-Object System.Drawing.Point(4, 66)
$scanNote.AutoSize = $true
$btnPortScan = New-Object System.Windows.Forms.Button
$btnPortScan.Text = 'Scan Ports'
$btnPortScan.Location = New-Object System.Drawing.Point(622, 62)
$btnPortScan.Size = New-Object System.Drawing.Size(100, 30)
$btnPortScan.Enabled = $true
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
$intervalTimer.Interval = ${intervalMs}
$signalTimer = New-Object System.Windows.Forms.Timer
$signalTimer.Interval = 5000
$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 700
$script:isLoopRunning = $false
$script:isProbeRunning = $false
$script:isPortScanRunning = $false
$script:isProbeOnline = $false
$script:probeProcess = $null
$script:scanProcess = $null
$script:scanProcessMode = ''
function Append-Log([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return }
  $logBox.AppendText($text + [Environment]::NewLine)
}
function Quote-Arg([string]$value) {
  if ($null -eq $value) { $value = '' }
  return '"' + ($value -replace '"', '\\"') + '"'
}
function Update-PortScanState() {
  $btnPortScan.Enabled = -not $script:isProbeRunning -and -not $script:isPortScanRunning
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
function Start-PortScan() {
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
  $psi.FileName = '${String(childFile).replace(/'/g, "''")}'
  $psi.Arguments = '${portScanLaunchArgs.replace(/'/g, "''")}' + ' --device-name ' + (Quote-Arg $deviceName) + ' --scan-host ' + (Quote-Arg $scanHost) + ' --scan-ports ' + (Quote-Arg $scanPorts)
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
  $script:scanProcessMode = 'manual'
  $btnRunOnce.Enabled = $false
  $btnStart.Enabled = $false
  $btnStop.Enabled = $false
  Append-Log(('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] Port Scan started for ' + $deviceName + ' (' + $scanHost + ')'))
  Update-Status
  $pollTimer.Start()
}
function Start-RequestedPortScan() {
  if ($script:isProbeRunning -or $script:isPortScanRunning) {
    return
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = '${String(childFile).replace(/'/g, "''")}'
  $psi.Arguments = '${claimPortScanLaunchArgs.replace(/'/g, "''")}'
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
  $script:scanProcessMode = 'remote'
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
      $scanMode = [string]$script:scanProcessMode
      $script:scanProcess.Dispose()
      $script:scanProcess = $null
      $script:isPortScanRunning = $false
      $script:scanProcessMode = ''
      if ($exitCode -eq 0) { $script:isProbeOnline = $true }
      $btnRunOnce.Enabled = $true
      $btnStart.Enabled = -not $script:isLoopRunning
      $btnStop.Enabled = $script:isLoopRunning
      if (-not ($scanMode -eq 'remote' -and $exitCode -eq 3)) {
        Append-Log(('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] Port Scan finished, exit code ' + $exitCode))
      }
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
  if ($script:isPortScanRunning) { return }
  Start-ProbeRun
})
$signalTimer.Add_Tick({
  if ($script:isProbeRunning) { return }
  if ($script:isPortScanRunning) { return }
  Start-RequestedPortScan
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
  $signalTimer.Stop()
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
Append-Log('Port Scan is ready with Device=所有測試項, Host=AUTO(service hosts), and Ports from admin config when available.')
  Append-Log('Admin-triggered port scan requests are polled automatically while this window is open.')
  $signalTimer.Start()
  Update-Status
})
[void]$form.ShowDialog()
`;
}

async function showWindowsControlWindow() {
  if (process.platform !== "win32") {
    throw new Error("Control window is only supported on Windows");
  }
  const controlDefaults = await getControlWindowDefaults();
  const encoded = Buffer.from(buildControlWindowCommand(controlDefaults), "utf16le").toString("base64");
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

  const allServices = listResponse.data || [];
  let services = allServices.filter((item) => toBool(item.enabled));
  if (RUNTIME.forceServiceId) {
    const matched = allServices.find((item) => String(item.id || "").trim() === RUNTIME.forceServiceId);
    if (!matched) {
      throw new Error(`Service not found for forced probe: ${RUNTIME.forceServiceId}`);
    }
    services = [matched];
  }
  const results = [];
  const writeErrors = [];
  const portScanResults = [];
  const portScanErrors = [];

  for (const service of services) {
    const result = await runServiceProbe(service);
    results.push({
      service: service.name || service.url,
      status: result.status,
      httpCode: result.httpCode,
      errorType: result.errorType || "",
      error: result.error || ""
    });

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

    try {
      const writeResponse = await apiPost(payload);
      if (!writeResponse.ok) {
        throw new Error(writeResponse.error || `appendProbeCheck failed for ${service.name || service.id}`);
      }
    } catch (error) {
      writeErrors.push(`${service.name || service.id}: ${error.message || error}`);
    }
  }

  try {
    const scanResults = await runGlobalPortScanIfEnabled(services);
    if (Array.isArray(scanResults) && scanResults.length) {
      portScanResults.push(...scanResults);
    }
  } catch (error) {
    portScanErrors.push(`GLOBAL_PORT_SCAN: ${error.message || error}`);
  }

  const downCount = results.filter((item) => item.status === "DOWN").length;
  const summary = results.slice(0, 8).map((item) => `${item.service}:${item.status}`).join(" | ");
  const finishedAt = new Date().toISOString();
  const combinedErrors = writeErrors.concat(portScanErrors);
  const runStatus = combinedErrors.length ? "PARTIAL_ERROR" : "OK";
  const runError = combinedErrors.length ? combinedErrors.slice(0, 6).join(" | ") : "";

  await upsertProbe({
    last_run_started_at: startedAt,
    last_run_finished_at: finishedAt,
    last_run_status: runStatus,
    last_run_error: runError,
    last_result_count: results.length,
    last_down_count: downCount,
    last_status_summary: summary
  });

  const summaryPayload = {
    ok: writeErrors.length === 0,
    probe_id: RUNTIME.probeId,
    probe_name: RUNTIME.probeName,
    config_path: RUNTIME.configPath,
    service_count: results.length,
    down_count: downCount,
    results,
    port_scan_count: portScanResults.filter((item) => item && item.ok).length,
    port_scan_results: portScanResults,
    write_errors: writeErrors,
    port_scan_errors: portScanErrors
  };

  console.log(JSON.stringify(summaryPayload, null, 2));
  maybeShowRunSummaryWindow({
    probeId: RUNTIME.probeId,
    probeName: RUNTIME.probeName,
    startedAt,
    finishedAt,
    runStatus,
    errorMessage: runError,
    results
  });
}

function shouldOpenControlWindow() {
  return process.platform === "win32" && !!RUNTIME.showControlWindow && !RUNTIME.cli.runOnceMode;
}

async function bootstrap() {
  if (RUNTIME.cli.portScanMode) {
    await runPortScanOnce();
    return;
  }
  if (RUNTIME.cli.claimPortScanMode) {
    const claimed = await claimAndRunRequestedPortScan({ silentNoop: true });
    if (!claimed) process.exitCode = 3;
    return;
  }
  if (process.platform === "win32" && !!RUNTIME.cli.controlMode && !RUNTIME.cli.runOnceMode) {
    await showWindowsControlWindow();
    return;
  }
  if (shouldOpenControlWindow()) {
    await showWindowsControlWindow();
    return;
  }
  await claimAndRunRequestedPortScan({ silentNoop: true });
  await runProbeOnce();
  await claimAndRunRequestedPortScan({ silentNoop: true });
}

bootstrap().catch(async (error) => {
  const message = String(error && error.message ? error.message : error);
  const finishedAt = new Date().toISOString();
  if (!RUNTIME.cli.portScanMode) {
    try {
      await upsertProbe({
        last_run_finished_at: finishedAt,
        last_run_status: "ERROR",
        last_run_error: message
      });
    } catch (_) {}
  }

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
