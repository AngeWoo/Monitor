import { apiGet, fmtDate, normalizeLatencyMs, safeText, statusBadge } from './common.js';

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
  loadingOverlay.classList.toggle('hidden', !show);
}

function setLoadingProgress(percent, label) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  if (loadingPercent) loadingPercent.textContent = `${Math.round(p)}%`;
  if (loadingBarInner) loadingBarInner.style.width = `${p}%`;
  if (loadingLabel && label) loadingLabel.textContent = label;
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
  historyTitle.textContent = `每分鐘歷史記錄 - ${safeText(serviceName)}`;

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
    if (r.status === 'DOWN') bucket.downCount += 1;

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

function renderMinuteHistoryPage() {
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
    const hasIssue = Number(r.downCount || 0) === 1;
    const rowClass = hasIssue ? 'history-alert-row' : '';
    return `
      <tr class="${rowClass}">
        <td>${fmtDate(r.minute)}</td>
        <td>${r.upCount}</td>
        <td>${r.downCount}</td>
        <td>${avgLatency}</td>
        <td>${r.lastHttp}</td>
      </tr>`;
  }).join('');
  updateHistoryPager(sorted.length);
  updateSortHeaderState();
}

function renderSummary() {
  const total = services.length;
  const enabled = services.filter(s => String(s.enabled).toUpperCase() === 'TRUE').length;
  const up = services.filter(s => s.last_status === 'UP').length;
  const down = services.filter(s => s.last_status === 'DOWN').length;
  const availability = enabled > 0 ? `${((up / enabled) * 100).toFixed(1)}%` : '0.0%';
  const activeRange = getActiveRange();
  const rangeText = `${activeRange.start ? fmtDate(activeRange.start) : '起始'}\n~ ${activeRange.end ? fmtDate(activeRange.end) : '結束'}`;

  summaryEl.innerHTML = [
    { label: '總服務數', value: total },
    { label: '啟用中', value: enabled },
    { label: '目前 UP', value: up },
    { label: '目前 DOWN', value: down },
    { label: '可用率', value: availability },
    { label: '日期起訖', value: rangeText, isRange: true }
  ].map(item => `
    <article class="metric">
      <p>${item.label}</p>
      ${item.isRange
        ? `<div class="metric-range-value">${safeText(item.value).replace('\n', '<br>')}</div>`
        : `<strong>${item.value}</strong>`}
    </article>
  `).join('');
}

