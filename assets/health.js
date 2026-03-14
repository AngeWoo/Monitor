import { apiGet, apiPost, fmtDate, safeText, statusBadge, loadHostBadge, serviceCheckModeBadge, serviceCheckModeDetail, isUpEquivalentStatus } from './common.js?v=20260314-a018';

const summaryEl = document.getElementById('healthSummary');
const staleBody = document.getElementById('staleBody');
const healthMessage = document.getElementById('healthMessage');
const refreshBtn = document.getElementById('refreshBtn');
const runNowBtn = document.getElementById('runNowBtn');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingLabel = document.getElementById('loadingLabel');
const loadingPercent = document.getElementById('loadingPercent');
const loadingBarInner = document.getElementById('loadingBarInner');

const notifyLogBody = document.getElementById('notifyLogBody');
const notifyLogMessage = document.getElementById('notifyLogMessage');
const notifyLogPageInfo = document.getElementById('notifyLogPageInfo');
const notifyLogPrevBtn = document.getElementById('notifyLogPrevBtn');
const notifyLogNextBtn = document.getElementById('notifyLogNextBtn');
const notifyLogRefreshBtn = document.getElementById('notifyLogRefreshBtn');
const notifyLogTabButtons = Array.from(document.querySelectorAll('[data-log-channel]'));

const CLICK_LOADING_MIN_MS = 380;
const NOTIFY_LOG_PAGE_SIZE = 30;

let isLoading = false;
let timer = null;
let firstLoadPending = true;

