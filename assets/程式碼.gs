/*********************************
 * Service Monitor API (JSONP + Gmail report)
 * - 401/403 視為 UP
 * - 郵件內容包含所有啟用服務
 * - only_on_issue=true 時：有異常就每次 runScheduler 都寄
 * - deleteTestDataByDate: 刪除 checks 中指定日期的所有資料（不看 is_test）
 *********************************/
const SHEET_SERVICES = "services";
const SHEET_CHECKS = "checks";
const API_KEY = "";

const PROP_REPORT_CONFIG = "REPORT_CONFIG";
const PROP_REPORT_LAST_SLOT = "REPORT_LAST_SLOT";
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
    if (!authOk_(body)) return jsonOut_({ ok: false, error: "Unauthorized" });

    const action = (body.action || "").trim();
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
  return { recipients: "", frequency: "hourly", daily_hour: 9, enabled: true, only_on_issue: true };
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
  out.frequency = out.frequency === "daily" ? "daily" : "hourly";
  out.daily_hour = Math.min(23, Math.max(0, toNum_(out.daily_hour, 9)));
  out.enabled = toBool_(out.enabled);
  out.only_on_issue = toBool_(out.only_on_issue);
  out.recipients = String(out.recipients || "").trim();
  return out;
}

function updateReportConfig_(payload) {
  const cfg = normalizeReportConfig_({
    recipients: payload.recipients,
    frequency: payload.frequency,
    daily_hour: payload.daily_hour,
    enabled: payload.enabled,
    only_on_issue: payload.only_on_issue
  });

  if (!cfg.recipients) return { ok: false, error: "Recipients required" };
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
  const recipients = parseRecipients_(cfg.recipients);
  if (!recipients.length) return { ok: false, error: "No recipients configured" };

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

  const htmlBody =
    `<h2>Service Monitor 狀態報告</h2>
     <p>時間：${escapeHtml_(at)}</p>
     <p>啟用服務：${services.length}，正常：${upCount}，異常：${issues.length}</p>
     <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
       <thead><tr><th>服務</th><th>URL</th><th>狀態</th><th>HTTP</th><th>延遲(ms)</th><th>最後檢查</th><th>是否異常</th></tr></thead>
       <tbody>${allRowsHtml}</tbody>
     </table>`;

  const plainLines = services.map((s) => {
    const st = String(s.last_status || "UNKNOWN");
    const code = String(s.last_http_code || "-");
    const latency = String(s.last_latency_ms || "-");
    const t = String(s.last_check_at || "-");
    const isIssue = st.toUpperCase() !== "UP" ? "YES" : "NO";
    return `- ${s.name} | ${st} | HTTP ${code} | ${latency} ms | ${t} | ISSUE:${isIssue}`;
  });

  const plain =
    `Service Monitor 狀態報告\n` +
    `時間: ${at}\n` +
    `啟用服務: ${services.length}, 正常: ${upCount}, 異常: ${issues.length}\n\n` +
    `所有服務列表:\n` +
    (plainLines.length ? plainLines.join("\n") : "(無啟用服務)");

  GmailApp.sendEmail(recipients.join(","), subject, plain, { htmlBody: htmlBody });
  return { ok: true, sent: true, issues: issues.length };
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
