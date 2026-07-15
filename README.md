# Collections Dashboard

A live dashboard over the Collections/Debtors Google Sheet. No build step —
plain HTML/CSS/JS, hosted on GitHub Pages.

## How it works

The source Google Sheet is private. A scheduled GitHub Action
(`.github/workflows/refresh-data.yml`) runs every 15 minutes (and can be
triggered manually from the repo's **Actions** tab), authenticates as a
Google service account, and writes each tab's data to `data/<slug>.json`.
The static page (`app.js`) only ever reads those committed JSON files — it
never talks to Google directly, so the sheet's privacy is preserved.

Requirements for this to keep working:
- The service account (its email is inside the JSON key file) must remain
  shared as a **Viewer** on the sheet.
- The `GCP_SERVICE_ACCOUNT_JSON` repo secret (Settings → Secrets and
  variables → Actions) must stay set to that service account's key.

## Updating the tab list

If tabs are renamed, added, or removed in the sheet, update the `TABS` array
in `app.js` **and** the `TABS` list in `scripts/fetch_data.py` to match.

## Local preview

```
python3 -m http.server 8000
```

Then open http://localhost:8000