let notifyLogChannel = 'mail';
let notifyLogPage = 1;
let notifyLogTotalPages = 0;
let notifyLogTotalRows = 0;

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

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNum(value, defaultValue = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

function isEnabled(value) {
  return String(value).toUpperCase() === 'TRUE' || value === true;
}

function isTrue(value) {
  return value === true || String(value).toUpperCase() === 'TRUE';
}

function analyzeService(service, nowMs) {
  const intervalMin = Math.max(1, toNum(service.interval_min, 5));
  const intervalMs = intervalMin * 60000;
  const graceMs = Math.max(90000, Math.floor(intervalMs * 0.5));

  const lastCheck = toDate(service.last_check_at);
  const nextCheck = toDate(service.next_check_at);

  if (!isEnabled(service.enabled)) {
    return { stale: false, reason: '停用中', lastCheck, nextCheck, intervalMin };
  }

  if (!lastCheck) {
    return { stale: true, reason: '尚未執行過健康檢查', lastCheck, nextCheck, intervalMin };
  }

  const overdueByLast = nowMs - lastCheck.getTime() - intervalMs - graceMs;
  const overdueByNext = nextCheck ? nowMs - nextCheck.getTime() - graceMs : -1;
  const stale = overdueByLast > 0 || overdueByNext > 0;

  if (!stale) {
    return { stale: false, reason: '正常', lastCheck, nextCheck, intervalMin };
  }

  const overdueMs = Math.max(overdueByLast, overdueByNext, 0);
  const overdueMin = Math.ceil(overdueMs / 60000);
  return {
    stale: true,
    reason: `逾時 ${overdueMin} 分鐘`,
    lastCheck,
    nextCheck,
    intervalMin
  };
}

function renderSummary(stats) {
  const schedulerBadge = stats.schedulerState === 'healthy'
    ? '<span class="badge up">正常</span>'
    : stats.schedulerState === 'degraded'
      ? '<span class="badge unknown">部分延遲</span>'
      : '<span class="badge down">疑似停擺</span>';

  summaryEl.innerHTML = [
    { label: 'API 狀態', value: stats.apiOk ? '正常' : '異常' },
    { label: 'API 延遲', value: `${stats.apiLatencyMs} ms` },
    { label: '啟用服務數', value: stats.enabledCount },
    { label: '逾時服務數', value: stats.staleCount },
    { label: '最後檢查時間', value: stats.lastCheckAt ? fmtDate(stats.lastCheckAt) : '-' },
    { label: '排程狀態', value: schedulerBadge }
  ].map((item) => {
    const valueHtml = String(item.value).includes('<span')
      ? `<div class="metric-value">${item.value}</div>`
      : `<strong>${item.value}</strong>`;
    return `
      <article class="metric">
        <p>${item.label}</p>
        ${valueHtml}
      </article>
    `;
  }).join('');
}

function renderStaleRows(rows) {
  if (!rows.length) {
    staleBody.innerHTML = '<tr><td colspan="8">目前沒有逾時服務</td></tr>';
    return;
  }

  staleBody.innerHTML = rows.map(({ service, check }) => `
    <tr>
      <td data-label="服務名稱">${safeText(service.name)}</td>
      <td data-label="檢查間隔">${check.intervalMin}</td>
      <td data-label="最後檢查">${check.lastCheck ? fmtDate(check.lastCheck) : '-'}</td>
      <td data-label="下次預定">${check.nextCheck ? fmtDate(check.nextCheck) : '-'}</td>
      <td data-label="狀態">${statusBadge(service.last_status)}</td>
      <td data-label="HTTP">${safeText(service.last_http_code) || '-'}</td>
      <td data-label="錯誤訊息" class="log-cell-wrap">${safeText(service.last_error) || '-'}</td>
      <td data-label="原因">${safeText(getHealthReason(service, check))}</td>
    </tr>
  `).join('');
}

function decorateHealthCheckModes(rows) {
  const renderedRows = Array.from(staleBody.querySelectorAll('tr'));
  renderedRows.forEach((rowEl, index) => {
    const item = rows[index];
    if (!item || !item.service) return;
    const firstCell = rowEl.querySelector('td');
    if (!firstCell || firstCell.querySelector('.service-check-mode-line')) return;
    const label = document.createElement('div');
    label.className = 'service-check-mode-line';
    label.innerHTML = `${serviceCheckModeBadge(item.service)}<span class="service-check-mode-detail">${safeText(serviceCheckModeDetail(item.service))}</span>`;
    firstCell.appendChild(label);
  });
}

function getHealthReason(service, check) {
  const status = safeText(service.last_status);
  if (status && status !== 'UP') {
    return service.last_error_type
      ? `${status} / ${safeText(service.last_error_type)}`
      : status;
  }
  return safeText(check.reason);
}

function notificationStatusBadge(item) {
  if (isTrue(item.sent) && isTrue(item.partial)) return '<span class="badge unknown">部分成功</span>';
  if (isTrue(item.sent)) return '<span class="badge up">已送出</span>';
  if (item.skipped) return '<span class="badge unknown">已略過</span>';
  return '<span class="badge down">失敗</span>';
}

function triggerLabel(trigger) {
  return String(trigger || '').toLowerCase() === 'manual' ? '手動' : '排程';
}

function formatIssueService(item) {
  const issueCount = toNum(item.issue_count, 0);
  const serviceCount = toNum(item.service_count, 0);
  return `${issueCount} / ${serviceCount}`;
}

function formatTargetSummary(item) {
  const summary = safeText(item.target_summary).trim();
  const count = toNum(item.target_count, 0);
  if (!summary) return count > 0 ? `${count} 筆` : '-';
  return count > 0 ? `${count} 筆: ${summary}` : summary;
}

function formatLogNote(item) {
  const parts = [item.error, item.warning, item.skipped]
    .map((value) => safeText(value).trim())
    .filter((value) => value);
  return parts.length ? parts.join(' | ') : '-';
}

function updateNotifyLogTabButtons() {
  notifyLogTabButtons.forEach((btn) => {
    const active = btn.dataset.logChannel === notifyLogChannel;
    btn.classList.toggle('active', active);
  });
}

function updateNotifyLogPager() {
  const totalPages = notifyLogTotalPages;
  if (notifyLogPageInfo) {
    if (!notifyLogTotalRows) {
      notifyLogPageInfo.textContent = '共 0 筆';
    } else {
      const start = (notifyLogPage - 1) * NOTIFY_LOG_PAGE_SIZE + 1;
      const end = Math.min(notifyLogTotalRows, notifyLogPage * NOTIFY_LOG_PAGE_SIZE);
      notifyLogPageInfo.textContent = `第 ${notifyLogPage}/${totalPages} 頁（${start}-${end} / ${notifyLogTotalRows}）`;
    }
  }
  if (notifyLogPrevBtn) notifyLogPrevBtn.disabled = notifyLogPage <= 1;
  if (notifyLogNextBtn) notifyLogNextBtn.disabled = !totalPages || notifyLogPage >= totalPages;
}

function renderNotificationLogs(rows) {
  updateNotifyLogTabButtons();

  if (!rows.length) {
    notifyLogBody.innerHTML = '<tr><td colspan="7">目前沒有通知紀錄</td></tr>';
    updateNotifyLogPager();
    return;
  }

  notifyLogBody.innerHTML = rows.map((item) => `
    <tr>
      <td data-label="發送時間">${fmtDate(item.timestamp)}</td>
      <td data-label="觸發方式">${triggerLabel(item.trigger)}</td>
      <td data-label="結果">${notificationStatusBadge(item)}</td>
      <td data-label="異常 / 服務">${formatIssueService(item)}</td>
      <td data-label="對象" class="log-cell-wrap">${safeText(formatTargetSummary(item))}</td>
      <td data-label="主旨" class="log-cell-wrap">${safeText(item.subject) || '-'}</td>
      <td data-label="備註" class="log-cell-wrap">${safeText(formatLogNote(item))}</td>
    </tr>
  `).join('');

  updateNotifyLogPager();
}

async function loadNotificationLogs(options = {}) {
  const showMessage = options.showMessage !== false;
  if (showMessage && notifyLogMessage) {
    notifyLogMessage.textContent = '讀取通知紀錄中...';
  }

  try {
    const res = await apiGet({
      action: 'getNotificationLogs',
      channel: notifyLogChannel,
      page: notifyLogPage,
      page_size: NOTIFY_LOG_PAGE_SIZE
    });

    notifyLogPage = toNum(res.page, 1);
    notifyLogTotalPages = toNum(res.total_pages, 0);
    notifyLogTotalRows = toNum(res.total, 0);

    renderNotificationLogs(res.data || []);

    if (showMessage && notifyLogMessage) {
      const label = notifyLogChannel === 'line' ? 'LINE' : '郵件';
      notifyLogMessage.textContent = `已載入 ${label} 通知紀錄`;
    }
  } catch (err) {
    notifyLogTotalPages = 0;
    notifyLogTotalRows = 0;
    notifyLogBody.innerHTML = '<tr><td colspan="7">通知紀錄讀取失敗</td></tr>';
    updateNotifyLogPager();
    if (notifyLogMessage) {
      notifyLogMessage.textContent = `通知紀錄讀取失敗: ${safeText(err.message)}`;
    }
  }
}

async function loadHealth(onProgress) {
  if (isLoading) return;
  isLoading = true;
  healthMessage.textContent = '讀取健康檢查中...';
  if (typeof onProgress === 'function') onProgress(10);

  try {
    const t0 = performance.now();
    const res = await apiGet({ action: 'listServices' });
    if (typeof onProgress === 'function') onProgress(60);
    const apiLatencyMs = Math.round(performance.now() - t0);

    const services = res.data || [];
    const enabledServices = services.filter((service) => isEnabled(service.enabled));
    const nowMs = Date.now();
    const analyzed = services.map((service) => ({
      service,
      check: analyzeService(service, nowMs)
    }));
    const staleList = analyzed.filter((item) => {
      const abnormalStatus = !isUpEquivalentStatus(item.service.last_status);
      return isEnabled(item.service.enabled) && (item.check.stale || abnormalStatus);
    });

    const lastCheckMs = enabledServices
      .map((service) => toDate(service.last_check_at))
      .filter(Boolean)
      .map((date) => date.getTime())
      .sort((a, b) => b - a)[0];

    let schedulerState = 'healthy';
    if (enabledServices.length > 0) {
      if (staleList.length === enabledServices.length) schedulerState = 'stalled';
      else if (staleList.length > 0) schedulerState = 'degraded';
    }

    renderSummary({
      apiOk: true,
      apiLatencyMs,
      enabledCount: enabledServices.length,
      staleCount: staleList.length,
      lastCheckAt: lastCheckMs ? new Date(lastCheckMs) : null,
      schedulerState
    });

    renderStaleRows(staleList);
    decorateHealthCheckModes(staleList);
    if (typeof onProgress === 'function') onProgress(80);
    await loadNotificationLogs({ showMessage: false });

    const nowText = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    healthMessage.textContent = `最後更新時間 ${nowText}，每 60 秒自動刷新`;
    if (typeof onProgress === 'function') onProgress(100);
  } catch (err) {
    renderSummary({
      apiOk: false,
      apiLatencyMs: 0,
      enabledCount: 0,
      staleCount: 0,
      lastCheckAt: null,
      schedulerState: 'stalled'
    });
    staleBody.innerHTML = '<tr><td colspan="8">健康檢查讀取失敗</td></tr>';
    healthMessage.textContent = `讀取失敗: ${safeText(err.message)}`;
    if (typeof onProgress === 'function') onProgress(100);
  } finally {
    isLoading = false;
  }
}

async function legacyRunNowAndCheck() {
  healthMessage.textContent = '正在立即執行健康檢查...';
  try {
    const res = await apiPost({ action: 'runNow' });
    if (!res.ok) throw new Error(res.error || 'runNow failed');
    healthMessage.textContent = '已觸發立即檢查，5 秒後重新整理...';
    window.setTimeout(() => {
      loadHealth().catch(() => {});
    }, 5000);
  } catch (err) {
    healthMessage.textContent = `立即執行失敗: ${safeText(err.message)}`;
  }
}

async function handleRefreshWithOverlay() {
  await runTransientLoading('重新整理健康檢查...', async (setP) => {
    await loadHealth((p) => {
      if (setP) setP(20 + p * 0.8);
    });
  });
}

async function handleRunNowWithOverlay() {
  await runTransientLoading('執行健康檢查...', async (setP) => {
    if (setP) setP(35);
    await runNowAndCheck();
    if (setP) setP(100);
  });
}

function bindNotifyLogEvents() {
  notifyLogTabButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const channel = btn.dataset.logChannel || 'mail';
      if (channel === notifyLogChannel) return;
      notifyLogChannel = channel;
      notifyLogPage = 1;
      await loadNotificationLogs();
    });
  });

  if (notifyLogPrevBtn) {
    notifyLogPrevBtn.addEventListener('click', async () => {
      if (notifyLogPage <= 1) return;
      notifyLogPage -= 1;
      await loadNotificationLogs({ showMessage: false });
    });
  }

  if (notifyLogNextBtn) {
    notifyLogNextBtn.addEventListener('click', async () => {
      if (!notifyLogTotalPages || notifyLogPage >= notifyLogTotalPages) return;
      notifyLogPage += 1;
      await loadNotificationLogs({ showMessage: false });
    });
  }

  if (notifyLogRefreshBtn) {
    notifyLogRefreshBtn.addEventListener('click', async () => {
      await loadNotificationLogs();
    });
  }
}

