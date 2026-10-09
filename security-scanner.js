"use strict";

// 安全性掃描器（由 local-probe.js 載入，pkg 打包時會自動一併帶入）。
// 只做「唯讀、低侵入」的檢查：GET / HEAD 風格請求、OPTIONS、TRACE、TLS 握手。
// 不會送出 PUT/DELETE/POST 等會改變伺服器狀態的請求，也不會把 Cookie 的值寫進結果（只記名稱與旗標）。

const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");

const SCANNER_VERSION = 2;
const DEFAULT_USER_AGENT = "MonitorSecurityScanner/2.0";
const ROOT_BODY_BYTES = 128 * 1024;
const PATH_BODY_BYTES = 64 * 1024;
const PATH_CONCURRENCY = 6;
const CORS_TEST_ORIGIN = "https://scanner-probe.invalid";
const SEVERITY_WEIGHT = { critical: 25, high: 12, medium: 5, low: 2 };
const ISSUE_SEVERITIES = ["critical", "high", "medium", "low"];
const SEVERITY_RANK = { critical: 5, high: 4, medium: 3, low: 2, info: 1, pass: 0, error: 0 };

// ── 設定：HTTP 安全標頭 ───────────────────────────────────────────────────────

const SECURITY_HEADERS_CHECKLIST = [
  { header: "strict-transport-security", label: "HSTS", severity: "high", description: "HTTP Strict Transport Security 未設定，瀏覽器可能透過 HTTP 明文連線" },
  { header: "x-frame-options", label: "X-Frame-Options", severity: "medium", description: "未設定 X-Frame-Options（也沒有 CSP frame-ancestors），可能受到 Clickjacking 攻擊" },
  { header: "x-content-type-options", label: "X-Content-Type-Options", severity: "medium", description: "未設定 nosniff，瀏覽器可能錯誤解析 MIME 類型" },
  { header: "content-security-policy", label: "CSP", severity: "medium", description: "未設定 Content-Security-Policy，可能受到 XSS 攻擊" },
  { header: "referrer-policy", label: "Referrer-Policy", severity: "low", description: "未設定 Referrer-Policy，可能洩漏敏感 URL 資訊" },
  { header: "permissions-policy", label: "Permissions-Policy", severity: "low", description: "未設定 Permissions-Policy，未限制瀏覽器功能存取權限" }
];

// ── 設定：敏感路徑 ────────────────────────────────────────────────────────────
// match 為「內容特徵」：回應必須真的長得像該檔案才算外洩，避免把 SPA/soft-404 首頁誤判成 /.env。
// 沒有 match 的項目只能靠狀態碼判斷，這裡刻意不放。

const HTML_HINT = /<\s*(?:!doctype|html|head|body|script)\b/i;
const looksLikeHtml = (text) => HTML_HINT.test(text.slice(0, 2048));
const DIR_LISTING = /<title>\s*Index of \/|<h1>\s*Index of \/|Directory listing for|Parent Directory<\/a>|\[To Parent Directory\]/i;

