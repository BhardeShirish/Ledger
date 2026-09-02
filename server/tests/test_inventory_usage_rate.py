"""A usage rate needs an interval to measure.

One purchase of 10kg does not mean 10kg is used per day, but that is what a
span of 1 implies. Every item then reported ~1 day of cover and the overview
flagged all of them as "needs attention" - an alarm that is always on tells
the owner nothing.
"""

from app.db import SessionLocal
from app.models import StockItem, StockMovement
from app.routers.inventory import _usage_per_day


def stepup(client):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})


def _item(outlet_id, name, qty=0.0):
    db = SessionLocal()
    try:
        it = StockItem(outlet_id=outlet_id, name=name, name_key=name.lower(),
                       base_unit="kg",
                       current_qty=qty, par_qty=0, min_qty=0, yield_percent=100,
                       is_active=True)
        db.add(it)
        db.commit()
        return it.id
    finally:
        db.close()


def _purchase(outlet_id, item_id, day, qty):
    db = SessionLocal()
    try:
        db.add(StockMovement(outlet_id=outlet_id, stock_item_id=item_id,
                             type="purchase", qty=qty, business_date=day,
                             unit_cost_paise=1000))
        db.commit()
    finally:
        db.close()


def _rates(outlet_id):
    db = SessionLocal()
    try:
        return _usage_per_day(db, outlet_id, days=3650)
    finally:
        db.close()


def test_one_purchase_gives_no_usage_rate(client, outlet_id):
    item = _item(outlet_id, "single-buy onion", qty=10)
    _purchase(outlet_id, item, "2026-08-01", 10)

    assert item not in _rates(outlet_id), \
        "one purchase implied the whole quantity is consumed that same day"


def test_two_purchases_measure_the_interval_between_them(client, outlet_id):
    item = _item(outlet_id, "repeat-buy rice", qty=20)
    _purchase(outlet_id, item, "2026-08-01", 10)
    _purchase(outlet_id, item, "2026-08-11", 10)

    # 20kg bought across a 10-day interval -> 2kg/day.
    assert _rates(outlet_id)[item] == 2.0


def test_cover_is_unknown_rather_than_alarming_for_a_single_purchase(client, outlet_id):
    """The overview must not flag an item it cannot forecast."""
    item = _item(outlet_id, "lonely turmeric", qty=5)
    _purchase(outlet_id, item, "2026-08-05", 5)
    stepup(client)

    r = client.get(f"/api/inventory/overview?outlet_id={outlet_id}")
    assert r.status_code == 200, r.text
    row = next(x for x in r.json()["items"] if x["id"] == item)

    assert row["days_of_cover"] is None
    assert row["usage_per_day"] == 0
