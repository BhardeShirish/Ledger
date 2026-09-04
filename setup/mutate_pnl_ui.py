"""Break the P&L screen on purpose and check its tests notice.

The screen's real job is refusing to look confident. Most mutations here
turn a withheld number back into a shown one, or paint a gap in the books
green — the two ways this page could quietly cost someone money.

    python setup\\mutate_pnl_ui.py
"""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from mutants import check  # noqa: E402

SRC = "web/src/components/ProfitAndLoss.tsx"

MUTATIONS = [
    ("paint an unlogged cost green, so a gap in the books reads as thrift",
     'unlogged: "text-ink-faint",',
     'unlogged: "text-good",'),

    ("call an unlogged cost healthy in words",
     'unlogged: "not logged",',
     'unlogged: "healthy",'),

    ("show a profit the server refused to youch for",
     "{d.totals.profit_known ? (",
     "{true ? ("),

    ("drop the explanation of why a number is missing",
     '<p className="mt-0.5 text-xs text-ink-faint">{why}</p>',
     '<p className="mt-0.5 text-xs text-ink-faint" />'),

    ("hide that ratios exclude GST",
     "{money(d.sales.net_rupees)} net sales · {d.measured_on}",
     "{money(d.sales.net_rupees)} net sales",),

    ("stop saying a part month is a part month",
     "{d.period.partial && ` · ${d.period.days_counted} of ${d.period.days_in_month} days`}",
     "{false}"),

    ("stop saying the wage bill was counted pro rata",
     '{d.payroll.prorated && ", counted pro rata for the days so far"}',
     "{false}"),

    ("swallow the caveat printed under a lever",
     '<p className="text-xs text-ink-faint">{s.how}</p>',
     '<p className="text-xs text-ink-faint" />'),

    ("report the calendar month where the rolling window belongs",
     "Food cost, last {d.rolling_food_cost.days} days",
     "Food cost this month"),

    ("show a break-even the server would not stand behind",
     "value={d.breakeven.possible",
     "value={true"),

    ("stop marking an overspent budget",
     'b.over ? "text-bad" : "text-ink"',
     '"text-ink"'),

    ("pretend a month with no sales has some",
     "{d && d.sales.bills === 0 ? (",
     "{d && false ? ("),

    ("lose the prime cost row, the one number an operator runs on",
     "<div className=\"font-semibold\">Prime cost</div>",
     "<div className=\"font-semibold\">Costs</div>"),

    ("show the wage bill without saying where it came from",
     "Wages come from your staff list: {d.payroll.headcount} people,{\" \"}",
     "{\" \"}"),
]


if __name__ == "__main__":
    raise SystemExit(check(['src/components/ProfitAndLoss.test.tsx'], [(SRC, *m) for m in MUTATIONS], kind="web"))
