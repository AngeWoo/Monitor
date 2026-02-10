import { apiGet, fmtDate, safeText, statusBadge } from './common.js';

const summaryEl = document.getElementById('summary');
const tbody = document.getElementById('servicesBody');
const refreshBtn = document.getElementById('refreshBtn');
const hoursSelect = document.getElementById('hoursSelect');
const latencyTitle = document.getElementById('latencyTitle');
const uptimeTitle = document.getElementById('uptimeTitle');

let services = [];
let selectedId = null;
let latencyChart;
let uptimeChart;

function renderSummary() {
  const total = services.length;
  const enabled = services.filter(s => String(s.enabled).toUpperCase() === 'TRUE').length;
  const up = services.filter(s => s.last_status === 'UP').length;
  const down = services.filter(s => s.last_status === 'DOWN').length;

  summaryEl.innerHTML = [
    { label: '總服務數', value: total },
    { label: '啟用中', value: enabled },
    { label: '目前 UP', value: up },
    { label: '目前 DOWN', value: down }
  ].map(item => `<article class="metric"><p>${item.label}</p><strong>${item.value}</strong></article>`).join('');
}

function renderTable() {
  if (!services.length) {
    tbody.innerHTML = '<tr><td colspan="8">尚無資料</td></tr>';
    return;
  }

  tbody.innerHTML = services.map(s => {
    const rowClass = s.id === selectedId ? 'selected-row' : '';
    return `
      <tr class="${rowClass}">
        <td>${safeText(s.name)}</td>
        <td><a href="${safeText(s.url)}" target="_blank" rel="noreferrer">${safeText(s.url)}</a></td>
        <td>${statusBadge(s.last_status)}</td>
        <td>${safeText(s.last_http_code) || '-'}</td>
        <td>${safeText(s.last_latency_ms) || '-'}</td>
        <td>${safeText(s.interval_min) || '-'}</td>
        <td>${fmtDate(s.last_check_at)}</td>
        <td><button class="btn tiny" data-id="${safeText(s.id)}">查看</button></td>
      </tr>`;
  }).join('');
}

function ensureCharts() {
  if (!latencyChart) {
    latencyChart = new Chart(document.getElementById('latencyChart'), {
      type: 'line',
      data: { labels: [], datasets: [{ label: 'Latency ms', data: [], tension: 0.25 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true } }
      }
    });
  }

  if (!uptimeChart) {
    uptimeChart = new Chart(document.getElementById('uptimeChart'), {
      type: 'doughnut',
      data: {
        labels: ['UP', 'DOWN'],
        datasets: [{ data: [0, 0] }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }
}

async function renderMetrics() {
  const service = services.find(s => s.id === selectedId);
  if (!service) return;

  const hours = Number(hoursSelect.value || 24);
  const result = await apiGet({ action: 'metrics', serviceId: selectedId, hours });
  const rows = (result.data || []).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const labels = rows.map(r => fmtDate(r.timestamp));
  const latency = rows.map(r => Number(r.latency_ms || 0));
  const upCount = rows.filter(r => r.status === 'UP').length;
  const downCount = rows.filter(r => r.status === 'DOWN').length;

  latencyTitle.textContent = `${safeText(service.name)} Latency (${hours}h)`;
  uptimeTitle.textContent = `${safeText(service.name)} Uptime Ratio`;

  latencyChart.data.labels = labels;
  latencyChart.data.datasets[0].data = latency;
  latencyChart.update();

  uptimeChart.data.datasets[0].data = [upCount, downCount];
  uptimeChart.update();
}

async function loadServices() {
  const result = await apiGet({ action: 'listServices' });
  services = result.data || [];

  if (!selectedId && services[0]) {
    selectedId = services[0].id;
  }

  renderSummary();
  renderTable();
  await renderMetrics();
}

function bindEvents() {
  refreshBtn.addEventListener('click', loadServices);

  hoursSelect.addEventListener('change', async () => {
    await renderMetrics();
  });

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-id]');
    if (!btn) return;
    selectedId = btn.dataset.id;
    renderTable();
    await renderMetrics();
  });
}

(async function init() {
  ensureCharts();
  bindEvents();
  try {
    await loadServices();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8">讀取失敗: ${safeText(err.message)}</td></tr>`;
  }
})();
