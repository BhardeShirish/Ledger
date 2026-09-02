# Ootaa Ledger — The Counter Book

One register for a small restaurant's back office: **daily sales, expenses,
vendor khata, staff attendance with shifts, advances and payroll** — with
Petpooja imports filling the money-in picture bill by bill.

Built for Indian restaurant owners who currently run the shop out of a
notebook and three WhatsApp groups. It runs on **one PC you own**, keeps every
record in a single file you can copy, and needs no subscription and no
internet. You can use it from your phone over your own private network.

**Licence: AGPL-3.0.** Free to use, modify and self-host, forever. If you run a
modified copy as a service for other people, you must publish your changes.

> Money is not a place for guesses. Where Ledger cannot be sure of a number it
> says so rather than showing a confident green figure — a profit estimate
> stays grey until payroll has actually been run, and "no problems found" is
> never claimed for a month with nothing recorded in it.

---

## Try it in five minutes

You do not have to enter real data to look around. Start with a demo ledger
full of sample records:

**Docker** (any OS):

```bash
cp .env.example .env          # then set LEDGER_OWNER_PASSWORD
echo "LEDGER_DEMO_SEED=1" >> .env
docker compose up -d
```

**Windows, no Docker:** double-click `Start-Ootaa-Ledger.cmd`.

Either way, open <http://localhost:8080> and sign in as `owner` with the
password you set. Remove the `LEDGER_DEMO_SEED` line and start from an empty
database when you are ready for real records.

---

## Running it for real

### Windows (the usual case)

Everything is double-clickable, because Windows blocks double-clicked
PowerShell files:

| I want to… | Double-click |
|---|---|
| Start Ledger | `Start-Ootaa-Ledger.cmd` |
| Stop Ledger | `Stop-Ootaa-Ledger.cmd` |
| Set up a brand-new PC | `Install-Ledger-New-PC.cmd` (inside the ZIP) |
| Update a PC that already runs Ledger | `Update-Ledger.cmd` (inside the ZIP) |
| Build any package | `setup\Create-Package.cmd` (asks which of the three) |

From a terminal: `.\start.ps1`, `.\stop.ps1`, and
`.\setup\Create-Ledger-New-PC-Package.ps1` with `-Update` or `-Fresh`.

On a brand-new PC use `Install-Ledger-New-PC.cmd` — it installs Python if
needed, registers Ledger to start at logon, and prints the first-run owner
password. Change it in Settings → account after signing in.

### Docker (Linux, macOS, or a NAS)

```bash
cp .env.example .env          # LEDGER_OWNER_PASSWORD is required
docker compose up -d
```

Records live in the `ledger-data` volume, not in the image, so rebuilding or
upgrading the container never touches your data. To take a copy off the
machine:

```bash
docker cp ootaa-ledger:/data ./ledger-backup
```

> The Dockerfile has not been built on the author's machine (no Docker engine
> there). If it misbehaves, please open an issue — it is the one path here that
> has not been exercised end to end.

---

## Using it from your phone

The interface is fully responsive — a bottom tab bar, a hidden sidebar, and
touch-sized controls — and it installs to the home screen as an app. There is
no separate mobile app to download.

**It must be served over HTTPS.** This is not a preference. Browsers only grant
offline storage and installability to a *secure context*, so a plain
`http://192.168.x.x:8080` address gives you a website that breaks the moment
the Wi-Fi drops. Worse, it sends your payroll and your password across the café
network in the clear.

