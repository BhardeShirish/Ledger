"""Inventory intelligence is evidence, not an inferred stock ledger."""
from datetime import date, timedelta

from app.db import SessionLocal
from app.models import (Expense, PurchaseOrder, SalesItem, StockCount, StockCountLine,
                        StockItem, StockLink, StockMovement)


def _dates():
    end = date.today()
    return (end - timedelta(days=14)).isoformat(), end.isoformat()


def _evidence(db, *, outlet_id=1, name="Rice", current=2, par=10, minimum=3):
    item = StockItem(outlet_id=outlet_id, name=name, name_key=name.lower(),
                     base_unit="kg", current_qty=current, par_qty=par, min_qty=minimum)
    db.add(item)
    db.flush()
    db.add(StockLink(outlet_id=outlet_id, stock_item_id=item.id,
                     menu_item_name="Rice bowl", coefficient=0.25, status="confirmed"))
    start, end = _dates()
    first = (date.fromisoformat(start) + timedelta(days=1)).isoformat()
    second = (date.fromisoformat(start) + timedelta(days=8)).isoformat()
    db.add_all([
        SalesItem(outlet_id=outlet_id, business_date=first, item_name="Rice bowl", qty=10),
        SalesItem(outlet_id=outlet_id, business_date=second, item_name="Rice bowl", qty=10),
        StockMovement(outlet_id=outlet_id, stock_item_id=item.id, business_date=first,
                      type="purchase", qty=10, unit_cost_paise=8000),
        StockMovement(outlet_id=outlet_id, stock_item_id=item.id, business_date=second,
                      type="purchase", qty=10, unit_cost_paise=8500),
    ])
    count = StockCount(outlet_id=outlet_id, business_date=second, status="done")
    db.add(count)
    db.flush()
    db.add(StockCountLine(count_id=count.id, stock_item_id=item.id,
                          system_qty=6, counted_qty=5))
    return item, start, end


def test_confirmed_recipe_expected_usage_never_creates_stock_movement(client):
    with SessionLocal() as db:
        item, start, end = _evidence(db)
        db.commit()
        item_id = item.id
    response = client.get("/api/inventory/intelligence", params={
        "outlet_id": 1, "start": start, "end": end,
    })
    assert response.status_code == 200, response.text
    row = next(row for row in response.json()["items"] if row["stock_item_id"] == item_id)
    assert row["expected_consumption_qty"] == 5
    assert row["expected_consumption_unit"] == "kg"
    with SessionLocal() as db:
        assert db.query(StockMovement).filter_by(stock_item_id=item_id).count() == 2


def test_missing_sales_withholds_consumption_velocity_and_reorder(client):
    start, end = _dates()
    with SessionLocal() as db:
        item = StockItem(outlet_id=1, name="No Sales", name_key="no sales", base_unit="kg",
                         current_qty=1, par_qty=10, min_qty=3)
        db.add(item)
        db.flush()
        db.add(StockLink(outlet_id=1, stock_item_id=item.id, menu_item_name="Silent dish",
                         coefficient=1, status="confirmed"))
        db.commit()
        item_id = item.id
    response = client.get("/api/inventory/intelligence", params={
        "outlet_id": 1, "start": start, "end": end,
    })
    assert response.status_code == 200, response.text
    row = next(row for row in response.json()["items"] if row["stock_item_id"] == item_id)
    assert row["expected_consumption_qty"] is None
    assert row["velocity_per_day"] is None
    assert row["reorder_recommendation_qty"] is None
    assert row["risk"] is None


def test_unconfirmed_recipe_withholds_consumption_even_when_sales_exist(client):
    start, end = _dates()
    with SessionLocal() as db:
        item = StockItem(outlet_id=1, name="Unconfirmed", name_key="unconfirmed",
                         base_unit="kg", current_qty=1, par_qty=10, min_qty=3)
        db.add(item)
        db.flush()
        db.add_all([
            StockLink(outlet_id=1, stock_item_id=item.id, menu_item_name="Known dish",
                      coefficient=1, status="suggested"),
            SalesItem(outlet_id=1, business_date=start, item_name="Known dish", qty=4),
            SalesItem(outlet_id=1, business_date=end, item_name="Known dish", qty=4),
        ])
        db.commit()
        item_id = item.id
    response = client.get("/api/inventory/intelligence", params={
        "outlet_id": 1, "start": start, "end": end,
    })
    row = next(row for row in response.json()["items"] if row["stock_item_id"] == item_id)
    assert row["confirmed_recipe_links"] == 0
    assert row["expected_consumption_qty"] is None
    assert row["reorder_recommendation_qty"] is None


def test_count_variance_uses_the_frozen_count_snapshot(client):
    with SessionLocal() as db:
        item, start, end = _evidence(db, current=99)
        db.commit()
        item_id = item.id
    response = client.get("/api/inventory/intelligence", params={
        "outlet_id": 1, "start": start, "end": end,
    })
    row = next(row for row in response.json()["items"] if row["stock_item_id"] == item_id)
    assert row["count_variances"] == [{
        "date": (date.fromisoformat(start) + timedelta(days=8)).isoformat(),
        "system_qty": 6, "counted_qty": 5, "variance_qty": -1,
    }]


def test_reorder_selection_creates_only_an_unapproved_purchase_draft(client):
    with SessionLocal() as db:
        item, start, end = _evidence(db)
        db.commit()
        item_id = item.id
    vendor = client.post("/api/vendors", json={"name": "Evidence supplier"}).json()
    category = next(row for row in client.get("/api/lists/categories").json()
                    if row["name"].lower().startswith("raw"))
    response = client.post("/api/purchases/orders/from-inventory-intelligence", json={
        "outlet_id": 1, "vendor_id": vendor["id"], "category_id": category["id"],
        "payment_mode": "credit", "stock_item_ids": [item_id], "start": start, "end": end,
    })
    assert response.status_code == 201, response.text
    order = response.json()
    assert order["status"] == "draft"
    assert order["approved_at"] is None
    assert order["receipt"] is None
    assert order["lines"][0]["quantity"] == 8
    with SessionLocal() as db:
        assert db.query(PurchaseOrder).filter_by(id=order["id"], status="draft").count() == 1
        assert db.query(Expense).count() == 0
        assert db.query(StockMovement).filter_by(stock_item_id=item_id).count() == 2


def test_inventory_intelligence_respects_outlet_access(client, manager):
    other = client.post("/api/outlets", json={"name": "Other evidence outlet"}).json()["id"]
    with SessionLocal() as db:
        _evidence(db, outlet_id=other, name="Other rice")
        db.commit()
    start, end = _dates()
    assert manager.get("/api/inventory/intelligence", params={
        "outlet_id": other, "start": start, "end": end,
    }).status_code == 403
