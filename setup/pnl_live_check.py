"""Run the P&L against a snapshot of the real books.

A fixture proves the code does what I told it to. Only real data proves
the answers are worth showing an owner. Read-only on the live file: it
snapshots through sqlite, gives the copy a known password, prints what an
owner would see, and never writes back.

    cd server; python ..\\setup\\pnl_live_check.py
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
SCRATCH = ROOT / "server" / "tests" / ".tmppnl"

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

PW = "pnl-pass-123456"
with sqlite3.connect(copy) as db:
    owner = next((r for r in db.execute("select id, username, role from users")
                  if r[2] == "owner"), None)
    if owner is None:
        sys.exit("no owner in the copied ledger")
    db.execute("update users set password_hash=?, failed_attempts=0,"
               " locked_until=null where id=?", (hash_password(PW), owner[0]))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def report(d):
    s, p = d["sales"], d["prime_cost"]
    print(f"  net sales {s['net_rupees']:,.0f} (ex-GST) from {s['bills']:,} "
          f"bills over {s['days_open']} days")
    print(f"  measured on: {d['measured_on']}; days "
          f"{d['period']['days_counted']}/{d['period']['days_in_month']}"
          f"{' (part month)' if d['period']['partial'] else ''}")
    print(f"  payroll: {d['payroll']['headcount']} staff, "
          f"{d['payroll']['monthly_rupees']:,.0f}/month")
    print(f"\n  {'line':<18}{'rupees':>12}{'% net':>8}  band        status")
    for ln in d["lines"]:
        pct = "-" if ln["percent_of_net"] is None else f"{ln['percent_of_net']}%"
        band = f"{ln['band_low']:.0f}-{ln['band_high']:.0f}%"
        print(f"  {ln['label']:<18}{ln['rupees']:>12,.0f}{pct:>8}  "
              f"{band:<11} {ln['status']}")
    pct = "-" if p["percent_of_net"] is None else f"{p['percent_of_net']}%"
    band = f"{p['band_low']:.0f}-{p['band_high']:.0f}%"
    print(f"  {'PRIME COST':<18}{p['rupees']:>12,.0f}{pct:>8}  "
          f"{band:<11} {p['status']}")
    t = d["totals"]
    if t["profit_known"]:
        print(f"  {'profit':<18}{t['profit_rupees']:>12,.0f}"
              f"{str(t['profit_percent_of_net']) + '%':>8}")
    else:
        print(f"  {'profit':<18}{'withheld':>12}   {t['profit_unknown_why']}")
    be = d["breakeven"]
    if be.get("possible"):
        print(f"\n  break-even {be['bills_per_day']} bills/day "
              f"(actually {be['actual_bills_per_day']}), "
              f"contribution margin {be['contribution_margin_percent']}%")
    else:
        print(f"\n  break-even: withheld — {be.get('why')}")
    pb = d["per_bill"]
    print(f"  per bill: net {pb['net_rupees']}, cost {pb['cost_rupees']}, "
          f"profit {pb['profit_rupees']}, contribution {pb['contribution_rupees']}")
    roll = d["rolling_food_cost"]
    print(f"  rolling {roll['days']}d food cost: {roll['percent_of_net']}% "
          f"({roll['cogs_rupees']:,.0f} of {roll['net_rupees']:,.0f})")
    print("  levers:")
    for lev in d["sensitivity"]:
        print(f"    {lev['lever']:<34} {lev['monthly_rupees']:>10,.0f}/month")
    print("\n  findings:")
    for x in d["findings"]:
        print(f"    [{x['severity']:>5}] {x['title']}")
        print(f"            {x['detail']}")


with TestClient(app) as c:
    login = c.post("/api/auth/login", json={"username": owner[1], "password": PW})
    if login.status_code != 200:
        sys.exit(f"login failed: {login.text}")
    c.headers.update({"Authorization": "Bearer " + login.json()["token"]})

    for month in ("2026-08", "2026-07"):
        r = c.get("/api/pnl/summary", params={"month": month})
        print(f"\n{'=' * 74}\n/pnl/summary month={month} -> HTTP {r.status_code}")
        if r.status_code != 200:
            print(r.text[:900])
            continue
        report(r.json())

    print(f"\n{'=' * 74}\nstanding costs")
    r = c.get("/api/recurring")
    body = r.json() if r.status_code == 200 else r.text[:300]
    print(f"/recurring -> HTTP {r.status_code}: {body}")

shutil.rmtree(SCRATCH, ignore_errors=True)
