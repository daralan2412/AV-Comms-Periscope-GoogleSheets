#!/usr/bin/env python3
"""
scrape_and_upload.py - AV-Comms-Periscope-GoogleSheets

NEW pipeline, independent of daralan2412/AV-Flights-Periscope-GoogleSheets
(AV Flight Lookup), daralan2412/FX-periscope-googlesheets (FedEx
REP-1901), daralan2412/CM-Master-Periscope-Googlesheets (Copa) and
daralan2412/periscope-to-sheets (PTY wheelchair). None of those are touched;
this repo shares no secrets, sheet or Apps Script with them.

Source: Periscope/Sisense shared report "Springshot Comms Counts" (Avianca BOG)
        https://app.periscopedata.com/shared/ecc51857-da20-40f2-8917-3c2b68fd34e8
        widget "Raw Data", 8 columns (see HEADERS).
Target: Google Sheet "2026_AV_Comms"
        https://docs.google.com/spreadsheets/d/1Nd_-ux8WkyifEXbxuTBoyUNL0E-wRbJ5JorgTDfza-0
        tab "Data". The scraper posts every row to the Apps Script Web App
        (SHEETS_WEBAPP_URL / WEBAPP_TOKEN secrets), which UPSERTS by
        team_mission_comment_id: an id already in the tab is overwritten in
        place, new ids are appended. Re-pulling D-1/D0 four times a day is
        therefore safe - "N updated in place" is the normal steady state and
        "appended" is what is actually new.

Flow (4x a day: 00:07, 06:07, 12:07, 18:07 America/Bogota - see run.yml):
  1. Open the report, set the Date Range filter to "D-1 to D0" via Custom
     Range with computed Start/End dates, then use the Raw Data widget's own
     "Download Data" CSV export (NOT DOM scraping - the grid is virtualized;
     the CSV is generated server-side and is complete).
  2. POST {"rows": [[...8 cols...], ...]} to the Web App.

Optional one-off catch-up: BACKFILL_START / BACKFILL_END (MM/DD/YYYY, via the
workflow_dispatch inputs or env) additionally pulls that range in
BACKFILL_CHUNK_DAYS pieces.

The browser-driving code is the hardened v4.1 logic from the FedEx pipeline
(2026-09-02), as reused by the Copa pipeline, because this report is the same
Sisense template with the same DOM (verified live 2026-09-24: same
Company_Job_Filter / Company_Worksite_Filter / Date Range panel with "Custom
Range" and default "All Dates"). Traps it works around:
  - do NOT wait for the grid / "networkidle" before applying our filter (the
    default "All Dates" query is slow at scheduled hours and we replace it);
  - "Custom Range" lives in .custom-date-option, NOT inside .radio-button-group;
  - type the dates with press_sequentially (the datepicker ignores .fill());
    no Escape (it can clear the field), no Tab; click-into-next-field commits;
  - wait for .apply-button to lose "disabled" before clicking it;
  - the real breadcrumb is ".filters-bar .filter-group .filter .label"
    (".filters-bar-label" only ever reads "Filters (N)");
  - ".error-message" is ALWAYS in the DOM (display:none) - check visibility,
    never existence, or every run silently reports "no rows";
  - whole-scrape retry with a fresh browser (SCRAPE_ATTEMPTS).
"""

import csv
import io
import json
import os
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests
from playwright.sync_api import sync_playwright

PERISCOPE_URL = "https://app.periscopedata.com/shared/ecc51857-da20-40f2-8917-3c2b68fd34e8"
REPORT_NAME = "Springshot Comms Counts"
WIDGET_TITLE = "Raw Data"  # the only titled widget on the report (the others are charts)
LOCAL_TZ = ZoneInfo("America/Bogota")  # BOG station time; UTC-5 all year (no DST).
# Window = today back through LOOKBACK_DAYS days ago, inclusive ("D0 to D-1").
# The D-1 lookback also covers Sisense filtering on a UTC timestamp: a comment
# made at 20:00 Bogota is already "tomorrow" in UTC, and the next day's first
# run (00:07, window D-1..D0) still includes it.
LOOKBACK_DAYS = 1
BACKFILL_CHUNK_DAYS = 1  # one day per pull: the widget caps display at 20k rows and a day is ~15k
WIDGET_TIMEOUT_S = 420  # post-Apply query wait (~50 s live on 2026-09-24)
SCRAPE_ATTEMPTS = 3  # whole-scrape retries with a fresh browser (see scrape_with_retry()).
SCRAPE_RETRY_DELAY_S = 60
WEBAPP_URL = os.environ["SHEETS_WEBAPP_URL"]
WEBAPP_TOKEN = os.environ["WEBAPP_TOKEN"]

