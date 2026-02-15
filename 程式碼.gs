/*********************************
 * Service Monitor API (JSONP + Gmail report)
 * - 401/403 視為 UP
 * - 郵件內容包含所有啟用服務
 * - only_on_issue=true 時：有異常就每次 runScheduler 都寄
 * - deleteTestDataByDate: 刪除 checks 中指定日期的所有資料（不看 is_test）
 * - Dashboard URL: 動態由前端帶入 dashboard_url 並儲存，寄信 footer 自動附上
 *********************************/
const SHEET_SERVICES = "services";
const SHEET_CHECKS = "checks";
const API_KEY = "";

const PROP_REPORT_CONFIG = "REPORT_CONFIG";
const PROP_REPORT_LAST_SLOT = "REPORT_LAST_SLOT";
const PROP_DASHBOARD_URL = "DASHBOARD_URL";
const PROP_LINE_TARGETS = "LINE_TARGETS";

const TEST_DELETE_DEFAULT_SHEET = SHEET_CHECKS;

const SERVICE_HEADERS = [
  "id", "name", "url", "interval_min", "enabled",
  "last_check_at", "last_status", "last_http_code", "last_latency_ms",
  "next_check_at", "created_at", "updated_at"
];

const CHECK_HEADERS = [
  "timestamp", "service_id", "status", "http_code", "latency_ms", "error"
];

function initSheets() {
  const ss = SpreadsheetApp.getActive();

  let s1 = ss.getSheetByName(SHEET_SERVICES);
  if (!s1) s1 = ss.insertSheet(SHEET_SERVICES);
  ensureHeaders_(s1, SERVICE_HEADERS);

  let s2 = ss.getSheetByName(SHEET_CHECKS);
  if (!s2) s2 = ss.insertSheet(SHEET_CHECKS);
  ensureHeaders_(s2, CHECK_HEADERS);
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
          interval_min: toNum_(p.interval_min, 5)
        });
        break;
      case "updateService":
        result = updateService_({
          id: p.id,
          name: p.name,
          url: p.url,
          interval_min: p.interval_min !== undefined ? toNum_(p.interval_min, 5) : undefined,
          enabled: p.enabled !== undefined ? toBool_(p.enabled) : undefined
        });
        break;
      case "deleteService":
        result = deleteService_(p.id);
        break;
      case "deleteTestDataByDate":
        result = deleteTestDataByDate_(p);
        break;
      case "runNow":
        runScheduler();
        result = { ok: true };
        break;
      case "getReportConfig":
        result = { ok: true, data: getReportConfig_() };
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
        runScheduler();
        result = { ok: true };
        break;
      case "getReportConfig":
        result = { ok: true, data: getReportConfig_() };
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
      default:
        result = { ok: false, error: "Unknown action" };
    }

    return jsonOut_(result);
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function runScheduler() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    const now = new Date();
    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SERVICES);
    const values = sh.getDataRange().getValues();
    if (values.length < 2) {
      maybeSendScheduledReport_(now);
      return;
    }

    const idx = indexMap_(values[0]);
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      if (!toBool_(row[idx.enabled])) continue;

      const nextCheck = row[idx.next_check_at] ? new Date(row[idx.next_check_at]) : new Date(0);
      if (nextCheck.getTime() > now.getTime()) continue;

      const id = row[idx.id];
      const url = row[idx.url];
      const intervalMin = Math.max(1, toNum_(row[idx.interval_min], 5));

      const result = checkUrl_(url);
      appendCheckLog_(id, result);

      const next = new Date(now.getTime() + intervalMin * 60000);
      sh.getRange(r + 1, idx.last_check_at + 1).setValue(now);
      sh.getRange(r + 1, idx.last_status + 1).setValue(result.status);
      sh.getRange(r + 1, idx.last_http_code + 1).setValue(result.httpCode);
      sh.getRange(r + 1, idx.last_latency_ms + 1).setValue(result.latencyMs);
      sh.getRange(r + 1, idx.next_check_at + 1).setValue(next);
      sh.getRange(r + 1, idx.updated_at + 1).setValue(now);
    }

    maybeSendScheduledReport_(now);
  } finally {
    lock.releaseLock();
  }
}

function checkUrl_(url) {
  const start = Date.now();
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    const code = resp.getResponseCode();
    const latency = Date.now() - start;
    const up = (code >= 200 && code < 400) || code === 401 || code === 403;
    return { status: up ? "UP" : "DOWN", httpCode: code, latencyMs: latency, error: "" };
  } catch (err) {
    return { status: "DOWN", httpCode: 0, latencyMs: Date.now() - start, error: String(err) };
  }
}

