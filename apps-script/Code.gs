/**
 * AV-Comms-Periscope-GoogleSheets - Apps Script Web App
 *
 * NEW, INDEPENDENT PROJECT. Shares nothing (Script Properties, deployment,
 * sheet) with the FedEx, Copa or PTY wheelchair pipelines.
 *
 * Source:  Sisense/Periscope shared report "Springshot Comms Counts" (Avianca BOG)
 *          https://app.periscopedata.com/shared/ecc51857-da20-40f2-8917-3c2b68fd34e8
 * Target:  ONE SPREADSHEET PER MONTH (v3.1, see MONTH_FILES), tab "Data", 8 columns (HEADERS).
 *          July 2026 = the original "2026_AV_Comms" (SPREADSHEET_ID); other
 *          months = "<M>_<YYYY>_AV_Comms" in the same Drive folder, created on
 *          first use. Column A = team_mission_comment_id = the dedupe key;
 *          column G = created_date decides the file.
 *
 * Contract with the scraper (scrape_and_upload.py):
 *   GET  ?token=...                          -> {success:true} health check
 *   GET  ?token=...&action=rebuild           -> collapse stray duplicate ids
 *   POST ?token=...  {"rows":[[...8 cols...], ...]}
 *        UPSERT by team_mission_comment_id: an id already in the tab has its
 *        row overwritten in place (freshest scrape wins), new ids are
 *        appended. Then a cleanup pass over column A only removes any stray
 *        duplicate ids (e.g. hand-pasted data), keeping the LAST occurrence.
 *
 * Cell formats: columns A-C (ids / flight numbers) and G (created_date) keep
 * Sheets' automatic format, so they are stored as numbers / date-times
 * exactly like the rows already in the tab. Free-text columns D-F and H are
 * forced to plain text ('@') before writing, so a comment such as "=)" or
 * "+1" can never be evaluated as a formula and "360" stays text.
 *
 * Both endpoints require ?token=<AUTH_TOKEN> (Script Property). Same value in
 * the GitHub secret WEBAPP_TOKEN.
 *
 * Deploy: Deploy > New deployment > Web app, Execute as: Me, Who has access:
 * Anyone. The /exec URL goes in the GitHub secret SHEETS_WEBAPP_URL.
 * Editing this code does NOT change the live /exec until
 * Deploy > Manage deployments > Edit > Version: New version.
 */

var SPREADSHEET_ID = '1Nd_-ux8WkyifEXbxuTBoyUNL0E-wRbJ5JorgTDfza-0'; // 2026_AV_Comms = the JULY 2026 file
var HOME_MONTH = '7_2026';         // month held by SPREADSHEET_ID
var FILE_SUFFIX = '_AV_Comms';     // other months: "<M>_<YYYY>_AV_Comms" (8_2026_AV_Comms, ...)
var SHEET_NAME = 'Data';
var ID_COL = 1;                    // column A = team_mission_comment_id
var DATE_COL = 7;                  // column G = created_date (routes the row)
var TEXT_COLS = [4, 5, 6, 8];      // owner, job_type, comment, metadata
var HEADERS = [
  'team_mission_comment_id', 'inbound_number', 'outbound_number', 'owner',
  'job_type', 'comment', 'created_date', 'metadata'
];

// v3 (2026-09-24): ONE FILE PER MONTH. A single spreadsheet is capped at 10M
// cells; July alone is ~490k rows. Each row goes to the file of its own
// created_date month: July -> 2026_AV_Comms (the original file), any other
// month -> "<M>_<YYYY>_AV_Comms" in the same Drive folder, created on first
// use. Rows sitting in the wrong month's file are deleted by the cleanup.

// GET ?token=...                                   -> health check (all month files)
// GET ?token=...&action=rebuild&month=9_2026       -> dedupe + wrong-month cleanup of one file
function doGet(e) {
  if (!checkToken_(e)) return jsonOut_({ success: false, error: 'unauthorized' });
  try {
    if ((e.parameter.action || '') === 'rebuild') {
      var ym = e.parameter.month || HOME_MONTH;
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(120000)) return jsonOut_({ success: false, error: 'another upload is in progress (lock timeout)' });
      try {
        var sh = findMonthSheet_(ym);
        if (!sh) return jsonOut_({ success: false, error: 'no file for ' + ym });
        return jsonOut_({ success: true, action: 'rebuild', month: ym, result: cleanupSheet_(sh, ym) });
      } finally {
        lock.releaseLock();
      }
    }
    var files = {}, total = 0;
    listMonthFiles_().forEach(function (f) {
      var n = Math.max(f.sheet.getLastRow() - 1, 0);
      files[f.name] = n; total += n;
    });
    return jsonOut_({ success: true, message: 'ok', rows: total, files: files });
  } catch (err) {
    return jsonOut_({ success: false, error: 'doGet failed: ' + err });
  }
}

