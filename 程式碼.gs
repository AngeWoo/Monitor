/*********************************
 * Service Monitor API (JSONP + Gmail report)
 * - 401/403 視為 UP
 * - 郵件內容包含所有啟用服務
 * - only_on_issue=true 時：有異常就每次 runScheduler 都寄
 * - deleteTestDataByDate: 刪除 checks 中指定日期的所有資料（不看 is_test）
 * - Dashboard URL: 動態由前端帶入 dashboard_url 並儲存，寄信 footer 自動附上
 *********************************/
const SHEET_SERVICES   = "services";
const SHEET_CHECKS     = "checks";
const SHEET_PROBE_CHECKS = "probe_checks";
const SHEET_PROBES = "probes";
const SHEET_PORT_SCANS = "port_scans";
const SHEET_NOTIFY_LOGS = "notify_logs";
const API_KEY = "";

const PORT_SCAN_HEADERS = [
  "device_name", "host", "open_ports", "scanned_at", "open_count", "total_count"
];

const NOTIFY_LOG_HEADERS = [
  "timestamp",
  "channel",
  "trigger",
  "status_label",
  "sent",
  "partial",
  "skipped",
  "issue_count",
  "service_count",
  "target_count",
  "target_summary",
  "subject",
  "error",
  "warning",
  "details_json"
];

const PROP_REPORT_CONFIG = "REPORT_CONFIG";
const PROP_REPORT_LAST_SLOT = "REPORT_LAST_SLOT";
const PROP_DASHBOARD_URL = "DASHBOARD_URL";
const PROP_LINE_TARGETS = "LINE_TARGETS";
const PROP_SERVICE_RECOMMENDATION_MIGRATION = "SERVICE_RECOMMENDED_SETTINGS_V1";
const PROP_PROBE_RUN_SIGNAL = "PROBE_RUN_SIGNAL";
const PROBE_ONLINE_WINDOW_MS = 3 * 60 * 1000;
const PROBE_RESULT_GRACE_MS = 2 * 60 * 1000;

const TEST_DELETE_DEFAULT_SHEET = SHEET_CHECKS;

const SERVICE_HEADERS = [
  "id", "name", "url", "interval_min", "enabled",
  "check_type", "expected_keyword", "forbidden_keyword", "expected_final_url", "secondary_url",
  "allow_redirects", "max_redirects", "latency_warn_ms", "fail_threshold", "retry_count", "retry_delay_ms",
  "last_check_at", "last_status", "last_http_code", "last_error_type", "last_error", "last_final_url",
  "consecutive_failures", "last_latency_ms",
  "next_check_at", "created_at", "updated_at"
];

const CHECK_HEADERS = [
  "timestamp", "service_id", "status", "http_code", "latency_ms", "error_type", "error", "final_url"
];

const PROBE_CHECK_HEADERS = [
  "timestamp", "probe_id", "service_id", "service_name", "status", "http_code", "latency_ms",
  "error_type", "error", "final_url", "observed_url", "details_json"
];

const PROBE_HEADERS = [
  "probe_id", "probe_name", "host_name", "host_user", "platform", "platform_release",
  "app_version", "probe_version", "api_base", "enabled", "last_seen_at", "last_run_started_at",
  "last_run_finished_at", "last_run_status", "last_run_error", "last_result_count",
  "last_down_count", "last_status_summary", "created_at", "updated_at"
];

function initSheets() {
  const ss = SpreadsheetApp.getActive();

  let s1 = ss.getSheetByName(SHEET_SERVICES);
  if (!s1) s1 = ss.insertSheet(SHEET_SERVICES);
  ensureHeaders_(s1, SERVICE_HEADERS);

  let s2 = ss.getSheetByName(SHEET_CHECKS);
  if (!s2) s2 = ss.insertSheet(SHEET_CHECKS);
  ensureHeaders_(s2, CHECK_HEADERS);

  let s2b = ss.getSheetByName(SHEET_PROBE_CHECKS);
  if (!s2b) s2b = ss.insertSheet(SHEET_PROBE_CHECKS);
  ensureHeaders_(s2b, PROBE_CHECK_HEADERS);

  let s2c = ss.getSheetByName(SHEET_PROBES);
  if (!s2c) s2c = ss.insertSheet(SHEET_PROBES);
  ensureHeaders_(s2c, PROBE_HEADERS);

  let s3 = ss.getSheetByName(SHEET_PORT_SCANS);
  if (!s3) s3 = ss.insertSheet(SHEET_PORT_SCANS);
  ensureHeaders_(s3, PORT_SCAN_HEADERS);

  let s4 = ss.getSheetByName(SHEET_NOTIFY_LOGS);
  if (!s4) s4 = ss.insertSheet(SHEET_NOTIFY_LOGS);
  ensureHeaders_(s4, NOTIFY_LOG_HEADERS);
}

function ensureHeaders_(sheet, requiredHeaders) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(requiredHeaders);
    return;
  }

  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = indexMap_(header);

  requiredHeaders.forEach((h) => {
    if (idx[h] !== undefined) return;
    sheet.getRange(1, sheet.getLastColumn() + 1).setValue(h);
  });
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "runScheduler") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("runScheduler").timeBased().everyMinutes(1).create();
}

function doGet(e) {
  try {
    const p = (e && e.parameter) ? e.parameter : {};
    const callback = p.callback || "";
    const action = (p.action || "").trim();

    // 嘗試從前端請求動態更新 dashboard URL
    captureDashboardUrlFromParams_(p);

    if (!authOk_(p)) return output_(callback, { ok: false, error: "Unauthorized" });
    if (!action) return output_(callback, { ok: false, error: "Missing action" });

    let result;
    switch (action) {
      case "dashboardInit":
        result = dashboardInit_(toNum_(p.hours, 24));
        break;
      case "updatePortScan":
        result = updatePortScan_(p);
        break;
      case "appendProbeCheck":
        result = appendProbeCheck_(p);
        break;
      case "upsertProbe":
        result = upsertProbe_(p);
        break;
      case "listProbes":
        result = listProbes_();
        break;
      case "markProbeOffline":
        result = markProbeOffline_(p);
        break;
      case "clearProbeState":
        result = clearProbeState_(p);
        break;
      case "refreshServiceNow":
        result = refreshServiceNow_(p);
        break;
      case "getProbeRunSignal":
        result = getProbeRunSignal_();
        break;
      case "listServices":
        result = listServices_();
        break;
      case "metrics":
        result = getMetrics_(p.serviceId, toNum_(p.hours, 24));
        break;
      case "addService":
        result = addService_({
          name: p.name,
          url: p.url,
          interval_min: toNum_(p.interval_min, 5),
          check_type: p.check_type,
          expected_keyword: p.expected_keyword,
          forbidden_keyword: p.forbidden_keyword,
          expected_final_url: p.expected_final_url,
          secondary_url: p.secondary_url,
          allow_redirects: p.allow_redirects,
          max_redirects: p.max_redirects,
          latency_warn_ms: p.latency_warn_ms,
          fail_threshold: p.fail_threshold,
          retry_count: p.retry_count,
          retry_delay_ms: p.retry_delay_ms
        });
        break;
      case "updateService":
        result = updateService_({
          id: p.id,
          name: p.name,
          url: p.url,
          interval_min: p.interval_min !== undefined ? toNum_(p.interval_min, 5) : undefined,
          enabled: p.enabled !== undefined ? toBool_(p.enabled) : undefined,
          check_type: p.check_type,
          expected_keyword: p.expected_keyword,
          forbidden_keyword: p.forbidden_keyword,
          expected_final_url: p.expected_final_url,
          secondary_url: p.secondary_url,
          allow_redirects: p.allow_redirects !== undefined ? toBool_(p.allow_redirects) : undefined,
          max_redirects: p.max_redirects !== undefined ? toNum_(p.max_redirects, 5) : undefined,
          latency_warn_ms: p.latency_warn_ms !== undefined ? toNum_(p.latency_warn_ms, 5000) : undefined,
          fail_threshold: p.fail_threshold !== undefined ? toNum_(p.fail_threshold, 2) : undefined,
          retry_count: p.retry_count !== undefined ? toNum_(p.retry_count, 2) : undefined,
          retry_delay_ms: p.retry_delay_ms !== undefined ? toNum_(p.retry_delay_ms, 1200) : undefined
        });
        break;
      case "deleteService":
        result = deleteService_(p.id);
        break;
      case "deleteTestDataByDate":
        result = deleteTestDataByDate_(p);
        break;
      case "runNow":
        result = runNow_(p);
        break;
      case "getReportConfig":
        result = { ok: true, data: getReportConfigForClient_() };
        break;
      case "updateReportConfig":
        result = updateReportConfig_(p);
        break;
      case "sendReportNow":
        result = sendStatusReportNow_();
        break;
      case "debugLineTarget":
        result = debugLineTarget_(p);
        break;
      case "getLineTargets":
        result = { ok: true, data: getLineTargets_() };
        break;
      case "getLineTargetSummary":
        result = { ok: true, data: getLineTargetSummary_() };
        break;
      case "getChecksDateRange":
        result = getChecksDateRange_();
        break;
      case "getChecksDates":
        result = getChecksDates_();
        break;
      case "getNotificationLogs":
        result = getNotificationLogs_(p);
        break;
      case "clearNotificationLogs":
        result = clearNotificationLogs_();
        break;
      case "hardDeleteService":
        result = hardDeleteService_(p.id);
        break;
      case "metricsAll":
        result = metricsAll_(toNum_(p.hours, 24));
        break;
      default:
        result = { ok: false, error: "Unknown action" };
    }

    return output_(callback, result);
  } catch (err) {
    const callback = (e && e.parameter && e.parameter.callback) ? e.parameter.callback : "";
    return output_(callback, { ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const params = (e && e.parameter) ? e.parameter : {};
    const action = String((body && body.action) || params.action || "").trim();

    // LINE webhook typically posts without API key; allow via dedicated action.
    if (action === "lineWebhook") {
      return jsonOut_(lineWebhook_(body));
    }

    // 嘗試從前端請求動態更新 dashboard URL
    captureDashboardUrlFromPayload_(body);

    if (!authOk_(body)) return jsonOut_({ ok: false, error: "Unauthorized" });

    let result;

    switch (action) {
      case "addService":
        result = addService_(body);
        break;
      case "updateService":
        result = updateService_(body);
        break;
      case "deleteService":
        result = deleteService_(body.id);
        break;
      case "deleteTestDataByDate":
        result = deleteTestDataByDate_(body);
        break;
      case "runNow":
        result = runNow_(body);
        break;
      case "getReportConfig":
        result = { ok: true, data: getReportConfigForClient_() };
        break;
      case "updateReportConfig":
        result = updateReportConfig_(body);
        break;
      case "sendReportNow":
        result = sendStatusReportNow_();
        break;
      case "debugLineTarget":
        result = debugLineTarget_(body);
        break;
      case "getLineTargets":
        result = { ok: true, data: getLineTargets_() };
        break;
      case "getLineTargetSummary":
        result = { ok: true, data: getLineTargetSummary_() };
        break;
      case "getChecksDateRange":
        result = getChecksDateRange_();
        break;
      case "getChecksDates":
        result = getChecksDates_();
        break;
      case "getNotificationLogs":
        result = getNotificationLogs_(body);
        break;
      case "clearNotificationLogs":
        result = clearNotificationLogs_();
        break;
      case "hardDeleteService":
        result = hardDeleteService_(body.id);
        break;
      case "metricsAll":
        result = metricsAll_(toNum_(body.hours, 24));
        break;
      case "updatePortScan":
        result = updatePortScan_(body);
        break;
      case "appendProbeCheck":
        result = appendProbeCheck_(body);
        break;
      case "upsertProbe":
        result = upsertProbe_(body);
        break;
      case "listProbes":
        result = listProbes_();
        break;
      case "markProbeOffline":
        result = markProbeOffline_(body);
        break;
      case "clearProbeState":
        result = clearProbeState_(body);
        break;
      case "refreshServiceNow":
        result = refreshServiceNow_(body);
        break;
      case "getProbeRunSignal":
        result = getProbeRunSignal_();
        break;
      default:
        result = { ok: false, error: "Unknown action" };
    }

    return jsonOut_(result);
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function runServiceChecks_(options) {
  var opts = options || {};
  var now = opts.now instanceof Date ? opts.now : new Date();
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SERVICES);
  ensureHeaders_(sh, SERVICE_HEADERS);
  applyRecommendedServiceSettingsIfNeeded_();
  var values = sh.getDataRange().getValues();
  var onlineProbes = getOnlineProbes_(now.getTime());
  var checkedServices = [];
  if (values.length < 2) {
    return {
      ok: true,
      now: now,
      checked_services: checkedServices,
      checked_count: 0,
      online_probe_count: onlineProbes.length,
      probe_requested: false
    };
  }

  var idx = indexMap_(values[0]);
  var forceAll = !!opts.force_all;
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!toBool_(row[idx.enabled])) continue;

    if (!forceAll) {
      var nextCheck = row[idx.next_check_at] ? new Date(row[idx.next_check_at]) : new Date(0);
      if (nextCheck.getTime() > now.getTime()) continue;
    }

    var id = row[idx.id];
    var intervalMin = Math.max(1, toNum_(row[idx.interval_min], 5));
    var service = objFromRow_(values[0], row);
    var result = checkUrl_(service);
    appendCheckLog_(id, result);
    checkedServices.push({
      id: id,
      name: service.name || service.url || id
    });

    var next = new Date(now.getTime() + intervalMin * 60000);
    sh.getRange(r + 1, idx.last_check_at + 1).setValue(now);
    sh.getRange(r + 1, idx.last_status + 1).setValue(result.status);
    sh.getRange(r + 1, idx.last_http_code + 1).setValue(result.httpCode);
    if (idx.last_error_type !== undefined) sh.getRange(r + 1, idx.last_error_type + 1).setValue(result.errorType || "");
    if (idx.last_error !== undefined) sh.getRange(r + 1, idx.last_error + 1).setValue(result.error || "");
    if (idx.last_final_url !== undefined) sh.getRange(r + 1, idx.last_final_url + 1).setValue(result.finalUrl || "");
    if (idx.consecutive_failures !== undefined) sh.getRange(r + 1, idx.consecutive_failures + 1).setValue(result.failStreak || 0);
    sh.getRange(r + 1, idx.last_latency_ms + 1).setValue(result.latencyMs);
    sh.getRange(r + 1, idx.next_check_at + 1).setValue(next);
    sh.getRange(r + 1, idx.updated_at + 1).setValue(now);
  }

  invalidateServicesCache_();
  var probeRequested = false;
  if (onlineProbes.length && checkedServices.length && toBool_(opts.request_probe !== undefined ? opts.request_probe : true)) {
    var firstChecked = checkedServices[0];
    var isSingleService = checkedServices.length === 1;
    requestProbeRunSignal_({
      service_id: forceAll ? "" : (isSingleService ? firstChecked.id : ""),
      service_name: forceAll ? "all services" : (isSingleService ? firstChecked.name : "scheduled services"),
      requested_by: String(opts.requested_by || "system").trim() || "system"
    });
    probeRequested = true;
  }

  return {
    ok: true,
    now: now,
    checked_services: checkedServices,
    checked_count: checkedServices.length,
    online_probe_count: onlineProbes.length,
    probe_requested: probeRequested
  };
}

function runScheduler() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    var summary = runServiceChecks_({
      force_all: false,
      request_probe: true,
      requested_by: "scheduler"
    });
    maybeSendScheduledReport_(summary.now || new Date());
    return summary;
  } finally {
    lock.releaseLock();
  }
}