# Column ORDER of the Raw Data widget / CSV export (confirmed live 2026-09-24
# against the grid header: TEAM MISSION COMMENT ID, INBOUND NUMBER, OUTBOUND
# NUMBER, OWNER, JOB TYPE, COMMENT, CREATED DATE, METADATA). The names are the
# existing header row of the "Data" tab.
HEADERS = [
    "team_mission_comment_id", "inbound_number", "outbound_number", "owner",
    "job_type", "comment", "created_date", "metadata",
]


WEBAPP_ATTEMPTS = 4
WEBAPP_RETRY_DELAY_S = 45


class PermanentWebAppError(RuntimeError):
    """The Web App answered in a way a retry cannot fix (bad token, doPost error)."""


def webapp_request(method: str, timeout: int, **kwargs) -> dict:
    """GET/POST the Apps Script Web App and return its JSON, retrying transients.

    WHY THIS EXISTS. Three of the four scheduled runs of 2026-09-18/19
    (#61, #62, #64) went red with exactly this:
        FAILED: 404 Client Error: Not Found for url:
        https://script.googleusercontent.com/macros/echo?user_content_key=...
    Apps Script does not answer on the /exec URL itself - it 302-redirects
    to a one-time googleusercontent "echo" URL that carries the reply, and
    Google intermittently 404s that redirect. #61 and #62 died on the
    tiny health-check GET before scraping anything; #64 died on the POST
    *after* the Web App had already written all 6,505 rows (the sheet's
    modified time matches). Twelve back-to-back GETs from another machine
    all returned 200, so it is a transient, not a broken deployment.

    Both calls are safe to repeat: the GET is read-only and the POST is an
    upsert by team_mission_comment_id, so a retry after an ambiguous failure can at
    worst rewrite identical rows.

    Retryable: connection errors, timeouts, HTTP 5xx / 429 / 408 / 404, a
    non-JSON body, and the Web App's own "another upload is in progress"
    lock timeout. Not retryable (raised as PermanentWebAppError): 401/403
    and any other 4xx, and an explicit success:false from doGet/doPost.
    """
    last_err = None
    for attempt in range(1, WEBAPP_ATTEMPTS + 1):
        try:
            resp = requests.request(
                method, WEBAPP_URL, params={"token": WEBAPP_TOKEN}, timeout=timeout, **kwargs
            )
            if resp.status_code >= 500 or resp.status_code in (404, 408, 429):
                raise RuntimeError(
                    f"HTTP {resp.status_code} from Web App ({resp.url[:60]}...): {resp.text[:160]!r}"
                )
            if resp.status_code >= 400:
                raise PermanentWebAppError(
                    f"Web App {method} rejected with HTTP {resp.status_code}: {resp.text[:160]!r}"
                )
            try:
                data = resp.json()
            except ValueError:
                raise RuntimeError(f"non-JSON reply from Web App (HTTP {resp.status_code}): {resp.text[:160]!r}")
            if not data.get("success"):
                err = str(data.get("error", ""))
                if "lock timeout" in err or "in progress" in err:
                    raise RuntimeError(f"Web App busy: {err}")
                raise PermanentWebAppError(f"Web App {method} failed: {data}")
            return data
        except PermanentWebAppError:
            raise
        except Exception as exc:  # noqa: BLE001 - the transient classes listed above
            last_err = exc
            print(f"Web App {method} attempt {attempt}/{WEBAPP_ATTEMPTS} failed: {exc}", file=sys.stderr)
            if attempt < WEBAPP_ATTEMPTS:
                print(f"Retrying in {WEBAPP_RETRY_DELAY_S}s...", file=sys.stderr)
                time.sleep(WEBAPP_RETRY_DELAY_S)
    raise RuntimeError(f"Web App {method} failed after {WEBAPP_ATTEMPTS} attempts: {last_err}")


def check_token():
    """Cheap pre-flight auth check before paying for a headless-browser scrape
    (retried like the POST - see webapp_request)."""
    webapp_request("GET", timeout=30)


def _fmt(d):
    return d.strftime("%m/%d/%Y")


