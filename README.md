# Service Monitor Frontend

Static frontend for monitoring services with a Google Apps Script backend.

## API Endpoint

Configured in `/assets/common.js`:

- `https://script.google.com/macros/s/AKfycbxPm5VWcnXe5b2u6oi1gqLIBCjK6raQtI-4ya1Gd1umDUEYhBGSOHpq9XBS9zZ7iBCq/exec`

This frontend uses JSONP so it works on GitHub Pages without a CORS proxy.

## GAS Requirements

Your Apps Script `doGet` must support:

- `callback` query param and return `callback(<json>)` when provided
- read actions:
  - `action=listServices`
  - `action=metrics&serviceId=...&hours=...`
- write actions via GET query params for the frontend JSONP tunnel:
  - `action=addService&name=...&url=...&interval_min=...`
  - `action=updateService&id=...&name=...&url=...&interval_min=...&enabled=true|false`
  - `action=deleteService&id=...`
  - `action=deleteTestDataByDate&date=YYYY-MM-DD`
  - `action=runNow`
  - `action=getReportConfig`
  - `action=updateReportConfig&recipients=...&frequency=hourly|daily&daily_hour=0-23&enabled=true|false&only_on_issue=true|false`
  - `action=sendReportNow`

## Pages

- `/index.html`: dashboard
- `/admin.html`: admin page
- `/health.html`: backend health check page

## GitHub Pages

Upload all files to your repository root or `docs` folder, enable GitHub Pages, and open:

- `https://<your-account>.github.io/<repo>/index.html`
- `https://<your-account>.github.io/<repo>/admin.html`

## Local Preview

```bash
python3 -m http.server 8080
```

Then open:

- `http://localhost:8080/index.html`
- `http://localhost:8080/admin.html`

## Local Probe

For dual-probe setups, you can run the local Node.js probe:

```bash
node local-probe.js
```

Recommended setup for distribution:

1. Copy `probe-config.example.json` to `probe-config.json`
2. Fill in your GAS Web App URL and probe ID
3. Place `probe-config.json` next to `local-probe.js` or the generated `.exe`

Environment variables:

- `MONITOR_API_BASE`: GAS Web App URL
- `MONITOR_PROBE_ID`: probe identifier, for example `local-office-01`
- `MONITOR_PROBE_NAME`: display name for this probe
- `MONITOR_REQUEST_TIMEOUT_MS`: request timeout per HTTP attempt
- `MONITOR_SHOW_RESULT_WINDOW`: `true|false`, whether to show the Windows summary popup
- `MONITOR_SHOW_RESULT_WINDOW_ON_ERROR_ONLY`: `true|false`, when `true` only show the popup if there is a down or error result
- `MONITOR_SHOW_CONTROL_WINDOW`: `true|false`, whether to open the small control window
- `MONITOR_CONTROL_WINDOW_INTERVAL_SEC`: repeat interval for loop mode in the control window

The script will:

- read `action=listServices`
- check enabled services from the local machine
- follow Google Apps Script Web App redirects automatically
- register or update probe metadata using `action=upsertProbe`
- write results back to GAS using `action=appendProbeCheck`

For Windows, schedule it with Task Scheduler every minute.

If you run the probe manually, you can enable a Windows popup summary window:

- the packaged `.exe` defaults to `show_result_window = true`
- `show_result_window_on_error_only = true` shows the popup only on down or error results
- `show_result_window_on_error_only = false` shows the popup on every run

Control window mode:

- `Run Once` runs one probe cycle immediately
- `Start Loop` keeps running on the configured interval
- `Stop` pauses the loop without closing the program
- `Close` exits the control window and stops any running child probe
- start the probe from `dist/monitor-local-probe.vbs`
- do not launch the `.exe` directly; it is the background worker and will show a console window

## Security Scan

`node local-probe.js --security-scan` (or the control window / admin page trigger) scans every enabled, non-local service. The checks live in `security-scanner.js` (loaded by `local-probe.js`; `pkg` bundles it automatically). Results are stored in the existing `security_scans` sheet (`details_json`), so the GAS backend does not need to be redeployed.

Checks (read-only; no PUT/DELETE/POST is ever sent, cookie values are never stored):

- TLS: certificate expiry / hostname / trust chain / key size / SHA-1 signature, and active probing of TLS 1.0 / 1.1 / 1.2 / 1.3 support
- HTTP headers: HSTS (and max-age), CSP (and `unsafe-inline` / wildcard quality), X-Frame-Options (or CSP `frame-ancestors`), nosniff, Referrer-Policy, Permissions-Policy, version leaks
- Sensitive paths (~30, e.g. `/.env`, `/.git/config`, backups, phpinfo, actuator, directory listing): a hit only counts when the response **looks like that file** and differs from a random non-existent path, so SPA catch-all pages (always 200) and login redirects are not reported
- Cookie flags, HTTP→HTTPS redirect, CORS reflection, TRACE, mixed content

Scoring: `100 − (critical×25 + high×12 + medium×5 + low×2)`. Grade: any critical or score < 40 → F; 2+ high or < 60 → D; 1 high or < 75 → C; < 90 → B; otherwise A. Each result also records the previous grade/score and which issues are new or fixed. The dashboard and admin pages show it, and the dashboard can export all findings as CSV.

After changing `local-probe.js` / `security-scanner.js`, rebuild and redistribute the probe (`npm install` once, then `npm run probe:build:win`); old probes keep writing the old result format, which the UI labels as "legacy".

## Build EXE

```bash
npm install
npm run probe:build:win
```

Output:

- `dist/monitor-local-probe.vbs`
- `dist/probe-config.json`
- `dist/monitor-local-probe-ui.ps1`
