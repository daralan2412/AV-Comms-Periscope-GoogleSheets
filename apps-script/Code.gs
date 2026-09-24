/**
 * AV-Comms-Periscope-GoogleSheets - Apps Script Web App
 *
 * NEW, INDEPENDENT PROJECT. Shares nothing (Script Properties, deployment,
 * sheet) with the FedEx, Copa or PTY wheelchair pipelines.
 *
 * Source:  Sisense/Periscope shared report "Springshot Comms Counts" (Avianca BOG)
 *          https://app.periscopedata.com/shared/ecc51857-da20-40f2-8917-3c2b68fd34e8
 * Target:  spreadsheet "2026_AV_Comms" (SPREADSHEET_ID), tab "Data", 8 columns
 *          (HEADERS). Column A = team_mission_comment_id = the dedupe key.
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

var SPREADSHEET_ID = '1Nd_-ux8WkyifEXbxuTBoyUNL0E-wRbJ5JorgTDfza-0';
var SHEET_NAME = 'Data';
var ID_COL = 1;                    // column A = team_mission_comment_id
var TEXT_COLS = [4, 5, 6, 8];      // owner, job_type, comment, metadata
var HEADERS = [
  'team_mission_comment_id', 'inbound_number', 'outbound_number', 'owner',
  'job_type', 'comment', 'created_date', 'metadata'
];

function doGet(e) {
  if (!checkToken_(e)) return jsonOut_({ success: false, error: 'unauthorized' });
  try {
    var sheet = getSheet_();
    if ((e.parameter.action || '') === 'rebuild') {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(120000)) return jsonOut_({ success: false, error: 'another upload is in progress (lock timeout)' });
      try {
        return jsonOut_({ success: true, action: 'rebuild', result: dedupeSheet_(sheet) });
      } finally {
        lock.releaseLock();
      }
    }
    return jsonOut_({ success: true, message: 'ok', sheet: sheet.getParent().getName() + ' / ' + sheet.getName(),
                      rows: Math.max(sheet.getLastRow() - 1, 0) });
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
    var sheet = getSheet_();
    var u = upsertRows_(sheet, rows);
    var d = dedupeSheet_(sheet);
    return jsonOut_({
      success: true,
      rows_received: rows.length,
      rows_updated: u.updated,
      rows_appended: u.appended,
      duplicates_removed: d.duplicates,
      total_rows: d.total
    });
  } catch (err) {
    return jsonOut_({ success: false, error: 'doPost failed: ' + err });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------

function getSheet_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('tab "' + SHEET_NAME + '" not found');
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
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

  // In-place updates: the CSV export is not guaranteed to come back in the
  // same order as the rows were appended, so instead of one setValues() per
  // row, read the smallest block that spans every row to update, patch it
  // in memory and write it back once. For D-1..D0 that block is the last
  // ~30k rows of the tab.
  var rowNums = Object.keys(updates).map(Number);
  var updated = rowNums.length;
  if (updated > 0) {
    var lo = Math.min.apply(null, rowNums), hi = Math.max.apply(null, rowNums);
    var span = sheet.getRange(lo, 1, hi - lo + 1, HEADERS.length);
    var data = span.getValues();
    rowNums.forEach(function (r) { data[r - lo] = updates[r]; });
    setTextFormat_(sheet, lo, hi - lo + 1);
    span.setValues(data);
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

// Reads column A only. Returns without writing when there is nothing to do
// (the normal case, since doPost upserts).
function dedupeSheet_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { duplicates: 0, total: 0 };
  var ids = sheet.getRange(2, ID_COL, lastRow - 1, 1).getValues();

  var lastIndexById = {};
  for (var j = 0; j < ids.length; j++) {
    var id = String(ids[j][0]).trim();
    if (id) lastIndexById[id] = j;
  }
  var toDelete = [];
  for (var i = 0; i < ids.length; i++) {
    var idI = String(ids[i][0]).trim();
    if (idI && lastIndexById[idI] !== i) toDelete.push(i);
  }
  var total = ids.length - toDelete.length;
  if (toDelete.length === 0) return { duplicates: 0, total: total };

  var blocks = [];
  for (var k = 0; k < toDelete.length; k++) {
    if (blocks.length && toDelete[k] === blocks[blocks.length - 1].end + 1) {
      blocks[blocks.length - 1].end = toDelete[k];
    } else {
      blocks.push({ start: toDelete[k], end: toDelete[k] });
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
  return { duplicates: toDelete.length, total: total };
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

// Run once from the editor to grant the Sheets scope and check access.
function debugCheck() {
  var sheet = getSheet_();
  Logger.log(sheet.getParent().getName() + ' / ' + sheet.getName() + ': ' + (sheet.getLastRow() - 1) +
             ' data rows, header: ' + sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0].join(', '));
}
