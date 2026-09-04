"""Break patterns.py on purpose and check the tests notice.

A green suite proves nothing on its own — it might be asserting that the
sun rises. Each mutation below is a plausible mistake someone could make
editing this file. If the tests still pass afterwards, the rule it broke is
not actually covered.

    python setup\\mutate_patterns.py
"""
import io
import subprocess
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

SRC = Path(__file__).resolve().parents[1] / "server" / "app" / "routers" / "patterns.py"
SERVER = SRC.parents[2]

MUTATIONS = [
    ("mean instead of median — one wedding lifts every future Tuesday",
     "est = int(median(hist))",
     "est = int(sum(hist) / len(hist))"),

    ("forecast every weekday off one sample",
     "MIN_WEEKS_FOR_FORECAST = 2",
     "MIN_WEEKS_FOR_FORECAST = 1"),

    ("blend all weekdays together — Sunday predicted like a Tuesday",
     "per_dow[date.fromisoformat(iso).weekday()].append(paise)",
     "per_dow[0].append(paise); per_dow[1] = per_dow[2] = per_dow[3] = \\\n"
     "        per_dow[4] = per_dow[5] = per_dow[6] = per_dow[0]"),

    ("forecast starts on the last day of data, not the day after",
     "d = last + timedelta(days=i)",
     "d = last + timedelta(days=i - 1)"),

    ("count untimed bills as midnight, inventing a rush at 00:00",
     'f["totals"]["bills_without_a_time"]:',
     'False:'),

    ("stop noticing a price climb",
     "if chg is not None and abs(chg) >= PRICE_MOVE_PCT:",
     "if chg is not None and abs(chg) >= 1e9:"),

    ("stop noticing the same item bought at double the price",
     "SUSPECT_SPREAD_PCT = 60.0",
     "SUSPECT_SPREAD_PCT = 1e9"),

    ("call any two items a duplicate name, so Onion and Potato collide",
     "            if ta < tb or tb < ta:",
     "            if True:"),

    ("weekday shape reports the period total, not the per-day rate",
     'round(w["bills"] / n, 1)',
     'round(w["bills"] / 1, 1)'),

    ("read the price history backwards, so a fall reads as a rise",
     'buys = sorted(it["buys"], key=lambda b: (b["date"], b["unit_price_rupees"]))',
     'buys = sorted(it["buys"], key=lambda b: (b["date"], b["unit_price_rupees"]),\n'
     '                      reverse=True)'),
]


def run_tests() -> bool:
    r = subprocess.run([sys.executable, "-m", "pytest", "tests/test_patterns.py", "-q"],
                       cwd=SERVER, capture_output=True, text=True)
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
            if old not in original:
                print(f"SKIP  {name}\n      anchor moved: {old!r}")
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