function doPost(e) {
  if (!checkToken_(e)) return jsonOut_({ success: false, error: 'unauthorized' });

  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ success: false, error: 'invalid JSON body: ' + err });
  }
  var rows = (body.rows || []).map(normalizeWidth_);

  // Serialize concurrent runs (a late cron overlapping a manual run).
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(120000)) {
    return jsonOut_({ success: false, error: 'another upload is in progress (lock timeout)' });
  }
  try {
    var groups = {}, unroutable = 0;
    rows.forEach(function (row) {
      var ym = monthKey_(row[DATE_COL - 1], null);
      if (!ym) { unroutable++; return; }
      (groups[ym] = groups[ym] || []).push(row);
    });
    var perFile = {}, upd = 0, app = 0, dup = 0, wrong = 0, total = 0;
    Object.keys(groups).forEach(function (ym) {
      var sheet = getOrCreateMonthSheet_(ym);
      var u = upsertRows_(sheet, groups[ym]);
      var c = cleanupSheet_(sheet, ym);
      perFile[fileLabel_(ym)] = { received: groups[ym].length, updated: u.updated, appended: u.appended,
                                  duplicates_removed: c.duplicates, wrong_month_removed: c.wrongMonth, total_rows: c.total };
      upd += u.updated; app += u.appended; dup += c.duplicates; wrong += c.wrongMonth; total += c.total;
    });
    return jsonOut_({
      success: true,
      rows_received: rows.length,
      rows_unroutable: unroutable,
      rows_updated: upd,
      rows_appended: app,
      duplicates_removed: dup,
      wrong_month_removed: wrong,
      total_rows: total,
      files: perFile
    });
  } catch (err) {
    return jsonOut_({ success: false, error: 'doPost failed: ' + err });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Month routing
// ---------------------------------------------------------------------------

// "9_2026" from a created_date cell: ISO text "2026-09-24 13:05:00[.123]"
// (what Periscope exports) or a Date (what Sheets turns it into).
function monthKey_(v, tz) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
    tz = tz || 'America/Bogota';
    return Number(Utilities.formatDate(v, tz, 'M')) + '_' + Utilities.formatDate(v, tz, 'yyyy');
  }
  var m = String(v).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return parseInt(m[2], 10) + '_' + m[1];
  m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);   // MM/DD/YYYY fallback
  if (m) return parseInt(m[1], 10) + '_' + m[3];
  return null;
}

// v3.1: NO DriveApp. The Drive scope was not granted, so month files are
// pre-created in the 2026_AV_Comms folder and listed here; SpreadsheetApp
// (already authorized) is all that is needed to open them. A month that is
// not listed is created with SpreadsheetApp.create (it lands in My Drive
// root - move it next to the others) and remembered in Script Properties.
var MONTH_FILES = {
  '1_2026':  '1QkXGSIIrXaZ40OQBE7Z7aOwVXtcGhBU5Q5h2NMTe9yk', // 1_2026_AV_Comms
  '2_2026':  '17dF124-LatQV7H2WUaSL9QDGYS-iwJLbi356KVal8qk', // 2_2026_AV_Comms
  '3_2026':  '1pFk55gPIPiXfkakgjooQDp7LYkxibYUpw4i0HwUO4oM', // 3_2026_AV_Comms
  '4_2026':  '1IPe3Sn9vuZiWWlPK_y2YzKG8tKrZyEdhMH_dDh0UyAM', // 4_2026_AV_Comms
  '5_2026':  '1xkjMhOPT6bP1Nftj6XqNgzbJ8jeMIThLVxrelKmKHuE', // 5_2026_AV_Comms
  '6_2026':  '14LbT32TRUaIZY6XL2ByAZEkNlSU8RY1bUOs-rN5aVUo', // 6_2026_AV_Comms
  '7_2026':  '1Nd_-ux8WkyifEXbxuTBoyUNL0E-wRbJ5JorgTDfza-0', // 2026_AV_Comms (July)
  '8_2026':  '1-Y5OA_LoQ_4CeeEvB3zgYtsJvlc8FsCkt-VGXDn7dYk', // 8_2026_AV_Comms
  '9_2026':  '1GyE2jBn-KsJhFCyTVgi0-TVio_TLJjCMTHDyJZJjk6s', // 9_2026_AV_Comms
  '10_2026': '1uIqbSa8g6u81xtd_jbYbuPyGCNG9OcjcHbFtyj9pPVc', // 10_2026_AV_Comms
  '11_2026': '1QbiK8fjmua3swsFkmGCTeuz4GCZ0cDPNTmBHbBJJ9Hc', // 11_2026_AV_Comms
  '12_2026': '1IhOhZxoifPu37jpi5Pfd77V3k6MxP0v9RgbH-alI7zA'  // 12_2026_AV_Comms
};

