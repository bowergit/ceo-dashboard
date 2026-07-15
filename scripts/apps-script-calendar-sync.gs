// Daniel's CEO Dashboard — Google Apps Script sync project ("Calendar to sheet")
// Bound to the Magic Gigs spreadsheet. This is a COPY kept for reference — the live version
// runs in the Apps Script editor, not here. If you change the live script, paste the new
// version here too. See ../ARCHITECTURE.md for what feeds what and why.
//
// Three independent sync functions, one shared pattern: read a Google Calendar, write the
// result into a Supabase table, wipe-and-reinsert (or diff-and-delete for workouts) so Supabase
// always matches whatever's currently on the calendar. Each has its own daily time trigger.

// ============================================================
// 1) Workouts — Exercise calendar -> public.workouts (anon key, diff + delete tracking)
// ============================================================

function syncCalendarToSupabase() {
  var CALENDAR_ID = "e29a920cea47dd69a4b033d18485ecaa82ade6d76f321b439a60e6325b5d7dc7@group.calendar.google.com";
  var SUPABASE_URL = "https://uilytgubukiinyrqrltj.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_WK5p8tUAsNLEqnmxVT7Eag_2EVNbi7V";
  var SYNC_SHEET_ID = "1b-Smzvo1066R2mH4uIZ7nPlNIYscqlU8EarSAhXo2Xw";
  var SYNC_SHEET_NAME = "Sync";
  var ARCHIVE_SHEET_NAME = "Sync Archive";

  var now = new Date();
  var monthAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  var calendar = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!calendar) {
    Logger.log("Calendar not found");
    return;
  }

  var events = calendar.getEvents(monthAgo, now);
  var currentEvents = [];

  events.forEach(function(event) {
    if (!event.isAllDayEvent()) {
      var eventTitle = event.getTitle();
      if (eventTitle.toLowerCase().indexOf("security volunteer") > -1) {
        Logger.log("Skipping: " + eventTitle);
        return;
      }
      var eventDate = Utilities.formatDate(event.getStartTime(), Session.getScriptTimeZone(), "yyyy-MM-dd");
      currentEvents.push({date: eventDate, type: eventTitle});
    }
  });

  var ss = SpreadsheetApp.openById(SYNC_SHEET_ID);
  var archiveSheet = ss.getSheetByName(ARCHIVE_SHEET_NAME);
  if (!archiveSheet) {
    archiveSheet = ss.insertSheet(ARCHIVE_SHEET_NAME);
    archiveSheet.appendRow(["date", "event_name"]);
  }

  var archiveData = archiveSheet.getDataRange().getValues();
  var previousEvents = [];
  for (var i = 1; i < archiveData.length; i++) {
    if (archiveData[i][0] && archiveData[i][1]) {
      var dateVal = archiveData[i][0];
      var dateStr = "";
      if (typeof dateVal === "object" && dateVal instanceof Date) {
        dateStr = Utilities.formatDate(dateVal, Session.getScriptTimeZone(), "yyyy-MM-dd");
      } else {
        dateStr = String(dateVal).split(" ")[0];
      }
      previousEvents.push({date: dateStr, type: String(archiveData[i][1])});
    }
  }

  var deleted = [];
  previousEvents.forEach(function(prev) {
    var inWindow = new Date(prev.date) >= monthAgo && new Date(prev.date) <= now;
    if (!inWindow) return;
    var found = currentEvents.some(function(curr) {
      return curr.date === prev.date && curr.type === prev.type;
    });
    if (!found) {
      deleted.push(prev);
    }
  });

  if (deleted.length > 0) {
    var deletedCount = deleteWorkoutsFromSupabase(deleted, SUPABASE_URL, SUPABASE_ANON_KEY);
    Logger.log("Deleted " + deletedCount + " workouts from Supabase");
  }

  if (currentEvents.length > 0) {
    var insertedCount = insertWorkoutsToSupabase(currentEvents, SUPABASE_URL, SUPABASE_ANON_KEY);
    Logger.log("Inserted " + insertedCount + " new workouts");
  }

  updateSyncSheet(currentEvents, ss, SYNC_SHEET_NAME);
  updateSyncSheet(currentEvents, ss, ARCHIVE_SHEET_NAME);

  Logger.log("Sync complete. Current: " + currentEvents.length + ", Deleted: " + deleted.length);
}