def compute_windows():
    """All (label, start, end) windows this run must pull, primary first.

    - primary: D-LOOKBACK_DAYS..D0 in America/Bogota, one single-day window
      per day, computed at run time (a late cron still pulls the right days).
    - manual backfill: BACKFILL_START/BACKFILL_END if both set, cut into
      BACKFILL_CHUNK_DAYS pieces.
    """
    today = datetime.now(LOCAL_TZ).date()
    # One window PER DAY: the Raw Data widget refuses to render more than
    # 20,000 rows ("Result set too large ... 5MB"), and one BOG day is ~15k
    # comments, so a 2-day window never renders (run #3, 2026-09-24).
    windows = [
        ("primary D-%d" % k, _fmt(today - timedelta(days=k)), _fmt(today - timedelta(days=k)))
        for k in range(LOOKBACK_DAYS, -1, -1)
    ]

    bf_start, bf_end = os.environ.get("BACKFILL_START", "").strip(), os.environ.get("BACKFILL_END", "").strip()
    if bf_start and bf_end:
        a = datetime.strptime(bf_start, "%m/%d/%Y").date()
        b = datetime.strptime(bf_end, "%m/%d/%Y").date()
        while a <= b:
            c = min(a + timedelta(days=BACKFILL_CHUNK_DAYS - 1), b)
            windows.append(("manual backfill", _fmt(a), _fmt(c)))
            a = c + timedelta(days=1)
    return windows


