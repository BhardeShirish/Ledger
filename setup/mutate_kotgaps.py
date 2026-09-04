"""Break the kitchen-ticket counting on purpose and check the tests notice.

Each mutation here is a way this report could quietly mislead the owner:
by accusing the kitchen of a leak that is really an import quirk, by
hiding a real one, by letting one day's ticket numbers bleed into the
next, or by congratulating a shop on figures it never had.

    python setup\\mutate_kotgaps.py
"""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from mutants import check  # noqa: E402

MUTATIONS = [
    ("blame the kitchen for bills that arrived with no ticket number",
     'at_least = max(0, at_most - day["unnumbered"])',
     "at_least = at_most"),

    ("credit unnumbered bills twice over, so a gap goes negative",
     'at_least = max(0, at_most - day["unnumbered"])',
     'at_least = at_most - day["unnumbered"] * 2'),

    ("let unnumbered bills push the count below zero",
     'at_least = max(0, at_most - day["unnumbered"])',
     'at_least = at_most - day["unnumbered"]'),

    ("count from ticket 1 instead of the day's own first ticket",
     "absent = [n for n in range(first, last + 1) if n not in nums]",
     "absent = [n for n in range(1, last + 1) if n not in nums]"),



    ("pool every day's tickets together, so gaps cancel out",
     'day = per.setdefault(b.business_date, {',
     'day = per.setdefault("all", {'),

    ("treat a bill with no ticket number as ticket zero",
     "        if n is None:\n            day[\"unnumbered\"] += 1",
     "        if n is None:\n            day[\"numbers\"].add(0)\n"
     "            day[\"unnumbered\"] += 1"),

    ("read a non-numeric ticket label as a number anyway",
     "    return int(text) if text.isdigit() else None",
     "    return int(text) if text else None"),

    ("miss ticket numbers that arrive as integers, not strings",
     "    text = str(value).strip()",
     "    text = value if isinstance(value, str) else ''"),

    ("run the numbers together, so 41 and 43 read as one range",
     "            if n == int(hi or lo) + 1:",
     "            if n <= int(hi or lo) + 2:"),

    ("cut the count along with the printed list",
     '"missing_at_most": at_most, "missing_at_least": at_least,',
     '"missing_at_most": min(at_most, MAX_LISTED_NUMBERS),'
     ' "missing_at_least": at_least,'),

    ("value the loss at every bill in the period, not the day's own",
     'avg = day["net_paise"] / day["bills"] if day["bills"] else 0',
     "avg = 100000"),

    ("call a day with no ticket numbers a clean day",
     '                "measurable": False,',
     '                "measurable": True,'),

    ("congratulate a shop whose import carried no ticket numbers",
     "    if not measured:",
     "    if False:"),

    ("stay quiet when tickets really are going missing",
     '        add("act", f"{at_least} kitchen tickets never became a bill",',
     '        add("info", f"{at_least} kitchen tickets seen",'),

    ("name the calmest day as the worst one",
     'worst = sorted(measured, key=lambda d: (-d["missing_at_least"], d["date"]))[:10]',
     'worst = sorted(measured, key=lambda d: (d["missing_at_least"], d["date"]))[:10]'),

    ("drop the missing numbers, leaving nothing to look up",
     '"missing_numbers": _runs(absent[:MAX_LISTED_NUMBERS]),',
     '"missing_numbers": [],'),

    ("hide how many bills carry no ticket number",
     '    if totals["unnumbered_bills"]:',
     "    if False:"),

    ("accept a backwards date range and report on nothing",
     "            raise HTTPException(422, \"start must fall on or before end\")",
     "            pass"),
]


if __name__ == "__main__":
    SRC = "server/app/routers/patterns.py"
    raise SystemExit(check(["tests/test_kot_gaps.py"],
                           [(SRC, *m) for m in MUTATIONS]))
