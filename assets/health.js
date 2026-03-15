import { apiGet, apiPost, fmtDate, safeText, escapeHtml, statusBadge, loadHostBadge, serviceCheckModeBadge, serviceCheckModeDetail, isUpEquivalentStatus } from './common.js?v=20260315-a041';

const summaryEl = document.getElementById('healthSummary');
const staleBody = document.getElementById('staleBody');
const healthMessage = document.getElementById('healthMessage');
const refreshBtn = document.getElementById('refreshBtn');
const runNowBtn = document.getElementById('runNowBtn');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingLabel = document.getElementById('loadingLabel');
const loadingPercent = document.getElementById('loadingPercent');
const loadingBarInner = document.getElementById('loadingBarInner');
const delayOverview = document.getElementById('delayOverview');

const notifyLogBody = document.getElementById('notifyLogBody');
const notifyLogMessage = document.getElementById('notifyLogMessage');
const notifyLogPageInfo = document.getElementById('notifyLogPageInfo');
const notifyLogPrevBtn = document.getElementById('notifyLogPrevBtn');
const notifyLogNextBtn = document.getElementById('notifyLogNextBtn');
const notifyLogRefreshBtn = document.getElementById('notifyLogRefreshBtn');
const notifyLogClearBtn = document.getElementById('notifyLogClearBtn');
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
let notifyLogRequestSeq = 0;

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
    return { stale: false, reason: 'Disabled', lastCheck, nextCheck, intervalMin };
  }

  if (!lastCheck) {
    return { stale: true, reason: '尚未成功檢查', lastCheck, nextCheck, intervalMin };
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
    reason: `已延遲 ${overdueMin} 分鐘`,
    lastCheck,
    nextCheck,
    intervalMin
  };
}

renderSummary = function renderSummarySafe(stats) {
  const schedulerBadge = stats.schedulerState === 'healthy'
    ? '<span class="badge up">正常</span>'
    : stats.schedulerState === 'degraded'
      ? '<span class="badge unknown">部分延遲或異常</span>'
      : '<span class="badge down">已停滯</span>';

  summaryEl.innerHTML = [
    { label: 'API 狀態', value: stats.apiOk ? '正常' : '失敗' },
    { label: 'API 延遲', value: `${stats.apiLatencyMs} ms` },
    { label: '啟用服務數', value: stats.enabledCount },
    { label: '異常服務數', value: stats.staleCount },
    { label: '最近檢查時間', value: stats.lastCheckAt ? fmtDate(stats.lastCheckAt) : '-' },
    { label: '排程 / 檢查狀態', value: schedulerBadge }
  ].map((item) => {
    const valueHtml = String(item.value).includes('<span')
      ? `<div class="metric-value">${item.value}</div>`
      : `<strong>${escapeHtml(item.value)}</strong>`;
    return `
      <article class="metric">
        <p>${escapeHtml(item.label)}</p>
        ${valueHtml}
      </article>
    `;
  }).join('');
};

renderStaleRows = function renderStaleRowsSafe(rows) {
  if (!rows.length) {
    staleBody.innerHTML = '<tr><td colspan="8">目前沒有異常服務</td></tr>';
    return;
  }

  staleBody.innerHTML = rows.map(({ service, check }) => `
    <tr>
      <td data-label="服務">${escapeHtml(safeText(service.name))}</td>
      <td data-label="間隔">${escapeHtml(check.intervalMin)}</td>
      <td data-label="最後檢查">${check.lastCheck ? fmtDate(check.lastCheck) : '-'}</td>
      <td data-label="下次檢查">${check.nextCheck ? fmtDate(check.nextCheck) : '-'}</td>
      <td data-label="狀態">${statusBadge(service.last_status)}</td>
      <td data-label="HTTP">${escapeHtml(safeText(service.last_http_code) || '-')}</td>
      <td data-label="錯誤" class="log-cell-wrap">${escapeHtml(safeText(service.last_error) || '-')}</td>
      <td data-label="原因">${escapeHtml(safeText(getHealthReason(service, check)))}</td>
    </tr>
  `).join('');
};

decorateHealthCheckModes = function decorateHealthCheckModesSafe(rows) {
  const renderedRows = Array.from(staleBody.querySelectorAll('tr'));
  renderedRows.forEach((rowEl, index) => {
    const item = rows[index];
    if (!item || !item.service) return;
    const firstCell = rowEl.querySelector('td');
    if (!firstCell || firstCell.querySelector('.service-check-mode-line')) return;
    const label = document.createElement('div');
    label.className = 'service-check-mode-line';
    label.innerHTML = `${serviceCheckModeBadge(item.service)}<span class="service-check-mode-detail">${escapeHtml(safeText(serviceCheckModeDetail(item.service)))}</span>`;
    firstCell.appendChild(label);
  });
};

