import { apiGet, apiPost, safeText, escapeHtml as escapeHtmlText, loadHostBadge, fmtDate, serviceCheckModeBadge, serviceCheckModeDetail } from './common.js?v=20260315-a041';

const addForm = document.getElementById('addForm');
const addMessage = document.getElementById('addMessage');
const adminBody = document.getElementById('adminServicesBody');
const adminMessage = document.getElementById('adminMessage');
const reloadBtn = document.getElementById('reloadBtn');
const runNowBtn = document.getElementById('runNowBtn');
const probesBody = document.getElementById('adminProbesBody');
const probesMessage = document.getElementById('probesMessage');
const reloadProbesBtn = document.getElementById('reloadProbesBtn');
const reportForm = document.getElementById('reportForm');
const reportMessage = document.getElementById('reportMessage');
const reloadReportBtn = document.getElementById('reloadReportBtn');
const sendReportNowBtn = document.getElementById('sendReportNowBtn');
const portScanConfigForm = document.getElementById('portScanConfigForm');
const portScanConfigMessage = document.getElementById('portScanConfigMessage');
const portScanRequestLog = document.getElementById('portScanRequestLog');
const reloadPortScanConfigBtn = document.getElementById('reloadPortScanConfigBtn');
const triggerPortScanBtn = document.getElementById('triggerPortScanBtn');
const misplacedStartPortScanBtn = document.getElementById('startPortScanBtn');
const deleteTestDataForm = document.getElementById('deleteTestDataForm');
const deleteTestDataMessage = document.getElementById('deleteTestDataMessage');
const deleteTestDataDateSelect = document.getElementById('deleteTestDataDateSelect');
const deleteTestDataDatesInfo = document.getElementById('deleteTestDataDatesInfo');
const reloadDeleteDatesBtn = document.getElementById('reloadDeleteDatesBtn');
const deleteTestDataSubmitBtn = document.getElementById('deleteTestDataSubmitBtn');
const deleteProgressWrap = document.getElementById('deleteProgressWrap');
const deleteProgressBar = document.getElementById('deleteProgressBar');
const deleteProgressPct = document.getElementById('deleteProgressPct');
const lineUserStats = document.getElementById('lineUserStats');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingLabel = document.getElementById('loadingLabel');
const loadingPercent = document.getElementById('loadingPercent');
const loadingBarInner = document.getElementById('loadingBarInner');

const CLICK_LOADING_MIN_MS = 380;
const DATES_CACHE_KEY = 'monitor_checks_dates_v1';
const DATES_CACHE_TTL_MS = 5 * 60 * 1000;
const PORT_SCAN_WATCH_INTERVAL_MS = 3000;
const PORT_SCAN_WATCH_TIMEOUT_MS = 180000;
const PORT_SCAN_LOG_LIMIT = 60;

let services = [];
let probes = [];
let firstLoadPending = true;
let deleteProgressTimer = null;
let deleteProgressValue = 0;
let portScanWatchToken = 0;
let portScanLogLines = [];
const PROBE_ONLINE_WINDOW_MS = 3 * 60 * 1000;

if (misplacedStartPortScanBtn) {
  misplacedStartPortScanBtn.remove();
}

function normalizeService(rawService) {
  const service = Object.assign({}, serviceDefaults(), rawService || {});
  service.id = safeText(service.id || '');
  service.name = safeText(service.name || service.url || '');
  service.url = safeText(service.url || '').trim();
  service.check_type = safeText(service.check_type || 'status_code').trim() || 'status_code';
  service.interval_min = Math.max(1, Number(service.interval_min || 5) || 5);
  service.max_redirects = Math.max(0, Math.min(10, Number(service.max_redirects || 5) || 5));
  service.latency_warn_ms = Math.max(0, Number(service.latency_warn_ms || 5000) || 5000);
  service.fail_threshold = Math.max(1, Number(service.fail_threshold || 2) || 2);
  service.retry_count = Math.max(1, Math.min(5, Number(service.retry_count || 2) || 2));
  service.retry_delay_ms = Math.max(0, Math.min(10000, Number(service.retry_delay_ms || 1200) || 1200));
  service.port_scan_enabled = isEnabled(service.port_scan_enabled);
  service.port_scan_host = safeText(service.port_scan_host || '').trim();
  service.port_scan_ports = safeText(service.port_scan_ports || '').trim();
  service.port_scan_device_name = safeText(service.port_scan_device_name || '').trim();
  return service;
}

function statusDot(status) {
  const value = String(status || '').toUpperCase();
  const cls = value === 'UP' || value === 'UP-'
    ? 'dot-up'
    : value
      ? 'dot-down'
      : 'dot-unknown';
  return `<span class="status-dot ${cls}" aria-hidden="true"></span>`;
}

function probeOnlineStateDisplay(probe) {
  const lastSeenAt = probe && probe.last_seen_at ? new Date(probe.last_seen_at) : null;
  const validSeenAt = lastSeenAt && !Number.isNaN(lastSeenAt.getTime()) ? lastSeenAt : null;
  const online = !!validSeenAt && (Date.now() - validSeenAt.getTime() <= PROBE_ONLINE_WINDOW_MS);
  return {
    online,
    label: online ? 'Online' : 'Offline'
  };
}

function formatPortScanPorts(probe) {
  const ports = Array.isArray(probe?.latest_port_scan?.open_ports) ? probe.latest_port_scan.open_ports : [];
  if (!ports.length) return '無開啟 ports';
  return ports.join(', ');
}

function formatPortScanSummary(probe) {
  const scan = probe?.latest_port_scan;
  if (!scan) return '尚無 Port 掃描結果';
  return `${safeText(scan.open_count || 0)} / ${safeText(scan.total_count || 0)} ports 開啟`;
}

function isHealthyServiceStatus(status) {
  const value = String(status || '').trim().toUpperCase();
  return value === 'UP' || value === 'UP-';
}

function hasWarningServiceStatus(status) {
  const value = String(status || '').trim().toUpperCase();
  if (!value || value === '-' || value === 'UNKNOWN' || value === 'PENDING') return false;
  return !isHealthyServiceStatus(value);
}

function shouldUseWarnServiceCard(service) {
  if (!isEnabled(service?.enabled)) return false;
  return hasWarningServiceStatus(service?.last_status)
    || hasWarningServiceStatus(service?.gas_status)
    || hasWarningServiceStatus(service?.probe_status);
}

function renderServices() {
  if (!adminBody) return;
  if (!services.length) {
    adminBody.innerHTML = '<p class="message">目前沒有服務資料。</p>';
    return;
  }
  adminBody.innerHTML = services.map((service) => rowTemplate(service)).join('');
}

function renderProbes() {
  if (!probesBody) return;
  if (!probes.length) {
    probesBody.innerHTML = '<p class="message">目前沒有 Probe 節點。</p>';
    return;
  }
  probesBody.innerHTML = probes.map((probe) => probeCompactTemplateV2(probe)).join('');
}

function renderPortScanRequestLog() {
  if (!portScanRequestLog) return;
  portScanRequestLog.textContent = portScanLogLines.length
    ? portScanLogLines.join('\n')
    : '按下「開始掃描 Port」後，這裡會顯示回報紀錄。';
  portScanRequestLog.scrollTop = portScanRequestLog.scrollHeight;
}

function resetPortScanRequestLog() {
  portScanLogLines = [];
  renderPortScanRequestLog();
}

function appendPortScanRequestLog(message, timestamp) {
  const label = safeText(timestamp || new Date().toLocaleTimeString('zh-TW', { hour12: false }));
  portScanLogLines.push(`[${label}] ${safeText(message)}`);
  if (portScanLogLines.length > PORT_SCAN_LOG_LIMIT) {
    portScanLogLines = portScanLogLines.slice(-PORT_SCAN_LOG_LIMIT);
  }
  renderPortScanRequestLog();
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function formatPortScanSessionTime(rawValue) {
  const date = rawValue ? new Date(rawValue) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return new Date().toLocaleTimeString('zh-TW', { hour12: false });
  }
  return date.toLocaleTimeString('zh-TW', { hour12: false });
}

