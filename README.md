# AV-Comms-Periscope-GoogleSheets

Pulls the Sisense/Periscope shared report **"Springshot Comms Counts"**
(Avianca BOG) into the Google Sheet **2026_AV_Comms**, four times a day, on
GitHub Actions.

This is a **new, independent pipeline**. It shares nothing with
`AV-Flights-Periscope-GoogleSheets` (AV Flight Lookup), `FX-periscope-googlesheets` (FedEx REP-1901), `CM-Master-Periscope-Googlesheets`
(Copa) or `periscope-to-sheets` (PTY wheelchair) - different report,
different sheet, different Apps Script project, different secrets.

## What it does

| | |
|---|---|
| Source | https://app.periscopedata.com/shared/ecc51857-da20-40f2-8917-3c2b68fd34e8 (widget "Raw Data", 8 columns) |
| Window | **D0 to D-1** (today and yesterday, America/Bogota), pulled as **one single-day window per day** (the Raw Data widget refuses to render more than 20,000 rows; one BOG day is ~15.5k) |
| Schedule | **00:07, 06:07, 12:07, 18:07 America/Bogota** (`7 5,11,17,23 * * *` UTC) + manual `workflow_dispatch` |
| Target | https://docs.google.com/spreadsheets/d/1Nd_-ux8WkyifEXbxuTBoyUNL0E-wRbJ5JorgTDfza-0 - tab **Data** |
| Columns | `team_mission_comment_id, inbound_number, outbound_number, owner, job_type, comment, created_date, metadata` |
| Dedupe | **upsert** by `team_mission_comment_id`: an id already in the tab is overwritten in place, new ids are appended (sorted by `created_date`) |

## How it works

1. `scrape_and_upload.py` (Python 3.11 + Playwright Chromium) opens the
   report, picks **Custom Range** in the Date Range filter, types the
   window's start / end (MM/DD/YYYY), applies, waits for the Raw Data widget
   to settle, clicks its **Download Data** CSV export and polls the
   `/download_csv/` URL until it returns 200.
2. It POSTs `{"rows": [[...8 cols...], ...]}` to the Apps Script Web App
   (`apps-script/Code.gs`) with `?token=`.
3. The Web App upserts by id, then checks column A for stray duplicate ids
   (only writes if it finds any).

The browser-driving code is the hardened **v4.1** logic from the FedEx
pipeline (hidden `.error-message` placeholder, datepicker ignoring `.fill()`,
wrong breadcrumb selector, slow default "All Dates" query at scheduled hours).

## Secrets (Settings > Secrets and variables > Actions)

- `SHEETS_WEBAPP_URL` - the Web App `/exec` URL.
- `WEBAPP_TOKEN` - must equal the Apps Script Script Property `AUTH_TOKEN`.

## Reading a run

A green check is **not** proof of success (the script exits 0 when the widget
genuinely has no rows). Open "Run scrape and upload" and look for:

```
Windows this run (America/Bogota): primary D-1 = 09/23/2026..09/23/2026; primary D-0 = 09/24/2026..09/24/2026
Pulling 'Springshot Comms Counts' data for 09/23/2026 to 09/23/2026 (primary D-1)...
  widget settled after 33s: {...}
Scraped 15508 rows for 09/23/2026 to 09/23/2026.
Posted 15508 rows: 0 updated in place, 15508 appended; 0 stray duplicate row(s) removed; 31157 data rows in the tab now.
Pulling ... 09/24/2026 to 09/24/2026 (primary D-0)...
```

"appended" is what is actually new since the previous run. A scrape step
that finishes in single-digit seconds did not do the work.

## One-off catch-up

Actions > the workflow > **Run workflow**, fill `backfill_start` /
`backfill_end` (MM/DD/YYYY). The run pulls D-1..D0 and then that range one
day at a time. Safe to repeat - everything is upserted.

## Capacity

A Google spreadsheet holds at most 10 million cells. At ~15k comments/day x 8
columns the Data tab grows by ~3.7M cells a month, so a single file lasts
roughly 2.5 months. Plan a split (e.g. one file per month) before it fills.

## Known edge cases

- Sisense's Date Range filter may be applied on a UTC timestamp; the D-1
  lookback makes sure evening comments (already "tomorrow" in UTC) are picked
  up by the next run.
- Apps Script deployments are pinned to a version: after editing `Code.gs`,
  **Deploy > Manage deployments > Edit > New version**, or `/exec` keeps
  running the old code.

## Lessons from the first runs (2026-09-24)

- Runs #1-#3 timed out waiting for the widget: a 2-day window (~31k rows)
  makes the Raw Data widget show "Result set too large. Data displayed in web
  browser is limited to 5MB, please select fewer than 20,000 rows." instead of
  a grid. Fixed in v1.2 by pulling one day per window; the scraper also logs
  the widget state every 30 s and treats that message as settled (it still
  tries the server-side CSV export).
- Run #4 (first success): 09/23 = 15,508 rows appended, 09/24 (partial day)
  appended; tab went 15,649 -> 38,248 rows.
