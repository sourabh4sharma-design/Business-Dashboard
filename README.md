# Collections Dashboard

A live dashboard over the Collections/Debtors Google Sheet. No build step —
plain HTML/CSS/JS, hosted on GitHub Pages.

## How it works

- Data is pulled directly from the Google Sheet on every page load, via each
  tab's public CSV export URL (`SHEET_ID` + tab name in `app.js`).
- The sheet must stay shared as **"Anyone with the link – Viewer"** or the
  dashboard can't read it.
- Editing the sheet updates the dashboard automatically — no code changes or
  redeploys needed. Just click **Refresh** on the page (or reload it).

## Updating the tab list

If tabs are renamed, added, or removed in the sheet, update the `TABS` array
at the top of `app.js` to match.

## Local preview

```
python3 -m http.server 8000
```

Then open http://localhost:8000