function buildPortScanSessionMarker(session) {
  if (!session) return '';
  return [
    safeText(session.request_id || ''),
    safeText(session.updated_at || ''),
    safeText(session.status || ''),
    Array.isArray(session.log_lines) ? session.log_lines.length : 0
  ].join('|');
}

function formatPortScanSessionLogLine(entry) {
  const probeLabel = safeText(entry?.probe_id || '');
  const levelLabel = safeText(entry?.level || '').toUpperCase();
  const suffix = [probeLabel, levelLabel].filter(Boolean).join(' | ');
  return suffix ? `${safeText(entry?.message || '')} (${suffix})` : safeText(entry?.message || '');
}

async function fetchPortScanSession() {
  const res = await apiGet({ action: 'getPortScanSignal' }, 120000);
  if (!res || res.ok === false) throw new Error(res?.error || 'getPortScanSignal failed');
  return res.data || null;
}

async function watchPortScanRequest(meta) {
  const watchToken = ++portScanWatchToken;
  const requestId = safeText(meta?.requestId || '');
  const onlineProbeCount = Math.max(0, Number(meta?.onlineProbeCount || 0) || 0);
  const startedAt = Date.now();
  let pollRound = 0;
  let lastMarker = '';
  let lastLogCount = 0;
  let sawRunning = false;
  let sawCompletion = false;

  appendPortScanRequestLog(
    onlineProbeCount > 0
      ? `已送出 Port 掃描要求，等待 ${onlineProbeCount} 個上線 Probe 回報。`
      : '已送出 Port 掃描要求，但目前沒有偵測到上線中的 Probe。'
  );

  while (watchToken === portScanWatchToken && Date.now() - startedAt < PORT_SCAN_WATCH_TIMEOUT_MS) {
    pollRound += 1;
    try {
      const session = await fetchPortScanSession();
      if (!session) {
        appendPortScanRequestLog('目前找不到 Port Scan session。');
        break;
      }
      if (requestId && safeText(session.request_id || '') !== requestId) {
        appendPortScanRequestLog('偵測到較新的 Port Scan 要求，停止追蹤本次 session。');
        break;
      }

      const marker = buildPortScanSessionMarker(session);
      const logs = Array.isArray(session.log_lines) ? session.log_lines : [];
      if (marker !== lastMarker) {
        for (let index = lastLogCount; index < logs.length; index += 1) {
          const entry = logs[index];
          appendPortScanRequestLog(formatPortScanSessionLogLine(entry), formatPortScanSessionTime(entry?.at));
        }
        lastLogCount = logs.length;
        lastMarker = marker;
      } else if (pollRound === 1 || pollRound % 3 === 0) {
        appendPortScanRequestLog(`第 ${pollRound} 次輪詢：session 仍在 ${safeText(session.status || 'pending')}。`);
      }

      if (safeText(session.status || '') === 'running') {
        sawRunning = true;
      }
      if (safeText(session.status || '') === 'completed' || safeText(session.status || '') === 'failed') {
        sawCompletion = true;
        await Promise.allSettled([loadServices(), loadProbes()]);
        if (session.result_summary) {
          appendPortScanRequestLog(session.result_summary, formatPortScanSessionTime(session.completed_at));
        }
        break;
      }
    } catch (error) {
      appendPortScanRequestLog(`輪詢失敗: ${safeText(error?.message || error)}`);
    }

    if (watchToken !== portScanWatchToken) break;
    await delay(PORT_SCAN_WATCH_INTERVAL_MS);
  }

  if (watchToken !== portScanWatchToken) return;
  if (!sawCompletion) {
    appendPortScanRequestLog(
      sawRunning
        ? '追蹤時間到，Port Scan 可能仍在進行中。'
        : '追蹤結束，尚未看到 Probe claim 這次 Port Scan request。'
    );
  }
}

async function loadServices(onProgress) {
  if (typeof onProgress === 'function') onProgress(12);
  const res = await apiGet({ action: 'listServices' }, 120000);
  if (!res || res.ok === false) throw new Error(res?.error || 'listServices failed');
  if (typeof onProgress === 'function') onProgress(72);
  services = Array.isArray(res.data) ? res.data.map(normalizeService) : [];
  renderServices();
  if (adminMessage) adminMessage.textContent = `已載入 ${services.length} 筆服務設定。`;
  if (typeof onProgress === 'function') onProgress(100);
  return services;
}

async function loadProbes(onProgress) {
  if (typeof onProgress === 'function') onProgress(12);
  const res = await apiGet({ action: 'listProbes' }, 120000);
  if (!res || res.ok === false) throw new Error(res?.error || 'listProbes failed');
  if (typeof onProgress === 'function') onProgress(72);
  probes = Array.isArray(res.data) ? res.data : [];
  renderProbes();
  if (probesMessage) probesMessage.textContent = probes.length
    ? `已載入 ${probes.length} 個 Probe 節點。`
    : '目前沒有 Probe 節點。';
  if (typeof onProgress === 'function') onProgress(100);
  return probes;
}

function resetAddFormDefaults() {
  if (!addForm) return;
  addForm.reset();
  const defaults = serviceDefaults();
  addForm.elements.name.value = '';
  addForm.elements.url.value = '';
  addForm.elements.interval_min.value = defaults.interval_min;
  addForm.elements.check_type.value = defaults.check_type;
  addForm.elements.expected_keyword.value = defaults.expected_keyword;
  addForm.elements.forbidden_keyword.value = defaults.forbidden_keyword;
  addForm.elements.expected_final_url.value = defaults.expected_final_url;
  addForm.elements.secondary_url.value = defaults.secondary_url;
  addForm.elements.allow_redirects.checked = defaults.allow_redirects;
  addForm.elements.max_redirects.value = defaults.max_redirects;
  addForm.elements.latency_warn_ms.value = defaults.latency_warn_ms;
  addForm.elements.fail_threshold.value = defaults.fail_threshold;
  addForm.elements.retry_count.value = defaults.retry_count;
  addForm.elements.retry_delay_ms.value = defaults.retry_delay_ms;
}

function startDeleteProgress() {
  deleteProgressValue = 12;
  if (deleteProgressWrap) deleteProgressWrap.classList.remove('hidden');
  if (deleteProgressBar) deleteProgressBar.style.width = `${deleteProgressValue}%`;
  if (deleteProgressPct) deleteProgressPct.textContent = `${deleteProgressValue}%`;
  if (deleteTestDataSubmitBtn) deleteTestDataSubmitBtn.disabled = true;
  if (deleteProgressTimer) window.clearInterval(deleteProgressTimer);
  deleteProgressTimer = window.setInterval(() => {
    deleteProgressValue = Math.min(92, deleteProgressValue + 7);
    if (deleteProgressBar) deleteProgressBar.style.width = `${deleteProgressValue}%`;
    if (deleteProgressPct) deleteProgressPct.textContent = `${deleteProgressValue}%`;
  }, 260);
}

function finishDeleteProgress(success) {
  if (deleteProgressTimer) {
    window.clearInterval(deleteProgressTimer);
    deleteProgressTimer = null;
  }
  deleteProgressValue = success ? 100 : 0;
  if (deleteProgressBar) deleteProgressBar.style.width = `${deleteProgressValue}%`;
  if (deleteProgressPct) deleteProgressPct.textContent = `${deleteProgressValue}%`;
  if (deleteTestDataSubmitBtn) deleteTestDataSubmitBtn.disabled = false;
  window.setTimeout(() => {
    if (deleteProgressWrap) deleteProgressWrap.classList.add('hidden');
    if (deleteProgressBar) deleteProgressBar.style.width = '0%';
    if (deleteProgressPct) deleteProgressPct.textContent = '0%';
  }, success ? 480 : 180);
}