function deleteWorkoutsFromSupabase(events, supabaseUrl, anonKey) {
  var deleted = 0;
  events.forEach(function(event) {
    try {
      var encodedType = encodeURIComponent(event.type);
      var url = supabaseUrl + "/rest/v1/workouts?date=eq." + event.date + "&type=eq." + encodedType;
      var res = UrlFetchApp.fetch(url, {
        method: "delete",
        headers: {
          "apikey": anonKey,
          "Authorization": "Bearer " + anonKey,
          "Content-Type": "application/json"
        },
        muteHttpExceptions: true
      });
      if (res.getResponseCode() === 200 || res.getResponseCode() === 204) {
        deleted++;
        Logger.log("Deleted: " + event.date + " " + event.type);
      } else {
        Logger.log("Delete response " + res.getResponseCode() + ": " + res.getContentText());
      }
    } catch (e) {
      Logger.log("Error deleting: " + e.toString());
    }
  });
  return deleted;
}

function insertWorkoutsToSupabase(rows, supabaseUrl, anonKey) {
  var inserted = 0;
  var skipped = 0;

  rows.forEach(function(row) {
    try {
      var url = supabaseUrl + "/rest/v1/workouts";
      var payload = JSON.stringify([row]);

      var res = UrlFetchApp.fetch(url, {
        method: "post",
        headers: {
          "apikey": anonKey,
          "Authorization": "Bearer " + anonKey,
          "Content-Type": "application/json"
        },
        payload: payload,
        muteHttpExceptions: true
      });

      if (res.getResponseCode() === 201) {
        inserted++;
      } else {
        var respText = res.getContentText();
        try {
          var respJson = JSON.parse(respText);
          if (respJson.code === "23505") {
            skipped++;
          } else {
            Logger.log("Error: " + respText);
          }
        } catch (e) {
          Logger.log("Error parsing response: " + respText);
        }
      }
    } catch (e) {
      Logger.log("Error inserting: " + e.toString());
    }
  });

  Logger.log("Inserted " + inserted + " new, skipped " + skipped + " duplicates");
  return inserted;
}

function updateSyncSheet(rows, ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(["date", "event_name"]);
  }

  if (sheet.getLastRow() > 1) {
    sheet.deleteRows(2, sheet.getLastRow() - 1);
  }

  if (rows.length > 0) {
    var sheetRows = rows.map(function(r) { return [r.date, r.type]; });
    sheetRows.sort(function(a, b) { return new Date(b[0]) - new Date(a[0]); });
    sheet.getRange(2, 1, sheetRows.length, 2).setValues(sheetRows);
  }
}

function setupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "syncCalendarToSupabase") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger("syncCalendarToSupabase")
    .timeBased()
    .atHour(0)
    .nearMinute(30)
    .everyDays(1)
    .create();

  Logger.log("Trigger set up for daily 00:30 UTC");
}

// ============================================================
// 2) Social & Aimee events -> public.relationship_events (service_role key, wipe + reinsert)
// ============================================================

function syncRelationshipEventsToSupabase() {
  var SUPABASE_URL = "https://uilytgubukiinyrqrltj.supabase.co";
  var SERVICE_KEY = PropertiesService.getScriptProperties().getProperty("SUPABASE_SERVICE_ROLE_KEY");
  var SOCIAL_CAL_ID = "family09528587924791813696@group.calendar.google.com";
  var AIMEE_CAL_ID = "c3b2f36de2a14219f9494e244fefca3b95e1e20584e6d613d290b061edb3ebbf@group.calendar.google.com";
  Logger.log("=== syncRelationshipEventsToSupabase starting ===");
  if (!SERVICE_KEY) { Logger.log("ABORT: Missing SUPABASE_SERVICE_ROLE_KEY script property."); return; }
  Logger.log("Service key present, length " + SERVICE_KEY.length);

  var now = new Date();
  var windowStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var windowEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  Logger.log("Window: " + windowStart + " to " + windowEnd);

  var rows = [];
  function pullCalendar(calId, source) {
    var cal = CalendarApp.getCalendarById(calId);
    if (!cal) { Logger.log("ABORT: calendar not found for " + source + ": " + calId); return; }
    var events = cal.getEvents(windowStart, windowEnd);
    Logger.log(source + " calendar (" + cal.getName() + "): " + events.length + " events in window");
    events.forEach(function(e) {
      rows.push({ date: Utilities.formatDate(e.getStartTime(), Session.getScriptTimeZone(), "yyyy-MM-dd"), title: e.getTitle(), source: source });
    });
  }
  pullCalendar(SOCIAL_CAL_ID, "social");
  pullCalendar(AIMEE_CAL_ID, "aimee");
  Logger.log("Total rows to write: " + rows.length);

  var headers = { "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY, "Content-Type": "application/json" };
  var delRes = UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/relationship_events?id=not.is.null", { method: "delete", headers: headers, muteHttpExceptions: true });
  Logger.log("Delete existing rows: " + delRes.getResponseCode() + " " + delRes.getContentText());

  if (rows.length > 0) {
    var res = UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/relationship_events", { method: "post", headers: headers, payload: JSON.stringify(rows), muteHttpExceptions: true });
    Logger.log("Insert " + rows.length + " rows: " + res.getResponseCode() + " " + res.getContentText().slice(0, 500));
  } else {
    Logger.log("No rows to insert.");
  }
  Logger.log("=== syncRelationshipEventsToSupabase finished ===");
}

function setupRelationshipEventsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction() === "syncRelationshipEventsToSupabase") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("syncRelationshipEventsToSupabase").timeBased().atHour(6).nearMinute(15).everyDays(1).create();
  Logger.log("Trigger installed.");
}