const SENSITIVE_PATHS = [
  { path: "/.env", label: ".env 環境變數檔", severity: "critical", match: (t) => !looksLikeHtml(t) && /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=\s*\S*/m.test(t) },
  { path: "/.git/config", label: "Git 配置檔", severity: "critical", match: (t) => !looksLikeHtml(t) && /\[(?:core|remote\s+"[^"]*"|branch\s+"[^"]*")\]/.test(t) },
  { path: "/.git/HEAD", label: "Git HEAD", severity: "critical", match: (t) => /^ref:\s*refs\/heads\//m.test(t) },
  { path: "/backup.sql", label: "資料庫備份 backup.sql", severity: "critical", match: (t) => !looksLikeHtml(t) && /(?:CREATE\s+TABLE|INSERT\s+INTO|DROP\s+TABLE|-- MySQL dump)/i.test(t) },
  { path: "/dump.sql", label: "資料庫備份 dump.sql", severity: "critical", match: (t) => !looksLikeHtml(t) && /(?:CREATE\s+TABLE|INSERT\s+INTO|DROP\s+TABLE|-- MySQL dump)/i.test(t) },
  { path: "/db.sql", label: "資料庫備份 db.sql", severity: "critical", match: (t) => !looksLikeHtml(t) && /(?:CREATE\s+TABLE|INSERT\s+INTO|DROP\s+TABLE|-- MySQL dump)/i.test(t) },
  { path: "/backup.zip", label: "網站備份 backup.zip", severity: "high", match: (t, buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04 },
  { path: "/www.zip", label: "網站備份 www.zip", severity: "high", match: (t, buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04 },
  { path: "/phpinfo.php", label: "phpinfo() 頁面", severity: "high", match: (t) => /phpinfo\(\)|PHP Version\s*\d|<title>phpinfo/i.test(t) },
  { path: "/phpmyadmin/", label: "phpMyAdmin", severity: "high", match: (t) => /phpMyAdmin|pma_/i.test(t) },
  { path: "/actuator/env", label: "Spring Boot Actuator /env", severity: "high", match: (t) => /"(?:activeProfiles|propertySources)"/.test(t) },
  { path: "/actuator", label: "Spring Boot Actuator", severity: "medium", match: (t) => /"_links"/.test(t) },
  { path: "/.DS_Store", label: "macOS .DS_Store", severity: "medium", match: (t) => t.includes("Bud1") },
  { path: "/.htaccess", label: ".htaccess 配置檔", severity: "medium", match: (t) => !looksLikeHtml(t) && /(?:RewriteEngine|RewriteRule|RewriteCond|AuthType|AuthUserFile|<IfModule|php_value|Deny\s+from|Allow\s+from|ErrorDocument)/i.test(t) },
  { path: "/web.config", label: "IIS web.config", severity: "medium", match: (t) => /<configuration[\s>]|<system\.web|<system\.webServer|<appSettings/i.test(t) },
  { path: "/server-status", label: "Apache Server Status", severity: "medium", match: (t) => /Apache Server Status|Server Version:\s*Apache/i.test(t) },
  { path: "/server-info", label: "Apache Server Info", severity: "medium", match: (t) => /Apache Server Information|Server Settings/i.test(t) },
  { path: "/uploads/", label: "uploads 目錄列表", severity: "medium", match: (t) => DIR_LISTING.test(t) },
  { path: "/backup/", label: "backup 目錄列表", severity: "medium", match: (t) => DIR_LISTING.test(t) },
  { path: "/backups/", label: "backups 目錄列表", severity: "medium", match: (t) => DIR_LISTING.test(t) },
  { path: "/logs/", label: "logs 目錄列表", severity: "medium", match: (t) => DIR_LISTING.test(t) },
  { path: "/files/", label: "files 目錄列表", severity: "medium", match: (t) => DIR_LISTING.test(t) },
  { path: "/wp-login.php", label: "WordPress 登入頁", severity: "low", match: (t) => /wp-login|user_login/i.test(t) },
  { path: "/admin/", label: "管理後台登入頁", severity: "low", match: (t) => /<input[^>]+type\s*=\s*["']?password|<form[^>]+login|sign.?in/i.test(t) },
  { path: "/swagger-ui.html", label: "Swagger UI", severity: "low", match: (t) => /swagger/i.test(t) },
  { path: "/v2/api-docs", label: "Swagger API 文件", severity: "low", match: (t) => /"swagger"|"openapi"/.test(t) },
  { path: "/openapi.json", label: "OpenAPI 文件", severity: "low", match: (t) => /"openapi"|"swagger"/.test(t) },
  { path: "/composer.json", label: "composer.json", severity: "low", match: (t) => /"(?:require|name)"\s*:/.test(t) },
  { path: "/package.json", label: "package.json", severity: "low", match: (t) => /"(?:dependencies|devDependencies|name)"\s*:/.test(t) },
  // 資訊型：不計入扣分
  { path: "/robots.txt", label: "robots.txt", severity: "info", kind: "robots", match: (t) => /(?:User-agent|Disallow|Sitemap)\s*:/i.test(t) },
  { path: "/.well-known/security.txt", label: "security.txt", severity: "info", kind: "security.txt", match: (t) => /^\s*Contact\s*:/mi.test(t) }
];

// ── 共用小工具 ────────────────────────────────────────────────────────────────

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function errMessage(error) {
  return String(error && error.message ? error.message : error);
}

function worstSeverity(items) {
  let worst = "pass";
  for (const item of items) {
    const sev = item && item.severity;
    if ((SEVERITY_RANK[sev] || 0) > (SEVERITY_RANK[worst] || 0)) worst = sev;
  }
  return worst;
}

async function runLimited(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const idx = next;
      next += 1;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ── 原始 HTTP 請求：不跟轉址、限制回應大小、不驗證憑證（憑證另外由 TLS 檢查回報）──

function rawRequest(urlString, options) {
  const opts = options || {};
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10000;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : PATH_BODY_BYTES;
  let target;
  try {
    target = new URL(urlString);
  } catch (error) {
    return Promise.reject(error);
  }
  const client = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const requestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: opts.method || "GET",
      headers: Object.assign({
        "User-Agent": opts.userAgent || DEFAULT_USER_AGENT,
        Accept: "*/*",
        Connection: "close"
      }, opts.headers || {}),
      agent: false,
      rejectUnauthorized: false
    };
    if (target.protocol === "https:" && !net.isIP(target.hostname)) requestOptions.servername = target.hostname;

    const req = client.request(requestOptions, (res) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      const build = () => ({
        statusCode: Number(res.statusCode || 0),
        headers: res.headers || {},
        body: Buffer.concat(chunks).subarray(0, maxBytes),
        truncated
      });
      res.on("data", (chunk) => {
        if (truncated) return;
        chunks.push(chunk);
        size += chunk.length;
        if (size >= maxBytes) {
          truncated = true;
          finish(resolve, build());
          res.destroy();
        }
      });
      res.on("end", () => finish(resolve, build()));
      res.on("close", () => finish(resolve, build()));
      res.on("error", (error) => (truncated ? finish(resolve, build()) : finish(reject, error)));
    });

    timer = setTimeout(() => req.destroy(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    req.on("error", (error) => finish(reject, error));
    req.end();
  });
}

// 只跟「同主機」的轉址（含 HTTP→HTTPS 升級），取得瀏覽器實際會看到的最終頁面。
async function fetchFollowingSameHost(startUrl, options, maxRedirects) {
  const chain = [];
  const cookies = [];
  let current = startUrl;
  let response = null;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    response = await rawRequest(current, options);
    chain.push({ url: current, status: response.statusCode });
    const setCookie = response.headers["set-cookie"];
    if (Array.isArray(setCookie)) cookies.push(...setCookie);
    const location = response.headers.location;
    if (!(response.statusCode >= 300 && response.statusCode < 400 && location)) break;
    let next;
    try {
      next = new URL(location, current);
    } catch (_) {
      break;
    }
    if (next.hostname.toLowerCase() !== new URL(current).hostname.toLowerCase()) break;
    if (next.href === current) break;
    current = next.href;
  }
  return { response, finalUrl: current, chain, cookies };
}

// ── Soft-404 / 基準比對 ───────────────────────────────────────────────────────

function contentTypeOf(headers) {
  return String(headers["content-type"] || "").split(";")[0].trim().toLowerCase();
}

function fingerprint(res) {
  const text = res.body.toString("utf8", 0, Math.min(res.body.length, 4096));
  const title = ((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").replace(/\s+/g, " ").trim().toLowerCase();
  return {
    status: res.statusCode,
    ct: contentTypeOf(res.headers),
    len: res.body.length,
    title,
    sig: sha1(text.replace(/\d+/g, "0").replace(/\s+/g, " "))
  };
}

function lenClose(a, b, pct, minAbs) {
  return Math.abs(a - b) <= Math.max(minAbs, pct * Math.max(a, b));
}

function isSoftMatch(fp, base) {
  if (!base) return false;
  const isRedirect = (status) => status >= 300 && status < 400;
  if (isRedirect(fp.status) && isRedirect(base.status)) return true;
  if (fp.status !== base.status) return false;
  if (fp.ct !== base.ct) return false;
  if (fp.sig === base.sig) return true;
  if (fp.title && fp.title === base.title && lenClose(fp.len, base.len, 0.25, 64)) return true;
  return lenClose(fp.len, base.len, 0.02, 48);
}

async function fetchBaseline(baseUrl, suffix, opts) {
  const random = crypto.randomBytes(6).toString("hex");
  try {
    const res = await rawRequest(`${baseUrl}/__scan_${random}${suffix}`, {
      userAgent: opts.userAgent,
      timeoutMs: opts.pathTimeoutMs,
      maxBytes: PATH_BODY_BYTES
    });
    return fingerprint(res);
  } catch (_) {
    return null;
  }
}

// ── 敏感路徑 ──────────────────────────────────────────────────────────────────

function pathRow(item, fullPath, fields) {
  return Object.assign({
    category: "exposure",
    path: fullPath,
    label: item.label,
    status_code: 0,
    accessible: false,
    severity: "pass",
    body_length: 0,
    confidence: "",
    description: ""
  }, fields);
}

async function probePath(baseUrl, prefix, item, baselines, opts) {
  const fullPath = `${prefix}${item.path}`;
  let res;
  try {
    res = await rawRequest(`${baseUrl}${item.path}`, {
      userAgent: opts.userAgent,
      timeoutMs: opts.pathTimeoutMs,
      maxBytes: PATH_BODY_BYTES
    });
  } catch (error) {
    return pathRow(item, fullPath, { description: `${item.label} 無法存取: ${errMessage(error)}` });
  }

  const code = res.statusCode;
  const base = item.path.endsWith("/") ? baselines.dir : baselines.file;
  const row = (fields) => pathRow(item, fullPath, Object.assign({ status_code: code, body_length: res.body.length }, fields));

  if (code >= 300 && code < 400) {
    return row({ description: `${item.label} 不存在（HTTP ${code} 導向 ${String(res.headers.location || "").slice(0, 80)}）` });
  }
  if (code === 401 || code === 403) return row({ description: `${item.label} 已保護 (HTTP ${code})` });
  if (code !== 200 && code !== 206) return row({ description: `${item.label} 不存在 (HTTP ${code})` });

  const fp = fingerprint(res);
  if (isSoftMatch(fp, base)) {
    return row({ confidence: "soft404", description: `${item.label}: 回應與不存在的頁面相同（站台對任何路徑都回 200），視為不存在` });
  }

  const text = res.body.toString("utf8");
  let matched = false;
  try {
    matched = item.match(text, res.body, res);
  } catch (_) {
    matched = false;
  }
  if (!matched) {
    return row({ confidence: "nomatch", description: `${item.label}: 回應 200 但內容不符合該檔案特徵，視為不存在` });
  }

  if (item.kind === "security.txt") {
    return row({ severity: "pass", confidence: "confirmed", description: "已提供 security.txt（漏洞通報聯絡方式）" });
  }
  if (item.kind === "robots") {
    const disallow = (text.match(/^\s*Disallow\s*:\s*\S+/gim) || []).length;
    return row({ accessible: true, severity: "info", confidence: "confirmed", description: `robots.txt 存在（${disallow} 條 Disallow，可能洩漏內部路徑）` });
  }
  return row({
    accessible: true,
    severity: item.severity,
    confidence: "confirmed",
    description: `${item.label} 可公開存取 (HTTP ${code})，且內容符合該檔案特徵，請立即限制存取`
  });
}

function buildScanBases(parsedUrl) {
  const origin = parsedUrl.origin;
  const bases = [{ baseUrl: origin, prefix: "" }];
  // 服務掛在子目錄（例如 https://host/Srules/）時，也掃一次該目錄下的敏感檔案
  const pathname = parsedUrl.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    const dir = pathname.replace(/\/+$/, "");
    bases.push({ baseUrl: `${origin}${dir}`, prefix: dir });
  }
  return bases;
}

async function checkSensitivePaths(parsedUrl, opts) {
  const all = [];
  for (const { baseUrl, prefix } of buildScanBases(parsedUrl)) {
    const [dir, file] = await Promise.all([
      fetchBaseline(baseUrl, "/", opts),
      fetchBaseline(baseUrl, ".php", opts)
    ]);
    const baselines = { dir, file };
    const tasks = SENSITIVE_PATHS.map((item) => () => probePath(baseUrl, prefix, item, baselines, opts));
    all.push(...await runLimited(tasks, PATH_CONCURRENCY));
  }
  return all;
}

// ── HTTP 標頭 ─────────────────────────────────────────────────────────────────

function parseCsp(value) {
  const directives = {};
  String(value || "").split(";").map((s) => s.trim()).filter(Boolean).forEach((part) => {
    const [name, ...values] = part.split(/\s+/);
    directives[name.toLowerCase()] = values;
  });
  return directives;
}

function analyzeCsp(value) {
  const directives = parseCsp(value);
  const issues = [];
  let severity = "pass";
  const bump = (sev) => {
    if ((SEVERITY_RANK[sev] || 0) > (SEVERITY_RANK[severity] || 0)) severity = sev;
  };
  const scriptSources = directives["script-src"] || directives["default-src"] || null;
  if (!scriptSources) {
    issues.push("未限制 script 來源（缺少 script-src 與 default-src）");
    bump("medium");
  } else {
    const hasNonceOrHash = scriptSources.some((v) => /^'(?:nonce-|sha(?:256|384|512)-)/i.test(v) || v === "'strict-dynamic'");
    if (scriptSources.includes("'unsafe-inline'") && !hasNonceOrHash) {
      issues.push("script 允許 'unsafe-inline'，XSS 防護形同虛設");
      bump("medium");
    }
    if (scriptSources.includes("'unsafe-eval'")) {
      issues.push("script 允許 'unsafe-eval'");
      bump("low");
    }
    if (scriptSources.includes("*")) {
      issues.push("script 來源使用萬用字元 *");
      bump("medium");
    } else if (scriptSources.includes("https:") || scriptSources.includes("http:")) {
      issues.push("script 來源僅限制協定（https:/http:），任何網站的腳本都可載入");
      bump("low");
    }
    if (scriptSources.includes("data:")) {
      issues.push("script 允許 data: 來源");
      bump("medium");
    }
  }
  return { severity, issues, directives };
}

function analyzeHsts(value) {
  const maxAge = Number((String(value).match(/max-age\s*=\s*"?(\d+)/i) || [])[1] || 0);
  const includeSub = /includesubdomains/i.test(value);
  if (!maxAge) return { severity: "medium", description: "HSTS 沒有有效的 max-age，等於未啟用" };
  if (maxAge < 15552000) {
    return { severity: "low", description: `HSTS max-age 僅 ${maxAge} 秒（約 ${Math.round(maxAge / 86400)} 天），建議至少 180 天（15552000）` };
  }
  return { severity: "pass", description: `HSTS 設定良好：max-age=${maxAge}${includeSub ? "、includeSubDomains" : "（未含 includeSubDomains）"}` };
}

function analyzeHeaders(res, ctx) {
  const headers = res.headers || {};
  const findings = [];
  const cspValue = String(headers["content-security-policy"] || "").trim();
  const cspDirectives = cspValue ? parseCsp(cspValue) : {};

  for (const check of SECURITY_HEADERS_CHECKLIST) {
    const value = String(headers[check.header] || "").trim();
    let severity = value ? "pass" : check.severity;
    let description = value ? `已設定: ${value.length > 160 ? `${value.slice(0, 160)}...` : value}` : check.description;

    if (check.header === "strict-transport-security" && !ctx.isHttps) {
      severity = "info";
      description = "此服務使用 HTTP，HSTS 只對 HTTPS 有意義（請先啟用 HTTPS）";
    } else if (check.header === "x-frame-options" && !value && cspDirectives["frame-ancestors"]) {
      severity = "pass";
      description = `已由 CSP frame-ancestors 保護: ${cspDirectives["frame-ancestors"].join(" ")}`;
    } else if (check.header === "x-content-type-options" && value && value.toLowerCase() !== "nosniff") {
      severity = "low";
      description = `X-Content-Type-Options 值應為 nosniff，目前為: ${value}`;
    } else if (check.header === "content-security-policy" && !value && headers["content-security-policy-report-only"]) {
      severity = "low";
      description = "只設定了 Content-Security-Policy-Report-Only（僅回報，不會真正阻擋）";
    }

    findings.push({ category: "header", check: check.label, header: check.header, present: !!value, value, severity, description });
  }

  const hsts = String(headers["strict-transport-security"] || "").trim();
  if (hsts && ctx.isHttps) {
    const quality = analyzeHsts(hsts);
    findings.push({ category: "header", check: "HSTS 品質", header: "", present: true, value: "", severity: quality.severity, description: quality.description });
  }
  if (cspValue) {
    const quality = analyzeCsp(cspValue);
    findings.push({
      category: "header",
      check: "CSP 品質",
      header: "",
      present: true,
      value: "",
      severity: quality.severity,
      description: quality.issues.length ? quality.issues.join("；") : "CSP 未發現明顯弱點"
    });
  }

  const xss = String(headers["x-xss-protection"] || "").trim();
  findings.push({
    category: "header",
    check: "X-XSS-Protection",
    header: "x-xss-protection",
    present: !!xss,
    value: xss,
    severity: xss ? "pass" : "info",
    description: xss ? `已設定: ${xss}` : "未設定（此標頭已被現代瀏覽器棄用，不扣分）"
  });

  const serverHeader = String(headers.server || "").trim();
  if (serverHeader) {
    const hasVersion = /\/\s*[\d.]+|\b\d+\.\d+/.test(serverHeader);
    findings.push({
      category: "header",
      check: "Server Header",
      header: "server",
      present: true,
      value: serverHeader,
      severity: hasVersion ? "low" : "info",
      description: hasVersion ? `Server header 暴露版本資訊: ${serverHeader}` : `Server header: ${serverHeader}`
    });
  }
  for (const name of ["x-powered-by", "x-aspnet-version", "x-aspnetmvc-version", "x-generator"]) {
    const value = String(headers[name] || "").trim();
    if (!value) continue;
    findings.push({
      category: "header",
      check: name === "x-powered-by" ? "X-Powered-By" : name.toUpperCase(),
      header: name,
      present: true,
      value,
      severity: "low",
      description: `${name} 暴露技術棧/版本: ${value}，建議移除`
    });
  }
  return findings;
}

// ── Cookie（只記名稱與旗標，不記值）──────────────────────────────────────────

function parseSetCookie(line) {
  const parts = String(line).split(";").map((s) => s.trim());
  const nameValue = parts.shift() || "";
  const eq = nameValue.indexOf("=");
  const cookie = { name: (eq > 0 ? nameValue.slice(0, eq) : nameValue).trim(), secure: false, httpOnly: false, sameSite: "" };
  for (const attr of parts) {
    const [key, value] = attr.split("=");
    const lower = String(key || "").trim().toLowerCase();
    if (lower === "secure") cookie.secure = true;
    else if (lower === "httponly") cookie.httpOnly = true;
    else if (lower === "samesite") cookie.sameSite = String(value || "").trim().toLowerCase();
  }
  return cookie;
}

function analyzeCookies(rawCookies, ctx) {
  const rows = [];
  const byName = new Map();
  rawCookies.map(parseSetCookie).filter((c) => c.name).forEach((c) => byName.set(c.name, c));
  const cookies = Array.from(byName.values()).slice(0, 20);
  const row = (check, severity, description) => ({ category: "cookie", check, severity, description });

  if (!cookies.length) {
    rows.push(row("Cookie 旗標", "info", "首頁回應沒有設定 Cookie（登入後的 Cookie 不在檢查範圍）"));
    return rows;
  }
  const sessionLike = (c) => /sess|sid|token|auth|jwt|login/i.test(c.name);
  const csrfLike = (c) => /csrf|xsrf/i.test(c.name);
  const names = (list) => list.slice(0, 6).map((c) => c.name).join(", ") + (list.length > 6 ? ` 等 ${list.length} 個` : "");

  const noSecure = ctx.isHttps ? cookies.filter((c) => !c.secure) : [];
  const noHttpOnly = cookies.filter((c) => !c.httpOnly && !csrfLike(c));
  const noSameSite = cookies.filter((c) => !c.sameSite);
  const sameSiteNoneInsecure = cookies.filter((c) => c.sameSite === "none" && !c.secure);

  if (noSecure.length) rows.push(row("Cookie Secure 旗標", noSecure.some(sessionLike) ? "medium" : "low", `HTTPS 站台的 Cookie 未設定 Secure，可能經由 HTTP 明文傳送: ${names(noSecure)}`));
  else if (ctx.isHttps) rows.push(row("Cookie Secure 旗標", "pass", `${cookies.length} 個 Cookie 皆已設定 Secure`));
  if (noHttpOnly.length) rows.push(row("Cookie HttpOnly 旗標", noHttpOnly.some(sessionLike) ? "medium" : "low", `Cookie 未設定 HttpOnly，可被前端腳本（XSS）讀取: ${names(noHttpOnly)}`));
  else rows.push(row("Cookie HttpOnly 旗標", "pass", "Cookie 皆已設定 HttpOnly（CSRF token 類除外）"));
  if (noSameSite.length) rows.push(row("Cookie SameSite 旗標", noSameSite.some(sessionLike) ? "low" : "info", `Cookie 未明確設定 SameSite: ${names(noSameSite)}`));
  else rows.push(row("Cookie SameSite 旗標", "pass", "Cookie 皆已設定 SameSite"));
  if (sameSiteNoneInsecure.length) rows.push(row("Cookie SameSite=None", "medium", `SameSite=None 的 Cookie 必須同時設定 Secure: ${names(sameSiteNoneInsecure)}`));
  return rows;
}

// ── 其他 HTTP 層檢查 ──────────────────────────────────────────────────────────

function analyzeMixedContent(res, ctx) {
  if (!ctx.isHttps) return [];
  if (!/html/i.test(contentTypeOf(res.headers))) return [];
  const html = res.body.toString("utf8");
  const active = html.match(/<(?:script|iframe)\b[^>]*\bsrc\s*=\s*["']http:\/\/[^"']+/gi) || [];
  const styles = html.match(/<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*\bhref\s*=\s*["']http:\/\/[^"']+/gi) || [];
  const passive = html.match(/<(?:img|audio|video|source)\b[^>]*\bsrc\s*=\s*["']http:\/\/[^"']+/gi) || [];
  const row = (severity, description) => ({ category: "content", check: "混合內容 (Mixed Content)", severity, description });
  if (active.length || styles.length) {
    return [row("medium", `HTTPS 頁面以 HTTP 載入主動式資源（script/iframe ${active.length}、css ${styles.length}），會被瀏覽器封鎖或遭竄改`)];
  }
  if (passive.length) return [row("low", `HTTPS 頁面以 HTTP 載入 ${passive.length} 個圖片/媒體資源`)];
  return [row("pass", "首頁未發現混合內容")];
}

async function checkHttpRedirect(parsedUrl, opts) {
  const row = (severity, description) => ({ category: "redirect", check: "HTTP 導向 HTTPS", severity, description });
  if (parsedUrl.protocol !== "https:") return [];
  if (parsedUrl.port && parsedUrl.port !== "443") {
    return [row("info", `自訂 HTTPS 連接埠 ${parsedUrl.port}，略過 HTTP→HTTPS 導向檢查`)];
  }
  try {
    const res = await rawRequest(`http://${parsedUrl.hostname}/`, { userAgent: opts.userAgent, timeoutMs: opts.pathTimeoutMs, maxBytes: 4096 });
    const location = String(res.headers.location || "");
    if (res.statusCode >= 300 && res.statusCode < 400 && /^https:\/\//i.test(location)) {
      return [row("pass", `HTTP (80) 已導向 HTTPS（${res.statusCode}）`)];
    }
    if (res.statusCode >= 300 && res.statusCode < 400) {
      return [row("low", `HTTP (80) 有轉址但目標不是 HTTPS: ${location.slice(0, 80)}`)];
    }
    return [row("medium", `HTTP (80) 直接回應 ${res.statusCode}，沒有強制導向 HTTPS，使用者可能以明文連線`)];
  } catch (error) {
    return [row("pass", `HTTP (80) 未開放或無法連線（${errMessage(error).slice(0, 60)}）`)];
  }
}

async function checkCors(targetUrl, opts) {
  const row = (severity, description) => ({ category: "cors", check: "CORS 設定", severity, description });
  try {
    const res = await rawRequest(targetUrl, {
      userAgent: opts.userAgent,
      timeoutMs: opts.pathTimeoutMs,
      maxBytes: 2048,
      headers: { Origin: CORS_TEST_ORIGIN }
    });
    const acao = String(res.headers["access-control-allow-origin"] || "").trim();
    const credentials = String(res.headers["access-control-allow-credentials"] || "").trim().toLowerCase() === "true";
    if (!acao) return [row("pass", "未回應 CORS 標頭（同源政策預設保護）")];
    if (acao === CORS_TEST_ORIGIN) {
      return credentials
        ? [row("high", "CORS 會反射任意 Origin 並允許帶憑證 (credentials)，任何網站都能以使用者身分讀取資料")]
        : [row("low", "CORS 會反射任意 Origin（未允許憑證），僅公開資料可被跨站讀取")];
    }
    if (acao === "null") return [row(credentials ? "high" : "medium", "CORS 允許 Origin: null（可被 sandbox iframe/本機檔案利用）")];
    if (acao === "*") return [row(credentials ? "low" : "info", "CORS 為 Access-Control-Allow-Origin: *（公開 API 常見，請確認資料本來就公開）")];
    return [row("pass", `CORS 限定來源: ${acao.slice(0, 80)}`)];
  } catch (error) {
    return [row("info", `CORS 檢查失敗: ${errMessage(error).slice(0, 80)}`)];
  }
}

async function checkHttpMethods(targetUrl, opts) {
  const rows = [];
  const row = (severity, description) => ({ category: "method", check: "HTTP 方法", severity, description });
  try {
    const trace = await rawRequest(targetUrl, { method: "TRACE", userAgent: opts.userAgent, timeoutMs: opts.pathTimeoutMs, maxBytes: 4096 });
    const echoed = trace.statusCode === 200 && (/message\/http/i.test(contentTypeOf(trace.headers)) || /^TRACE\s/i.test(trace.body.toString("utf8", 0, 16)));
    rows.push(echoed ? row("medium", "TRACE 方法已啟用並回顯請求內容（Cross-Site Tracing 風險），建議停用") : row("pass", `TRACE 方法未啟用（HTTP ${trace.statusCode}）`));
  } catch (error) {
    rows.push(row("pass", `TRACE 方法無法使用（${errMessage(error).slice(0, 60)}）`));
  }
  try {
    const options = await rawRequest(targetUrl, { method: "OPTIONS", userAgent: opts.userAgent, timeoutMs: opts.pathTimeoutMs, maxBytes: 2048 });
    const allow = String(options.headers.allow || "").toUpperCase();
    if ((options.statusCode === 200 || options.statusCode === 204) && /\b(?:PUT|DELETE|PATCH)\b/.test(allow)) {
      rows.push(row("low", `OPTIONS 回報允許 ${allow}（僅讀取回報，未實際測試），請確認寫入方法均需授權`));
    }
  } catch (_) {
    // OPTIONS 失敗不影響結果
  }
  return rows;
}

// ── TLS ───────────────────────────────────────────────────────────────────────

const TLS_VERSIONS = ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"];
const SIG_OIDS = [
  { id: "SHA-1", severity: "high", hex: ["2a864886f70d010105", "2a8648ce3d040101"] },
  { id: "MD5", severity: "critical", hex: ["2a864886f70d010104"] },
  { id: "MD2", severity: "critical", hex: ["2a864886f70d010102"] }
];
const WEAK_CIPHER = /RC4|3DES|DES-CBC|(?:^|[-_])DES(?:[-_]|$)|NULL|EXPORT|(?:^|[-_])MD5(?:$|[-_])|ANON/i;

function classifyProbeError(error) {
  const text = `${error && error.code ? error.code : ""} ${errMessage(error)}`.toLowerCase();
  // 探針這端的 OpenSSL 不支援該版本 → 無法判斷
  if (/no protocols available|invalid_protocol_version|no ciphers available|unsupported_protocol_version/.test(text)) return null;
  if (/etimedout|timeout|enotfound|ehostunreach|econnrefused/.test(text)) return null;
  // 對方拒絕（版本/握手失敗、被重設、對方回非 TLS 內容）→ 不支援
  return false;
}

function probeTlsVersion(host, port, version, timeoutMs) {
  return new Promise((resolve) => {
    let socket = null;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { if (socket) socket.destroy(); } catch (_) { /* ignore */ }
      resolve(value);
    };
    try {
      const options = { host, port, rejectUnauthorized: false, minVersion: version, maxVersion: version, timeout: timeoutMs };
      if (!net.isIP(host)) options.servername = host;
      if (version !== "TLSv1.3") options.ciphers = "ALL:@SECLEVEL=0";
      socket = tls.connect(options, () => finish(socket.getProtocol() === version));
    } catch (_) {
      finish(null);
      return;
    }
    socket.on("error", (error) => finish(classifyProbeError(error)));
    socket.setTimeout(timeoutMs, () => finish(null));
  });
}

function inspectCertificate(socket, result) {
  const cert = socket.getPeerCertificate(true);
  if (!cert || !cert.subject) return;
  result.cert_subject = cert.subject.CN || "";
  result.cert_issuer = (cert.issuer && (cert.issuer.CN || cert.issuer.O)) || "";
  result.cert_valid_from = cert.valid_from || "";
  result.cert_valid_to = cert.valid_to || "";
  result.san = String(cert.subjectaltname || "").split(/,\s*/).map((s) => s.replace(/^DNS:/, "")).filter(Boolean).slice(0, 8);
  result.wildcard = result.cert_subject.startsWith("*.") || result.san.some((s) => s.startsWith("*."));

  if (cert.valid_to) {
    const expiry = new Date(cert.valid_to);
    result.cert_days_remaining = Math.floor((expiry - new Date()) / 86400000);
    result.cert_expired = result.cert_days_remaining < 0;
  }

  if (cert.modulus) {
    result.key_type = "RSA";
    result.key_bits = Number(cert.bits || 0);
  } else if (cert.asn1Curve || cert.nistCurve) {
    result.key_type = `EC ${cert.nistCurve || cert.asn1Curve}`;
    result.key_bits = Number(cert.bits || 0);
  }

  // 沿憑證鏈檢查簽章演算法（根憑證自簽不算）
  const seen = new Set();
  let current = cert;
  let length = 0;
  while (current && current.raw && !seen.has(current.fingerprint256)) {
    seen.add(current.fingerprint256);
    length += 1;
    const issuer = current.issuerCertificate;
    const isRoot = !issuer || issuer === current || issuer.fingerprint256 === current.fingerprint256;
    if (!isRoot || length === 1) {
      for (const sig of SIG_OIDS) {
        if (sig.hex.some((hex) => current.raw.includes(Buffer.from(hex, "hex")))) {
          if (!result.weak_signature || SEVERITY_RANK[sig.severity] > SEVERITY_RANK[result.weak_signature.severity]) {
            result.weak_signature = { algorithm: sig.id, severity: sig.severity, subject: (current.subject && current.subject.CN) || "" };
          }
        }
      }
    }
    if (isRoot) break;
    current = issuer;
  }
  result.chain_length = length;
}

function buildTlsFindings(r) {
  const findings = [];
  const add = (check, severity, description) => findings.push({ category: "tls", check, severity, description });

  const legacyEarly = ["TLSv1", "TLSv1.1"].filter((v) => r.protocols[v] === true);
  if (!r.ok) {
    add("TLS 連線", "error", `無法完成 TLS 握手: ${r.errors.join("；").slice(0, 160) || "未知錯誤"}`);
    if (legacyEarly.length) add("TLS 協定版本", "medium", `僅/仍支援已淘汰的 ${legacyEarly.join("、")}，應停用並啟用 TLS 1.2 以上`);
    return findings;
  }
  if (r.cert_expired) add("憑證有效期", "critical", `憑證已過期（${r.cert_valid_to}）`);
  else if (r.cert_days_remaining >= 0 && r.cert_days_remaining <= 14) add("憑證有效期", "high", `憑證將在 ${r.cert_days_remaining} 天後到期，請立即更新`);
  else if (r.cert_days_remaining >= 0 && r.cert_days_remaining <= 30) add("憑證有效期", "medium", `憑證將在 ${r.cert_days_remaining} 天後到期`);
  else if (r.cert_days_remaining >= 0) add("憑證有效期", "pass", `憑證剩餘 ${r.cert_days_remaining} 天`);

  add("主機名稱比對", r.sni_match ? "pass" : "high", r.sni_match ? `憑證涵蓋此主機名稱${r.wildcard ? "（萬用字元憑證）" : ""}` : "憑證的主體/SAN 與連線主機名稱不符，瀏覽器會顯示憑證錯誤");

  if (r.cert_self_signed) add("憑證信任鏈", "high", "使用自簽憑證，瀏覽器與用戶端不會信任");
  else if (r.trust_error === "SELF_SIGNED_CERT_IN_CHAIN") add("憑證信任鏈", "high", "憑證鏈包含不受信任的私有 CA 根憑證");
  else if (r.trust_error === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || r.trust_error === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" || r.trust_error === "UNABLE_TO_GET_ISSUER_CERT") {
    add("憑證信任鏈", "medium", "憑證鏈無法驗證：伺服器可能漏送中繼憑證，或簽發者不在探針信任清單內");
  } else add("憑證信任鏈", "pass", "憑證鏈可驗證");

  if (r.weak_signature) add("憑證簽章演算法", r.weak_signature.severity, `憑證鏈使用已淘汰的 ${r.weak_signature.algorithm} 簽章（${r.weak_signature.subject}）`);
  else add("憑證簽章演算法", "pass", "憑證簽章演算法安全");

  if (r.key_type === "RSA" && r.key_bits > 0 && r.key_bits < 2048) add("憑證金鑰強度", "high", `RSA 金鑰僅 ${r.key_bits} 位元，低於 2048`);
  else if (r.key_bits > 0) add("憑證金鑰強度", "pass", `${r.key_type} ${r.key_bits} 位元`);

  const legacy = ["TLSv1", "TLSv1.1"].filter((v) => r.protocols[v] === true);
  if (legacy.length) add("TLS 協定版本", "medium", `仍支援已淘汰的 ${legacy.join("、")}，應停用（PCI DSS、NIST 均已要求）`);
  else if (["TLSv1", "TLSv1.1"].some((v) => r.protocols[v] === null)) add("TLS 協定版本", "info", "無法判斷是否仍支援 TLS 1.0/1.1（探針端 OpenSSL 限制或連線逾時）");
  else add("TLS 協定版本", "pass", "未支援 TLS 1.0 / 1.1");

  if (r.protocols["TLSv1.3"] === false) add("TLS 1.3", "info", "尚未支援 TLS 1.3（建議啟用，不扣分）");

  if (r.cipher && WEAK_CIPHER.test(r.cipher)) add("加密套件", "high", `協商出較弱的加密套件: ${r.cipher}`);
  else if (r.cipher) add("加密套件", "pass", r.cipher);
  return findings;
}

function inspectTls(host, port, timeoutMs) {
  const result = {
    ok: false,
    protocol: "",
    cipher: "",
    cert_subject: "",
    cert_issuer: "",
    cert_valid_from: "",
    cert_valid_to: "",
    cert_days_remaining: -1,
    cert_expired: false,
    cert_self_signed: false,
    sni_match: true,
    trust_error: "",
    key_type: "",
    key_bits: 0,
    san: [],
    wildcard: false,
    chain_length: 0,
    weak_signature: null,
    protocols: {},
    errors: [],
    findings: [],
    severity: "pass"
  };

  const doHandshake = (extraOptions) => new Promise((resolve) => {
    let finished = false;
    let socket = null;
    const done = () => {
      if (finished) return;
      finished = true;
      try { if (socket) socket.destroy(); } catch (_) { /* ignore */ }
      resolve();
    };
    const options = Object.assign({ host, port: port || 443, rejectUnauthorized: false, timeout: timeoutMs || 10000 }, extraOptions || {});
    if (!net.isIP(host)) options.servername = host;
    try {
      socket = tls.connect(options, () => {
        try {
          result.ok = true;
          result.errors = [];
          result.protocol = socket.getProtocol ? socket.getProtocol() || "" : "";
          const cipher = socket.getCipher ? socket.getCipher() : null;
          result.cipher = (cipher && cipher.name) || "";
          inspectCertificate(socket, result);
          if (!socket.authorized) {
            const authError = String(socket.authorizationError || "");
            result.errors.push(authError);
            result.trust_error = authError;
            if (/ALTNAME|hostname|mismatch|does not match/i.test(authError)) result.sni_match = false;
            if (authError === "DEPTH_ZERO_SELF_SIGNED_CERT") result.cert_self_signed = true;
          }
        } catch (error) {
          result.errors.push(errMessage(error));
        }
        done();
      });
    } catch (error) {
      result.errors.push(errMessage(error));
      done();
      return;
    }
    socket.on("error", (error) => {
      result.errors.push(errMessage(error));
      done();
    });
    socket.setTimeout(timeoutMs || 10000, () => {
      result.errors.push("TLS handshake timeout");
      done();
    });
  });
  const handshake = doHandshake();

  return Promise.all([
    handshake,
    ...TLS_VERSIONS.map((version) => probeTlsVersion(host, port || 443, version, Math.min(timeoutMs || 10000, 8000)).then((supported) => {
      result.protocols[version] = supported;
    }))
  ]).then(async () => {
    // 只支援舊協定的伺服器，預設設定（TLS 1.2+）握手會失敗；改用它支援的最高舊版本再取一次憑證資訊
    if (!result.ok) {
      const legacy = ["TLSv1.1", "TLSv1"].find((v) => result.protocols[v] === true);
      if (legacy) {
        await doHandshake({ minVersion: legacy, maxVersion: legacy, ciphers: "ALL:@SECLEVEL=0" });
      }
    }
    result.findings = buildTlsFindings(result);
    result.severity = worstSeverity(result.findings);
    return result;
  });
}

// ── 評分與彙整 ────────────────────────────────────────────────────────────────

function computeScore(counts) {
  let score = 100;
  for (const sev of ISSUE_SEVERITIES) score -= (counts[sev] || 0) * SEVERITY_WEIGHT[sev];
  return Math.max(0, Math.min(100, score));
}

function computeGrade(counts, score) {
  if (counts.critical > 0 || score < 40) return "F";
  if (counts.high >= 2 || score < 60) return "D";
  if (counts.high === 1 || score < 75) return "C";
  if (score < 90) return "B";
  return "A";
}

function issueKey(item) {
  if (item.category === "exposure") return `exposure:${item.path}`;
  return `${item.category}:${item.check}`;
}

function buildDiff(previous, currentKeys, currentScore, currentGrade) {
  if (!previous) return null;
  const diff = {
    previous_grade: previous.grade || "",
    previous_score: previous.score === undefined ? null : previous.score,
    previous_scanned_at: previous.scanned_at || "",
    legacy: !previous.keys,
    new_issues: [],
    resolved_issues: []
  };
  if (previous.keys) {
    const before = new Set(previous.keys);
    const after = new Set(currentKeys);
    diff.new_issues = currentKeys.filter((k) => !before.has(k)).slice(0, 30);
    diff.resolved_issues = previous.keys.filter((k) => !after.has(k)).slice(0, 30);
  }
  diff.changed = diff.previous_grade !== currentGrade || (diff.previous_score !== null && diff.previous_score !== currentScore);
  return diff;
}

// ── 對外入口 ──────────────────────────────────────────────────────────────────

async function scanService(service, options) {
  const opts = Object.assign({
    userAgent: DEFAULT_USER_AGENT,
    timeoutMs: 15000,
    pathTimeoutMs: 8000,
    previous: null,
    log: async () => {}
  }, options || {});

  const url = String((service && (service.secondary_url || service.url)) || "").trim();
  const base = { service_id: String((service && service.id) || "").trim(), service_name: String((service && service.name) || url).trim() };
  if (!url) return Object.assign({ ok: false, error: "No URL" }, base);

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return Object.assign({ ok: false, error: "Invalid URL" }, base);
  }
  parsed.hash = "";
  const isHttps = parsed.protocol === "https:";
  const host = parsed.hostname;
  const port = Number(parsed.port || (isHttps ? 443 : 80));
  const scannedAt = new Date().toISOString();
  const ctx = { isHttps };
  const safe = async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (error) {
      await opts.log(`[SECURITY_SCAN] ${label} failed: ${errMessage(error)}`);
      return fallback;
    }
  };

  await opts.log(`[SECURITY_SCAN] service=${base.service_name} url=${parsed.href}`);

  const [tlsResult, rootResult, pathFindings, redirectRows, corsRows, methodRows] = await Promise.all([
    isHttps ? safe("tls", () => inspectTls(host, port, opts.timeoutMs), null) : Promise.resolve(null),
    safe("root", () => fetchFollowingSameHost(parsed.href, { userAgent: opts.userAgent, timeoutMs: opts.timeoutMs, maxBytes: ROOT_BODY_BYTES }, 3), null),
    safe("paths", () => checkSensitivePaths(parsed, opts), []),
    safe("redirect", () => checkHttpRedirect(parsed, opts), []),
    safe("cors", () => checkCors(parsed.href, opts), []),
    safe("methods", () => checkHttpMethods(parsed.href, opts), [])
  ]);

  let headerFindings;
  let extra = [];
  let rootInfo = null;
  if (rootResult && rootResult.response) {
    headerFindings = analyzeHeaders(rootResult.response, ctx);
    extra = extra.concat(analyzeCookies(rootResult.cookies, ctx), analyzeMixedContent(rootResult.response, ctx));
    rootInfo = { final_url: rootResult.finalUrl, status: rootResult.response.statusCode, hops: rootResult.chain.length - 1 };
  } else {
    headerFindings = [{ category: "header", check: "HTTP_REQUEST", header: "", present: false, value: "", severity: "error", description: "無法連線檢查標頭" }];
  }
  extra = extra.concat(redirectRows, corsRows, methodRows);
  if (!isHttps) {
    extra.unshift({ category: "tls", check: "未啟用 HTTPS", severity: "high", description: "此服務使用 HTTP 明文連線，帳號密碼與內容可能被竊聽或竄改" });
  }

  const tlsFindings = tlsResult ? tlsResult.findings : [];
  const scored = [...headerFindings, ...pathFindings, ...extra, ...tlsFindings];
  const counts = { critical: 0, high: 0, medium: 0, low: 0, pass: 0 };
  scored.forEach((item) => {
    if (counts[item.severity] !== undefined) counts[item.severity] += 1;
  });
  const score = computeScore(counts);
  const grade = computeGrade(counts, score);
  const totalIssues = counts.critical + counts.high + counts.medium + counts.low;
  const keys = scored.filter((item) => ISSUE_SEVERITIES.includes(item.severity)).map(issueKey).slice(0, 80);
  const diff = buildDiff(opts.previous, keys, score, grade);

  const result = {
    ok: true,
    scanner_version: SCANNER_VERSION,
    service_id: base.service_id,
    service_name: base.service_name,
    url: parsed.href,
    host,
    scanned_at: scannedAt,
    grade,
    score,
    total_issues: totalIssues,
    critical_count: counts.critical,
    high_count: counts.high,
    medium_count: counts.medium,
    low_count: counts.low,
    pass_count: counts.pass,
    is_https: isHttps,
    tls: tlsResult,
    headers: headerFindings,
    paths: pathFindings,
    extra,
    root: rootInfo,
    keys,
    diff
  };

  await opts.log(`[SECURITY_SCAN] service=${base.service_name} grade=${grade} score=${score} issues=${totalIssues} (critical=${counts.critical} high=${counts.high} medium=${counts.medium} low=${counts.low})`);
  return result;
}

// 把掃描結果轉成要寫進 details_json 的物件（欄位精簡，避免超過 Sheets 儲存格上限）
function toDetails(result) {
  const tlsResult = result.tls;
  return {
    version: SCANNER_VERSION,
    score: result.score,
    tls: tlsResult ? {
      protocol: tlsResult.protocol,
      cipher: tlsResult.cipher,
      cert_subject: tlsResult.cert_subject,
      cert_issuer: tlsResult.cert_issuer,
      cert_valid_from: tlsResult.cert_valid_from,
      cert_valid_to: tlsResult.cert_valid_to,
      cert_days_remaining: tlsResult.cert_days_remaining,
      cert_expired: tlsResult.cert_expired,
      cert_self_signed: tlsResult.cert_self_signed,
      sni_match: tlsResult.sni_match,
      key_type: tlsResult.key_type,
      key_bits: tlsResult.key_bits,
      san: tlsResult.san,
      wildcard: tlsResult.wildcard,
      chain_length: tlsResult.chain_length,
      protocols: tlsResult.protocols,
      severity: tlsResult.severity,
      findings: tlsResult.findings,
      errors: (tlsResult.errors || []).slice(0, 4)
    } : null,
    headers: result.headers.map((h) => ({ check: h.check, header: h.header, present: h.present, value: h.value, severity: h.severity, description: h.description })),
    paths: result.paths.map((p) => ({ path: p.path, label: p.label, status_code: p.status_code, accessible: p.accessible, severity: p.severity, body_length: p.body_length, confidence: p.confidence, description: p.description })),
    extra: result.extra,
    root: result.root,
    keys: result.keys,
    diff: result.diff
  };
}

// 從 listSecurityScans 的一列資料取出上次掃描的摘要（供 diff 使用）
function previousFromRow(row) {
  if (!row) return null;
  let details = null;
  try {
    details = row.details_json ? JSON.parse(row.details_json) : null;
  } catch (_) {
    details = null;
  }
  return {
    grade: String(row.grade || ""),
    score: details && typeof details.score === "number" ? details.score : undefined,
    scanned_at: String(row.scanned_at || ""),
    keys: details && Array.isArray(details.keys) ? details.keys : null
  };
}

module.exports = {
  SCANNER_VERSION,
  scanService,
  toDetails,
  previousFromRow,
  // 以下供測試使用
  analyzeCsp,
  analyzeCookies,
  analyzeHeaders,
  isSoftMatch,
  fingerprint,
  computeScore,
  computeGrade,
  probeTlsVersion,
  inspectTls,
  SENSITIVE_PATHS
};