/*************** Service CRUD ***************/
function addService_(b) {
  if (!b || !b.url) return { ok: false, error: "Missing url" };

  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SERVICES);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  const now = new Date();
  const id = Utilities.getUuid();
  const rowObj = {
    id: id,
    name: b.name || b.url,
    url: b.url,
    interval_min: Math.max(1, toNum_(b.interval_min, 5)),
    enabled: true,
    last_check_at: "",
    last_status: "",
    last_http_code: "",
    last_latency_ms: "",
    next_check_at: now,
    created_at: now,
    updated_at: now
  };

  sh.appendRow(rowFromObj_(header, rowObj));
  return { ok: true, id: id };
}

function updateService_(b) {
  if (!b || !b.id) return { ok: false, error: "Missing id" };

  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SERVICES);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return { ok: false, error: "No data" };
  const idx = indexMap_(values[0]);

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idx.id]) !== String(b.id)) continue;

    if (b.name !== undefined) sh.getRange(r + 1, idx.name + 1).setValue(b.name);
    if (b.url !== undefined) sh.getRange(r + 1, idx.url + 1).setValue(b.url);
    if (b.interval_min !== undefined) sh.getRange(r + 1, idx.interval_min + 1).setValue(Math.max(1, toNum_(b.interval_min, 5)));
    if (b.enabled !== undefined) sh.getRange(r + 1, idx.enabled + 1).setValue(!!b.enabled);
    sh.getRange(r + 1, idx.updated_at + 1).setValue(new Date());
    return { ok: true };
  }

  return { ok: false, error: "Not found" };
}

function deleteService_(id) {
  if (!id) return { ok: false, error: "Missing id" };
  return updateService_({ id: id, enabled: false });
}

function listServices_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_SERVICES);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return { ok: true, data: [] };
  const header = values[0];
  return { ok: true, data: values.slice(1).map((r) => objFromRow_(header, r)) };
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

function appendCheckLog_(serviceId, result) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CHECKS);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rowObj = {
    timestamp: new Date(),
    service_id: serviceId,
    status: result.status,
    http_code: result.httpCode,
    latency_ms: result.latencyMs,
    error: result.error || ""
  };
  sh.appendRow(rowFromObj_(header, rowObj));
}

/*************** Delete By Date (ignore is_test) ***************/
function deleteTestDataByDate_(payload) {
  const date = String((payload && payload.date) || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "Invalid date, expected YYYY-MM-DD" };
  }

  const sheetName = String((payload && payload.sheet) || TEST_DELETE_DEFAULT_SHEET).trim();
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sh) return { ok: false, error: "Sheet not found: " + sheetName };

  const values = sh.getDataRange().getValues();
  if (values.length < 2) {
    return { ok: true, data: { date, sheet: sheetName, mode: "all_by_date", matched_date_count: 0, deleted_count: 0 } };
  }

  const header = values[0];
  const idx = indexMap_(header);
  if (idx.timestamp === undefined) return { ok: false, error: "Missing timestamp column in checks sheet" };

  const tz = Session.getScriptTimeZone();
  const kept = [header];
  let matchedDateCount = 0;

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const ymd = normalizeYmd_(row[idx.timestamp], tz);
    if (ymd === date) {
      matchedDateCount++;
    } else {
      kept.push(row);
    }
  }

  if (matchedDateCount > 0) {
    sh.clearContents();
    sh.getRange(1, 1, kept.length, header.length).setValues(kept);
  }

  return {
    ok: true,
    data: {
      date,
      sheet: sheetName,
      mode: "all_by_date",
      matched_date_count: matchedDateCount,
      deleted_count: matchedDateCount
    }
  };
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
    teams_webhook_url: ""
  };
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
  return out;
}

