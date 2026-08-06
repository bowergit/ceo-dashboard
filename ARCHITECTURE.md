# CEO Dashboard — infrastructure map

This repo (`bowergit/ceo-dashboard`) is one file, `index.html`, served by GitHub Pages. It has
**zero data of its own** — everything it shows is fetched live, at page-load time, from other
systems. This document exists because most of those other systems (Supabase tables, Google Apps
Script projects, an iPhone Shortcut) live *outside* this repo, invisible to anyone — human or AI —
who only reads `index.html`. If you're an AI picking this project up cold: read this file before
touching `index.html`, and re-read it fresh each session — it can go stale the same way code can.

## The shape of it

```
Google Calendar ──┐
Google Sheets   ──┼─→ Google Apps Script (server-side, runs on Google's infra) ──→ Supabase
iPhone Shortcut ──┘                                                                    │
                                                                                        │
Google Sheets (published CSV) ─────────────────────────────────────────→ index.html ←──┘
                                                                          (GitHub Pages)
```

Two independent ingestion paths feed the dashboard:

1. **Public, anonymized, no login needed** — the magic-gig turnover numbers. Sourced from a
   Google Sheet published as CSV, fetched directly by the browser. No names, no server, no auth.
2. **Private, behind Supabase login** — everything else (health, tutoring, Social/Aimee,
   Shabbat protection). Populated by Google Apps Script running on a daily trigger, read by the
   dashboard only after the user signs in with Supabase auth (`danielbowermagic@gmail.com`).

Nothing about credentials below is a secret in itself (the anon/publishable key is *meant* to be
public — see below) except the Supabase **service_role** key, which lives only in Apps Script
Script Properties, never in this repo or in `index.html`.

## Path 1 — Magic gig turnover (public, no login)

| Step | What | Where |
|---|---|---|
| Source | "Magic Gigs" Google Sheet, `Gigs` tab — the real data, full details (client names, fees, etc.) | Google Sheets, id `1v6yFnthaTIu51XK7VPsr_p8gfBJgiR1eJaRTpQhYGkk` |
| Trim | `Feed` tab in the same sheet — one `FILTER()` formula pulling only `Event, Booked date, Event date, Fee, Type` (no client names, no remainder date) | Same spreadsheet |
| Publish | `Feed` tab is **File → Share → Publish to web** as CSV | Google's own public URL |
| Fetch | `index.html`'s `getGigs()` fetches that CSV directly from the browser, on every page load, with one retry on failure | Client-side JS in `index.html` |
| Compute | `magicFromGigs()` derives turnover-this-month, YoY, booked-this-week, upcoming list — all computed in the browser, nothing pre-aggregated | Client-side JS |

Feed CSV URL is hardcoded in `index.html` as `GIGS_CSV_URL`. If the Feed tab's *columns* ever
change, `getGigs()`'s CSV column parsing (`r[0]`, `r[1]`, …) must be updated to match.

**Why it's public:** so the browser can fetch it with zero authentication and zero server. The
trade-off is deliberate — trimmed to remove anything identifying, so a public CSV is an acceptable
risk. Do not add client names or contact details back into the `Feed` tab.

## Path 2 — Everything else (private, Supabase-gated)

Supabase project id: `uilytgubukiinyrqrltj`. Table: `public.metrics` holds one row of
targets/config (survival income line, workout targets, social/Aimee targets, etc.) — everything
else is one table per data domain, mirroring how `workouts` already worked (raw rows, dashboard
computes stats client-side — no table stores a pre-aggregated count).

