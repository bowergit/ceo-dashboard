// Daniel's CEO Dashboard - Google Apps Script calendar sync project.
//
// Bound to the Magic Gigs spreadsheet. This repo copy is documentation/source control;
// the live copy runs in the Google Apps Script editor. If the live script changes,
// paste the same version back here.
//
// Normal use in Apps Script:
//   - Run now: select runAllSyncsNow and click Run.
//   - Install/repair daily trigger: select setupDailyRunAllTrigger and click Run once.
//
// Required Script Property:
//   SUPABASE_SERVICE_ROLE_KEY

var CONFIG = {
  SUPABASE_URL: "https://uilytgubukiinyrqrltj.supabase.co",
  SERVICE_KEY_PROPERTY: "SUPABASE_SERVICE_ROLE_KEY",

  CALENDARS: {
    EXERCISE: "e29a920cea47dd69a4b033d18485ecaa82ade6d76f321b439a60e6325b5d7dc7@group.calendar.google.com",
    SOCIAL: "family09528587924791813696@group.calendar.google.com",
    AIMEE: "c3b2f36de2a14219f9494e244fefca3b95e1e20584e6d613d290b061edb3ebbf@group.calendar.google.com",
    BOOKED_GIGS: "9a7292c0f070e07b6d88fbb5b498fc603c0f02261905097a5f39dbf6d94d8a6d@group.calendar.google.com"
  },

  WORKOUTS: {
    LOOKBACK_DAYS: 90,
    SKIP_TITLE_CONTAINS: ["security volunteer"],
    SYNC_SHEET_ID: "1b-Smzvo1066R2mH4uIZ7nPlNIYscqlU8EarSAhXo2Xw",
    SYNC_SHEET_NAME: "Sync",
    ARCHIVE_SHEET_NAME: "Sync Archive"
  },

  RELATIONSHIPS: {
    PAST_MONTHS: 1,
    FUTURE_MONTHS: 2
  },

  TIMED_GIGS: {
    HORIZON_DAYS: 180
  },

  DAILY_TRIGGER: {
    FUNCTION_NAME: "runAllSyncsNow",
    HOUR: 6,
    NEAR_MINUTE: 10
  }
};

// Keep top-level functions intentionally small. These are the only functions
// you should normally select from the Apps Script Run dropdown.

function runAllSyncsNow() {
  Sync.runAll();
}

function setupDailyRunAllTrigger() {
  Sync.setupDailyTrigger();
}

// Backwards-compatible wrapper for old triggers/bookmarks.
function syncCalendarToSupabase() {
  Sync.syncWorkouts();
}

function syncWorkoutsToSupabase() {
  Sync.syncWorkouts();
}

function syncRelationshipEventsToSupabase() {
  Sync.syncRelationshipEvents();
}

function syncTimedGigsToSupabase() {
  Sync.syncTimedGigs();
}

