import { apiGet, apiPost, safeText } from './common.js?v=20260211-mail1';

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
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingLabel = document.getElementById('loadingLabel');
const loadingPercent = document.getElementById('loadingPercent');
const loadingBarInner = document.getElementById('loadingBarInner');

let services = [];
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

function rowTemplate(s) {
  const enabled = String(s.enabled).toUpperCase() === 'TRUE';
  return `
    <tr>
      <td><input data-field="name" data-id="${safeText(s.id)}" value="${safeText(s.name)}" /></td>
      <td><input data-field="url" data-id="${safeText(s.id)}" value="${safeText(s.url)}" /></td>
      <td><input data-field="interval_min" data-id="${safeText(s.id)}" type="number" min="1" max="1440" value="${safeText(s.interval_min || 5)}" /></td>
      <td><input data-field="enabled" data-id="${safeText(s.id)}" type="checkbox" ${enabled ? 'checked' : ''} /></td>
      <td><button class="btn tiny" data-action="save" data-id="${safeText(s.id)}">儲存</button></td>
      <td><button class="btn tiny danger" data-action="disable" data-id="${safeText(s.id)}">停用</button></td>
    </tr>`;
}

function renderTable() {
  if (!services.length) {
    adminBody.innerHTML = '<tr><td colspan="6">尚無服務</td></tr>';
    return;
  }
  adminBody.innerHTML = services.map(rowTemplate).join('');
}

async function loadServices(onProgress) {
  adminMessage.textContent = '載入中...';
  const res = await apiGet({ action: 'listServices' });
  services = res.data || [];
  renderTable();
  adminMessage.textContent = '';
  if (typeof onProgress === 'function') onProgress(100);
}

function formDataToPayload(id) {
  const fields = [...adminBody.querySelectorAll(`[data-id="${id}"]`)];
  const payload = { id, action: 'updateService' };

  for (const field of fields) {
    const key = field.dataset.field;
    if (key === 'enabled') {
      payload.enabled = field.checked;
    } else if (key === 'interval_min') {
      payload.interval_min = Number(field.value || 5);
    } else {
      payload[key] = field.value;
    }
  }

  return payload;
}

async function handleAdd(e) {
  e.preventDefault();
  addMessage.textContent = '送出中...';

  const form = new FormData(addForm);
  const payload = {
    action: 'addService',
    name: form.get('name'),
    url: form.get('url'),
    interval_min: Number(form.get('interval_min') || 5)
  };

  try {
    const res = await apiPost(payload);
    if (!res.ok) throw new Error(res.error || '新增失敗');
    addForm.reset();
    addMessage.textContent = '新增成功';
    await loadServices();
  } catch (err) {
    addMessage.textContent = `新增失敗: ${safeText(err.message)}`;
  }
}

async function handleTableClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;

  try {
    if (btn.dataset.action === 'save') {
      adminMessage.textContent = '儲存中...';
      const payload = formDataToPayload(id);
      const res = await apiPost(payload);
      if (!res.ok) throw new Error(res.error || '更新失敗');
      adminMessage.textContent = '更新成功';
    }

    if (btn.dataset.action === 'disable') {
      adminMessage.textContent = '停用中...';
      const res = await apiPost({ action: 'deleteService', id });
      if (!res.ok) throw new Error(res.error || '停用失敗');
      adminMessage.textContent = '已停用';
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
    if (!res.ok) throw new Error(res.error || '執行失敗');
    adminMessage.textContent = '已觸發檢查';
  } catch (err) {
    adminMessage.textContent = `執行失敗: ${safeText(err.message)}`;
  }
}

async function handleReloadWithOverlay() {
  await runTransientLoading('重新整理中...', async (setP) => {
    if (setP) setP(25);
    await loadServices((p) => {
      if (setP) setP(25 + p * 0.75);
    });
  });
}

async function handleRunNowWithOverlay() {
  await runTransientLoading('執行檢查中...', async (setP) => {
    if (setP) setP(20);
    await handleRunNow();
    if (setP) setP(60);
    await loadServices((p) => {
      if (setP) setP(60 + p * 0.4);
    });
  });
}

function applyReportConfig(cfg) {
  if (!reportForm) return;
  reportForm.elements.recipients.value = safeText(cfg.recipients || '');
  reportForm.elements.notify_mode.value = safeText(cfg.notify_mode || 'mail');
  reportForm.elements.frequency.value = safeText(cfg.frequency || 'hourly');
  reportForm.elements.daily_hour.value = Number.isFinite(Number(cfg.daily_hour))
    ? Number(cfg.daily_hour)
    : 9;
  reportForm.elements.enabled.checked = String(cfg.enabled).toLowerCase() !== 'false';
  reportForm.elements.only_on_issue.checked = String(cfg.only_on_issue).toLowerCase() !== 'false';
  reportForm.elements.line_channel_access_token.value = safeText(cfg.line_channel_access_token || '');
  reportForm.elements.line_to.value = safeText(cfg.line_to || '');
  reportForm.elements.teams_webhook_url.value = safeText(cfg.teams_webhook_url || '');
}

async function loadReportConfig(onProgress) {
  if (!reportMessage) return;
  reportMessage.textContent = '讀取通知設定中...';
  try {
    const res = await apiGet({ action: 'getReportConfig' });
    applyReportConfig(res.data || {});
    reportMessage.textContent = '通知設定已載入';
    if (typeof onProgress === 'function') onProgress(100);
  } catch (err) {
    reportMessage.textContent = `讀取失敗: ${safeText(err.message)}`;
    if (typeof onProgress === 'function') onProgress(100);
  }
}

