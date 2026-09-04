"""Prove an existing shop can still sign in after the hashing change.

The work factor now travels inside the stored hash. Every password in a
real ledger was written before that, in the old three-part form. If those
stopped opening, a shop would be locked out of its own books by an
upgrade — so this signs in against a copy of the real database, with
testing mode off, exactly as the shop's own machine would.

    python setup\\password_upgrade_check.py
"""
import hashlib
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

tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="pwcheck-")))
shutil.copy(LIVE, tmp / "ledger.db")
os.environ["LEDGER_DATA_DIR"] = str(tmp)
os.environ["LEDGER_SECRET_KEY"] = "x" * 40
# Deliberately NOT set: this must behave like the shop's own machine.
os.environ.pop("LEDGER_TESTING", None)

sys.path.insert(0, str(ROOT / "server"))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.security import hash_password  # noqa: E402

PW = "upgrade-check-pass-123456"
OLD = "old-format-pass-7890"

with sqlite3.connect(tmp / "ledger.db") as db:
    owner = db.execute(
        "select id, username from users where role='owner' order by id").fetchone()
    if not owner:
        sys.exit("no owner in the copied ledger")
    # One user keeps a hash in the old three-part form, written exactly the
    # way the previous version wrote it.
    salt = os.urandom(16)
    dk = hashlib.scrypt(OLD.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    db.execute("update users set password_hash=?, failed_attempts=0,"
               " locked_until=null where id=?",
               (f"scrypt${salt.hex()}${dk.hex()}", owner[0]))

failures = 0


def check(label, ok, note=""):
    global failures
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  — {note}" if note else ""))
    if not ok:
        failures += 1


try:
    with TestClient(app) as c:
        r = c.post("/api/auth/login",
                   json={"username": owner[1], "password": OLD})
        check("a password stored the old way still signs in",
              r.status_code == 200, r.text[:160])

        r2 = c.post("/api/auth/login",
                    json={"username": owner[1], "password": "not-the-password"})
        check("the wrong password is still refused", r2.status_code != 200)

        # Now save a password the new way and confirm it opens too.
        with sqlite3.connect(tmp / "ledger.db") as db:
            db.execute("update users set password_hash=?, failed_attempts=0,"
                       " locked_until=null where id=?",
                       (hash_password(PW), owner[0]))
        r3 = c.post("/api/auth/login",
                    json={"username": owner[1], "password": PW})
        check("a password stored the new way signs in", r3.status_code == 200,
              r3.text[:160])

        with sqlite3.connect(tmp / "ledger.db") as db:
            stored = db.execute("select password_hash from users where id=?",
                                (owner[0],)).fetchone()[0]
        check("a real machine still hashes at full strength",
              stored.split("$")[0] == "scrypt16384", stored.split("$")[0])
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print("all checks passed" if not failures else f"{failures} check(s) failed")
raise SystemExit(1 if failures else 0)
