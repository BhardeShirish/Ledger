"""Break the part-paid-bill handling on purpose and check the tests notice.

Every mutation here is a way the drawer could start lying: by inventing
cash that may never have arrived, by hiding the doubt, or by leaking one
day's part payments into another.

    python setup\\mutate_cash_split.py
"""
import io
import subprocess
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
SRC = SERVER / "app" / "routers" / "dayclose.py"
TESTS = ["tests/test_cash_split.py", "tests/test_losses.py"]

MUTATIONS = [
    ("assume every part payment was cash, inventing a shortage",
     "expected = opening + cash_sales - cash_expenses - advances - losses",
     "expected = opening + cash_sales + split_unknown - cash_expenses - advances - losses"),

    ("hide the doubt entirely, so a surplus looks like a mistake",
     '        "split_unknown_paise": split_unknown,\n',
     '        "split_unknown_paise": 0,\n'),

    ("read part payments for the whole outlet, not just this day",
     "                    .filter_by(outlet_id=outlet_id, business_date=d,\n"
     "                               channel_kind=\"split\").all())",
     "                    .filter_by(outlet_id=outlet_id,\n"
     "                               channel_kind=\"split\").all())"),

    ("count online-only sales as part paid, doubting a clean day",
     'channel_kind="split").all())',
     'channel_kind="upi").all())'),

    ("lose a hand-written split, which has the same doubt as an imported one",
     '        (r.total_paise if r.source == "petpooja" else (r.amount_paise or 0))\n'
     "        for r in split_rows)",
     '        (r.total_paise if r.source == "petpooja" else 0)\n'
     "        for r in split_rows)"),

    ("let the doubt absorb the variance, so a real surplus disappears",
     "    row.variance_paise = counted - exp[\"expected_paise\"]",
     "    row.variance_paise = max(0, counted - exp[\"expected_paise\"]"
     " - exp[\"split_unknown_paise\"])"),
]


def run_tests() -> bool:
    r = subprocess.run([sys.executable, "-m", "pytest", *TESTS, "-q", "-x"],
                       cwd=SERVER, capture_output=True, text=True,
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
