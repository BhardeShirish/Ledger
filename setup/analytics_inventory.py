"""Ask every analytics screen what it currently says about the real books.

An endpoint that exists, has a UI and passes its tests can still be
useless in practice — it can return an empty list, or findings so vague
nobody would act on them. This runs the whole analytics layer against a
copy of the real database and prints what an owner would actually read.

Read-only: everything happens on a snapshot.

    python setup\\analytics_inventory.py
"""
import io
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
LIVE = ROOT / "server" / "data" / "ledger.db"
if not LIVE.exists():
    sys.exit(f"no live database at {LIVE}")

tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="analytics-")))
shutil.copy(LIVE, tmp / "ledger.db")
os.environ["LEDGER_DATA_DIR"] = str(tmp)
os.environ["LEDGER_SECRET_KEY"] = "x" * 40
os.environ["LEDGER_TESTING"] = "1"

sys.path.insert(0, str(ROOT / "server"))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.security import hash_password  # noqa: E402

PW = "inventory-check-pass-123456"
with sqlite3.connect(tmp / "ledger.db") as db:
    owner = db.execute(
        "select id, username from users where role='owner' order by id").fetchone()
    db.execute("update users set password_hash=?, failed_attempts=0,"
               " locked_until=null where id=?", (hash_password(PW), owner[0]))
    last = db.execute("select max(business_date) from sales_bills").fetchone()[0]

MONTH = (last or "2026-08-01")[:7]
START = MONTH + "-01"
END = last or (MONTH + "-28")

SCREENS = [
    ("What you spend on / suppliers / prices", "/api/patterns/purchases",
     {"start": START, "end": END}),
    ("When you're busy", "/api/patterns/bills", {"start": START, "end": END}),
    ("Kitchen tickets without a bill", "/api/patterns/kot-gaps",
     {"start": START, "end": END}),
    ("The month's read (spend review)", "/api/advisor/review", {"month": MONTH}),
    ("Profit & loss against benchmarks", "/api/pnl/summary", {"month": MONTH}),
    ("Break-even", "/api/insights/breakeven", {"month": MONTH}),
    ("Benchmark", "/api/insights/benchmark", {"start": START, "end": END}),
    ("Unit economics", "/api/insights/unit-economics",
     {"start": START, "end": END}),
    ("Anomalies", "/api/insights/anomalies", {}),
    ("Days you forgot to log", "/api/insights/missing-logs", {}),
    ("Forecast", "/api/insights/forecast", {}),
    ("Budgets", "/api/insights/budgets", {"month": MONTH}),
    ("Menu items", "/api/insights/items", {"start": START, "end": END}),
]

empty = 0
try:
    with TestClient(app) as c:
        r = c.post("/api/auth/login",
                   json={"username": owner[1], "password": PW})
        c.headers.update({"Authorization": "Bearer " + r.json()["token"]})
        c.post("/api/auth/stepup", json={"password": PW})

        print(f"month {MONTH}, through {END}\n")
        for title, path, params in SCREENS:
            r = c.get(path, params=params)
            if r.status_code != 200:
                print(f"[{r.status_code}] {title}  {path}")
                print(f"        {r.text[:160]}\n")
                empty += 1
                continue
            d = r.json()
            print(f"{title}")
            if isinstance(d, list):
                print(f"        (a plain list of {len(d)} rows)"
                      if d else "        NOTHING TO SAY — screen would be blank")
                empty += 0 if d else 1
                print()
                continue
            findings = d.get("findings") or []
            if not findings:
                # Not every screen writes sentences. Some return figures, and
                # a figures screen with real numbers in it is not "blank" —
                # saying so would send a reader chasing a bug that isn't there.
                nums = {k: v for k, v in d.items()
                        if isinstance(v, (int, float)) and v
                        and not isinstance(v, bool)}
                keys = [k for k, v in d.items()
                        if isinstance(v, (list, dict)) and v]
                if keys or nums:
                    parts = []
                    if keys:
                        parts.append(", ".join(keys[:4]))
                    if nums:
                        parts.append(", ".join(
                            f"{k}={v:,.0f}" for k, v in list(nums.items())[:4]))
                    print(f"        (figures, no written findings: "
                          f"{'; '.join(parts)})")
                else:
                    print("        NOTHING TO SAY — screen would be blank")
                    empty += 1
            for f in findings[:4]:
                print(f"        [{f.get('severity', '?')}] {f.get('title', '')}")
            if len(findings) > 4:
                print(f"        … and {len(findings) - 4} more")
            print()
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(f"{len(SCREENS)} screens checked, {empty} with nothing to say")
