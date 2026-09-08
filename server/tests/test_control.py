"""Day-close control, credit accounting, money config, split allocation."""
from datetime import date, timedelta

from app.db import SessionLocal
from app.models import Expense, SalesBill


def _today():
    return date.today().isoformat()


def _old(days=10):
    return (date.today() - timedelta(days=days)).isoformat()


def test_reopen_rights_matrix(client, manager, fresh_owner, outlet_id):
    h = fresh_owner
    h.post("/api/auth/stepup", json={"password": "change-me-please"})
    day = h.get("/api/cash/day", params={"outlet_id": outlet_id, "date": _today()}).json()
    counted = max(0, round(day["expected_paise"] / 100, 2))
    cl = h.post("/api/cash/close", headers=None, json={
        "outlet_id": outlet_id, "date": _today(),
        "counted_rupees": counted,
        "taken_home_rupees": counted, "note": ""})
    assert cl.status_code == 200
    cid = cl.json()["id"]

    # closed day shows frozen numbers; owner may re-close DIRECTLY (auto-reopen)
    again = h.post("/api/cash/close", json={
        "outlet_id": outlet_id, "date": _today(),
        "counted_rupees": max(0, counted - 25),
        "taken_home_rupees": 0, "note": "recount correction"})
    assert again.status_code == 200, again.text
    assert again.json()["counted_paise"] == round(max(0, counted - 25) * 100)
    # manager closing a PAST day over an existing closure stays blocked
    mgr = manager.post("/api/cash/close", json={
        "outlet_id": outlet_id, "date": _old(5),
        "counted_rupees": 1})
    assert mgr.status_code in (403, 428)

    # manager reopens TODAY fine
    r = manager.post(f"/api/cash/{cid}/reopen")
    assert r.status_code == 200, r.text
    # manager closes again, then owner path works too
    d2 = h.get("/api/cash/day", params={"outlet_id": outlet_id, "date": _today()}).json()
    cl2 = h.post("/api/cash/close", json={
        "outlet_id": outlet_id, "date": _today(),
        "counted_rupees": max(0, round(d2["expected_paise"] / 100, 2)),
        "taken_home_rupees": 0, "note": ""})
    cid2 = cl2.json()["id"]

    # an OLD closure: owner without elevation → blocked by window; with → ok
    old = h.get("/api/cash/closures", params={"outlet_id": outlet_id}).json()["rows"][0]
    r = h.post(f"/api/cash/{old['id']}/reopen")   # elevated already in fresh_owner? stepdown not called
    # be explicit:
    h.post("/api/auth/stepdown")
    r = h.post(f"/api/cash/{cid2}/reopen")
    assert r.status_code in (200, 403)  # today → within window → 200 for anyone
    h.post("/api/auth/stepup", json={"password": "change-me-please"})


def test_cash_close_rejects_impossible_values(client, outlet_id):
    for counted, taken in [(-1, 0), (100, -1), (100, 101)]:
        response = client.post("/api/cash/close", json={
            "outlet_id": outlet_id, "date": _today(),
            "counted_rupees": counted, "taken_home_rupees": taken,
        })
        assert response.status_code == 422