async function initFirstLoad() {
  setLoadingOverlay(true);
  setLoadingProgress(8, '載入健康檢查頁面...');
  try {
    await loadHealth((p) => setLoadingProgress(p, '載入健康檢查頁面...'));
    setLoadingProgress(100, '載入完成');
    loadHostBadge();
  } finally {
    if (firstLoadPending) {
      firstLoadPending = false;
      window.setTimeout(() => setLoadingOverlay(false), 220);
    }
  }
}

async function runNowAndCheck() {
  healthMessage.textContent = '正在執行 GAS + Probe 健康檢查...';
  try {
    const res = await apiPost({ action: 'runNow', request_probe: true, requested_by: 'health' });
    if (!res.ok) throw new Error(res.error || 'runNow failed');
    const data = res.data || {};
    const probeRequested = !!data.probe_requested;
    healthMessage.textContent = probeRequested
      ? 'GAS 已完成檢查，已通知在線 Probe 同步重測，約 6 秒後更新結果'
      : 'GAS 已完成健康檢查';
    window.setTimeout(() => {
      loadHealth().catch(() => {});
    }, probeRequested ? 6500 : 5000);
  } catch (err) {
    healthMessage.textContent = `執行失敗: ${safeText(err.message)}`;
  }
}

if (refreshBtn) refreshBtn.addEventListener('click', handleRefreshWithOverlay);
if (runNowBtn) runNowBtn.addEventListener('click', handleRunNowWithOverlay);

bindNotifyLogEvents();
initFirstLoad();

if (timer) window.clearInterval(timer);
timer = window.setInterval(() => {
  loadHealth().catch(() => {});
}, 60000);
