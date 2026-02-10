// Use same-origin API path to avoid browser CORS issues.
// Configure your web server to proxy this path to the Google Apps Script URL.
export const API_BASE = "./api";

async function parseJson(response) {
  if (!response.ok) {
    if (response.status === 404 && API_BASE.startsWith("./")) {
      throw new Error("API proxy not found. Please configure /api proxy on your web server.");
    }
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

export async function apiGet(params) {
  const url = new URL(API_BASE, window.location.href);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), { method: "GET" });
  return parseJson(res);
}

export async function apiPost(payload) {
  const url = new URL(API_BASE, window.location.href);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return parseJson(res);
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

export function statusBadge(status) {
  if (status === "UP") return '<span class="badge up">UP</span>';
  if (status === "DOWN") return '<span class="badge down">DOWN</span>';
  return '<span class="badge unknown">UNKNOWN</span>';
}
