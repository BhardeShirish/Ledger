"""The journey that makes the P&L trustworthy, on a copy of the real books.

Unit tests prove each rule. This proves the thing the owner will actually
do: open the page, see it refuse to answer, enter the standing costs it
asked for, and watch it start answering. If that loop does not close, the
whole feature is decoration.

Read-only on the live file — everything happens on a snapshot.

    cd server; python ..\\setup\\pnl_journey_check.py
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
SCRATCH = ROOT / "server" / "tests" / ".tmpjourney"

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

PW = "journey-pass-123456"
with sqlite3.connect(copy) as db:
    owner = next((r for r in db.execute("select id, username, role from users")
                  if r[2] == "owner"), None)
    if owner is None:
        sys.exit("no owner in the copied ledger")
    db.execute("update users set password_hash=?, failed_attempts=0,"
               " locked_until=null where id=?", (hash_password(PW), owner[0]))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

MONTH = "2026-08"
fails = []


def check(label, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if detail:
        print(f"        {detail}")
    if not ok:
        fails.append(label)


def count_expenses(c, start, end):
    """The server returns {'total', 'rows'} and caps rows at 200, so the
    count has to come from 'total' or a busy month reads as unchanged."""
    r = c.get("/api/expenses", params={"start": start, "end": end})
    assert r.status_code == 200, r.text
    return r.json()["total"]


with TestClient(app) as c:
    login = c.post("/api/auth/login", json={"username": owner[1], "password": PW})
    if login.status_code != 200:
        sys.exit(f"login failed: {login.text}")
    c.headers.update({"Authorization": "Bearer " + login.json()["token"]})

    cats = c.get("/api/lists/categories").json()
    cats = cats["items"] if isinstance(cats, dict) else cats
    by_name = {x["name"].lower(): x for x in cats}

    outlets = c.get("/api/outlets").json()
    if not outlets:
        sys.exit("no outlet in the copied ledger")
    OUTLET = outlets[0]["id"]

    print("\n1. Before anything is entered")
    d = c.get("/api/pnl/summary", params={"month": MONTH}).json()
    check("the page refuses to state a profit",
          d["totals"]["profit_known"] is False,
          d["totals"]["profit_unknown_why"] or "")
    check("the page refuses to state a break-even",
          d["breakeven"]["possible"] is False)
    check("it names exactly what is missing",
          bool(d["data_quality"]["missing_groups"]),
          ", ".join(d["data_quality"]["missing_groups"]))
    check("the top finding is the warning, not a compliment",
          d["findings"][0]["severity"] == "act",
          d["findings"][0]["title"])

    print("\n2. Every seeded category has a P&L line")
    ungrouped = [x["name"] for x in cats if not x.get("cost_group")]
    check("no category is left without a line", not ungrouped,
          ", ".join(ungrouped) or "all grouped")
    check("rent is on the occupancy line",
          by_name.get("rent", {}).get("cost_group") == "occupancy",
          str(by_name.get("rent", {}).get("cost_group_label")))
    check("vegetables are on the food line",
          by_name.get("vegetables & fruits", {}).get("cost_group") == "cogs_food")

    print("\n3. The owner enters the standing costs the page asked for")
    for name, cat, amount, day in [
        ("Shop rent", "rent", 45000, 5),
        ("Electricity", "electricity", 18000, 10),
        ("Internet", "internet & phone", 1200, 8),
    ]:
        cid = by_name.get(cat, {}).get("id")
        if cid is None:
            check(f"category {cat!r} exists", False)
            continue
        r = c.post("/api/recurring", json={
            "category_id": cid, "name": name, "amount_rupees": amount,
            "day_of_month": day, "start_month": "2026-05"})
        check(f"{name} saved", r.status_code == 201,
              f"posted {r.json().get('posted_now')} months" if r.status_code == 201
              else r.text[:200])

    print("\n4. Nothing was double-posted")
    before = c.get("/api/recurring").json()
    n1 = count_expenses(c, "2026-05-01", "2026-09-30")
    c.get("/api/pnl/summary", params={"month": MONTH})
    c.get("/api/pnl/summary", params={"month": MONTH})
    n2 = count_expenses(c, "2026-05-01", "2026-09-30")
    check("reloading the report posts nothing new", n1 == n2, f"{n1} then {n2}")
    check("the monthly standing total is right",
          before["monthly_total_rupees"] == 64200.0,
          str(before["monthly_total_rupees"]))

    print("\n5. Nothing was posted for a month that hasn't happened")
    future = count_expenses(c, "2026-10-01", "2027-12-31")
    check("no future rent", future == 0, f"{future} future rows")

    print("\n6. The page now answers what it refused to answer")
    d = c.get("/api/pnl/summary", params={"month": MONTH}).json()
    occ = next(l for l in d["lines"] if l["key"] == "occupancy")
    check("rent and power now appear", occ["rupees"] > 0,
          f"₹{occ['rupees']:,.0f} = {occ['percent_of_net']}% of net sales")
    check("occupancy is judged against its band",
          occ["status"] in ("good", "low", "high", "over"), occ["status"])
    check("food cost is still honestly reported as missing",
          "Food cost" in d["data_quality"]["missing_groups"],
          "profit stays withheld until the buying is logged too")

    print("\n7. With food cost logged as well, the whole page comes alive")
    veg = by_name["vegetables & fruits"]["id"]
    net = d["sales"]["net_rupees"]
    # A past month's buying is older than the 48h edit window, so the owner
    # must re-enter the password first — exactly what the screen asks for.
    su = c.post("/api/auth/stepup", json={"password": PW})
    check("owner can re-verify to enter last month's buying",
          su.status_code == 200, su.text[:200] if su.status_code != 200 else "")
    r = c.post("/api/expenses", json={
        "outlet_id": OUTLET, "business_date": f"{MONTH}-15", "category_id": veg,
        "amount_rupees": round(net * 0.30, 2), "mode": "cash",
        "item_name": "Month's vegetable buying", "description": "journey check"})
    check("a food purchase can be logged", r.status_code in (200, 201),
          r.text[:200] if r.status_code not in (200, 201) else "")
    d = c.get("/api/pnl/summary", params={"month": MONTH}).json()
    check("profit is now stated", d["totals"]["profit_known"] is True,
          f"₹{d['totals']['profit_rupees']:,.0f} "
          f"({d['totals']['profit_percent_of_net']}% of net sales)"
          if d["totals"]["profit_known"] else "")
    check("break-even is now stated", d["breakeven"]["possible"] is True,
          f"{d['breakeven'].get('bills_per_day')} bills/day vs "
          f"{d['breakeven'].get('actual_bills_per_day')} actual")
    check("prime cost is judged", d["prime_cost"]["status"] != "unlogged",
          f"{d['prime_cost']['percent_of_net']}% — {d['prime_cost']['status']}")
    check("the levers drop their assumption",
          all(l.get("assumed_food_cost_percent") is None
              for l in d["sensitivity"]))
    check("the 'not trustworthy' warning is gone",
          not any("trustworthy" in f["title"] for f in d["findings"]))
    print("\n  what the owner now reads:")
    for f in d["findings"]:
        print(f"    [{f['severity']:>5}] {f['title']}")

    print("\n8. Stopping a cost keeps the months it already paid")
    rid = before["items"][0]["id"]
    n_before = count_expenses(c, "2026-05-01", "2026-09-30")
    c.delete(f"/api/recurring/{rid}")
    c.get("/api/pnl/summary", params={"month": MONTH})
    n_after = count_expenses(c, "2026-05-01", "2026-09-30")
    check("history is preserved and nothing new posts",
          n_before == n_after, f"{n_before} then {n_after}")

shutil.rmtree(SCRATCH, ignore_errors=True)

print()
if fails:
    print(f"{len(fails)} step(s) failed:")
    for f in fails:
        print(f"  - {f}")
    raise SystemExit(1)
print("the whole journey holds up on the real books")
