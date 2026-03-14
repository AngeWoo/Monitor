import { apiGet, apiPost, safeText, loadHostBadge } from './common.js?v=20260314-a006';

const addForm = document.getElementById('addForm');
const addMessage = document.getElementById('addMessage');
const adminBody = document.getElementById('adminServicesBody');
const adminMessage = document.getElementById('adminMessage');
const reloadBtn = document.getElementById('reloadBtn');
const runNowBtn = document.getElementById('runNowBtn');
const reportForm = document.getElementById('reportForm');
const reportMessage = document.getElementById('reportMessage');
const reloadReportBtn = document.getElementById('reloadReportBtn');
const sendReportNowBtn = document.getElementById('sendReportNowBtn');
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

let services = [];
let firstLoadPending = true;
let deleteProgressTimer = null;
let deleteProgressValue = 0;

function serviceDefaults() {
  return {
    check_type: 'status_code',
    expected_keyword: '',
    forbidden_keyword: '',
    expected_final_url: '',
    secondary_url: '',
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

function populateDateSelect(dates) {
  if (!deleteTestDataDateSelect) return;
  deleteTestDataDateSelect.innerHTML = dates.length
    ? '<option value="">-- 請選擇日期 --</option>' + dates.map((date) => `<option value="${safeText(date)}">${safeText(date)}</option>`).join('')
    : '<option value="">目前沒有資料</option>';
}

function setDeleteProgressUI(percent) {
  if (deleteProgressBar) deleteProgressBar.style.width = `${percent}%`;
  if (deleteProgressPct) deleteProgressPct.textContent = `${percent}%`;
}

function startDeleteProgress() {
  deleteProgressValue = 0;
  setDeleteProgressUI(0);
  if (deleteProgressWrap) deleteProgressWrap.classList.remove('hidden');
  if (deleteTestDataSubmitBtn) deleteTestDataSubmitBtn.disabled = true;
  if (deleteTestDataMessage) deleteTestDataMessage.textContent = '';
  deleteProgressTimer = window.setInterval(() => {
    deleteProgressValue += (82 - deleteProgressValue) * 0.07;
    setDeleteProgressUI(Math.min(82, Math.round(deleteProgressValue)));
  }, 400);
}

function finishDeleteProgress(success) {
  if (deleteProgressTimer) {
    window.clearInterval(deleteProgressTimer);
    deleteProgressTimer = null;
  }
  if (deleteTestDataSubmitBtn) deleteTestDataSubmitBtn.disabled = false;
  if (success) {
    setDeleteProgressUI(100);
    window.setTimeout(() => {
      if (deleteProgressWrap) deleteProgressWrap.classList.add('hidden');
    }, 900);
  } else {
    if (deleteProgressWrap) deleteProgressWrap.classList.add('hidden');
    setDeleteProgressUI(0);
  }
}

function statusDot(status) {
  const value = String(status || '').toUpperCase();
  if (value === 'UP') return '<span class="status-dot dot-up" title="UP"></span>';
  if (value === 'SLOW' || value === 'UNSTABLE') return '<span class="status-dot dot-unknown" title="UNSTABLE"></span>';
  if (value) return '<span class="status-dot dot-down" title="DOWN"></span>';
  return '<span class="status-dot dot-unknown" title="UNKNOWN"></span>';
}

function normalizeService(service) {
  return { ...serviceDefaults(), ...service };
}

function rowTemplate(rawService) {
  const service = normalizeService(rawService);
  const enabled = isEnabled(service.enabled);
  const allowRedirects = isEnabled(service.allow_redirects);

  return `
    <article class="service-card">
      <div class="service-card-header">
        <div class="service-card-title">
          <span class="name-cell">${statusDot(service.last_status)}<strong>${safeText(service.name) || '(未命名服務)'}</strong></span>
          <span class="service-card-url">${safeText(service.url) || '-'}</span>
        </div>
        <div class="service-card-side">
          <span class="service-card-status">${safeText(service.last_status) || '-'}</span>
          <span class="service-card-meta">HTTP ${safeText(service.last_http_code) || '-'} | ${safeText(service.last_error_type) || '-'} | Fail Streak ${safeText(service.consecutive_failures) || '0'}</span>
        </div>
      </div>

      <div class="service-card-body service-card-body-compact">
        <div class="service-main-grid">
          <label class="span-2">
            服務名稱
            <input data-field="name" data-id="${safeText(service.id)}" value="${escapeAttr(service.name)}" />
          </label>
          <label class="span-1">
            間隔(分)
            <input data-field="interval_min" data-id="${safeText(service.id)}" type="number" min="1" max="1440" value="${escapeAttr(service.interval_min || 5)}" />
          </label>
          <label class="span-1">
            檢測方式
            <select data-field="check_type" data-id="${safeText(service.id)}">
              <option value="status_code" ${service.check_type === 'status_code' ? 'selected' : ''}>HTTP 狀態碼</option>
              <option value="keyword" ${service.check_type === 'keyword' ? 'selected' : ''}>關鍵字驗證</option>
            </select>
          </label>
          <label class="span-3">
            URL
            <input data-field="url" data-id="${safeText(service.id)}" value="${escapeAttr(service.url)}" />
          </label>
          <label class="check-item service-inline-check span-1">
            <input data-field="enabled" data-id="${safeText(service.id)}" type="checkbox" ${enabled ? 'checked' : ''} />
            <span>啟用服務</span>
          </label>
        </div>

        <div class="service-result-strip">
          <div class="service-result-item"><span>狀態</span><strong>${safeText(service.last_status) || '-'}</strong></div>
          <div class="service-result-item"><span>HTTP</span><strong>${safeText(service.last_http_code) || '-'}</strong></div>
          <div class="service-result-item"><span>Error Type</span><strong>${safeText(service.last_error_type) || '-'}</strong></div>
          <div class="service-result-item"><span>連續失敗</span><strong>${safeText(service.consecutive_failures) || '0'}</strong></div>
          <div class="service-result-item service-result-item-wide"><span>Error 訊息</span><strong class="log-cell-wrap">${safeText(service.last_error) || '-'}</strong></div>
        </div>

        <details class="service-advanced">
          <summary>進階檢查設定</summary>
          <div class="service-card-grid service-card-grid-compact">
            <label class="span-1">
              最大跳轉
              <input data-field="max_redirects" data-id="${safeText(service.id)}" type="number" min="0" max="10" value="${escapeAttr(service.max_redirects)}" />
            </label>
            <label class="span-1">
              延遲警戒(ms)
              <input data-field="latency_warn_ms" data-id="${safeText(service.id)}" type="number" min="0" max="600000" value="${escapeAttr(service.latency_warn_ms)}" />
            </label>
            <label class="span-1">
              失敗門檻
              <input data-field="fail_threshold" data-id="${safeText(service.id)}" type="number" min="1" max="10" value="${escapeAttr(service.fail_threshold)}" />
            </label>
            <label class="span-1">
              重試次數
              <input data-field="retry_count" data-id="${safeText(service.id)}" type="number" min="1" max="5" value="${escapeAttr(service.retry_count)}" />
            </label>
            <label class="span-1">
              重試間隔(ms)
              <input data-field="retry_delay_ms" data-id="${safeText(service.id)}" type="number" min="0" max="10000" value="${escapeAttr(service.retry_delay_ms)}" />
            </label>
            <label class="check-item service-inline-check span-1">
              <input data-field="allow_redirects" data-id="${safeText(service.id)}" type="checkbox" ${allowRedirects ? 'checked' : ''} />
              <span>允許跳轉</span>
            </label>
            <label class="span-2">
              必須包含關鍵字
              <input data-field="expected_keyword" data-id="${safeText(service.id)}" value="${escapeAttr(service.expected_keyword)}" placeholder="留空表示不檢查" />
            </label>
            <label class="span-2">
              不可包含關鍵字
              <input data-field="forbidden_keyword" data-id="${safeText(service.id)}" value="${escapeAttr(service.forbidden_keyword)}" placeholder="留空表示不檢查" />
            </label>
            <label class="span-2">
              預期最終網址
              <input data-field="expected_final_url" data-id="${safeText(service.id)}" value="${escapeAttr(service.expected_final_url)}" placeholder="留空表示不限制最終網址" />
            </label>
            <label class="span-2">
              第二觀測網址
              <input data-field="secondary_url" data-id="${safeText(service.id)}" value="${escapeAttr(service.secondary_url)}" placeholder="留空表示只用主網址觀測" />
            </label>
          </div>
        </details>
      </div>

      <div class="service-card-actions">
        <button class="btn tiny" data-action="save" data-id="${safeText(service.id)}">儲存設定</button>
        <button class="btn tiny danger" data-action="disable" data-id="${safeText(service.id)}">停用</button>
        <button class="btn tiny danger" data-action="remove" data-id="${safeText(service.id)}" data-name="${escapeAttr(service.name)}">刪除</button>
      </div>
    </article>
  `;
}

function renderServices() {
  if (!services.length) {
    adminBody.innerHTML = '<div class="service-empty">目前沒有服務</div>';
    return;
  }
  adminBody.innerHTML = services.map(rowTemplate).join('');
}

async function loadServices(onProgress) {
  adminMessage.textContent = '載入服務中...';
  const res = await apiGet({ action: 'listServices' });
  services = (res.data || []).map(normalizeService);
  renderServices();
  adminMessage.textContent = '';
  if (typeof onProgress === 'function') onProgress(100);
}

function fieldValue(field) {
  if (field.type === 'checkbox') return field.checked;
  if (field.type === 'number') return Number(field.value || 0);
  return field.value;
}

function formDataToPayload(id) {
  const fields = Array.from(adminBody.querySelectorAll(`[data-id="${id}"]`));
  const payload = { action: 'updateService', id };
  fields.forEach((field) => {
    payload[field.dataset.field] = fieldValue(field);
  });
  return payload;
}

function addFormPayload() {
  const form = new FormData(addForm);
  return {
    action: 'addService',
    name: form.get('name'),
    url: form.get('url'),
    interval_min: Number(form.get('interval_min') || 5),
    check_type: form.get('check_type'),
    expected_keyword: form.get('expected_keyword'),
    forbidden_keyword: form.get('forbidden_keyword'),
    expected_final_url: form.get('expected_final_url'),
    secondary_url: form.get('secondary_url'),
    allow_redirects: addForm.elements.allow_redirects.checked,
    max_redirects: Number(form.get('max_redirects') || 5),
    latency_warn_ms: Number(form.get('latency_warn_ms') || 5000),
    fail_threshold: Number(form.get('fail_threshold') || 2),
    retry_count: Number(form.get('retry_count') || 2),
    retry_delay_ms: Number(form.get('retry_delay_ms') || 1200)
  };
}

function resetAddFormDefaults() {
  addForm.reset();
  addForm.elements.interval_min.value = 5;
  addForm.elements.max_redirects.value = 5;
  addForm.elements.latency_warn_ms.value = 5000;
  addForm.elements.fail_threshold.value = 2;
  addForm.elements.retry_count.value = 2;
  addForm.elements.retry_delay_ms.value = 1200;
  addForm.elements.allow_redirects.checked = true;
}

async function handleAdd(event) {
  event.preventDefault();
  addMessage.textContent = '新增中...';
  try {
    const res = await apiPost(addFormPayload());
    if (!res.ok) throw new Error(res.error || 'addService failed');
    resetAddFormDefaults();
    addMessage.textContent = '服務已新增';
    await loadServices();
  } catch (err) {
    addMessage.textContent = `新增失敗: ${safeText(err.message)}`;
  }
}

async function handleTableClick(event) {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  try {
    if (action === 'save') {
      adminMessage.textContent = '儲存中...';
      const res = await apiPost(formDataToPayload(id));
      if (!res.ok) throw new Error(res.error || 'updateService failed');
      adminMessage.textContent = '設定已更新';
    } else if (action === 'disable') {
      adminMessage.textContent = '停用中...';
      const res = await apiPost({ action: 'deleteService', id });
      if (!res.ok) throw new Error(res.error || 'deleteService failed');
      adminMessage.textContent = '服務已停用';
    } else if (action === 'remove') {
      const name = btn.dataset.name || id;
      const confirmed = window.confirm(`確定要永久刪除 ${name} 嗎？這不會清除既有 checks 歷史。`);
      if (!confirmed) return;
      adminMessage.textContent = '刪除中...';
      const res = await apiPost({ action: 'hardDeleteService', id });
      if (!res.ok) throw new Error(res.error || 'hardDeleteService failed');
      adminMessage.textContent = '服務已刪除';
    }

    await loadServices();
  } catch (err) {
    adminMessage.textContent = `操作失敗: ${safeText(err.message)}`;
  }
}

async function handleRunNow() {
  adminMessage.textContent = '執行中...';
  try {
    const res = await apiPost({ action: 'runNow' });
    if (!res.ok) throw new Error(res.error || 'runNow failed');
    adminMessage.textContent = '已觸發健康檢查';
    await loadServices();
  } catch (err) {
    adminMessage.textContent = `執行失敗: ${safeText(err.message)}`;
  }
}

async function handleReloadWithOverlay() {
  await runTransientLoading('重新整理服務...', async (setP) => {
    if (setP) setP(25);
    await loadServices((p) => {
      if (setP) setP(25 + p * 0.75);
    });
  });
}

async function handleRunNowWithOverlay() {
  await runTransientLoading('執行健康檢查...', async (setP) => {
    if (setP) setP(20);
    await handleRunNow();
    if (setP) setP(100);
  });
}

function applyReportConfig(cfg) {
  if (!reportForm) return;
  reportForm.elements.recipients.value = safeText(cfg.recipients || '');
  reportForm.elements.notify_mode.value = safeText(cfg.notify_mode || 'mail');
  reportForm.elements.frequency.value = safeText(cfg.frequency || 'hourly');
  reportForm.elements.daily_hour.value = Number.isFinite(Number(cfg.daily_hour)) ? Number(cfg.daily_hour) : 9;
  reportForm.elements.enabled.checked = String(cfg.enabled).toLowerCase() !== 'false';
  reportForm.elements.only_on_issue.checked = String(cfg.only_on_issue).toLowerCase() !== 'false';
  reportForm.elements.line_channel_access_token.value = safeText(cfg.line_channel_access_token || '');
  reportForm.elements.line_to.value = safeText(cfg.line_to || '');
  reportForm.elements.teams_webhook_url.value = safeText(cfg.teams_webhook_url || '');
  reportForm.elements.monitor_label.value = safeText(cfg.monitor_label || '');
}

async function loadLineTargetSummary() {
  if (!lineUserStats) return;
  try {
    const res = await apiGet({ action: 'getLineTargetSummary' });
    const data = res.data || {};
    lineUserStats.textContent = `Recorded LINE users: ${Number(data.user_count || 0)} / groups: ${Number(data.group_count || 0)} / rooms: ${Number(data.room_count || 0)}`;
  } catch (_) {
    lineUserStats.textContent = 'Recorded LINE users: -';
  }
}

async function loadReportConfig(onProgress) {
  reportMessage.textContent = '讀取通知設定中...';
  try {
    const res = await apiGet({ action: 'getReportConfig' });
    applyReportConfig(res.data || {});
    await loadLineTargetSummary();
    reportMessage.textContent = '通知設定已載入';
    if (typeof onProgress === 'function') onProgress(100);
  } catch (err) {
    reportMessage.textContent = `讀取失敗: ${safeText(err.message)}`;
    if (typeof onProgress === 'function') onProgress(100);
  }
}

async function handleSaveReport(event) {
  event.preventDefault();
  reportMessage.textContent = '儲存中...';

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
    line_to: reportForm.elements.line_to.value.trim(),
    teams_webhook_url: reportForm.elements.teams_webhook_url.value.trim()
  };

  try {
    const res = await apiPost(payload);
    if (!res.ok) throw new Error(res.error || 'updateReportConfig failed');
    reportMessage.textContent = '通知設定已儲存';
  } catch (err) {
    reportMessage.textContent = `儲存失敗: ${safeText(err.message)}`;
  }
}

async function handleSendReportNow() {
  reportMessage.textContent = '寄送測試通知中...';
  try {
    const res = await apiPost({ action: 'sendReportNow' });
    if (!res.ok) throw new Error(res.error || 'sendReportNow failed');
    const channels = Array.isArray(res.channels) ? res.channels : [];
    const details = channels.map((item) => {
      const state = item.sent ? 'OK' : `FAIL(${safeText(item.error || item.skipped || '')})`;
      return `${item.channel}: ${state}`;
    }).join(' | ');
    reportMessage.textContent = details || '已送出測試通知';
  } catch (err) {
    reportMessage.textContent = `寄送失敗: ${safeText(err.message)}`;
  }
}

async function loadChecksDates(forceRefresh) {
  if (!deleteTestDataDateSelect) return;

  if (!forceRefresh) {
    const cached = loadCachedDates();
    if (cached) {
      populateDateSelect(cached);
      if (deleteTestDataDatesInfo) deleteTestDataDatesInfo.textContent = `共 ${cached.length} 個日期`;
      return;
    }
  }

  if (deleteTestDataDatesInfo) deleteTestDataDatesInfo.textContent = '讀取日期中...';
  try {
    const res = await apiGet({ action: 'getChecksDates' }, 120000);
    const dates = res.ok && res.data && Array.isArray(res.data.dates) ? res.data.dates : [];
    saveCachedDates(dates);
    populateDateSelect(dates);
    if (deleteTestDataDatesInfo) deleteTestDataDatesInfo.textContent = dates.length ? `共 ${dates.length} 個日期` : '目前沒有資料';
  } catch (err) {
    if (deleteTestDataDatesInfo) deleteTestDataDatesInfo.textContent = `讀取失敗: ${safeText(err.message)}`;
    if (deleteTestDataDateSelect) deleteTestDataDateSelect.innerHTML = '<option value="">目前無法讀取</option>';
  }
}

async function handleDeleteTestData(event) {
  event.preventDefault();
  const date = (deleteTestDataDateSelect?.value || deleteTestDataForm.elements.date_manual?.value || '').trim();
  if (!date) {
    deleteTestDataMessage.textContent = '請選擇或輸入日期';
    return;
  }

  const confirmed = window.confirm(`確定要刪除 ${date} 的 checks 資料嗎？`);
  if (!confirmed) return;

  startDeleteProgress();
  try {
    const res = await apiPost({ action: 'deleteTestDataByDate', date }, 300000);
    if (!res.ok) throw new Error(res.error || 'deleteTestDataByDate failed');
    finishDeleteProgress(true);
    deleteTestDataMessage.textContent = `刪除完成，筆數: ${Number(res.data?.deleted_count || 0)}`;
    clearChecksDatesCache();
    await loadChecksDates(true);
  } catch (err) {
    finishDeleteProgress(false);
    deleteTestDataMessage.textContent = `刪除失敗: ${safeText(err.message)}`;
  }
}

if (reloadBtn) reloadBtn.addEventListener('click', handleReloadWithOverlay);
if (runNowBtn) runNowBtn.addEventListener('click', handleRunNowWithOverlay);
if (addForm) addForm.addEventListener('submit', handleAdd);
if (adminBody) adminBody.addEventListener('click', handleTableClick);
if (reportForm) reportForm.addEventListener('submit', handleSaveReport);
if (reloadReportBtn) reloadReportBtn.addEventListener('click', () => loadReportConfig());
if (sendReportNowBtn) sendReportNowBtn.addEventListener('click', handleSendReportNow);
if (deleteTestDataForm) deleteTestDataForm.addEventListener('submit', handleDeleteTestData);
if (reloadDeleteDatesBtn) reloadDeleteDatesBtn.addEventListener('click', () => loadChecksDates(true));

async function initFirstLoad() {
  setLoadingOverlay(true);
  setLoadingProgress(8, '載入管理頁...');
  try {
    await Promise.all([
      loadServices((p) => setLoadingProgress(8 + p * 0.62, '載入服務設定...')),
      loadReportConfig((p) => setLoadingProgress(70 + p * 0.28, '載入通知設定...'))
    ]);
    setLoadingProgress(100, '載入完成');
  } catch (err) {
    adminMessage.textContent = `載入失敗: ${safeText(err.message)}`;
  } finally {
    if (firstLoadPending) {
      firstLoadPending = false;
      window.setTimeout(() => setLoadingOverlay(false), 220);
    }
  }

  loadChecksDates(false);
  loadHostBadge();
}

resetAddFormDefaults();
initFirstLoad();