function defaultServiceCheckConfig_() {
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

function applyRecommendedServiceSettingsIfNeeded_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP_SERVICE_RECOMMENDATION_MIGRATION)) {
    return { ok: true, applied: false, skipped: true };
  }

  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SERVICES);
  if (!sh) {
    props.setProperty(PROP_SERVICE_RECOMMENDATION_MIGRATION, new Date().toISOString());
    return { ok: true, applied: false, updated: 0 };
  }

  ensureHeaders_(sh, SERVICE_HEADERS);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) {
    props.setProperty(PROP_SERVICE_RECOMMENDATION_MIGRATION, new Date().toISOString());
    return { ok: true, applied: false, updated: 0 };
  }

  const header = values[0];
  const idx = indexMap_(header);
  const recommended = defaultServiceCheckConfig_();
  const settingKeys = [
    "check_type",
    "expected_keyword",
    "forbidden_keyword",
    "expected_final_url",
    "secondary_url",
    "allow_redirects",
    "max_redirects",
    "latency_warn_ms",
    "fail_threshold",
    "retry_count",
    "retry_delay_ms"
  ];
  const now = new Date();
  let updated = 0;

  for (let r = 1; r < values.length; r++) {
    let dirty = false;
    settingKeys.forEach(function (key) {
      const columnIndex = idx[key];
      if (columnIndex === undefined) return;

      const recommendedValue = recommended[key];
      let currentValue = values[r][columnIndex];

      if (typeof recommendedValue === "boolean") {
        currentValue = toBool_(currentValue);
      } else if (typeof recommendedValue === "number") {
        currentValue = toNum_(currentValue, recommendedValue);
      } else {
        currentValue = String(currentValue || "").trim();
      }

      if (currentValue === recommendedValue) return;
      values[r][columnIndex] = recommendedValue;
      dirty = true;
    });

    if (dirty) {
      if (idx.updated_at !== undefined) values[r][idx.updated_at] = now;
      updated += 1;
    }
  }

  if (updated > 0) {
    sh.getRange(2, 1, values.length - 1, header.length).setValues(values.slice(1));
    invalidateServicesCache_();
  }

  props.setProperty(PROP_SERVICE_RECOMMENDATION_MIGRATION, now.toISOString());
  return { ok: true, applied: updated > 0, updated: updated };
}

function normalizeServiceConfig_(source) {
  const merged = Object.assign({}, defaultServiceCheckConfig_(), source || {});
  const checkType = String(merged.check_type || "status_code").trim().toLowerCase();
  merged.check_type = checkType === "keyword" ? "keyword" : "status_code";
  merged.expected_keyword = String(merged.expected_keyword || "").trim();
  merged.forbidden_keyword = String(merged.forbidden_keyword || "").trim();
  merged.expected_final_url = String(merged.expected_final_url || "").trim();
  merged.secondary_url = String(merged.secondary_url || "").trim();
  merged.allow_redirects = toBool_(merged.allow_redirects);
  merged.max_redirects = Math.max(0, Math.min(10, toNum_(merged.max_redirects, 5)));
  merged.latency_warn_ms = Math.max(0, toNum_(merged.latency_warn_ms, 5000));
  merged.fail_threshold = Math.max(1, toNum_(merged.fail_threshold, 2));
  merged.retry_count = Math.max(1, Math.min(5, toNum_(merged.retry_count, 2)));
  merged.retry_delay_ms = Math.max(0, Math.min(10000, toNum_(merged.retry_delay_ms, 1200)));
  merged.consecutive_failures = Math.max(0, toNum_(merged.consecutive_failures, 0));
  return merged;
}

function classifyFetchError_(err) {
  const text = String(err || "");
  if (/timed out|deadline/i.test(text)) return "TIMEOUT";
  if (/dns|resolve|host/i.test(text)) return "DNS_ERROR";
  if (/ssl|tls|certificate|handshake|schannel/i.test(text)) return "TLS_ERROR";
  if (/refused|reset|connect|socket|network|unreachable/i.test(text)) return "NETWORK_ERROR";
  return "FETCH_ERROR";
}

function classifyHttpFailure_(code, bodyText) {
  const body = String(bodyText || "");
  if (code === 401) return "";
  if (code === 403 && /access denied|forbidden|captcha|cloudflare|just a moment/i.test(body)) return "BLOCKED";
  if (code === 403) return "";
  if (code === 429) return "RATE_LIMIT";
  if (code >= 500) return "HTTP_5XX";
  if (code >= 400) return "HTTP_4XX";
  return "";
}

function delayMs_(ms) {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (!waitMs) return;
  Utilities.sleep(waitMs);
}

function fetchWithRedirectTrace_(url, config) {
  let currentUrl = url;
  let redirects = 0;
  let response = null;

  while (true) {
    response = UrlFetchApp.fetch(currentUrl, {
      muteHttpExceptions: true,
      followRedirects: false
    });
    const code = Number(response.getResponseCode() || 0);
    const headers = response.getHeaders ? response.getHeaders() : {};
    const location = String(headers.Location || headers.location || "").trim();
    const isRedirect = code >= 300 && code < 400 && !!location;

    if (!isRedirect) {
      return { response: response, finalUrl: currentUrl, redirects: redirects, exceeded: false };
    }
    if (!config.allow_redirects) {
      return { response: response, finalUrl: currentUrl, redirects: redirects, exceeded: false };
    }
    if (redirects >= config.max_redirects) {
      return { response: response, finalUrl: currentUrl, redirects: redirects, exceeded: true };
    }

    currentUrl = String(new URL(location, currentUrl));
    redirects += 1;
  }
}

function runSingleCheckAttempt_(url, config) {
  const start = Date.now();

  try {
    const trace = fetchWithRedirectTrace_(url, config);
    const resp = trace.response;
    const code = Number(resp.getResponseCode() || 0);
    const latency = Date.now() - start;
    const finalUrl = String(trace.finalUrl || url).trim();
    const bodyText = String(resp.getContentText() || "");

    if (trace.exceeded) {
      return {
        ok: false,
        status: "DOWN",
        httpCode: code,
        latencyMs: latency,
        errorType: "REDIRECT_ERROR",
        error: `Redirects exceeded limit ${config.max_redirects}`,
        finalUrl: finalUrl,
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
        finalUrl: finalUrl,
        observedUrl: url
      };
    }

    const httpErrorType = classifyHttpFailure_(code, bodyText);
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
      const expected = String(config.expected_final_url || "").trim();
      const actual = finalUrl || url;
      if (actual !== expected) {
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
      if (config.expected_keyword && bodyText.indexOf(config.expected_keyword) === -1) {
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
      if (config.forbidden_keyword && bodyText.indexOf(config.forbidden_keyword) >= 0) {
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
  } catch (err) {
    return {
      ok: false,
      status: "DOWN",
      httpCode: 0,
      latencyMs: Date.now() - start,
      errorType: classifyFetchError_(err),
      error: String(err),
      finalUrl: "",
      observedUrl: url
    };
  }
}

function summarizeSampleResults_(results) {
  return results.map(function (item, index) {
    const part = `#${index + 1} ${item.observedUrl} => ${item.status} HTTP ${item.httpCode || 0}`;
    return item.error ? `${part} (${truncateText_(item.error, 120)})` : part;
  }).join(" | ");
}

function checkUrl_(service) {
  const config = normalizeServiceConfig_(service);
  const urls = [String(service.url || "").trim()];
  if (config.secondary_url) urls.push(config.secondary_url);

  const sampleResults = [];
  urls.forEach(function (targetUrl) {
    for (let attempt = 0; attempt < config.retry_count; attempt++) {
      sampleResults.push(runSingleCheckAttempt_(targetUrl, config));
      if (attempt < config.retry_count - 1) delayMs_(config.retry_delay_ms);
    }
  });

  const successResults = sampleResults.filter(function (item) { return item.ok; });
  const failResults = sampleResults.filter(function (item) { return !item.ok; });
  const hasSlow = successResults.some(function (item) { return item.status === "SLOW"; });
  const allFailed = sampleResults.length > 0 && failResults.length === sampleResults.length;
  const hadMixedResults = successResults.length > 0 && failResults.length > 0;
  const previousFailStreak = Math.max(0, toNum_(service.consecutive_failures, 0));
  const nextFailStreak = allFailed ? previousFailStreak + 1 : 0;
  const representativeFailure = failResults[failResults.length - 1] || null;
  const representativeSuccess = successResults[successResults.length - 1] || null;
  const sampleSummary = summarizeSampleResults_(sampleResults);

  if (hadMixedResults) {
    return {
      status: "UNSTABLE",
      httpCode: representativeFailure ? representativeFailure.httpCode : (representativeSuccess ? representativeSuccess.httpCode : 0),
      latencyMs: representativeSuccess ? representativeSuccess.latencyMs : (representativeFailure ? representativeFailure.latencyMs : 0),
      errorType: "UNSTABLE",
      error: sampleSummary,
      finalUrl: representativeSuccess ? representativeSuccess.finalUrl : (representativeFailure ? representativeFailure.finalUrl : ""),
      failStreak: previousFailStreak,
      sampleSummary: sampleSummary
    };
  }

  if (allFailed) {
    const reachedThreshold = nextFailStreak >= config.fail_threshold;
    return {
      status: reachedThreshold ? (representativeFailure.errorType || "DOWN") : "UNSTABLE",
      httpCode: representativeFailure ? representativeFailure.httpCode : 0,
      latencyMs: representativeFailure ? representativeFailure.latencyMs : 0,
      errorType: representativeFailure ? representativeFailure.errorType : "DOWN",
      error: reachedThreshold
        ? (representativeFailure ? representativeFailure.error : "All checks failed")
        : `Failure ${nextFailStreak}/${config.fail_threshold}: ${representativeFailure ? representativeFailure.error : sampleSummary}`,
      finalUrl: representativeFailure ? representativeFailure.finalUrl : "",
      failStreak: nextFailStreak,
      sampleSummary: sampleSummary
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
    sampleSummary: sampleSummary
  };
}

/*************** Service CRUD ***************/
function addService_(b) {
  if (!b || !b.url) return { ok: false, error: "Missing url" };

  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SERVICES);
  ensureHeaders_(sh, SERVICE_HEADERS);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const cfg = normalizeServiceConfig_(b);

  const now = new Date();
  const id = Utilities.getUuid();
  const rowObj = {
    id: id,
    name: b.name || b.url,
    url: b.url,
    interval_min: Math.max(1, toNum_(b.interval_min, 5)),
    enabled: true,
    check_type: cfg.check_type,
    expected_keyword: cfg.expected_keyword,
    forbidden_keyword: cfg.forbidden_keyword,
    expected_final_url: cfg.expected_final_url,
    secondary_url: cfg.secondary_url,
    allow_redirects: cfg.allow_redirects,
    max_redirects: cfg.max_redirects,
    latency_warn_ms: cfg.latency_warn_ms,
    fail_threshold: cfg.fail_threshold,
    retry_count: cfg.retry_count,
    retry_delay_ms: cfg.retry_delay_ms,
    last_check_at: "",
    last_status: "",
    last_http_code: "",
    last_error_type: "",
    last_error: "",
    last_final_url: "",
    consecutive_failures: 0,
    last_latency_ms: "",
    next_check_at: now,
    created_at: now,
    updated_at: now
  };

  sh.appendRow(rowFromObj_(header, rowObj));
  invalidateServicesCache_();
  return { ok: true, id: id };
}

function updateService_(b) {
  if (!b || !b.id) return { ok: false, error: "Missing id" };

  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SERVICES);
  ensureHeaders_(sh, SERVICE_HEADERS);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return { ok: false, error: "No data" };
  const idx = indexMap_(values[0]);

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idx.id]) !== String(b.id)) continue;

    if (b.name !== undefined) sh.getRange(r + 1, idx.name + 1).setValue(b.name);
    if (b.url !== undefined) sh.getRange(r + 1, idx.url + 1).setValue(b.url);
    if (b.interval_min !== undefined) sh.getRange(r + 1, idx.interval_min + 1).setValue(Math.max(1, toNum_(b.interval_min, 5)));
    if (b.enabled !== undefined) sh.getRange(r + 1, idx.enabled + 1).setValue(!!b.enabled);
    if (b.check_type !== undefined && idx.check_type !== undefined) sh.getRange(r + 1, idx.check_type + 1).setValue(normalizeServiceConfig_(b).check_type);
    if (b.expected_keyword !== undefined && idx.expected_keyword !== undefined) sh.getRange(r + 1, idx.expected_keyword + 1).setValue(String(b.expected_keyword || "").trim());
    if (b.forbidden_keyword !== undefined && idx.forbidden_keyword !== undefined) sh.getRange(r + 1, idx.forbidden_keyword + 1).setValue(String(b.forbidden_keyword || "").trim());
    if (b.expected_final_url !== undefined && idx.expected_final_url !== undefined) sh.getRange(r + 1, idx.expected_final_url + 1).setValue(String(b.expected_final_url || "").trim());
    if (b.secondary_url !== undefined && idx.secondary_url !== undefined) sh.getRange(r + 1, idx.secondary_url + 1).setValue(String(b.secondary_url || "").trim());
    if (b.allow_redirects !== undefined && idx.allow_redirects !== undefined) sh.getRange(r + 1, idx.allow_redirects + 1).setValue(!!b.allow_redirects);
    if (b.max_redirects !== undefined && idx.max_redirects !== undefined) sh.getRange(r + 1, idx.max_redirects + 1).setValue(Math.max(0, Math.min(10, toNum_(b.max_redirects, 5))));
    if (b.latency_warn_ms !== undefined && idx.latency_warn_ms !== undefined) sh.getRange(r + 1, idx.latency_warn_ms + 1).setValue(Math.max(0, toNum_(b.latency_warn_ms, 5000)));
    if (b.fail_threshold !== undefined && idx.fail_threshold !== undefined) sh.getRange(r + 1, idx.fail_threshold + 1).setValue(Math.max(1, toNum_(b.fail_threshold, 2)));
    if (b.retry_count !== undefined && idx.retry_count !== undefined) sh.getRange(r + 1, idx.retry_count + 1).setValue(Math.max(1, Math.min(5, toNum_(b.retry_count, 2))));
    if (b.retry_delay_ms !== undefined && idx.retry_delay_ms !== undefined) sh.getRange(r + 1, idx.retry_delay_ms + 1).setValue(Math.max(0, Math.min(10000, toNum_(b.retry_delay_ms, 1200))));
    sh.getRange(r + 1, idx.updated_at + 1).setValue(new Date());
    invalidateServicesCache_();
    return { ok: true };
  }

  return { ok: false, error: "Not found" };
}

