"""Run the review, bill patterns and purchases against the real books.

Read-only on the live file: snapshots through sqlite, gives the copy a
known password, prints what an owner would see. Nothing is written back.

    cd server; python ..\\setup\\patterns_live_check.py
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
SCRATCH = ROOT / "server" / "tests" / ".tmppatterns"

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
os.environ["LEDGER_SECRET_KEY"] = "y" * 40
os.environ["LEDGER_TESTING"] = "1"
sys.path.insert(0, str(ROOT / "server"))

from app.security import hash_password  # noqa: E402

PW = "patterns-pass-123456"
with sqlite3.connect(copy) as db:
    owner = next((r for r in db.execute("select id, username, role from users")
                  if r[2] == "owner"), None)
    if owner is None:
        sys.exit("no owner in the copied ledger")
    db.execute("update users set password_hash=?, failed_attempts=0,"
               " locked_until=null where id=?", (hash_password(PW), owner[0]))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def show(title, findings):
    print("\n" + "=" * 74)
    print(title)
    print("=" * 74)
    for f in findings:
        print(f"  [{f['severity']:>5}] {f['title']}")
        print(f"          {f['detail']}")


with TestClient(app) as c:
    login = c.post("/api/auth/login", json={"username": owner[1], "password": PW})
    if login.status_code != 200:
        sys.exit(f"login failed: {login.text}")
    c.headers.update({"Authorization": f"Bearer {login.json()['token']}"})

    r = c.get("/api/patterns/bills", params={"start": "2026-05-01",
                                             "end": "2026-08-25"})
    print(f"/patterns/bills -> HTTP {r.status_code}")
    if r.status_code == 200:
        d = r.json()
        t = d["totals"]
        print(f"  {t['bills']:,} bills, ₹{t['rupees']:,.0f}, "
              f"{t['days_open']} days, avg ticket ₹{t['avg_ticket_rupees']:,.0f}")
        print("  busiest hours:", ", ".join(
            f"{h['hour']:02d}:00 ₹{h['rupees']:,.0f}"
            for h in sorted(d["hours"], key=lambda x: -x["rupees"])[:4]))
        print("  forecast next week: ₹%s" % (
            f"{d['forecast']['week_rupees']:,.0f}"
            if d["forecast"]["week_rupees"] else "not enough history"))
        for day in d["forecast"]["days"]:
            v = f"₹{day['rupees']:,.0f}" if day["rupees"] is not None else "—"
            print(f"    {day['date']} {day['weekday']:<10} {v:>12}"
                  f"  (from {day['based_on_days']} days)")
        show("BILL PATTERNS", d["findings"])
    else:
        print(r.text[:500])

    r = c.get("/api/patterns/purchases", params={"start": "2026-01-01",
                                                 "end": "2026-12-31"})
    print(f"\n/patterns/purchases -> HTTP {r.status_code}")
    if r.status_code == 200:
        d = r.json()
        print(f"  ₹{d['totals']['rupees']:,.0f} over {d['totals']['entries']} "
              f"entries, {d['totals']['items_price_tracked']} items priced")
        show("PURCHASES", d["findings"])
    else:
        print(r.text[:500])

    r = c.get("/api/advisor/review", params={"month": "2026-08"})
    if r.status_code == 200:
        show("SPEND REVIEW (2026-08)", r.json()["findings"])

shutil.rmtree(SCRATCH, ignore_errors=True)
print("\nscratch copy removed.")