// ============================================================
// 3) Timed gigs (for Shabbat audit) -> public.timed_gigs (service_role key, wipe + reinsert)
// ============================================================

function syncTimedGigsToSupabase() {
  var SUPABASE_URL = "https://uilytgubukiinyrqrltj.supabase.co";
  var SERVICE_KEY = PropertiesService.getScriptProperties().getProperty("SUPABASE_SERVICE_ROLE_KEY");
  var BOOKED_GIGS_CAL_ID = "9a7292c0f070e07b6d88fbb5b498fc603c0f02261905097a5f39dbf6d94d8a6d@group.calendar.google.com";
  Logger.log("=== syncTimedGigsToSupabase starting ===");
  if (!SERVICE_KEY) { Logger.log("ABORT: Missing SUPABASE_SERVICE_ROLE_KEY script property."); return; }
  var cal = CalendarApp.getCalendarById(BOOKED_GIGS_CAL_ID);
  if (!cal) { Logger.log("ABORT: Booked Gigs calendar not found."); return; }

  var now = new Date();
  var horizon = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
  var allEvents = cal.getEvents(now, horizon);
  Logger.log("Booked Gigs calendar: " + allEvents.length + " events in next 180 days (before all-day filter)");

  var rows = [];
  allEvents.forEach(function(e) {
    if (e.isAllDayEvent()) return;
    rows.push({
      date: Utilities.formatDate(e.getStartTime(), Session.getScriptTimeZone(), "yyyy-MM-dd"),
      event: e.getTitle().split(" • ")[0].trim(),
      starts_at: e.getStartTime().toISOString(),
      ends_at: e.getEndTime().toISOString()
    });
  });
  Logger.log("Total timed rows to write: " + rows.length);

  var headers = { "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY, "Content-Type": "application/json" };
  var delRes = UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/timed_gigs?id=not.is.null", { method: "delete", headers: headers, muteHttpExceptions: true });
  Logger.log("Delete existing rows: " + delRes.getResponseCode() + " " + delRes.getContentText());

  if (rows.length > 0) {
    var res = UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/timed_gigs", { method: "post", headers: headers, payload: JSON.stringify(rows), muteHttpExceptions: true });
    Logger.log("Insert " + rows.length + " rows: " + res.getResponseCode() + " " + res.getContentText().slice(0, 500));
  } else {
    Logger.log("No rows to insert.");
  }
  Logger.log("=== syncTimedGigsToSupabase finished ===");
}

function setupTimedGigsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction() === "syncTimedGigsToSupabase") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("syncTimedGigsToSupabase").timeBased().atHour(6).nearMinute(20).everyDays(1).create();
  Logger.log("Trigger installed.");
}

// ============================================================
// One-time trigger cleanup (used once, 2026-07-15, to clear a stale trigger left over from
// before this script's main function was renamed from syncCalendarToSheet). Safe to keep.
// ============================================================

function fixTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("syncCalendarToSupabase")
    .timeBased()
    .atHour(0)
    .nearMinute(30)
    .everyDays(1)
    .create();
  Logger.log("Cleared " + triggers.length + " old trigger(s). New trigger installed for syncCalendarToSupabase.");
}
