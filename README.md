# Service Monitor Frontend

Static frontend for monitoring services with Google Apps Script backend.

## API Endpoint
Configured in `/assets/common.js`:

- `./api` (same-origin proxy path)

Target Google Apps Script endpoint:

- `https://script.google.com/macros/s/AKfycbxPm5VWcnXe5b2u6oi1gqLIBCjK6raQtI-4ya1Gd1umDUEYhBGSOHpq9XBS9zZ7iBCq/exec`

## Nginx proxy (required to avoid CORS)

If your site is served under `/Monitor/`, add this in your Nginx server block:

```nginx
location /Monitor/api {
    proxy_pass https://script.google.com/macros/s/AKfycbxPm5VWcnXe5b2u6oi1gqLIBCjK6raQtI-4ya1Gd1umDUEYhBGSOHpq9XBS9zZ7iBCq/exec;
    proxy_ssl_server_name on;
    proxy_set_header Host script.google.com;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

If your site is served from root (`/`), use `/api` instead:

```nginx
location /api {
    proxy_pass https://script.google.com/macros/s/AKfycbxPm5VWcnXe5b2u6oi1gqLIBCjK6raQtI-4ya1Gd1umDUEYhBGSOHpq9XBS9zZ7iBCq/exec;
    proxy_ssl_server_name on;
    proxy_set_header Host script.google.com;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Pages

- `/index.html`: Dashboard (summary + table + charts)
- `/admin.html`: Admin (add/update/disable service + run checks now)

## Local preview

```bash
python3 -m http.server 8080
```

Then open:

- `http://localhost:8080/index.html`
- `http://localhost:8080/admin.html`

Note: `python3 -m http.server` does not provide `/api` proxy. Use Nginx for full API testing.
