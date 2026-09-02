"""Multi-line bill entry (bulk expenses)."""
from datetime import date, timedelta


def _today():
    return date.today().isoformat()


def test_bulk_creates_one_expense_per_line(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    cats = client.get("/api/lists/categories").json()
    rc = next(c for c in cats if c["name"].lower().startswith("raw"))
    v = client.post("/api/vendors", json={"name": "Bulk Veg Mart"}).json()

    r = client.post("/api/expenses/bulk", json={
        "outlet_id": outlet_id, "business_date": _today(),
        "category_id": rc["id"], "vendor_id": v["id"], "mode": "cash",
        "note": "sabzi weekly",
        "lines": [
            {"item_name": "Onion", "quantity": 10, "unit": "kg", "amount_rupees": 350},
            {"item_name": "Tomato", "quantity": 8, "unit": "kg", "amount_rupees": 240},
            {"item_name": "Coriander", "unit": "bunch", "amount_rupees": 30},
        ]})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["created"] == 3

    rows = client.get("/api/expenses", params={
        "outlet_id": outlet_id, "start": _today(), "end": _today()}).json()["rows"]
    mine = [x for x in rows if x["vendor_id"] == v["id"]]
    names = {x["description"] for x in mine}
    assert any("Onion" in n for n in names)
    total = sum(x["amount_rupees"] for x in mine)
    assert abs(total - 620) < 0.01

    # unit economics sees the qty lines
    ue = client.get("/api/insights/unit-economics", params={
        "start": _today(), "end": _today(), "q": "onion"}).json()
    onion = next(x for x in ue if x["item"] == "Onion")
    assert onion["cheapest_unit_price"] == 35.0


def test_bulk_reconciles_bill_total_remainder(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    cats = client.get("/api/lists/categories").json()
    rc = next(c for c in cats if c["name"].lower().startswith("raw"))
    v = client.post("/api/vendors", json={"name": "Atta Supplier"}).json()
    r = client.post("/api/expenses/bulk", json={
        "outlet_id": outlet_id, "business_date": _today(),
        "category_id": rc["id"], "mode": "cash", "vendor_id": v["id"],
        "bill_total_rupees": 500,
        "note": "printed bill higher",
        "lines": [
            {"item_name": "Atta", "quantity": 10, "unit": "kg", "amount_rupees": 400},
        ]})
    assert r.status_code == 201
    assert r.json()["created"] == 2          # line + adjustment row
    rows = client.get("/api/expenses", params={
        "outlet_id": outlet_id, "start": _today(),
        "end": _today()}).json()["rows"]
    adj = [x for x in rows if "Other charges" in x["description"]]
    assert any(abs(x["amount_rupees"] - 100) < 0.01 for x in adj)


def test_bulk_mismatch_reported_when_lines_exceed_total(client, outlet_id):
    cats = client.get("/api/lists/categories").json()
    rc = next(c for c in cats if c["name"].lower().startswith("raw"))
    r = client.post("/api/expenses/bulk", json={
        "outlet_id": outlet_id, "business_date": _today(),
        "category_id": rc["id"], "mode": "cash",
        "bill_total_rupees": 100,
        "lines": [{"item_name": "Paneer", "unit": "kg",
                   "amount_rupees": 300}]})
    assert r.status_code == 201
    assert r.json()["mismatch_rupees"] == -200.0   # flagged, not silently dropped
    # only the item line exists; no negative expense created
    rows = client.get("/api/expenses", params={
        "outlet_id": outlet_id, "start": _today(),
        "end": _today()}).json()["rows"]
    assert all(x["description"] != "" for x in rows)


def test_bulk_requires_vendor_when_qty(client, outlet_id):
    cats = client.get("/api/lists/categories").json()
    rc = next(c for c in cats if c["name"].lower().startswith("raw"))
    r = client.post("/api/expenses/bulk", json={
        "outlet_id": outlet_id, "business_date": _today(),
        "category_id": rc["id"],
        "lines": [{"item_name": "Rice", "quantity": 5,
                   "unit": "kg", "amount_rupees": 300}]})
    assert r.status_code == 422 and "vendor" in r.json()["detail"]


def test_bulk_rejects_old_dates_for_manager(manager, outlet_id):
    old = (date.today() - timedelta(days=9)).isoformat()
    r = manager.post("/api/expenses/bulk", json={
        "outlet_id": outlet_id, "business_date": old,
        "category_id": 1, "mode": "cash",
        "lines": [{"item_name": "X", "amount_rupees": 50}]})
    assert r.status_code == 403
