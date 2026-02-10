# Service Monitor Frontend

Static frontend for monitoring services with Google Apps Script backend.

## API Endpoint
Configured in `/assets/common.js`:

- `https://script.google.com/macros/s/AKfycbxPm5VWcnXe5b2u6oi1gqLIBCjK6raQtI-4ya1Gd1umDUEYhBGSOHpq9XBS9zZ7iBCq/exec`

This frontend uses **JSONP** (script injection), so it works on GitHub Pages without CORS proxy.

## GAS Requirements

Your Apps Script `doGet` must support:

- `callback` query param (return `callback(<json>)` when provided)
- read actions:
  - `action=listServices`
  - `action=metrics&serviceId=...&hours=...`
- write actions via GET query params (JSONP tunnel):
  - `action=addService&name=...&url=...&interval_min=...`
  - `action=updateService&id=...&name=...&url=...&interval_min=...&enabled=true|false`
  - `action=deleteService&id=...`
  - `action=runNow`
  - `action=getReportConfig`
  - `action=updateReportConfig&recipients=...&frequency=hourly|daily&daily_hour=0-23&enabled=true|false&only_on_issue=true|false`
  - `action=sendReportNow`

## Pages

- `/index.html`: Dashboard (summary + table + charts)
- `/admin.html`: Admin (add/update/disable service + run checks now)
- `/health.html`: Backend health check (API latency + stale service detection)

## GitHub Pages

Upload all files to your repository root (or docs folder), enable GitHub Pages, and open:

- `https://<your-account>.github.io/<repo>/index.html`
- `https://<your-account>.github.io/<repo>/admin.html`

## Local preview (UI only)

```bash
python3 -m http.server 8080
```

Then open:

- `http://localhost:8080/index.html`
- `http://localhost:8080/admin.html`