var Sync = {
  runAll: function() {
    Logger.log("######## runAllSyncsNow: workouts ########");
    Sync.syncWorkouts();

    Logger.log("######## runAllSyncsNow: relationship events ########");
    Sync.syncRelationshipEvents();

    Logger.log("######## runAllSyncsNow: timed gigs for Shabbat/Yom Tov audit ########");
    Sync.syncTimedGigs();

    Logger.log("######## runAllSyncsNow: all syncs complete ########");
  },

  setupDailyTrigger: function() {
    Sync.removeKnownSyncTriggers();

    ScriptApp.newTrigger(CONFIG.DAILY_TRIGGER.FUNCTION_NAME)
      .timeBased()
      .atHour(CONFIG.DAILY_TRIGGER.HOUR)
      .nearMinute(CONFIG.DAILY_TRIGGER.NEAR_MINUTE)
      .everyDays(1)
      .create();

    Logger.log(
      "Installed daily trigger for " +
      CONFIG.DAILY_TRIGGER.FUNCTION_NAME +
      " at about " +
      Sync.pad2(CONFIG.DAILY_TRIGGER.HOUR) +
      ":" +
      Sync.pad2(CONFIG.DAILY_TRIGGER.NEAR_MINUTE)
    );
  },

  // 1) Workouts - Exercise calendar -> public.workouts
  syncWorkouts: function() {
    Logger.log("=== syncWorkoutsToSupabase starting ===");

    var now = new Date();
    var windowStart = Sync.addDays(now, -CONFIG.WORKOUTS.LOOKBACK_DAYS);
    var windowEnd = now;
    var startDate = Sync.dateKey(windowStart);
    var endDate = Sync.dateKey(windowEnd);
    var calendar = Sync.getCalendarOrThrow(CONFIG.CALENDARS.EXERCISE, "Exercise");
    var events = calendar.getEvents(windowStart, windowEnd);
    var rows = [];
    var seen = {};

    events.forEach(function(event) {
      if (event.isAllDayEvent()) return;

      var title = event.getTitle().trim();
      var lower = title.toLowerCase();
      for (var i = 0; i < CONFIG.WORKOUTS.SKIP_TITLE_CONTAINS.length; i++) {
        if (lower.indexOf(CONFIG.WORKOUTS.SKIP_TITLE_CONTAINS[i]) > -1) {
          Logger.log("Skipping workout calendar event: " + title);
          return;
        }
      }

      var row = {
        date: Sync.dateKey(event.getStartTime()),
        type: title
      };
      var key = row.date + "|" + row.type;
      if (!seen[key]) {
        seen[key] = true;
        rows.push(row);
      }
    });

    rows.sort(Sync.sortByDateThenText("date", "type"));

    Sync.deleteRowsInDateWindow("workouts", startDate, endDate);
    Sync.insertRows("workouts", rows);
    Sync.updateWorkoutSyncSheets(rows);

    Logger.log(
      "=== syncWorkoutsToSupabase finished: " +
      rows.length +
      " workout row(s), window " +
      startDate +
      " to " +
      endDate +
      " ==="
    );
  },

  updateWorkoutSyncSheets: function(rows) {
    var ss = SpreadsheetApp.openById(CONFIG.WORKOUTS.SYNC_SHEET_ID);
    Sync.writeWorkoutSheet(ss, CONFIG.WORKOUTS.SYNC_SHEET_NAME, rows);
    Sync.writeWorkoutSheet(ss, CONFIG.WORKOUTS.ARCHIVE_SHEET_NAME, rows);
  },

  writeWorkoutSheet: function(ss, sheetName, rows) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }

    sheet.clearContents();
    sheet.getRange(1, 1, 1, 2).setValues([["date", "event_name"]]);

    if (rows.length === 0) return;

    var sheetRows = rows.map(function(row) {
      return [row.date, row.type];
    });
    sheet.getRange(2, 1, sheetRows.length, 2).setValues(sheetRows);
  },

  // 2) Social + Aimee calendars -> public.relationship_events
  syncRelationshipEvents: function() {
    Logger.log("=== syncRelationshipEventsToSupabase starting ===");

    var now = new Date();
    var windowStart = new Date(
      now.getFullYear(),
      now.getMonth() - CONFIG.RELATIONSHIPS.PAST_MONTHS,
      1
    );
    var windowEnd = new Date(
      now.getFullYear(),
      now.getMonth() + CONFIG.RELATIONSHIPS.FUTURE_MONTHS,
      0,
      23,
      59,
      59
    );

    var rows = [];
    rows = rows.concat(Sync.relationshipRowsFromCalendar(CONFIG.CALENDARS.SOCIAL, "social", windowStart, windowEnd));
    rows = rows.concat(Sync.relationshipRowsFromCalendar(CONFIG.CALENDARS.AIMEE, "aimee", windowStart, windowEnd));
    rows.sort(Sync.sortByDateThenText("date", "title"));

    Sync.wipeTable("relationship_events");
    Sync.insertRows("relationship_events", rows);

    Logger.log(
      "=== syncRelationshipEventsToSupabase finished: " +
      rows.length +
      " row(s), window " +
      Sync.dateKey(windowStart) +
      " to " +
      Sync.dateKey(windowEnd) +
      " ==="
    );
  },

  relationshipRowsFromCalendar: function(calendarId, source, windowStart, windowEnd) {
    var calendar = Sync.getCalendarOrThrow(calendarId, source);
    var events = calendar.getEvents(windowStart, windowEnd);
    var rows = [];

    Logger.log(source + " calendar (" + calendar.getName() + "): " + events.length + " event(s)");

    events.forEach(function(event) {
      rows.push({
        date: Sync.dateKey(event.getStartTime()),
        title: event.getTitle(),
        source: source
      });
    });

    return rows;
  },

  // 3) Timed gigs -> public.timed_gigs
  syncTimedGigs: function() {
    Logger.log("=== syncTimedGigsToSupabase starting ===");

    var now = new Date();
    var horizon = Sync.addDays(now, CONFIG.TIMED_GIGS.HORIZON_DAYS);
    var calendar = Sync.getCalendarOrThrow(CONFIG.CALENDARS.BOOKED_GIGS, "Booked Gigs");
    var events = calendar.getEvents(now, horizon);
    var rows = [];

    Logger.log("Booked Gigs calendar: " + events.length + " event(s) before all-day filter");

    events.forEach(function(event) {
      if (event.isAllDayEvent()) return;

      rows.push({
        date: Sync.dateKey(event.getStartTime()),
        event: Sync.cleanGigTitle(event.getTitle()),
        starts_at: event.getStartTime().toISOString(),
        ends_at: event.getEndTime().toISOString()
      });
    });

    rows.sort(Sync.sortByDateThenText("date", "event"));

    Sync.wipeTable("timed_gigs");
    Sync.insertRows("timed_gigs", rows);

    Logger.log(
      "=== syncTimedGigsToSupabase finished: " +
      rows.length +
      " timed gig row(s), horizon to " +
      Sync.dateKey(horizon) +
      " ==="
    );
  },

  cleanGigTitle: function(title) {
    return String(title || "").split(" • ")[0].trim();
  },

  // Supabase helpers
  getServiceRoleKey: function() {
    var key = PropertiesService
      .getScriptProperties()
      .getProperty(CONFIG.SERVICE_KEY_PROPERTY);

    if (!key) {
      throw new Error("Missing Script Property: " + CONFIG.SERVICE_KEY_PROPERTY);
    }

    return key;
  },

  supabaseHeaders: function() {
    var key = Sync.getServiceRoleKey();
    return {
      "apikey": key,
      "Authorization": "Bearer " + key,
      "Content-Type": "application/json",
      "Prefer": "return=minimal"
    };
  },

  supabaseFetch: function(path, options) {
    var request = {
      method: options.method,
      headers: Sync.supabaseHeaders(),
      muteHttpExceptions: true
    };

    if (options.payload !== undefined) {
      request.payload = options.payload;
    }

    var response = UrlFetchApp.fetch(CONFIG.SUPABASE_URL + path, request);
    var code = response.getResponseCode();
    var body = response.getContentText();
    var ok = code >= 200 && code < 300;

    Logger.log(options.method.toUpperCase() + " " + path + " -> " + code);
    if (!ok) {
      Logger.log(body.slice(0, 1000));
      throw new Error("Supabase request failed: " + code + " " + path);
    }

    return response;
  },

  wipeTable: function(tableName) {
    Sync.supabaseFetch("/rest/v1/" + tableName + "?date=not.is.null", {
      method: "delete"
    });
  },

  deleteRowsInDateWindow: function(tableName, startDate, endDate) {
    Sync.supabaseFetch(
      "/rest/v1/" +
      tableName +
      "?date=gte." +
      encodeURIComponent(startDate) +
      "&date=lte." +
      encodeURIComponent(endDate),
      {method: "delete"}
    );
  },

  insertRows: function(tableName, rows) {
    if (!rows || rows.length === 0) {
      Logger.log("No rows to insert into " + tableName + ".");
      return;
    }

    Sync.supabaseFetch("/rest/v1/" + tableName, {
      method: "post",
      payload: JSON.stringify(rows)
    });
  },

  // Generic helpers
  getCalendarOrThrow: function(calendarId, label) {
    var calendar = CalendarApp.getCalendarById(calendarId);
    if (!calendar) {
      throw new Error("Calendar not found for " + label + ": " + calendarId);
    }
    return calendar;
  },

  removeKnownSyncTriggers: function() {
    var knownHandlers = {
      runAllSyncsNow: true,
      syncCalendarToSupabase: true,
      syncWorkoutsToSupabase: true,
      syncRelationshipEventsToSupabase: true,
      syncTimedGigsToSupabase: true
    };

    var triggers = ScriptApp.getProjectTriggers();
    var removed = 0;

    triggers.forEach(function(trigger) {
      if (knownHandlers[trigger.getHandlerFunction()]) {
        ScriptApp.deleteTrigger(trigger);
        removed++;
      }
    });

    Logger.log("Removed " + removed + " existing sync trigger(s).");
  },

  dateKey: function(date) {
    return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
  },

  addDays: function(date, days) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
  },

  pad2: function(value) {
    return String(value < 10 ? "0" + value : value);
  },

  sortByDateThenText: function(dateField, textField) {
    return function(a, b) {
      if (a[dateField] !== b[dateField]) {
        return a[dateField] < b[dateField] ? -1 : 1;
      }
      var aText = String(a[textField] || "");
      var bText = String(b[textField] || "");
      if (aText === bText) return 0;
      return aText < bText ? -1 : 1;
    };
  }
};