function updateReportConfig_(payload) {
  const cfg = normalizeReportConfig_({
    recipients: payload.recipients,
    frequency: payload.frequency,
    daily_hour: payload.daily_hour,
    enabled: payload.enabled,
    only_on_issue: payload.only_on_issue,
    notify_mode: payload.notify_mode,
    line_channel_access_token: payload.line_channel_access_token,
    line_to: payload.line_to,
    teams_webhook_url: payload.teams_webhook_url
  });

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
  return { ok: true, data: cfg };
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

function sendStatusReport_(cfg, forceSend, now) {
  const sendMail = cfg.notify_mode !== "line_only";
  const recipients = parseRecipients_(cfg.recipients);
  if (sendMail && !recipients.length) return { ok: false, error: "No recipients configured" };

  const services = (listServices_().data || []).filter((s) => toBool_(s.enabled));
  const issues = services.filter((s) => String(s.last_status || "").toUpperCase() !== "UP");
  const upCount = services.length - issues.length;

  if (!forceSend && cfg.only_on_issue && issues.length === 0) {
    return { ok: true, sent: false, skipped: "No issue" };
  }

  const tz = Session.getScriptTimeZone();
  const at = Utilities.formatDate(now, tz, "yyyy-MM-dd HH:mm:ss");
  const statusLabel = issues.length > 0 ? "ALERT" : "OK";
  const subject = `[Service Monitor][${statusLabel}] ${at}`;
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
        const isIssue = String(s.last_status || "").toUpperCase() !== "UP";
        return `<tr>
          <td>${escapeHtml_(s.name)}</td>
          <td>${escapeHtml_(s.url)}</td>
          <td>${escapeHtml_(String(s.last_status || "UNKNOWN"))}</td>
          <td>${escapeHtml_(String(s.last_http_code || "-"))}</td>
          <td>${escapeHtml_(String(s.last_latency_ms || "-"))}</td>
          <td>${escapeHtml_(String(s.last_check_at || "-"))}</td>
          <td>${isIssue ? "YES" : "NO"}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7">目前沒有啟用服務</td></tr>`;

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

  const htmlBody =
    `<h2>Service Monitor 狀態報告</h2>
     <p>時間：${escapeHtml_(at)}</p>
     <p>啟用服務：${services.length}，正常：${upCount}，異常：${issues.length}</p>
     <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
       <thead><tr><th>服務</th><th>URL</th><th>狀態</th><th>HTTP</th><th>延遲(ms)</th><th>最後檢查</th><th>是否異常</th></tr></thead>
       <tbody>${allRowsHtml}</tbody>
     </table>${statsHtml}${dashboardHtml}${dashboardBackLinkHtml}`;

  const plainLines = services.map((s) => {
    const st = String(s.last_status || "UNKNOWN");
    const code = String(s.last_http_code || "-");
    const latency = String(s.last_latency_ms || "-");
    const t = String(s.last_check_at || "-");
    const isIssue = st.toUpperCase() !== "UP" ? "YES" : "NO";
    return `- ${s.name} | ${st} | HTTP ${code} | ${latency} ms | ${t} | ISSUE:${isIssue}`;
  });

  let plain =
    `Service Monitor 狀態報告\n` +
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

  const channels = [];
  if (sendMail) {
    let mailResult = { channel: "mail", sent: true };
    try {
      GmailApp.sendEmail(recipients.join(","), subject, plain, { htmlBody: htmlBody });
    } catch (err) {
      mailResult = { channel: "mail", sent: false, error: String(err) };
    }
    channels.push(mailResult);
  }

  const shouldSendLine = cfg.notify_mode === "mail_line" || cfg.notify_mode === "all" || cfg.notify_mode === "line_only";
  const shouldSendTeams = cfg.notify_mode === "mail_teams" || cfg.notify_mode === "all";
  const shouldDispatchExtraChannels = forceSend || issues.length > 0;

  if (shouldDispatchExtraChannels && shouldSendLine) {
    channels.push(callNotifierSafe_("line", function () {
      return sendLineAlert_(cfg, subject, at, services, issues, dashboardUrl);
    }));
  }
  if (shouldDispatchExtraChannels && shouldSendTeams) {
    channels.push(callNotifierSafe_("teams", function () {
      return sendTeamsAlert_(cfg, subject, at, services, issues, dashboardUrl);
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

function buildAlertText_(subject, at, services, issues, dashboardUrl) {
  const lines = [
    subject,
    `時間: ${at}`,
    `啟用服務: ${services.length}`,
    `異常數: ${issues.length}`
  ];
  if (issues.length) {
    lines.push("異常服務:");
    issues.slice(0, 10).forEach((s) => {
      lines.push(`- ${s.name || s.url || "(未命名)"} | ${String(s.last_status || "UNKNOWN")} | HTTP ${String(s.last_http_code || "-")}`);
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

function sendLineAlert_(cfg, subject, at, services, issues, dashboardUrl) {
  if (!cfg.line_channel_access_token) {
    return { channel: "line", sent: false, skipped: "LINE token 未設定" };
  }

  const targets = resolveLineNotifyTargets_(cfg);
  if (!targets.length) {
    return { channel: "line", sent: false, skipped: "尚無可通知的 LINE User（請先讓使用者對 Bot 發訊息）" };
  }

  const text = truncateText_(buildAlertText_(subject, at, services, issues, dashboardUrl), 4800);
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

function sendTeamsAlert_(cfg, subject, at, services, issues, dashboardUrl) {
  if (!cfg.teams_webhook_url) {
    return { channel: "teams", sent: false, skipped: "Teams webhook 未設定" };
  }

  const text = buildAlertText_(subject, at, services, issues, dashboardUrl);
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
