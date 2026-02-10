// JSONP endpoint for GitHub Pages (no CORS dependency).
export const API_BASE = "https://script.google.com/macros/s/AKfycbxPm5VWcnXe5b2u6oi1gqLIBCjK6raQtI-4ya1Gd1umDUEYhBGSOHpq9XBS9zZ7iBCq/exec";

function jsonpRequest(params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const callbackName = `gasJsonp_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const url = new URL(API_BASE);

    Object.entries(params).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      url.searchParams.set(k, String(v));
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

export async function apiGet(params) {
  return jsonpRequest(params);
}

export async function apiPost(payload) {
  // For JSONP mode, POST actions are tunneled through query params.
  return jsonpRequest(payload);
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
