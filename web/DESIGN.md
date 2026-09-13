---
name: Ledger — The Counter Book
description: A warm ledger-paper register for a small restaurant's back office — sales, staff, and every rupee in one place.
colors:
  paper:
    value: "#FAF7F2"
  paper-2:
    value: "#F3EEE6"
  paper-3:
    value: "#ECE5DA"
  ink:
    value: "#1C1917"
  ink-soft:
    value: "#57534E"
  ink-faint:
    value: "#70665D"
  accent:
    value: "#C2410C"
  accent-soft:
    value: "#FFF1E7"
  good:
    value: "#15803D"
  bad:
    value: "#B91C1C"
  warn-bg:
    value: "#FFFBEB"
  warn-border:
    value: "#FDE68A"
  warn-text:
    value: "#78350F"
  rule:
    value: "#E7E0D8"
  rule-strong:
    value: "#D6CCC0"
typography:
  headline:
    fontFamily: '"IBM Plex Sans", system-ui, sans-serif'
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "1.25"
    letterSpacing: "-0.01em"
  title:
    fontFamily: '"IBM Plex Sans", system-ui, sans-serif'
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: "1.3"
    letterSpacing: "-0.01em"
  label:
    fontFamily: '"IBM Plex Sans", system-ui, sans-serif'
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: "1.3"
    letterSpacing: "0.12em"
  body:
    fontFamily: '"IBM Plex Sans", system-ui, sans-serif'
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.45"
  small:
    fontFamily: '"IBM Plex Sans", system-ui, sans-serif'
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1.4"
  figure:
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace'
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: "1.4"
    letterSpacing: "-0.01em"
rounded:
  xs: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.25rem"
  xl: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-danger:
    backgroundColor: "{colors.bad}"
    textColor: "#FFFFFF"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  card:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.lg}"
  badge-good:
    backgroundColor: "{colors.good}"
    textColor: "{colors.good}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  badge-warn:
    backgroundColor: "{colors.warn-bg}"
    textColor: "{colors.warn-text}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  badge-bad:
    backgroundColor: "{colors.bad}"
    textColor: "{colors.bad}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  badge-neutral:
    backgroundColor: "{colors.paper-3}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  badge-accent:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  sheet:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.xl}"
    padding: "16px 20px"
---

# Design System: Ledger — The Counter Book

## Overview

**Creative North Star: "The Counter Book"**

Ledger reads like the physical ledger it replaces: warm cream paper, dense ink, and a single burnt-turmeric accent reserved for action. It is a working document, not a dashboard — dense with real figures, quiet in color, and built so an owner scanning it during a busy shift can tell in one glance what needs a decision and what has already been handled. Nothing decorative earns a place; every color, weight, and border in the shipped app is doing a job (a state, a hierarchy level, or a boundary).

The system is flat and paper-like rather than lifted: surfaces are told apart by tone (paper / paper-2 / paper-3) and a hairline rule, not by shadow. Shadow is reserved for the rare moment something detaches from the page — an overlay sheet, the sign-in card. Money is always set in a tabular monospace so columns of rupees line up without being asked to.

**Key Characteristics:**
- Warm neutral paper background with near-black ink text; one accent color (burnt turmeric) used sparingly for actions and highlights only.
- A strict three-color state vocabulary — green/amber/red — that means the same thing everywhere: ready, needs a look, needs a decision.
- Flat, bordered surfaces; tonal layering instead of shadow for depth.
- Figures are always monospace and tabular; prose is always humanist sans.
- Reviewable workflows (like bank-statement import) keep their queue on the page and open one item at a time in an explicit `Sheet` — a side sheet on desktop, a bottom sheet on mobile — over the untouched queue, never as an in-page split.

## Colors

The palette is a single warm neutral scale plus one accent and three semantic signal colors; nothing else is admitted.

### Primary
- **Burnt Turmeric** (`#C2410C`, `accent`): the one accent. Primary buttons, links, focus rings, active nav indicators, caret color. Used for action and emphasis only — never for large fills or decorative backgrounds. Its soft tint (`#FFF1E7`, `accent-soft`) marks the selected row in a list and small accent chips.