function renderTable() {
  if (!services.length) {
    tbody.innerHTML = '<tr><td colspan="8">尚無資料</td></tr>';
    return;
  }

  tbody.innerHTML = services.map(s => {
    const rowClass = s.id === selectedId ? 'selected-row' : '';
    const latencyMs = normalizeLatencyMs(s.last_latency_ms);
    return `
      <tr class="${rowClass}">
        <td>${safeText(s.name)}</td>
        <td>
          <a class="url-ellipsis" href="${safeText(s.url)}" target="_blank" rel="noreferrer" title="${safeText(s.url)}">
            ${safeText(s.url)}
          </a>
        </td>
        <td>${statusBadge(s.last_status)}</td>
        <td>${safeText(s.last_http_code) || '-'}</td>
        <td>${latencyMs ?? '-'}</td>
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
            label: '平均線',
            data: [],
            tension: 0,
            borderColor: '#e1b400',
            borderDash: [6, 6],
            pointRadius: 0,
            pointHoverRadius: 0,
            spanGaps: true
          },
          {
            label: '最大線',
            data: [],
            tension: 0,
            borderColor: '#be2d2d',
            borderDash: [8, 6],
            pointRadius: 0,
            pointHoverRadius: 0,
            spanGaps: true
          },
          {
            label: '最小線',
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
                label: '正常佔比(%)',
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
                label: '中斷佔比(%)',
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
                label: '平均 Latency(ms)',
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
                title: { display: true, text: '百分比(%)' }
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
          allLatencyTitle.textContent = `Latency 圖表初始化失敗: ${safeText(err?.message || err)}`;
        }
      }
    }
  }
}

async function renderAllLatencyStats(onProgress) {
  if (!allLatencyChart) ensureCharts();
  if (!allLatencyChart || !allLatencyTitle) return;
  if (!services.length) {
    allLatencyTitle.textContent = '所有測試項目 Latency 統計 (0/0)';
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
    let done = 0;
    const total = metricsCandidates.length;
    const statsResults = await Promise.all(metricsCandidates.map(async (item) => {
      try {
        const result = await apiGet({ action: 'metrics', serviceId: item.id, hours });
        const rows = result.data || [];
        const values = rows
          .map((r) => normalizeLatencyMs(r?.latency_ms))
          .filter((v) => v !== null);

        if (values.length) {
          const avg = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
          const downCount = rows.filter((r) => safeText(r?.status) === 'DOWN').length;
          return {
            id: item.id,
            avgLatency: avg,
            sampleCount: values.length,
            testCount: rows.length,
            downCount,
            okCount: Math.max(rows.length - downCount, 0)
          };
        }
      } catch (_) {
        // Keep default values when metrics fetch fails.
      }
      return {
        id: item.id,
        avgLatency: null,
        sampleCount: 0,
        testCount: 0,
        downCount: 0,
        okCount: 0
      };
    }).map((promise) => promise.finally(() => {
      done += 1;
      if (onProgress) onProgress((done / total) * 100);
    })));

    const statsById = new Map(statsResults.map((r) => [r.id, r]));
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
  allLatencyTitle.textContent = hasLatencyCount
    ? `所有測試項目 Latency 統計 (${hasLatencyCount}/${entries.length}) | 最大統計筆數: ${maxSampleEntry?.sample || 0}`
    : '所有測試項目 Latency 統計（目前無可用 latency 資料）';

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
  const hours = Number(hoursSelect.value || 24);
  let serviceName = '所有項目';
  let rawRows = [];

  if (selectedId && selectedId !== ALL_SERVICES_ID) {
    const service = services.find((s) => s.id === selectedId);
    if (!service) return;
    serviceName = safeText(service.name);
    const result = await apiGet({ action: 'metrics', serviceId: selectedId, hours });
    rawRows = (result.data || []).map((r) => ({ ...r, _serviceId: selectedId }));
    if (onProgress) onProgress(100);
  } else {
    const allTargets = services.slice();
    let done = 0;
    const total = Math.max(1, allTargets.length);
    const allResults = await Promise.all(
      allTargets.map(async (s) => {
        try {
          const result = await apiGet({ action: 'metrics', serviceId: s.id, hours });
          return (result.data || []).map((r) => ({ ...r, _serviceId: s.id }));
        } catch (_) {
          return [];
        } finally {
          done += 1;
          if (onProgress) onProgress((done / total) * 100);
        }
      })
    );
    rawRows = allResults.flat();
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

  const labels = rows.map(r => fmtDate(r.timestamp));
  const latencyValues = rows.map(r => normalizeLatencyMs(r.latency_ms));
  const latency = latencyValues.map(v => v ?? 0);
  const validLatency = latencyValues.filter((v) => v !== null);
  const avgLatency = validLatency.length
    ? Math.round(validLatency.reduce((sum, v) => sum + v, 0) / validLatency.length)
    : null;
  const maxLatency = validLatency.length ? Math.max(...validLatency) : null;
  const minLatency = validLatency.length ? Math.min(...validLatency) : null;
  const pointColors = rows.map(r => (safeText(r.status) === 'DOWN' ? '#be2d2d' : '#2aa18f'));
  const upCount = rows.filter(r => r.status === 'UP').length;
  const downCount = rows.filter(r => r.status === 'DOWN').length;

  const hasRange = latencyRange.start || latencyRange.end;
  const rangeText = hasRange
    ? ` | 區間: ${latencyRange.start ? fmtDate(latencyRange.start) : '起始'} ~ ${latencyRange.end ? fmtDate(latencyRange.end) : '結束'}`
    : '';
  latencyTitle.textContent = `${serviceName} | Latency (${hours}h)${rangeText}`;
  uptimeTitle.textContent = `${serviceName} | Uptime Ratio`;
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

async function loadServices() {
  if (isLoading) return;
  isLoading = true;
  setLoadingOverlay(firstLoadPending);
  if (firstLoadPending) setLoadingProgress(5, '讀取服務清單...');

  try {
    const result = await apiGet({ action: 'listServices' });
    services = result.data || [];
    if (firstLoadPending) setLoadingProgress(25, '整理服務資料...');

    if (!selectedId) {
      selectedId = ALL_SERVICES_ID;
    }
    if (selectedId !== ALL_SERVICES_ID && selectedId && !services.some(s => s.id === selectedId)) {
      selectedId = ALL_SERVICES_ID;
    }

    renderSummary();
    renderTable();
    if (firstLoadPending) setLoadingProgress(35, '載入所有測試項目統計...');
    await renderAllLatencyStats(firstLoadPending ? (p) => setLoadingProgress(35 + p * 0.35, '載入所有測試項目統計...') : null);
    if (firstLoadPending) setLoadingProgress(72, '載入 Latency / Uptime...');
    await renderMetrics(firstLoadPending ? (p) => setLoadingProgress(72 + p * 0.26, '載入 Latency / Uptime...') : null);
    if (firstLoadPending) setLoadingProgress(100, '載入完成');
  } finally {
    isLoading = false;
    if (firstLoadPending) {
      firstLoadPending = false;
      window.setTimeout(() => setLoadingOverlay(false), 180);
    }
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
        if (latencyTitle) latencyTitle.textContent = 'Latency 區間錯誤：起始時間不能晚於結束時間';
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
    selectedId = btn.dataset.id;
    renderTable();
    await renderMetrics();
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

(async function init() {
  ensureCharts();
  if (refreshIntervalSelect) {
    autoRefreshMs = Math.max(10, Number(refreshIntervalSelect.value || 60)) * 1000;
  }
  bindEvents();
  startAutoRefresh();
  try {
    await loadServices();
    markRefreshDone();
    resetAutoRefreshClock();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8">讀取失敗: ${safeText(err.message)}</td></tr>`;
    if (minuteHistoryBody) {
      minuteHistoryBody.innerHTML = '<tr><td colspan="5">讀取失敗</td></tr>';
    }
  } finally {
    isLoading = false;
  }
})();
