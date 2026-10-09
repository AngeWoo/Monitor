import { escapeHtml, safeText, fmtDate } from './common.js?v=20260315-a041';

// 安全性掃描結果的共用顯示邏輯（儀表板與管理頁共用）。
// 掃描結果存在 scan.details_json：version 2 為新版掃描器（有分數、Cookie/CORS 等額外檢查、與上次比較），
// 沒有 version 的是舊版結果，仍可顯示，但會提示重新掃描。

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info', 'pass', 'error'];
const ISSUE_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const SEVERITY_LABEL = { critical: '嚴重', high: '高', medium: '中', low: '低', info: '資訊', pass: '通過', error: '錯誤' };
const GRADE_COLOR = { A: '#16a34a', B: '#65a30d', C: '#ca8a04', D: '#ea580c', F: '#dc2626' };
const GRADE_RANK = { A: 5, B: 4, C: 3, D: 2, F: 1 };
const CATEGORY_LABEL = { tls: 'SSL/TLS', header: 'HTTP 標頭', exposure: '敏感路徑', cookie: 'Cookie', cors: 'CORS', method: 'HTTP 方法', redirect: '導向', content: '頁面內容' };

// 修正建議：依檢查項目名稱對應（找不到時用 fallback）
const REMEDIATION = {
  'HSTS': '在 HTTPS 站台回傳 Strict-Transport-Security: max-age=31536000; includeSubDomains（nginx: add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;）',
  'HSTS 品質': 'max-age 至少 15552000（180 天），建議 31536000 並加上 includeSubDomains',
  'X-Frame-Options': '回傳 X-Frame-Options: SAMEORIGIN，或在 CSP 設定 frame-ancestors（nginx: add_header X-Frame-Options "SAMEORIGIN" always;）',
  'X-Content-Type-Options': '回傳 X-Content-Type-Options: nosniff（nginx: add_header X-Content-Type-Options "nosniff" always;）',
  'CSP': '先用 Content-Security-Policy-Report-Only 觀察，再逐步收斂 script-src 等來源；起手式: default-src \'self\'',
  'CSP 品質': '避免 \'unsafe-inline\' / \'unsafe-eval\' 與萬用字元，改用 nonce 或 hash；不要在 script-src 放 data: 或整個 https:',
  'Referrer-Policy': '回傳 Referrer-Policy: strict-origin-when-cross-origin',
  'Permissions-Policy': '回傳 Permissions-Policy: camera=(), microphone=(), geolocation=()（只開放需要的功能）',
  'Server Header': '隱藏版本號（nginx: server_tokens off;　Apache: ServerTokens Prod、ServerSignature Off;　IIS: 移除 Server 標頭）',
  'X-Powered-By': '移除此標頭（PHP: expose_php=Off;　Express: app.disable("x-powered-by");　IIS: 在自訂標頭移除）',
  'Cookie Secure 旗標': 'Set-Cookie 加上 Secure（框架設定 session cookie secure=true），避免經 HTTP 明文傳送',
  'Cookie HttpOnly 旗標': 'Set-Cookie 加上 HttpOnly，避免被前端腳本（XSS）讀取',
  'Cookie SameSite 旗標': 'Set-Cookie 加上 SameSite=Lax（或 Strict）降低 CSRF 風險',
  'Cookie SameSite=None': 'SameSite=None 必須搭配 Secure，否則瀏覽器會拒絕該 Cookie',
  'HTTP 導向 HTTPS': '讓 80 埠永久導向 HTTPS（nginx: server { listen 80; return 301 https://$host$request_uri; }）',
  'CORS 設定': '不要反射請求的 Origin；改用固定白名單，且不要把 Allow-Credentials 與萬用來源併用',
  'HTTP 方法': '停用 TRACE（Apache: TraceEnable off;　IIS: 移除 TRACE verb；nginx 預設不支援）；寫入類方法務必要求授權',
  '混合內容 (Mixed Content)': '把 http:// 資源改為 https:// 或相對路徑，也可加上 CSP upgrade-insecure-requests',
  '未啟用 HTTPS': '安裝憑證並啟用 HTTPS（可用 Let\'s Encrypt / win-acme 自動簽發續約），再把所有 HTTP 導向 HTTPS',
  '憑證有效期': '立即更新憑證；建議改用 ACME 自動續約，並保留到期監控',
  '主機名稱比對': '重新申請涵蓋此網域（CN/SAN）的憑證，並確認伺服器回傳的是正確站台的憑證',
  '憑證信任鏈': '改用受信任 CA 簽發的憑證，並在伺服器安裝完整憑證鏈（含中繼憑證）',
  '憑證簽章演算法': '更換使用 SHA-256 以上簽章的憑證，並更新中繼憑證',
  '憑證金鑰強度': 'RSA 金鑰至少 2048 位元（或改用 ECDSA P-256）',
  'TLS 協定版本': '只啟用 TLS 1.2 / 1.3（nginx: ssl_protocols TLSv1.2 TLSv1.3;　Apache: SSLProtocol -all +TLSv1.2 +TLSv1.3;　IIS: 於 SCHANNEL 停用 TLS 1.0/1.1）',
  '加密套件': '停用 RC4 / 3DES / NULL / EXPORT 等套件，採用 Mozilla「Intermediate」建議套件清單'
};

