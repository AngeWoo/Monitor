import { apiGet, fmtDate, normalizeLatencyMs, safeText, escapeHtml, escapeAttr, safeHttpUrl, statusBadge, loadHostBadge, serviceCheckModeBadge, serviceCheckModeDetail, isUpEquivalentStatus } from './common.js?v=20260315-a041';

const summaryEl = document.getElementById('summary');
const tbody = document.getElementById('servicesBody');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingLabel = document.getElementById('loadingLabel');
const loadingPercent = document.getElementById('loadingPercent');
const loadingBarInner = document.getElementById('loadingBarInner');
const refreshBtn = document.getElementById('refreshBtn');
const refreshIntervalSelect = document.getElementById('refreshIntervalSelect');
const autoRefreshInfo = document.getElementById('autoRefreshInfo');
const hoursSelect = document.getElementById('hoursSelect');
const latencyTitle = document.getElementById('latencyTitle');
const uptimeTitle = document.getElementById('uptimeTitle');
const allLatencyTitle = document.getElementById('allLatencyTitle');
const allAvailabilityBadge = document.getElementById('allAvailabilityBadge');
const latencyRangeStart = document.getElementById('latencyRangeStart');
const latencyRangeEnd = document.getElementById('latencyRangeEnd');
const applyLatencyRangeBtn = document.getElementById('applyLatencyRangeBtn');
const clearLatencyRangeBtn = document.getElementById('clearLatencyRangeBtn');
const quickRangeBtns = document.querySelectorAll('.quick-range-btn');
const historyTitle = document.getElementById('historyTitle');
const minuteHistoryHead = document.getElementById('minuteHistoryHead');
const minuteHistoryBody = document.getElementById('minuteHistoryBody');
const historyPageInfo = document.getElementById('historyPageInfo');
const historyPrevBtn = document.getElementById('historyPrevBtn');
const historyNextBtn = document.getElementById('historyNextBtn');
const chartsGrid = document.querySelector('.charts-grid');
const serviceDetailModal = document.getElementById('serviceDetailModal');
const serviceDetailModalTitle = document.getElementById('serviceDetailModalTitle');
const serviceDetailModalSubtitle = document.getElementById('serviceDetailModalSubtitle');
const serviceDetailModalBody = document.getElementById('serviceDetailModalBody');
const serviceDetailModalClose = document.getElementById('serviceDetailModalClose');
const HISTORY_PAGE_SIZE = 10;
const ALL_SERVICES_ID = '__ALL__';

let services = [];
let selectedId = null;
let latencyChart;
let uptimeChart;
let allLatencyChart;
let isLoading = false;
let autoRefreshTimer = null;
let countdownTimer = null;
let nextRefreshAt = 0;
let autoRefreshMs = 60 * 1000;
let minuteHistoryRows = [];
let historySortKey = 'minute';
let historySortType = 'date';
let historySortDir = 'desc';
let historyPage = 1;
let latencyRange = { start: null, end: null };
let firstLoadPending = true;
let loadingShownAt = 0;
const LOADING_MIN_SHOW_MS = 800;
let checksDataMinDate = null;
let checksDataMaxDate = null;
let batchMetricsCache = null;
let batchMetricsHours = null;
let batchMetricsLoadedAt = 0;
let batchMetricsPromise = null;
let batchMetricsPromiseHours = null;
let chartJsReadyPromise = null;
const BATCH_METRICS_TTL_MS = 55 * 1000;
let renderMetricsRequestSeq = 0;
let renderAllLatencyRequestSeq = 0;

function setSectionTitleText(el, text) {
  if (!el) return;
  const titleText = el.querySelector('.title-text');
  if (titleText) {
    titleText.textContent = text;
    return;
  }
  el.textContent = text;
}

