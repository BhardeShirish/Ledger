"""Break the "no basis, no projection" rule and check its tests notice.

The rule exists because of one screen an owner opens every morning. On the
4th of a month, before that month's sales are imported, the Daily Brief used
to print a confident "₹0 projected month-end". That is not a cautious
estimate; it is a forecast of ruin drawn from an empty table.

Every mutation below puts the lie back, in a slightly different disguise.

    python setup\\mutate_forecast.py
"""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from mutants import check  # noqa: E402

API = "server/app/routers/insights.py"

BACKEND = [
    (API, "project ₹0 from an empty month, the original bug",
     '"projected_rupees": round(projected / 100, 2) if has_basis else None,',
     '"projected_rupees": round(projected / 100, 2),'),

    (API, "always claim a basis, so the gate never fires",
     "has_basis = so_far > 0",
     "has_basis = True"),

    (API, "never claim a basis, so a real month stops forecasting",
     "has_basis = so_far > 0",
     "has_basis = False"),

    (API, "treat elapsed days as a basis, though they may all be empty",
     "has_basis = so_far > 0",
     "has_basis = days_elapsed > 0"),

    (API, "call an unrecorded month 'behind target'",
     '"on_track": projected >= target_paise if has_basis else None,',
     '"on_track": projected >= target_paise,'),

    (API, "report 0% of target on a month nobody has entered",
     '"percent_of_target": round(projected / target_paise * 100, 1)\n            if has_basis else None,',
     '"percent_of_target": round(projected / target_paise * 100, 1),'),
]

UI = "web/src/pages/DailyBrief.tsx"

FRONTEND = [
    (UI, "fall back to ₹0 in the tile, the original bug",
     'value={fc.data.projected_rupees == null\n                           ? "—"\n                           : inr(Math.round(fc.data.projected_rupees * 100))}',
     'value={inr(Math.round((fc.data.projected_rupees ?? 0) * 100))}'),

    (UI, "drop the explanation, leaving a bare dash nobody can read",
     '? "no sales recorded yet this month"',
     '? ""'),

    (UI, "use a loose equality that misses an explicit null",
     "fc.data.projected_rupees == null\n                         ? \"no sales recorded yet this month\"",
     "fc.data.projected_rupees === undefined\n                         ? \"no sales recorded yet this month\""),
]


if __name__ == "__main__":
    rc = check(["tests/test_insights.py"], BACKEND, kind="backend")
    rc |= check(["src/pages/DailyBrief.test.tsx"], FRONTEND, kind="web")
    raise SystemExit(rc)