function collectServicePayload(card, serviceId) {
  const payload = { action: 'updateService', id: serviceId };
  const fields = card.querySelectorAll('[data-field][data-id]');
  fields.forEach((field) => {
    if (String(field.dataset.id || '') !== serviceId) return;
    const key = String(field.dataset.field || '').trim();
    if (!key) return;
    if (field.type === 'checkbox') {
      payload[key] = field.checked;
      return;
    }
    const rawValue = safeText(field.value).trim();
    if (['interval_min', 'max_redirects', 'latency_warn_ms', 'fail_threshold', 'retry_count', 'retry_delay_ms'].includes(key)) {
      payload[key] = Number(rawValue || 0);
      return;
    }
    payload[key] = rawValue;
  });
  return payload;
}

async function handleAdd(event) {
  event.preventDefault();
  if (!addForm) return;
  addMessage.textContent = '正在新增服務...';
  const payload = {
    action: 'addService',
    name: addForm.elements.name.value.trim(),
    url: addForm.elements.url.value.trim(),
    interval_min: Number(addForm.elements.interval_min.value || 5),
    check_type: addForm.elements.check_type.value,
    expected_keyword: addForm.elements.expected_keyword.value.trim(),
    forbidden_keyword: addForm.elements.forbidden_keyword.value.trim(),
    expected_final_url: addForm.elements.expected_final_url.value.trim(),
    secondary_url: addForm.elements.secondary_url.value.trim(),
    allow_redirects: addForm.elements.allow_redirects.checked,
    max_redirects: Number(addForm.elements.max_redirects.value || 5),
    latency_warn_ms: Number(addForm.elements.latency_warn_ms.value || 5000),
    fail_threshold: Number(addForm.elements.fail_threshold.value || 2),
    retry_count: Number(addForm.elements.retry_count.value || 2),
    retry_delay_ms: Number(addForm.elements.retry_delay_ms.value || 1200)
  };

  try {
    const res = await apiPost(payload, 120000);
    if (!res || res.ok === false) throw new Error(res?.error || 'addService failed');
    resetAddFormDefaults();
    await loadServices();
    addMessage.textContent = '服務已新增。';
  } catch (err) {
    addMessage.textContent = `新增服務失敗: ${safeText(err.message)}`;
  }
}

async function handleTableClick(event) {
  const btn = event.target.closest('button[data-action][data-id]');
  if (!btn) return;

  const action = String(btn.dataset.action || '').trim();
  const serviceId = String(btn.dataset.id || '').trim();
  const card = btn.closest('.service-card');
  if (!action || !serviceId || !card) return;

  try {
    if (action === 'save') {
      adminMessage.textContent = '正在儲存服務設定...';
      const res = await apiPost(collectServicePayload(card, serviceId), 120000);
      if (!res || res.ok === false) throw new Error(res?.error || 'updateService failed');
      await loadServices();
      adminMessage.textContent = '服務設定已更新。';
      return;
    }

    if (action === 'refresh') {
      await handleSingleServiceRefreshWithOverlay(serviceId, safeText(btn.dataset.name || '服務'));
      return;
    }

    if (action === 'disable') {
      const res = await apiPost({ action: 'updateService', id: serviceId, enabled: false }, 120000);
      if (!res || res.ok === false) throw new Error(res?.error || 'disable service failed');
      await loadServices();
      adminMessage.textContent = '服務已停用。';
      return;
    }

    if (action === 'remove') {
      const serviceName = safeText(btn.dataset.name || serviceId);
      if (!window.confirm(`確定要永久刪除 ${serviceName}？`)) return;
      const res = await apiPost({ action: 'hardDeleteService', id: serviceId }, 120000);
      if (!res || res.ok === false) throw new Error(res?.error || 'hardDeleteService failed');
      await loadServices();
      adminMessage.textContent = '服務已刪除。';
    }
  } catch (err) {
    adminMessage.textContent = `操作失敗: ${safeText(err.message)}`;
  }
}

async function animateProgressDuringWait(waitMs, progress, startPercent, endPercent) {
  const startedAt = Date.now();
  await new Promise((resolve) => {
    const tick = () => {
      const elapsed = Date.now() - startedAt;
      const ratio = Math.max(0, Math.min(1, elapsed / waitMs));
      progress(startPercent + (endPercent - startPercent) * ratio);
      if (ratio >= 1) {
        resolve();
        return;
      }
      window.setTimeout(tick, 220);
    };
    tick();
  });
}

async function handleSingleServiceRefreshWithOverlay(serviceId, serviceName) {
  const labelName = safeText(serviceName || serviceId || '服務');
  await runTransientLoading(`正在重新檢查 ${labelName}...`, async (progress) => {
    progress(14);
    const res = await apiPost({ action: 'refreshServiceNow', id: serviceId, request_probe: true, requested_by: 'admin' }, 120000);
    if (!res || res.ok === false) throw new Error(res?.error || 'refreshServiceNow failed');

    const data = res.data || {};
    const probeRequested = !!data.probe_requested;

    progress(28);
    await Promise.allSettled([
      loadServices((p) => progress(28 + p * 0.28)),
      loadProbes((p) => progress(56 + p * 0.16))
    ]);

    if (probeRequested) {
      await animateProgressDuringWait(6500, progress, 72, 88);
      await Promise.allSettled([
        loadServices((p) => progress(88 + p * 0.08)),
        loadProbes((p) => progress(96 + p * 0.03))
      ]);
    }
  });
  adminMessage.textContent = `已完成 ${labelName} 的重新檢查。`;
}

async function handleReloadWithOverlay() {
  await runTransientLoading('正在重新載入管理資料...', async (progress) => {
    await Promise.allSettled([
      loadServices((p) => progress(Math.min(62, p * 0.62))),
      loadProbes((p) => progress(62 + p * 0.22)),
      loadReportConfig((p) => progress(84 + p * 0.16))
    ]);
  });
}

async function handleRunNowWithOverlay() {
  await runTransientLoading('正在執行檢查...', async () => {
    await handleRunNow();
  });
}

async function handleReloadReportWithOverlay() {
  await runTransientLoading('正在重新載入報表設定...', async (progress) => {
    await loadReportConfig(progress);
  });
}

async function handleReloadDeleteDatesWithOverlay() {
  await runTransientLoading('正在重新載入可刪除日期...', async (progress) => {
    await loadChecksDates(true, progress);
  });
}

async function handleReloadProbes() {
  await runTransientLoading('正在重新載入 Probe 狀態...', async (progress) => {
    await loadProbes(progress);
  });
}

function serviceDefaults() {
  return {
    check_type: 'status_code',
    expected_keyword: '',
    forbidden_keyword: '',
    expected_final_url: '',
    secondary_url: '',
    port_scan_enabled: false,
    port_scan_host: '',
    port_scan_ports: '',
    port_scan_device_name: '',
    allow_redirects: true,
    max_redirects: 5,
    latency_warn_ms: 5000,
    fail_threshold: 2,
    retry_count: 2,
    retry_delay_ms: 1200,
    consecutive_failures: 0,
    last_error_type: '',
    last_error: '',
    last_http_code: '',
    last_status: ''
  };
}

function isEnabled(value) {
  return value === true || String(value).toUpperCase() === 'TRUE';
}