### Neutral
- **Ledger Paper** (`#FAF7F2`, `paper`): card and control background, the "page" surface.
- **Paper, one shade down** (`#F3EEE6`, `paper-2`): app background behind cards, and secondary info blocks (rule rows, previous-payment notes).
- **Paper, two shades down** (`#ECE5DA`, `paper-3`): hover/pressed state for tonal surfaces, disabled-ish chips.
- **Ink** (`#1C1917`, `ink`): primary text and headings.
- **Soft Ink** (`#57534E`, `ink-soft`): secondary text — field labels, body copy that isn't the primary message.
- **Faint Ink** (`#70665D`, `ink-faint`): tertiary text — hints, meta, timestamps. **This value diverges from the `ink.faint` (`#A8A29E`) declared in `tailwind.config.js`**: the shipped `index.css` overrides `.text-ink-faint` to `#70665D` because the configured value fell below 3:1 contrast on paper, even for field hints. The override is what actually renders and is the value recorded here; the config value is stale.
- **Rule** (`#E7E0D8`, `rule`) / **Rule, strong** (`#D6CCC0`, `rule-strong`): hairline borders. `rule` divides rows inside a surface; `rule-strong` outlines standalone cards, inputs, and buttons.

### Semantic (state)
- **Good** (`#15803D`): ready, recorded, reconciled, or intentionally excluded ("not an expense"). Backgrounds use `good/10`.
- **Bad** (`#B91C1C`): a required decision, an error, or a destructive action. Backgrounds use `bad/10` or `bad/5`.
- **Warn** (Tailwind's default amber scale — `#FFFBEB` bg, `#FDE68A` border, `#78350F`/`#92400E` text): a system recommendation or an ambiguity that needs confirming (auto-suggested category, possible duplicate). This scale is used consistently across the app but was never added to `tailwind.config.js` as a named token — it is Tailwind's stock `amber-*` used directly, and the exact shade pair shifts slightly by context: the `warn` `Badge` chip uses `amber-100`/`amber-800` (`#FEF3C7`/`#92400E`), while banners and inline panels (Layout's offline banner, BankImport's suggestion and possible-duplicate panels, Reports' budget warnings) use `amber-50` background with an `amber-200` or `amber-300` border and `amber-900` text (`#FFFBEB`/`#FDE68A`–`#FCD34D`/`#78350F`). All of it is the same semantic "warn" signal; the frontmatter records the panel/border variant as canonical. Recorded here as the real, load-bearing "warn" token even though the config file doesn't name it.

### Named Rules
**The Traffic-Light Rule.** Every reviewable item in a queue (a payee, a budget, a finding) resolves to exactly one of three colors: green means it is ready or was deliberately excluded, amber means the system has a recommendation or found an ambiguity (a suggested category, a possible duplicate) that a person should confirm, red means a decision is required and nothing has been assumed. The same three colors must never be repurposed for anything else in a reviewable list.

**The One Accent Rule.** Burnt turmeric is the only color used to mean "act here" or "this is the brand." It never appears as a large background fill — only text, icons, thin borders, focus rings, and the small `accent-soft` tint.

## Typography

**Body Font:** IBM Plex Sans (with `system-ui, sans-serif`)
**Label/Mono Font:** IBM Plex Mono (with `ui-monospace, monospace`)

**Character:** A plain, humanist grotesk carries every word in the app; a monospace carries every number. The pairing reads like a ledger book set in a modern voice — nothing decorative, nothing condensed for drama.

### Hierarchy
- **Headline** (600, 1.5rem/`text-2xl`, tight tracking): the one page title (`<h1>`) per screen — "Import from your bank," "Every bill, searchable."
- **Title** (600, 1.125rem/`text-lg`, tight tracking): section/panel headers within a page, e.g. "What deserves attention next," "Build a graph."
- **Label** (500, 11px, uppercase, 0.12em tracking, set in `ink-soft`): the recurring kicker above a headline (`Money · Bank statement`) and stat-tile captions. This is a system component (`SectionLabel`/`.label-caps`), not a one-off — it appears above nearly every page title.
- **Body** (400, 0.875rem/`text-sm`): default paragraph and field-label copy, usually `ink-soft`.
- **Small** (400, 0.75rem/`text-xs`, `ink-faint`): hints, timestamps, secondary meta under a row.
- **Figure** (400, 0.9375rem monospace, tabular-nums, tight tracking — the `.num` utility): every monetary amount and count in the app, from a ₹ total to a "12 payments" count, so columns of numbers always align.

### Named Rules
**The Ledger Figures Rule.** Any value that is a rupee amount, a count, or a percentage is set in `.num` (IBM Plex Mono, tabular figures). Prose is never set in mono; figures are never set in the sans face.

## Layout

The app shell is a fixed left sidebar with grouped task navigation on desktop (≥768px, `md:`) and a bottom tab bar plus a slide-up "everything else" sheet on mobile. Main content is centered with a `max-w-5xl` column and consistent `px-4`/`md:px-8` gutters.

Page rhythm stacks sections with `space-y-5`; a card's internal padding steps by task weight — `p-3`/`py-2.5` for compact list rows, `p-4` for a standard card, `p-5` for a primary workflow card (upload, review). Spacing otherwise uses Tailwind's default 4px-based scale; no custom spacing tokens are declared.

**Explicit review in a Sheet, over a preserved queue.** The bank-statement import screen — the app's canonical "review a queue of ambiguous items" workflow — keeps its payee queue as a single-column list of rows on the page (each with a status `Badge` and an Edit/Review button) and opens the detail for one payee at a time in a `Sheet` (`side` variant): pinned to the right edge as a side panel at `sm:` and above (`sm:items-stretch sm:justify-end`, `sm:max-w-lg`), a bottom sheet below `sm:` (`items-end`, `rounded-t-xl`). The queue underneath is never replaced or re-laid-out while the Sheet is open.

Touch ergonomics: under `pointer: coarse`, every input, select, button, and nav link gets a minimum 44px (`2.75rem`) hit target and inputs are forced to 16px so iOS Safari does not auto-zoom on focus. The bottom save bar and app main padding account for `env(safe-area-inset-bottom)` on mobile and collapse to normal padding at `md:`.

### Named Rules
**The Queued Sheet Review Rule.** A workflow where someone reviews and corrects several ambiguous items in sequence (the bank-import payee queue) opens each item in a `Sheet`, not an in-page detail panel. The Sheet locks background scroll for the duration (`document.body.style.overflow = "hidden"`) and is dismissed only by its own close button, the Escape key, or a backdrop click. Previous/Next inside the Sheet step only through payees whose review state is not yet `"ready"` — the unresolved review queue, in the same order as the page-level list. The underlying page's sticky Add/Cancel bar (`Add N expenses…` / `Cancel preview`) is untouched by the Sheet and stays reachable the moment it closes.

**The Sticky Action Bar Rule.** A page whose primary action sits below content long enough to be scrolled past keeps that action pinned in a sticky bottom bar, not just at the end of the page. The shared `SaveBar` component (used by `AttendanceGrid` and `SalesSheet`) appears only while there are unsaved changes (`dirtyCount`/`dirtyKinds`), pins above `env(safe-area-inset-bottom)` on mobile, and collapses to a normal static bar at `md:`. `BankImport`'s payee-review screen applies the same pinned-bottom placement to its own Add/Cancel bar rather than the shared component — its content (a running ready-count sentence plus Cancel/Add) is specific to that page, but the placement rule is the same one.

## Elevation & Depth

The system is flat by default: surfaces are separated by a change in paper tone (`paper` → `paper-2` → `paper-3`) and a 1px `rule`/`rule-strong` border, not by shadow. Exactly one shadow token exists and it is reserved for content that visually detaches from the page: the overlay `Sheet` (bottom sheet on mobile, side/center dialog on desktop) and the sign-in card.

### Shadow Vocabulary
- **Sheet** (`box-shadow: 0 12px 40px -12px rgba(28,25,23,.28)`): the only elevated surface in the app — modal/drawer overlays and the Login card.

### Named Rules
**The Flat-By-Default Rule.** Cards, list rows, and panels never carry a shadow. If something needs to read as "above" the page, it uses the `Sheet` shadow, not a new one.

## Shapes

Radius scales with a surface's weight: 4px (`rounded`) for small inline controls (icon-only buttons, compact table inputs), 6px (`rounded-md`) for the dominant case — buttons, inputs, badges-as-rectangles, most bordered rows and cards — 8px (`rounded-lg`) for the default `.card` surface and a few emphasis containers, and 12px (`rounded-xl`) for the two surfaces called out in Elevation (`Sheet`, the Login card). Fully round (`rounded-full`) is reserved for pills (badges, filter chips, segmented controls), avatars, and progress-bar tracks — never for rectangular content containers.

Borders, not shadows, are the primary structural device: every card, input, and button carries a 1px `rule`/`rule-strong` border. A dashed border (`border-dashed`) is the app's specific marker for an optional or upload-style affordance — the statement/file drop zone, an "add a new item" ghost row — and should not be used for ordinary containers.

## Components

### Buttons
- **Shape:** 6px radius (`rounded-md`), minimum 44px hit target at every viewport.
- **Primary:** `accent` background, white text, `px-4 py-2.5 text-sm` at the default size.
- **Outline:** `paper` background, `rule-strong` border — the default secondary action (Previous/Next, Cancel).
- **Ghost:** no border or fill at rest, `paper-3` on hover — lowest-emphasis action (Discard).
- **Danger:** `bad` background, white text — destructive confirms only.
- **Hover / Focus:** background darkens slightly (`/90` opacity) on hover; a 2px `accent` focus ring with 2px offset on focus-visible, everywhere in the app (defined once, globally, not per-component).

### Icons
- **Library:** every icon is an inline SVG from `lucide-react` — no icon font, no glyph characters, no `<img>`-based icons anywhere in the app.
- **Sizing:** 11–16px inline with badge/button text, 17–20px for nav and header chrome, up to 28px for the handful of empty/upload hero icons (`FileUp`, `Landmark`, `ShieldCheck`).
- **Weight:** navigation and chrome icons consistently use `strokeWidth={1.75}`; inline action icons (`Plus`, `Trash2`, `Pencil`, `Check`) use the library's default weight.
- **Pairing:** an icon on an interactive control is almost always paired with a text label (`<Plus size={16} /> Add expense`); the rare icon-only button (Sheet's close `X`, a row-level `Trash2`/`Pencil`) always carries an `aria-label`.

### Cards / Containers
- **Corner Style:** 8px (`rounded-lg`) by default via the shared `.card` class.
- **Background:** `paper`, with `paper-2` used for nested/secondary blocks inside a card.
- **Shadow Strategy:** none (see Elevation & Depth) — separation comes from the `rule` border.
- **Border:** 1px, `rule`.
- **Internal Padding:** `p-4`–`p-5` depending on the card's weight in the page.

### Inputs / Fields
- **Style:** `paper` background, `rule-strong` 1px border, 6px radius. Only numeric `Input`s apply `.num`; Selects and text, password, and date Inputs retain IBM Plex Sans.
- **Compact variant:** `Input` and `Select` expose `size="compact"` for dense filters and table cells while preserving the same border, background, focus, touch-target, and type rules.
- **Focus:** border shifts to `accent` plus a soft `accent/30` focus ring.
- **Behavior:** a numeric field selects its full contents on focus (correcting a whole figure is normal; editing one word of a text field is not, so text fields keep a normal caret).
- **Error / Disabled:** disabled controls drop to 50% opacity; field-level errors render via the shared `ErrorNote` (a `bad`-toned inline banner with `role="alert"`), not inline red text under the field.

### Lists & Rows
- **Structure:** the default list is a `Card` whose rows are separated by `divide-y divide-rule` (or individual `border-b border-rule` rows) rather than a card per row; a standard row runs `px-4 py-2.5`, denser rows step down to `py-1.5`–`py-2`.
- **Row anatomy:** a truncating label (`min-w-0 flex-1 truncate`) on the left, an optional `Badge` for state, a right-aligned `.num` amount, and a trailing `size="sm"` `Button` (usually `outline`) for the row's one action — the same shape whether the row is a bank-import payee, a past import, or a remembered rule.
- **Empty list:** a list with no rows renders one centered muted sentence inside the same card (`"Nothing imported yet."`), not the full `EmptyState` — `EmptyState` (see Feedback, below) is reserved for a whole page or section with no data.

### Badges & Status
- **Traffic-Light triad** (`good` / `warn` / `bad`): the only three tones used for a reviewable item's state — see the Traffic-Light Rule in Colors. `good` = `bg-good/10 text-good`, `warn` = `bg-amber-100 text-amber-800`, `bad` = `bg-bad/10 text-bad`.
- **`neutral`:** `bg-paper-3 text-ink-soft` — an inactive or informational tag with no state meaning (a role label, "Recommendation withheld"). Never used inside a reviewable queue, where it would read as a fourth traffic-light color.
- **`accent`:** `bg-accent-soft text-accent` — marks "current / in progress / look here" (today's date cell, the top-ranked item, an unfinalized payroll run, an "owner" role tag, a data-source tag like "Petpooja"). This is a distinct fourth meaning layered on top of the three-color system, not a state color, and must never be read as a fourth Traffic-Light value.
- **Shape:** always `rounded-full`, `px-2 py-0.5`, `text-xs font-semibold` — a pill, never a rectangle.

### Navigation
- **Desktop:** fixed left sidebar, task-based groups (not entity-based — "Daily work," "Sales & insights," not "Attendance," "Bills"), each group expandable to its children; active item marked with a small `accent` dot plus background tint, not a full-width fill.
- **Mobile:** four-item bottom tab bar for the daily-use screens (Home, Attendance, Sales, Expenses) plus a "everything else" bottom sheet for the rest of the task groups.
- **Kicker:** nearly every page opens with a `label`-styled breadcrumb ("Money · Bank statement") above its `headline` — this is a system convention, not a one-off caption.

### Guided setup
The first-run **Getting started** guide is a record-checked walkthrough, not a
feature tour or a checklist. It follows the counter's real order: name the
business/outlet (or, for a manager, their account), put people on live shifts,
record today's sales, record today's spending, then count and close cash.

- **Truth:** a step turns green only when its underlying Ledger record verifies
  it. A failed or pending read is visibly still being checked, never styled as
  incomplete; there is no manual “done” control.
- **Continuity:** following a guide link collapses it into a compact,
  44px-accessible `Guide · Step N of N` pill above the mobile tab bar or at the
  desktop lower-right. It reopens at the first unverified step and does not
  persist an automatic collapse as a person's preference.
- **Permission:** managers see only reachable, permitted actions. The guide
  never sends them to owner-only business settings or POS import.
- **Layering:** the guide sits on the navigation layer (`z-30`) and always
  yields to the shared `Sheet` dialog layer (`z-40`). A guide must never cover
  a form, confirmation, or review sheet.
- **Focus:** a guide link sends focus to `#main-content`; explicit opening and
  minimising return focus to the requested guide surface. Escape affects the
  guide only while focus is inside it.

### Sheets & Modals
`Sheet` is the app's only dialog/overlay primitive — there is no separate "Modal" or "Dialog" component — and it is used two ways, both real and non-contradictory:
- **As a standard add/edit/confirm form** (its majority use — over a dozen pages: `Advances`, `Bills`, `CashRegister`, `ExpensesList`, `InventoryItems`, `InventoryWastage`, `MenuItems`, `PayrollRunDetail`, `PeopleList`, `PersonDetail`, `PurchaseOrders`, `SettingsPage`, `VendorDetail`, `VendorsList`): a bottom sheet on mobile, a centered dialog on desktop (`sm:max-w-md`, or `wide` for `sm:max-w-2xl` on denser forms like closing the day or planning a purchase order).
- **As the queued-review pattern** (`side` variant, `BankImport` only): pinned to the right edge on desktop, a bottom sheet on mobile, with Previous/Next stepping the unresolved queue — see the Queued Sheet Review Rule (Layout) and Payee Review Sheet (below). A focused `Sheet` is the correct pattern here specifically because it protects one item's review while the on-page queue stays exactly as it was underneath; it does not replace, and is not replaced by, the plain add/edit `Sheet` used everywhere else.
- **Every Sheet, regardless of variant:** traps focus (`Tab`/`Shift+Tab` wraps within the dialog), returns focus to the trigger on close, locks `document.body` scroll for its duration, and is dismissed only by its own close button, `Escape`, or a backdrop click.
- **Confirmation:** `ConfirmSheet` composes `Sheet` for destructive and replay-risk actions. It preserves the action's warning copy and pairs an explicit outline **Cancel** with a primary or danger **Confirm**; while pending, both actions and dismissal are disabled.
- **Not a master-detail pattern.** The app has no persistent side-by-side master-detail view (a list permanently driving an adjacent detail pane). `MenuItems`' two-column `md:grid-cols-[1fr_260px]` layout is a static top-items/dead-items split with no row-click-to-detail behavior, not an interactive master-detail. Detail and editing always happen in a `Sheet` over the list, never in a permanently visible side pane — neither "no dialogs" nor "master-detail only" describes the shipped app.

### Payee Review Sheet (signature component)
The bank-statement import's payee review is the app's reference implementation of "review a queue of ambiguous decisions" as an explicit `Sheet`: the page keeps a plain single-column list of payees, each row carrying one `Badge` state (ready/recommended/check duplicate/needs category) in the Traffic-Light colors plus an Edit/Review button. Choosing a row opens that payee in a `Sheet` (`side` variant — side panel on desktop, bottom sheet on mobile) that shows, in order: the recommendation and its evidence ("Recommended from 4 matching earlier payments"), the category/supplier/payment-method decision (payment method defaults to "Detected: …" from the statement, editable), an explicit and reversible possible-duplicate checklist (per-transaction checkboxes plus Select all/Deselect all — nothing is added unless selected), and a collapsed `<details>` disclosure for the underlying matched transactions. Previous/Next in the Sheet's header step only through the payees that still need a look (the unresolved review queue), skipping ones already ready. Closing the Sheet — its close button, Escape, or the backdrop — returns to the untouched queue and the page's sticky Add/Cancel bar underneath.

### Feedback, Loading, Empty & Error States
- **Loading:** `Spinner` (`role="status"`) — an `accent`-topped spinning ring plus a "Loading…" label, centered with generous vertical padding (`py-16` full-page, `py-14` inside `EmptyState`).
- **Empty:** `EmptyState` — a centered `ink-faint` icon, a medium-weight title, an optional one-line hint, and an optional action button; used for a whole page or major section with no data. A list with nothing in it uses a single muted sentence instead (see Lists & Rows), not the full `EmptyState`.
- **Inline field/form error:** `ErrorNote` (`role="alert"`) — a `bad`-toned bordered banner (`border-bad/30 bg-bad/10 text-bad`), never inline red text under a single field.
- **Global API error:** a dismissible `role="alert"` banner in the app header — auto-clears after 6 seconds unless marked sticky, in which case it carries an explicit `Retry` action and a `✕` dismiss button (the one place in the app a plain text glyph stands in for an icon rather than `lucide-react`'s `X` — a minor inconsistency with the Icons pattern, not a second dismiss-icon convention).
- **Offline:** a persistent `role="status"` amber banner ("You are offline…") — informational and not dismissible, distinct from the sticky red API-error banner.

### Tables & Financial Formatting
- **Storage/formatting split:** every amount is stored and passed as an integer count of paise; `inr()` is the single formatter that turns paise into a display string — money is never formatted ad hoc elsewhere.
- **Presentation:** `₹` symbol, `en-IN` locale grouping (lakh/crore digit groups), 0 decimals for whole rupees and 2 for fractional amounts, a true minus sign (`−`, not a hyphen) for negatives, and a bare `—` for `null`/`NaN` ("not known") rather than "₹NaN" or a misleading "₹0".
- **Signed amounts:** where a value can be a surplus or a shortfall (a cash-count variance), it is prefixed `+`/`−` — except exactly zero, which is never signed, so a balanced count reads as balanced rather than as a manufactured surplus.
- **Table/row alignment:** numeric columns are right-aligned and set in `.num`; label columns are left-aligned and truncate rather than wrap.

## Do's and Don'ts

### Do:
- **Do** keep the accent color rare — action and brand only, never a background fill.
- **Do** set every money amount, count, and percentage in `.num` (IBM Plex Mono, tabular figures).
- **Do** use the green/amber/red Traffic-Light mapping (ready/recommended-or-ambiguous/required-decision) for any reviewable queue, and only for that.
- **Do** open a multi-item review workflow's detail one record at a time in a `Sheet` (side sheet on desktop, bottom sheet on mobile) over the preserved queue, with Previous/Next stepping through only the unresolved items.
- **Do** show evidence next to any auto-suggested value ("Recommended from N matching earlier payments"), not just the suggestion itself.
- **Do** make duplicate or bulk inclusion explicit per-item and reversible (checkboxes + select/deselect all), never auto-selected.
- **Do** leave the underlying page's queue and its sticky Add/Cancel bar exactly as they were when a review `Sheet` opens or closes — dismissal (close button, Escape, backdrop) never discards queue state.
- **Do** use `lucide-react` inline SVGs exclusively for icons, paired with a text label except where an `aria-label` is present.
- **Do** keep a page's primary action in a sticky bottom bar (`SaveBar` or an equivalent pinned bar) whenever that action sits far enough below content to be scrolled past.

### Don't:
- **Don't** add a second shadow token or use shadow for ordinary card/row separation — depth comes from paper tone and `rule` borders.
- **Don't** use `rounded-full` on a rectangular content container; it is reserved for pills, avatars, and track/progress shapes.
- **Don't** render a "warn" (amber, ambiguity/recommendation) state in the `bad` red — `ImportWizard`'s `Box` component does this (`tone === "warn"` maps to `text-bad`) and it contradicts the Traffic-Light Rule everywhere else in the app; treat it as a defect to fix, not a second valid mapping for warn.
- **Don't** treat `Badge`'s `accent`/`neutral` tones as a fourth or fifth Traffic-Light state — they mean "current/in progress" and "informational," never "ready," "needs a look," or "needs a decision."
- **Don't** use the browser's unstyled `window.confirm()` for destructive or replay-risk actions; use the shared `ConfirmSheet` instead.