const EXPOSURE_REMEDIATION = [
  [/\.env$/i, '立即將 .env 移出網站根目錄或在網頁伺服器封鎖，並「更換所有已外洩的密碼、金鑰與 token」'],
  [/\.git\//i, '封鎖 /.git 存取並從部署目錄移除 .git 資料夾（nginx: location ~ /\\.git { deny all; }），並檢查是否有金鑰被提交'],
  [/\.(sql|zip)$/i, '立即移除網站目錄下的備份檔，檢查 access log 確認是否已被下載，必要時更換資料庫密碼'],
  [/phpinfo/i, '刪除 phpinfo 頁面，避免洩漏 PHP 版本、路徑與環境變數'],
  [/actuator/i, '限制 Actuator 管理端點僅內網可存取或需驗證，並關閉不需要的端點'],
  [/phpmyadmin|wp-login|\/admin\//i, '限制管理頁來源 IP（VPN/內網）、加上多因素驗證，或改用不易猜測的路徑'],
  [/swagger|api-docs|openapi/i, '正式環境關閉 API 文件頁，或加上驗證'],
  [/\.DS_Store|composer\.json|package\.json|\.htaccess|web\.config|server-(?:status|info)/i, '封鎖此檔案的對外存取（部署時排除，或在網頁伺服器設定 deny）']
];
const DIRLIST_FIX = '關閉目錄列表（nginx: autoindex off;　Apache: Options -Indexes），並確認目錄內沒有敏感檔案';
const EXPOSURE_FALLBACK = '移除該檔案或在網頁伺服器封鎖對外存取，並檢查 access log 確認是否已被外部取得';

function remediationFor(item) {
  if (!item) return '';
  if (item.category === 'exposure' || item.path) {
    if (/目錄列表/.test(item.label || '')) return DIRLIST_FIX;
    for (const [pattern, text] of EXPOSURE_REMEDIATION) {
      if (pattern.test(item.path || '')) return text;
    }
    return EXPOSURE_FALLBACK;
  }
  return REMEDIATION[item.check] || '';
}

export function severityLabel(severity) {
  return SEVERITY_LABEL[String(severity || '').toLowerCase()] || escapeHtml(severity || '-');
}

export function gradeColor(grade) {
  return GRADE_COLOR[String(grade || '').toUpperCase()] || '#94a3b8';
}

const detailsCache = new WeakMap();

export function parseDetails(scan) {
  if (!scan || typeof scan !== 'object') return null;
  if (detailsCache.has(scan)) return detailsCache.get(scan);
  let details = null;
  try {
    details = scan.details_json ? JSON.parse(scan.details_json) : null;
  } catch (_) {
    details = null;
  }
  detailsCache.set(scan, details);
  return details;
}

// 新版掃描器直接給分數；舊版結果用計數推算（與掃描器相同公式）
export function securityScore(scan) {
  const details = parseDetails(scan);
  if (details && typeof details.score === 'number') return details.score;
  const score = 100
    - Number(scan.critical_count || 0) * 25
    - Number(scan.high_count || 0) * 12
    - Number(scan.medium_count || 0) * 5
    - Number(scan.low_count || 0) * 2;
  return Math.max(0, Math.min(100, score));
}

export function isLegacyScan(scan) {
  const details = parseDetails(scan);
  return !details || !details.version;
}

// 與上次掃描比較：回傳 { dir: 'up'|'down'|'same', text }，沒有上次資料回傳 null
export function securityTrend(scan) {
  const details = parseDetails(scan);
  const diff = details && details.diff;
  if (!diff || !diff.previous_grade) return null;
  const now = GRADE_RANK[String(scan.grade || '').toUpperCase()] || 0;
  const before = GRADE_RANK[String(diff.previous_grade).toUpperCase()] || 0;
  let dir = 'same';
  if (now > before) dir = 'up';
  else if (now < before) dir = 'down';
  else if (typeof diff.previous_score === 'number') {
    const delta = securityScore(scan) - diff.previous_score;
    if (delta > 0) dir = 'up';
    else if (delta < 0) dir = 'down';
  }
  const text = `上次 ${diff.previous_grade}${typeof diff.previous_score === 'number' ? ` (${diff.previous_score})` : ''} → 本次 ${scan.grade} (${securityScore(scan)})`;
  return { dir, text };
}

export function securityTrendBadge(scan) {
  const trend = securityTrend(scan);
  if (!trend) return '';
  const symbol = trend.dir === 'up' ? '▲' : trend.dir === 'down' ? '▼' : '＝';
  return `<span class="sec-trend sec-trend-${trend.dir}" title="${escapeHtml(trend.text)}">${symbol}</span>`;
}

export function securityGradeCell(scan) {
  const grade = String(scan.grade || '-').toUpperCase();
  return `<span class="sec-grade" style="background:${gradeColor(grade)}">${escapeHtml(grade)}</span>`
    + ` <span class="sec-score" title="安全分數 (0-100)">${securityScore(scan)}</span>${securityTrendBadge(scan)}`;
}

// ── 把各區塊的檢查結果攤平成統一格式，方便排序與匯出 ────────────────────────

function legacyTlsItems(tls) {
  if (!tls) return [];
  const items = [];
  if (tls.cert_expired) items.push({ category: 'tls', check: '憑證有效期', severity: 'critical', description: '憑證已過期' });
  else if (tls.cert_self_signed) items.push({ category: 'tls', check: '憑證信任鏈', severity: 'high', description: '使用自簽憑證' });
  else if (typeof tls.cert_days_remaining === 'number' && tls.cert_days_remaining >= 0 && tls.cert_days_remaining <= 90) {
    items.push({ category: 'tls', check: '憑證有效期', severity: tls.severity || 'medium', description: `憑證剩餘 ${tls.cert_days_remaining} 天` });
  }
  if (tls.sni_match === false) items.push({ category: 'tls', check: '主機名稱比對', severity: 'high', description: '憑證與主機名稱不符' });
  return items;
}

export function collectItems(scan) {
  const details = parseDetails(scan) || {};
  const items = [];
  if (details.tls) {
    const tlsItems = Array.isArray(details.tls.findings) ? details.tls.findings : legacyTlsItems(details.tls);
    tlsItems.forEach((f) => items.push({ category: 'tls', check: f.check, severity: f.severity, description: f.description }));
  }
  (details.headers || []).forEach((h) => items.push({ category: 'header', check: h.check || h.header || '-', severity: h.severity, description: h.description, value: h.value }));
  (details.paths || []).forEach((p) => items.push({ category: 'exposure', check: p.label || p.path, path: p.path, label: p.label, severity: p.severity, description: p.description, status_code: p.status_code, accessible: p.accessible, confidence: p.confidence }));
  (details.extra || []).forEach((e) => items.push({ category: e.category || 'content', check: e.check, severity: e.severity, description: e.description }));
  return items;
}

function sortBySeverity(items) {
  return items.slice().sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

export function issueItems(scan) {
  return sortBySeverity(collectItems(scan).filter((item) => ISSUE_SEVERITIES.includes(item.severity)));
}

// ── 詳情 HTML ─────────────────────────────────────────────────────────────────

function sevTag(severity) {
  const sev = String(severity || 'pass').toLowerCase();
  return `<span class="sec-sev sec-sev-${escapeHtml(sev)}">${severityLabel(sev)}</span>`;
}

function countChips(items) {
  const counts = {};
  items.forEach((item) => {
    if (ISSUE_SEVERITIES.includes(item.severity)) counts[item.severity] = (counts[item.severity] || 0) + 1;
  });
  const chips = ISSUE_SEVERITIES.filter((sev) => counts[sev]).map((sev) => `<span class="sec-sev sec-sev-${sev}">${SEVERITY_LABEL[sev]} ${counts[sev]}</span>`);
  return chips.length ? chips.join(' ') : '<span class="sec-sev sec-sev-pass">無問題</span>';
}

function itemsTable(items, columns) {
  if (!items.length) return '';
  const head = columns.map((c) => `<th>${escapeHtml(c.title)}</th>`).join('');
  const rows = items.map((item) => `<tr>${columns.map((c) => `<td>${c.render(item)}</td>`).join('')}</tr>`).join('');
  return `<div class="service-modal-table-wrap"><table class="service-modal-table sec-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

const COL_CHECK = { title: '項目', render: (i) => escapeHtml(i.display || i.check || '-') };
const COL_SEV = { title: '結果', render: (i) => sevTag(i.severity) };
const COL_DESC = { title: '說明', render: (i) => escapeHtml(i.description || '') };
const COL_FIX = {
  title: '建議',
  render: (i) => (ISSUE_SEVERITIES.includes(i.severity) ? `<span class="sec-fix">${escapeHtml(remediationFor(i))}</span>` : '')
};

function section(title, items, body, open) {
  return `<details class="sec-section"${open ? ' open' : ''}>
    <summary><span class="sec-section-title">${escapeHtml(title)}</span><span class="sec-section-chips">${countChips(items)}</span></summary>
    ${body}
  </details>`;
}

function tlsFacts(tls) {
  const protocols = tls.protocols && typeof tls.protocols === 'object' ? tls.protocols : null;
  const protocolChips = protocols
    ? ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'].map((v) => {
      const supported = protocols[v];
      const legacy = v === 'TLSv1' || v === 'TLSv1.1';
      const cls = supported === true ? (legacy ? 'sec-sev-medium' : 'sec-sev-pass') : (supported === false ? 'sec-sev-neutral' : 'sec-sev-info');
      const mark = supported === true ? '支援' : supported === false ? '不支援' : '未知';
      return `<span class="sec-sev ${cls}">${escapeHtml(v.replace('TLSv', 'TLS '))}: ${mark}</span>`;
    }).join(' ')
    : '';
  const days = typeof tls.cert_days_remaining === 'number' && tls.cert_days_remaining >= 0 ? ` (剩 ${tls.cert_days_remaining} 天)` : (tls.cert_expired ? ' (已過期)' : '');
  const fact = (label, value, wide) => `<div class="service-modal-meta-item${wide ? ' service-modal-meta-item-wide' : ''}"><span class="service-modal-meta-label">${escapeHtml(label)}</span><span class="service-modal-meta-value">${value}</span></div>`;
  return `<div class="service-modal-meta-grid">
    ${fact('協商協定 / 加密套件', escapeHtml(`${tls.protocol || '-'} / ${tls.cipher || '-'}`))}
    ${fact('憑證主體 (CN)', escapeHtml(tls.cert_subject || '-'))}
    ${fact('簽發者', escapeHtml(tls.cert_issuer || '-'))}
    ${fact('有效期', escapeHtml(`${tls.cert_valid_from || '-'} ~ ${tls.cert_valid_to || '-'}`) + escapeHtml(days))}
    ${tls.key_bits ? fact('金鑰', escapeHtml(`${tls.key_type || ''} ${tls.key_bits} bit`)) : ''}
    ${Array.isArray(tls.san) && tls.san.length ? fact('SAN', escapeHtml(tls.san.join(', '))) : ''}
    ${protocolChips ? fact('TLS 版本支援', protocolChips, true) : ''}
  </div>`;
}

function diffBlock(scan, details) {
  const diff = details && details.diff;
  const trend = securityTrend(scan);
  if (!diff || !trend) return '';
  const humanize = (key) => escapeHtml(String(key).replace(/^[a-z]+:/, ''));
  let html = `<div class="sec-diff"><strong>與上次掃描比較</strong> <span class="sec-trend sec-trend-${trend.dir}">${trend.dir === 'up' ? '▲ 改善' : trend.dir === 'down' ? '▼ 變差' : '＝ 持平'}</span> <span class="sec-muted">${escapeHtml(trend.text)}（${escapeHtml(fmtDate(diff.previous_scanned_at))}）</span>`;
  if (diff.legacy) {
    html += '<div class="sec-muted">上次是舊版掃描規則的結果（可能含誤判），僅比較等級。</div>';
  } else {
    if (diff.new_issues && diff.new_issues.length) html += `<div>新增問題：${diff.new_issues.map((k) => `<span class="sec-sev sec-sev-high">${humanize(k)}</span>`).join(' ')}</div>`;
    if (diff.resolved_issues && diff.resolved_issues.length) html += `<div>已修復：${diff.resolved_issues.map((k) => `<span class="sec-sev sec-sev-pass">${humanize(k)}</span>`).join(' ')}</div>`;
    if (!(diff.new_issues && diff.new_issues.length) && !(diff.resolved_issues && diff.resolved_issues.length)) html += '<div class="sec-muted">問題清單沒有變化。</div>';
  }
  return `${html}</div>`;
}

export function renderSecurityReport(scan) {
  const details = parseDetails(scan);
  const grade = String(scan.grade || '-').toUpperCase();
  const score = securityScore(scan);
  const items = collectItems(scan);
  const issues = sortBySeverity(items.filter((item) => ISSUE_SEVERITIES.includes(item.severity)));

  let html = `<div class="service-modal-summary-grid">
    <div class="service-modal-stat"><span class="service-modal-stat-label">評級</span><span class="service-modal-stat-value"><span class="sec-grade sec-grade-lg" style="background:${gradeColor(grade)}">${escapeHtml(grade)}</span></span></div>
    <div class="service-modal-stat"><span class="service-modal-stat-label">安全分數</span><span class="service-modal-stat-value"><strong class="sec-score-lg" style="color:${gradeColor(grade)}">${score}</strong> / 100</span><span class="service-modal-stat-detail">100 − (嚴重×25 + 高×12 + 中×5 + 低×2)</span></div>
    <div class="service-modal-stat"><span class="service-modal-stat-label">問題統計</span><span class="service-modal-stat-value">${Number(scan.total_issues || 0)} 項</span><span class="service-modal-stat-detail">嚴重 ${Number(scan.critical_count || 0)} / 高 ${Number(scan.high_count || 0)} / 中 ${Number(scan.medium_count || 0)} / 低 ${Number(scan.low_count || 0)}</span></div>
    <div class="service-modal-stat"><span class="service-modal-stat-label">HTTPS</span><span class="service-modal-stat-value" style="color:${scan.is_https ? '#16a34a' : '#dc2626'};font-weight:700">${scan.is_https ? '✓ 是' : '✗ 否'}</span><span class="service-modal-stat-detail">通過 ${Number(scan.pass_count || 0)} 項</span></div>
  </div>`;

  if (!details || !details.version) {
    html += `<div class="sec-notice">此結果由<strong>舊版掃描規則</strong>產生，可能有誤判（例如網站對任何路徑都回 200 時，敏感路徑會被誤判為外洩）。請重新執行安全性掃描，以取得完整的新版報告。</div>`;
  }
  html += diffBlock(scan, details);

  if (issues.length) {
    const top = issues.slice(0, 10);
    html += `<div class="service-modal-section"><div class="service-modal-section-head"><h3>優先修正（${issues.length} 項）</h3></div>`
      + itemsTable(top.map((i) => ({ ...i, display: `${CATEGORY_LABEL[i.category] || i.category}｜${i.check}` })), [COL_SEV, COL_CHECK, COL_DESC, COL_FIX])
      + (issues.length > top.length ? `<p class="sec-muted">另有 ${issues.length - top.length} 項較低優先的問題，請見下方各分類。</p>` : '')
      + '</div>';
  } else if (details && details.version) {
    html += '<div class="sec-notice sec-notice-ok">沒有發現需要處理的問題。</div>';
  }

  // SSL/TLS
  if (details && details.tls) {
    const tlsItems = items.filter((i) => i.category === 'tls');
    html += section('🔒 SSL / TLS', tlsItems, tlsFacts(details.tls) + itemsTable(tlsItems, [COL_CHECK, COL_SEV, COL_DESC]), tlsItems.some((i) => ISSUE_SEVERITIES.includes(i.severity)));
  } else if (scan.is_https) {
    html += '<div class="sec-notice sec-notice-bad">無法取得 TLS 憑證資訊（探針連不上或握手失敗）。</div>';
  }

  // HTTP 標頭
  const headerItems = items.filter((i) => i.category === 'header');
  if (headerItems.length) {
    html += section('📋 HTTP 安全標頭', headerItems, itemsTable(headerItems, [COL_CHECK, COL_SEV, COL_DESC]), headerItems.some((i) => ISSUE_SEVERITIES.includes(i.severity)));
  }

  // 敏感路徑
  const pathItems = items.filter((i) => i.category === 'exposure');
  if (pathItems.length) {
    const exposed = pathItems.filter((i) => i.accessible && i.severity !== 'info');
    const infoItems = pathItems.filter((i) => i.severity === 'info' || (i.accessible && i.severity === 'pass') || i.check === 'security.txt');
    const protectedItems = pathItems.filter((i) => !exposed.includes(i) && !infoItems.includes(i));
    const soft = protectedItems.filter((i) => i.confidence === 'soft404').length;
    let body = '';
    body += exposed.length
      ? itemsTable(sortBySeverity(exposed), [{ title: '路徑', render: (i) => `<code>${escapeHtml(i.path)}</code>` }, { title: 'HTTP', render: (i) => escapeHtml(String(i.status_code || '-')) }, COL_SEV, COL_DESC, COL_FIX])
      : '<p class="sec-muted">沒有發現可公開存取的敏感檔案。</p>';
    if (infoItems.length) body += `<p class="sec-muted">${infoItems.map((i) => escapeHtml(i.description || i.check)).join('；')}</p>`;
    if (soft) body += `<p class="sec-muted">其中 ${soft} 個路徑因「站台對任何路徑都回 200 / 導向」而與不存在頁面無法區分，已依內容特徵判定為不存在。</p>`;
    body += `<details class="sec-sub"><summary>已保護 / 不存在的路徑（${protectedItems.length}）</summary><ul>${protectedItems.map((i) => `<li><code>${escapeHtml(i.path)}</code> <span class="sec-muted">${escapeHtml(i.label || '')}</span></li>`).join('')}</ul></details>`;
    html += section('🔎 敏感路徑與資訊洩漏', pathItems.filter((i) => ISSUE_SEVERITIES.includes(i.severity)), body, exposed.length > 0);
  }

  // Cookie / CORS / 方法 / 導向 / 內容
  const extraItems = items.filter((i) => ['cookie', 'cors', 'method', 'redirect', 'content'].includes(i.category) || (i.category === 'tls' && !(details && details.tls)));
  if (extraItems.length) {
    html += section('🧩 Cookie / CORS / HTTP 行為', extraItems, itemsTable(extraItems.map((i) => ({ ...i, display: `${CATEGORY_LABEL[i.category] || i.category}｜${i.check}` })), [COL_CHECK, COL_SEV, COL_DESC, COL_FIX]), extraItems.some((i) => ISSUE_SEVERITIES.includes(i.severity)));
  }

  if (details && details._truncated) {
    html += '<p class="sec-muted">⚠ 詳細資料超過儲存上限，部分內容已被截斷。</p>';
  }
  return html;
}

// ── CSV 匯出 ──────────────────────────────────────────────────────────────────

function csvCell(value) {
  let text = safeText(value).replace(/\r?\n/g, ' ');
  // 避免被試算表當成公式執行（內容有一部分來自受測網站回應）
  if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function securityScansToCsv(scans) {
  const header = ['服務名稱', 'Host', '等級', '分數', '掃描時間', '類別', '項目', '嚴重度', '說明', '建議'];
  const lines = [header.map(csvCell).join(',')];
  (scans || []).forEach((scan) => {
    const base = [scan.service_name || scan.service_id || '', scan.host || '', scan.grade || '', securityScore(scan), scan.scanned_at || ''];
    const issues = issueItems(scan);
    if (!issues.length) {
      lines.push([...base, '', '', '', '沒有發現需要處理的問題', ''].map(csvCell).join(','));
      return;
    }
    issues.forEach((item) => {
      lines.push([...base, CATEGORY_LABEL[item.category] || item.category, item.check, SEVERITY_LABEL[item.severity] || item.severity, item.description || '', remediationFor(item)].map(csvCell).join(','));
    });
  });
  // 加 BOM，Excel 才能正確顯示中文
  return `﻿${lines.join('\r\n')}`;
}

export function downloadTextFile(filename, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
