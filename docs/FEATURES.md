# Ledger features

Ledger is a local-first back office for one small restaurant or cafe. It keeps
the daily record together and withholds conclusions when the supporting
evidence is incomplete.

## Daily operations

- Record-validated getting-started guide
- Daily checklist for attendance, sales, expenses, statement review, and cash
  close
- Catch-up prompts for missed work rather than silent zeroes
- Responsive, touch-friendly browser interface
- Offline queue and safe replay for sales, expenses, and attendance

## Sales and bills

- Manual sales totals by channel
- Petpooja bill import
- Searchable, server-paged bill history
- Payment-mode filters, refunds, and losses
- Split-payment bill workflow with unresolved splits kept visible
- Manual totals kept distinct from bill-level and hourly evidence

## Expenses and bill capture

- Expenses with vendor, category, payment method, date, notes, and receipt
  attachment
- Multi-line bills linked to a single receipt and supplier
- Optional bill-photo OCR for printed or handwritten bills
- OCR can extract supplier, date, total, line items, quantities, amounts, and
  confidence into an editable expense draft
- Local Tesseract and OpenAI-compatible vision endpoints are supported;
  Gemini-compatible endpoints can be configured through the compatible API
  path
- OCR never creates or approves an expense automatically

## Bank, UPI, and cash

- Bank-statement and PhonePe/UPI import
- Payee grouping and history-based category suggestions
- Probable duplicate-payment detection before an import is booked
- Expected-versus-counted drawer cash
- Cash close, variance explanations, money-to-bank records, and close history
- Partial, many-to-many reconciliation controls
- Statement credits kept separate from sales evidence

## Suppliers, purchasing, and stock

- Supplier directory, history, balances, and payable aging
- Draft, approve, cancel, receive, and finalise purchase orders
- Finalised receipts alone write stock, cost, and supplier liability
- Stock items, physical counts, count history, variance history, and wastage
- Recipe and ingredient links with theoretical-consumption analysis
- Evidence-gated reorder drafts; forecasts never adjust stock automatically
- Supplier unit-price and price-movement tracking

## People and payroll

- Staff directory and staff records
- Shift-aware attendance grid
- Lateness, overtime, and advances
- Transparent payroll drafts, payroll-run history, and finalisation controls
- Labour planning based on real attendance and timestamped bill data when
  available

## Reports and owner intelligence

- Month P&L with cost-coverage warnings
- Break-even, budgets, forecast scenarios, trends, and cash-runway guidance
- Supplier prices, labour productivity, menu engineering, and service-period
  demand analysis when evidence exists
- Ranked Daily Brief with evidence, confidence, covered days, deep links, and
  resolution history
- Recurring-cost review, close-readiness exceptions, and system-health
  guidance
- Recommendations and profit conclusions are withheld when records cannot
  support them

## Owner controls and safeguards

- Local SQLite data ownership
- Append-only audit history
- Owner elevation for sensitive changes
- Closed-month protection and owner-controlled reopen flow
- Human approval for purchases, receiving, cash reconciliation, payroll, and
  period close
- Optional AI wording for anonymous aggregate findings only; it cannot access
  business records or perform financial actions

## Installation, recovery, and access

- Windows installer, update workflow, and new-PC transfer package
- Docker and Docker Compose deployment for common desktop, server, NAS, and
  Raspberry Pi environments
- Data stored separately from program updates on Windows
- Daily verified recovery ZIPs and a checked restore helper
- Private phone access guidance using secure HTTPS and a private network
- No open-LAN or router-port-forwarding requirement for the recommended remote
  access path

## Deliberate non-goals

Ledger is not a POS replacement, customer khata product, GST filing product,
aggregator-settlement reconciler, biometric-hardware system, multi-master
two-PC sync system, or autonomous bookkeeping agent.

## Product principles

1. **Financial truth first.** Sales minus a few recorded expenses is not
   presented as profit until coverage makes that conclusion credible.
2. **Evidence before advice.** Missing recipes, count history, purchasing
   history, or timestamped demand suppress recommendations.
3. **Closed books stay closed.** Financial writes to a closed month require a
   deliberate owner reopen.
4. **A person stays accountable.** OCR and AI are advisory; Ledger requires a
   human to save, approve, reconcile, pay, receive, or close.
