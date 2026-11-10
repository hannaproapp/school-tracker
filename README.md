# School Tracker

Daily homework (Google Classroom) and grades (Blackbaud) per kid, with a two-week plan,
submitted/missing status, a grade scorecard, and alerts for anything below an A.

## Adding a kid
1. Add an entry to `kids.json` (`id` is lowercase and used everywhere below). Push; Railway redeploys.
2. Open `/setup` on the dashboard and follow it for the new kid:
   - **Grades:** install Tampermonkey in the Chrome where the kid is signed into Blackbaud, then open the install link on `/setup`. The userscript syncs grades to `/ingest/<id>` whenever the kid has Blackbaud open (at most every 3 hours).
   - **Blackbaud homework:** paste the kid's Assignment Center calendar-feed (iCal) link. The server reads it on every run; no sign-in needed.
3. Open `/kid/<id>` on the dashboard and click **Connect Google account**; the kid signs in and approves.

`collector.js` is the same grade collection as a one-off script you can paste into a signed-in Blackbaud tab's console.

Each kid has their own Google token, Blackbaud login, state file, alert log, and dashboard page (`/kid/<id>`).
`alertEmails` per kid overrides `PARENT_EMAILS`; the kid's own `email` is always copied.

## Railway variables
| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client for the Classroom API |
| `SMTP_USER`, `SMTP_PASS` | Gmail address and app password used to send alerts |
| `PARENT_EMAILS` | Comma-separated alert recipients |
| `NTFY_TOPIC` | Phone push topic (ntfy app) |
| `DASHBOARD_KEY` | Append `?key=...` once to open the dashboard |
| `A_THRESHOLD` | Alert below this percent (default 93) |
| `GRADE_STALE_HOURS` | Alert when no grade sync arrives for this long (default 48) |
| `<ID>_BB_ICAL` | Optional: a kid's Blackbaud assignment feed link (otherwise set on `/setup`) |
| `RUN_CRON` | Schedule in ET (default 6am, 3pm, 8pm) |

## Daily emails and alerts (per kid, to `alertEmails`/`PARENT_EMAILS` plus the kid)
- 6am: two-week homework plan and missing work.
- 4pm Eastern: everything due the next school day (Fri/Sat look ahead through Monday) with turned-in status.
- 8pm: alert (email + phone push) for anything due the next school day that is not turned in.
- Any run: alert if a kid's grades haven't synced in `GRADE_STALE_HOURS` (they need to open Blackbaud in Chrome).
- Any run: notice (email + push) for assignments newly posted in Classroom or the Blackbaud feed; alerts for new missing work and new grades that round below `A_THRESHOLD`.
- Fridays 3:55pm: weekly scorecard email (grade now vs. a week ago per class, the graded work that moved it, missing work, dashboard link) to each kid's `scorecardEmails`. Preview: `/kid/<id>/scorecard`.
