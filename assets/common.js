// JSONP endpoint for GitHub Pages (no CORS dependency).
export const API_BASE = "https://script.google.com/macros/s/AKfycbxPm5VWcnXe5b2u6oi1gqLIBCjK6raQtI-4ya1Gd1umDUEYhBGSOHpq9XBS9zZ7iBCq/exec";

function inferDashboardUrl() {
  try {
    const loc = window.location;
    if (!loc || !loc.origin || !loc.pathname) return "";
    const basePath = loc.pathname.replace(/\/[^/]*$/, "/");
    return `${loc.origin}${basePath}index.html`;
  } catch (_) {
    return "";
  }
}

function jsonpRequest(params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const callbackName = `gasJsonp_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const url = new URL(API_BASE);
    const mergedParams = { ...params };

    if (!mergedParams.dashboard_url) {
      const dashboardUrl = inferDashboardUrl();
      if (dashboardUrl) mergedParams.dashboard_url = dashboardUrl;
    }

    Object.entries(mergedParams).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      url.searchParams.set(key, String(value));
    });
    url.searchParams.set("callback", callbackName);

    const script = document.createElement("script");
    let done = false;
    let timer;

    function cleanup() {
      if (script.parentNode) script.parentNode.removeChild(script);
      if (timer) window.clearTimeout(timer);
      try {
        delete window[callbackName];
      } catch (_) {
        window[callbackName] = undefined;
      }
    }

    window[callbackName] = (data) => {
      if (done) return;
      done = true;
      cleanup();
      if (data && data.ok === false) {
        reject(new Error(data.error || "API error"));
        return;
      }
      resolve(data);
    };

    script.onerror = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("JSONP request failed."));
    };

    timer = window.setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("JSONP request timeout."));
    }, timeoutMs);

    script.src = url.toString();
    document.head.appendChild(script);
  });
}

export async function apiGet(params, timeoutMs) {
  return jsonpRequest(params, timeoutMs);
}

export async function apiPost(payload, timeoutMs) {
  return jsonpRequest(payload, timeoutMs);
}

export function fmtDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("zh-TW", { hour12: false });
}

export function safeText(v) {
  return (v ?? "").toString();
}

export function escapeHtml(v) {
  return safeText(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(v) {
  return escapeHtml(v);
}

export function safeHttpUrl(v) {
  const raw = safeText(v).trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw, window.location.href);
    const protocol = String(parsed.protocol || "").toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return "";
    return parsed.toString();
  } catch (_) {
    return "";
  }
}

export function normalizeLatencyMs(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  const asNum = Number(value);
  if (Number.isFinite(asNum)) {
    return Math.round(asNum);
  }

  const d = new Date(value);
  if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() < 1971) {
    const sheetsEpoch = Date.UTC(1899, 11, 30);
    const serial = (d.getTime() - sheetsEpoch) / 86400000;
    if (Number.isFinite(serial)) return Math.round(serial);
  }

  return null;
}

export function statusBadge(status) {
  const value = String(status || "").toUpperCase();
  if (value === "UP") return '<span class="badge up">UP</span>';
  if (value === "UP-") return '<span class="badge warn">UP-</span>';
  if (value === "SLOW") return '<span class="badge unknown">SLOW</span>';
  if (value === "UNSTABLE") return '<span class="badge unknown">UNSTABLE</span>';
  if (value) return `<span class="badge down">${escapeHtml(value)}</span>`;
  return '<span class="badge unknown">UNKNOWN</span>';
}

export function isUpEquivalentStatus(status) {
  const value = String(status || "").toUpperCase();
  return value === "UP" || value === "UP-";
}

export function serviceCheckModeBadge(service) {
  const mode = String((service && service.check_mode) || "").toLowerCase();
  const label = safeText((service && service.check_mode_label) || "").trim() || "單點檢查";
  const cls = mode === "dual"
    ? "check-mode-badge dual"
    : mode === "dual_pending"
      ? "check-mode-badge pending"
      : "check-mode-badge single";
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

export function serviceCheckModeDetail(service) {
  return safeText((service && service.check_mode_detail) || "").trim() || "由 GAS 執行檢查";
}

export function loadHostBadge() {
  const badge = document.getElementById("hostBadge");
  if (!badge) return;
  const host = window.location.hostname;
  const port = window.location.port;
  badge.textContent = `主機 ${host}${port ? `:${port}` : ""}`;
}

function createScrollFab() {
  const wrap = document.createElement("div");
  wrap.className = "fab-wrap";

  const fabTop = document.createElement("button");
  fabTop.className = "fab fab--hidden";
  fabTop.title = "回到頂部";
  fabTop.setAttribute("aria-label", "回到頂部");
  fabTop.textContent = "↑";

  const fabBottom = document.createElement("button");
  fabBottom.className = "fab fab--hidden";
  fabBottom.title = "前往底部";
  fabBottom.setAttribute("aria-label", "前往底部");
  fabBottom.textContent = "↓";

  wrap.appendChild(fabTop);
  wrap.appendChild(fabBottom);
  document.body.appendChild(wrap);

  function updateVisibility() {
    const scrollTop = window.scrollY;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    fabTop.classList.toggle("fab--hidden", scrollTop < 60);
    fabBottom.classList.toggle("fab--hidden", maxScroll < 1 || scrollTop >= maxScroll - 30);
  }

  fabTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  fabBottom.addEventListener("click", () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));

  window.addEventListener("scroll", updateVisibility, { passive: true });
  window.addEventListener("resize", updateVisibility, { passive: true });
  window.setTimeout(updateVisibility, 300);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", createScrollFab);
} else {
  createScrollFab();
}
