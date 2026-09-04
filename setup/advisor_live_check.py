"""See what the spend review actually says about the real books.

Read-only on the live file: it snapshots through sqlite, gives the copy a
known password, and prints the review. Nothing is written back.

    cd server; python ..\\setup\\advisor_live_check.py
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
SCRATCH = ROOT / "server" / "tests" / ".tmpadvisor"

if not LIVE.exists():
    sys.exit(f"no live database at {LIVE}")

shutil.rmtree(SCRATCH, ignore_errors=True)
SCRATCH.mkdir(parents=True)
copy = SCRATCH / "ledger.db"
source, dest = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True), sqlite3.connect(copy)
try:
    source.backup(dest)
finally:
    dest.close()
    source.close()

os.environ["LEDGER_DATA_DIR"] = str(SCRATCH)
os.environ["LEDGER_SECRET_KEY"] = "y" * 40
os.environ["LEDGER_TESTING"] = "1"
sys.path.insert(0, str(ROOT / "server"))

from app.security import hash_password  # noqa: E402

PW = "advisor-pass-123456"
with sqlite3.connect(copy) as db:
    owner = next((r for r in db.execute("select id, username, role from users")
                  if r[2] == "owner"), None)
    if owner is None:
        sys.exit("no owner in the copied ledger")
    db.execute("update users set password_hash=?, failed_attempts=0,"
               " locked_until=null where id=?", (hash_password(PW), owner[0]))
    months = db.execute(
        "select substr(business_date,1,7) m, count(*) from expenses"
        " group by m order by m").fetchall()
print("expense months in the real ledger:", months)

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

with TestClient(app) as c:
    login = c.post("/api/auth/login", json={"username": owner[1], "password": PW})
    if login.status_code != 200:
        sys.exit(f"login failed: {login.text}")
    c.headers.update({"Authorization": f"Bearer {login.json()['token']}"})

    for month, _ in months or [(None, 0)]:
        r = c.get("/api/advisor/review", params={"month": month} if month else {})
        print("\n" + "=" * 72)
        print(f"{month}  ->  HTTP {r.status_code}")
        if r.status_code != 200:
            print(r.text[:500])
            continue
        d = r.json()
        t = d["totals"]
        print(f"  spend ₹{t['spend_rupees']:,.0f} (prev ₹{t['prev_spend_rupees']:,.0f})"
              f"   sales ₹{t['sales_rupees']:,.0f}"
              f"   rows {d['data_quality']['expenses_this_month']}"
              f"/{d['data_quality']['expenses_prev_month']}")
        for f in d["findings"]:
            print(f"  [{f['severity']:>5}] {f['title']}")
            print(f"          {f['detail']}")

shutil.rmtree(SCRATCH, ignore_errors=True)
print("\nscratch copy removed.")