function getHealthReason(service, check) {
  const status = safeText(service.last_status);
  if (status && !isUpEquivalentStatus(status)) {
    return service.last_error_type
      ? `${status} / ${safeText(service.last_error_type)}`
      : status;
  }
  return safeText(check.reason || '-');
}

function buildDelayFixList(item) {
  const service = item?.service || {};
  const check = item?.check || {};
  const fixes = [];
  const status = safeText(service.last_status);
  const lastCheck = toDate(service.last_check_at);

  if (!lastCheck) {
    fixes.push('先到管理設定按「立即執行檢查」，確認這個服務至少能成功寫入第一次檢查結果。');
  }

  if (check.stale) {
    fixes.push('檢查 Apps Script 觸發器或 Probe 節點是否仍在執行，並確認排程間隔與 next_check_at 是否持續更新。');
  }

  if (status && !isUpEquivalentStatus(status)) {
    fixes.push('檢查服務網址、HTTP 回應碼與錯誤訊息，必要時修正檢查條件或目標站點狀態。');
  }

  if (!fixes.length) {
    fixes.push('重新載入後再次觀察；若仍持續延遲，建議手動執行檢查並確認排程來源是否正常。');
  }

  return fixes.slice(0, 3);
}

function renderDelayOverview(rows, errorMessage = '') {
  if (!delayOverview) return;

  if (errorMessage) {
    delayOverview.innerHTML = `
      <div class="health-delay-state is-error">
        <strong>目前無法分析延遲項目</strong>
        <p>${escapeHtml(errorMessage)}</p>
      </div>
    `;
    return;
  }

  if (!rows.length) {
    delayOverview.innerHTML = `
      <div class="health-delay-state is-ok">
        <strong>目前沒有延遲項目</strong>
        <p>所有啟用中的服務都在預期時間內完成檢查，排程器狀態正常。</p>
      </div>
    `;
    return;
  }

  delayOverview.innerHTML = `
    <div class="health-delay-state is-warn">
      <strong>以下項目目前延遲或異常</strong>
      <p>這些服務會影響「排程 / 檢查狀態」判定。先看原因，再依建議修正即可恢復正常。</p>
    </div>
    <div class="health-delay-list">
      ${rows.map(({ service, check }) => {
        const status = safeText(service.last_status);
        const fixList = buildDelayFixList({ service, check });
        const delayLabel = check.stale ? safeText(check.reason) : '狀態異常';
        const issueText = service.last_error ? safeText(service.last_error) : '請查看最近一次檢查結果';
        return `
          <article class="health-delay-item">
            <div class="health-delay-item-head">
              <strong>${escapeHtml(safeText(service.name) || '未命名服務')}</strong>
              <span class="health-delay-badge">${escapeHtml(delayLabel)}</span>
            </div>
            <p class="health-delay-item-meta">
              狀態: ${escapeHtml(status || '-')} | 最後檢查: ${escapeHtml(service.last_check_at ? fmtDate(service.last_check_at) : '-')}
            </p>
            <p class="health-delay-item-note">目前資訊: ${escapeHtml(issueText)}</p>
            <ul class="health-delay-fix-list">
              ${fixList.map((fix) => `<li>${escapeHtml(fix)}</li>`).join('')}
            </ul>
          </article>
        `;
      }).join('')}
    </div>
  `;
}

function notificationStatusBadge(item) {
  if (isTrue(item.sent) && isTrue(item.partial)) return '<span class="badge unknown">Partial</span>';
  if (isTrue(item.sent)) return '<span class="badge up">Sent</span>';
  if (item.skipped) return '<span class="badge unknown">Skipped</span>';
  return '<span class="badge down">Failed</span>';
}

function triggerLabel(trigger) {
  return String(trigger || '').toLowerCase() === 'manual' ? 'Manual' : 'Scheduled';
}

function formatIssueService(item) {
  const issueCount = toNum(item.issue_count, 0);
  const serviceCount = toNum(item.service_count, 0);
  return `${issueCount} / ${serviceCount}`;
}

