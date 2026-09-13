# Ledger visual tour

Every capture below is from an isolated, fictional demo ledger seeded with
invented staff, suppliers, bills, and bank lines. No real restaurant, person,
supplier, customer, transaction, receipt, or credential appears anywhere in
these images.

Previews are sized for reading on GitHub. Select any image to open the complete
capture at full resolution.

## Start here

### Getting started

Five steps take a new install from empty to a first closed day: name the
business, put people on shifts, record sales, record spending, count the cash.
Each step is ticked by **records Ledger actually found** — there is no "mark as
done" — so hiding the guide cannot lose progress, and a step that is still
loading says *checking* rather than claiming the work is undone.

<p align="center">
  <a href="screenshots/14-getting-started.png">
    <img src="screenshots/14-getting-started.png" alt="Ledger record-validated Getting started guide" width="1000">
  </a>
</p>

## Keep today under control

### Daily checklist

One clear daily loop for attendance, sales, expenses, and cash close. The guide
collapses to a *Step N of 5* pill once you are working.

<p align="center">
  <a href="screenshots/01-home.png">
    <img src="screenshots/01-home.png" alt="Ledger daily operating checklist" width="1000">
  </a>
</p>

### Expense capture

Record spending with vendor, category, and payment mode in one pass, with the
recent history beside the form so a duplicate entry is visible before it is
made.

<p align="center">
  <a href="screenshots/02-expenses.png">
    <img src="screenshots/02-expenses.png" alt="Ledger expense capture and history" width="1000">
  </a>
</p>

### Cash close

Opening float, cash sales, cash expenses, and advances add up to one expected
drawer figure. Bills that were paid part cash and part online are shown as an
explicit unknown (`? ₹1,890`) instead of being guessed into the drawer.
[Open the complete cash-close screen.](screenshots/03-cash-close.png)

<p align="center">
  <a href="screenshots/03-cash-close.png">
    <img src="screenshots/03-cash-close-overview.png" alt="Ledger cash close overview" width="1000">
  </a>
</p>

## Bring records in without breaking them

### Bank / PhonePe statement review

Upload a statement and Ledger groups money out by who was paid, then labels
every payee before anything is booked: **ready**, **needs category**, or
**check duplicate** when a payment of the same date and amount was already
entered by hand. Duplicates are excluded by default. Categories come from your
own history — a suggestion appears only when past entries for that payee agree
— and a confirmed payee can be remembered for next time. The commit button
names exactly how many expenses will be created and for how much.
[Open the complete import-review screen.](screenshots/13-statement-import-review.png)

<p align="center">
  <a href="screenshots/13-statement-import-review.png">
    <img src="screenshots/13-statement-import-review-overview.png" alt="Ledger bank statement import review with duplicate and category checks" width="1000">
  </a>
</p>

### Bills & history

Every imported bill is searchable and paged from the server, with filters by
date and payment type and an honest *Showing X–Y of Z*. Bills paid across two
methods are surfaced as work to do: the split must be allocated across channels
and must add up to the bill total exactly.
[Open the complete bills screen.](screenshots/15-bills.png)

<p align="center">
  <a href="screenshots/15-bills.png">
    <img src="screenshots/15-bills-overview.png" alt="Ledger searchable bill history with unresolved payment splits" width="1000">
  </a>
</p>

## Order with evidence

### Inventory

Quantity, usage, and food cost in one place — and a count of items whose
evidence is being **withheld** rather than dressed up as safe stock.

<p align="center">
  <a href="screenshots/04-inventory.png">
    <img src="screenshots/04-inventory.png" alt="Ledger inventory overview with withheld evidence" width="1000">
  </a>
</p>

### Reorder evidence

A reorder recommendation appears only when the recorded inputs support it.
Everything else is listed as missing data to fix, not as a silent "healthy".

<p align="center">
  <a href="screenshots/05-reorder.png">
    <img src="screenshots/05-reorder.png" alt="Ledger reorder evidence and incomplete-data coaching" width="1000">
  </a>
</p>

### Purchase controls

A plan waits for approval, an approved order waits for goods, and **only a
finalized receipt** moves stock, creates the expense, and raises the supplier
liability.

<p align="center">
  <a href="screenshots/06-purchase-orders.png">
    <img src="screenshots/06-purchase-orders.png" alt="Ledger purchase orders and controlled receiving" width="1000">
  </a>
</p>

## Turn records into owner decisions

### Daily brief

Ranked owner actions, each with the evidence behind it, the days it covers, and
a stated confidence level. Repeated findings collapse into one decision instead
of a month of identical rows. [Open the complete daily brief.](screenshots/07-daily-brief.png)

<p align="center">
  <a href="screenshots/07-daily-brief.png">
    <img src="screenshots/07-daily-brief-overview.png" alt="Ledger owner intelligence brief overview" width="1000">
  </a>
</p>

### Monthly reports

Month close lists its blockers by name — unreconciled cash, an unclosed drawer,
an unresolved payment split — and a month can only be closed over them with a
written explanation. Profit is withheld, with the reason, whenever the cost side
is not complete enough to state one.
[Open the complete monthly-reports screen.](screenshots/08-monthly-reports.png)

<p align="center">
  <a href="screenshots/08-monthly-reports.png">
    <img src="screenshots/08-monthly-reports-overview.png" alt="Ledger monthly reports and month-close blockers" width="1000">
  </a>
</p>

### Deep analysis

Sales, cost, supplier, demand, menu, and labour evidence lead to ranked next
actions — *Act on this*, *Check this*, *Record this* — each with the arithmetic
shown and a **Before you act** note naming the innocent explanation (a bulk buy,
a double entry, a closed day) before you chase a trend.
[Open the complete deep-analysis screen.](screenshots/09-deep-analysis.png)

<p align="center">
  <a href="screenshots/09-deep-analysis.png">
    <img src="screenshots/09-deep-analysis-overview.png" alt="Ledger deep analysis with ranked next actions and caveats" width="1000">
  </a>
</p>

### Staffing

Coverage, labour effectiveness, and observed service periods. Suggestions are
explicitly *review candidates, never a generated roster or a judgement about a
person*, and are withheld when no repeatable pattern clears the evidence bar.

<p align="center">
  <a href="screenshots/10-staffing.png">
    <img src="screenshots/10-staffing.png" alt="Ledger staffing coverage and service-period planning" width="1000">
  </a>
</p>

## Make control durable

### Owner controls

Per-outlet policies, edit windows, and data safety in one place: where the
verified recovery copies are written (outside Ledger's own folder), when the
last one completed, and a one-click download of the full archive.
[Open the complete owner-controls screen.](screenshots/11-owner-controls.png)

<p align="center">
  <a href="screenshots/11-owner-controls.png">
    <img src="screenshots/11-owner-controls-overview.png" alt="Ledger owner controls and data safety overview" width="1000">
  </a>
</p>

## On a phone

### Daily checklist

The operating loop stays focused during service, with a five-tab bottom bar and
touch targets sized for a busy counter.

<p align="center">
  <a href="screenshots/12-mobile-home.png">
    <img src="screenshots/12-mobile-home.png" alt="Ledger daily checklist on a phone" width="390">
  </a>
</p>

### Expenses on the floor

Spending is captured where it happens. Writes are queued if the connection drops
and retried with an idempotency key, so a flaky network cannot book the same
expense twice.

<p align="center">
  <a href="screenshots/16-mobile-expenses.png">
    <img src="screenshots/16-mobile-expenses.png" alt="Ledger expense capture on a phone" width="390">
  </a>
</p>
