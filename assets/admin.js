import { apiGet, apiPost, safeText } from './common.js';

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

let services = [];

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

async function loadServices() {
  adminMessage.textContent = '載入中...';
  const res = await apiGet({ action: 'listServices' });
  services = res.data || [];
  renderTable();
  adminMessage.textContent = '';
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

function applyReportConfig(cfg) {
  if (!reportForm) return;
  reportForm.elements.recipients.value = safeText(cfg.recipients || '');
  reportForm.elements.frequency.value = safeText(cfg.frequency || 'hourly');
  reportForm.elements.daily_hour.value = Number.isFinite(Number(cfg.daily_hour))
    ? Number(cfg.daily_hour)
    : 9;
  reportForm.elements.enabled.checked = String(cfg.enabled).toLowerCase() !== 'false';
  reportForm.elements.only_on_issue.checked = String(cfg.only_on_issue).toLowerCase() !== 'false';
}

async function loadReportConfig() {
  if (!reportMessage) return;
  reportMessage.textContent = '讀取郵件設定中...';
  try {
    const res = await apiGet({ action: 'getReportConfig' });
    applyReportConfig(res.data || {});
    reportMessage.textContent = '郵件設定已載入';
  } catch (err) {
    reportMessage.textContent = `讀取失敗: ${safeText(err.message)}`;
  }
}

async function handleSaveReport(e) {
  e.preventDefault();
  reportMessage.textContent = '儲存中...';
  const payload = {
    action: 'updateReportConfig',
    recipients: reportForm.elements.recipients.value,
    frequency: reportForm.elements.frequency.value,
    daily_hour: Number(reportForm.elements.daily_hour.value || 9),
    enabled: reportForm.elements.enabled.checked,
    only_on_issue: reportForm.elements.only_on_issue.checked
  };

  try {
    const res = await apiPost(payload);
    if (!res.ok) throw new Error(res.error || '儲存失敗');
    reportMessage.textContent = '郵件設定已更新';
  } catch (err) {
    reportMessage.textContent = `儲存失敗: ${safeText(err.message)}`;
  }
}

async function handleSendReportNow() {
  reportMessage.textContent = '寄送中...';
  try {
    const res = await apiPost({ action: 'sendReportNow' });
    if (!res.ok) throw new Error(res.error || '寄送失敗');
    reportMessage.textContent = '已送出測試報告';
  } catch (err) {
    reportMessage.textContent = `寄送失敗: ${safeText(err.message)}`;
  }
}

reloadBtn.addEventListener('click', loadServices);
runNowBtn.addEventListener('click', handleRunNow);
addForm.addEventListener('submit', handleAdd);
adminBody.addEventListener('click', handleTableClick);
if (reportForm) reportForm.addEventListener('submit', handleSaveReport);
if (reloadReportBtn) reloadReportBtn.addEventListener('click', loadReportConfig);
if (sendReportNowBtn) sendReportNowBtn.addEventListener('click', handleSendReportNow);

loadServices().catch(err => {
  adminMessage.textContent = `讀取失敗: ${safeText(err.message)}`;
});
loadReportConfig();