function formatTargetSummary(item) {
  const summary = safeText(item.target_summary).trim();
  const count = toNum(item.target_count, 0);
  if (!summary) return count > 0 ? `${count} targets` : '-';
  return count > 0 ? `${count} targets: ${summary}` : summary;
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
      notifyLogPageInfo.textContent = '0 rows';
    } else {
      const start = (notifyLogPage - 1) * NOTIFY_LOG_PAGE_SIZE + 1;
      const end = Math.min(notifyLogTotalRows, notifyLogPage * NOTIFY_LOG_PAGE_SIZE);
      notifyLogPageInfo.textContent = `Page ${notifyLogPage}/${totalPages} · rows ${start}-${end} / ${notifyLogTotalRows}`;
    }
  }
  if (notifyLogPrevBtn) notifyLogPrevBtn.disabled = notifyLogPage <= 1;
  if (notifyLogNextBtn) notifyLogNextBtn.disabled = !totalPages || notifyLogPage >= totalPages;
  if (notifyLogClearBtn) notifyLogClearBtn.disabled = notifyLogTotalRows <= 0;
}
renderNotificationLogs = function renderNotificationLogsSafe(rows) {
  updateNotifyLogTabButtons();

  if (!rows.length) {
    notifyLogBody.innerHTML = '<tr><td colspan="7">No notification logs</td></tr>';
    updateNotifyLogPager();
    return;
  }

  notifyLogBody.innerHTML = rows.map((item) => `
    <tr>
      <td data-label="Timestamp">${fmtDate(item.timestamp)}</td>
      <td data-label="Trigger">${escapeHtml(triggerLabel(item.trigger))}</td>
      <td data-label="Status">${notificationStatusBadge(item)}</td>
      <td data-label="Issue / Total">${escapeHtml(formatIssueService(item))}</td>
      <td data-label="Targets" class="log-cell-wrap">${escapeHtml(safeText(formatTargetSummary(item)))}</td>
      <td data-label="Subject" class="log-cell-wrap">${escapeHtml(safeText(item.subject) || '-')}</td>
      <td data-label="Note" class="log-cell-wrap">${escapeHtml(safeText(formatLogNote(item)))}</td>
    </tr>
  `).join('');

  updateNotifyLogPager();
};

loadNotificationLogs = async function loadNotificationLogsSafe(options = {}) {
  const requestSeq = ++notifyLogRequestSeq;
  const showMessage = options.showMessage !== false;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  if (onProgress) onProgress(14);
  if (showMessage && notifyLogMessage) {
    notifyLogMessage.textContent = 'Loading notification logs...';
  }

  try {
    const res = await apiGet({
      action: 'getNotificationLogs',
      channel: notifyLogChannel,
      page: notifyLogPage,
      page_size: NOTIFY_LOG_PAGE_SIZE
    });
    if (requestSeq !== notifyLogRequestSeq) return;
    if (onProgress) onProgress(72);

    notifyLogPage = toNum(res.page, 1);
    notifyLogTotalPages = toNum(res.total_pages, 0);
    notifyLogTotalRows = toNum(res.total, 0);

    renderNotificationLogs(res.data || []);
    if (onProgress) onProgress(100);

    if (showMessage && notifyLogMessage) {
      const label = notifyLogChannel === 'line' ? 'LINE' : 'mail';
      notifyLogMessage.textContent = `Loaded ${label} notification logs`;
    }
  } catch (err) {
    if (requestSeq !== notifyLogRequestSeq) return;
    notifyLogTotalPages = 0;
    notifyLogTotalRows = 0;
    notifyLogBody.innerHTML = '<tr><td colspan="7">Failed to load notification logs</td></tr>';
    updateNotifyLogPager();
    if (onProgress) onProgress(100);
    if (notifyLogMessage) {
      notifyLogMessage.textContent = `Failed to load notification logs: ${safeText(err.message)}`;
    }
  }
};

async function clearNotificationLogs() {
  if (!window.confirm('Clear all notification logs?')) return;

  if (notifyLogClearBtn) notifyLogClearBtn.disabled = true;
  if (notifyLogMessage) notifyLogMessage.textContent = 'Clearing notification logs...';

  try {
    const res = await apiPost({ action: 'clearNotificationLogs' });
    if (!res.ok) throw new Error(res.error || 'clearNotificationLogs failed');

    notifyLogPage = 1;
    notifyLogTotalPages = 0;
    notifyLogTotalRows = 0;
    renderNotificationLogs([]);
    await loadNotificationLogs({ showMessage: false });

    if (notifyLogMessage) {
      notifyLogMessage.textContent = `Cleared ${toNum(res.deleted_count, 0)} notification log rows`;
    }
  } catch (err) {
    const rawMessage = safeText(err.message);
    if (notifyLogMessage) {
      notifyLogMessage.textContent = `Failed to clear notification logs: ${rawMessage}`;
    }
    updateNotifyLogPager();
  } finally {
    if (notifyLogClearBtn) notifyLogClearBtn.disabled = notifyLogTotalRows <= 0;
  }
}

