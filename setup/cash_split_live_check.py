"""The part-paid-bill doubt, measured on a copy of the real books.

Read-only on the live file — everything happens on a snapshot.

    cd server; python ..\\setup\\cash_split_live_check.py
"""
import io
import os
import shutil
import sqlite3
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
LIVE = ROOT / "server" / "data" / "ledger.db"
SCRATCH = ROOT / "server" / "tests" / ".tmpsplit"

if not LIVE.exists():
    sys.exit(f"no live database at {LIVE}")

shutil.rmtree(SCRATCH, ignore_errors=True)
SCRATCH.mkdir(parents=True)
copy = SCRATCH / "ledger.db"
src, dst = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True), sqlite3.connect(copy)
try:
    src.backup(dst)
finally:
    dst.close()
    src.close()

os.environ["LEDGER_DATA_DIR"] = str(SCRATCH)
os.environ["LEDGER_SECRET_KEY"] = "z" * 40
os.environ["LEDGER_TESTING"] = "1"
sys.path.insert(0, str(ROOT / "server"))

from app.security import hash_password  # noqa: E402

PW = "split-check-pass-123456"
with sqlite3.connect(copy) as db:
    owner = next((r for r in db.execute("select id, username, role from users")
                  if r[2] == "owner"), None)
    if owner is None:
        sys.exit("no owner in the copied ledger")
    db.execute("update users set password_hash=?, failed_attempts=0,"
               " locked_until=null where id=?", (hash_password(PW), owner[0]))
    days = [r[0] for r in db.execute(
        "select distinct business_date from sales_daily"
        " where channel_kind='split' order by business_date desc limit 5")]
    total = db.execute(
        "select count(*), coalesce(sum(total_paise),0) from sales_daily"
        " where channel_kind='split'").fetchone()

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

fails = []


def check(label, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if detail:
        print(f"        {detail}")
    if not ok:
        fails.append(label)


with TestClient(app) as c:
    login = c.post("/api/auth/login", json={"username": owner[1], "password": PW})
    if login.status_code != 200:
        sys.exit(f"login failed: {login.text}")
    c.headers.update({"Authorization": "Bearer " + login.json()["token"]})
    outlet = c.get("/api/outlets").json()[0]["id"]

    print(f"\nThe real books hold {total[0]} part-paid days "
          f"worth ₹{total[1] / 100:,.0f}")
    print("That much cash reached the till without the report saying so.\n")

    print("Days that carry the doubt")
    for d in days:
        r = c.get("/api/cash/day", params={"outlet_id": outlet, "date": d})
        j = r.json()
        check(f"{d} states its unknown",
              j.get("split_unknown_paise", 0) > 0,
              f"expected ₹{j['expected_paise'] / 100:,.0f}, "
              f"could be up to ₹{j.get('split_unknown_paise', 0) / 100:,.0f} more")

    print("\nA day with no part payments carries no doubt")
    clean = next((r[0] for r in sqlite3.connect(copy).execute(
        "select business_date from sales_daily where business_date not in"
        " (select business_date from sales_daily where channel_kind='split')"
        " limit 1")), None)
    if clean:
        j = c.get("/api/cash/day",
                  params={"outlet_id": outlet, "date": clean}).json()
        check(f"{clean} is stated plainly",
              j.get("split_unknown_paise", 0) == 0, "no unknown")

    print("\nThe doubt never moves the expected drawer")
    # A closed day deliberately shows its frozen expectation rather than
    # today's hindsight, so the arithmetic can only be re-derived on a day
    # that is still open.
    live_day = None
    for d in days:
        j = c.get("/api/cash/day", params={"outlet_id": outlet, "date": d}).json()
        if not j.get("frozen"):
            live_day = (d, j)
            break
    if live_day is None:
        check("an open part-paid day exists to check", False,
              "every part-paid day is closed and frozen")
    else:
        d, j = live_day
        cash_only = (j["opening_paise"] + j["cash_sales_paise"]
                     - j["cash_expenses_paise"] - j["advances_given_paise"]
                     - j["cash_losses_paise"])
        check(f"expected on {d} is built from known cash alone",
              j["expected_paise"] == cash_only,
              f"₹{j['expected_paise'] / 100:,.0f} with "
              f"₹{j['split_unknown_paise'] / 100:,.0f} stated separately, "
              "not folded in")

shutil.rmtree(SCRATCH, ignore_errors=True)

print()
if fails:
    print(f"{len(fails)} check(s) failed:")
    for f in fails:
        print(f"  - {f}")
    raise SystemExit(1)
print("the drawer tells the truth about part-paid bills")