function deleteService_(id) {
  if (!id) return { ok: false, error: "Missing id" };
  return updateService_({ id: id, enabled: false });
}

function runNow_(payload) {
  var summary = runServiceChecks_({
    force_all: true,
    request_probe: payload && payload.request_probe,
    requested_by: String((payload && payload.requested_by) || "admin").trim() || "admin"
  });

  return {
    ok: true,
    data: {
      checked_count: Number(summary.checked_count || 0),
      probe_requested: !!summary.probe_requested,
      online_probe_count: Number(summary.online_probe_count || 0)
    }
  };
}

function refreshServiceNow_(payload) {
  var id = String((payload && payload.id) || "").trim();
  if (!id) return { ok: false, error: "Missing id" };

  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SERVICES);
  if (!sh) return { ok: false, error: "Services sheet not found" };
  ensureHeaders_(sh, SERVICE_HEADERS);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { ok: false, error: "No services found" };
  var idx = indexMap_(values[0]);
  var now = new Date();

  for (var r = 1; r < values.length; r++) {
    if (String(values[r][idx.id] || "").trim() !== id) continue;
    var service = objFromRow_(values[0], values[r]);
    var intervalMin = Math.max(1, toNum_(service.interval_min, 5));
    var result = checkUrl_(service);
    appendCheckLog_(id, result);

    sh.getRange(r + 1, idx.last_check_at + 1).setValue(now);
    sh.getRange(r + 1, idx.last_status + 1).setValue(result.status);
    sh.getRange(r + 1, idx.last_http_code + 1).setValue(result.httpCode);
    if (idx.last_error_type !== undefined) sh.getRange(r + 1, idx.last_error_type + 1).setValue(result.errorType || "");
    if (idx.last_error !== undefined) sh.getRange(r + 1, idx.last_error + 1).setValue(result.error || "");
    if (idx.last_final_url !== undefined) sh.getRange(r + 1, idx.last_final_url + 1).setValue(result.finalUrl || "");
    if (idx.consecutive_failures !== undefined) sh.getRange(r + 1, idx.consecutive_failures + 1).setValue(result.failStreak || 0);
    if (idx.last_latency_ms !== undefined) sh.getRange(r + 1, idx.last_latency_ms + 1).setValue(result.latencyMs);
    if (idx.next_check_at !== undefined && toBool_(service.enabled)) {
      sh.getRange(r + 1, idx.next_check_at + 1).setValue(new Date(now.getTime() + intervalMin * 60000));
    }
    if (idx.updated_at !== undefined) sh.getRange(r + 1, idx.updated_at + 1).setValue(now);

    invalidateServicesCache_();

    var onlineProbes = getOnlineProbes_(Date.now());
    var probeRequested = false;
    if (onlineProbes.length && toBool_(payload && payload.request_probe !== undefined ? payload.request_probe : true)) {
      requestProbeRunSignal_({
        service_id: id,
        service_name: service.name || service.url || id,
        requested_by: String((payload && payload.requested_by) || "admin").trim() || "admin"
      });
      probeRequested = true;
    }

    return {
      ok: true,
      data: {
        id: id,
        gas_result: result,
        probe_requested: probeRequested,
        online_probe_count: onlineProbes.length
      }
    };
  }

  return { ok: false, error: "Service not found" };
}

function hardDeleteService_(id) {
  if (!id) return { ok: false, error: "Missing id" };
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SERVICES);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { ok: false, error: "Not found" };
  var idx = indexMap_(values[0]);
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][idx.id]) !== String(id)) continue;
    sh.deleteRow(r + 1);
    invalidateServicesCache_();
    return { ok: true };
  }
  return { ok: false, error: "Not found" };
}

function listServices_() {
  applyRecommendedServiceSettingsIfNeeded_();
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CACHE_KEY_SERVICES);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SERVICES);
  ensureHeaders_(sh, SERVICE_HEADERS);
  var values = sh.getDataRange().getValues();
  var result = values.length < 2
    ? { ok: true, data: [] }
    : { ok: true, data: buildServiceViews_(values.slice(1).map(function(r) { return objFromRow_(values[0], r); })) };
  try { cache.put(CACHE_KEY_SERVICES, JSON.stringify(result), CACHE_TTL_SERVICES); } catch (_) {}
  return result;
}

function buildServiceViews_(services) {
  var nowMs = Date.now();
  var onlineProbes = getOnlineProbes_(nowMs);
  if (!onlineProbes.length) {
    return services.map(function(service) {
      return buildSingleProbeServiceView_(service);
    });
  }

  var onlineProbeMap = {};
  onlineProbes.forEach(function(probe) {
    onlineProbeMap[String(probe.probe_id || "").trim()] = probe;
  });

  var latestProbeChecks = getLatestProbeChecksByService_(onlineProbeMap);
  return services.map(function(service) {
    return buildAggregatedServiceView_(service, latestProbeChecks[String(service.id || "").trim()], onlineProbes, nowMs);
  });
}

function buildSingleProbeServiceView_(service) {
  var view = cloneRecord_(service);
  var gasStatus = normalizeServiceStatus_(service.last_status);
  view.check_mode = "single";
  view.check_mode_label = "單一測試";
  view.check_mode_detail = "GAS:" + (gasStatus || "UNKNOWN");
  view.gas_status = gasStatus;
  view.gas_http_code = service.last_http_code || "";
  view.gas_error_type = service.last_error_type || "";
  view.gas_error = service.last_error || "";
  view.gas_last_check_at = service.last_check_at || "";
  view.probe_status = "";
  view.probe_http_code = "";
  view.probe_error_type = "";
  view.probe_error = "";
  view.probe_last_check_at = "";
  view.probe_id = "";
  view.probe_name = "";
  view.online_probe_count = 0;
  return view;
}

function buildAggregatedServiceView_(service, probeCheck, onlineProbes, nowMs) {
  var view = cloneRecord_(service);
  var gasStatus = normalizeServiceStatus_(service.last_status);
  var gasErrorType = String(service.last_error_type || "").trim();
  var gasError = String(service.last_error || "").trim();
  var gasCheckAt = service.last_check_at || "";
  var onlineCount = Array.isArray(onlineProbes) ? onlineProbes.length : 0;

  view.gas_status = gasStatus;
  view.gas_http_code = service.last_http_code || "";
  view.gas_error_type = gasErrorType;
  view.gas_error = gasError;
  view.gas_last_check_at = gasCheckAt;
  view.online_probe_count = onlineCount;

  if (!probeCheck || !isFreshProbeCheck_(probeCheck, service, nowMs)) {
    view.check_mode = "dual_pending";
    view.check_mode_label = "雙探針待同步";
    view.check_mode_detail = "GAS:" + (gasStatus || "UNKNOWN") + " | 等待本機 Probe";
    view.probe_status = "";
    view.probe_http_code = "";
    view.probe_error_type = "";
    view.probe_error = "";
    view.probe_last_check_at = "";
    view.probe_id = "";
    view.probe_name = "";

    if (isDownLikeStatus_(gasStatus)) {
      view.last_status = "UNSTABLE";
      view.last_error_type = "PROBE_PENDING";
      view.last_error = joinStatusText_([gasError, "等待 Probe 確認"]);
    }
    return view;
  }

  var probeStatus = normalizeServiceStatus_(probeCheck.status);
  var probeErrorType = String(probeCheck.error_type || "").trim();
  var probeError = String(probeCheck.error || "").trim();
  var gasDown = isDownLikeStatus_(gasStatus);
  var probeDown = isDownLikeStatus_(probeStatus);
  var gasSlow = gasStatus === "SLOW";
  var probeSlow = probeStatus === "SLOW";
  var gasUnstable = gasStatus === "UNSTABLE";
  var probeUnstable = probeStatus === "UNSTABLE";
  var combinedHttp = combineScalarDisplay_(service.last_http_code, probeCheck.http_code);
  var combinedCheckedAt = maxDateValue_(service.last_check_at, probeCheck.timestamp);
  var combinedLatency = chooseCombinedLatency_(service.last_latency_ms, probeCheck.latency_ms, gasSlow || probeSlow || gasDown || probeDown);
  var probeName = String((probeCheck && probeCheck.probe_name) || "").trim();
  var probeId = String((probeCheck && probeCheck.probe_id) || "").trim();

  view.check_mode = "dual";
  view.check_mode_label = "雙探針測試";
  view.check_mode_detail = "GAS:" + (gasStatus || "UNKNOWN") + " | " + (probeName || probeId || "Probe") + ":" + (probeStatus || "UNKNOWN");
  view.probe_status = probeStatus;
  view.probe_http_code = probeCheck.http_code || "";
  view.probe_error_type = probeErrorType;
  view.probe_error = probeError;
  view.probe_last_check_at = probeCheck.timestamp || "";
  view.probe_id = probeId;
  view.probe_name = probeName;
  view.last_check_at = combinedCheckedAt || view.last_check_at;
  view.last_http_code = combinedHttp;
  if (combinedLatency !== "") view.last_latency_ms = combinedLatency;

  if (gasDown && probeDown) {
    view.last_status = "DOWN";
    view.last_error_type = "DUAL_CONFIRMED_DOWN";
    view.last_error = joinStatusText_([
      formatStatusSource_("GAS", gasStatus, gasErrorType || gasError),
      formatStatusSource_(probeName || probeId || "Probe", probeStatus, probeErrorType || probeError)
    ]);
    return view;
  }

  if (gasDown !== probeDown) {
    view.last_status = "UNSTABLE";
    view.last_error_type = "DUAL_MISMATCH";
    view.last_error = joinStatusText_([
      formatStatusSource_("GAS", gasStatus, gasErrorType || gasError),
      formatStatusSource_(probeName || probeId || "Probe", probeStatus, probeErrorType || probeError)
    ]);
    return view;
  }

  if (gasUnstable || probeUnstable) {
    view.last_status = "UP-";
    view.last_error_type = "DUAL_PARTIAL";
    view.last_error = joinStatusText_([
      formatStatusSource_("GAS", gasStatus, gasErrorType || gasError),
      formatStatusSource_(probeName || probeId || "Probe", probeStatus, probeErrorType || probeError)
    ]);
    return view;
  }

  if (gasSlow || probeSlow) {
    view.last_status = "UP-";
    view.last_error_type = "DUAL_PARTIAL";
    view.last_error = joinStatusText_([
      gasSlow ? formatStatusSource_("GAS", gasStatus, gasError) : "",
      probeSlow ? formatStatusSource_(probeName || probeId || "Probe", probeStatus, probeError) : ""
    ]);
    return view;
  }

  view.last_status = "UP";
  view.last_error_type = "";
  view.last_error = "";
  return view;
}

function getOnlineProbes_(nowMs) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_PROBES);
  if (!sh) return [];
  ensureHeaders_(sh, PROBE_HEADERS);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  return values.slice(1).map(function(row) {
    return objFromRow_(values[0], row);
  }).filter(function(probe) {
    return isProbeOnline_(probe, nowMs);
  });
}

function getLatestProbeChecksByService_(onlineProbeMap) {
  var probeIds = Object.keys(onlineProbeMap || {});
  if (!probeIds.length) return {};
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_PROBE_CHECKS);
  if (!sh) return {};
  ensureHeaders_(sh, PROBE_CHECK_HEADERS);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return {};
  var latestByService = {};

  values.slice(1).forEach(function(row) {
    var item = objFromRow_(values[0], row);
    var probeId = String(item.probe_id || "").trim();
    if (!onlineProbeMap[probeId]) return;
    var serviceId = String(item.service_id || "").trim();
    if (!serviceId) return;
    var tsMs = toTimeMs_(item.timestamp);
    if (!tsMs) return;
    var existing = latestByService[serviceId];
    if (existing && existing.timestamp_ms >= tsMs) return;
    item.timestamp_ms = tsMs;
    item.probe_name = onlineProbeMap[probeId].probe_name || probeId;
    latestByService[serviceId] = item;
  });

  return latestByService;
}

