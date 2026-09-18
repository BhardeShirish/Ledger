# Ledger

**A simple back office for one small restaurant or cafe.**

Ledger keeps sales, expenses, cash, stock, suppliers, staff, and payroll in one
place on a PC you own. It helps the owner close each day with records they can
actually trust.

No Ledger subscription is required. Your records live in local SQLite storage
that you control.

## What it helps with

- **Run the day:** attendance, sales, expenses, Bank/UPI review, and cash close
  in one simple daily flow.
- **Save bills faster:** capture receipt photos or use optional OCR to fill an
  expense draft, then review it before saving.
- **Avoid duplicate spending:** import Bank, PhonePe, or UPI statements with
  payee grouping and duplicate checks.
- **Track purchases and stock:** goods affect cost, stock, and supplier dues
  only after they are actually received.
- **Pay staff clearly:** attendance, advances, overtime, and payroll drafts
  stay together.
- **Understand the business:** reports and the Daily Brief explain what needs
  attention and clearly identify missing information.

## Start quickly

### Windows

Download the repository and double-click:

```text
setup\Install-Ledger.cmd
```

### Docker

```bash
docker run -d --name ledger -p 127.0.0.1:8080:8080 \
  -v ledger-data:/data \
  -e LEDGER_OWNER_PASSWORD='choose-a-strong-password' \
  --restart unless-stopped \
  ghcr.io/bhardeshirish/ledger:latest
```

Then open <http://localhost:8080>.

## See Ledger in action

**Product tour (1 minute 45 seconds)**

See how a restaurant owner records the day, checks incoming payment activity,
closes cash, and uses the evidence to decide what needs attention next.

https://github.com/user-attachments/assets/cbf9a5e8-cf13-4b48-8539-89fc691bc535

<p align="center">
  <strong>Run the whole day from one checklist</strong><br>
  Attendance, sales, expenses, and cash close stay visible until the day is
  complete.<br><br>
  <a href="docs/screenshots/01-home.png"><img src="docs/screenshots/01-home.png" alt="Ledger daily checklist showing the work left to complete" width="82%"></a>
</p>

<p align="center">
  <strong>Review Bank, PhonePe, and UPI spending before it becomes an expense</strong><br>
  Ledger groups payees, suggests categories from history, and flags likely
  duplicates before anything is booked.<br><br>
  <a href="docs/screenshots/13-statement-import-review.png"><img src="docs/screenshots/13-statement-import-review-overview.png" alt="Ledger statement import review showing duplicate checks and category status" width="82%"></a>
</p>

<p align="center">
  <strong>Close the cash drawer with a real count</strong><br>
  Compare expected cash with the money counted, explain any difference, and
  record money moved to the bank.<br><br>
  <a href="docs/screenshots/03-cash-close.png"><img src="docs/screenshots/03-cash-close-overview.png" alt="Ledger cash close showing expected versus counted cash" width="82%"></a>
</p>

All screenshots use built-in fictional demo data.

## Documentation

- [Complete feature list](docs/FEATURES.md)
- [Screenshots and product tour](docs/SCREENSHOTS.md)
- [Install, update, back up, and run Ledger](docs/OPERATIONS.md)
- [Private phone access](docs/REMOTE-ACCESS.md)
- [Changelog](CHANGELOG.md)

## Important rules

Ledger does not pretend a guess is a fact. It withholds profit, forecast, and
reorder conclusions until the underlying records support them. OCR and optional
AI can suggest or pre-fill work, but a person must always save, approve,
receive, reconcile, run payroll, or close a period.

**Licence: AGPL-3.0.** Free to use, modify, and self-host. If you run a
modified copy as a service for other people, you must publish your changes.
