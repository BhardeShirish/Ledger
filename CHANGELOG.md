# Changelog

All notable changes to Ledger are recorded here. Dates and figures in this
file describe code, not a release: nothing below has been tagged, versioned or
published yet.

## Unreleased

Everything in this section is work in the tree **after the last published
commit `a5bf6fb` ("Make Ledger neutral and sharpen screenshots")**. There is no
version number and no release date because there has not been a release.

### Bank and PhonePe statement import

- Statements are now recognised by their **content, not their file extension**:
  `.xlsx`, `.xls`, an HTML table served as `.xls`, and CSV/text are all read by
  the same parser, and the header row is found by column meaning
  (`Withdrawal Amt.` / `Debit` / `Dr`) rather than a fixed position.
- **PhonePe exports** are detected and parsed alongside ordinary bank
  statements, keeping the UTR and the account the money left. When an export
  covers more than one account, the upload is refused until the last four
  digits of the business account are given, and lines belonging to other
  accounts are then excluded rather than silently merged.
- **Duplicate safeguards.** Each statement line gets a stable hash that prefers
  the bank's own reference/UTR, with repeated identical same-day lines numbered
  so they stay distinct across re-downloads. A second, legacy hash is still
  checked so imports made before this change continue to de-duplicate. Lines
  already booked are shown as *already imported* instead of being added again.
- **Payments you already wrote down by hand** are found by exact
  outlet + date + amount match (`server/app/expense_duplicates.py`) and flagged
  as *check duplicate*. They are excluded by default; the owner can admit
  specific ones by hash at commit time.
- **Categorisation from your own history, not a guess.** The payee is parsed
  from the narration (VPA, merchant text, noise words stripped) and earlier
  expenses for the same payee are consulted. A category, vendor or payment mode
  is only suggested when at least **75%** of that payee's prior entries agree;
  otherwise the payee is left for review. Confirmed decisions can be remembered
  as a rule (`GET/PATCH/DELETE /api/bank/rules`) so the next statement arrives
  mostly pre-sorted.
- **Compact review UI.** Money out is grouped by payee with a state on each row
  — *ready*, *recommended*, *needs category*, *check duplicate* — a running
  total, the count still needing a decision, and one commit button that names
  exactly how many expenses will be created and for how much. Committing is
  step-up protected, re-checks the edit window and open periods, and can
  back-fill the same category onto earlier matching expenses when that is
  allowed.
- **Statement credits are retained separately** for cash-deposit matching and
  never become sales.
- Cash/bank reconciliation gained partial many-to-many matching
  (`GET /api/bank/cash-reconciliation`, `POST`/`DELETE .../matches`).

### POS (Petpooja) import and bills

- **Re-importing a day is now a replace, not an append.** Committing a report
  rewrites every date it covers: bills are matched on (date, invoice no.),
  bills no longer present in the report are deleted, and the daily channel
  totals for those dates are rebuilt from the persisted bills so a removed
  channel disappears instead of lingering.
- **Bills & history is served from the server** with paging and filters
  (`GET /api/sales/bills` with `business_date`, `kind`, `q`, `page`,
  `per_page`). Ordering is `bill_ts desc, id desc` so a row cannot appear twice
  across pages, and search escapes `%` and `_` so a typed wildcard is a literal,
  not a full-table scan.