async function handleSaveReport(e) {
  e.preventDefault();
  reportMessage.textContent = '儲存中...';
  const notifyMode = reportForm.elements.notify_mode.value;
  const recipients = reportForm.elements.recipients.value.trim();
  const lineToken = reportForm.elements.line_channel_access_token.value.trim();
  const lineTo = reportForm.elements.line_to.value.trim();
  const teamsWebhookUrl = reportForm.elements.teams_webhook_url.value.trim();
  const needsMail = notifyMode !== 'line_only';

  if (needsMail && !recipients) {
    reportMessage.textContent = '儲存失敗: Mail 模式需填寫收件人';
    return;
  }

  if ((notifyMode === 'mail_line' || notifyMode === 'all') && (!lineToken || !lineTo)) {
    reportMessage.textContent = '儲存失敗: 啟用 LINE 模式時，請填寫 LINE Token 與 LINE To';
    return;
  }
  if (notifyMode === 'line_only' && (!lineToken || !lineTo)) {
    reportMessage.textContent = '儲存失敗: LINE-only 模式需填寫 LINE Token 與 LINE To';
    return;
  }
  if ((notifyMode === 'mail_teams' || notifyMode === 'all') && !teamsWebhookUrl) {
    reportMessage.textContent = '儲存失敗: 啟用 Teams 模式時，請填寫 Teams Webhook URL';
    return;
  }

  const payload = {
    action: 'updateReportConfig',
    recipients: recipients,
    notify_mode: notifyMode,
    frequency: reportForm.elements.frequency.value,
    daily_hour: Number(reportForm.elements.daily_hour.value || 9),
    enabled: reportForm.elements.enabled.checked,
    only_on_issue: reportForm.elements.only_on_issue.checked,
    line_channel_access_token: lineToken,
    line_to: lineTo,
    teams_webhook_url: teamsWebhookUrl
  };

  try {
    const res = await apiPost(payload);
    if (!res.ok) throw new Error(res.error || '儲存失敗');
    reportMessage.textContent = '通知設定已更新';
  } catch (err) {
    reportMessage.textContent = `儲存失敗: ${safeText(err.message)}`;
  }
}

async function handleSendReportNow() {
  reportMessage.textContent = '寄送中...';
  try {
    const res = await apiPost({ action: 'sendReportNow' });
    if (!res.ok) throw new Error(res.error || '寄送失敗');
    const channels = Array.isArray(res.channels) ? res.channels : [];
    const sentChannels = channels.filter((c) => c?.sent).map((c) => c.channel).join(', ');
    const failedChannelObjs = channels.filter((c) => !c?.sent);
    const failedChannels = failedChannelObjs.map((c) => c.channel).join(', ');
    const failedDetails = failedChannelObjs
      .map((c) => `${c.channel}: ${safeText(c.error || c.skipped || 'failed')}`)
      .join(' | ');
    if (res.partial) {
      reportMessage.textContent = `部分送達：成功(${sentChannels || '-'})，失敗(${failedChannels || '-'})；${failedDetails}`;
      return;
    }
    if (failedChannelObjs.length) {
      reportMessage.textContent = `未送達：${failedDetails}`;
      return;
    }
    reportMessage.textContent = `已送出測試報告（${sentChannels || 'mail'}）`;
  } catch (err) {
    reportMessage.textContent = `寄送失敗: ${safeText(err.message)}`;
  }
}

async function handleDeleteTestData(e) {
  e.preventDefault();
  if (!deleteTestDataForm || !deleteTestDataMessage) return;

  const date = deleteTestDataForm.elements.date.value;
  if (!date) {
    deleteTestDataMessage.textContent = '請先選擇日期';
    return;
  }

  const confirmed = window.confirm(`確定要刪除 ${date} 的測試資料嗎？此操作無法復原。`);
  if (!confirmed) return;

  deleteTestDataMessage.textContent = '刪除中...';
  try {
    const res = await apiPost({ action: 'deleteTestDataByDate', date });
    if (!res.ok) throw new Error(res.error || '刪除失敗');

    const removedCount = Number(res.data?.deleted_count);
    if (Number.isFinite(removedCount)) {
      deleteTestDataMessage.textContent = `刪除完成，共刪除 ${removedCount} 筆`;
      return;
    }
    deleteTestDataMessage.textContent = '刪除完成';
  } catch (err) {
    deleteTestDataMessage.textContent = `刪除失敗: ${safeText(err.message)}`;
  }
}

reloadBtn.addEventListener('click', handleReloadWithOverlay);
runNowBtn.addEventListener('click', handleRunNowWithOverlay);
addForm.addEventListener('submit', handleAdd);
adminBody.addEventListener('click', handleTableClick);
if (reportForm) reportForm.addEventListener('submit', handleSaveReport);
if (reloadReportBtn) reloadReportBtn.addEventListener('click', loadReportConfig);
if (sendReportNowBtn) sendReportNowBtn.addEventListener('click', handleSendReportNow);
if (deleteTestDataForm) deleteTestDataForm.addEventListener('submit', handleDeleteTestData);

async function initFirstLoad() {
  setLoadingOverlay(true);
  setLoadingProgress(8, '讀取服務清單...');
  try {
    await Promise.all([
      loadServices((p) => setLoadingProgress(8 + p * 0.62, '讀取服務清單...')),
      loadReportConfig((p) => setLoadingProgress(70 + p * 0.28, '讀取通知設定...'))
    ]);
    setLoadingProgress(100, '載入完成');
  } catch (err) {
    adminMessage.textContent = `讀取失敗: ${safeText(err.message)}`;
  } finally {
    if (firstLoadPending) {
      firstLoadPending = false;
      window.setTimeout(() => setLoadingOverlay(false), 220);
    }
  }
}

initFirstLoad();