| Table | Written by | Read by | RLS |
|---|---|---|---|
| `metrics` | Daniel, manually, via Supabase dashboard | `index.html` Live mode | SELECT restricted to the two-account allowlist below. No anon/public policy exists — this table's row is only ever read by an owner session; writes happen via the Supabase dashboard directly (project-owner context, outside RLS), never through the app. (An earlier version of this doc said "anon read/write" here — that was never actually true against the live policy set; corrected 2026-08-06.) |
| `workouts` | Apps Script `syncWorkoutsToSupabase()` / legacy wrapper `syncCalendarToSupabase()` (**service_role** key) | `index.html` Live mode | **Fixed 2026-08-06** (was: RLS disabled entirely — anyone with the anon key could read/write it). RLS now on, SELECT restricted to the two-account allowlist. The vestigial `anon insert` policy was dropped too — the real writer uses service_role, which bypasses RLS regardless, so no app ever needed anon insert on this table. |
| `workouts.status` | text, default `'completed'`, check `in ('scheduled','completed')` (added 2026-07-27) — the sync window now also covers today through Saturday of the *current* week (still `LOOKBACK_DAYS` back for the past), which is the part that actually matters: without it, nothing not-yet-happened was in the table at all. **The dashboard does not read this column.** It derives done-vs-planned purely from the date: a session counts as done only once its day has fully passed. `status` is stamped from the event's start time, so a 7am session flips to `'completed'` at 7am whether or not Daniel actually trained — which had the dashboard telling him he'd done workouts he hadn't (2026-07-29). The date rule can't make that mistake. Column is kept because it's accurate metadata about the sync, not because anything depends on it. | |
| `weights` | iPhone Shortcut, daily 11am (anon key) — see below | `index.html` Live mode | **Fixed 2026-08-06** (was: a redundant `qual: true` anon-read policy meant literally anyone with the public anon key — no login at all — could read every weight entry). That policy is dropped; SELECT is now restricted to the two-account allowlist. Anon INSERT/UPDATE are unchanged and still fully open (`qual: true`) — the Shortcut has no other credential, so this is a deliberate, known trade-off: anyone with the anon key can still *write* a row (or overwrite an existing date), just not *read* the table. Tightening writes further (e.g. a shared secret in the request) would need a Shortcut change too; flagged, not done. |
| `tutoring_lessons`, `tutoring_students`, `tutoring_rate_history` | [`bowergit/tutoring`](https://github.com/bowergit/tutoring) app | `index.html` Live mode | Tenant-isolated (`owner_id = auth.uid()`, policy `tenant_rw`, covers SELECT/INSERT/UPDATE/DELETE) — this is the tutoring app's real multi-tenant model for its actual other users, not a Daniel-only gate, and the CEO dashboard security pass (2026-08-06) deliberately left it alone. What protects Daniel's tutoring data from another tutoring-app tenant *inside the CEO dashboard* isn't this policy — it's the dashboard's own login gate never running any query at all unless the session is one of the two allowlisted accounts. (This doc previously said "public read with anon key as of 2026-07-15" — stale; corrected 2026-08-06 to match the live policy.) |
| `relationship_events` | Apps Script `syncRelationshipEventsToSupabase()` (**service_role** key) | `index.html` Live mode | SELECT restricted to the two-account allowlist (was a single hardcoded email — widened 2026-08-06 to cover both of Daniel's accounts). Zero public write policy. |
| `timed_gigs` | Apps Script `syncTimedGigsToSupabase()` (**service_role** key) | `index.html` Live mode | SELECT restricted to the two-account allowlist (was a single hardcoded email — widened 2026-08-06 to cover both of Daniel's accounts). Zero public write policy. |

`relationship_events`/`timed_gigs` are the newer pattern (2026-07-15 onward): the sync uses the
Supabase **service_role** key, which bypasses RLS entirely and runs only inside Apps Script
(server-side, never exposed to a browser), so the table itself needs no public write policy at
all — tighter than the anon-key pattern `workouts`/`weights` use. New tables should follow this
pattern, not the older one.

Maths/tutoring data is not sourced from the old `lessons` table. The live dashboard reads the
same tables used by [`bowergit/tutoring`](https://github.com/bowergit/tutoring): lesson rows from
`tutoring_lessons`, student names from `tutoring_students`, and fallback/effective prices from
`tutoring_rate_history` when a lesson row has no `rate_charged`. The CEO dashboard computes
monthly done/planned counts and projected value client-side from those raw rows.

Revenue trajectory is also computed client-side. Magic projects current-year actuals forward using
weighted months, with November and December deliberately heavier for the Christmas season. Maths
projects each visible student as `rate * 40 lessons/year`, scaled from the student's first logged or
scheduled lesson in the year, so future-starting students only count from when they appear.

### Access control — hard allowlist, not "authenticated"

This Supabase project ("Bower OS", `uilytgubukiinyrqrltj`) is shared across more than one of
Daniel's apps — the tutoring CRM ([`bowergit/tutoring`](https://github.com/bowergit/tutoring)) uses
it too, and has its own real users signing up for their own accounts on the same project. That
means **a valid Supabase session on this project is not the same thing as "is Daniel"** — anyone
with a real account on *any* app sharing this project can authenticate against it. Before
2026-08-06, `index.html`'s Live-mode gate was exactly `if(!session)`, i.e. "is there a session at
all" — any of those accounts would pass. Combined with `workouts` having RLS off entirely and
`weights` having a wide-open anon-read policy, this meant another tenant's Supabase account could
log into the CEO dashboard and actually see Daniel's real workout/weight data rendered.

Fixed the same way in both places it needed fixing, kept in sync by hand (nothing enforces that
automatically, so if either changes the other needs re-checking):

- **App-level** (`index.html`): a hard `ALLOWED_USER_IDS` allowlist of exactly two Supabase user
  ids, checked once, in the one place `loadLive()` is about to fetch anything. Anything else —
  including a genuinely valid session on this project — is signed out immediately (not just
  redirected to the login screen while still holding an active foreign session) and shown "That
  account isn't authorised for this dashboard."
- **RLS-level**: SELECT on `metrics`, `workouts`, `weights`, `relationship_events`, `timed_gigs` is
  restricted to `auth.uid() IN (...)` against the same two ids. This is what actually matters —
  the app-level check alone would stop a browser hitting this specific page, but does nothing
  against someone calling the Supabase REST API directly with their own valid token.

The two allowlisted ids (also in `index.html` and in the migration that set these policies):

| Account | Supabase user id |
|---|---|
| `danielbowermagic@gmail.com` | `babb06b5-b5e0-4436-8b72-bc5556814956` |
| `daniel.b.bower@gmail.com` | `80ee6bad-92f7-4536-8db2-9c645d24f4b1` |

**Do not add a broader path in alongside this allowlist** — no `authenticated OR is-owner`, no
"admin" flag, no second policy on these tables that grants access some other way. A second,
looser path in is the exact bug class this exists to rule out (and is what caused a real cross-
tenant data leak in the tutoring app, independently found and fixed the same day this was written).
If you need to grant a new person access to the CEO dashboard specifically, add their id to both
`ALLOWED_USER_IDS` in `index.html` and every `auth.uid() IN (...)` policy above — don't reach for
`is_app_owner()`. That function exists in this project (used by the tutoring app previously) but
is now a permanent no-op (`SELECT false`) specifically so it can't be silently reintroduced into a
policy — leave it that way.

`tutoring_lessons`/`tutoring_students`/`tutoring_rate_history` are the one deliberate exception:
they stay on the tutoring app's own `owner_id = auth.uid()` tenant-isolation policy, not this
allowlist, because that policy is what lets the tutoring app's *other* real users see their own
data — it's a different app's actual multi-tenant model, not a hole in this one. What protects
Daniel's tutoring data from another tenant *inside the CEO dashboard specifically* is that the
dashboard's login gate refuses to run any query at all unless the session is on the allowlist —
so another tenant's session never reaches these tables from this app, even though RLS itself would
technically let them read rows they own.

### iPhone Shortcut — weight data

Runs once daily at 11am via an iOS **Personal Automation** ("Run Immediately", not a manual tap).
Uses the third-party **Health Auto Export** app to pull the last 7 days of body-weight data out of
Apple Health as JSON. The Shortcut parses that JSON, loops over each record, extracts `date` +
`qty` (kg), trims the date to `YYYY-MM-DD`, and sends each reading as its own request:

```
POST {SUPABASE_URL}/rest/v1/weights?on_conflict=date
Headers:
  apikey: <supabase publishable/anon key>
  Authorization: Bearer <supabase publishable/anon key>
  Prefer: resolution=merge-duplicates,return=representation
Body: {"date": "YYYY-MM-DD", "kg": <number>}
```

- **Auth:** the Supabase publishable (anon) key — the same one that's already public in
  `index.html`, nothing more sensitive than that.
- **Upsert, not insert:** `on_conflict=date` + `resolution=merge-duplicates` means re-running
  never creates a duplicate row for a date already logged; it overwrites that date's value.
  This depends on a **unique index on `weights.date`** (`weights_date_unique`, confirmed present
  via `pg_indexes` — it's a standalone `CREATE UNIQUE INDEX`, not a formal table constraint, so
  it won't show up in a `pg_constraint`/`\d weights` listing, only in `pg_indexes`). Without that
  index the upsert would fail outright — Postgres requires a matching unique index for
  `ON CONFLICT` to target. Don't drop or rename it without updating the Shortcut.
- **Self-healing by design:** always re-exports the trailing 7 days, not just "today" — so a
  missed automation run, a phone that was off, or a gap in Health data backfills automatically
  on the next successful run, no manual catch-up needed.

### Google Apps Script — "Calendar to sheet" project

One Apps Script project (bound to the Magic Gigs spreadsheet, confirmed — as of 2026-07-15 — to be
the *only* Apps Script project in this system) contains all three sync functions below. A copy of
its source lives in this repo at [`scripts/apps-script-calendar-sync.gs`](scripts/apps-script-calendar-sync.gs)
— kept manually in sync; if you change the live script, paste the new version there too so an AI
reading this repo cold can see what's actually running without opening the Apps Script editor.

| Function | Reads | Writes | Trigger | Key used |
|---|---|---|---|---|
| `syncWorkoutsToSupabase()` | "Exercise" Google Calendar (`e29a920c…@group.calendar.google.com`) | `workouts` table | called by `runAllSyncsNow()` | service_role |
| `syncRelationshipEventsToSupabase()` | "Social" (`family095…@group.calendar.google.com`) + "Aimee" (`c3b2f36d…@group.calendar.google.com`) calendars | `relationship_events` table (wipe + reinsert) | called by `runAllSyncsNow()` | service_role |
| `syncTimedGigsToSupabase()` | "Booked Gigs" Google Calendar (`9a7292c0…@group.calendar.google.com`, itself synced from 17hats) | `timed_gigs` table (wipe + reinsert) | called by `runAllSyncsNow()` | service_role |

The daily Apps Script trigger should call **`runAllSyncsNow()`** only. To install or repair that
trigger, select **`setupDailyRunAllTrigger()`** in the Apps Script function dropdown and click Run
once. To force a refresh right now, select **`runAllSyncsNow()`** and click Run. That function runs
all three syncs in sequence with a clear header logged before each, so there's one unambiguous
thing to select when you want data now rather than at the next trigger.

The `SUPABASE_SERVICE_ROLE_KEY` used by Apps Script lives in that Apps Script project's
**Script Properties** (Project Settings → Script Properties) — never hardcoded in the script body,
never in this repo.

## Reliability note

Google Apps Script time-based triggers run on Google's own infrastructure — they fire reliably
regardless of whether any app is open on Daniel's machine. This is *not* true of Claude's own
`mcp__scheduled-tasks__*` mechanism, which only fires while the Claude app happens to be open at
trigger time and does not queue missed runs (confirmed by failure on 2026-07-13 through 15, when a
Claude-side sync silently went stale for two days). **Prefer Apps Script for anything that must
run unattended and reliably.**

## Editing the Magic Gigs sheet without Zapier

Zapier's Google Sheets connector was used twice, early on, to create the `Feed` tab and write its
`FILTER` formula — a one-off setup action, not part of the ongoing pipeline. Nothing in the live
system depends on Zapier today. If the sheet needs editing again in the future, prefer writing a
short Apps Script snippet (run manually once, same as the sync functions above) over reaching for
Zapier, to avoid burning Daniel's Zapier task quota on what's normally a one-off action.

## Known gaps (flagged, not yet fixed)

- `weights` table: anon INSERT/UPDATE are still fully open (`qual: true`, no restriction) — the
  iPhone Shortcut has no other credential to write with, so this is a deliberate trade-off, not an
  oversight. Anyone with the public anon key can still write a row or overwrite an existing date's
  value; they just can't *read* the table any more (fixed 2026-08-06 — see "Access control" above).
  Tightening writes further would need a Shortcut change (e.g. a shared secret in the request) and
  hasn't been done.
- 2026-08-06 fixed: the two issues previously listed here (`workouts` RLS fully disabled;
  `weights`' redundant anon-read policy) — see "Access control" above for what changed and why.