- Search is submit-only rather than per-keystroke, with explicit
  *Showing X–Y of Z bills*, *Previous*/*Next*, distinct empty states for
  "no bills at all" and "no bills match these filters", and an **Export**.
- **Part-payment bills** are surfaced as work to do: a banner counts the
  unresolved splits and each is allocated across channels through
  `POST /api/sales/bills/{id}/allocate-split`, which requires the month to be
  open and the allocation to be positive, finite, one row per channel and to
  sum exactly to the bill total.

### Financial validation and integrity

- New `server/app/financial_completeness.py` decides whether a profit figure is
  safe to show at all, from whether COGS looks genuinely logged and whether the
  occupancy and operating cost groups have any entries. It returns
  `profit_known`, `profit_unknown_reason` and `missing_cost_groups`.
- **P&L and the dashboard both withhold profit** when that check fails, and say
  which cost groups are missing. Profit per bill, contribution and break-even
  are withheld on the same basis; break-even also refuses to answer when sales
  are manual-only, and explains why.
- A low cost ratio is no longer automatically "good": `_status()` can return
  `unlogged` when the ratio is only low because the costs were never entered.
- The sensitivity view, when COGS is not believable, states that it is assuming
  the midpoint of the healthy band rather than quietly using a number.
- Healthy bands are owner-configurable (`GET`/`PUT /api/pnl/bands`) and are
  sanitised on read, so corrupt settings fall back to defaults instead of
  producing nonsense thresholds.

### Analytics, Daily Brief and next actions

- Analytics now leads with **ranked next actions** — *Act on this*,
  *Check this*, *Record this* — each with the arithmetic behind it, a deep link
  to the page where the work is done, and a **"Before you act"** caveat naming
  the innocent explanation. For example, a cost spike names a bulk buy, a
  duplicated entry and a misplaced decimal before it names a trend; a closed day
  and an unrecorded day are called out as indistinguishable.
- Per-bill metrics are reported as **unavailable rather than zero** when only
  manual daily totals exist for the range (`bill_metrics_available`).
- The owner intelligence panel states a **confidence level** on every finding
  (*high / medium / low confidence*) with the evidence and, where known, the
  days covered. Repeated findings that share a title and destination are
  collapsed into one item with a count and the money involved, so a month of
  unreconciled drawers reads as one decision rather than thirty.
- The optional AI priority brief states exactly what leaves the machine —
  anonymous health bands, coverage bands and finding topics, "never names,
  amounts, dates, documents, or records" — and falls back to the deterministic
  findings when it cannot produce anything usable.

### Reports, cash and reconciliation

- Cash close accounts for split-payment bills explicitly through
  `split_unknown_paise` instead of misattributing them to the drawer, and adds
  opening float, cash expenses, advances and losses into one expected figure
  with an owner-set variance threshold.
- Closed-day history labels what each rupee column means instead of printing
  bare amounts; the rupee marker stays visible while a figure is being edited.
- Month-close readiness, recurring-cost review and the reporting controls share
  one surface, and standing monthly costs (rent, internet, licences, insurance)
  post themselves on a chosen day — never into a month that has not arrived.

### Getting started guide (record-validated)

- A new **Getting started** panel walks a first-time user through five steps:
  name the business and outlet (or, for a manager, put a real name on the
  login), add people and put them on shifts, record today's sales, record
  today's spending, and count the cash and close the day.
- Every step is decided by **records the API actually returned** — money
  config, employees, shifts, today's sales sheet, today's expenses and today's
  closure. There is no "mark as done": the browser stores only whether the panel
  is open, collapsed or hidden, so hiding the guide cannot lose progress because
  no progress was ever stored.
- "Checking" is kept distinct from "not done", so a pending or failed read is
  never reported as an incomplete step, and each step states up front what
  evidence it will accept.
- The panel steps aside on the very page a step is about, collapses to a
  *Guide · Step N of 5* pill, re-reads the records when you come back from a
  step's page, and offers **Check again**.

### Unsaved work, validation and error resilience

- A shared draft guard (`web/src/lib/useDirtyDraft.ts`) compares the open form
  against its pristine values and intercepts both in-app navigation and a
  browser tab close. Losing a draft now requires answering
  **"Keep unsaved work?" → Keep working / Discard & continue**. It is wired into
  advances, attendance, cash register, inventory counts, items and wastage,
  payroll run detail, people, person detail, purchase orders, vendors and vendor
  detail.
- The error boundary tells a stale-bundle failure apart from a real crash: a
  code-split load failure after an update reloads once and says
  *"Ledger was updated"* instead of *"Something went wrong"*.
- Uploading a workbook whose worksheet structure cannot be read now returns a
  plain instruction ("open it in Excel and save a new .xlsx copy") instead of
  failing on a comparison against `None`.
- Server-side validation was tightened across write paths: inventory count
  dates are validated and cannot be in the future, cash denominations must be
  positive numbers, user roles and password lengths are enforced, and the last
  active owner cannot be removed.

### Time zone

- The inventory count's default business date is pinned to the **Asia/Kolkata**
  day. A regression test freezes the clock at 00:30 IST — 19:00 the previous day
  in UTC — so a UTC-based regression cannot pass by luck
  (`test_count_start_files_the_night_count_under_the_kolkata_day`).

### Offline, PWA and mobile

- The service worker cache version moved to `v2` and it now refuses to cache
  anything that is not a real HTML app shell: a redirect to a private-network
  sign-in page, a gateway error page, or an HTML error served in place of an
  asset can no longer replace the working offline copy. `/api` is excluded
  exactly, not just by prefix.
- The API client attaches an **idempotency key** to every queueable write, so
  the first attempt and every offline retry identify the same write. Redirected
  responses, 5xx, 408 and "OK but not JSON" are treated as "did not arrive" and
  queued rather than reported as success.
- When the connection returns a sign-in or gateway page instead of Ledger data,
  the message says so and tells you to reconnect, instead of showing a generic
  failure.
- The shell has a **Skip to main content** link, a five-tab bottom bar on
  phones, safe-area padding, larger touch targets and consistent focus states;
  sign-out works from the phone's **More** tab.

### Private access, backups and recovery

- **Password recovery without email.** `POST /api/auth/forgot` writes a
  12-character code (grouped 4-4-4, ambiguous characters excluded) to
  `password-reset.txt` in Ledger's own data folder; the API response never
  contains it. Codes last **15 minutes**, allow **5 attempts**, require a new
  password of at least **12 characters**, and on success clear any login lockout
  and revoke every other session. An unknown username behaves identically to a
  real one from the client's point of view.
- **Verified recovery archives.** The daily database backup is taken through
  SQLite's online backup API into a `.partial` file and is only renamed after
  `PRAGMA integrity_check` returns `ok`. The full recovery ZIP (database,
  receipts, signing key, instructions) is verified with `testzip()` and a check
  that `ledger.db` is really inside before it counts as written.
- The recovery folder must be an absolute path **outside** Ledger's data and
  application directories, is write-tested before being accepted, and the choice
  is stored so deleting the Ledger application folder does not delete the
  copies. Settings shows the exact folder and the latest completed copy.
- `GET /api/admin/backup/download` builds the ZIP from an online backup rather
  than a live file copy, includes uploads and the signing key, and is recorded
  in the audit log.
- New Windows helpers: `setup\Restore-LedgerBackup.ps1` (validates the ZIP and
  the database, preserves the current data folder before restoring),
  `setup\Set-LedgerRemoteAccess.ps1` and `setup\Test-LedgerRemoteAccess.ps1` for
  private HTTPS over a VPN, plus `docs/REMOTE-ACCESS.md`.
- The new-PC package and the installer now carry those helpers through an
  explicit allowlist, so remote-access or certificate state on the source
  machine can never ride along in a package.
- `server/app/recovery_import.py` merges recovered or fragmented databases by
  meaning rather than by row id, so a re-import is idempotent, damaged rows do
  not stop the rest, and vendor payments and advances are not double counted.

### Continuous integration and tests

- CI installs `requirements-dev.txt` as well as `requirements.txt`, caches both,
  and runs `python -m pip` / `python -m pytest` so the interpreter under test is
  the one that was set up.
- New server test modules: `test_statement_import.py`, `test_expense_duplicates.py`,
  `test_sales_bills.py`, `test_password_reset.py`, `test_recovery_import.py`.
- New web test modules: `App.test.tsx`, `api/client.test.ts`,
  `OnboardingGuide.test.tsx`, `Bills.test.tsx`, `FinanceReadability.test.tsx`,
  `ImportWorkflows.test.tsx`, `InventoryCounts.test.tsx`,
  `OperationalAccessibility.test.tsx`, `OperationalDraftGuard.test.tsx`,
  `OperationalErrors.test.tsx`, `OperationalMobileUX.test.tsx`,
  `OperationalValidation.test.tsx`, `SettingsPage.test.tsx` and
  `test/service-worker.test.js`.
- `npm run test:guide` runs the Getting started and shared-shell regression
  tests directly, keeping the normal guide-development loop short without
  weakening the complete `npm run test` release check.
- Some of these are written as named regression guards rather than general
  coverage. `web/src/pages/FinanceReadability.test.tsx` opens with *"The bugs
  these guard:"* and names them — a closed-day history that showed bare rupee
  columns, bank-import cash deposits, vendor-list navigation, manual sales money
  inputs, and accessible names on finance screens.

### Documentation

- This changelog.
- Every screenshot in `docs/screenshots/` was re-captured from the current
  build, and the visual tour was rewritten around the workflows and safety
  boundaries a newcomer needs. New captures cover the statement-import review,
  the Getting started guide and searchable bill history.
- The README's remote-access section was rewritten around the private-network
  bootstrap and its licensing caveats, and the data section now describes the
  verified recovery ZIPs and the restore helper.
