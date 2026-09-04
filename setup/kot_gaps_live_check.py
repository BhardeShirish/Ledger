"""Run the kitchen-ticket check against a copy of the real books.

Tests prove the arithmetic; this proves the answer is worth reading.
Nothing here writes to the live database — it works on a snapshot.

    python setup\\kot_gaps_live_check.py
"""
import io
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

LIVE = Path(__file__).resolve().parents[1] / "server" / "data" / "ledger.db"
if not LIVE.exists():
    print(f"no live database at {LIVE} — nothing to check against")
    raise SystemExit(0)

tmp = Path(tempfile.mkdtemp(prefix="kotcheck-"))
shutil.copy(LIVE, tmp / "ledger.db")
os.environ["LEDGER_DATA_DIR"] = str(tmp)
os.environ["LEDGER_SECRET_KEY"] = "x" * 40
os.environ["LEDGER_TESTING"] = "1"

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import sqlite3  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.security import hash_password  # noqa: E402

# The snapshot is a throwaway, so give ourselves a way in rather than
# asking anyone to type the shop's real password into a script.
PW = "kot-check-pass-123456"
with sqlite3.connect(tmp / "ledger.db") as _db:
    _owner = _db.execute(
        "select id, username from users where role='owner' order by id").fetchone()
    if not _owner:
        sys.exit("no owner in the copied ledger")
    _db.execute("update users set password_hash=?, failed_attempts=0,"
                " locked_until=null where id=?", (hash_password(PW), _owner[0]))

failures = 0


def check(label, ok, note=""):
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  — {note}" if note else ""))
    if not ok:
        failures += 1


try:
    with TestClient(app) as c:
        r = c.post("/api/auth/login",
                   json={"username": _owner[1], "password": PW})
        if r.status_code != 200:
            sys.exit(f"could not sign in to the snapshot: {r.text[:200]}")
        c.headers.update({"Authorization": "Bearer " + r.json()["token"]})

        r = c.get("/api/patterns/kot-gaps",
                  params={"start": "2026-01-01", "end": "2026-12-31"})
        check("the report answers at all", r.status_code == 200, r.text[:200])
        if r.status_code != 200:
            raise SystemExit(1)
        d = r.json()
        t = d["totals"]

        print()
        print(f"  {t['days']} days, {t['bills']} bills, "
              f"{t['tickets_seen']} ticket numbers seen")
        print(f"  {t['unnumbered_bills']} bills carried no ticket number")
        print(f"  tickets unaccounted for: at least {t['missing_at_least']}, "
              f"at most {t['missing_at_most']}")
        print(f"  typically {t['typical_per_day']:g} a day")
        print(f"  worth at least ₹{t['value_at_least_rupees']:,.0f} "
              f"at each day's own average bill")
        print()
        for w in d["worst_days"][:5]:
            print(f"    {w['date']}: {w['missing_at_least']} missing of "
                  f"{w['tickets_seen']} raised — "
                  f"{', '.join(w['missing_numbers'][:8])}")
        print()
        for f in d["findings"]:
            print(f"    [{f['severity']}] {f['title']}")
            print(f"           {f['detail']}")
        print()

        check("the lower figure never exceeds the upper",
              t["missing_at_least"] <= t["missing_at_most"])
        check("no day reports a negative gap",
              all(x["missing_at_least"] >= 0 for x in d["days"]))
        check("every day's totals add up",
              t["missing_at_least"] == sum(x["missing_at_least"]
                                           for x in d["days"]))
        check("days come back in order",
              [x["date"] for x in d["days"]] ==
              sorted(x["date"] for x in d["days"]))
        check("no day claims more tickets seen than bills raised",
              all(x["tickets_seen"] + x["unnumbered_bills"] <= x["bills"]
                  for x in d["days"]))
        check("the worst day really is the worst",
              not d["worst_days"] or d["worst_days"][0]["missing_at_least"] ==
              max(x["missing_at_least"] for x in d["days"]))
        aug = c.get("/api/patterns/kot-gaps",
                    params={"start": "2026-08-01", "end": "2026-08-31"}).json()
        whole = {x["date"]: x["missing_at_least"] for x in d["days"]}
        check("one month's figures match the same days in the full period",
              all(whole.get(x["date"]) == x["missing_at_least"]
                  for x in aug["days"]),
              "a narrower window must not change a day's answer")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print("all checks passed" if not failures else f"{failures} check(s) failed")
raise SystemExit(1 if failures else 0)