async function loadHealth(onProgress, options = {}) {
  if (isLoading) return;
  isLoading = true;
  const deferNotificationLogs = options.deferNotificationLogs === true;
  healthMessage.textContent = 'Loading health status...';
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
    renderDelayOverview(staleList);
    decorateHealthCheckModes(staleList);
    if (typeof onProgress === 'function') onProgress(80);
    if (deferNotificationLogs) {
      window.setTimeout(() => {
        loadNotificationLogs({ showMessage: false }).catch(() => {});
      }, 0);
    } else {
      await loadNotificationLogs({ showMessage: false });
    }

    const nowText = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    healthMessage.textContent = `最後更新時間 ${nowText}，每 60 秒自動更新。`;
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
    renderDelayOverview([], safeText(err.message));
    staleBody.innerHTML = '<tr><td colspan="8">載入健康資料失敗</td></tr>';
    healthMessage.textContent = `載入健康資料失敗: ${safeText(err.message)}`;
    if (typeof onProgress === 'function') onProgress(100);
  } finally {
    isLoading = false;
  }
}

async function legacyRunNowAndCheck() {
  healthMessage.textContent = 'Running checks now...';
  try {
    const res = await apiPost({ action: 'runNow' });
    if (!res.ok) throw new Error(res.error || 'runNow failed');
    healthMessage.textContent = 'Checks started. Refreshing health status in 5 seconds.';
    window.setTimeout(() => {
      loadHealth().catch(() => {});
    }, 5000);
  } catch (err) {
    healthMessage.textContent = `Failed to run checks: ${safeText(err.message)}`;
  }
}

async function handleRefreshWithOverlay() {
  await runTransientLoading('正在重新整理健康狀態...', async (setP) => {
    await loadHealth((p) => {
      if (setP) setP(20 + p * 0.8);
    });
  });
}

async function handleRunNowWithOverlay() {
  await runTransientLoading('正在執行健康檢查...', async (setP) => {
    if (setP) setP(35);
    await runNowAndCheck();
    if (setP) setP(100);
  });
}

async function handleNotifyLogRefreshWithOverlay() {
  await runTransientLoading('正在重新載入通知紀錄...', async (setP) => {
    await loadNotificationLogs({ onProgress: setP });
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
      await handleNotifyLogRefreshWithOverlay();
    });
  }

  if (notifyLogClearBtn) {
    notifyLogClearBtn.addEventListener('click', async () => {
      await clearNotificationLogs();
    });
  }
}