def scrape_window_csv(start_str, end_str):
    """Filter the report's Raw Data widget to [start_str, end_str] and pull
    its CSV export.

    Uses Periscope's "Custom Range" Date Range filter with Start/End Date
    computed fresh on every run (see compute_windows), rather
    than a built-in preset - this pins down the exact semantics ("today back
    through yesterday, inclusive") instead of relying on unclear/undocumented
    behavior of a preset like "7 Days". Verified live: filling Start/End Date
    with explicit MM/DD/YYYY values and clicking Apply correctly narrows the
    Data widget and the resulting breadcrumb to that exact range.

    Uses the widget's built-in "Download Data" export instead of scraping the
    DOM: the Data widget is a virtualized grid (rows AND columns are only
    rendered near the viewport), so a DOM scrape would silently miss most of
    a real week's rows/columns. The CSV export is generated server-side and
    is complete regardless of what happened to be scrolled into view.

    Returns the CSV text, or None if the widget shows "Query returned no
    matching rows" - Sisense doesn't even offer a "Download Data" menu item
    when there's nothing to export, so this has to be checked for explicitly
    rather than treated as a scrape failure.
    """
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 1000})

        # Capture the export URL from the first matching request, then poll
        # it ourselves rather than relying on the page's own retry behavior.
        # Registered before any interaction so we can't race the request.
        export_url = {"value": None}

        def on_response(resp):
            if export_url["value"] is None and "/download_csv/" in resp.url:
                export_url["value"] = resp.url

        page.on("response", on_response)

        try:
            # "domcontentloaded" rather than "networkidle": the report's
            # default Date Range is "All Dates", so the page kicks off a
            # full-history query the moment it loads. On the scheduled
            # 7am/7pm runs that query is slow enough that "networkidle"
            # (and the old up-front wait for the grid, see below) never
            # settled in time. We don't need that unfiltered query at all
            # - we're about to replace it with our own Custom Range - so
            # don't wait on it.
            page.goto(PERISCOPE_URL, wait_until="domcontentloaded", timeout=90_000)

            # Only wait for the filters bar - that's all the next step
            # needs. NOTE: deliberately NOT waiting for ".ninja-grid" here.
            # An earlier version did, with a 30s timeout, and that is
            # exactly what every scheduled run failed on (runs #22, #23 on
            # 2026-09-01/02: "waiting for locator('.ninja-grid') to be
            # visible - Timeout 30000ms exceeded") while manual runs at
            # other times of day passed: the grid only renders once the
            # default "All Dates" query finishes, which at those hours
            # takes longer than 30s. The grid IS waited for further down,
            # after our filter is applied, with a much longer timeout.
            page.wait_for_selector(".filters-bar-label", timeout=90_000)

            # Open the report-level filters panel.
            page.locator(".filters-bar-label").first.click()
            page.wait_for_selector(".radio-button-group", timeout=30_000)
            page.wait_for_timeout(300)

            # Date Range column: select "Custom Range". Unlike the preset
            # options (Current Week, 7 Days, etc.), which live inside
            # .radio-button-group > .small-radio-button, "Custom Range" is
            # rendered in its own sibling container - .custom-date-option -
            # under .options (confirmed live via DOM inspection: a selector
            # scoped to .radio-button-group never matches it, which is why
            # an earlier version of this selector timed out in CI). It's
            # always the first item in the Date Range column, so no scroll
            # is needed to reach it. force=True because a plain click here
            # can hit a transient overlap issue while the panel settles.
            custom_range_option = page.locator(".custom-date-option .small-radio-button").first
            custom_range_option.click(force=True)
            page.wait_for_timeout(800)

            # Fill Start/End Date with the freshly computed D-1/D0 window.
            # force=True for the same transient-overlap reason as above.
            #
            # This is a jQuery UI-style datepicker (class "hasDatepicker")
            # that only registers a value in its own real filter state in
            # response to real keystrokes - a bulk .fill() (optionally
            # followed by dispatching synthetic "change"/"blur"/"focusout"
            # events) leaves the field SHOWING the right text but the
            # underlying filter state stays unset, so Apply stays disabled
            # and/or silently applies nothing (confirmed both ways in CI:
            # a bare .fill() and a .fill() + dispatch_event() combo both
            # left the Apply button with class "...apply-button disabled").
            # press_sequentially() sends one real keydown/keypress/keyup
            # per character, which is what a datepicker actually listens
            # for, and is what worked reliably in manual verification.
            start_input = page.locator(".range-start")
            end_input = page.locator(".range-end")

            # NOTE: no Escape/Tab here. Confirmed live (twice, 2026-08-31)
            # that clicking straight into the End field reliably commits
            # the Start field's typed value (it visibly reformats
            # "08/25/2026" -> "2026-08-25" the moment End gets focus), and
            # clicking Apply directly afterwards - without blurring End
            # first - still commits correctly. An earlier version of this
            # code pressed Escape after each field to close the
            # datepicker's calendar popup; that turned out to be the wrong
            # call - one live repro showed Escape leaving BOTH fields
            # empty after Apply (breadcrumb read just "Custom Range", no
            # dates, and the widget genuinely had no rows), most likely
            # because Escape is also this datepicker's "clear/cancel the
            # pending edit" shortcut, not just "close the popup".
            start_input.click(force=True)
            start_input.clear()
            start_input.press_sequentially(start_str, delay=40)

            end_input.click(force=True)
            end_input.clear()
            end_input.press_sequentially(end_str, delay=40)

            # Don't click Apply on a fixed delay - wait for the actual
            # signal that the datepicker has validated both typed dates:
            # the Apply button loses its "disabled" class. Confirmed live
            # in CI that even with real keystrokes, a short fixed wait
            # isn't always enough - the button can still read "disabled"
            # for a bit while the widget's own validation catches up, and
            # clicking (even with force=True) while it's disabled is a
            # no-op in the app's own click handler, silently applying
            # nothing. NOTE: this only proves the *button* thinks the
            # inputs are non-empty/well-formed - see below, it is NOT
            # sufficient proof the Custom Range actually got applied.
            page.wait_for_function(
                """() => {
                    const btn = document.querySelector('.apply-button');
                    return btn && !btn.classList.contains('disabled');
                }""",
                timeout=15_000,
            )

            # Apply the filter, then POLL the breadcrumb (not a fixed
            # delay) until it shows the committed "<date> to <date>" text.
            #
            # IMPORTANT: ".filters-bar-label" (used above to *open* the
            # panel) is NOT the per-filter breadcrumb - confirmed live via
            # DOM inspection that it only ever contains the generic
            # "Filters (N)" toggle text (a <div class="filters-bar-label
            # bold">Filters<span id="filter-count">(N)</span>...</div>).
            # This selector bug is why every prior CI run failed this
            # check even when the date range genuinely committed (run
            # #18, 2026-08-31: last breadcrumb text was literally
            # 'Filters (1)'). The actual per-filter readout lives in
            # ".filters-bar .filter-group .filter .label" (sibling of a
            # ".dimension-name" span reading "DateRange") - confirmed live
            # it shows "2026-08-25 to 2026-09-01" (computed dates,
            # YYYY-MM-DD) once both inputs hold a valid date, and keeps
            # showing it after Apply is clicked and the panel closes.
            apply_button = page.locator(".apply-button")
            date_range_label = page.locator(".filters-bar .filter-group .filter .label").first
            apply_button.click(force=True)
            try:
                page.wait_for_function(
                    """() => {
                        const el = document.querySelector('.filters-bar .filter-group .filter .label');
                        return !!el && el.textContent.includes(' to ');
                    }""",
                    timeout=15_000,
                )
            except Exception:
                raise RuntimeError(
                    "Custom Range Start/End Date did not commit - filter breadcrumb never "
                    "showed '<date> to <date>' after Apply (last breadcrumb text: "
                    f"{date_range_label.text_content()!r})"
                )

            # Find the "Raw Data" widget (the report's other widgets are
            # untitled charts).
            widget = page.locator(
                ".widget-container",
                has=page.locator(".widget-title", has_text=WIDGET_TITLE),
            ).first
            widget.scroll_into_view_if_needed()

            # Wait for the query that Apply just triggered to finish. The
            # widget shows a transient ".widget-loader" overlay ON TOP OF
            # its *previous* results while requerying - checking the
            # widget's contents before this resolves can observe stale
            # state. Poll (not a fixed delay) for either real grid rows or
            # a genuinely visible "no matching rows" message; also bail
            # out if the loader itself never appears/disappears within
            # the timeout, since a network hiccup here should be a clear
            # failure, not a silent "no rows".
            #
            # IMPORTANT: the ".error-message" node is ALWAYS present in
            # the widget's DOM, even when it's showing real data - it's a
            # hidden placeholder (confirmed live: display:none,
            # offsetParent:null while a fully-loaded grid with rows sat
            # right next to it). A bare `.count() > 0` check on it is
            # true unconditionally, which is why CI run #19 (2026-08-31)
            # reported "no rows" for a range that actually had data. Must
            # check visibility, not just presence.
            widget_handle = widget.element_handle()
            # Poll from Python (not wait_for_function) so the log shows the
            # widget's state every 30 s and a timeout says WHY it timed out
            # (run #1 of this repo only reported "Timeout 300000ms exceeded").
            state_js = """(el) => {
                const vis = (e) => !!e && e.offsetParent !== null;
                const loader = el.querySelector('.widget-loader');
                const err = el.querySelector('.error-message');
                return {
                    loader: vis(loader),
                    err: vis(err),
                    grid: !!el.querySelector('.ninja-grid'),
                    text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
                };
            }"""
            t0 = time.time()
            last_print = 0
            while True:
                st = widget_handle.evaluate(state_js)
                too_large = "Result set too large" in st["text"]
                if not st["loader"] and (st["err"] or st["grid"] or too_large):
                    print(f"  widget settled after {time.time() - t0:.0f}s: {st}", flush=True)
                    break
                waited = time.time() - t0
                if waited - last_print >= 30:
                    print(f"  waiting for widget ({waited:.0f}s): {st}", flush=True)
                    last_print = waited
                if waited > WIDGET_TIMEOUT_S:
                    raise RuntimeError(f"Raw Data widget never settled in {WIDGET_TIMEOUT_S}s; last state {st}")
                page.wait_for_timeout(1000)

            # No rows in this date range - Sisense shows this in place of
            # the grid and doesn't offer a "Download Data" menu item at
            # all, so check for it (now that the query above has settled)
            # instead of timing out waiting for a menu that will never
            # appear.
            if widget.locator(".error-message", has_text="no matching rows").is_visible():
                browser.close()
                return None

            # "Result set too large. Data displayed in web browser is limited
            # to 5MB, please select fewer than 20,000 rows." (seen in run #3,
            # 2026-09-24, for a 2-day window ~31k rows). That is only the
            # browser DISPLAY limit - the grid is not rendered, but the
            # widget's Download Data export is generated server-side, so we
            # still try it. Windows are also kept to ONE day (see
            # compute_windows) so this should be rare.
            if too_large:
                print("  widget says 'Result set too large' for display; trying the CSV export anyway", flush=True)

            # Open the per-widget menu.
            widget.hover()
            page.wait_for_timeout(500)
            widget.locator(".controls .expand.button").click(force=True)
            page.wait_for_selector("text=Download Data", timeout=30_000)
            page.get_by_text("Download Data", exact=True).click()

            deadline = time.time() + 60
            while export_url["value"] is None and time.time() < deadline:
                page.wait_for_timeout(250)
            if export_url["value"] is None:
                raise RuntimeError("Did not observe a download_csv request after clicking Download Data")
        except Exception:
            try:
                page.screenshot(path="debug_failure.png", full_page=True)
                with open("debug_failure.html", "w", encoding="utf-8") as f:
                    f.write(page.content())
            except Exception as diag_err:
                print(f"(could not capture debug artifacts: {diag_err})", file=sys.stderr)
            browser.close()
            raise

        csv_text = None
        deadline = time.time() + 180
        while time.time() < deadline:
            resp = page.context.request.get(export_url["value"])
            if resp.status == 200:
                csv_text = resp.text()
                break
            page.wait_for_timeout(2000)

        browser.close()

        if csv_text is None:
            raise RuntimeError("Timed out waiting for the CSV export to become ready")
        return csv_text


