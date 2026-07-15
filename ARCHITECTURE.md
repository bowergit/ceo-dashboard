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
| `metrics` | Daniel, manually, via Supabase dashboard | `index.html` Live mode | anon read/write (pre-existing, not tightened) |
| `workouts` | Apps Script `syncCalendarToSupabase()` (anon key) | `index.html` Live mode | **RLS disabled** — flagged, not fixed. Anyone with the anon key can read/write this table. |
| `weights` | iPhone Shortcut, daily 11am (anon key) — see below | `index.html` Live mode | RLS enabled, but has a redundant "anon read = true" policy that defeats its own owner-only policy — same class of gap as `workouts`, flagged, not fixed |
| `lessons` | Daniel, manually | `index.html` Live mode | owner-read only |
| `relationship_events` | Apps Script `syncRelationshipEventsToSupabase()` (**service_role** key) | `index.html` Live mode | **owner-read only, zero public write policy** |
| `timed_gigs` | Apps Script `syncTimedGigsToSupabase()` (**service_role** key) | `index.html` Live mode | **owner-read only, zero public write policy** |

`relationship_events`/`timed_gigs` are the newer pattern (2026-07-15 onward): the sync uses the
Supabase **service_role** key, which bypasses RLS entirely and runs only inside Apps Script
(server-side, never exposed to a browser), so the table itself needs no public write policy at
all — tighter than the anon-key pattern `workouts`/`weights` use. New tables should follow this
pattern, not the older one.

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
| `syncCalendarToSupabase()` | "Exercise" Google Calendar (`e29a920c…@group.calendar.google.com`) | `workouts` table | daily, ~00:30 UTC | anon |
| `syncRelationshipEventsToSupabase()` | "Social" (`family095…@group.calendar.google.com`) + "Aimee" (`c3b2f36d…@group.calendar.google.com`) calendars | `relationship_events` table (wipe + reinsert) | daily, ~06:15 local | service_role |
| `syncTimedGigsToSupabase()` | "Booked Gigs" Google Calendar (`9a7292c0…@group.calendar.google.com`, itself synced from 17hats) | `timed_gigs` table (wipe + reinsert) | daily, ~06:20 local | service_role |

The `SUPABASE_SERVICE_ROLE_KEY` used by the latter two lives in that Apps Script project's
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

- `workouts` table: RLS disabled entirely — anyone with the public anon key can read/write it.
- `weights` table: has RLS enabled, but a redundant `qual: true` "anon read" policy makes its
  more-restrictive owner-only policy moot in practice — same exposure as `workouts`, just via a
  policy bug instead of RLS being off.
- Both are lower priority than they sound, since the anon key is already public in `index.html`
  regardless — the actual risk is someone deliberately probing the API, not something a normal
  dashboard visitor could stumble into.
