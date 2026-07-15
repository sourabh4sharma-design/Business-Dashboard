# Collections Dashboard

A live dashboard over the Collections/Debtors Google Sheet. No build step —
plain HTML/CSS/JS, hosted on GitHub Pages.

## How it works

The source Google Sheet is private and restricted to the paytm.com Google
Workspace domain. An Apps Script deployed inside that sheet (Extensions →
Apps Script → Deploy as web app, "Execute as: Me") exposes each tab's data
at a `script.google.com/a/macros/paytm.com/...` URL.

`app.js` polls that URL every 7 seconds via JSONP (a `<script>` tag, not
`fetch()`) — this is what lets the request carry the viewer's existing
paytm.com Google session cookie automatically. In practice this means:
- Anyone signed into a **paytm.com** Google account in their browser sees
  live data, refreshed every ~7 seconds.
- Anyone else's request silently fails (no data), since Google's domain
  policy blocks the underlying script for non-paytm.com sessions.

The request is also gated by a shared secret key baked into `app.js`
(`APPS_SCRIPT_KEY`) — this only deters casual/automated scanning, since the
key is visible in this repo's public source; the paytm.com domain
restriction is the actual access control.

## Updating the tab list

If tabs are renamed, added, or removed in the sheet, update the `TABS` array
in `app.js` to match — no server-side script changes needed, since the Apps
Script just reads whatever tab name it's asked for.

## Updating the Apps Script

Open the sheet → Extensions → Apps Script. After editing the script, use
**Deploy → Manage deployments → edit (pencil icon) → Version: New version →
Deploy** to update the existing URL (creating a brand new deployment instead
would change the URL and require updating `APPS_SCRIPT_URL` in `app.js`).

## Local preview

```
python3 -m http.server 8000
```

Then open http://localhost:8000