def parse_csv_rows(csv_text: str):
    reader = csv.reader(io.StringIO(csv_text))
    try:
        header = next(reader)
    except StopIteration:
        return []

    norm = lambda h: h.strip().lower().replace(" ", "_")
    if len(header) != len(HEADERS):
        print(
            f"WARNING: CSV header has {len(header)} columns, expected {len(HEADERS)}. Got: {header}",
            file=sys.stderr,
        )
    else:
        mism = [(i, header[i], HEADERS[i]) for i in range(len(HEADERS)) if norm(header[i]) != norm(HEADERS[i])]
        if mism:
            print(f"WARNING: CSV header names differ from the sheet header at: {mism}", file=sys.stderr)

    rows = []
    for row in reader:
        if not any(c.strip() for c in row):
            continue  # trailing blank line
        # Defensive pad/truncate - Apps Script's setValues() needs a fixed width.
        if len(row) < len(HEADERS):
            row = row + [""] * (len(HEADERS) - len(row))
        elif len(row) > len(HEADERS):
            row = row[: len(HEADERS)]
        rows.append(row)
    return rows


def post_rows(rows: list):
    """POST the scraped rows to the Web App (retried, see webapp_request).
    Generous timeout: Apps Script's own hard limit is 6 minutes."""
    return webapp_request(
        "POST",
        timeout=360,
        data=json.dumps({"rows": rows}),
        headers={"Content-Type": "application/json"},
    )