function escapeAttr(value) {
  return safeText(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function setLoadingOverlay(show) {
  if (!loadingOverlay) return;
  loadingOverlay.classList.toggle('hidden', !show);
}

function setLoadingProgress(percent, label) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  if (loadingPercent) loadingPercent.textContent = `${Math.round(p)}%`;
  if (loadingBarInner) loadingBarInner.style.width = `${p}%`;
  if (loadingLabel && label) loadingLabel.textContent = label;
}

function finishFirstLoadOverlay(label, progress = 100) {
  if (!firstLoadPending) return;
  setLoadingProgress(progress, label);
  firstLoadPending = false;
  window.setTimeout(() => setLoadingOverlay(false), 220);
}

async function runTransientLoading(label, task) {
  const startedAt = Date.now();
  setLoadingOverlay(true);
  setLoadingProgress(10, label);
  try {
    await task((p) => setLoadingProgress(Math.max(10, Math.min(99, p)), label));
    setLoadingProgress(100, '完成');
  } finally {
    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(0, CLICK_LOADING_MIN_MS - elapsed);
    window.setTimeout(() => setLoadingOverlay(false), waitMs);
  }
}

function loadCachedDates() {
  try {
    const raw = localStorage.getItem(DATES_CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.ts > DATES_CACHE_TTL_MS) {
      localStorage.removeItem(DATES_CACHE_KEY);
      return null;
    }
    return Array.isArray(entry.dates) ? entry.dates : null;
  } catch (_) {
    return null;
  }
}

function saveCachedDates(dates) {
  try {
    localStorage.setItem(DATES_CACHE_KEY, JSON.stringify({ ts: Date.now(), dates }));
  } catch (_) {}
}

function clearChecksDatesCache() {
  try { localStorage.removeItem(DATES_CACHE_KEY); } catch (_) {}
}

populateDateSelect = function populateDateSelectSafe(dates) {
  if (!deleteTestDataDateSelect) return;
  const list = Array.isArray(dates) ? dates : [];
  const options = list.map((date) => `<option value="${escapeAttr(date)}">${escapeHtmlText(date)}</option>`).join('');
  deleteTestDataDateSelect.innerHTML = list.length
    ? '<option value="">-- Select a date --</option>' + options
    : '<option value="">No dates available</option>';
};

probeCompactTemplateV2 = function probeCompactTemplateV2Safe(probe) {
  const state = probeOnlineStateDisplay(probe);
  const statusClass = state.online ? 'probe-online' : 'probe-offline';
  const probeId = escapeAttr(probe.probe_id);
  const summaryText = escapeHtmlText(safeText(probe.last_status_summary) || '-');
  const errorText = escapeHtmlText(safeText(probe.last_run_error) || '');
  const versionText = escapeHtmlText(safeText(probe.probe_version) || '-');
  const appVersionText = probe.app_version ? ` / App ${escapeHtmlText(probe.app_version)}` : '';
  const portScan = probe?.latest_port_scan || null;
  const portScanHost = escapeHtmlText(safeText(portScan?.host) || safeText(probe.host_name) || '-');
  const portScanTime = portScan?.scanned_at ? fmtDate(portScan.scanned_at) : '尚未掃描';
  const portScanSummary = escapeHtmlText(formatPortScanSummary(probe));
  const portScanPorts = escapeHtmlText(formatPortScanPorts(probe));
  return `
    <article class="probe-card probe-card-compact probe-card-compact-v2">
      <div class="probe-card-header">
        <div>
          <strong>${escapeHtmlText(safeText(probe.probe_name) || safeText(probe.probe_id) || '(Probe)')}</strong>
          <div class="probe-card-subtitle">${escapeHtmlText(safeText(probe.host_name) || '-')} | ${escapeHtmlText(safeText(probe.platform) || '-')} ${escapeHtmlText(safeText(probe.platform_release) || '')}</div>
        </div>
        <div class="probe-card-side-actions">
          <span class="probe-status-badge ${statusClass}">${state.label}</span>
          <div class="probe-card-actions">
            <button class="btn tiny" type="button" data-probe-action="offline" data-probe-id="${probeId}">標記離線</button>
            <button class="btn tiny danger" type="button" data-probe-action="clear" data-probe-id="${probeId}">清除狀態</button>
          </div>
        </div>
      </div>
      <div class="probe-compact-grid-six">
        <div class="probe-compact-kpi"><span>Probe ID</span><strong>${escapeHtmlText(safeText(probe.probe_id) || '-')}</strong></div>
        <div class="probe-compact-kpi"><span>Status</span><strong>${escapeHtmlText(safeText(probe.last_run_status) || '-')}</strong></div>
        <div class="probe-compact-kpi"><span>Result / DOWN</span><strong>${escapeHtmlText(safeText(probe.last_result_count) || '0')} / ${escapeHtmlText(safeText(probe.last_down_count) || '0')}</strong></div>
        <div class="probe-compact-kpi"><span>Last seen</span><strong>${fmtDate(probe.last_seen_at)}</strong></div>
        <div class="probe-compact-kpi"><span>Last run</span><strong>${fmtDate(probe.last_run_finished_at || probe.last_run_started_at)}</strong></div>
        <div class="probe-compact-kpi"><span>Version</span><strong>${versionText}${appVersionText}</strong></div>
      </div>
      <div class="probe-compact-summary-row">
        <div class="probe-compact-summary"><span>Summary</span><strong class="log-cell-wrap">${summaryText}</strong></div>
        ${errorText && errorText !== '-' ? `<div class="probe-compact-summary probe-compact-error"><span>Error</span><strong class="log-cell-wrap">${errorText}</strong></div>` : ''}
        <div class="probe-compact-summary probe-port-scan-summary">
          <span>最近 Port 掃描</span>
          <strong>${portScanSummary}</strong>
          <small>主機 ${portScanHost} | 時間 ${portScanTime}</small>
          <strong class="log-cell-wrap">${portScanPorts}</strong>
        </div>
      </div>
    </article>
  `;
};

rowTemplate = function rowTemplateSafe(rawService) {
  const service = normalizeService(rawService);
  const enabled = isEnabled(service.enabled);
  const allowRedirects = isEnabled(service.allow_redirects);
  const gasStatusLabel = safeText(service.gas_status) || safeText(service.last_status) || '-';
  const probeStatusLabel = safeText(service.probe_status) || (service.check_mode === 'dual_pending' ? 'Pending' : '-');
  const serviceId = escapeAttr(service.id);
  const cardToneClass = shouldUseWarnServiceCard(service) ? ' service-card-warn' : '';

  return `
    <article class="service-card${cardToneClass}">
      <div class="service-card-header">
        <div class="service-card-title">
          <span class="name-cell">${statusDot(service.last_status)}<strong>${escapeHtmlText(safeText(service.name) || '(Unnamed Service)')}</strong></span>
          <span class="service-card-url">${escapeHtmlText(safeText(service.url) || '-')}</span>
          <span class="service-check-mode-line">${serviceCheckModeBadge(service)}<span class="service-check-mode-detail">${escapeHtmlText(safeText(serviceCheckModeDetail(service)))}</span></span>
        </div>
        <div class="service-card-side">
          <span class="service-card-status">${escapeHtmlText(safeText(service.last_status) || '-')}</span>
          <span class="service-card-meta">HTTP ${escapeHtmlText(safeText(service.last_http_code) || '-')} | ${escapeHtmlText(safeText(service.last_error_type) || '-')} | Fail Streak ${escapeHtmlText(safeText(service.consecutive_failures) || '0')}</span>
        </div>
      </div>

      <div class="service-card-body service-card-body-compact">
        <div class="service-main-grid">
          <label class="span-2">
            Name
            <input data-field="name" data-id="${serviceId}" value="${escapeAttr(service.name)}" />
          </label>
          <label class="span-1">
            Interval (min)
            <input data-field="interval_min" data-id="${serviceId}" type="number" min="1" max="1440" value="${escapeAttr(service.interval_min || 5)}" />
          </label>
          <label class="span-1">
            Check type
            <select data-field="check_type" data-id="${serviceId}">
              <option value="status_code" ${service.check_type === 'status_code' ? 'selected' : ''}>HTTP status</option>
              <option value="keyword" ${service.check_type === 'keyword' ? 'selected' : ''}>Keyword</option>
            </select>
          </label>
          <label class="span-3">
            URL
            <input data-field="url" data-id="${serviceId}" value="${escapeAttr(service.url)}" />
          </label>
          <label class="check-item service-inline-check span-1">
            <input data-field="enabled" data-id="${serviceId}" type="checkbox" ${enabled ? 'checked' : ''} />
            <span>Enabled</span>
          </label>
        </div>

        <div class="service-result-strip">
          <div class="service-result-item"><span>Mode</span><strong>${escapeHtmlText(safeText(service.check_mode_label) || 'Unknown')}</strong></div>
          <div class="service-result-item"><span>Status</span><strong>${escapeHtmlText(safeText(service.last_status) || '-')}</strong></div>
          <div class="service-result-item"><span>GAS</span><strong class="service-status-chip">${statusDot(gasStatusLabel)}${escapeHtmlText(gasStatusLabel)}</strong></div>
          <div class="service-result-item"><span>Probe</span><strong class="service-status-chip">${statusDot(probeStatusLabel)}${escapeHtmlText(probeStatusLabel)}</strong></div>
          <div class="service-result-item"><span>HTTP</span><strong>${escapeHtmlText(safeText(service.last_http_code) || '-')}</strong></div>
          <div class="service-result-item"><span>Error Type</span><strong>${escapeHtmlText(safeText(service.last_error_type) || '-')}</strong></div>
          <div class="service-result-item"><span>Fail Streak</span><strong>${escapeHtmlText(safeText(service.consecutive_failures) || '0')}</strong></div>
          <div class="service-result-item service-result-item-wide"><span>Error</span><strong class="log-cell-wrap">${escapeHtmlText(safeText(service.last_error) || '-')}</strong></div>
        </div>

        <details class="service-advanced">
          <summary>進階設定</summary>
          <div class="service-card-grid service-card-grid-compact">
            <label class="span-1">
              最大重新導向次數
              <input data-field="max_redirects" data-id="${serviceId}" type="number" min="0" max="10" value="${escapeAttr(service.max_redirects)}" />
            </label>
            <label class="span-1">
              延遲警示門檻 (ms)
              <input data-field="latency_warn_ms" data-id="${serviceId}" type="number" min="0" max="600000" value="${escapeAttr(service.latency_warn_ms)}" />
            </label>
            <label class="span-1">
              失敗判定門檻
              <input data-field="fail_threshold" data-id="${serviceId}" type="number" min="1" max="10" value="${escapeAttr(service.fail_threshold)}" />
            </label>
            <label class="span-1">
              重試次數
              <input data-field="retry_count" data-id="${serviceId}" type="number" min="1" max="5" value="${escapeAttr(service.retry_count)}" />
            </label>
            <label class="span-1">
              重試間隔 (ms)
              <input data-field="retry_delay_ms" data-id="${serviceId}" type="number" min="0" max="10000" value="${escapeAttr(service.retry_delay_ms)}" />
            </label>
            <label class="check-item service-inline-check span-1">
              <input data-field="allow_redirects" data-id="${serviceId}" type="checkbox" ${allowRedirects ? 'checked' : ''} />
              <span>跟隨重新導向</span>
            </label>
            <label class="span-2">
              預期關鍵字
              <input data-field="expected_keyword" data-id="${serviceId}" value="${escapeAttr(service.expected_keyword)}" placeholder="選填，內容中必須出現的關鍵字" />
            </label>
            <label class="span-2">
              禁止關鍵字
              <input data-field="forbidden_keyword" data-id="${serviceId}" value="${escapeAttr(service.forbidden_keyword)}" placeholder="選填，內容中不可出現的關鍵字" />
            </label>
            <label class="span-2">
              預期最終 URL
              <input data-field="expected_final_url" data-id="${serviceId}" value="${escapeAttr(service.expected_final_url)}" placeholder="選填，重新導向後應到達的網址" />
            </label>
            <label class="span-2">
              次要 URL
              <input data-field="secondary_url" data-id="${serviceId}" value="${escapeAttr(service.secondary_url)}" placeholder="選填，備援或 Probe 專用網址" />
            </label>
          </div>
        </details>
      </div>

      <div class="service-card-actions">
        <button class="btn tiny" data-action="save" data-id="${serviceId}">儲存</button>
        <button class="btn tiny secondary" data-action="refresh" data-id="${serviceId}">重新檢查</button>
        <button class="btn tiny danger" data-action="disable" data-id="${serviceId}">停用</button>
        <button class="btn tiny danger" data-action="remove" data-id="${serviceId}" data-name="${escapeAttr(service.name)}">移除</button>
      </div>
    </article>
  `;
};

applyReportConfig = function applyReportConfigSafe(cfg) {
  if (!reportForm) return;
  const rawMode = safeText(cfg.notify_mode || 'mail');
  const notifyMode = rawMode === 'all'
    ? 'mail_line'
    : rawMode === 'mail_teams'
      ? 'mail'
      : rawMode;
  reportForm.elements.recipients.value = safeText(cfg.recipients || '');
  reportForm.elements.notify_mode.value = notifyMode;
  reportForm.elements.frequency.value = safeText(cfg.frequency || 'hourly');
  reportForm.elements.daily_hour.value = Number.isFinite(Number(cfg.daily_hour)) ? Number(cfg.daily_hour) : 9;
  reportForm.elements.enabled.checked = String(cfg.enabled).toLowerCase() !== 'false';
  reportForm.elements.only_on_issue.checked = String(cfg.only_on_issue).toLowerCase() !== 'false';
  reportForm.elements.line_to.value = safeText(cfg.line_to || '');
  reportForm.elements.monitor_label.value = safeText(cfg.monitor_label || '');

  const tokenInput = reportForm.elements.line_channel_access_token;
  if (tokenInput) {
    const masked = safeText(cfg.line_channel_access_token_masked || '');
    tokenInput.value = '';
    tokenInput.dataset.configured = cfg.line_channel_access_token_configured ? 'true' : 'false';
    tokenInput.placeholder = masked
      ? `Configured token (${masked}) - leave blank to keep existing`
      : 'LINE Messaging API Channel Access Token';
    tokenInput.autocomplete = 'off';
  }
};

async function loadLineTargetSummary() {
  if (!lineUserStats) return;
  try {
    const res = await apiGet({ action: 'getLineTargetSummary' });
    const data = res.data || {};
    lineUserStats.textContent = `Recorded LINE users: ${Number(data.user_count || 0)} / groups: ${Number(data.group_count || 0)} / rooms: ${Number(data.room_count || 0)}`;
  } catch (_) {
    lineUserStats.textContent = '已記錄 LINE 對象：-';
  }
}

async function loadReportConfig(onProgress) {
  if (typeof onProgress === 'function') onProgress(12);
  reportMessage.textContent = 'Loading report settings...';
  try {
    const res = await apiGet({ action: 'getReportConfig' });
    if (typeof onProgress === 'function') onProgress(58);
    applyReportConfig(res.data || {});
    if (typeof onProgress === 'function') onProgress(82);
    await loadLineTargetSummary();
    reportMessage.textContent = 'Report settings loaded.';
    if (typeof onProgress === 'function') onProgress(100);
  } catch (err) {
    reportMessage.textContent = `Failed to load report settings: ${safeText(err.message)}`;
    if (typeof onProgress === 'function') onProgress(100);
  }
}

async function handleSaveReport(event) {
  event.preventDefault();
  reportMessage.textContent = 'Saving report settings...';

  const payload = {
    action: 'updateReportConfig',
    monitor_label: reportForm.elements.monitor_label.value.trim(),
    recipients: reportForm.elements.recipients.value.trim(),
    notify_mode: reportForm.elements.notify_mode.value,
    frequency: reportForm.elements.frequency.value,
    daily_hour: Number(reportForm.elements.daily_hour.value || 9),
    enabled: reportForm.elements.enabled.checked,
    only_on_issue: reportForm.elements.only_on_issue.checked,
    line_channel_access_token: reportForm.elements.line_channel_access_token.value.trim(),
    line_to: reportForm.elements.line_to.value.trim()
  };

  try {
    const res = await apiPost(payload);
    if (!res.ok) throw new Error(res.error || 'updateReportConfig failed');
    applyReportConfig(res.data || {});
    await loadLineTargetSummary();
    reportMessage.textContent = 'Report settings saved.';
  } catch (err) {
    reportMessage.textContent = `Failed to save report settings: ${safeText(err.message)}`;
  }
}

async function handleSendReportNow() {
  reportMessage.textContent = 'Sending report now...';
  try {
    const res = await apiPost({ action: 'sendReportNow' });
    if (!res.ok) throw new Error(res.error || 'sendReportNow failed');
    const channels = Array.isArray(res.channels) ? res.channels : [];
    const details = channels.map((item) => {
      const state = item.sent ? 'OK' : `FAIL(${safeText(item.error || item.skipped || '')})`;
      return `${item.channel}: ${state}`;
    }).join(' | ');
    reportMessage.textContent = details || 'Report request sent.';
  } catch (err) {
    reportMessage.textContent = `Failed to send report: ${safeText(err.message)}`;
  }
}

function applyPortScanConfig(cfg) {
  if (!portScanConfigForm) return;
  portScanConfigForm.elements.enabled.checked = String(cfg?.enabled).toLowerCase() === 'true' || cfg?.enabled === true;
  portScanConfigForm.elements.ports.value = safeText(cfg?.ports || '');
}

async function loadPortScanConfig(onProgress) {
  if (!portScanConfigForm) return null;
  if (portScanConfigMessage) portScanConfigMessage.textContent = '正在載入 Port 掃描設定...';
  if (typeof onProgress === 'function') onProgress(12);
  try {
    const res = await apiGet({ action: 'getPortScanConfig' }, 120000);
    if (!res || res.ok === false) throw new Error(res?.error || 'getPortScanConfig failed');
    if (typeof onProgress === 'function') onProgress(78);
    applyPortScanConfig(res.data || {});
    if (portScanConfigMessage) {
      portScanConfigMessage.textContent = safeText(res.data?.enabled)
        ? '全域 Port 掃描已啟用，Probe 會掃描各服務主機的指定 ports。'
        : '全域 Port 掃描目前未啟用。';
    }
    if (typeof onProgress === 'function') onProgress(100);
    return res.data || {};
  } catch (err) {
    if (portScanConfigMessage) portScanConfigMessage.textContent = `載入 Port 掃描設定失敗: ${safeText(err.message)}`;
    if (typeof onProgress === 'function') onProgress(100);
    return null;
  }
}

async function handleSavePortScanConfig(event) {
  event.preventDefault();
  if (!portScanConfigForm) return;
  if (portScanConfigMessage) portScanConfigMessage.textContent = '正在儲存 Port 掃描設定...';
  try {
    const payload = {
      action: 'updatePortScanConfig',
      enabled: portScanConfigForm.elements.enabled.checked,
      ports: portScanConfigForm.elements.ports.value.trim()
    };
    const res = await apiPost(payload, 120000);
    if (!res || res.ok === false) throw new Error(res?.error || 'updatePortScanConfig failed');
    applyPortScanConfig(res.data || {});
    if (portScanConfigMessage) {
      portScanConfigMessage.textContent = safeText(res.data?.enabled)
        ? '全域 Port 掃描設定已儲存，Probe 下次執行時會掃描各服務主機 ports。'
        : '全域 Port 掃描已停用。';
    }
  } catch (err) {
    if (portScanConfigMessage) portScanConfigMessage.textContent = `儲存 Port 掃描設定失敗: ${safeText(err.message)}`;
  }
}

async function handleReloadPortScanConfigWithOverlay() {
  await runTransientLoading('正在重新載入 Port 掃描設定...', async (progress) => {
    await loadPortScanConfig(progress);
  });
}

async function handleRequestPortScanWithOverlay() {
  let requestMeta = null;
  await runTransientLoading('正在通知 Probe 重新掃描 Port...', async (progress) => {
    progress(14);
    const res = await apiPost({
      action: 'requestPortScanSignal',
      requested_by: 'admin',
      note: 'manual port scan request'
    }, 120000);
    if (!res || res.ok === false) throw new Error(res?.error || 'requestPortScanSignal failed');

    const onlineProbeCount = Math.max(0, Number(res.online_probe_count || 0) || 0);
    requestMeta = {
      requestId: safeText(res.data?.request_id || ''),
      requestedAt: safeText(res.data?.requested_at || new Date().toISOString()),
      onlineProbeCount
    };
    progress(34);

    if (onlineProbeCount > 0) {
      await animateProgressDuringWait(9500, progress, 34, 84);
    } else {
      progress(84);
    }

    await Promise.allSettled([
      loadProbes((p) => progress(84 + p * 0.08)),
      loadServices((p) => progress(92 + p * 0.08))
    ]);

    if (portScanConfigMessage) {
      portScanConfigMessage.textContent = onlineProbeCount > 0
        ? `已通知 ${onlineProbeCount} 個上線中的 Probe 重新掃描各服務主機 Port。`
        : '目前沒有上線中的 Probe，可先確認 Probe 視窗是否在線。';
    }
  });
  portScanWatchToken += 1;
  resetPortScanRequestLog();
  if (requestMeta) {
    void watchPortScanRequest(requestMeta);
  }
}

async function handleProbeAction(event) {
  const btn = event.target.closest('button[data-probe-action]');
  if (!btn) return;

  const probeId = String(btn.dataset.probeId || '').trim();
  const probeAction = String(btn.dataset.probeAction || '').trim();
  if (!probeId || !probeAction) return;

  try {
    if (probesMessage) probesMessage.textContent = 'Updating probe state...';

    if (probeAction === 'offline') {
      const res = await apiPost({
        action: 'markProbeOffline',
        probe_id: probeId,
        summary: 'Marked offline by admin'
      });
      if (!res.ok) throw new Error(res.error || 'markProbeOffline failed');
      if (probesMessage) probesMessage.textContent = 'Probe marked offline.';
    } else if (probeAction === 'clear') {
      const confirmed = window.confirm(`Clear probe state for ${probeId}?`);
      if (!confirmed) {
        if (probesMessage) probesMessage.textContent = '';
        return;
      }
      const res = await apiPost({
        action: 'clearProbeState',
        probe_id: probeId
      });
      if (!res.ok) throw new Error(res.error || 'clearProbeState failed');
      if (probesMessage) probesMessage.textContent = 'Probe state cleared.';
    }

    await loadProbes();
  } catch (err) {
    if (probesMessage) probesMessage.textContent = `Failed to update probe: ${safeText(err.message)}`;
  }
}

async function loadChecksDates(forceRefresh, onProgress) {
  if (!deleteTestDataDateSelect) return;
  if (typeof onProgress === 'function') onProgress(12);

  if (!forceRefresh) {
    const cached = loadCachedDates();
    if (cached) {
      populateDateSelect(cached);
      if (deleteTestDataDatesInfo) deleteTestDataDatesInfo.textContent = `${cached.length} date options cached.`;
      if (typeof onProgress === 'function') onProgress(100);
      return;
    }
  }

  if (deleteTestDataDatesInfo) deleteTestDataDatesInfo.textContent = 'Loading available dates...';
  try {
    const res = await apiGet({ action: 'getChecksDates' }, 120000);
    if (typeof onProgress === 'function') onProgress(72);
    const dates = res.ok && res.data && Array.isArray(res.data.dates) ? res.data.dates : [];
    saveCachedDates(dates);
    populateDateSelect(dates);
    if (deleteTestDataDatesInfo) {
      deleteTestDataDatesInfo.textContent = dates.length
        ? `${dates.length} date options available.`
        : 'No dates available.';
    }
    if (typeof onProgress === 'function') onProgress(100);
  } catch (err) {
    if (deleteTestDataDatesInfo) deleteTestDataDatesInfo.textContent = `Failed to load dates: ${safeText(err.message)}`;
    if (deleteTestDataDateSelect) deleteTestDataDateSelect.innerHTML = '<option value="">Failed to load dates</option>';
    if (typeof onProgress === 'function') onProgress(100);
  }
}

async function handleDeleteTestData(event) {
  event.preventDefault();
  const date = (deleteTestDataDateSelect?.value || deleteTestDataForm.elements.date_manual?.value || '').trim();
  if (!date) {
    deleteTestDataMessage.textContent = 'Select a date first.';
    return;
  }

  const confirmed = window.confirm(`Delete checks data for ${date}?`);
  if (!confirmed) return;

  startDeleteProgress();
  try {
    const res = await apiPost({ action: 'deleteTestDataByDate', date }, 300000);
    if (!res.ok) throw new Error(res.error || 'deleteTestDataByDate failed');
    finishDeleteProgress(true);
    deleteTestDataMessage.textContent = `Deleted rows: ${Number(res.data?.deleted_count || 0)}`;
    clearChecksDatesCache();
    await loadChecksDates(true);
  } catch (err) {
    finishDeleteProgress(false);
    deleteTestDataMessage.textContent = `Failed to delete test data: ${safeText(err.message)}`;
  }
}

async function handleRunNow() {
  adminMessage.textContent = 'Running checks now...';
  try {
    const res = await apiPost({ action: 'runNow', request_probe: true, requested_by: 'admin' });
    if (!res.ok) throw new Error(res.error || 'runNow failed');
    const data = res.data || {};
    const probeRequested = !!data.probe_requested;
    adminMessage.textContent = probeRequested
      ? 'GAS checks started and probe execution requested.'
      : 'GAS checks started.';
    await Promise.all([loadServices(), loadProbes()]);
    if (probeRequested) {
      await new Promise((resolve) => window.setTimeout(resolve, 6500));
      await Promise.all([loadServices(), loadProbes()]);
    }
  } catch (err) {
    adminMessage.textContent = `Failed to run checks: ${safeText(err.message)}`;
  }
}

function populateDateSelect(dates) {
  if (!deleteTestDataDateSelect) return;
  const list = Array.isArray(dates) ? dates : [];
  const options = list.map((date) => `<option value="${escapeAttr(date)}">${escapeHtmlText(date)}</option>`).join('');
  deleteTestDataDateSelect.innerHTML = list.length
    ? '<option value="">-- Select a date --</option>' + options
    : '<option value="">No dates available</option>';
}

function probeCompactTemplateV2(probe) {
  const state = probeOnlineStateDisplay(probe);
  const statusClass = state.online ? 'probe-online' : 'probe-offline';
  const probeId = escapeAttr(probe.probe_id);
  const summaryText = escapeHtmlText(safeText(probe.last_status_summary) || '-');
  const errorText = escapeHtmlText(safeText(probe.last_run_error) || '');
  const versionText = escapeHtmlText(safeText(probe.probe_version) || '-');
  const appVersionText = probe.app_version ? ` / App ${escapeHtmlText(probe.app_version)}` : '';
  const portScan = probe?.latest_port_scan || null;
  const portScanHost = escapeHtmlText(safeText(portScan?.host) || safeText(probe.host_name) || '-');
  const portScanTime = portScan?.scanned_at ? fmtDate(portScan.scanned_at) : '尚未掃描';
  const portScanSummary = escapeHtmlText(formatPortScanSummary(probe));
  const portScanPorts = escapeHtmlText(formatPortScanPorts(probe));
  return `
    <article class="probe-card probe-card-compact probe-card-compact-v2">
      <div class="probe-card-header">
        <div>
          <strong>${escapeHtmlText(safeText(probe.probe_name) || safeText(probe.probe_id) || '(Probe)')}</strong>
          <div class="probe-card-subtitle">${escapeHtmlText(safeText(probe.host_name) || '-')} | ${escapeHtmlText(safeText(probe.platform) || '-')} ${escapeHtmlText(safeText(probe.platform_release) || '')}</div>
        </div>
        <div class="probe-card-side-actions">
          <span class="probe-status-badge ${statusClass}">${state.label}</span>
          <div class="probe-card-actions">
            <button class="btn tiny" type="button" data-probe-action="offline" data-probe-id="${probeId}">標記離線</button>
            <button class="btn tiny danger" type="button" data-probe-action="clear" data-probe-id="${probeId}">清除狀態</button>
          </div>
        </div>
      </div>
      <div class="probe-compact-grid-six">
        <div class="probe-compact-kpi"><span>Probe ID</span><strong>${escapeHtmlText(safeText(probe.probe_id) || '-')}</strong></div>
        <div class="probe-compact-kpi"><span>Status</span><strong>${escapeHtmlText(safeText(probe.last_run_status) || '-')}</strong></div>
        <div class="probe-compact-kpi"><span>Result / DOWN</span><strong>${escapeHtmlText(safeText(probe.last_result_count) || '0')} / ${escapeHtmlText(safeText(probe.last_down_count) || '0')}</strong></div>
        <div class="probe-compact-kpi"><span>Last seen</span><strong>${fmtDate(probe.last_seen_at)}</strong></div>
        <div class="probe-compact-kpi"><span>Last run</span><strong>${fmtDate(probe.last_run_finished_at || probe.last_run_started_at)}</strong></div>
        <div class="probe-compact-kpi"><span>Version</span><strong>${versionText}${appVersionText}</strong></div>
      </div>
      <div class="probe-compact-summary-row">
        <div class="probe-compact-summary"><span>Summary</span><strong class="log-cell-wrap">${summaryText}</strong></div>
        ${errorText && errorText !== '-' ? `<div class="probe-compact-summary probe-compact-error"><span>Error</span><strong class="log-cell-wrap">${errorText}</strong></div>` : ''}
        <div class="probe-compact-summary probe-port-scan-summary">
          <span>最近 Port 掃描</span>
          <strong>${portScanSummary}</strong>
          <small>主機 ${portScanHost} | 時間 ${portScanTime}</small>
          <strong class="log-cell-wrap">${portScanPorts}</strong>
        </div>
      </div>
    </article>
  `;
}

function rowTemplate(rawService) {
  const service = normalizeService(rawService);
  const enabled = isEnabled(service.enabled);
  const allowRedirects = isEnabled(service.allow_redirects);
  const gasStatusLabel = safeText(service.gas_status) || safeText(service.last_status) || '-';
  const probeStatusLabel = safeText(service.probe_status) || (service.check_mode === 'dual_pending' ? 'Pending' : '-');
  const serviceId = escapeAttr(service.id);
  const cardToneClass = shouldUseWarnServiceCard(service) ? ' service-card-warn' : '';

  return `
    <article class="service-card${cardToneClass}">
      <div class="service-card-header">
        <div class="service-card-title">
          <span class="name-cell">${statusDot(service.last_status)}<strong>${escapeHtmlText(safeText(service.name) || '(Unnamed Service)')}</strong></span>
          <span class="service-card-url">${escapeHtmlText(safeText(service.url) || '-')}</span>
          <span class="service-check-mode-line">${serviceCheckModeBadge(service)}<span class="service-check-mode-detail">${escapeHtmlText(safeText(serviceCheckModeDetail(service)))}</span></span>
        </div>
        <div class="service-card-side">
          <span class="service-card-status">${escapeHtmlText(safeText(service.last_status) || '-')}</span>
          <span class="service-card-meta">HTTP ${escapeHtmlText(safeText(service.last_http_code) || '-')} | ${escapeHtmlText(safeText(service.last_error_type) || '-')} | Fail Streak ${escapeHtmlText(safeText(service.consecutive_failures) || '0')}</span>
        </div>
      </div>

      <div class="service-card-body service-card-body-compact">
        <div class="service-main-grid">
          <label class="span-2">
            Name
            <input data-field="name" data-id="${serviceId}" value="${escapeAttr(service.name)}" />
          </label>
          <label class="span-1">
            Interval (min)
            <input data-field="interval_min" data-id="${serviceId}" type="number" min="1" max="1440" value="${escapeAttr(service.interval_min || 5)}" />
          </label>
          <label class="span-1">
            Check type
            <select data-field="check_type" data-id="${serviceId}">
              <option value="status_code" ${service.check_type === 'status_code' ? 'selected' : ''}>HTTP status</option>
              <option value="keyword" ${service.check_type === 'keyword' ? 'selected' : ''}>Keyword</option>
            </select>
          </label>
          <label class="span-3">
            URL
            <input data-field="url" data-id="${serviceId}" value="${escapeAttr(service.url)}" />
          </label>
          <label class="check-item service-inline-check span-1">
            <input data-field="enabled" data-id="${serviceId}" type="checkbox" ${enabled ? 'checked' : ''} />
            <span>Enabled</span>
          </label>
        </div>

        <div class="service-result-strip">
          <div class="service-result-item"><span>Mode</span><strong>${escapeHtmlText(safeText(service.check_mode_label) || 'Unknown')}</strong></div>
          <div class="service-result-item"><span>Status</span><strong>${escapeHtmlText(safeText(service.last_status) || '-')}</strong></div>
          <div class="service-result-item"><span>GAS</span><strong class="service-status-chip">${statusDot(gasStatusLabel)}${escapeHtmlText(gasStatusLabel)}</strong></div>
          <div class="service-result-item"><span>Probe</span><strong class="service-status-chip">${statusDot(probeStatusLabel)}${escapeHtmlText(probeStatusLabel)}</strong></div>
          <div class="service-result-item"><span>HTTP</span><strong>${escapeHtmlText(safeText(service.last_http_code) || '-')}</strong></div>
          <div class="service-result-item"><span>Error Type</span><strong>${escapeHtmlText(safeText(service.last_error_type) || '-')}</strong></div>
          <div class="service-result-item"><span>Fail Streak</span><strong>${escapeHtmlText(safeText(service.consecutive_failures) || '0')}</strong></div>
          <div class="service-result-item service-result-item-wide"><span>Error</span><strong class="log-cell-wrap">${escapeHtmlText(safeText(service.last_error) || '-')}</strong></div>
        </div>

        <details class="service-advanced">
          <summary>進階設定</summary>
          <div class="service-card-grid service-card-grid-compact">
            <label class="span-1">
              最大重新導向次數
              <input data-field="max_redirects" data-id="${serviceId}" type="number" min="0" max="10" value="${escapeAttr(service.max_redirects)}" />
            </label>
            <label class="span-1">
              延遲警示門檻 (ms)
              <input data-field="latency_warn_ms" data-id="${serviceId}" type="number" min="0" max="600000" value="${escapeAttr(service.latency_warn_ms)}" />
            </label>
            <label class="span-1">
              失敗判定門檻
              <input data-field="fail_threshold" data-id="${serviceId}" type="number" min="1" max="10" value="${escapeAttr(service.fail_threshold)}" />
            </label>
            <label class="span-1">
              重試次數
              <input data-field="retry_count" data-id="${serviceId}" type="number" min="1" max="5" value="${escapeAttr(service.retry_count)}" />
            </label>
            <label class="span-1">
              重試間隔 (ms)
              <input data-field="retry_delay_ms" data-id="${serviceId}" type="number" min="0" max="10000" value="${escapeAttr(service.retry_delay_ms)}" />
            </label>
            <label class="check-item service-inline-check span-1">
              <input data-field="allow_redirects" data-id="${serviceId}" type="checkbox" ${allowRedirects ? 'checked' : ''} />
              <span>跟隨重新導向</span>
            </label>
            <label class="span-2">
              預期關鍵字
              <input data-field="expected_keyword" data-id="${serviceId}" value="${escapeAttr(service.expected_keyword)}" placeholder="選填，內容中必須出現的關鍵字" />
            </label>
            <label class="span-2">
              禁止關鍵字
              <input data-field="forbidden_keyword" data-id="${serviceId}" value="${escapeAttr(service.forbidden_keyword)}" placeholder="選填，內容中不可出現的關鍵字" />
            </label>
            <label class="span-2">
              預期最終 URL
              <input data-field="expected_final_url" data-id="${serviceId}" value="${escapeAttr(service.expected_final_url)}" placeholder="選填，重新導向後應到達的網址" />
            </label>
            <label class="span-2">
              次要 URL
              <input data-field="secondary_url" data-id="${serviceId}" value="${escapeAttr(service.secondary_url)}" placeholder="選填，備援或 Probe 專用網址" />
            </label>
          </div>
        </details>
      </div>

      <div class="service-card-actions">
        <button class="btn tiny" data-action="save" data-id="${serviceId}">儲存</button>
        <button class="btn tiny secondary" data-action="refresh" data-id="${serviceId}">重新檢查</button>
        <button class="btn tiny danger" data-action="disable" data-id="${serviceId}">停用</button>
        <button class="btn tiny danger" data-action="remove" data-id="${serviceId}" data-name="${escapeAttr(service.name)}">移除</button>
      </div>
    </article>
  `;
}

function applyReportConfig(cfg) {
  if (!reportForm) return;
  const rawMode = safeText(cfg.notify_mode || 'mail');
  const notifyMode = rawMode === 'all'
    ? 'mail_line'
    : rawMode === 'mail_teams'
      ? 'mail'
      : rawMode;
  reportForm.elements.recipients.value = safeText(cfg.recipients || '');
  reportForm.elements.notify_mode.value = notifyMode;
  reportForm.elements.frequency.value = safeText(cfg.frequency || 'hourly');
  reportForm.elements.daily_hour.value = Number.isFinite(Number(cfg.daily_hour)) ? Number(cfg.daily_hour) : 9;
  reportForm.elements.enabled.checked = String(cfg.enabled).toLowerCase() !== 'false';
  reportForm.elements.only_on_issue.checked = String(cfg.only_on_issue).toLowerCase() !== 'false';
  reportForm.elements.line_to.value = safeText(cfg.line_to || '');
  reportForm.elements.monitor_label.value = safeText(cfg.monitor_label || '');

  const tokenInput = reportForm.elements.line_channel_access_token;
  if (tokenInput) {
    const masked = safeText(cfg.line_channel_access_token_masked || '');
    tokenInput.value = '';
    tokenInput.dataset.configured = cfg.line_channel_access_token_configured ? 'true' : 'false';
    tokenInput.placeholder = masked
      ? `Configured token (${masked}) - leave blank to keep existing`
      : 'LINE Messaging API Channel Access Token';
    tokenInput.autocomplete = 'off';
  }
}

if (reloadBtn) reloadBtn.addEventListener('click', handleReloadWithOverlay);
if (runNowBtn) runNowBtn.addEventListener('click', handleRunNowWithOverlay);
if (reloadProbesBtn) reloadProbesBtn.addEventListener('click', handleReloadProbes);
if (probesBody) probesBody.addEventListener('click', handleProbeAction);
if (addForm) addForm.addEventListener('submit', handleAdd);
if (adminBody) adminBody.addEventListener('click', handleTableClick);
if (reportForm) reportForm.addEventListener('submit', handleSaveReport);
if (reloadReportBtn) reloadReportBtn.addEventListener('click', handleReloadReportWithOverlay);
if (sendReportNowBtn) sendReportNowBtn.addEventListener('click', handleSendReportNow);
if (portScanConfigForm) portScanConfigForm.addEventListener('submit', handleSavePortScanConfig);
if (reloadPortScanConfigBtn) reloadPortScanConfigBtn.addEventListener('click', handleReloadPortScanConfigWithOverlay);
if (triggerPortScanBtn) triggerPortScanBtn.addEventListener('click', handleRequestPortScanWithOverlay);
if (deleteTestDataForm) deleteTestDataForm.addEventListener('submit', handleDeleteTestData);
if (reloadDeleteDatesBtn) reloadDeleteDatesBtn.addEventListener('click', handleReloadDeleteDatesWithOverlay);

async function initFirstLoad() {
  setLoadingOverlay(true);
  setLoadingProgress(8, '正在載入管理頁面...');
  try {
    const results = await Promise.allSettled([
      loadServices((p) => setLoadingProgress(8 + p * 0.46, '正在載入服務設定...')),
      loadProbes((p) => setLoadingProgress(54 + p * 0.16, '正在載入 Probe 狀態...')),
      loadReportConfig((p) => setLoadingProgress(70 + p * 0.11, '正在載入報表設定...')),
      loadPortScanConfig((p) => setLoadingProgress(81 + p * 0.09, '正在載入 Port 掃描設定...')),
      loadChecksDates(false, (p) => setLoadingProgress(90 + p * 0.10, '正在載入日期資料...'))
    ]);
    const failedCount = results.filter((item) => item.status === 'rejected').length;
    finishFirstLoadOverlay('載入完成', 100);
    if (failedCount && adminMessage) {
      adminMessage.textContent = `部分資料載入失敗，共 ${failedCount} 項。請稍後重新整理。`;
    }
  } catch (err) {
    adminMessage.textContent = `管理頁初始化失敗: ${safeText(err.message)}`;
    finishFirstLoadOverlay('載入失敗', 100);
  }

  loadHostBadge();
}

resetAddFormDefaults();
initFirstLoad();