def test_credit_purchase_creates_expense(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    v = client.post("/api/vendors", json={"name": "Credit Veg Mart"}).json()
    cats = client.get("/api/lists/categories").json()
    raw_cat = next((c for c in cats if c["name"].lower().startswith("raw")), cats[0])
    day = _today()
    r = client.post(f"/api/vendors/{v['id']}/entries", json={
        "outlet_id": outlet_id, "date": day, "type": "purchase_credit",
        "amount_rupees": 4000, "expense_category_id": raw_cat["id"],
        "note": "weekly vegetables"})
    assert r.status_code == 201

    db = SessionLocal()
    exp = (db.query(Expense)
             .filter(Expense.vendor_id == v["id"], Expense.mode == "credit").all())
    db.close()
    assert len(exp) == 1 and exp[0].amount_paise == 400_000

    # payment settles dues but adds NO expense
    p = client.post(f"/api/vendors/{v['id']}/entries", json={
        "outlet_id": outlet_id, "date": day, "type": "payment",
        "amount_rupees": 1500, "mode": "cash"})
    assert p.status_code == 201
    ledger = client.get(f"/api/vendors/{v['id']}/ledger").json()
    assert ledger["vendor"]["balance_rupees"] == 2500
    db = SessionLocal()
    n = (db.query(Expense).filter(Expense.vendor_id == v["id"]).count())
    db.close()
    assert n == 1  # only the credit purchase


def test_money_config_defaults(client, manager):
    r = manager.get("/api/lists/money-config")
    assert r.status_code == 200
    cfg = r.json()
    assert cfg["code"] == "INR" and cfg["symbol"] == "₹"
    assert cfg["restaurant_name"] == "My restaurant"
    assert 500 in cfg["denominations"] and 1 in cfg["denominations"]
    # manager cannot change it
    w = manager.put("/api/admin/settings",
                    json={"key": "currency_symbol", "value": "$"})
    assert w.status_code in (403, 428)


def test_business_name_is_configurable_and_cannot_be_blank(client):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    changed = client.put("/api/admin/settings", json={
        "key": "restaurant_name", "value": "Corner Cafe",
    })
    assert changed.status_code == 200, changed.text
    assert client.get("/api/lists/money-config").json()["restaurant_name"] == "Corner Cafe"

    blank = client.put("/api/admin/settings", json={
        "key": "restaurant_name", "value": "   ",
    })
    assert blank.status_code == 422


def test_split_allocation(client, outlet_id):
    """Import one part-payment bill then allocate it across channels."""
    from tests.test_importer import bill_row, build_xlsx
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    xlsx = build_xlsx([
        bill_row(7001, "2026-08-03 20:00:00", "Part Payment", my=300.0,
                 tax=15.0, total=315.0),
    ])
    up = client.post("/api/imports/upload", params={"outlet_id": outlet_id},
                     files={"file": ("s.xlsx", xlsx, "application/octet-stream")}).json()
    client.post(f"/api/imports/{up['batch_id']}/commit")

    splits = client.get("/api/sales/unresolved-splits",
                        params={"outlet_id": outlet_id}).json()
    target = next(b for b in splits if b["invoice_no"] == "7001")

    bad = client.post(f"/api/sales/bills/{target['id']}/allocate-split",
                      json={"allocations": [{"channel_kind": "cash", "amount_rupees": 100}]})
    assert bad.status_code == 422          # must match exactly
    invalid = client.post(f"/api/sales/bills/{target['id']}/allocate-split",
                          json={"allocations": [
                              {"channel_kind": "split", "amount_rupees": 115},
                              {"channel_kind": "upi", "amount_rupees": 200}]})
    assert invalid.status_code == 422

    ok = client.post(f"/api/sales/bills/{target['id']}/allocate-split",
                     json={"allocations": [
                         {"channel_kind": "cash", "amount_rupees": 115},
                         {"channel_kind": "upi", "amount_rupees": 200}]})
    assert ok.status_code == 200, ok.text
    sheet = client.get("/api/sales/sheet",
                       params={"outlet_id": outlet_id, "date": "2026-08-03"}).json()
    by_kind = {r["channel_kind"]: r for r in sheet["all_rows"]}
    assert by_kind["split"]["imported"]["bills"] == 0
    assert (by_kind["cash"]["imported"]["bills"] +
            by_kind["upi"]["imported"]["bills"]) == 1
    assert abs(by_kind["cash"]["imported"]["total_paise"] / 100 - 115.0) < 0.001
    assert abs(by_kind["upi"]["imported"]["total_paise"] / 100 - 200.0) < 0.001

    db = SessionLocal()
    b = db.get(SalesBill, target["id"])
    db.close()
    assert b.channel_kind == "upi"         # primary channel wins
