# School Tracker

Daily homework (Google Classroom) and grades (Blackbaud) per kid, with a two-week plan,
submitted/missing status, a grade scorecard, and alerts for anything below an A.

## Adding a kid
1. Add an entry to `kids.json` (`id` is lowercase and used everywhere below). Push; Railway redeploys.
2. In Railway, tracker, Variables: add `<ID>_BB_USER` and `<ID>_BB_PASS` (for example `TYLER_BB_USER`).
3. Open `/kid/<id>` on the dashboard and click **Connect Google account**; the kid signs in and approves.

Each kid has their own Google token, Blackbaud login, state file, alert log, and dashboard page (`/kid/<id>`).
`alertEmails` per kid overrides `PARENT_EMAILS`; the kid's own `email` is always copied.

## Railway variables
| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client for the Classroom API |
| `<ID>_BB_USER`, `<ID>_BB_PASS` | Each kid's Blackbaud login |
| `SMTP_USER`, `SMTP_PASS` | Gmail address and app password used to send alerts |
| `PARENT_EMAILS` | Comma-separated alert recipients |
| `NTFY_TOPIC` | Phone push topic (ntfy app) |
| `DASHBOARD_KEY` | Append `?key=...` once to open the dashboard |
| `A_THRESHOLD` | Alert below this percent (default 93) |
| `RUN_CRON` | Schedule in ET (default 6am, 3pm, 8pm) |
