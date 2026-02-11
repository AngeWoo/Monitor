import { apiGet, apiPost, fmtDate, safeText, statusBadge } from './common.js?v=20260211-mail1';

const summaryEl = document.getElementById('healthSummary');
const staleBody = document.getElementById('staleBody');
const healthMessage = document.getElementById('healthMessage');
const refreshBtn = document.getElementById('refreshBtn');
const runNowBtn = document.getElementById('runNowBtn');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingLabel = document.getElementById('loadingLabel');
const loadingPercent = document.getElementById('loadingPercent');
const loadingBarInner = document.getElementById('loadingBarInner');

let isLoading = false;
let timer = null;
let firstLoadPending = true;
const CLICK_LOADING_MIN_MS = 380;

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

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNum(v, defVal = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : defVal;
}

function isEnabled(v) {
  return String(v).toUpperCase() === 'TRUE' || v === true;
}

function analyzeService(service, nowMs) {
  const intervalMin = Math.max(1, toNum(service.interval_min, 5));
  const intervalMs = intervalMin * 60000;
  const graceMs = Math.max(90000, Math.floor(intervalMs * 0.5));

  const lastCheck = toDate(service.last_check_at);
  const nextCheck = toDate(service.next_check_at);

  if (!isEnabled(service.enabled)) {
    return { stale: false, reason: '停用', lastCheck, nextCheck, intervalMin };
  }

  if (!lastCheck) {
    return { stale: true, reason: '尚無檢查記錄', lastCheck, nextCheck, intervalMin };
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
    { label: 'API 可用性', value: stats.apiOk ? '正常' : '異常' },
    { label: 'API 回應時間', value: `${stats.apiLatencyMs} ms` },
    { label: '啟用服務數', value: stats.enabledCount },
    { label: '可疑服務數', value: stats.staleCount },
    { label: '最近檢查時間', value: stats.lastCheckAt ? fmtDate(stats.lastCheckAt) : '-' },
    { label: '排程判定', value: schedulerBadge }
  ].map(item => {
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
    staleBody.innerHTML = '<tr><td colspan="6">目前沒有可疑服務</td></tr>';
    return;
  }

  staleBody.innerHTML = rows.map(({ service, check }) => `
    <tr>
      <td>${safeText(service.name)}</td>
      <td>${check.intervalMin}</td>
      <td>${check.lastCheck ? fmtDate(check.lastCheck) : '-'}</td>
      <td>${check.nextCheck ? fmtDate(check.nextCheck) : '-'}</td>
      <td>${statusBadge(service.last_status)}</td>
      <td>${safeText(check.reason)}</td>
    </tr>
  `).join('');
}

async function loadHealth(onProgress) {
  if (isLoading) return;
  isLoading = true;
  healthMessage.textContent = '檢查中...';
  if (typeof onProgress === 'function') onProgress(10);

  try {
    const t0 = performance.now();
    const res = await apiGet({ action: 'listServices' });
    if (typeof onProgress === 'function') onProgress(60);
    const apiLatencyMs = Math.round(performance.now() - t0);

    const services = res.data || [];
    const enabledServices = services.filter(s => isEnabled(s.enabled));
    const nowMs = Date.now();

    const analyzed = services.map(service => ({ service, check: analyzeService(service, nowMs) }));
    const staleList = analyzed.filter(x => x.check.stale && isEnabled(x.service.enabled));

    const lastCheckMs = enabledServices
      .map(s => toDate(s.last_check_at))
      .filter(Boolean)
      .map(d => d.getTime())
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

    const nowText = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    healthMessage.textContent = `最後檢查：${nowText}（每 60 秒自動更新）`;
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
    staleBody.innerHTML = '<tr><td colspan="6">無法讀取資料</td></tr>';
    healthMessage.textContent = `讀取失敗: ${safeText(err.message)}`;
    if (typeof onProgress === 'function') onProgress(100);
  } finally {
    isLoading = false;
  }
}

async function runNowAndCheck() {
  healthMessage.textContent = '觸發排程中...';
  try {
    const res = await apiPost({ action: 'runNow' });
    if (!res.ok) throw new Error(res.error || 'runNow 失敗');
    healthMessage.textContent = '已觸發，5 秒後重新讀取...';
    window.setTimeout(loadHealth, 5000);
  } catch (err) {
    healthMessage.textContent = `觸發失敗: ${safeText(err.message)}`;
  }
}

async function handleRefreshWithOverlay() {
  await runTransientLoading('重新整理中...', async (setP) => {
    await loadHealth((p) => {
      if (setP) setP(20 + p * 0.8);
    });
  });
}

async function handleRunNowWithOverlay() {
  await runTransientLoading('觸發排程中...', async (setP) => {
    if (setP) setP(35);
    await runNowAndCheck();
    if (setP) setP(100);
  });
}

refreshBtn.addEventListener('click', handleRefreshWithOverlay);
runNowBtn.addEventListener('click', handleRunNowWithOverlay);

async function initFirstLoad() {
  setLoadingOverlay(true);
  setLoadingProgress(8, '讀取健康資料...');
  try {
    await loadHealth((p) => setLoadingProgress(p, '讀取健康資料...'));
    setLoadingProgress(100, '載入完成');
  } finally {
    if (firstLoadPending) {
      firstLoadPending = false;
      window.setTimeout(() => setLoadingOverlay(false), 220);
    }
  }
}

initFirstLoad();
if (timer) window.clearInterval(timer);
timer = window.setInterval(loadHealth, 60000);
