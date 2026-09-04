"""Bill patterns and purchase patterns.

Each rule gets a scenario built to trigger it and, where it matters, a
scenario built to *not* trigger it — an analytics page that cries wolf is
worse than one that says nothing.
"""
from datetime import date, timedelta

import pytest

from app.db import SessionLocal
from app.models import Expense, ExpenseCategory, SalesBill, Vendor

# A fixed Monday, so every weekday assertion is derived rather than guessed.
ANCHOR = date(2025, 6, 2)
assert ANCHOR.weekday() == 0
END = ANCHOR + timedelta(days=55)          # 8 whole weeks later


def _bill(db, when: date, hour: int, rupees: float, *, n=1,
          order_type="Dine In", channel="cash", discount=0.0, tip=0.0,
          stamped=True):
    for i in range(n):
        db.add(SalesBill(
            outlet_id=1, business_date=when.isoformat(),
            invoice_no=f"{when.isoformat()}-{hour}-{i}-{rupees}-{order_type}",
            bill_ts=f"{when.isoformat()} {hour:02d}:30:00" if stamped else "",
            order_type=order_type, area="Dining", channel_kind=channel,
            gross_paise=int(rupees * 100), discount_paise=int(discount * 100),
            net_paise=int(rupees * 100), tip_paise=int(tip * 100),
            total_paise=int(rupees * 100)))