function isProbeOnline_(probe, nowMs) {
  if (!probe || !toBool_(probe.enabled)) return false;
  var lastSeenMs = toTimeMs_(probe.last_seen_at);
  if (!lastSeenMs) return false;
  if ((nowMs - lastSeenMs) > PROBE_ONLINE_WINDOW_MS) return false;
  var runStatus = normalizeServiceStatus_(probe.last_run_status);
  return ["OFFLINE", "STOPPED", "CLOSED"].indexOf(runStatus) === -1;
}

function isFreshProbeCheck_(probeCheck, service, nowMs) {
  if (!probeCheck) return false;
  var timestampMs = Number(probeCheck.timestamp_ms || toTimeMs_(probeCheck.timestamp) || 0);
  if (!timestampMs) return false;
  var intervalMin = Math.max(1, toNum_(service && service.interval_min, 5));
  var maxAgeMs = intervalMin * 60000 + PROBE_RESULT_GRACE_MS;
  return (nowMs - timestampMs) <= maxAgeMs;
}

function toTimeMs_(value) {
  if (!value) return 0;
  var dt = new Date(value);
  var ms = dt.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeServiceStatus_(status) {
  return String(status || "").trim().toUpperCase();
}

function isDownLikeStatus_(status) {
  var value = normalizeServiceStatus_(status);
  return !!value && ["UP", "SLOW", "UNSTABLE"].indexOf(value) === -1;
}

function cloneRecord_(record) {
  var clone = {};
  Object.keys(record || {}).forEach(function(key) {
    clone[key] = record[key];
  });
  return clone;
}

function joinStatusText_(parts) {
  return (parts || []).filter(function(part) {
    return !!String(part || "").trim();
  }).join(" | ");
}

function formatStatusSource_(source, status, detail) {
  var text = String(source || "").trim() + ":" + normalizeServiceStatus_(status || "");
  var detailText = String(detail || "").trim();
  return detailText ? text + " (" + detailText + ")" : text;
}

function combineScalarDisplay_(leftValue, rightValue) {
  var left = String(leftValue || "").trim();
  var right = String(rightValue || "").trim();
  if (!left && !right) return "";
  if (!left) return right;
  if (!right) return left;
  return left === right ? left : left + " / " + right;
}

function maxDateValue_(leftValue, rightValue) {
  var leftMs = toTimeMs_(leftValue);
  var rightMs = toTimeMs_(rightValue);
  if (!leftMs && !rightMs) return "";
  return new Date(Math.max(leftMs || 0, rightMs || 0));
}

function chooseCombinedLatency_(leftValue, rightValue, preferWorst) {
  var leftNum = Number(leftValue);
  var rightNum = Number(rightValue);
  var leftOk = Number.isFinite(leftNum) && leftNum >= 0;
  var rightOk = Number.isFinite(rightNum) && rightNum >= 0;
  if (!leftOk && !rightOk) return "";
  if (!leftOk) return Math.round(rightNum);
  if (!rightOk) return Math.round(leftNum);
  return Math.round(preferWorst ? Math.max(leftNum, rightNum) : Math.min(leftNum, rightNum));
}

function listProbes_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_PROBES);
  if (!sh) return { ok: true, data: [] };
  ensureHeaders_(sh, PROBE_HEADERS);
  var values = sh.getDataRange().getValues();
  return values.length < 2
    ? { ok: true, data: [] }
    : { ok: true, data: values.slice(1).map(function(r) { return objFromRow_(values[0], r); }) };
}

function upsertProbe_(payload) {
  const probeId = String((payload && payload.probe_id) || "").trim();
  if (!probeId) return { ok: false, error: "Missing probe_id" };

  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_PROBES);
  if (!sh) sh = ss.insertSheet(SHEET_PROBES);
  ensureHeaders_(sh, PROBE_HEADERS);
  const values = sh.getDataRange().getValues();
  const header = values[0];
  const idx = indexMap_(header);
  const now = new Date();
  const probeName = String((payload && payload.probe_name) || probeId).trim();
  const rowObj = {
    probe_id: probeId,
    probe_name: probeName || probeId,
    host_name: String((payload && payload.host_name) || "").trim(),
    host_user: String((payload && payload.host_user) || "").trim(),
    platform: String((payload && payload.platform) || "").trim(),
    platform_release: String((payload && payload.platform_release) || "").trim(),
    app_version: String((payload && payload.app_version) || "").trim(),
    probe_version: String((payload && payload.probe_version) || "").trim(),
    api_base: String((payload && payload.api_base) || "").trim(),
    enabled: payload && payload.enabled !== undefined ? toBool_(payload.enabled) : true,
    last_seen_at: now,
    last_run_started_at: payload && payload.last_run_started_at ? new Date(payload.last_run_started_at) : "",
    last_run_finished_at: payload && payload.last_run_finished_at ? new Date(payload.last_run_finished_at) : "",
    last_run_status: String((payload && payload.last_run_status) || "").trim(),
    last_run_error: String((payload && payload.last_run_error) || "").trim(),
    last_result_count: toNum_(payload && payload.last_result_count, 0),
    last_down_count: toNum_(payload && payload.last_down_count, 0),
    last_status_summary: String((payload && payload.last_status_summary) || "").trim(),
    created_at: now,
    updated_at: now
  };

  if (values.length >= 2) {
    for (let r = 1; r < values.length; r++) {
      if (String(values[r][idx.probe_id] || "").trim() !== probeId) continue;

      Object.keys(rowObj).forEach(function (key) {
        if (idx[key] === undefined) return;
        if (key === "created_at") return;
        if (payload && payload[key] === undefined && !["last_seen_at", "updated_at"].includes(key)) return;
        sh.getRange(r + 1, idx[key] + 1).setValue(rowObj[key]);
      });
      sh.getRange(r + 1, idx.last_seen_at + 1).setValue(now);
      sh.getRange(r + 1, idx.updated_at + 1).setValue(now);
      invalidateServicesCache_();
      return { ok: true, updated: true, probe_id: probeId };
    }
  }

  sh.appendRow(rowFromObj_(header, rowObj));
  invalidateServicesCache_();
  return { ok: true, created: true, probe_id: probeId };
}

function updateProbeRow_(probeId, updater) {
  const id = String(probeId || "").trim();
  if (!id) return { ok: false, error: "Missing probe_id" };

  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_PROBES);
  if (!sh) return { ok: false, error: "Probe sheet not found" };
  ensureHeaders_(sh, PROBE_HEADERS);

  const values = sh.getDataRange().getValues();
  if (values.length < 2) return { ok: false, error: "Probe not found" };
  const idx = indexMap_(values[0]);

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idx.probe_id] || "").trim() !== id) continue;
    const rowData = objFromRow_(values[0], values[r]);
    const next = updater(rowData, idx) || {};
    Object.keys(next).forEach(function (key) {
      if (idx[key] === undefined) return;
      sh.getRange(r + 1, idx[key] + 1).setValue(next[key]);
    });
    if (idx.updated_at !== undefined) {
      sh.getRange(r + 1, idx.updated_at + 1).setValue(new Date());
    }
    invalidateServicesCache_();
    return { ok: true, probe_id: id };
  }

  return { ok: false, error: "Probe not found" };
}

function markProbeOffline_(payload) {
  const probeId = String((payload && payload.probe_id) || "").trim();
  const summary = String((payload && payload.summary) || "Marked offline by admin").trim();
  return updateProbeRow_(probeId, function () {
    return {
      last_run_status: "OFFLINE",
      last_run_error: "",
      last_result_count: 0,
      last_down_count: 0,
      last_status_summary: summary
    };
  });
}

function clearProbeState_(payload) {
  const probeId = String((payload && payload.probe_id) || "").trim();
  return updateProbeRow_(probeId, function () {
    return {
      last_seen_at: "",
      last_run_started_at: "",
      last_run_finished_at: "",
      last_run_status: "",
      last_run_error: "",
      last_result_count: 0,
      last_down_count: 0,
      last_status_summary: ""
    };
  });
}

function requestProbeRunSignal_(payload) {
  var props = PropertiesService.getScriptProperties();
  var signal = {
    requested_at: new Date().toISOString(),
    service_id: String((payload && payload.service_id) || "").trim(),
    service_name: String((payload && payload.service_name) || "").trim(),
    requested_by: String((payload && payload.requested_by) || "system").trim() || "system"
  };
  props.setProperty(PROP_PROBE_RUN_SIGNAL, JSON.stringify(signal));
  return signal;
}

function getProbeRunSignal_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP_PROBE_RUN_SIGNAL);
  if (!raw) return { ok: true, data: null };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Combined init: returns services + metricsAll + checksDateRange in one call.
 * Minimises JSONP round trips and benefits from all server-side caches.
 */
/**
 * Called by the Node.js port-scanner after each scan.
 * Upserts one row per device_name in the port_scans sheet.
 */
function updatePortScan_(payload) {
  var deviceName = String(payload.device_name || '').trim();
  if (!deviceName) return { ok: false, error: 'Missing device_name' };

  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SHEET_PORT_SCANS);
  if (!sh) { sh = ss.insertSheet(SHEET_PORT_SCANS); ensureHeaders_(sh, PORT_SCAN_HEADERS); }

  var openPorts  = String(payload.open_ports  || '').trim();
  var scannedAt  = String(payload.scanned_at  || new Date().toISOString()).trim();
  var openCount  = Number(payload.open_count  || 0);
  var totalCount = Number(payload.total_count || 0);
  var host       = String(payload.host        || '').trim();

  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var idx    = indexMap_(header);
    var col    = sh.getLastColumn();
    var data   = sh.getRange(2, 1, lastRow - 1, col).getValues();
    for (var r = 0; r < data.length; r++) {
      if (String(data[r][idx.device_name] || '').trim() === deviceName) {
        var rowNum = r + 2; // 1-based, +1 for header
        sh.getRange(rowNum, idx.host       + 1).setValue(host);
        sh.getRange(rowNum, idx.open_ports + 1).setValue(openPorts);
        sh.getRange(rowNum, idx.scanned_at + 1).setValue(scannedAt);
        sh.getRange(rowNum, idx.open_count + 1).setValue(openCount);
        sh.getRange(rowNum, idx.total_count+ 1).setValue(totalCount);
        return { ok: true, updated: true };
      }
    }
  }

  // No existing row — append
  var header2 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.appendRow(rowFromObj_(header2, {
    device_name: deviceName, host: host,
    open_ports:  openPorts,  scanned_at: scannedAt,
    open_count:  openCount,  total_count: totalCount
  }));
  return { ok: true, created: true };
}

/**
 * Reads port_scans sheet and returns a map:
 *   { deviceName: { host, open_ports: [80,443,...], scanned_at, open_count, total_count } }
 */
function readPortScansMap_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_PORT_SCANS);
  if (!sh || sh.getLastRow() < 2) return {};
  var values = sh.getDataRange().getValues();
  var idx = indexMap_(values[0]);
  var map = {};
  for (var r = 1; r < values.length; r++) {
    var row  = values[r];
    var name = String(row[idx.device_name] || '').trim();
    if (!name) continue;
    var portsStr = String(row[idx.open_ports] || '').trim();
    var ports = portsStr
      ? portsStr.split(',').map(function(p) { return Number(p.trim()); }).filter(function(n) { return n > 0; })
      : [];
    map[name] = {
      host:        String(row[idx.host]        || ''),
      open_ports:  ports,
      scanned_at:  row[idx.scanned_at]         || null,
      open_count:  Number(row[idx.open_count]  || 0),
      total_count: Number(row[idx.total_count] || 0)
    };
  }
  return map;
}

function dashboardInit_(hours) {
  var hoursNum = toNum_(hours, 24);
  var svcResult     = listServices_();
  var metricsResult = metricsAll_(hoursNum);
  var dateResult    = getChecksDateRange_();
  return {
    ok: true,
    data: {
      services:       svcResult.data     || [],
      metricsAll:     metricsResult.data || {},
      checksDateRange: dateResult.data   || {}
    }
  };
}

function getMetrics_(serviceId, hours) {
  if (!serviceId) return { ok: false, error: "Missing serviceId" };

  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CHECKS);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return { ok: true, data: [] };

  const idx = indexMap_(values[0]);
  const since = Date.now() - Math.max(1, toNum_(hours, 24)) * 3600 * 1000;

  const data = values.slice(1).filter((r) => {
    const ts = new Date(r[idx.timestamp]).getTime();
    return String(r[idx.service_id]) === String(serviceId) && ts >= since;
  }).map((r) => ({
    timestamp: r[idx.timestamp],
    status: r[idx.status],
    http_code: r[idx.http_code],
    latency_ms: r[idx.latency_ms],
    error: r[idx.error]
  }));

  return { ok: true, data: data };
}

function metricsAll_(hours) {
  var hoursNum = Math.max(1, toNum_(hours, 24));
  var cacheKey = CACHE_KEY_METRICS_PFX + hoursNum;
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }

  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CHECKS);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, data: {} };
  var lastCol = sh.getLastColumn();

  // Tail-read optimisation: only fetch recent rows instead of entire sheet.
  // Assumes at most 30 services each checking once per minute (×1.1 buffer).
  var estimatedRows = Math.max(5000, Math.ceil(hoursNum * 60 * 30 * 1.1));
  var startRow = Math.max(2, lastRow - estimatedRows + 1);
  var numRows  = lastRow - startRow + 1;

  var header    = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx       = indexMap_(header);
  var since     = Date.now() - hoursNum * 3600 * 1000;
  var grouped   = {};

  var dataValues = sh.getRange(startRow, 1, numRows, lastCol).getValues();
  for (var r = 0; r < dataValues.length; r++) {
    var row = dataValues[r];
    var ts  = new Date(row[idx.timestamp]).getTime();
    if (ts < since) continue;
    var sid = String(row[idx.service_id]);
    if (!grouped[sid]) grouped[sid] = [];
    grouped[sid].push({
      timestamp:  row[idx.timestamp],
      status:     row[idx.status],
      http_code:  row[idx.http_code],
      latency_ms: row[idx.latency_ms],
      error:      row[idx.error]
    });
  }

  var result = { ok: true, data: grouped };
  // Only store in CacheService when payload fits within the 100 KB limit
  try {
    var json = JSON.stringify(result);
    if (json.length < 90000) cache.put(cacheKey, json, CACHE_TTL_METRICS);
  } catch (_) {}

  return result;
}

