"""Break the P&L on purpose and check the tests notice.

A green suite proves nothing on its own — it might be asserting that the
sun rises. Each mutation below is a plausible mistake someone could make
editing these files, and most of them are mistakes that would make the
page *flatter* the shop, which is the failure mode that costs money.

    python setup\\mutate_pnl.py
"""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from mutants import check  # noqa: E402

PNL = "server/app/routers/pnl.py"
REC = "server/app/routers/recurring.py"
GRP = "server/app/costgroups.py"

MUTATIONS = [
    # ── the denominator ─────────────────────────────────────────────────
    (PNL, "measure ratios on the taxed total, flattering every line",
     '"net_paise": net, "total_paise": total,',
     '"net_paise": total, "total_paise": total,'),

    # ── the trust gate: the whole point of the page ─────────────────────
    (PNL, "call a suspiciously low cost 'good' instead of 'unlogged'",
     "if pct < lo * UNDERLOG_FRACTION or not logged:",
     "if False:"),

    (PNL, "treat one token receipt as a fully logged food cost",
     'cogs_ok = cogs_status != "unlogged"',
     "cogs_ok = True"),

    (PNL, "show a profit even while costs are missing",
     '"profit_rupees": _rupees(profit_paise) if complete else None,',
     '"profit_rupees": _rupees(profit_paise),'),

    (PNL, "show a break-even built on costs nobody entered",
     "    if not complete:",
     "    if False:"),

    (PNL, "quietly drop the missing-food-cost warning",
     'if not cogs_ok and GROUPS["cogs_food"][0] not in quality["missing_groups"]:',
     "if False:"),

    # ── labour ──────────────────────────────────────────────────────────
    (PNL, "charge a whole month of wages against a part month of sales",
     "share = days / in_month if in_month else 0",
     "share = 1"),

    (PNL, "keep paying staff who have left",
     'Employee.working_status != "left",',
     "Employee.id > 0,"),

    (PNL, "stop warning that salaries are booked twice",
     'if any(w in name.lower() for w in ("salar", "wage", "payroll"))',
     "if False"),

    (PNL, "stop noticing staff meals hidden in food cost",
     "if any(w in label for w in STAFF_MEAL_WORDS):",
     "if False:"),

    # ── the bands ───────────────────────────────────────────────────────
    (PNL, "never call a cost over its band",
     "if pct > hi * 1.15:",
     "if pct > 1e9:"),

    (PNL, "let prime cost pass the danger line unremarked",
     "PRIME_DANGER = 65.0",
     "PRIME_DANGER = 1e9"),

    # ── break-even and levers ───────────────────────────────────────────
    (PNL, "quote break-even in rupees a month instead of bills a day",
     '"bills_per_day": int(round(per_day / ticket)) if ticket else None,',
     '"bills_per_day": int(round(month_paise / ticket)) if ticket else None,'),

    (PNL, "forget to scale a part month's fixed costs to the whole month",
     "monthly_fixed = fixed / days_counted * days_in_month if days_counted else fixed",
     "monthly_fixed = fixed"),

    (PNL, "assume a 100% margin when food cost is unknown",
     "assumed = round((band[0] + band[1]) / 2, 1)",
     "assumed = 0.0"),

    (PNL, "read food cost over the calendar month, hiding a bulk order",
     "start = (last - timedelta(days=ROLLING_DAYS - 1)).isoformat()",
     "start = last.replace(day=1).isoformat()"),

    # ── standing costs ──────────────────────────────────────────────────
    (REC, "drop the idempotency key, so every page load re-posts the rent",
     'key = f"rec:{r.id}:{month}"',
     'key = ""'),

    (REC, "post next month's rent today",
     "if when > today:",
     "if False:"),

    (REC, "skip a month whose due day is longer than the month",
     "return date(y, m, min(day, calendar.monthrange(y, m)[1])).isoformat()",
     "return date(y, m, min(day, 28)).isoformat()"),

    (REC, "keep posting a cost the owner stopped",
     "filter(RecurringCost.is_active == True).all()",
     "all()"),

    (REC, "ignore the end month and post for ever",
     "last = min(m for m in (r.end_month or this_month, this_month) if m)",
     "last = this_month"),

    (REC, "let a backwards date range through validation",
     "if body.end_month < body.start_month:",
     "if False:"),

    # ── grouping ────────────────────────────────────────────────────────
    (GRP, "let a generic word beat a specific phrase",
     "if needle in text and len(needle) > best_len:",
     "if needle in text and best_len == 0:"),

    (GRP, "park unknown categories in the narrow 'other' band",
     'best, best_len = "operating", 0',
     'best, best_len = "admin", 0'),

    (GRP, "treat the water bill as stock you sell",
     '("water", "operating"),',
     '("water", "cogs_bev"),'),

    # ── the bands: what "healthy" means ─────────────────────────────────
    (PNL, "accept a reversed band, inverting every verdict on that line",
     "if not (0 <= lo < hi <= 100):",
     "if False:"),

    (PNL, "quietly repair a bad band instead of refusing it",
     "        return None\n    return [round(lo, 1), round(hi, 1)]",
     "        return [min(lo, hi), max(lo, hi)]\n    return [round(lo, 1), round(hi, 1)]"),

    (PNL, "let a corrupt saved band reach the report",
     "if key in BANDS_DEFAULT and band:",
     "if True:"),

    (PNL, "let a shop invent a P&L line that nothing is measured against",
     "unknown = [k for k in body if k not in BANDS_DEFAULT]",
     "unknown = []"),

    (PNL, "save the good lines and drop the bad one on the floor",
     '                     "with the low smaller than the high.")',
     '                     "with the low smaller than the high.") if False else None'),

    (PNL, "keep an override even when it matches the published figure",
     "if band != BANDS_DEFAULT[key]:",
     "if True:"),

    (PNL, "ignore the shop's own bands and judge everyone the same",
     "    saved = get_setting_db(db, \"pnl_bands\", None)",
     "    saved = None"),
]


if __name__ == "__main__":
    raise SystemExit(check(['tests/test_pnl.py', 'tests/test_recurring.py', 'tests/test_costgroups.py'], MUTATIONS))
