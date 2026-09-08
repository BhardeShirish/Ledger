"""Correcting an expense must correct the stock it created.

An expense with a quantity and a purchase movement are two halves of one
fact. Before this, editing the amount left the old unit cost in stock, and
deleting the expense left the goods on the shelf forever.
"""
from datetime import date, timedelta


def _setup(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    cats = client.get("/api/lists/categories").json()
    cat = next(c for c in cats if c["name"].lower().startswith("raw"))
    vendor = client.post("/api/vendors", json={"name": "Edit Test Traders"}).json()
    return cat["id"], vendor["id"]


def _item(client, outlet_id, name):
    """Overview carries the quantity; the items list carries the last price."""
    inv = client.get("/api/inventory/overview", params={"outlet_id": outlet_id}).json()
    rows = [x for x in inv["items"]
            if " ".join(x["name"].lower().split()) == name.lower()]
    if not rows:
        return None
    priced = client.get("/api/inventory/items", params={"outlet_id": outlet_id}).json()
    by_id = {p["id"]: p for p in priced}
    return {**by_id.get(rows[0]["id"], {}), **rows[0]}


def _buy(client, outlet_id, cat_id, vendor_id, item, qty, rupees):
    r = client.post("/api/expenses", json={
        "outlet_id": outlet_id, "business_date": date.today().isoformat(),
        "category_id": cat_id, "vendor_id": vendor_id,
        "amount_rupees": rupees, "mode": "upi",
        "item_name": item, "quantity": qty, "unit": "kg"})
    assert r.status_code == 201, r.text
    return r.json()


def test_an_expense_can_be_corrected(client, outlet_id):
    cat_id, vendor_id = _setup(client, outlet_id)
    e = _buy(client, outlet_id, cat_id, vendor_id, "Edit Onions", 5, 500)

    r = client.patch(f"/api/expenses/{e['id']}", json={
        "amount_rupees": 650, "mode": "cash", "description": "corrected"})
    assert r.status_code == 200, r.text
    assert r.json()["amount_rupees"] == 650
    assert r.json()["mode"] == "cash"
    assert r.json()["description"] == "corrected"


def test_correcting_the_amount_reprices_the_stock(client, outlet_id):
    cat_id, vendor_id = _setup(client, outlet_id)
    e = _buy(client, outlet_id, cat_id, vendor_id, "Edit Rice", 10, 800)
    before = _item(client, outlet_id, "Edit Rice")
    assert before and abs(before["current_qty"] - 10) < 0.01

    client.patch(f"/api/expenses/{e['id']}", json={"amount_rupees": 900})

    after = _item(client, outlet_id, "Edit Rice")
    # The goods did not change, only what was paid for them.
    assert abs(after["current_qty"] - 10) < 0.01, "an edit duplicated the stock"
    assert abs(after["last_unit_price_rupees"] - 90) < 0.01, after


def test_deleting_the_expense_takes_the_stock_back_off_the_shelf(client, outlet_id):
    cat_id, vendor_id = _setup(client, outlet_id)
    e = _buy(client, outlet_id, cat_id, vendor_id, "Edit Dal", 7, 700)
    before = _item(client, outlet_id, "Edit Dal")
    assert before and abs(before["current_qty"] - 7) < 0.01

    assert client.delete(f"/api/expenses/{e['id']}").status_code == 200

    after = _item(client, outlet_id, "Edit Dal")
    assert abs((after["current_qty"] if after else 0)) < 0.01, \
        "goods stayed in stock after the purchase was deleted"


def test_an_edit_cannot_invent_a_payment_mode(client, outlet_id):
    cat_id, vendor_id = _setup(client, outlet_id)
    e = _buy(client, outlet_id, cat_id, vendor_id, "Edit Oil", 2, 400)
    r = client.patch(f"/api/expenses/{e['id']}", json={"mode": "bitcoin"})
    assert r.status_code == 422, r.text


def test_an_edit_cannot_zero_the_amount(client, outlet_id):
    cat_id, vendor_id = _setup(client, outlet_id)
    e = _buy(client, outlet_id, cat_id, vendor_id, "Edit Salt", 1, 100)
    assert client.patch(f"/api/expenses/{e['id']}",
                        json={"amount_rupees": 0}).status_code == 422


def test_an_old_expense_needs_the_owner_password_again(fresh_owner, outlet_id):
    cats = fresh_owner.get("/api/lists/categories").json()
    cat_id = cats[0]["id"]
    old = (date.today() - timedelta(days=90)).isoformat()
    fresh_owner.post("/api/auth/stepup", json={"password": "change-me-please"})
    e = fresh_owner.post("/api/expenses", json={
        "outlet_id": outlet_id, "business_date": old, "category_id": cat_id,
        "amount_rupees": 300, "mode": "upi", "description": "long ago"}).json()
    fresh_owner.post("/api/auth/stepdown")

    blocked = fresh_owner.patch(f"/api/expenses/{e['id']}", json={"amount_rupees": 350})
    assert blocked.status_code == 403, blocked.text

    fresh_owner.post("/api/auth/stepup", json={"password": "change-me-please"})
    allowed = fresh_owner.patch(f"/api/expenses/{e['id']}", json={"amount_rupees": 350})
    assert allowed.status_code == 200, allowed.text


def test_a_new_expense_defaults_to_upi(client, outlet_id):
    """The dropdown starts on UPI; the API must agree, or an omitted mode
    would silently lower the cash drawer."""
    cats = client.get("/api/lists/categories").json()
    r = client.post("/api/expenses", json={
        "outlet_id": outlet_id, "business_date": date.today().isoformat(),
        "category_id": cats[0]["id"], "amount_rupees": 120,
        "description": "no mode given"})
    assert r.status_code == 201, r.text
    assert r.json()["mode"] == "upi"


def test_expense_create_and_update_reject_malformed_and_future_dates(client, outlet_id):
    cat_id, vendor_id = _setup(client, outlet_id)
    base = {"outlet_id": outlet_id, "category_id": cat_id, "vendor_id": vendor_id,
            "amount_rupees": 100, "mode": "upi"}
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    for business_date in ("not-a-date", tomorrow):
        r = client.post("/api/expenses", json={**base, "business_date": business_date})
        assert r.status_code == 422, r.text
        assert "date" in r.json()["detail"].lower()
    expense = _buy(client, outlet_id, cat_id, vendor_id, "Date Edit Rice", 1, 100)
    for business_date in ("not-a-date", tomorrow):
        r = client.patch(f"/api/expenses/{expense['id']}",
                         json={"business_date": business_date})
        assert r.status_code == 422, r.text
        assert "date" in r.json()["detail"].lower()