function appendCheckLog_(serviceId, result) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CHECKS);
  ensureHeaders_(sh, CHECK_HEADERS);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rowObj = {
    timestamp: new Date(),
    service_id: serviceId,
    status: result.status,
    http_code: result.httpCode,
    latency_ms: result.latencyMs,
    error_type: result.errorType || "",
    error: result.error || "",
    final_url: result.finalUrl || ""
  };
  sh.appendRow(rowFromObj_(header, rowObj));
}

function appendProbeCheck_(payload) {
  const probeId = String((payload && payload.probe_id) || "").trim();
  const serviceId = String((payload && payload.service_id) || "").trim();
  if (!probeId) return { ok: false, error: "Missing probe_id" };
  if (!serviceId) return { ok: false, error: "Missing service_id" };

  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_PROBE_CHECKS);
  if (!sh) sh = ss.insertSheet(SHEET_PROBE_CHECKS);
  ensureHeaders_(sh, PROBE_CHECK_HEADERS);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rowObj = {
    timestamp: new Date(),
    probe_id: probeId,
    service_id: serviceId,
    service_name: String((payload && payload.service_name) || "").trim(),
    status: String((payload && payload.status) || "").trim(),
    http_code: toNum_((payload && payload.http_code), 0),
    latency_ms: toNum_((payload && payload.latency_ms), 0),
    error_type: String((payload && payload.error_type) || "").trim(),
    error: String((payload && payload.error) || "").trim(),
    final_url: String((payload && payload.final_url) || "").trim(),
    observed_url: String((payload && payload.observed_url) || "").trim(),
    details_json: safeJsonStringify_(payload && payload.details ? payload.details : {})
  };
  sh.appendRow(rowFromObj_(header, rowObj));
  invalidateServicesCache_();
  upsertProbe_({
    probe_id: probeId,
    probe_name: payload && payload.probe_name,
    host_name: payload && payload.host_name,
    host_user: payload && payload.host_user,
    platform: payload && payload.platform,
    platform_release: payload && payload.platform_release,
    app_version: payload && payload.app_version,
    probe_version: payload && payload.probe_version,
    api_base: payload && payload.api_base,
    last_run_status: String((payload && payload.status) || "").trim(),
    last_run_error: String((payload && payload.error) || "").trim(),
    last_result_count: payload && payload.last_result_count,
    last_down_count: payload && payload.last_down_count,
    last_status_summary: payload && payload.last_status_summary,
    last_run_started_at: payload && payload.last_run_started_at,
    last_run_finished_at: payload && payload.last_run_finished_at
  });
  return { ok: true };
}

/*************** Delete By Date (ignore is_test) ***************/
function deleteTestDataByDate_(payload) {
  var date = String((payload && payload.date) || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "Invalid date, expected YYYY-MM-DD" };
  }

  var sheetName = String((payload && payload.sheet) || TEST_DELETE_DEFAULT_SHEET).trim();
  var sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sh) return { ok: false, error: "Sheet not found: " + sheetName };

  var lastRow = sh.getLastRow();
  if (lastRow < 2) {
    return { ok: true, data: { date: date, sheet: sheetName, mode: "all_by_date", matched_date_count: 0, deleted_count: 0 } };
  }

  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = indexMap_(header);
  if (idx.timestamp === undefined) return { ok: false, error: "Missing timestamp column in checks sheet" };

  // Read ONLY the timestamp column — 6x less data than full sheet read
  var tsColIdx = idx.timestamp + 1;
  var tsValues = sh.getRange(2, tsColIdx, lastRow - 1, 1).getValues();
  var tz = Session.getScriptTimeZone();
  var fmtCache = {};
  var rowsToDelete = []; // 1-based sheet row indices

  for (var r = 0; r < tsValues.length; r++) {
    var v = tsValues[r][0];
    if (!v) continue;
    var ms;
    if (Object.prototype.toString.call(v) === '[object Date]') {
      ms = v.getTime();
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      ms = Math.round((v - 25569) * 86400 * 1000);
    } else {
      ms = new Date(String(v)).getTime();
    }
    if (!ms || isNaN(ms)) continue;
    var hourKey = Math.floor(ms / 3600000);
    if (!(hourKey in fmtCache)) {
      fmtCache[hourKey] = Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd');
    }
    if (fmtCache[hourKey] === date) {
      rowsToDelete.push(r + 2); // offset r is 0-based from row 2, so sheet row = r+2
    }
  }

  if (rowsToDelete.length === 0) {
    return { ok: true, data: { date: date, sheet: sheetName, mode: "all_by_date", matched_date_count: 0, deleted_count: 0 } };
  }

  // Group consecutive rows into ranges to minimise deleteRows() API calls
  rowsToDelete.sort(function(a, b) { return a - b; });
  var groups = [];
  var gStart = rowsToDelete[0];
  var gEnd = rowsToDelete[0];
  for (var i = 1; i < rowsToDelete.length; i++) {
    if (rowsToDelete[i] === gEnd + 1) {
      gEnd = rowsToDelete[i];
    } else {
      groups.push({ start: gStart, count: gEnd - gStart + 1 });
      gStart = rowsToDelete[i];
      gEnd = rowsToDelete[i];
    }
  }
  groups.push({ start: gStart, count: gEnd - gStart + 1 });

  // Delete from bottom to top so row indices remain valid
  for (var g = groups.length - 1; g >= 0; g--) {
    sh.deleteRows(groups[g].start, groups[g].count);
  }

  invalidateChecksDateCache_();

  return {
    ok: true,
    data: {
      date: date,
      sheet: sheetName,
      mode: "all_by_date",
      matched_date_count: rowsToDelete.length,
      deleted_count: rowsToDelete.length
    }
  };
}

/*************** Cache Keys & TTLs ***************/
var CACHE_KEY_SERVICES    = 'list_services_v2';
var CACHE_TTL_SERVICES    = 35;   // 35 seconds
var CACHE_KEY_METRICS_PFX = 'metrics_all_v1_';
var CACHE_TTL_METRICS     = 60;   // 60 seconds (only stored when JSON < 90 KB)
var CACHE_KEY_DATES       = 'checks_dates_v1';
var CACHE_TTL_DATES       = 300;  // 5 minutes

function invalidateChecksDateCache_() {
  try { CacheService.getScriptCache().remove(CACHE_KEY_DATES); } catch (_) {}
}

function invalidateServicesCache_() {
  try { CacheService.getScriptCache().remove(CACHE_KEY_SERVICES); } catch (_) {}
}

function invalidateMetricsAllCache_() {
  try {
    var cache = CacheService.getScriptCache();
    [6, 24, 72].forEach(function(h) { cache.remove(CACHE_KEY_METRICS_PFX + h); });
  } catch (_) {}
}

function getChecksDatesFromSheet_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CHECKS);
  if (!sh) return null;
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { minDate: null, maxDate: null, dates: [] };
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = indexMap_(header);
  if (idx.timestamp === undefined) return null;
  var tsColIdx = idx.timestamp + 1;
  var tsValues = sh.getRange(2, tsColIdx, lastRow - 1, 1).getValues();
  var tz = Session.getScriptTimeZone();
  var dateMap = {};
  var fmtCache = {}; // hourly bucket → ymd string (limits Utilities.formatDate calls)
  var minDate = null;
  var maxDate = null;
  for (var r = 0; r < tsValues.length; r++) {
    var v = tsValues[r][0];
    if (!v) continue;
    var ms;
    if (Object.prototype.toString.call(v) === '[object Date]') {
      ms = v.getTime();
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      ms = Math.round((v - 25569) * 86400 * 1000);
    } else {
      ms = new Date(String(v)).getTime();
    }
    if (!ms || isNaN(ms)) continue;
    // Cache by hour bucket — safe for all UTC offsets, ~24 Utilities.formatDate calls/day max
    var hourKey = Math.floor(ms / 3600000);
    if (!(hourKey in fmtCache)) {
      fmtCache[hourKey] = Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd');
    }
    var ymd = fmtCache[hourKey];
    if (!ymd) continue;
    if (!dateMap[ymd]) {
      dateMap[ymd] = true;
      if (!minDate || ymd < minDate) minDate = ymd;
      if (!maxDate || ymd > maxDate) maxDate = ymd;
    }
  }
  var dates = Object.keys(dateMap).sort().reverse();
  return { minDate: minDate, maxDate: maxDate, dates: dates };
}

function getChecksDateRange_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CACHE_KEY_DATES);
  if (cached) {
    try {
      var p = JSON.parse(cached);
      return { ok: true, data: { minDate: p.minDate, maxDate: p.maxDate } };
    } catch (_) {}
  }
  var result = getChecksDatesFromSheet_();
  if (!result) return { ok: false, error: 'Sheet not found or missing timestamp column' };
  try { cache.put(CACHE_KEY_DATES, JSON.stringify(result), CACHE_TTL_DATES); } catch (_) {}
  return { ok: true, data: { minDate: result.minDate, maxDate: result.maxDate } };
}

function getChecksDates_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CACHE_KEY_DATES);
  if (cached) {
    try {
      var p = JSON.parse(cached);
      return { ok: true, data: { dates: p.dates } };
    } catch (_) {}
  }
  var result = getChecksDatesFromSheet_();
  if (!result) return { ok: false, error: 'Sheet not found or missing timestamp column' };
  try { cache.put(CACHE_KEY_DATES, JSON.stringify(result), CACHE_TTL_DATES); } catch (_) {}
  return { ok: true, data: { dates: result.dates } };
}

function getNotificationLogs_(payload) {
  const channel = String((payload && payload.channel) || "").trim().toLowerCase();
  const requestedPageSize = toNum_(payload && payload.page_size, 30);
  const pageSize = Math.max(1, Math.min(100, requestedPageSize || 30));
  const requestedPage = toNum_(payload && payload.page, 1);

  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NOTIFY_LOGS);
  if (!sh || sh.getLastRow() < 2) {
    return {
      ok: true,
      data: [],
      page: 1,
      page_size: pageSize,
      total: 0,
      total_pages: 0,
      channel: channel
    };
  }

  const values = sh.getDataRange().getValues();
  const header = values[0];
  const rows = values.slice(1)
    .map(function (row) { return objFromRow_(header, row); })
    .filter(function (item) {
      if (!channel) return true;
      return String(item.channel || "").trim().toLowerCase() === channel;
    })
    .reverse();

  const total = rows.length;
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
  const page = totalPages > 0
    ? Math.max(1, Math.min(requestedPage || 1, totalPages))
    : 1;
  const start = (page - 1) * pageSize;

  return {
    ok: true,
    data: rows.slice(start, start + pageSize),
    page: page,
    page_size: pageSize,
    total: total,
    total_pages: totalPages,
    channel: channel
  };
}

function clearNotificationLogs_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_NOTIFY_LOGS);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NOTIFY_LOGS);
    ensureHeaders_(sh, NOTIFY_LOG_HEADERS);
    return { ok: true, deleted_count: 0 };
  }

  ensureHeaders_(sh, NOTIFY_LOG_HEADERS);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    return { ok: true, deleted_count: 0 };
  }

  const deletedCount = lastRow - 1;
  sh.deleteRows(2, deletedCount);
  return { ok: true, deleted_count: deletedCount };
}

/*************** Report Config ***************/
function defaultReportConfig_() {
  return {
    recipients: "",
    frequency: "hourly",
    daily_hour: 9,
    enabled: true,
    only_on_issue: true,
    notify_mode: "mail",
    line_channel_access_token: "",
    line_to: "",
    teams_webhook_url: "",
    monitor_label: ""
  };
}

/**
 * Returns the display label for this monitoring instance.
 * Uses monitor_label from config if set; otherwise extracts host from dashboard URL.
 */
function getMonitorLabel_(cfg) {
  var label = String((cfg && cfg.monitor_label) || '').trim();
  if (label) return label;
  var url = getDashboardUrl_();
  if (url) {
    var m = url.match(/^https?:\/\/([^\/]+)/);
    if (m && m[1]) return m[1];
  }
  return 'Service Monitor';
}

function getReportConfig_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_REPORT_CONFIG);
  if (!raw) return defaultReportConfig_();
  try {
    return normalizeReportConfig_(JSON.parse(raw));
  } catch (_) {
    return defaultReportConfig_();
  }
}

function normalizeReportConfig_(cfg) {
  const out = Object.assign({}, defaultReportConfig_(), cfg || {});
  const mode = String(out.notify_mode || "").trim().toLowerCase();
  const validModes = { mail: true, mail_line: true, mail_teams: true, all: true, line_only: true };
  out.frequency = out.frequency === "daily" ? "daily" : "hourly";
  out.daily_hour = Math.min(23, Math.max(0, toNum_(out.daily_hour, 9)));
  out.enabled = toBool_(out.enabled);
  out.only_on_issue = toBool_(out.only_on_issue);
  out.recipients = String(out.recipients || "").trim();
  out.notify_mode = validModes[mode] ? mode : "mail";
  out.line_channel_access_token = String(out.line_channel_access_token || "").trim();
  out.line_to = normalizeLineToConfig_(out.line_to);
  out.teams_webhook_url = String(out.teams_webhook_url || "").trim();
  out.monitor_label = String(out.monitor_label || "").trim();
  return out;
}