def _get(c, path, **params):
    r = c.get(path, params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _titles(d):
    return " | ".join(f["title"] for f in d["findings"])


def _find(d, needle):
    for f in d["findings"]:
        if needle.lower() in f["title"].lower():
            return f["title"] + " — " + f["detail"]
    raise AssertionError(f"no finding for {needle!r} in: {_titles(d)}")


# ── bill patterns ───────────────────────────────────────────────────────────

@pytest.fixture()
def trade(client):
    """Eight weeks of a shop with two rushes and a big Sunday."""
    with SessionLocal() as db:
        d = ANCHOR
        while d <= END:
            if d.weekday() == 6:                      # Sunday: the big day
                _bill(db, d, 10, 200, n=20)
                _bill(db, d, 20, 200, n=20)
            elif d.weekday() == 1:                    # Tuesday: the dead day
                _bill(db, d, 10, 200, n=3)
                _bill(db, d, 20, 200, n=2)
            else:
                _bill(db, d, 10, 200, n=8)
                _bill(db, d, 16, 200, n=1)            # the afternoon lull
                _bill(db, d, 20, 200, n=7)
            d += timedelta(days=1)
        db.commit()
    return client


def test_hour_curve_counts_only_stamped_bills(client):
    with SessionLocal() as db:
        _bill(db, ANCHOR, 14, 100, n=3)
        _bill(db, ANCHOR, 0, 100, n=2, stamped=False)
        db.commit()
    d = _get(client, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=ANCHOR.isoformat())
    hours = {h["hour"]: h["bills"] for h in d["hours"]}
    assert hours[14] == 3
    assert sum(hours.values()) == 3, "untimed bills must not land in an hour"
    assert d["totals"]["bills"] == 5, "but they still count as bills"
    assert d["totals"]["bills_without_a_time"] == 2
    assert "no time on them" in _find(d, "no time")


def test_weekday_shape_is_per_day_not_total(trade):
    d = _get(trade, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=END.isoformat())
    wd = {w["name"]: w for w in d["weekdays"]}
    assert wd["Sunday"]["bills_per_day"] == 40
    assert wd["Tuesday"]["bills_per_day"] == 5
    # eight Sundays, so the total must be eight times the daily figure
    assert wd["Sunday"]["days_open"] == 8
    assert wd["Sunday"]["rupees"] == wd["Sunday"]["rupees_per_day"] * 8


def test_calls_out_the_weekday_spread(trade):
    d = _get(trade, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=END.isoformat())
    f = _find(d, "Sunday is worth")
    assert "8.0×" in f and "Tuesday" in f


def test_finds_the_lull_between_two_rushes(trade):
    d = _get(trade, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=END.isoformat())
    f = _find(d, "quiet stretch")
    assert "16:00" in f, f
    assert "10:00" in f and "20:00" in f


def test_ticket_buckets_add_up(trade):
    d = _get(trade, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=END.isoformat())
    assert sum(t["bills"] for t in d["tickets"]) == d["totals"]["bills"]
    band = {t["label"]: t["bills"] for t in d["tickets"]}
    assert band["₹100–₹300"] == d["totals"]["bills"], "every bill here is ₹200"


def test_flags_a_shop_living_on_tiny_tickets(client):
    with SessionLocal() as db:
        _bill(db, ANCHOR, 10, 50, n=70)      # under ₹100
        _bill(db, ANCHOR, 20, 500, n=30)
        db.commit()
    d = _get(client, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=ANCHOR.isoformat())
    assert "70% of bills are under ₹100" in _titles(d)


def test_stays_quiet_when_tickets_are_healthy(trade):
    d = _get(trade, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=END.isoformat())
    assert "under ₹100" not in _titles(d)


def test_names_a_channel_nobody_uses(client):
    with SessionLocal() as db:
        _bill(db, ANCHOR, 10, 200, n=100, order_type="Dine In")
        _bill(db, ANCHOR, 11, 100, n=1, order_type="Pick Up")
        db.commit()
    d = _get(client, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=ANCHOR.isoformat())
    assert "Pick Up is only" in _titles(d)


def test_flags_heavy_discounting_but_praises_light(client):
    with SessionLocal() as db:
        _bill(db, ANCHOR, 10, 100, n=10, discount=20)   # 20% of gross
        db.commit()
    d = _get(client, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=ANCHOR.isoformat())
    assert "Discounts are 20.0% of gross" in _titles(d)
    assert d["leakage"]["discount_rupees"] == 200

    with SessionLocal() as db:
        _bill(db, ANCHOR + timedelta(days=1), 10, 100, n=200)
        db.commit()
    d2 = _get(client, "/api/patterns/bills",
              start=ANCHOR.isoformat(), end=(ANCHOR + timedelta(days=1)).isoformat())
    assert "Discounts are under control" in _titles(d2)


# ── the forecast ────────────────────────────────────────────────────────────

def test_forecast_is_weekday_aware(trade):
    d = _get(trade, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=END.isoformat())
    days = {f["weekday"]: f["rupees"] for f in d["forecast"]["days"]}
    assert days["Sunday"] == 8000.0, days      # 40 bills x ₹200
    assert days["Tuesday"] == 1000.0, days     # 5 bills x ₹200
    assert d["forecast"]["week_rupees"] > 0


def test_forecast_starts_the_day_after_the_data_ends(trade):
    d = _get(trade, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=END.isoformat())
    first = d["forecast"]["days"][0]
    assert first["date"] == (END + timedelta(days=1)).isoformat()
    assert len(d["forecast"]["days"]) == 7


def test_forecast_uses_the_median_so_one_wedding_cannot_skew_it(client):
    """Four quiet Mondays and one enormous one must not raise every Monday."""
    with SessionLocal() as db:
        for w in range(4):
            _bill(db, ANCHOR + timedelta(days=7 * w), 12, 1000, n=1)
        _bill(db, ANCHOR + timedelta(days=28), 12, 50000, n=1)   # the outlier
        db.commit()
    end = ANCHOR + timedelta(days=28)
    d = _get(client, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=end.isoformat())
    mon = next(f for f in d["forecast"]["days"] if f["weekday"] == "Monday")
    assert mon["rupees"] == 1000.0, "a mean would have said 10,800"


def test_forecast_admits_when_a_weekday_has_no_history(client):
    with SessionLocal() as db:
        _bill(db, ANCHOR, 12, 500, n=2)      # one Monday only
        db.commit()
    d = _get(client, "/api/patterns/bills",
             start=ANCHOR.isoformat(), end=ANCHOR.isoformat())
    assert all(f["rupees"] is None for f in d["forecast"]["days"])
    assert d["forecast"]["week_rupees"] is None
    assert len(d["forecast"]["unforecastable_weekdays"]) == 7


def test_growth_trend_across_months(client):
    with SessionLocal() as db:
        for i in range(28):                       # a quiet month
            _bill(db, date(2025, 4, 1) + timedelta(days=i), 12, 100, n=1)
        for i in range(28):                       # then double
            _bill(db, date(2025, 5, 1) + timedelta(days=i), 12, 200, n=1)
        db.commit()
    d = _get(client, "/api/patterns/bills", start="2025-04-01", end="2025-05-28")
    assert "up 100%" in _find(d, "Daily takings")


def test_empty_period_says_so_without_crashing(client):
    d = _get(client, "/api/patterns/bills", start="2019-01-01", end="2019-01-31")
    assert d["totals"]["bills"] == 0
    assert "No bills in this period" in _titles(d)


def test_rejects_a_backwards_window(client):
    r = client.get("/api/patterns/bills?start=2025-06-30&end=2025-06-01")
    assert r.status_code == 422


# ── purchases ───────────────────────────────────────────────────────────────

def _cat(db, name):
    c = db.query(ExpenseCategory).filter(ExpenseCategory.name == name).first()
    if c is None:
        c = ExpenseCategory(name=name, is_active=True, sort=99)
        db.add(c)
        db.flush()
    return c.id


def _vendor(db, name):
    v = db.query(Vendor).filter(Vendor.name == name).first()
    if v is None:
        v = Vendor(name=name, is_active=True)
        db.add(v)
        db.flush()
    return v.id


def _buy(db, when: date, cat, rupees, *, item="", qty=None, unit="", vendor=None):
    db.add(Expense(outlet_id=1, business_date=when.isoformat(),
                   category_id=_cat(db, cat), amount_paise=int(rupees * 100),
                   mode="upi", item_name=item, quantity=qty, unit=unit,
                   vendor_id=_vendor(db, vendor) if vendor else None))


@pytest.fixture()
def shopping(client):
    with SessionLocal() as db:
        # a dominant supplier
        _buy(db, ANCHOR, "Groceries", 5000, item="Rice", qty=50, unit="kg",
             vendor="Sharma Kirana")                       # ₹100/kg
        _buy(db, ANCHOR + timedelta(days=7), "Groceries", 3000,
             item="Rice", qty=20, unit="kg", vendor="Sharma Kirana")  # ₹150/kg
        _buy(db, ANCHOR + timedelta(days=14), "Groceries", 3200,
             item="Rice", qty=20, unit="kg", vendor="Sharma Kirana")  # ₹160/kg
        # a small second supplier, and a name that duplicates Rice
        _buy(db, ANCHOR + timedelta(days=2), "Vegetables", 500,
             item="Sona Masoori Rice", qty=5, unit="kg", vendor="Sabzi Bhaiya")
        # something bought as a lump sum, so it cannot be price-tracked
        _buy(db, ANCHOR + timedelta(days=3), "Repairs", 900, vendor="Sabzi Bhaiya")
        db.commit()
    return client


def test_ranks_categories_and_vendors(shopping):
    d = _get(shopping, "/api/patterns/purchases",
             start=ANCHOR.isoformat(), end=END.isoformat())
    assert d["categories"][0]["name"] == "Groceries"
    assert d["categories"][0]["rupees"] == 11200
    assert d["vendors"][0]["name"] == "Sharma Kirana"
    assert d["vendors"][0]["orders"] == 3
    assert "supplies 89% of your buying" in _titles(d)


def test_tracks_how_often_and_at_what_price(shopping):
    d = _get(shopping, "/api/patterns/purchases",
             start=ANCHOR.isoformat(), end=END.isoformat())
    rice = next(i for i in d["items"] if i["item"] == "Rice")
    assert rice["times_bought"] == 3
    assert rice["avg_days_between"] == 7.0
    assert rice["first_unit_price_rupees"] == 100
    assert rice["last_unit_price_rupees"] == 160
    assert rice["change_percent"] == 60.0
    assert [h["date"] for h in rice["history"]] == sorted(
        h["date"] for h in rice["history"]), "history must read forwards"
    assert "Bought most often: Rice" in _titles(d)


def test_flags_the_price_climbing(shopping):
    d = _get(shopping, "/api/patterns/purchases",
             start=ANCHOR.isoformat(), end=END.isoformat())
    f = _find(d, "Rice is 60% dearer")
    assert "₹100.00/kg" in f and "₹160.00/kg" in f


def test_flags_a_price_spread_that_looks_like_a_typo(client):
    with SessionLocal() as db:
        _buy(db, ANCHOR, "Groceries", 500, item="Rice", qty=10, unit="kg")
        _buy(db, ANCHOR, "Groceries", 1000, item="Rice", qty=10, unit="kg")
        db.commit()
    d = _get(client, "/api/patterns/purchases",
             start=ANCHOR.isoformat(), end=END.isoformat())
    f = _find(d, "very different prices")
    assert "₹50.00/kg" in f and "₹100.00/kg" in f


def test_spots_one_thing_logged_under_two_names(shopping):
    d = _get(shopping, "/api/patterns/purchases",
             start=ANCHOR.isoformat(), end=END.isoformat())
    assert d["name_collisions"], "Rice vs Sona Masoori Rice should collide"
    assert "look like the same thing" in _titles(d)


def test_does_not_confuse_two_genuinely_different_items(client):
    with SessionLocal() as db:
        _buy(db, ANCHOR, "Vegetables", 100, item="Onion", qty=5, unit="kg")
        _buy(db, ANCHOR, "Vegetables", 100, item="Potato", qty=5, unit="kg")
        db.commit()
    d = _get(client, "/api/patterns/purchases",
             start=ANCHOR.isoformat(), end=END.isoformat())
    assert d["name_collisions"] == []


def test_bracketed_translations_fold_to_the_same_item(client):
    """Bills arrive as "TOMATO HYBRID (अंग्रेज़ी टमाटर)" and as "Tomato"."""
    with SessionLocal() as db:
        _buy(db, ANCHOR, "Vegetables", 290,
             item="TOMATO HYBRID (अंग्रेज़ी टमाटर)", qty=10, unit="kg")
        _buy(db, ANCHOR + timedelta(days=1), "Vegetables", 240,
             item="Tomato", qty=8, unit="kg")
        db.commit()
    d = _get(client, "/api/patterns/purchases",
             start=ANCHOR.isoformat(), end=END.isoformat())
    assert d["name_collisions"], _titles(d)


def test_counts_what_cannot_be_price_tracked(shopping):
    d = _get(shopping, "/api/patterns/purchases",
             start=ANCHOR.isoformat(), end=END.isoformat())
    assert d["untracked"] == {"entries": 1, "rupees": 900}
    assert "1 purchases have no quantity" in _titles(d)


def test_no_purchases_says_so(client):
    d = _get(client, "/api/patterns/purchases", start="2019-01-01", end="2019-12-31")
    assert "No purchases logged in this period" in _titles(d)


def test_findings_are_ordered_act_first(shopping):
    d = _get(shopping, "/api/patterns/purchases",
             start=ANCHOR.isoformat(), end=END.isoformat())
    sev = [f["severity"] for f in d["findings"]]
    order = {"act": 0, "watch": 1, "good": 2, "info": 3}
    assert sev == sorted(sev, key=lambda s: order[s])