The free way to do this properly is [Tailscale](https://tailscale.com). On the
PC holding the records:

```bash
tailscale up
tailscale serve --bg 8080
```

Install Tailscale on the phone too, sign in to the same account, and open the
`https://your-pc.your-tailnet.ts.net` address it prints. Only your own devices
can reach it; nothing is exposed to the internet, and the certificate is real,
so the app installs and works offline. On the phone, choose "Add to Home
Screen" and Ledger becomes an icon like any other app.

If you would rather not use Tailscale, any HTTPS reverse proxy — Caddy, nginx
with Let's Encrypt, or a Cloudflare Tunnel — does the same job.

**Plain LAN access**, if you accept the trade-off, is `.\start.ps1 -Lan` on
Windows or `LEDGER_BIND=0.0.0.0` under Docker. Ledger prints the address and
warns you. Do not do this on a network customers can join.

### When the connection drops

Ledger keeps working. You stay signed in, an amber banner tells you the figures
on screen may be stale, and new **sales, expenses and attendance** are saved on
the device and sent when you reconnect. A chip in the corner shows how many
entries are waiting and lets you retry by hand.

Only entries that are safe to re-send are queued this way. Each carries a
unique key, and every endpoint behind it either overwrites one specific day's
figure or refuses a repeated key outright — so an entry that syncs twice is
still recorded once. `server/tests/test_offline_replay.py` is what holds that
promise in place; if you add an endpoint to `OFFLINE_OK` in
`web/src/api/client.ts`, add it there too.

Reading old reports offline is deliberately *not* supported. A cached figure
that is quietly a week out of date is more dangerous than an error message.

---

## Your data

Everything lives in `server/data` (Windows) or the `ledger-data` volume
(Docker): the SQLite database, uploaded receipts, and the signing key that
keeps you logged in across restarts. Copy that folder and you have copied the
whole business.

To restore a backup, stop Ledger, then replace the database and uploaded files
in that folder before restarting. Do not drop the backup ZIP into
`server/data` — the server does not auto-extract it.

### Moving to a new Windows PC

Run `.\setup\Create-Ledger-New-PC-Package.ps1` on the old PC. It stops Ledger,
then builds `Ledger-New-PC.zip` with a consistent database snapshot, the
receipts and the application. Transfer that ZIP privately, extract it, and
double-click `Install-Ledger-New-PC.cmd`. Do not resume entering data on the
old PC afterwards; the two databases do not synchronise.

`-Fresh` builds `Ledger-Fresh-Install.zip` instead, carrying no records at all.

### Updating a PC that already runs Ledger

Run `.\setup\Create-Ledger-New-PC-Package.ps1 -Update` to build
`Ledger-Update.zip` (program only, no records). Extract the whole ZIP on the
target PC, double-click `Update-Ledger.cmd`, then press Ctrl+F5 in the browser.

That PC keeps its own database, receipts and logins. Before replacing anything
the updater backs the database up to `server/data/backups/`, keeps the previous
program alongside for rollback, and refuses to run against a package that
carries a database of its own.

---

## Security

- Managers never see salaries, payroll or advances at all.
- Editing a record older than 48 hours (configurable) needs the owner's live
  password.
- Sessions are database-backed, so signing out revokes access immediately;
  cookie writes are CSRF-protected; repeated bad passwords lock the account.
- Every change lands in an append-only audit log.
- Ledger binds to `127.0.0.1` unless you explicitly tell it otherwise.

Found a security problem? Please report it privately through a GitHub security
advisory rather than a public issue.

---

## How the pieces fit

- **Home = today's flow**: attendance → sales → expenses → close-the-day.
  Green ticks when each is done, and a reminder appears for days you skipped.
- **Attendance grid**: one day at a time (today by default, never a future
  day); statuses cycle P→A→H→L→WO; times pre-fill from shifts; `×2` credits a
  double shift as an extra day, while `A ×2` counts two days missed and is
  never paid; late and OT are derived automatically.
- **Payroll mirrors the Excel exactly**: `per-day = salary ÷ 26`,
  `month pay = credited days × per-day − same-month advances`. Drafts show the
  full arithmetic; finalising locks the month.
- **Day sheet** records the day's takings plus losses — a refund to a customer,
  cash missing from the drawer, wastage — and each loss says whether it came
  out of the till, which is what the drawer count is checked against.
- **Petpooja importer** reads the Orders Master Report (47 columns), handles
  Part/Due payments, skips cancelled bills, dedupes per invoice+day.
- **Cash register** computes the expected drawer (float + cash sales − cash out
  − drawer losses) against the counted cash; variances surface in Insights.
- **Inventory** tracks purchases, wastage, counts, reorder quantities,
  ingredient links, usage and dish profitability.

## Non-goals (by design)

GST filing (CA-pack exports instead), customer-side khata, aggregator
settlement reconciliation, biometric hardware, and multi-master sync between
two PCs that are both taking entries.

---

## Contributing

```bash
cd server && pip install -r requirements.txt
export LEDGER_OWNER_PASSWORD='choose-a-strong-password'
uvicorn app.main:app --reload --port 8000          # API + /api/docs
cd ../web && npm install && npm run dev            # SPA on 5173, proxies /api
```

Before opening a pull request:

```bash
cd server && pytest -q                             # 292 tests
cd web && npx vitest run && npx tsc --noEmit && npx eslint src
```

Two house rules, both learned the hard way:

1. **A test you have not watched fail proves nothing.** Break the code on
   purpose, see the new test go red, then put the code back.
2. **Never show a confident number the data does not support.** If a figure is
   missing an input, name the input.