function resolveSecretConfigValue_(existingValue, nextValue) {
  const existing = String(existingValue || "").trim();
  if (nextValue === undefined || nextValue === null) return existing;
  const incoming = String(nextValue || "").trim();
  if (!incoming) return existing;
  if (incoming === tokenPreview_(existing)) return existing;
  return incoming;
}

function getReportConfigForClient_() {
  const cfg = getReportConfig_();
  const out = Object.assign({}, cfg);
  const lineToken = String(cfg.line_channel_access_token || "").trim();
  const teamsWebhook = String(cfg.teams_webhook_url || "").trim();
  out.line_channel_access_token = "";
  out.line_channel_access_token_configured = !!lineToken;
  out.line_channel_access_token_masked = tokenPreview_(lineToken);
  out.teams_webhook_url = "";
  out.teams_webhook_url_configured = !!teamsWebhook;
  out.teams_webhook_url_masked = tokenPreview_(teamsWebhook);
  return out;
}

function updateReportConfig_(payload) {
  const existing = getReportConfig_();
  const cfg = normalizeReportConfig_(Object.assign({}, existing, {
    recipients: payload.recipients,
    frequency: payload.frequency,
    daily_hour: payload.daily_hour,
    enabled: payload.enabled,
    only_on_issue: payload.only_on_issue,
    notify_mode: payload.notify_mode,
    line_channel_access_token: resolveSecretConfigValue_(existing.line_channel_access_token, payload.line_channel_access_token),
    line_to: payload.line_to,
    teams_webhook_url: resolveSecretConfigValue_(existing.teams_webhook_url, payload.teams_webhook_url),
    monitor_label: payload.monitor_label
  }));

  const needsMail = cfg.notify_mode !== "line_only";
  if (needsMail && !cfg.recipients) return { ok: false, error: "Recipients required for mail mode" };
  if ((cfg.notify_mode === "mail_line" || cfg.notify_mode === "all") &&
      !cfg.line_channel_access_token) {
    return { ok: false, error: "LINE mode requires line_channel_access_token" };
  }
  if (cfg.notify_mode === "line_only" && !cfg.line_channel_access_token) {
    return { ok: false, error: "LINE-only mode requires line_channel_access_token" };
  }
  if ((cfg.notify_mode === "mail_teams" || cfg.notify_mode === "all") &&
      !cfg.teams_webhook_url) {
    return { ok: false, error: "Teams mode requires teams_webhook_url" };
  }
  PropertiesService.getScriptProperties().setProperty(PROP_REPORT_CONFIG, JSON.stringify(cfg));
  return { ok: true, data: getReportConfigForClient_() };
}

/*************** Report Sending ***************/
function sendStatusReportNow_() {
  const cfg = getReportConfig_();
  return sendStatusReport_(cfg, true, new Date());
}

function sendStatusReportNow() {
  return sendStatusReportNow_();
}

function maybeSendScheduledReport_(now) {
  const cfg = getReportConfig_();
  if (!cfg.enabled) return;

  if (cfg.only_on_issue) {
    sendStatusReport_(cfg, false, now);
    return;
  }

  const slot = reportSlot_(cfg, now);
  if (!slot) return;

  const props = PropertiesService.getScriptProperties();
  const lastSlot = props.getProperty(PROP_REPORT_LAST_SLOT) || "";
  if (lastSlot === slot) return;

  const res = sendStatusReport_(cfg, false, now);
  if (res.ok && res.sent) props.setProperty(PROP_REPORT_LAST_SLOT, slot);
}

function reportSlot_(cfg, now) {
  const tz = Session.getScriptTimeZone();
  const hour = Number(Utilities.formatDate(now, tz, "H"));
  const minute = Number(Utilities.formatDate(now, tz, "m"));

  if (cfg.frequency === "hourly") return "hourly-" + Utilities.formatDate(now, tz, "yyyyMMddHH");
  if (cfg.frequency === "daily") {
    if (hour !== cfg.daily_hour) return "";
    if (minute > 4) return "";
    return "daily-" + Utilities.formatDate(now, tz, "yyyyMMdd");
  }
  return "";
}

function parseRecipients_(raw) {
  return String(raw || "").split(/[;,]/).map((s) => s.trim()).filter((s) => s);
}

/**
 * Fetches port scan results from the local port-scanner via nginx reverse proxy.
 * Returns an object keyed by device name → array of open port numbers.
 * Returns {} on any error so callers can treat it as "no data".
 */
function fetchPortDevicesMap_() {
  var dashUrl = getDashboardUrl_();
  if (!dashUrl) return {};
  try {
    var m = dashUrl.match(/^(https?:\/\/[^\/]+)/);
    if (!m) return {};
    var apiUrl = m[1] + '/port-api/devices';
    var resp = UrlFetchApp.fetch(apiUrl, { muteHttpExceptions: true, followRedirects: true });
    if (resp.getResponseCode() !== 200) return {};
    var json = JSON.parse(resp.getContentText());
    if (!json.ok || !Array.isArray(json.data)) return {};
    var portMap = {};
    json.data.forEach(function(d) {
      if (!d.last_scan || !Array.isArray(d.last_scan.ports)) return;
      var open = d.last_scan.ports
        .filter(function(p) { return p.status === 'open'; })
        .map(function(p) { return p.port; })
        .sort(function(a, b) { return a - b; });
      if (open.length) portMap[String(d.name)] = open;
    });
    return portMap;
  } catch (_) {
    return {};
  }
}

function buildNotificationTargetInfo_(channelResult, meta) {
  const result = channelResult || {};
  const channel = String(result.channel || "").toLowerCase();

  if (channel === "mail") {
    const recipients = Array.isArray(meta && meta.recipients) ? meta.recipients : [];
    return {
      count: recipients.length,
      summary: recipients.join(", ")
    };
  }

  if (channel === "line") {
    const results = Array.isArray(result.results) ? result.results : [];
    const targets = results
      .map(function (item) { return String((item && item.target) || "").trim(); })
      .filter(function (item) { return item; });
    const count = Number(result.target_count || targets.length || 0);
    const preview = targets.slice(0, 3).join(", ");
    return {
      count: count,
      summary: targets.length > 3 ? `${preview} ...` : preview
    };
  }

  if (channel === "teams") {
    return { count: 1, summary: "Teams webhook" };
  }

  return { count: 0, summary: "" };
}

function appendNotificationLogs_(meta, channels) {
  if (!channels || !channels.length) return;

  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_NOTIFY_LOGS);
  if (!sh) sh = ss.insertSheet(SHEET_NOTIFY_LOGS);
  ensureHeaders_(sh, NOTIFY_LOG_HEADERS);

  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rows = channels.map(function (channelResult) {
    const targetInfo = buildNotificationTargetInfo_(channelResult, meta);
    const detailsJson = safeJsonStringify_(channelResult);
    return rowFromObj_(header, {
      timestamp: meta && meta.now ? meta.now : new Date(),
      channel: String((channelResult && channelResult.channel) || ""),
      trigger: String((meta && meta.trigger) || ""),
      status_label: String((meta && meta.statusLabel) || ""),
      sent: !!(channelResult && channelResult.sent),
      partial: !!(channelResult && channelResult.partial),
      skipped: String((channelResult && channelResult.skipped) || ""),
      issue_count: Number((meta && meta.issueCount) || 0),
      service_count: Number((meta && meta.serviceCount) || 0),
      target_count: Number(targetInfo.count || 0),
      target_summary: String(targetInfo.summary || ""),
      subject: String((meta && meta.subject) || ""),
      error: String((channelResult && channelResult.error) || ""),
      warning: String((meta && meta.warning) || ""),
      details_json: truncateText_(detailsJson, 2000)
    });
  });

  sh.getRange(sh.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
}

