"""Run the endpoint sweep against a COPY of the real ledger.

An empty test ledger exercises none of the shapes real books contain -
part-paid advances, closed days, wastage, months with no sales. This copies
the live database, gives the copy a known owner password, and walks every
GET route on it. The original is never opened for writing.
"""
import os
import shutil
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIVE = ROOT / "server" / "data" / "ledger.db"
SCRATCH = ROOT / "server" / "tests" / ".tmplive"

if not LIVE.exists():
    sys.exit(f"no live database at {LIVE}")

shutil.rmtree(SCRATCH, ignore_errors=True)
SCRATCH.mkdir(parents=True)
copy = SCRATCH / "ledger.db"

# Snapshot through sqlite so a live writer cannot hand us a torn file.
source, dest = sqlite3.connect(f"file:{LIVE}?mode=ro", uri=True), sqlite3.connect(copy)
try:
    source.backup(dest)
    assert dest.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
finally:
    dest.close()
    source.close()

os.environ["LEDGER_DATA_DIR"] = str(SCRATCH)
os.environ["LEDGER_SECRET_KEY"] = "y" * 40
os.environ["LEDGER_TESTING"] = "1"

sys.path.insert(0, str(ROOT / "server"))
from app.security import hash_password  # noqa: E402

with sqlite3.connect(copy) as db:
    rows = db.execute("select id, username, role from users").fetchall()
    owner = next((r for r in rows if r[2] == "owner"), None)
    if owner is None:
        sys.exit("no owner in the copied ledger")
    db.execute("update users set password_hash=?, failed_attempts=0, locked_until=null"
               " where id=?", (hash_password("sweep-pass-123456"), owner[0]))
    counts = {t: db.execute(f"select count(*) from {t}").fetchone()[0]
              for t in ("expenses", "sales_daily", "sales_bills", "employees",
                        "attendance", "vendors", "stock_items", "day_closures")}

print(f"copied ledger: {counts}")
print(f"owner: {owner[1]}")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from tests.test_every_endpoint_answers import ROUTES  # noqa: E402

failures, unfilled = [], []
with TestClient(app) as c:
    login = c.post("/api/auth/login",
                   json={"username": owner[1], "password": "sweep-pass-123456"})
    if login.status_code != 200:
        sys.exit(f"login failed: {login.text}")
    c.headers.update({"Authorization": f"Bearer {login.json()['token']}"})
    c.post("/api/auth/stepup", json={"password": "sweep-pass-123456"})

    outlets = c.get("/api/outlets").json()
    oid = outlets[0]["id"] if outlets else 1

    # Fill each route's own declared query parameters, rather than guessing one
    # set for all of them - a 422 would otherwise hide whatever the handler
    # does once it actually runs.
    spec = c.get("/api/openapi.json").json()
    VALUES = {
        "outlet_id": oid, "employee_id": 1, "vendor_id": 1, "category_id": 1,
        "month": "2026-09", "day": "2026-09-04", "date": "2026-09-04",
        "start": "2026-08-01", "end": "2026-09-04", "from_date": "2026-08-01",
        "to_date": "2026-09-04", "days": 30, "limit": 20, "offset": 0,
        "kind": "", "q": "", "status": "", "item_id": 1, "period": "month",
    }
    for template, url in ROUTES:
        params, missing = {}, []
        for p in spec.get("paths", {}).get(template, {}).get("get", {}).get("parameters", []):
            if p.get("in") != "query":
                continue
            name = p["name"]
            if name in VALUES:
                params[name] = VALUES[name]
            elif p.get("required"):
                missing.append(name)
        if missing:
            print(f"  ??   -   {template}  (unknown required params: {missing})")
        r = c.get(url, params=params)
        flag = "FAIL" if r.status_code >= 500 else ("422 " if r.status_code == 422 else "ok  ")
        if r.status_code >= 500:
            failures.append((template, r.status_code, r.text[:300]))
        elif r.status_code == 422:
            unfilled.append((template, r.text[:200]))
        print(f"  {flag} {r.status_code} {template}")

print()
for template, code, body in failures:
    print(f"FAILED {template} -> {code}\n  {body}\n")
for template, body in unfilled:
    print(f"STILL 422 {template}\n  {body}\n")
print(f"{len(ROUTES)} routes, {len(failures)} failing, {len(unfilled)} still 422 on real data")
shutil.rmtree(SCRATCH, ignore_errors=True)
sys.exit(1 if failures else 0)