async function initFirstLoad() {
  setLoadingOverlay(true);
  setLoadingProgress(8, '正在載入健康頁面...');
  try {
    await loadHealth((p) => setLoadingProgress(p, '正在載入健康頁面...'));
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
  healthMessage.textContent = 'Running GAS + probe checks now...';
  try {
    const res = await apiPost({ action: 'runNow', request_probe: true, requested_by: 'health' });
    if (!res.ok) throw new Error(res.error || 'runNow failed');
    const data = res.data || {};
    const probeRequested = !!data.probe_requested;
    healthMessage.textContent = probeRequested
      ? 'GAS checks started and probe execution requested. Refreshing in about 6 seconds.'
      : 'GAS checks started. Refreshing in about 5 seconds.';
    await new Promise((resolve) => window.setTimeout(resolve, probeRequested ? 6500 : 5000));
    await loadHealth();
  } catch (err) {
    healthMessage.textContent = `Failed to run checks: ${safeText(err.message)}`;
  }
}

function renderSummary(stats) {
  const schedulerBadge = stats.schedulerState === 'healthy'
    ? '<span class="badge up">正常</span>'
    : stats.schedulerState === 'degraded'
      ? '<span class="badge unknown">部分延遲或異常</span>'
      : '<span class="badge down">已停滯</span>';

  summaryEl.innerHTML = [
    { label: 'API 狀態', value: stats.apiOk ? '正常' : '失敗' },
    { label: 'API 延遲', value: `${stats.apiLatencyMs} ms` },
    { label: '啟用服務數', value: stats.enabledCount },
    { label: '異常服務數', value: stats.staleCount },
    { label: '最近檢查時間', value: stats.lastCheckAt ? fmtDate(stats.lastCheckAt) : '-' },
    { label: '排程 / 檢查狀態', value: schedulerBadge }
  ].map((item) => {
    const valueHtml = String(item.value).includes('<span')
      ? `<div class="metric-value">${item.value}</div>`
      : `<strong>${escapeHtml(item.value)}</strong>`;
    return `
      <article class="metric">
        <p>${escapeHtml(item.label)}</p>
        ${valueHtml}
      </article>
    `;
  }).join('');
}

function renderStaleRows(rows) {
  if (!rows.length) {
    staleBody.innerHTML = '<tr><td colspan="8">目前沒有異常服務</td></tr>';
    return;
  }

  staleBody.innerHTML = rows.map(({ service, check }) => `
    <tr>
      <td data-label="服務">${escapeHtml(safeText(service.name))}</td>
      <td data-label="間隔">${escapeHtml(check.intervalMin)}</td>
      <td data-label="最後檢查">${check.lastCheck ? fmtDate(check.lastCheck) : '-'}</td>
      <td data-label="下次檢查">${check.nextCheck ? fmtDate(check.nextCheck) : '-'}</td>
      <td data-label="狀態">${statusBadge(service.last_status)}</td>
      <td data-label="HTTP">${escapeHtml(safeText(service.last_http_code) || '-')}</td>
      <td data-label="錯誤" class="log-cell-wrap">${escapeHtml(safeText(service.last_error) || '-')}</td>
      <td data-label="原因">${escapeHtml(safeText(getHealthReason(service, check)))}</td>
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
    label.innerHTML = `${serviceCheckModeBadge(item.service)}<span class="service-check-mode-detail">${escapeHtml(safeText(serviceCheckModeDetail(item.service)))}</span>`;
    firstCell.appendChild(label);
  });
}

function renderNotificationLogs(rows) {
  updateNotifyLogTabButtons();

  if (!rows.length) {
    notifyLogBody.innerHTML = '<tr><td colspan="7">No notification logs</td></tr>';
    updateNotifyLogPager();
    return;
  }

  notifyLogBody.innerHTML = rows.map((item) => `
    <tr>
      <td data-label="Timestamp">${fmtDate(item.timestamp)}</td>
      <td data-label="Trigger">${escapeHtml(triggerLabel(item.trigger))}</td>
      <td data-label="Status">${notificationStatusBadge(item)}</td>
      <td data-label="Issue / Total">${escapeHtml(formatIssueService(item))}</td>
      <td data-label="Targets" class="log-cell-wrap">${escapeHtml(safeText(formatTargetSummary(item)))}</td>
      <td data-label="Subject" class="log-cell-wrap">${escapeHtml(safeText(item.subject) || '-')}</td>
      <td data-label="Note" class="log-cell-wrap">${escapeHtml(safeText(formatLogNote(item)))}</td>
    </tr>
  `).join('');

  updateNotifyLogPager();
}

async function loadNotificationLogs(options = {}) {
  const requestSeq = ++notifyLogRequestSeq;
  const showMessage = options.showMessage !== false;
  if (showMessage && notifyLogMessage) {
    notifyLogMessage.textContent = 'Loading notification logs...';
  }

  try {
    const res = await apiGet({
      action: 'getNotificationLogs',
      channel: notifyLogChannel,
      page: notifyLogPage,
      page_size: NOTIFY_LOG_PAGE_SIZE
    });
    if (requestSeq !== notifyLogRequestSeq) return;

    notifyLogPage = toNum(res.page, 1);
    notifyLogTotalPages = toNum(res.total_pages, 0);
    notifyLogTotalRows = toNum(res.total, 0);

    renderNotificationLogs(res.data || []);

    if (showMessage && notifyLogMessage) {
      const label = notifyLogChannel === 'line' ? 'LINE' : 'mail';
      notifyLogMessage.textContent = `Loaded ${label} notification logs`;
    }
  } catch (err) {
    if (requestSeq !== notifyLogRequestSeq) return;
    notifyLogTotalPages = 0;
    notifyLogTotalRows = 0;
    notifyLogBody.innerHTML = '<tr><td colspan="7">Failed to load notification logs</td></tr>';
    updateNotifyLogPager();
    if (notifyLogMessage) {
      notifyLogMessage.textContent = `Failed to load notification logs: ${safeText(err.message)}`;
    }
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