function sendStatusReportLegacy_(cfg, forceSend, now) {
  const sendMail = cfg.notify_mode !== "line_only";
  const recipients = parseRecipients_(cfg.recipients);
  const eventTime = now || new Date();

  const services = (listServices_().data || []).filter((s) => toBool_(s.enabled));
  const issues = services.filter((s) => !isUpEquivalentStatus_(s.last_status));
  const upCount = services.length - issues.length;

  if (!forceSend && cfg.only_on_issue && issues.length === 0) {
    return { ok: true, sent: false, skipped: "No issue" };
  }

  const tz = Session.getScriptTimeZone();
  const at = Utilities.formatDate(eventTime, tz, "yyyy-MM-dd HH:mm:ss");
  const statusLabel = issues.length > 0 ? "ALERT" : "OK";
  const monitorLabel = getMonitorLabel_(cfg);
  const subject = `[Service Monitor][${statusLabel}][${monitorLabel}] ${at}`;
  const logMeta = {
    now: eventTime,
    trigger: forceSend ? "manual" : "scheduled",
    statusLabel: statusLabel,
    issueCount: issues.length,
    serviceCount: services.length,
    subject: subject,
    recipients: recipients,
    warning: ""
  };

  if (sendMail && !recipients.length) {
    const failedChannels = [{ channel: "mail", sent: false, error: "No recipients configured" }];
    appendNotificationLogs_(logMeta, failedChannels);
    return {
      ok: false,
      sent: false,
      partial: false,
      issues: issues.length,
      channels: failedChannels,
      error: "No recipients configured",
      warning: ""
    };
  }

  const portMap = readPortScansMap_(); // { serviceName: { open_ports:[80,443], scanned_at, ... } }
  const latencyValues = services
    .map((s) => Number(s.last_latency_ms))
    .filter((v) => Number.isFinite(v) && v >= 0);
  const sortedLatency = latencyValues.slice().sort((a, b) => a - b);
  const avgLatency = sortedLatency.length
    ? Math.round(sortedLatency.reduce((sum, v) => sum + v, 0) / sortedLatency.length)
    : null;
  const p95Latency = sortedLatency.length
    ? sortedLatency[Math.min(sortedLatency.length - 1, Math.floor((sortedLatency.length - 1) * 0.95))]
    : null;
  const minLatency = sortedLatency.length ? sortedLatency[0] : null;
  const maxLatency = sortedLatency.length ? sortedLatency[sortedLatency.length - 1] : null;
  const availabilityRate = services.length ? ((upCount / services.length) * 100).toFixed(1) : "0.0";

  const allRowsHtml = services.length
    ? services.map((s) => {
        const isIssue = !isUpEquivalentStatus_(s.last_status);
        const portData  = portMap[String(s.name)];
        const openPorts = portData ? portData.open_ports : null;
        const portsCell = openPorts && openPorts.length
          ? `<span style="color:#0e7a6a;font-weight:600;">${openPorts.join(", ")}</span>`
          : `<span style="color:#aaa;">—</span>`;
        return `<tr>
          <td>${escapeHtml_(s.name)}</td>
          <td>${escapeHtml_(s.url)}</td>
          <td>${escapeHtml_(String(s.last_status || "UNKNOWN"))}</td>
          <td>${escapeHtml_(String(s.last_http_code || "-"))}</td>
          <td>${escapeHtml_(String(s.last_latency_ms || "-"))}</td>
          <td>${escapeHtml_(String(s.last_check_at || "-"))}</td>
          <td>${portsCell}</td>
          <td>${isIssue ? "YES" : "NO"}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="8">目前沒有啟用服務</td></tr>`;

  const dashboardUrl = getDashboardUrl_();
  const dashboardHtml = dashboardUrl
    ? `<hr><p style="margin-top:12px;">Dashboard：<a href="${escapeHtml_(dashboardUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml_(dashboardUrl)}</a></p>`
    : "";
  const dashboardBackLinkHtml = dashboardUrl
    ? `<p style="margin-top:8px;"><a href="${escapeHtml_(dashboardUrl)}" target="_blank" rel="noopener noreferrer">點一下回到 Dashboard</a></p>`
    : "";
  const statsHtml =
    `<h3>統計資料</h3>
     <ul>
       <li>啟用服務總數：${services.length}</li>
       <li>正常：${upCount}</li>
       <li>異常：${issues.length}</li>
       <li>可用率：${availabilityRate}%</li>
       <li>平均延遲：${avgLatency !== null ? avgLatency + " ms" : "N/A"}</li>
       <li>P95 延遲：${p95Latency !== null ? p95Latency + " ms" : "N/A"}</li>
       <li>最小延遲：${minLatency !== null ? minLatency + " ms" : "N/A"}</li>
       <li>最大延遲：${maxLatency !== null ? maxLatency + " ms" : "N/A"}</li>
     </ul>`;

  const issueUrlsHtml = issues.length
    ? `<hr><h3>⚠️ 異常偵測主機網址</h3><ul style="margin:4px 0;padding-left:20px;">` +
      issues.map((s) =>
        `<li><strong>${escapeHtml_(s.name)}</strong>：` +
        `<a href="${escapeHtml_(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml_(s.url)}</a></li>`
      ).join("") +
      `</ul>`
    : "";

  const htmlBody =
    `<h2>Service Monitor 狀態報告</h2>
     <p style="color:#555;font-size:0.9em;border-bottom:1px solid #e0e0e0;padding-bottom:8px;margin-bottom:12px;">
       監控站：<strong>${escapeHtml_(monitorLabel)}</strong>
     </p>
     <p>時間：${escapeHtml_(at)}</p>
     <p>啟用服務：${services.length}，正常：${upCount}，異常：${issues.length}</p>
     <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
       <thead><tr><th>服務</th><th>URL</th><th>狀態</th><th>HTTP</th><th>延遲(ms)</th><th>最後檢查</th><th>開放 Ports</th><th>是否異常</th></tr></thead>
       <tbody>${allRowsHtml}</tbody>
     </table>${statsHtml}${issueUrlsHtml}${dashboardHtml}${dashboardBackLinkHtml}`;

  const plainLines = services.map((s) => {
    const st = String(s.last_status || "UNKNOWN");
    const code = String(s.last_http_code || "-");
    const latency = String(s.last_latency_ms || "-");
    const t = String(s.last_check_at || "-");
    const isIssue = isUpEquivalentStatus_(st) ? "NO" : "YES";
    const portData  = portMap[String(s.name)];
    const openPorts = portData ? portData.open_ports : null;
    const portStr   = openPorts && openPorts.length ? openPorts.join(", ") : "—";
    return `- ${s.name} | ${st} | HTTP ${code} | ${latency} ms | Ports:${portStr} | ${t} | ISSUE:${isIssue}`;
  });

  let plain =
    `Service Monitor 狀態報告\n` +
    `監控站: ${monitorLabel}\n` +
    `時間: ${at}\n` +
    `啟用服務: ${services.length}, 正常: ${upCount}, 異常: ${issues.length}\n\n` +
    `所有服務列表:\n` +
    (plainLines.length ? plainLines.join("\n") : "(無啟用服務)");

  plain +=
    `\n\n=== 統計資料 ===\n` +
    `可用率: ${availabilityRate}%\n` +
    `平均延遲: ${avgLatency !== null ? avgLatency + " ms" : "N/A"}\n` +
    `P95 延遲: ${p95Latency !== null ? p95Latency + " ms" : "N/A"}\n` +
    `最小延遲: ${minLatency !== null ? minLatency + " ms" : "N/A"}\n` +
    `最大延遲: ${maxLatency !== null ? maxLatency + " ms" : "N/A"}`;

  if (dashboardUrl) {
    plain += `\n\n點一下回到 Dashboard:`;
    plain += `\n${dashboardUrl}`;
  }

  if (issues.length) {
    plain += `\n\n=== 異常偵測主機網址 ===`;
    issues.forEach((s) => {
      plain += `\n- ${s.name}: ${s.url}`;
    });
  }

  const channels = [];
  if (sendMail) {
    let mailResult = { channel: "mail", sent: true, target_count: recipients.length };
    try {
      GmailApp.sendEmail(recipients.join(","), subject, plain, { htmlBody: htmlBody });
    } catch (err) {
      mailResult = { channel: "mail", sent: false, target_count: recipients.length, error: String(err) };
    }
    channels.push(mailResult);
  }

  const shouldSendLine = cfg.notify_mode === "mail_line" || cfg.notify_mode === "all" || cfg.notify_mode === "line_only";
  const shouldSendTeams = cfg.notify_mode === "mail_teams" || cfg.notify_mode === "all";
  const shouldDispatchExtraChannels = forceSend || issues.length > 0;

  if (shouldDispatchExtraChannels && shouldSendLine) {
    channels.push(callNotifierSafe_("line", function () {
      return sendLineAlert_(cfg, subject, at, services, issues, dashboardUrl, monitorLabel, portMap);
    }));
  }
  if (shouldDispatchExtraChannels && shouldSendTeams) {
    channels.push(callNotifierSafe_("teams", function () {
      return sendTeamsAlert_(cfg, subject, at, services, issues, dashboardUrl, monitorLabel, portMap);
    }));
  }

  const sentCount = channels.filter(function (c) { return c && c.sent; }).length;
  const failedChannels = channels.filter(function (c) { return c && !c.sent && c.error; });
  const hadMailQuotaError = failedChannels.some(function (c) {
    return c.channel === "mail" && /次數過多|Limit exceeded|Service invoked too many times/i.test(String(c.error || ""));
  });

  return {
    ok: sentCount > 0,
    sent: sentCount > 0,
    partial: sentCount > 0 && failedChannels.length > 0,
    issues: issues.length,
    channels: channels,
    error: sentCount > 0 ? "" : (failedChannels[0] ? failedChannels[0].error : "All channels failed"),
    warning: hadMailQuotaError ? "Mail quota exceeded, fallback channels were used." : ""
  };
}

function callNotifierSafe_(channel, fn) {
  try {
    return fn();
  } catch (err) {
    return { channel: channel, sent: false, error: String(err) };
  }
}

function isConfirmedDownStatus_(status) {
  const value = String(status || "").toUpperCase();
  return value === "DOWN";
}

function isUpEquivalentStatus_(status) {
  var value = normalizeServiceStatus_(status);
  return value === "UP" || value === "UP-";
}

function sendStatusReport_(cfg, forceSend, now) {
  const sendMail = cfg.notify_mode !== "line_only";
  const recipients = parseRecipients_(cfg.recipients);
  const eventTime = now || new Date();
  const services = (listServices_().data || []).filter(function (item) { return toBool_(item.enabled); });
  const issues = services.filter(function (item) {
    return isConfirmedDownStatus_(item.last_status);
  });
  const upCount = services.length - issues.length;
  const shouldSendLine = cfg.notify_mode === "mail_line" || cfg.notify_mode === "all" || cfg.notify_mode === "line_only";
  const shouldSendTeams = cfg.notify_mode === "mail_teams" || cfg.notify_mode === "all";
  const shouldDispatchExtraChannels = forceSend || issues.length > 0;
  const shouldSendMailNow = sendMail && (forceSend || !cfg.only_on_issue || issues.length > 0);

  if (!shouldSendMailNow && !(shouldDispatchExtraChannels && (shouldSendLine || shouldSendTeams))) {
    return { ok: true, sent: false, skipped: "No issue" };
  }

  const tz = Session.getScriptTimeZone();
  const at = Utilities.formatDate(eventTime, tz, "yyyy-MM-dd HH:mm:ss");
  const statusLabel = issues.length > 0 ? "ALERT" : "OK";
  const monitorLabel = getMonitorLabel_(cfg);
  const subject = `[Service Monitor][${statusLabel}][${monitorLabel}] ${at}`;
  const logMeta = {
    now: eventTime,
    trigger: forceSend ? "manual" : "scheduled",
    statusLabel: statusLabel,
    issueCount: issues.length,
    serviceCount: services.length,
    subject: subject,
    recipients: recipients,
    warning: ""
  };

  if (shouldSendMailNow && !recipients.length) {
    const failedChannels = [{ channel: "mail", sent: false, error: "No recipients configured" }];
    appendNotificationLogs_(logMeta, failedChannels);
    return {
      ok: false,
      sent: false,
      partial: false,
      issues: issues.length,
      channels: failedChannels,
      error: "No recipients configured",
      warning: ""
    };
  }

  const portMap = readPortScansMap_();
  const latencyValues = services
    .map(function (item) { return Number(item.last_latency_ms); })
    .filter(function (value) { return Number.isFinite(value) && value >= 0; });
  const sortedLatency = latencyValues.slice().sort(function (a, b) { return a - b; });
  const avgLatency = sortedLatency.length
    ? Math.round(sortedLatency.reduce(function (sum, value) { return sum + value; }, 0) / sortedLatency.length)
    : null;
  const p95Latency = sortedLatency.length
    ? sortedLatency[Math.min(sortedLatency.length - 1, Math.floor((sortedLatency.length - 1) * 0.95))]
    : null;
  const minLatency = sortedLatency.length ? sortedLatency[0] : null;
  const maxLatency = sortedLatency.length ? sortedLatency[sortedLatency.length - 1] : null;
  const availabilityRate = services.length ? ((upCount / services.length) * 100).toFixed(1) : "0.0";
  const dashboardUrl = getDashboardUrl_();

  const allRowsHtml = services.length
    ? services.map(function (item) {
        const isIssue = !isUpEquivalentStatus_(item.last_status);
        const portData = portMap[String(item.name)];
        const openPorts = portData ? portData.open_ports : null;
        const portsCell = openPorts && openPorts.length
          ? `<span style="color:#0e7a6a;font-weight:600;">${openPorts.join(", ")}</span>`
          : `<span style="color:#999;">-</span>`;
        return `<tr>
          <td>${escapeHtml_(item.name)}</td>
          <td>${escapeHtml_(item.url)}</td>
          <td>${escapeHtml_(String(item.last_status || "UNKNOWN"))}</td>
          <td>${escapeHtml_(String(item.last_http_code || "-"))}</td>
          <td>${escapeHtml_(String(item.last_latency_ms || "-"))}</td>
          <td>${escapeHtml_(String(item.last_check_at || "-"))}</td>
          <td>${portsCell}</td>
          <td>${isIssue ? "YES" : "NO"}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="8">No enabled services</td></tr>`;

  const statsHtml = `
    <h3>Summary</h3>
    <ul>
      <li>Total services: ${services.length}</li>
      <li>UP: ${upCount}</li>
      <li>DOWN: ${issues.length}</li>
      <li>Availability: ${availabilityRate}%</li>
      <li>Average latency: ${avgLatency !== null ? avgLatency + " ms" : "N/A"}</li>
      <li>P95 latency: ${p95Latency !== null ? p95Latency + " ms" : "N/A"}</li>
      <li>Min latency: ${minLatency !== null ? minLatency + " ms" : "N/A"}</li>
      <li>Max latency: ${maxLatency !== null ? maxLatency + " ms" : "N/A"}</li>
    </ul>`;

  const issueUrlsHtml = issues.length
    ? `<hr><h3>Issue services</h3><ul style="margin:4px 0;padding-left:20px;">` +
      issues.map(function (item) {
        const name = escapeHtml_(item.name);
        const url = escapeHtml_(item.url);
        return `<li><strong>${name}</strong>: <a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a></li>`;
      }).join("") +
      `</ul>`
    : "";

  const dashboardHtml = dashboardUrl
    ? `<hr><p>Dashboard: <a href="${escapeHtml_(dashboardUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml_(dashboardUrl)}</a></p>`
    : "";

  const htmlBody = `
    <h2>Service Monitor Status Report</h2>
    <p><strong>Monitor:</strong> ${escapeHtml_(monitorLabel)}</p>
    <p><strong>Checked at:</strong> ${escapeHtml_(at)}</p>
    <p><strong>Services:</strong> ${services.length} / <strong>UP:</strong> ${upCount} / <strong>DOWN:</strong> ${issues.length}</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
      <thead>
        <tr><th>Name</th><th>URL</th><th>Status</th><th>HTTP</th><th>Latency(ms)</th><th>Last Check</th><th>Open Ports</th><th>Issue</th></tr>
      </thead>
      <tbody>${allRowsHtml}</tbody>
    </table>
    ${statsHtml}
    ${issueUrlsHtml}
    ${dashboardHtml}`;

  const plainLines = services.map(function (item) {
    const st = String(item.last_status || "UNKNOWN");
    const code = String(item.last_http_code || "-");
    const latency = String(item.last_latency_ms || "-");
    const checkedAt = String(item.last_check_at || "-");
    const portData = portMap[String(item.name)];
    const openPorts = portData ? portData.open_ports : null;
    const portStr = openPorts && openPorts.length ? openPorts.join(", ") : "-";
    const isIssue = isUpEquivalentStatus_(st) ? "NO" : "YES";
    return `- ${item.name} | ${st} | HTTP ${code} | ${latency} ms | Ports: ${portStr} | ${checkedAt} | ISSUE: ${isIssue}`;
  });

  let plain = [
    "Service Monitor Status Report",
    `Monitor: ${monitorLabel}`,
    `Checked at: ${at}`,
    `Services: ${services.length}`,
    `UP: ${upCount}`,
    `DOWN: ${issues.length}`,
    "",
    "Service List:",
    plainLines.length ? plainLines.join("\n") : "(No enabled services)",
    "",
    "Summary:",
    `Availability: ${availabilityRate}%`,
    `Average latency: ${avgLatency !== null ? avgLatency + " ms" : "N/A"}`,
    `P95 latency: ${p95Latency !== null ? p95Latency + " ms" : "N/A"}`,
    `Min latency: ${minLatency !== null ? minLatency + " ms" : "N/A"}`,
    `Max latency: ${maxLatency !== null ? maxLatency + " ms" : "N/A"}`
  ].join("\n");

  if (dashboardUrl) {
    plain += `\n\nDashboard:\n${dashboardUrl}`;
  }
  if (issues.length) {
    plain += `\n\nIssue services:`;
    issues.forEach(function (item) {
      plain += `\n- ${item.name}: ${item.url}`;
    });
  }

  const channels = [];
  if (shouldSendMailNow) {
    let mailResult = { channel: "mail", sent: true, target_count: recipients.length };
    try {
      GmailApp.sendEmail(recipients.join(","), subject, plain, { htmlBody: htmlBody });
    } catch (err) {
      mailResult = { channel: "mail", sent: false, target_count: recipients.length, error: String(err) };
    }
    channels.push(mailResult);
  }

  if (shouldDispatchExtraChannels && shouldSendLine) {
    channels.push(callNotifierSafe_("line", function () {
      return sendLineAlert_(cfg, subject, at, services, issues, dashboardUrl, monitorLabel, portMap);
    }));
  }
  if (shouldDispatchExtraChannels && shouldSendTeams) {
    channels.push(callNotifierSafe_("teams", function () {
      return sendTeamsAlert_(cfg, subject, at, services, issues, dashboardUrl, monitorLabel, portMap);
    }));
  }

  const sentCount = channels.filter(function (item) { return item && item.sent; }).length;
  const failedChannels = channels.filter(function (item) { return item && !item.sent && item.error; });
  const hadMailQuotaError = failedChannels.some(function (item) {
    return item.channel === "mail" && /次數過多|Limit exceeded|Service invoked too many times/i.test(String(item.error || ""));
  });

  logMeta.warning = hadMailQuotaError ? "Mail quota exceeded, fallback channels were used." : "";
  appendNotificationLogs_(logMeta, channels);

  return {
    ok: sentCount > 0,
    sent: sentCount > 0,
    partial: sentCount > 0 && failedChannels.length > 0,
    issues: issues.length,
    channels: channels,
    error: sentCount > 0 ? "" : (failedChannels[0] ? failedChannels[0].error : "All channels failed"),
    warning: logMeta.warning
  };
}

function buildAlertText_(subject, at, services, issues, dashboardUrl, monitorLabel, portMap) {
  var pm = portMap || {};
  const lines = [
    subject,
    `監控站: ${monitorLabel || 'Service Monitor'}`,
    `時間: ${at}`,
    `啟用服務: ${services.length}`,
    `異常數: ${issues.length}`
  ];
  if (issues.length) {
    lines.push("異常服務:");
    issues.slice(0, 10).forEach((s) => {
      const portData  = pm[String(s.name || "")];
      const openPorts = portData ? portData.open_ports : null;
      const portStr   = openPorts && openPorts.length ? openPorts.join(", ") : "—";
      lines.push(`- ${s.name || "(未命名)"} | ${String(s.last_status || "UNKNOWN")} | HTTP ${String(s.last_http_code || "-")} | Ports: ${portStr}`);
      if (s.url) lines.push(`  ${s.url}`);
    });
    if (issues.length > 10) {
      lines.push(`...其餘 ${issues.length - 10} 筆請看 Dashboard`);
    }
  } else {
    lines.push("目前無異常服務");
  }
  if (dashboardUrl) {
    lines.push("");
    lines.push("點一下回到 Dashboard:");
    lines.push(dashboardUrl);
  }
  if (issues.length) {
    lines.push("");
    lines.push("偵測主機網址:");
    issues.slice(0, 10).forEach((s) => {
      lines.push(`- ${s.name || "(未命名)"}: ${s.url || "(無網址)"}`);
    });
  }
  return lines.join("\n");
}

function getRecordedLineUserTargets_() {
  const recorded = getLineTargets_();
  const users = recorded
    .map(function (item) {
      const id = String((item && item.target_id) || "").trim();
      if (!id) return "";
      const type = String((item && (item.target_type || item.source_type)) || inferLineToType_(id)).toLowerCase();
      return type === "user" ? id : "";
    })
    .filter(function (id) { return !!id; });
  return dedupeLineTargets_(users);
}

function resolveLineNotifyTargets_(cfg, options) {
  const opts = options || {};
  const hasOverride = Object.prototype.hasOwnProperty.call(opts, "overrideTo");
  const baseRaw = hasOverride ? opts.overrideTo : (cfg && cfg.line_to);
  const configuredTargets = parseLineTargets_(baseRaw);
  const includeRecordedUsers = opts.includeRecordedUsers !== false;
  const recordedUsers = includeRecordedUsers ? getRecordedLineUserTargets_() : [];
  return dedupeLineTargets_(recordedUsers.concat(configuredTargets));
}

function sendLineAlert_(cfg, subject, at, services, issues, dashboardUrl, monitorLabel, portMap) {
  if (!cfg.line_channel_access_token) {
    return { channel: "line", sent: false, skipped: "LINE token 未設定" };
  }

  const targets = resolveLineNotifyTargets_(cfg);
  if (!targets.length) {
    return { channel: "line", sent: false, skipped: "尚無可通知的 LINE User（請先讓使用者對 Bot 發訊息）" };
  }

  const text = truncateText_(buildAlertText_(subject, at, services, issues, dashboardUrl, monitorLabel, portMap), 4800);
  const results = targets.map(function (target) {
    return sendLinePushSingle_(cfg.line_channel_access_token, target, text);
  });
  const successCount = results.filter(function (r) { return r && r.sent; }).length;
  const failed = results.filter(function (r) { return !r || !r.sent; });

  if (successCount === results.length) {
    return {
      channel: "line",
      sent: true,
      target_count: results.length,
      user_target_count: targets.filter(function (t) { return inferLineToType_(t) === "user"; }).length,
      results: results
    };
  }
  return {
    channel: "line",
    sent: successCount > 0,
    partial: successCount > 0,
    target_count: results.length,
    user_target_count: targets.filter(function (t) { return inferLineToType_(t) === "user"; }).length,
    success_count: successCount,
    failed_count: failed.length,
    results: results,
    error: failed.length
      ? failed.map(function (r) {
          return `${r.target}: ${r.error || "failed"}`;
        }).join(" | ")
      : ""
  };
}

function sendTeamsAlert_(cfg, subject, at, services, issues, dashboardUrl, monitorLabel, portMap) {
  if (!cfg.teams_webhook_url) {
    return { channel: "teams", sent: false, skipped: "Teams webhook 未設定" };
  }

  const text = buildAlertText_(subject, at, services, issues, dashboardUrl, monitorLabel, portMap);
  const payload = {
    title: subject,
    text: text
  };

  const resp = UrlFetchApp.fetch(cfg.teams_webhook_url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = Number(resp.getResponseCode() || 0);
  if (code >= 200 && code < 300) return { channel: "teams", sent: true };
  return {
    channel: "teams",
    sent: false,
    error: `Teams webhook 回應 ${code}: ${truncateText_(resp.getContentText() || "", 300)}`
  };
}

function debugLineTarget_(payload) {
  const cfg = getReportConfig_();
  const hasOverride = payload && Object.prototype.hasOwnProperty.call(payload, "line_to");
  const targets = resolveLineNotifyTargets_(cfg, {
    overrideTo: hasOverride ? payload.line_to : cfg.line_to,
    includeRecordedUsers: !hasOverride
  });
  const token = String(cfg.line_channel_access_token || "").trim();

  if (!token) return { ok: false, error: "LINE token 未設定 (line_channel_access_token)" };
  if (!targets.length) return { ok: false, error: "尚無可通知的 LINE User（請先讓使用者對 Bot 發訊息）" };

  const tz = Session.getScriptTimeZone();
  const at = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm:ss");
  const text = `LINE debug test ${at}`;
  const results = targets.map(function (target) {
    return sendLinePushSingle_(token, target, text);
  });
  const acceptedCount = results.filter(function (r) { return r && r.sent; }).length;
  const accepted = acceptedCount > 0;

  return {
    ok: accepted,
    action: "debugLineTarget",
    accepted: accepted,
    target_count: targets.length,
    accepted_count: acceptedCount,
    failed_count: targets.length - acceptedCount,
    line_to: targets,
    line_to_types: targets.map(function (t) { return { target: t, type: inferLineToType_(t) }; }),
    token_preview: tokenPreview_(token),
    notify_mode: cfg.notify_mode,
    request_payload_preview: {
      to: targets,
      message_text: text
    },
    results: results,
    trace: {
      checked_at: at
    }
  };
}

function sendLinePushSingle_(token, target, text) {
  const reqBody = {
    to: target,
    messages: [{ type: "text", text: text }]
  };

  let resp;
  try {
    resp = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify(reqBody),
      muteHttpExceptions: true
    });
  } catch (err) {
    return {
      target: target,
      target_type: inferLineToType_(target),
      sent: false,
      status: 0,
      error: "LINE API request failed: " + String(err)
    };
  }

  const status = Number(resp.getResponseCode() || 0);
  const bodyText = String(resp.getContentText() || "");
  const headers = resp.getAllHeaders ? resp.getAllHeaders() : {};
  const requestId = pickHeader_(headers, "x-line-request-id");
  const sent = status >= 200 && status < 300;
  return {
    target: target,
    target_type: inferLineToType_(target),
    sent: sent,
    status: status,
    response_body: truncateText_(bodyText, 800),
    response_headers: headers,
    line_request_id: requestId || "",
    error: sent ? "" : `LINE API 回應 ${status}: ${truncateText_(bodyText, 300)}`
  };
}

function lineWebhook_(payload) {
  const events = (payload && Array.isArray(payload.events)) ? payload.events : [];
  if (!events.length) {
    return { ok: true, received_events: 0, recorded: 0, data: getLineTargets_() };
  }

  const current = getLineTargets_();
  const map = {};
  current.forEach(function (item) {
    if (!item || !item.target_id) return;
    map[String(item.target_id)] = item;
  });

  var recorded = 0;
  events.forEach(function (ev) {
    const source = (ev && ev.source) || {};
    const targetId = String(source.groupId || source.roomId || source.userId || "").trim();
    if (!targetId) return;

    const targetType = String(source.type || inferLineToType_(targetId));
    const eventTs = Number(ev && ev.timestamp);
    const updatedAt = Number.isFinite(eventTs) ? new Date(eventTs).toISOString() : new Date().toISOString();
    const text = ev && ev.message && ev.message.type === "text"
      ? truncateText_(String(ev.message.text || ""), 200)
      : "";

    map[targetId] = {
      target_id: targetId,
      target_type: targetType,
      user_id: String(source.userId || ""),
      group_id: String(source.groupId || ""),
      room_id: String(source.roomId || ""),
      last_event_type: String((ev && ev.type) || ""),
      last_message_text: text,
      updated_at: updatedAt
    };
    recorded += 1;
  });

  const merged = Object.keys(map).map(function (k) { return map[k]; });
  merged.sort(function (a, b) {
    const ta = new Date(a.updated_at || 0).getTime();
    const tb = new Date(b.updated_at || 0).getTime();
    return tb - ta;
  });
  const trimmed = merged.slice(0, 200);
  PropertiesService.getScriptProperties().setProperty(PROP_LINE_TARGETS, JSON.stringify(trimmed));

  return {
    ok: true,
    received_events: events.length,
    recorded: recorded,
    data: trimmed.slice(0, 20)
  };
}

function getLineTargets_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_LINE_TARGETS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function getLineTargetSummary_() {
  const all = getLineTargets_();
  const counts = {
    user: 0,
    group: 0,
    room: 0,
    unknown: 0
  };

  all.forEach(function (item) {
    const id = String((item && item.target_id) || "").trim();
    if (!id) return;
    const type = String((item && (item.target_type || item.source_type)) || inferLineToType_(id)).toLowerCase();
    if (type === "user") counts.user += 1;
    else if (type === "group") counts.group += 1;
    else if (type === "room") counts.room += 1;
    else counts.unknown += 1;
  });

  const cfg = getReportConfig_();
  const notifyTargets = resolveLineNotifyTargets_(cfg);
  const notifyUserCount = notifyTargets.filter(function (t) { return inferLineToType_(t) === "user"; }).length;

  return {
    total: all.length,
    user_count: counts.user,
    group_count: counts.group,
    room_count: counts.room,
    unknown_count: counts.unknown,
    notify_target_count: notifyTargets.length,
    notify_user_count: notifyUserCount
  };
}

/*************** Dashboard URL Capture ***************/
function captureDashboardUrlFromParams_(p) {
  const url = normalizeDashboardUrl_(p && (p.dashboard_url || p.dashboardUrl));
  if (!url) return;
  PropertiesService.getScriptProperties().setProperty(PROP_DASHBOARD_URL, url);
}

function captureDashboardUrlFromPayload_(body) {
  const url = normalizeDashboardUrl_(body && (body.dashboard_url || body.dashboardUrl));
  if (!url) return;
  PropertiesService.getScriptProperties().setProperty(PROP_DASHBOARD_URL, url);
}

function getDashboardUrl_() {
  return String(PropertiesService.getScriptProperties().getProperty(PROP_DASHBOARD_URL) || "").trim();
}

function normalizeDashboardUrl_(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (!/^https?:\/\//i.test(s)) return "";
  try {
    const u = new URL(s);
    u.hash = "";
    return u.toString();
  } catch (_) {
    return "";
  }
}

/*************** Utils ***************/
function authOk_(p) {
  if (!API_KEY) return true;
  return p && String(p.key || "") === API_KEY;
}

function toNum_(v, defVal) {
  const n = Number(v);
  return Number.isFinite(n) ? n : defVal;
}

function toBool_(v) {
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function normalizeYmd_(v, tz) {
  if (v === null || v === undefined || v === "") return "";
  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, tz, "yyyy-MM-dd");
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, tz, "yyyy-MM-dd");
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d2 = new Date(s);
  if (!isNaN(d2.getTime())) return Utilities.formatDate(d2, tz, "yyyy-MM-dd");
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function normalizeLineToConfig_(raw) {
  if (Array.isArray(raw)) {
    return raw.map(function (v) { return String(v || "").trim(); }).filter(function (v) { return v; }).join(",");
  }
  return String(raw || "").trim();
}

function parseLineTargets_(raw) {
  if (Array.isArray(raw)) {
    return dedupeLineTargets_(raw.map(function (v) { return String(v || "").trim(); }));
  }

  const text = String(raw || "").trim();
  if (!text) return [];

  if (text[0] === "[") {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return dedupeLineTargets_(parsed.map(function (v) { return String(v || "").trim(); }));
      }
    } catch (_) {
      // Fallback to delimiter parsing below.
    }
  }

  const parts = text.split(/[\s,;]+/).map(function (s) { return s.trim(); });
  return dedupeLineTargets_(parts);
}

function dedupeLineTargets_(items) {
  const out = [];
  const seen = {};
  items.forEach(function (v) {
    if (!v || seen[v]) return;
    seen[v] = true;
    out.push(v);
  });
  return out;
}

function indexMap_(header) {
  const m = {};
  header.forEach((h, i) => { m[String(h)] = i; });
  return m;
}

function objFromRow_(header, row) {
  const o = {};
  header.forEach((h, i) => { o[h] = row[i]; });
  return o;
}

function rowFromObj_(header, obj) {
  return header.map((h) => (Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : ""));
}

function output_(callback, obj) {
  if (callback) {
    return ContentService
      .createTextOutput(callback + "(" + JSON.stringify(obj) + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return jsonOut_(obj);
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function escapeHtml_(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeJsonStringify_(value) {
  try {
    return JSON.stringify(value || {});
  } catch (_) {
    return "{}";
  }
}

function truncateText_(s, maxLen) {
  const text = String(s || "");
  const limit = Math.max(1, Number(maxLen) || 1);
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 3)) + "...";
}

function tokenPreview_(token) {
  const t = String(token || "");
  if (!t) return "";
  if (t.length <= 10) return "***";
  return t.slice(0, 6) + "..." + t.slice(-4);
}

function inferLineToType_(to) {
  const s = String(to || "");
  if (/^U[0-9a-fA-F]{10,}$/.test(s)) return "user";
  if (/^C[0-9a-fA-F]{10,}$/.test(s)) return "group";
  if (/^R[0-9a-fA-F]{10,}$/.test(s)) return "room";
  return "unknown";
}

function pickHeader_(headers, key) {
  if (!headers || !key) return "";
  const target = String(key).toLowerCase();
  const keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (String(k).toLowerCase() === target) return String(headers[k] || "");
  }
  return "";
}
