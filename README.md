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

## See Ledger

<p align="center">
  <a href="docs/screenshots/01-home.png">
    <img src="docs/screenshots/01-home.png" alt="Ledger daily checklist" width="31%">
  </a>
  <a href="docs/screenshots/13-statement-import-review.png">
    <img src="docs/screenshots/13-statement-import-review-overview.png" alt="Ledger statement import review" width="31%">
  </a>
  <a href="docs/screenshots/03-cash-close.png">
    <img src="docs/screenshots/03-cash-close-overview.png" alt="Ledger cash close" width="31%">
  </a>
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