def scrape_with_retry(start_str, end_str):
    """Whole-scrape retry with a fresh browser (Sisense is sometimes slow at
    scheduled hours; a second attempt a minute later is cheap). The debug
    screenshot/HTML of the LAST failed attempt ends up in the run artifacts."""
    last_exc = None
    for attempt in range(1, SCRAPE_ATTEMPTS + 1):
        try:
            return scrape_window_csv(start_str, end_str)
        except Exception as exc:  # noqa: BLE001 - deliberately broad
            last_exc = exc
            print(f"Scrape attempt {attempt}/{SCRAPE_ATTEMPTS} for {start_str}-{end_str} failed: {exc}", file=sys.stderr)
            if attempt < SCRAPE_ATTEMPTS:
                print(f"Retrying in {SCRAPE_RETRY_DELAY_S}s with a fresh browser...", file=sys.stderr)
                time.sleep(SCRAPE_RETRY_DELAY_S)
    raise last_exc


def print_result(result):
    print(
        f"Posted {result.get('rows_received')} rows: "
        f"{result.get('rows_updated')} updated in place, {result.get('rows_appended')} appended; "
        f"{result.get('duplicates_removed')} stray duplicate row(s) removed; "
        f"{result.get('total_rows')} data rows in the tab now."
    )


def main():
    check_token()

    windows = compute_windows()
    print("Windows this run (America/Bogota): " + "; ".join(f"{lbl} = {a}..{b}" for lbl, a, b in windows))

    failures = []
    for label, start_str, end_str in windows:
        print(f"Pulling '{REPORT_NAME}' data for {start_str} to {end_str} ({label})...")
        try:
            csv_text = scrape_with_retry(start_str, end_str)
        except Exception as exc:  # noqa: BLE001
            # The primary window fails the run; a manual backfill chunk is
            # logged and skipped so the rest of the range still goes through.
            if label.startswith("primary"):
                raise
            print(f"Backfill window {start_str}-{end_str} skipped after retries: {exc}", file=sys.stderr)
            failures.append(f"{start_str}-{end_str}")
            continue

        if csv_text is None:
            print(f"No rows for {start_str} to {end_str} - nothing to post for this window.")
            continue

        rows = parse_csv_rows(csv_text)
        print(f"Scraped {len(rows)} rows for {start_str} to {end_str}.")
        print_result(post_rows(rows))

    if failures:
        print(f"Note: {len(failures)} backfill window(s) skipped: {', '.join(failures)}", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