function updateAvailabilityBadge(availabilityText, availabilityValue) {
  if (!allAvailabilityBadge) return;
  allAvailabilityBadge.textContent = `整體服務可用率: ${availabilityText}`;
  allAvailabilityBadge.classList.remove('availability-good', 'availability-warn', 'availability-bad');
  if (availabilityValue > 99) {
    allAvailabilityBadge.classList.add('availability-good');
  } else if (availabilityValue >= 85 && availabilityValue <= 90) {
    allAvailabilityBadge.classList.add('availability-warn');
  } else if (availabilityValue < 85) {
    allAvailabilityBadge.classList.add('availability-bad');
  }
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

function parseDateTimeLocalValue(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getActiveRange() {
  if (latencyRange.start || latencyRange.end) {
    return {
      start: latencyRange.start || null,
      end: latencyRange.end || null
    };
  }
  const hours = Math.max(1, Number(hoursSelect?.value || 24));
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600 * 1000);
  return { start, end };
}

function toDateTimeLocalValue(date) {
  if (!date || Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function setRangeActiveButton(activeBtn) {
  if (quickRangeBtns && quickRangeBtns.length) {
    quickRangeBtns.forEach((btn) => {
      btn.classList.toggle('active', btn === activeBtn);
    });
  }
  if (applyLatencyRangeBtn) {
    applyLatencyRangeBtn.classList.toggle('active', applyLatencyRangeBtn === activeBtn);
  }
  if (clearLatencyRangeBtn) {
    clearLatencyRangeBtn.classList.toggle('active', clearLatencyRangeBtn === activeBtn);
  }
}

function setLoadingOverlay(show) {
  if (!loadingOverlay) return;
  if (show) loadingShownAt = Date.now();
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
  const elapsed = Date.now() - loadingShownAt;
  const waitMs = Math.max(0, LOADING_MIN_SHOW_MS - elapsed);
  window.setTimeout(() => setLoadingOverlay(false), waitMs);
}

function ensureChartJsLoaded() {
  if (window.Chart) return Promise.resolve(window.Chart);
  if (chartJsReadyPromise) return chartJsReadyPromise;

  chartJsReadyPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[data-chartjs-loader="true"]');
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(window.Chart), { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Chart.js 載入失敗')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
    script.async = true;
    script.dataset.chartjsLoader = 'true';
    script.onload = () => resolve(window.Chart);
    script.onerror = () => reject(new Error('Chart.js 載入失敗'));
    document.head.appendChild(script);
  });

  return chartJsReadyPromise;
}

async function ensureChartsReady() {
  await ensureChartJsLoaded();
  ensureCharts();
}

function detectQuickRangeButton(start, end) {
  if (!start || !end || !quickRangeBtns || !quickRangeBtns.length) return null;
  const diffMin = Math.round((end.getTime() - start.getTime()) / 60000);
  for (const btn of quickRangeBtns) {
    const mins = Number(btn.dataset.minutes || 0);
    if (!Number.isFinite(mins) || mins <= 0) continue;
    if (Math.abs(diffMin - mins) <= 1) return btn;
  }
  return null;
}

function minuteKey(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return '';
  d.setSeconds(0, 0);
  return d.toISOString();
}

function renderMinuteHistory(serviceName, rows) {
  if (!minuteHistoryBody || !historyTitle) return;
  setSectionTitleText(historyTitle, `每分鐘歷史記錄 - ${safeText(serviceName)}`);

  if (!rows.length) {
    minuteHistoryRows = [];
    historyPage = 1;
    minuteHistoryBody.innerHTML = '<tr><td colspan="5">此時段沒有歷史資料</td></tr>';
    updateHistoryPager(0);
    updateSortHeaderState();
    return;
  }

  const grouped = new Map();
  rows.forEach((r) => {
    const key = minuteKey(r.timestamp);
    if (!key) return;

    if (!grouped.has(key)) {
      grouped.set(key, {
        minute: key,
        upCount: 0,
        downCount: 0,
        latencySum: 0,
        latencyCount: 0,
        lastHttp: '-',
        lastTs: 0
      });
    }

    const bucket = grouped.get(key);
    if (r.status === 'UP') bucket.upCount += 1;
    if (r.status !== 'UP') bucket.downCount += 1;

    const latency = normalizeLatencyMs(r.latency_ms);
    if (latency !== null) {
      bucket.latencySum += latency;
      bucket.latencyCount += 1;
    }

    const ts = new Date(r.timestamp).getTime();
    if (ts >= bucket.lastTs) {
      bucket.lastTs = ts;
      bucket.lastHttp = safeText(r.http_code) || '-';
    }
  });

  const rowsByMinute = [...grouped.values()]
    .sort((a, b) => new Date(b.minute) - new Date(a.minute))
    .slice(0, 180)
    .map((r) => ({
      ...r,
      avgLatency: r.latencyCount ? Math.round(r.latencySum / r.latencyCount) : -1
    }));

  minuteHistoryRows = rowsByMinute;
  historyPage = 1;
  renderMinuteHistoryPage();
}

function scrollToServiceDetails() {
  const target = chartsGrid || historyTitle || latencyTitle;
  if (!target || typeof target.scrollIntoView !== 'function') return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setServiceDetailModalVisible(show) {
  if (!serviceDetailModal) return;
  serviceDetailModal.classList.toggle('hidden', !show);
  serviceDetailModal.setAttribute('aria-hidden', show ? 'false' : 'true');
  document.body.classList.toggle('modal-open', show);
  if (show && serviceDetailModalClose) {
    window.requestAnimationFrame(() => serviceDetailModalClose.focus());
  }
}

function formatLatencyValue(value) {
  const latency = normalizeLatencyMs(value);
  return latency === null ? '-' : `${latency} ms`;
}

function formatPortScanCell(service) {
  const scan = service?.latest_port_scan;
  if (!scan) return '<span class="port-scan-value is-empty">—</span>';
  const ports = Array.isArray(scan.open_ports) ? scan.open_ports : [];
  const content = ports.length ? escapeHtml(ports.join(', ')) : '無開啟';
  const scannedAt = scan.scanned_at ? fmtDate(scan.scanned_at) : '-';
  const host = escapeHtml(safeText(scan.host || ''));
  const title = host ? `${host} | ${scannedAt}` : scannedAt;
  return `<span class="port-scan-value" title="${escapeAttr(title)}">${content}</span>`;
}

function getServiceRangeText(rows) {
  if (!rows.length) return '此時段沒有檢查資料';
  const firstTs = rows[0]?.timestamp;
  const lastTs = rows[rows.length - 1]?.timestamp;
  if (!firstTs || !lastTs) return '資料時間不完整';
  return `${fmtDate(firstTs)} ~ ${fmtDate(lastTs)}`;
}

function renderModalMetricCard(label, valueHtml, detail = '') {
  return `
    <article class="service-modal-stat">
      <span class="service-modal-stat-label">${escapeHtml(label)}</span>
      <strong class="service-modal-stat-value">${valueHtml}</strong>
      ${detail ? `<span class="service-modal-stat-detail">${escapeHtml(detail)}</span>` : ''}
    </article>
  `;
}

function renderModalMetaItem(label, valueHtml, extraClass = '') {
  return `
    <article class="service-modal-meta-item ${extraClass}">
      <span class="service-modal-meta-label">${escapeHtml(label)}</span>
      <div class="service-modal-meta-value">${valueHtml}</div>
    </article>
  `;
}

function renderServiceDetailModalError(service, err) {
  if (!serviceDetailModalBody) return;
  const serviceName = safeText(service?.name || '服務');
  if (serviceDetailModalTitle) serviceDetailModalTitle.textContent = `${serviceName} 詳細資料`;
  if (serviceDetailModalSubtitle) serviceDetailModalSubtitle.textContent = '載入失敗';
  serviceDetailModalBody.innerHTML = `
    <div class="service-modal-empty service-modal-empty-error">
      <strong>無法載入此測試項資料</strong>
      <p>${escapeHtml(safeText(err?.message || err || '未知錯誤'))}</p>
    </div>
  `;
  setServiceDetailModalVisible(true);
}

function renderServiceDetailModal(service) {
  if (!serviceDetailModalBody) return;
  const serviceName = safeText(service?.name || '服務');
  const serviceUrl = safeText(service?.url || '');
  const serviceHref = safeHttpUrl(serviceUrl);
  const latestStatus = safeText(service?.last_status || '-');
  const latestHttp = safeText(service?.last_http_code || '-');
  const latestError = safeText(service?.last_error || '-');
  const intervalText = `${escapeHtml(safeText(service?.interval_min) || '-')} 分鐘`;
  const enabledText = String(service?.enabled || '').toUpperCase() === 'TRUE' ? '啟用中' : '停用';
  const lastCheckText = fmtDate(service?.last_check_at);
  const latestLatencyText = formatLatencyValue(service?.last_latency_ms);
  const latestPortScan = formatPortScanCell(service);

  if (serviceDetailModalTitle) serviceDetailModalTitle.textContent = `${serviceName} 詳細資料`;
  if (serviceDetailModalSubtitle) serviceDetailModalSubtitle.textContent = '目前服務基本資料';

  serviceDetailModalBody.innerHTML = `
    <section class="service-modal-summary-grid">
      ${renderModalMetricCard('目前狀態', statusBadge(latestStatus), enabledText)}
      ${renderModalMetricCard('最新 HTTP', escapeHtml(latestHttp || '-'), lastCheckText)}
      ${renderModalMetricCard('最新延遲', escapeHtml(latestLatencyText), '來自目前列表資料')}
      ${renderModalMetricCard('檢查間隔', intervalText, escapeHtml(safeText(serviceCheckModeDetail(service))))}
    </section>

    <section class="service-modal-section">
      <div class="service-modal-section-head">
        <h3>服務資訊</h3>
        <span class="service-modal-chip">${intervalText}</span>
      </div>
      <div class="service-modal-meta-grid">
        ${renderModalMetaItem('服務名稱', `<strong>${escapeHtml(serviceName)}</strong>`)}
        ${renderModalMetaItem('檢查方式', `${serviceCheckModeBadge(service)}<span class="service-modal-inline-detail">${escapeHtml(safeText(serviceCheckModeDetail(service)))}</span>`)}
        ${renderModalMetaItem('監測網址', serviceHref
          ? `<a class="url-ellipsis" href="${escapeAttr(serviceHref)}" target="_blank" rel="noreferrer">${escapeHtml(serviceUrl)}</a>`
          : `<span>${escapeHtml(serviceUrl || '-')}</span>`, 'service-modal-meta-item-wide')}
        ${renderModalMetaItem('最後檢查時間', `<strong>${escapeHtml(lastCheckText)}</strong>`)}
        ${renderModalMetaItem('啟用狀態', `<strong>${escapeHtml(enabledText)}</strong>`)}
        ${renderModalMetaItem('最新延遲', `<strong>${escapeHtml(latestLatencyText)}</strong>`)}
        ${renderModalMetaItem('開啟 Ports', latestPortScan)}
        ${renderModalMetaItem('錯誤摘要', `<span>${escapeHtml(latestError || '-')}</span>`, 'service-modal-meta-item-wide')}
      </div>
    </section>
  `;

  setServiceDetailModalVisible(true);
}

function compareValues(a, b, type) {
  if (type === 'date') return new Date(a).getTime() - new Date(b).getTime();
  if (type === 'number') {
    const na = Number(a);
    const nb = Number(b);
    const va = Number.isFinite(na) ? na : Number.POSITIVE_INFINITY;
    const vb = Number.isFinite(nb) ? nb : Number.POSITIVE_INFINITY;
    return va - vb;
  }
  return String(a).localeCompare(String(b), 'zh-Hant');
}

function sortMinuteHistoryRows() {
  const dir = historySortDir === 'asc' ? 1 : -1;
  return [...minuteHistoryRows].sort((a, b) => {
    const cmp = compareValues(a[historySortKey], b[historySortKey], historySortType);
    return cmp * dir;
  });
}

function updateSortHeaderState() {
  if (!minuteHistoryHead) return;
  const buttons = minuteHistoryHead.querySelectorAll('.th-sort');
  buttons.forEach((btn) => {
    const active = btn.dataset.sortKey === historySortKey;
    btn.classList.toggle('active', active);
    btn.dataset.sortDir = active ? historySortDir : '';
  });
}

function updateHistoryPager(totalRows) {
  const totalPages = Math.max(1, Math.ceil(totalRows / HISTORY_PAGE_SIZE));
  if (historyPage > totalPages) historyPage = totalPages;
  if (historyPage < 1) historyPage = 1;

  if (historyPageInfo) {
    if (totalRows === 0) {
      historyPageInfo.textContent = '共 0 筆';
    } else {
      const start = (historyPage - 1) * HISTORY_PAGE_SIZE + 1;
      const end = Math.min(totalRows, historyPage * HISTORY_PAGE_SIZE);
      historyPageInfo.textContent = `第 ${historyPage}/${totalPages} 頁（${start}-${end} / ${totalRows}）`;
    }
  }
  if (historyPrevBtn) historyPrevBtn.disabled = historyPage <= 1;
  if (historyNextBtn) historyNextBtn.disabled = historyPage >= totalPages;
}

renderMinuteHistoryPage = function renderMinuteHistoryPageSafe() {
  const sorted = sortMinuteHistoryRows();
  const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + HISTORY_PAGE_SIZE);

  if (!pageRows.length) {
    minuteHistoryBody.innerHTML = '<tr><td colspan="5">此頁沒有資料</td></tr>';
    updateHistoryPager(sorted.length);
    updateSortHeaderState();
    return;
  }

  minuteHistoryBody.innerHTML = pageRows.map((r) => {
    const avgLatency = r.avgLatency >= 0 ? r.avgLatency : '-';
    const hasIssue = Number(r.downCount || 0) > 0;
    const rowClass = hasIssue ? 'history-alert-row' : '';
    return `
      <tr class="${rowClass}">
        <td data-label="時間">${fmtDate(r.minute)}</td>
        <td data-label="UP">${r.upCount}</td>
        <td data-label="DOWN">${r.downCount}</td>
        <td data-label="平均延遲">${avgLatency}</td>
        <td data-label="HTTP">${r.lastHttp}</td>
      </tr>`;
  }).join('');
  updateHistoryPager(sorted.length);
  updateSortHeaderState();
};

renderSummary = function renderSummarySafe() {
  const total = services.length;
  const enabled = services.filter((s) => String(s.enabled).toUpperCase() === 'TRUE').length;
  const up = services.filter((s) => isUpEquivalentStatus(s.last_status)).length;
  const down = services.filter((s) => !isUpEquivalentStatus(s.last_status)).length;
  const availability = enabled > 0 ? `${((up / enabled) * 100).toFixed(1)}%` : '0.0%';
  const activeRange = getActiveRange();
  const rangeStartText = activeRange.start ? fmtDate(activeRange.start) : '-';
  const rangeEndText = activeRange.end ? fmtDate(activeRange.end) : '-';

  summaryEl.innerHTML = [
    { label: '服務總數', value: total },
    { label: '已啟用', value: enabled },
    { label: '正常服務', value: up },
    { label: '異常服務', value: down },
    { label: '可用率', value: availability },
    { label: '區間開始', value: rangeStartText },
    { label: '區間結束', value: rangeEndText },
    { label: '最早資料日', value: checksDataMinDate || '-' },
    { label: '最新資料日', value: checksDataMaxDate || '-' }
  ].map((item) => `
    <article class="metric">
      <p>${escapeHtml(item.label)}</p>
      <strong>${escapeHtml(item.value)}</strong>
    </article>
  `).join('');
}

async function loadChecksDateRange(onProgress) {
  if (typeof onProgress === 'function') onProgress(12);
  try {
    const res = await apiGet({ action: 'getChecksDateRange' });
    if (res.ok && res.data) {
      if (typeof onProgress === 'function') onProgress(72);
      checksDataMinDate = res.data.minDate || null;
      checksDataMaxDate = res.data.maxDate || null;
      renderSummary();
    }
    if (typeof onProgress === 'function') onProgress(100);
  } catch (_) {
    if (typeof onProgress === 'function') onProgress(100);
    // Date range is optional, silently ignore errors
  }
};

renderTable = function renderTableSafe() {
  if (!services.length) {
    tbody.innerHTML = '<tr><td colspan="9">尚無資料</td></tr>';
    return;
  }

  tbody.innerHTML = services.map((s) => {
    const rowClass = s.id === selectedId ? 'selected-row' : '';
    const latencyMs = normalizeLatencyMs(s.last_latency_ms);
    const serviceUrl = safeText(s.url);
    const href = safeHttpUrl(serviceUrl);
    return `
      <tr class="${rowClass}">
        <td data-label="服務"><span class="service-name-with-dot">${statusDot(s.last_status)}<span>${escapeHtml(safeText(s.name))}</span></span></td>
        <td data-label="URL">
          <a class="url-ellipsis" href="${escapeAttr(href)}" target="_blank" rel="noreferrer" title="${escapeAttr(serviceUrl)}">
            ${escapeHtml(serviceUrl)}
          </a>
          <div class="service-check-mode-line">${serviceCheckModeBadge(s)}<span class="service-check-mode-detail">${escapeHtml(safeText(serviceCheckModeDetail(s)))}</span></div>
        </td>
        <td data-label="狀態">${statusBadge(s.last_status)}</td>
        <td data-label="HTTP">${escapeHtml(safeText(s.last_http_code) || '-')}</td>
        <td data-label="開啟 Ports">${formatPortScanCell(s)}</td>
        <td data-label="延遲">${latencyMs ?? '-'}</td>
        <td data-label="間隔">${escapeHtml(safeText(s.interval_min) || '-')}</td>
        <td data-label="最後檢查">${fmtDate(s.last_check_at)}</td>
        <td data-label="操作"><button class="btn tiny" data-id="${escapeAttr(safeText(s.id))}">查看詳情</button></td>
      </tr>`;
  }).join('');
}

function ensureCharts() {
  if (!latencyChart) {
    latencyChart = new Chart(document.getElementById('latencyChart'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Latency',
            data: [],
            tension: 0.25,
            borderColor: '#2aa18f',
            backgroundColor: '#2aa18f44',
            pointRadius: 3,
            pointHoverRadius: 8,
            pointHitRadius: 36,
            spanGaps: true
          },
          {
            label: '平均延遲',
            data: [],
            tension: 0,
            borderColor: '#e1b400',
            borderDash: [6, 6],
            pointRadius: 0,
            pointHoverRadius: 0,
            spanGaps: true
          },
          {
            label: '最大延遲',
            data: [],
            tension: 0,
            borderColor: '#be2d2d',
            borderDash: [8, 6],
            pointRadius: 0,
            pointHoverRadius: 0,
            spanGaps: true
          },
          {
            label: '最小延遲',
            data: [],
            tension: 0,
            borderColor: '#1d8b4f',
            borderDash: [4, 4],
            pointRadius: 0,
            pointHoverRadius: 0,
            spanGaps: true
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'nearest',
          axis: 'x',
          intersect: false
        },
        plugins: {
          tooltip: {
            enabled: true,
            callbacks: {
              title(ctx) {
                if (!ctx || !ctx.length) return '';
                return `時間: ${safeText(ctx[0].label)}`;
              },
              label(ctx) {
                const v = Number(ctx.parsed?.y ?? ctx.raw ?? 0);
                const name = safeText(ctx.dataset?.label || 'Latency');
                return `${name}: ${Math.round(v)} ms`;
              }
            }
          }
        },
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

  if (!allLatencyChart) {
    const allLatencyCanvas = document.getElementById('allLatencyChart');
    if (allLatencyCanvas) {
      try {
        allLatencyChart = new Chart(allLatencyCanvas, {
          type: 'bar',
          data: {
            labels: [],
            datasets: [
              {
                label: '成功比例 (%)',
                data: [],
                yAxisID: 'y',
                backgroundColor: '#8cb0ff',
                borderColor: '#5b83dd',
                borderWidth: 1,
                borderRadius: 6,
                maxBarThickness: 30,
                minBarLength: 4
              },
              {
                label: '失敗比例 (%)',
                data: [],
                yAxisID: 'y',
                backgroundColor: '#f3a39a',
                borderColor: '#cc6f65',
                borderWidth: 1,
                borderRadius: 6,
                maxBarThickness: 30,
                minBarLength: 4
              },
              {
                label: '平均 Latency (ms)',
                type: 'line',
                data: [],
                yAxisID: 'y1',
                backgroundColor: '#6ac8b955',
                borderColor: '#2aa18f',
                borderWidth: 2,
                tension: 0.25,
                pointRadius: 3,
                pointHoverRadius: 7,
                pointHitRadius: 24
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
              mode: 'index',
              intersect: false
            },
            plugins: {
              legend: { display: true },
              tooltip: {
                callbacks: {
                  label(ctx) {
                    const label = ctx.dataset?.label || '';
                    const v = Number(ctx.parsed?.y ?? ctx.raw ?? 0);
                    if (ctx.datasetIndex === 0 || ctx.datasetIndex === 1) {
                      return `${label}: ${v.toFixed(1)}%`;
                    }
                    return `${label}: ${Math.round(v)} ms`;
                  }
                }
              }
            },
            scales: {
              x: { stacked: true, ticks: { maxRotation: 45, minRotation: 0 } },
              y: {
                stacked: true,
                beginAtZero: true,
                max: 100,
                ticks: {
                  callback(value) {
                    return `${value}%`;
                  }
                },
                title: { display: true, text: '比例 (%)' }
              },
              y1: {
                beginAtZero: true,
                position: 'right',
                grid: { drawOnChartArea: false },
                title: { display: true, text: 'Latency (ms)' }
              }
            }
          }
        });
      } catch (err) {
        if (allLatencyTitle) {
          setSectionTitleText(allLatencyTitle, `Latency 圖表初始化失敗: ${safeText(err?.message || err)}`);
        }
      }
    }
  }
}

async function fetchMetricsAll(hours) {
  const now = Date.now();
  if (
    batchMetricsCache !== null &&
    batchMetricsHours === hours &&
    now - batchMetricsLoadedAt < BATCH_METRICS_TTL_MS
  ) {
    return batchMetricsCache;
  }
  if (batchMetricsPromise && batchMetricsPromiseHours === hours) {
    return batchMetricsPromise;
  }

  batchMetricsPromiseHours = hours;
  batchMetricsPromise = (async () => {
    const result = await apiGet({ action: 'metricsAll', hours });
    batchMetricsCache = (result.ok && result.data) ? result.data : {};
    batchMetricsHours = hours;
    batchMetricsLoadedAt = Date.now();
    return batchMetricsCache;
  })().finally(() => {
    if (batchMetricsPromiseHours === hours) {
      batchMetricsPromise = null;
      batchMetricsPromiseHours = null;
    }
  });

  return batchMetricsPromise;
};

async function fetchServiceMetricsRows(serviceId, hours) {
  const result = await apiGet({ action: 'metrics', serviceId, hours });
  return (result.data || []).map((row) => ({ ...row, _serviceId: serviceId }));
}

function filterRowsByActiveRange(rawRows) {
  const startTs = latencyRange.start ? latencyRange.start.getTime() : null;
  const endTs = latencyRange.end ? latencyRange.end.getTime() : null;
  return rawRows.filter((row) => {
    const ts = new Date(row.timestamp).getTime();
    if (Number.isNaN(ts)) return false;
    if (startTs !== null && ts < startTs) return false;
    if (endTs !== null && ts > endTs) return false;
    return true;
  });
}

renderAllLatencyStats = async function renderAllLatencyStatsSafe(onProgress) {
  await ensureChartsReady();
  if (!allLatencyChart || !allLatencyTitle) return;
  if (!services.length) {
    setSectionTitleText(allLatencyTitle, '所有服務 Latency 統計 (0/0)');
    updateAvailabilityBadge('0.0%', 0);
    allLatencyChart.data.labels = [];
    allLatencyChart.data.datasets[0].data = [];
    allLatencyChart.data.datasets[1].data = [];
    allLatencyChart.data.datasets[2].data = [];
    allLatencyChart.update();
    if (onProgress) onProgress(100);
    return;
  }

  const requestSeq = ++renderAllLatencyRequestSeq;
  const entries = services.map((s, idx) => {
    const latency = normalizeLatencyMs(s.last_latency_ms);
    return {
      id: s.id,
      name: safeText(s.name) || `服務 ${idx + 1}`,
      status: safeText(s.last_status),
      latency,
      value: latency ?? null,
      sampleCount: 0,
      downCount: 0,
      testCount: 0,
      okCount: 0
    };
  });

  const metricsCandidates = entries.filter((item) => item.id);
  if (metricsCandidates.length) {
    const hours = Math.max(1, Number(hoursSelect?.value || 24));
    const allMetrics = await fetchMetricsAll(hours);
    if (requestSeq !== renderAllLatencyRequestSeq) return;
    if (onProgress) onProgress(100);

    const statsById = new Map();
    metricsCandidates.forEach((item) => {
      const rows = allMetrics[item.id] || [];
      const values = rows
        .map((r) => normalizeLatencyMs(r?.latency_ms))
        .filter((v) => v !== null);
      if (values.length) {
        const avg = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
        const downCount = rows.filter((r) => safeText(r?.status) !== 'UP').length;
        statsById.set(item.id, {
          id: item.id,
          avgLatency: avg,
          sampleCount: values.length,
          testCount: rows.length,
          downCount,
          okCount: Math.max(rows.length - downCount, 0)
        });
      } else {
        statsById.set(item.id, {
          id: item.id,
          avgLatency: null,
          sampleCount: 0,
          testCount: 0,
          downCount: 0,
          okCount: 0
        });
      }
    });
    entries.forEach((item) => {
      const stats = statsById.get(item.id);
      if (!stats) return;
      if (stats.avgLatency !== null) {
        item.latency = stats.avgLatency;
        item.value = stats.avgLatency;
        item.sampleCount = stats.sampleCount;
        item.testCount = stats.testCount;
        item.downCount = stats.downCount;
        item.okCount = stats.okCount;
        return;
      }
      if (item.value === null && item.latency !== null) {
        item.value = item.latency;
      }
      item.okCount = Math.max((item.testCount || 0) - (item.downCount || 0), 0);
    });
  }

  const hasLatencyCount = entries.filter((item) => item.latency !== null).length;
  const maxSampleEntry = entries.reduce((best, item) => {
    const sample = Number(item.testCount || 0);
    if (!best || sample > best.sample) return { sample };
    return best;
  }, null);
  const totalTests = entries.reduce((sum, item) => sum + Number(item.testCount || 0), 0);
  const totalOk = entries.reduce((sum, item) => sum + Number(item.okCount || 0), 0);
  const overallAvailability = totalTests > 0
    ? `${((totalOk / totalTests) * 100).toFixed(1)}%`
    : '0.0%';
  setSectionTitleText(allLatencyTitle, hasLatencyCount
    ? `所有服務 Latency 統計 (${hasLatencyCount}/${entries.length}) | 最大樣本數: ${maxSampleEntry?.sample || 0} | 整體可用率: ${overallAvailability}`
    : `所有服務 Latency 統計 | 尚無可用 latency 資料 | 整體可用率: ${overallAvailability}`);
  updateAvailabilityBadge(overallAvailability, (totalOk / Math.max(totalTests, 1)) * 100);

  allLatencyChart.data.labels = entries.map((item) => item.name);
  allLatencyChart.data.datasets[0].data = entries.map((item) => {
    const total = Number(item.testCount || 0);
    if (total <= 0) return 0;
    return Math.round(((Number(item.okCount || 0) / total) * 100) * 10) / 10;
  });
  allLatencyChart.data.datasets[1].data = entries.map((item) => {
    const total = Number(item.testCount || 0);
    if (total <= 0) return 0;
    return Math.round(((Number(item.downCount || 0) / total) * 100) * 10) / 10;
  });
  allLatencyChart.data.datasets[2].data = entries.map((item) => (item.value ?? 0));
  allLatencyChart.options.scales.y.suggestedMax = 100;
  allLatencyChart.options.scales.y1.suggestedMax = hasLatencyCount ? undefined : 10;
  allLatencyChart.update();
  if (onProgress) onProgress(100);
};

renderMetrics = async function renderMetricsSafe(onProgress) {
  const requestSeq = ++renderMetricsRequestSeq;
  const hours = Number(hoursSelect.value || 24);
  let serviceName = '全部服務';
  let rawRows = [];

  if (selectedId && selectedId !== ALL_SERVICES_ID) {
    const service = services.find((s) => s.id === selectedId);
    if (!service) return null;
    serviceName = safeText(service.name);
    rawRows = await fetchServiceMetricsRows(selectedId, hours);
    if (requestSeq !== renderMetricsRequestSeq) return null;
    if (onProgress) onProgress(100);
  } else {
    const allMetrics = await fetchMetricsAll(hours);
    if (requestSeq !== renderMetricsRequestSeq) return null;
    if (onProgress) onProgress(100);
    rawRows = services.flatMap((s) => (allMetrics[s.id] || []).map((r) => ({ ...r, _serviceId: s.id })));
  }

  rawRows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const rows = filterRowsByActiveRange(rawRows);
  if (requestSeq !== renderMetricsRequestSeq) return null;

  const labels = rows.map((r) => fmtDate(r.timestamp));
  const latencyValues = rows.map((r) => normalizeLatencyMs(r.latency_ms));
  const latency = latencyValues.map((v) => v ?? 0);
  const validLatency = latencyValues.filter((v) => v !== null);
  const avgLatency = validLatency.length
    ? Math.round(validLatency.reduce((sum, v) => sum + v, 0) / validLatency.length)
    : null;
  const maxLatency = validLatency.length ? Math.max(...validLatency) : null;
  const minLatency = validLatency.length ? Math.min(...validLatency) : null;
  const pointColors = rows.map((r) => (safeText(r.status) === 'UP' ? '#2aa18f' : '#be2d2d'));
  const upCount = rows.filter((r) => r.status === 'UP').length;
  const downCount = rows.filter((r) => r.status !== 'UP').length;

  const hasRange = latencyRange.start || latencyRange.end;
  const rangeText = hasRange
    ? ` | 區間: ${latencyRange.start ? fmtDate(latencyRange.start) : '起始'} ~ ${latencyRange.end ? fmtDate(latencyRange.end) : '結束'}`
    : '';
  setSectionTitleText(latencyTitle, `${serviceName} | Latency (${hours}h)${rangeText}`);
  setSectionTitleText(uptimeTitle, `${serviceName} | Uptime Ratio`);
  renderSummary();
  renderMinuteHistory(serviceName, rows);

  await ensureChartsReady();

  latencyChart.data.labels = labels;
  latencyChart.data.datasets[0].data = latency;
  latencyChart.data.datasets[0].pointBackgroundColor = pointColors;
  latencyChart.data.datasets[0].pointBorderColor = pointColors;
  latencyChart.data.datasets[1].data = labels.map(() => (avgLatency ?? null));
  latencyChart.data.datasets[2].data = labels.map(() => (maxLatency ?? null));
  latencyChart.data.datasets[3].data = labels.map(() => (minLatency ?? null));
  latencyChart.update();

  uptimeChart.data.datasets[0].data = [upCount, downCount];
  uptimeChart.update();

  return { serviceName, rows, hours };
};

async function loadServices() {
  if (isLoading) return;
  isLoading = true;
  const firstPaintLoad = firstLoadPending;
  setLoadingOverlay(firstPaintLoad);
  if (firstPaintLoad) setLoadingProgress(5, '讀取服務清單...');

  try {
    const result = await apiGet({ action: 'listServices' });
    services = result.data || [];
    if (firstPaintLoad) setLoadingProgress(25, '整理服務資料...');

    if (!selectedId) {
      selectedId = ALL_SERVICES_ID;
    }
    if (selectedId !== ALL_SERVICES_ID && selectedId && !services.some(s => s.id === selectedId)) {
      selectedId = ALL_SERVICES_ID;
    }

    renderSummary();
    renderTable();
    let dateRangeProgress = 0;

    if (firstPaintLoad) {
      setLoadingProgress(35, '載入圖表與歷史資料...');
    }

    let allLatencyProgress = 0;
    let metricsProgress = 0;
    const updateFirstLoadProgress = () => {
      if (!firstPaintLoad) return;
      const percent = 35 + (allLatencyProgress * 0.2) + (metricsProgress * 0.25) + (dateRangeProgress * 0.2);
      setLoadingProgress(percent, '載入圖表與歷史資料...');
    };

    await Promise.allSettled([
      loadChecksDateRange(firstPaintLoad ? (p) => {
        dateRangeProgress = Math.max(0, Math.min(100, Number(p) || 0));
        updateFirstLoadProgress();
      } : null),
      renderAllLatencyStats(firstPaintLoad ? (p) => {
        allLatencyProgress = Math.max(0, Math.min(100, Number(p) || 0));
        updateFirstLoadProgress();
      } : null),
      renderMetrics(firstPaintLoad ? (p) => {
        metricsProgress = Math.max(0, Math.min(100, Number(p) || 0));
        updateFirstLoadProgress();
      } : null)
    ]);
  } finally {
    isLoading = false;
    if (firstLoadPending) finishFirstLoadOverlay('載入完成', 100);
  }
}

function updateAutoRefreshHint() {
  if (!autoRefreshInfo) return;
  const intervalSec = Math.max(1, Math.round(autoRefreshMs / 1000));
  if (!nextRefreshAt) {
    autoRefreshInfo.textContent = `每 ${intervalSec} 秒自動更新`;
    return;
  }
  const remain = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  autoRefreshInfo.textContent = `每 ${intervalSec} 秒自動更新 | ${remain}s`;
}

function markRefreshDone() {
  if (!autoRefreshInfo) return;
  const intervalSec = Math.max(1, Math.round(autoRefreshMs / 1000));
  const nowText = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  autoRefreshInfo.textContent = `最後更新 ${nowText} | ${intervalSec}s 後更新`;
}

function resetAutoRefreshClock() {
  nextRefreshAt = Date.now() + autoRefreshMs;
  updateAutoRefreshHint();
}

function startAutoRefresh() {
  if (autoRefreshTimer) window.clearInterval(autoRefreshTimer);
  if (countdownTimer) window.clearInterval(countdownTimer);

  resetAutoRefreshClock();
  autoRefreshTimer = window.setInterval(async () => {
    try {
      await loadServices();
      markRefreshDone();
    } catch (_) {
      // Keep timer running even if one refresh fails.
    } finally {
      resetAutoRefreshClock();
    }
  }, autoRefreshMs);

  countdownTimer = window.setInterval(updateAutoRefreshHint, 1000);
}

function bindEvents() {
  refreshBtn.addEventListener('click', async () => {
    await loadServices();
    markRefreshDone();
    resetAutoRefreshClock();
  });

  hoursSelect.addEventListener('change', async () => {
    await renderMetrics();
  });

  if (applyLatencyRangeBtn) {
    applyLatencyRangeBtn.addEventListener('click', async () => {
      const start = parseDateTimeLocalValue(latencyRangeStart?.value);
      const end = parseDateTimeLocalValue(latencyRangeEnd?.value);
      if (start && end && start.getTime() > end.getTime()) {
        if (latencyTitle) setSectionTitleText(latencyTitle, 'Latency 範圍無效，開始時間不能晚於結束時間');
        return;
      }
      latencyRange = { start, end };
      const quickBtn = detectQuickRangeButton(start, end);
      setRangeActiveButton(quickBtn || applyLatencyRangeBtn);
      await renderMetrics();
    });
  }

  if (clearLatencyRangeBtn) {
    clearLatencyRangeBtn.addEventListener('click', async () => {
      latencyRange = { start: null, end: null };
      if (latencyRangeStart) latencyRangeStart.value = '';
      if (latencyRangeEnd) latencyRangeEnd.value = '';
      setRangeActiveButton(clearLatencyRangeBtn);
      await renderMetrics();
    });
  }

  if (quickRangeBtns && quickRangeBtns.length) {
    quickRangeBtns.forEach((btn) => {
      btn.addEventListener('click', async () => {
        const mins = Math.max(1, Number(btn.dataset.minutes || 0));
        if (!Number.isFinite(mins) || mins <= 0) return;
        const end = new Date();
        const start = new Date(end.getTime() - mins * 60000);
        latencyRange = { start, end };
        if (latencyRangeStart) latencyRangeStart.value = toDateTimeLocalValue(start);
        if (latencyRangeEnd) latencyRangeEnd.value = toDateTimeLocalValue(end);
        setRangeActiveButton(btn);
        await renderMetrics();
      });
    });
  }

  refreshIntervalSelect.addEventListener('change', () => {
    const sec = Number(refreshIntervalSelect.value || 60);
    autoRefreshMs = Math.max(10, sec) * 1000;
    startAutoRefresh();
    updateAutoRefreshHint();
  });

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-id]');
    if (!btn) return;
    e.preventDefault();
    const serviceId = safeText(btn.dataset.id).trim();
    if (!serviceId) return;
    selectedId = serviceId;
    renderTable();

    const service = services.find((item) => safeText(item.id) === serviceId);
    if (!service) {
      renderServiceDetailModalError(null, '找不到此服務資料');
      return;
    }
    renderServiceDetailModal(service);
  });

  if (serviceDetailModalClose) {
    serviceDetailModalClose.addEventListener('click', () => {
      setServiceDetailModalVisible(false);
    });
  }

  if (serviceDetailModal) {
    serviceDetailModal.addEventListener('click', (e) => {
      if (e.target === serviceDetailModal) {
        setServiceDetailModalVisible(false);
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && serviceDetailModal && !serviceDetailModal.classList.contains('hidden')) {
      setServiceDetailModalVisible(false);
    }
  });

  if (minuteHistoryHead) {
    minuteHistoryHead.addEventListener('click', (e) => {
      const btn = e.target.closest('.th-sort');
      if (!btn) return;
      const nextKey = btn.dataset.sortKey;
      const nextType = btn.dataset.sortType || 'text';
      if (historySortKey === nextKey) {
        historySortDir = historySortDir === 'asc' ? 'desc' : 'asc';
      } else {
        historySortKey = nextKey;
        historySortType = nextType;
        historySortDir = nextKey === 'minute' ? 'desc' : 'asc';
      }
      historyPage = 1;
      renderMinuteHistoryPage();
    });
  }

  if (historyPrevBtn) {
    historyPrevBtn.addEventListener('click', () => {
      historyPage = Math.max(1, historyPage - 1);
      renderMinuteHistoryPage();
    });
  }

  if (historyNextBtn) {
    historyNextBtn.addEventListener('click', () => {
      historyPage += 1;
      renderMinuteHistoryPage();
    });
  }
}

function renderMinuteHistoryPage() {
  const sorted = sortMinuteHistoryRows();
  const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + HISTORY_PAGE_SIZE);

  if (!pageRows.length) {
    minuteHistoryBody.innerHTML = '<tr><td colspan="5">???????</td></tr>';
    updateHistoryPager(sorted.length);
    updateSortHeaderState();
    return;
  }

  minuteHistoryBody.innerHTML = pageRows.map((r) => {
    const avgLatency = r.avgLatency >= 0 ? r.avgLatency : '-';
    const hasIssue = Number(r.downCount || 0) > 0;
    const rowClass = hasIssue ? 'history-alert-row' : '';
    return `
      <tr class="${rowClass}">
        <td data-label="???">${fmtDate(r.minute)}</td>
        <td data-label="UP">${r.upCount}</td>
        <td data-label="DOWN">${r.downCount}</td>
        <td data-label="?勗?蹓?>${avgLatency}</td>
        <td data-label="HTTP">${escapeHtml(r.lastHttp)}</td>
      </tr>`;
  }).join('');
  updateHistoryPager(sorted.length);
  updateSortHeaderState();
}

function renderSummary() {
  const total = services.length;
  const enabled = services.filter((s) => String(s.enabled).toUpperCase() === 'TRUE').length;
  const up = services.filter((s) => isUpEquivalentStatus(s.last_status)).length;
  const down = services.filter((s) => !isUpEquivalentStatus(s.last_status)).length;
  const availability = enabled > 0 ? `${((up / enabled) * 100).toFixed(1)}%` : '0.0%';
  const activeRange = getActiveRange();
  const rangeStartText = activeRange.start ? fmtDate(activeRange.start) : '-';
  const rangeEndText = activeRange.end ? fmtDate(activeRange.end) : '-';

  summaryEl.innerHTML = [
    { label: 'Total Services', value: total },
    { label: 'Enabled', value: enabled },
    { label: 'Current UP', value: up },
    { label: 'Current DOWN', value: down },
    { label: 'Availability', value: availability },
    { label: 'Range Start', value: rangeStartText },
    { label: 'Range End', value: rangeEndText },
    { label: 'Earliest Check Date', value: checksDataMinDate || '-' },
    { label: 'Latest Check Date', value: checksDataMaxDate || '-' }
  ].map((item) => `
    <article class="metric">
      <p>${escapeHtml(item.label)}</p>
      <strong>${escapeHtml(item.value)}</strong>
    </article>
  `).join('');
}

function renderTable() {
  if (!services.length) {
    tbody.innerHTML = '<tr><td colspan="9">?垓????</td></tr>';
    return;
  }

  tbody.innerHTML = services.map((s) => {
    const rowClass = s.id === selectedId ? 'selected-row' : '';
    const latencyMs = normalizeLatencyMs(s.last_latency_ms);
    const urlText = safeText(s.url);
    const href = safeHttpUrl(urlText) || '#';
    return `
      <tr class="${rowClass}">
        <td data-label="???"><span class="service-name-with-dot">${statusDot(s.last_status)}<span>${escapeHtml(safeText(s.name))}</span></span></td>
        <td data-label="URL">
          <a class="url-ellipsis" href="${escapeAttr(href)}" target="_blank" rel="noreferrer" title="${escapeAttr(urlText)}">
            ${escapeHtml(urlText)}
          </a>
          <div class="service-check-mode-line">${serviceCheckModeBadge(s)}<span class="service-check-mode-detail">${escapeHtml(safeText(serviceCheckModeDetail(s)))}</span></div>
        </td>
        <td data-label="????>${statusBadge(s.last_status)}</td>
        <td data-label="HTTP">${escapeHtml(safeText(s.last_http_code) || '-')}</td>
        <td data-label="開啟 Ports">${formatPortScanCell(s)}</td>
        <td data-label="?勗?蹓?>${latencyMs ?? '-'}</td>
        <td data-label="?擗?">${escapeHtml(safeText(s.interval_min) || '-')}</td>
        <td data-label="???綽???>${fmtDate(s.last_check_at)}</td>
        <td data-label=""><button class="btn tiny" data-id="${escapeAttr(safeText(s.id))}">?鈭?</button></td>
      </tr>`;
  }).join('');
}

async function renderAllLatencyStats(onProgress) {
  const requestSeq = ++renderAllLatencyRequestSeq;
  if (!allLatencyChart) ensureCharts();
  if (!allLatencyChart || !allLatencyTitle) return;
  if (!services.length) {
    setSectionTitleText(allLatencyTitle, '所有服務 Latency 統計 (0/0)');
    updateAvailabilityBadge('0.0%', 0);
    allLatencyChart.data.labels = [];
    allLatencyChart.data.datasets[0].data = [];
    allLatencyChart.data.datasets[1].data = [];
    allLatencyChart.data.datasets[2].data = [];
    allLatencyChart.update();
    if (onProgress) onProgress(100);
    return;
  }

  const entries = services.map((s, idx) => {
    const latency = normalizeLatencyMs(s.last_latency_ms);
    return {
      id: s.id,
      name: safeText(s.name) || `??? ${idx + 1}`,
      status: safeText(s.last_status),
      latency,
      value: latency ?? null,
      sampleCount: 0,
      downCount: 0,
      testCount: 0,
      okCount: 0
    };
  });

  const metricsCandidates = entries.filter((item) => item.id);
  if (metricsCandidates.length) {
    const hours = Math.max(1, Number(hoursSelect?.value || 24));
    const allMetrics = await fetchMetricsAll(hours);
    if (requestSeq !== renderAllLatencyRequestSeq) return;
    if (onProgress) onProgress(100);

    const statsById = new Map();
    metricsCandidates.forEach((item) => {
      const rows = allMetrics[item.id] || [];
      const values = rows
        .map((r) => normalizeLatencyMs(r?.latency_ms))
        .filter((v) => v !== null);
      if (values.length) {
        const avg = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
        const downCount = rows.filter((r) => safeText(r?.status) !== 'UP').length;
        statsById.set(item.id, {
          id: item.id,
          avgLatency: avg,
          sampleCount: values.length,
          testCount: rows.length,
          downCount,
          okCount: Math.max(rows.length - downCount, 0)
        });
      } else {
        statsById.set(item.id, {
          id: item.id,
          avgLatency: null,
          sampleCount: 0,
          testCount: 0,
          downCount: 0,
          okCount: 0
        });
      }
    });
    entries.forEach((item) => {
      const stats = statsById.get(item.id);
      if (!stats) return;
      if (stats.avgLatency !== null) {
        item.latency = stats.avgLatency;
        item.value = stats.avgLatency;
        item.sampleCount = stats.sampleCount;
        item.testCount = stats.testCount;
        item.downCount = stats.downCount;
        item.okCount = stats.okCount;
        return;
      }
      if (item.value === null && item.latency !== null) {
        item.value = item.latency;
      }
      item.okCount = Math.max((item.testCount || 0) - (item.downCount || 0), 0);
    });
  }

  if (requestSeq !== renderAllLatencyRequestSeq) return;

  const hasLatencyCount = entries.filter((item) => item.latency !== null).length;
  const maxSampleEntry = entries.reduce((best, item) => {
    const sample = Number(item.testCount || 0);
    if (!best || sample > best.sample) return { sample };
    return best;
  }, null);
  const totalTests = entries.reduce((sum, item) => sum + Number(item.testCount || 0), 0);
  const totalOk = entries.reduce((sum, item) => sum + Number(item.okCount || 0), 0);
  const overallAvailability = totalTests > 0
    ? `${((totalOk / totalTests) * 100).toFixed(1)}%`
    : '0.0%';
  setSectionTitleText(
    allLatencyTitle,
    hasLatencyCount
      ? `所有服務 Latency 統計 (${hasLatencyCount}/${entries.length}) | 最大樣本數 ${maxSampleEntry?.sample || 0} | 整體可用率 ${overallAvailability}`
      : `所有服務 Latency 統計 | 目前沒有可用 latency 資料 | 整體可用率 ${overallAvailability}`
  );
  updateAvailabilityBadge(overallAvailability, (totalOk / Math.max(totalTests, 1)) * 100);

  allLatencyChart.data.labels = entries.map((item) => item.name);
  allLatencyChart.data.datasets[0].data = entries.map((item) => {
    const total = Number(item.testCount || 0);
    if (total <= 0) return 0;
    return Math.round(((Number(item.okCount || 0) / total) * 100) * 10) / 10;
  });
  allLatencyChart.data.datasets[1].data = entries.map((item) => {
    const total = Number(item.testCount || 0);
    if (total <= 0) return 0;
    return Math.round(((Number(item.downCount || 0) / total) * 100) * 10) / 10;
  });
  allLatencyChart.data.datasets[2].data = entries.map((item) => (item.value ?? 0));
  allLatencyChart.options.scales.y.suggestedMax = 100;
  allLatencyChart.options.scales.y1.suggestedMax = hasLatencyCount ? undefined : 10;
  allLatencyChart.update();
  if (onProgress) onProgress(100);
}

async function renderMetrics(onProgress) {
  const requestSeq = ++renderMetricsRequestSeq;
  const hours = Number(hoursSelect.value || 24);
  let serviceName = 'All Services';
  let rawRows = [];

  if (selectedId && selectedId !== ALL_SERVICES_ID) {
    const service = services.find((s) => s.id === selectedId);
    if (!service) return;
    serviceName = safeText(service.name);
    const result = await apiGet({ action: 'metrics', serviceId: selectedId, hours });
    if (requestSeq !== renderMetricsRequestSeq) return;
    rawRows = (result.data || []).map((r) => ({ ...r, _serviceId: selectedId }));
    if (onProgress) onProgress(100);
  } else {
    const allMetrics = await fetchMetricsAll(hours);
    if (requestSeq !== renderMetricsRequestSeq) return;
    if (onProgress) onProgress(100);
    rawRows = services.flatMap((s) => (allMetrics[s.id] || []).map((r) => ({ ...r, _serviceId: s.id })));
  }

  rawRows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const startTs = latencyRange.start ? latencyRange.start.getTime() : null;
  const endTs = latencyRange.end ? latencyRange.end.getTime() : null;
  const rows = rawRows.filter((r) => {
    const ts = new Date(r.timestamp).getTime();
    if (Number.isNaN(ts)) return false;
    if (startTs !== null && ts < startTs) return false;
    if (endTs !== null && ts > endTs) return false;
    return true;
  });

  if (requestSeq !== renderMetricsRequestSeq) return;

  const labels = rows.map((r) => fmtDate(r.timestamp));
  const latencyValues = rows.map((r) => normalizeLatencyMs(r.latency_ms));
  const latency = latencyValues.map((v) => v ?? 0);
  const validLatency = latencyValues.filter((v) => v !== null);
  const avgLatency = validLatency.length
    ? Math.round(validLatency.reduce((sum, v) => sum + v, 0) / validLatency.length)
    : null;
  const maxLatency = validLatency.length ? Math.max(...validLatency) : null;
  const minLatency = validLatency.length ? Math.min(...validLatency) : null;
  const pointColors = rows.map((r) => (safeText(r.status) === 'UP' ? '#2aa18f' : '#be2d2d'));
  const upCount = rows.filter((r) => r.status === 'UP').length;
  const downCount = rows.filter((r) => r.status !== 'UP').length;

  const hasRange = latencyRange.start || latencyRange.end;
  const rangeText = hasRange
    ? ` | ???? ${latencyRange.start ? fmtDate(latencyRange.start) : '???'} ~ ${latencyRange.end ? fmtDate(latencyRange.end) : '?荒??'}`
    : '';
  setSectionTitleText(latencyTitle, `${serviceName} | Latency (${hours}h)${rangeText}`);
  setSectionTitleText(uptimeTitle, `${serviceName} | Uptime Ratio`);
  renderSummary();
  renderMinuteHistory(serviceName, rows);

  latencyChart.data.labels = labels;
  latencyChart.data.datasets[0].data = latency;
  latencyChart.data.datasets[0].pointBackgroundColor = pointColors;
  latencyChart.data.datasets[0].pointBorderColor = pointColors;
  latencyChart.data.datasets[1].data = labels.map(() => (avgLatency ?? null));
  latencyChart.data.datasets[2].data = labels.map(() => (maxLatency ?? null));
  latencyChart.data.datasets[3].data = labels.map(() => (minLatency ?? null));
  latencyChart.update();

  uptimeChart.data.datasets[0].data = [upCount, downCount];
  uptimeChart.update();
}

(async function init() {
  if (refreshIntervalSelect) {
    autoRefreshMs = Math.max(10, Number(refreshIntervalSelect.value || 60)) * 1000;
  }
  bindEvents();
  startAutoRefresh();
  window.setTimeout(() => {
    ensureChartJsLoaded().catch(() => {});
  }, 0);
  try {
    await loadServices();
    markRefreshDone();
    resetAutoRefreshClock();
    loadHostBadge();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8">霈?仃?? ${safeText(err.message)}</td></tr>`;
    if (minuteHistoryBody) {
      minuteHistoryBody.innerHTML = '<tr><td colspan="5">霈?仃??/td></tr>';
    }
  } finally {
    isLoading = false;
  }
})();



