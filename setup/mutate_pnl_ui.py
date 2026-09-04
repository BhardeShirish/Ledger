"""Break the P&L screen on purpose and check its tests notice.

The screen's real job is refusing to look confident. Most mutations here
turn a withheld number back into a shown one, or paint a gap in the books
green — the two ways this page could quietly cost someone money.

    python setup\\mutate_pnl_ui.py
"""
import io
import subprocess
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
SRC = WEB / "src" / "components" / "ProfitAndLoss.tsx"
TEST = "src/components/ProfitAndLoss.test.tsx"

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


def run_tests() -> bool:
    r = subprocess.run(["npx", "vitest", "run", TEST],
                       cwd=WEB, capture_output=True, text=True, shell=True,
                       encoding="utf-8", errors="replace")
    return r.returncode == 0


def main() -> int:
    original = SRC.read_text(encoding="utf-8")

    if not run_tests():
        print("baseline is already red — fix that first")
        return 1
    print("baseline green\n")

    missed = []
    try:
        for name, old, new in MUTATIONS:
            if original.count(old) != 1:
                print(f"SKIP  {name}\n      anchor hit {original.count(old)} times")
                return 1
            SRC.write_text(original.replace(old, new, 1), encoding="utf-8")
            if run_tests():
                print(f"MISSED  {name}")
                missed.append(name)
            else:
                print(f"caught  {name}")
    finally:
        SRC.write_text(original, encoding="utf-8")

    print()
    if missed:
        print(f"{len(missed)} mutation(s) survived — those rules are untested:")
        for m in missed:
            print(f"  - {m}")
        return 1
    print(f"all {len(MUTATIONS)} mutations caught")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