function fileLabel_(ym) {
  return ym === HOME_MONTH ? '2026_AV_Comms (' + ym + ')' : ym + FILE_SUFFIX;
}

function monthFileId_(ym) {
  return MONTH_FILES[ym] || PropertiesService.getScriptProperties().getProperty('FILE_' + ym);
}

// Returns the data tab. Month files other than July are trimmed to the 8
// data columns on first use: Google counts EMPTY columns against the 10M
// cell cap (a default 26-column grid would triple the cost of every row).
function dataSheet_(ss, ym) {
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  if (ym !== HOME_MONTH) {
    if (sheet.getName() !== SHEET_NAME) sheet.setName(SHEET_NAME);
    if (sheet.getMaxColumns() > HEADERS.length) {
      sheet.deleteColumns(HEADERS.length + 1, sheet.getMaxColumns() - HEADERS.length);
    }
    if (ss.getSpreadsheetTimeZone() !== 'America/Bogota') ss.setSpreadsheetTimeZone('America/Bogota');
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  if (sheet.getFrozenRows() !== 1) sheet.setFrozenRows(1);
  return sheet;
}

function findMonthSheet_(ym) {
  var id = monthFileId_(ym);
  return id ? dataSheet_(SpreadsheetApp.openById(id), ym) : null;
}

function getOrCreateMonthSheet_(ym) {
  var existing = findMonthSheet_(ym);
  if (existing) return existing;
  var ss = SpreadsheetApp.create(ym + FILE_SUFFIX, 1000, HEADERS.length);
  PropertiesService.getScriptProperties().setProperty('FILE_' + ym, ss.getId());
  return dataSheet_(ss, ym);
}

function listMonthFiles_() {
  var keys = Object.keys(MONTH_FILES);
  var props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(props).forEach(function (k) {
    var m = k.match(/^FILE_(\d{1,2}_\d{4})$/);
    if (m && keys.indexOf(m[1]) < 0) keys.push(m[1]);
  });
  return keys.map(function (ym) { return { name: fileLabel_(ym), sheet: findMonthSheet_(ym) }; });
}

function upsertRows_(sheet, batch) {
  var lastRow = sheet.getLastRow();

  var rowById = {};
  if (lastRow >= 2) {
    var ids = sheet.getRange(2, ID_COL, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i][0]).trim();
      if (id) rowById[id] = i + 2;
    }
  }

  // Collapse the batch by id (last posted wins); split into updates/appends.
  var updates = {};       // sheet row number -> row values
  var appendsById = {};
  var appendOrder = [];
  var blankIdRows = [];
  batch.forEach(function (row) {
    var id = String(row[ID_COL - 1]).trim();
    if (!id) { blankIdRows.push(row); return; }
    if (rowById[id]) { updates[rowById[id]] = row; return; }
    if (!appendsById.hasOwnProperty(id)) appendOrder.push(id);
    appendsById[id] = row;
  });

  // In-place updates. The CSV export is not in sheet order, so one
  // setValues() per row would be far too slow. Instead the rows to update
  // are grouped into clusters (a gap of up to CLUSTER_GAP untouched rows is
  // absorbed), and each cluster is read, patched in memory and written back
  // once. Clustering (v2, 2026-09-24) matters once backfilled days sit
  // between today's rows: a single min..max span would rewrite the whole tab.
  var rowNums = Object.keys(updates).map(Number).sort(function (a, b) { return a - b; });
  var updated = rowNums.length;
  var CLUSTER_GAP = 2000;
  var c0 = 0;
  while (c0 < rowNums.length) {
    var c1 = c0;
    while (c1 + 1 < rowNums.length && rowNums[c1 + 1] - rowNums[c1] <= CLUSTER_GAP) c1++;
    var lo = rowNums[c0], hi = rowNums[c1];
    var span = sheet.getRange(lo, 1, hi - lo + 1, HEADERS.length);
    var data = span.getValues();
    for (var k = c0; k <= c1; k++) data[rowNums[k] - lo] = updates[rowNums[k]];
    setTextFormat_(sheet, lo, hi - lo + 1);
    span.setValues(data);
    c0 = c1 + 1;
  }

  // Appends, in created_date order (ISO text sorts chronologically).
  var appends = appendOrder.map(function (id) { return appendsById[id]; });
  appends.sort(function (a, b) {
    var x = String(a[6]), y = String(b[6]);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  appends = appends.concat(blankIdRows);
  if (appends.length > 0) {
    var start = lastRow + 1;
    if (start + appends.length - 1 > sheet.getMaxRows()) {
      sheet.insertRowsAfter(sheet.getMaxRows(), start + appends.length - 1 - sheet.getMaxRows());
    }
    setTextFormat_(sheet, start, appends.length);
    sheet.getRange(start, 1, appends.length, HEADERS.length).setValues(appends);
  }
  return { updated: updated, appended: appends.length };
}

function setTextFormat_(sheet, startRow, numRows) {
  TEXT_COLS.forEach(function (c) {
    sheet.getRange(startRow, c, numRows, 1).setNumberFormat('@');
  });
}

// Cleanup: delete rows whose created_date belongs to another month (they
// live in that month's file) and collapse stray duplicate ids (last wins).
// Reads columns A and G only; writes nothing when there is nothing to remove.
function cleanupSheet_(sheet, ym) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { duplicates: 0, wrongMonth: 0, total: 0 };
  var tz = sheet.getParent().getSpreadsheetTimeZone();
  var ids = sheet.getRange(2, ID_COL, lastRow - 1, 1).getValues();
  var dates = sheet.getRange(2, DATE_COL, lastRow - 1, 1).getValues();

  // Fast path for Date cells: Utilities.formatDate() per cell took minutes on
  // a 500k-row file (the 2026-09-24 rebuild of July timed out). Compute the
  // file's UTC offset once and read month/year with plain Date arithmetic.
  var offMs = null;
  var wrong = {}, wrongMonth = 0;
  for (var w = 0; w < dates.length; w++) {
    var v = dates[w][0], k;
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
      if (offMs === null) offMs = tzOffsetMs_(v, tz);
      var x = new Date(v.getTime() + offMs);
      k = (x.getUTCMonth() + 1) + '_' + x.getUTCFullYear();
    } else {
      k = monthKey_(v, tz);
    }
    if (k && k !== ym) { wrong[w] = true; wrongMonth++; }
  }
  var lastIndexById = {};
  for (var j = 0; j < ids.length; j++) {
    if (wrong[j]) continue;
    var id = String(ids[j][0]).trim();
    if (id) lastIndexById[id] = j;
  }
  var toDelete = [], duplicates = 0;
  for (var i = 0; i < ids.length; i++) {
    if (wrong[i]) { toDelete.push(i); continue; }
    var idI = String(ids[i][0]).trim();
    if (idI && lastIndexById[idI] !== i) { toDelete.push(i); duplicates++; }
  }
  var total = ids.length - toDelete.length;
  if (toDelete.length === 0) return { duplicates: 0, wrongMonth: 0, total: total };

  var blocks = [];
  for (var q = 0; q < toDelete.length; q++) {
    if (blocks.length && toDelete[q] === blocks[blocks.length - 1].end + 1) {
      blocks[blocks.length - 1].end = toDelete[q];
    } else {
      blocks.push({ start: toDelete[q], end: toDelete[q] });
    }
  }
  if (blocks.length <= 50) {
    for (var bi = blocks.length - 1; bi >= 0; bi--) {
      sheet.deleteRows(blocks[bi].start + 2, blocks[bi].end - blocks[bi].start + 1);
    }
  } else {
    var lastCol = Math.max(sheet.getLastColumn(), HEADERS.length);
    var rng = sheet.getRange(2, 1, lastRow - 1, lastCol);
    var data = rng.getValues();
    var drop = {};
    toDelete.forEach(function (x) { drop[x] = true; });
    var kept = data.filter(function (_, idx) { return !drop[idx]; });
    rng.clearContent();
    if (kept.length > 0) {
      setTextFormat_(sheet, 2, kept.length);
      sheet.getRange(2, 1, kept.length, lastCol).setValues(kept);
    }
  }
  return { duplicates: duplicates, wrongMonth: wrongMonth, total: total };
}

// "-0500" -> -5h in ms (fixed-offset zones like America/Bogota; no DST).
function tzOffsetMs_(d, tz) {
  var z = Utilities.formatDate(d, tz, 'Z');
  var sign = z.charAt(0) === '-' ? -1 : 1;
  return sign * (parseInt(z.substr(1, 2), 10) * 60 + parseInt(z.substr(3, 2), 10)) * 60000;
}

function normalizeWidth_(row) {
  row = row || [];
  if (row.length < HEADERS.length) return row.concat(new Array(HEADERS.length - row.length).fill(''));
  if (row.length > HEADERS.length) return row.slice(0, HEADERS.length);
  return row;
}

function checkToken_(e) {
  var token = PropertiesService.getScriptProperties().getProperty('AUTH_TOKEN');
  return !!token && e && e.parameter && e.parameter.token === token;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run once from the editor to grant the Sheets + Drive scopes and check access.
function debugCheck() {
  listMonthFiles_().forEach(function (f) {
    Logger.log(f.name + ': ' + (f.sheet.getLastRow() - 1) + ' data rows');
  });
}
