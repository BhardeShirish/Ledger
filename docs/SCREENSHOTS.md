# Ledger visual tour

Every capture is from an isolated, fictional demo ledger — invented staff,
suppliers, bills and bank lines. No real restaurant, person, customer,
transaction, receipt or credential appears anywhere. Select any image to open
the full-resolution capture.

## Start here

### Getting started

Takes a new install from empty to a first closed day in five steps. Each step is
ticked by records Ledger actually found, so progress cannot be faked or lost by
hiding the guide.

<p align="center">
  <a href="screenshots/14-getting-started.png">
    <img src="screenshots/14-getting-started.png" alt="Ledger record-validated Getting started guide" width="1000">
  </a>
</p>

## Keep today under control

### Daily checklist

One loop for attendance, sales, expenses and cash close, collapsing to a
*Step N of 5* pill once you are working. Missed days appear as catch-up work
rather than silent zeroes.

<p align="center">
  <a href="screenshots/01-home.png">
    <img src="screenshots/01-home.png" alt="Ledger daily operating checklist" width="1000">
  </a>
</p>

### Expense capture

Vendor, category, payment mode and receipt in one pass. Recent history sits
beside the form so a duplicate is visible before it is entered.

<p align="center">
  <a href="screenshots/02-expenses.png">
    <img src="screenshots/02-expenses.png" alt="Ledger expense capture and history" width="1000">
  </a>
</p>

### Cash close

Shows whether the drawer matches the day, on the day. Part-cash/part-online
bills are held as an explicit unknown (`? ₹1,890`) instead of being guessed into
the cash figure. [Full screen.](screenshots/03-cash-close.png)

<p align="center">
  <a href="screenshots/03-cash-close.png">
    <img src="screenshots/03-cash-close-overview.png" alt="Ledger cash close overview" width="1000">
  </a>
</p>

## Bring records in without breaking them

### Bank / PhonePe statement review

Turns a statement into expenses without double-booking: every payee is labelled
**ready**, **needs category**, or **check duplicate** when a payment of the same
date and amount was already entered by hand, and duplicates are excluded by
default. Categories are suggested only where your own past entries agree, and
the commit button names how many expenses it will create and for how much.
[Full screen.](screenshots/13-statement-import-review.png)

<p align="center">
  <a href="screenshots/13-statement-import-review.png">
    <img src="screenshots/13-statement-import-review-overview.png" alt="Ledger bank statement import review with duplicate and category checks" width="1000">
  </a>
</p>

### Bills & history

Find any imported bill by date or payment type, paged from the server with an
honest *Showing X–Y of Z*. Split-payment bills are surfaced as work to finish —
the allocation must add up to the bill total exactly.
[Full screen.](screenshots/15-bills.png)

<p align="center">
  <a href="screenshots/15-bills.png">
    <img src="screenshots/15-bills-overview.png" alt="Ledger searchable bill history with unresolved payment splits" width="1000">
  </a>
</p>

## Order with evidence

### Inventory

Quantity, usage and food cost in one place. Items whose evidence is too thin are
counted as **withheld** rather than dressed up as safe stock.

<p align="center">
  <a href="screenshots/04-inventory.png">
    <img src="screenshots/04-inventory.png" alt="Ledger inventory overview with withheld evidence" width="1000">
  </a>
</p>

### Reorder evidence

Tells you what to buy only when recorded purchases and counts support it.
Everything else is listed as missing data to fix, never as a silent "healthy".

<p align="center">
  <a href="screenshots/05-reorder.png">
    <img src="screenshots/05-reorder.png" alt="Ledger reorder evidence and incomplete-data coaching" width="1000">
  </a>
</p>

### Purchase controls

Keeps ordering, approving and receiving as separate decisions. Only a
**finalized receipt** moves stock, creates the expense and raises the supplier
liability.

<p align="center">
  <a href="screenshots/06-purchase-orders.png">
    <img src="screenshots/06-purchase-orders.png" alt="Ledger purchase orders and controlled receiving" width="1000">
  </a>
</p>

## Turn records into owner decisions

### Daily brief

Ranks what actually needs the owner today, each item carrying its evidence, the
days it covers and a stated confidence. Repeated findings collapse into one
decision instead of a month of identical rows.
[Full screen.](screenshots/07-daily-brief.png)

<p align="center">
  <a href="screenshots/07-daily-brief.png">
    <img src="screenshots/07-daily-brief-overview.png" alt="Ledger owner intelligence brief overview" width="1000">
  </a>
</p>

### Monthly reports

Closes a month only with its blockers named — unreconciled cash, an open drawer,
an unresolved split — and overriding them requires a written explanation. Profit
is withheld, with the reason, whenever the cost side is too incomplete to state
one. [Full screen.](screenshots/08-monthly-reports.png)

<p align="center">
  <a href="screenshots/08-monthly-reports.png">
    <img src="screenshots/08-monthly-reports-overview.png" alt="Ledger monthly reports and month-close blockers" width="1000">
  </a>
</p>

### Deep analysis

Turns sales, cost, supplier, demand, menu and labour evidence into ranked next
actions — *Act on this*, *Check this*, *Record this* — with the arithmetic
shown. A **Before you act** note names the innocent explanation (a bulk buy, a
double entry, a closed day) before you chase a trend.
[Full screen.](screenshots/09-deep-analysis.png)

<p align="center">
  <a href="screenshots/09-deep-analysis.png">
    <img src="screenshots/09-deep-analysis-overview.png" alt="Ledger deep analysis with ranked next actions and caveats" width="1000">
  </a>
</p>

### Staffing

Shows coverage, labour effectiveness and observed service periods. Suggestions
are review candidates only — never a generated roster or a judgement about a
person — and are withheld when no repeatable pattern clears the evidence bar.

<p align="center">
  <a href="screenshots/10-staffing.png">
    <img src="screenshots/10-staffing.png" alt="Ledger staffing coverage and service-period planning" width="1000">
  </a>
</p>

## Make control durable

### Owner controls

Per-outlet policies, edit windows and data safety in one place. It names where
verified recovery copies are written (outside Ledger's own folder), when the
last one completed, and offers a one-click download of the full archive.
[Full screen.](screenshots/11-owner-controls.png)

<p align="center">
  <a href="screenshots/11-owner-controls.png">
    <img src="screenshots/11-owner-controls-overview.png" alt="Ledger owner controls and data safety overview" width="1000">
  </a>
</p>

## On a phone

### Daily checklist

Lets an owner run the same loop away from the counter, with a five-tab bottom
bar and touch targets sized for service hours.

<p align="center">
  <a href="screenshots/12-mobile-home.png">
    <img src="screenshots/12-mobile-home.png" alt="Ledger daily checklist on a phone" width="390">
  </a>
</p>

### Expenses on the floor

Captures spending where it happens. A dropped connection queues the write and
retries it with an idempotency key, so a flaky network cannot book the same
expense twice.

<p align="center">
  <a href="screenshots/16-mobile-expenses.png">
    <img src="screenshots/16-mobile-expenses.png" alt="Ledger expense capture on a phone" width="390">
  </a>
</p>
