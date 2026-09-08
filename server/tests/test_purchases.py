"""Purchase orders remain plans until an approved receipt is finalized."""
from datetime import date, timedelta

from app.db import SessionLocal
from app.models import Expense, StockMovement, VendorEntry


def _order(client, outlet_id, *, mode="credit", quantity=10, price=80):
    vendor = client.post("/api/vendors", json={"name": f"PO Vendor {mode}"}).json()
    category = next(row for row in client.get("/api/lists/categories").json()
                    if row["name"].lower().startswith("raw"))
    response = client.post("/api/purchases/orders", json={
        "outlet_id": outlet_id, "vendor_id": vendor["id"], "category_id": category["id"],
        "payment_mode": mode, "lines": [{"item_name": "PO Test Rice", "quantity": quantity,
                                         "unit": "kg", "unit_cost_rupees": price}],
    })
    assert response.status_code == 201, response.text
    return response.json(), vendor, category


def _receipt(order, day=None, *, quantity=8, price=90):
    return {"business_date": day or date.today().isoformat(), "finalize": True,
            "idempotency_key": f"test-receipt-{order['id']}-{day or 'today'}",
            "lines": [{"order_line_id": order["lines"][0]["id"], "received_quantity": quantity,
                       "unit": "kg", "unit_price_rupees": price}]}


def test_manager_can_draft_but_cannot_edit_approve_or_cancel(manager, outlet_id):
    order, _, _ = _order(manager, outlet_id, mode="cash")
    body = {**order, "lines": [{"item_name": "PO Test Rice", "quantity": 1,
                                "unit": "kg", "unit_cost_rupees": 1}]}
    assert manager.put(f"/api/purchases/orders/{order['id']}", json=body).status_code == 403
    assert manager.post(f"/api/purchases/orders/{order['id']}/approve").status_code == 403
    assert manager.post(f"/api/purchases/orders/{order['id']}/cancel").status_code == 403


def test_receiving_requires_owner_approval(client, outlet_id):
    order, _, _ = _order(client, outlet_id, mode="cash")
    response = client.post(f"/api/purchases/orders/{order['id']}/receive", json=_receipt(order))
    assert response.status_code == 409
    assert response.json()["detail"].startswith("An owner must approve")


def test_draft_receipt_posts_nothing_until_explicit_finalization(client, outlet_id):
    order, vendor, _ = _order(client, outlet_id, mode="credit")
    assert client.post(f"/api/purchases/orders/{order['id']}/approve").status_code == 200
    draft = _receipt(order)
    draft["finalize"] = False
    response = client.post(f"/api/purchases/orders/{order['id']}/receive", json=draft)
    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    assert response.json()["receipt"]["status"] == "draft"
    with SessionLocal() as db:
        assert db.query(Expense).filter(Expense.description.like(f"PO #{order['id']}%")).count() == 0
        assert db.query(StockMovement).count() == 0
        assert db.query(VendorEntry).filter_by(vendor_id=vendor["id"]).count() == 0


def test_finalized_receipt_posts_expense_stock_and_credit_once(client, outlet_id):
    order, vendor, _ = _order(client, outlet_id)
    assert client.post(f"/api/purchases/orders/{order['id']}/approve").status_code == 200
    payload = _receipt(order)
    first = client.post(f"/api/purchases/orders/{order['id']}/receive", json=payload)
    second = client.post(f"/api/purchases/orders/{order['id']}/receive", json=payload)
    assert first.status_code == second.status_code == 200
    changed = {**payload, "lines": [{**payload["lines"][0], "received_quantity": 9}]}
    assert client.post(f"/api/purchases/orders/{order['id']}/receive",
                       json=changed).status_code == 409
    assert first.json()["status"] == "received"
    line = first.json()["receipt"]["lines"][0]
    assert line["short_quantity"] == 2
    assert line["price_variance_paise"] == 1000
    with SessionLocal() as db:
        expenses = db.query(Expense).filter(Expense.description.like(f"PO #{order['id']}%")).all()
        assert len(expenses) == 1
        assert expenses[0].amount_paise == 72_000
        assert len(db.query(StockMovement).filter_by(ref_expense_id=expenses[0].id).all()) == 1
        assert len(db.query(VendorEntry).filter_by(expense_id=expenses[0].id).all()) == 1
        assert db.query(VendorEntry).filter_by(vendor_id=vendor["id"]).count() == 1
        expense_id = expenses[0].id
    assert client.patch(f"/api/expenses/{expense_id}", json={"amount_rupees": 1}).status_code == 409
    assert client.delete(f"/api/expenses/{expense_id}").status_code == 409


def test_closed_period_blocks_receipt_without_posting(client, outlet_id):
    old = date.today().replace(day=1) - timedelta(days=1)
    order, _, _ = _order(client, outlet_id, mode="cash")
    assert client.post(f"/api/purchases/orders/{order['id']}/approve").status_code == 200
    assert client.post("/api/auth/stepup", json={"password": "change-me-please"}).status_code == 200
    close = client.post("/api/control/month/close", json={
        "outlet_id": outlet_id, "month": old.strftime("%Y-%m"), "force": True, "reason": "PO test",
    })
    assert close.status_code == 200, close.text
    response = client.post(f"/api/purchases/orders/{order['id']}/receive",
                           json=_receipt(order, old.isoformat()))
    assert response.status_code == 423
    with SessionLocal() as db:
        assert db.query(Expense).filter(Expense.description.like(f"PO #{order['id']}%")).count() == 0
        assert db.query(StockMovement).count() == 0


def test_purchase_order_outlet_isolation(client, manager, outlet_id):
    other = client.post("/api/outlets", json={"name": "PO Other Outlet"}).json()["id"]
    order, _, _ = _order(client, other, mode="cash")
    assert manager.get(f"/api/purchases/orders/{order['id']}").status_code == 403
    assert manager.get("/api/purchases/orders", params={"outlet_id": other}).status_code == 403
