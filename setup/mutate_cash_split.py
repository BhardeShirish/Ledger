"""Break the part-paid-bill handling on purpose and check the tests notice.

Every mutation here is a way the drawer could start lying: by inventing
cash that may never have arrived, by hiding the doubt, or by leaking one
day's part payments into another.

    python setup\\mutate_cash_split.py
"""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from mutants import check  # noqa: E402

SRC = "server/app/routers/dayclose.py"

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


if __name__ == "__main__":
    raise SystemExit(check(['tests/test_cash_split.py', 'tests/test_losses.py'], [(SRC, *m) for m in MUTATIONS]))
