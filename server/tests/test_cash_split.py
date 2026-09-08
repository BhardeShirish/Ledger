"""Part-paid bills and the drawer.

A bill settled part cash, part online arrives from the POS as one "split"
row with no breakdown. Those rupees are real cash that reached the till,
but nothing says how many, so they cannot be added to the expected drawer
without inventing a figure.

The failure this guards against is quiet: the drawer counts high every
busy day, the owner is shown a surplus with no explanation, and within a
fortnight every variance alert is being waved away — including the one
that mattered.
"""
from app.db import SessionLocal
from app.models import SalesDaily
from datetime import date, timedelta

from app.util import today_iso


def _day(client, outlet_id, date):
    r = client.get(f"/api/cash/day?outlet_id={outlet_id}&date={date}")
    assert r.status_code == 200, r.text
    return r.json()


def _split(outlet_id, date, rupees, source="petpooja"):
    """A part-paid day as the POS import writes it."""
    with SessionLocal() as db:
        db.add(SalesDaily(outlet_id=outlet_id, business_date=date,
                          channel_kind="split", bills=1,
                          gross_paise=int(rupees * 100),
                          discount_paise=0, net_paise=int(rupees * 100),
                          tax_paise=0, tip_paise=0,
                          total_paise=int(rupees * 100),
                          amount_paise=int(rupees * 100), source=source))
        db.commit()


def _cash(client, outlet_id, date, rupees):
    r = client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": date,
        "channel_kind": "cash", "amount_rupees": rupees})
    assert r.status_code in (200, 201), r.text


def test_a_day_with_no_part_paid_bills_says_so(client, outlet_id):
    assert _day(client, outlet_id, today_iso())["split_unknown_paise"] == 0


def test_part_paid_sales_are_reported_as_an_unknown(client, outlet_id):
    d = today_iso()
    _split(outlet_id, d, 890)
    assert _day(client, outlet_id, d)["split_unknown_paise"] == 89_000


def test_the_unknown_is_not_quietly_added_to_the_expected_drawer(client, outlet_id):
    """Guessing that a part payment was all cash would invent a shortage
    every time the customer actually paid most of it online."""
    d = today_iso()
    before = _day(client, outlet_id, d)["expected_paise"]
    _split(outlet_id, d, 890)
    assert _day(client, outlet_id, d)["expected_paise"] == before


def test_the_unknown_sits_alongside_real_cash_sales(client, outlet_id):
    d = today_iso()
    _cash(client, outlet_id, d, 1000)
    _split(outlet_id, d, 500)
    day = _day(client, outlet_id, d)
    assert day["cash_sales_paise"] == 100_000
    assert day["split_unknown_paise"] == 50_000


def test_several_part_paid_days_do_not_leak_into_each_other(client, outlet_id):
    d = today_iso()
    _split(outlet_id, "2026-01-05", 700)
    assert _day(client, outlet_id, d)["split_unknown_paise"] == 0
    assert _day(client, outlet_id, "2026-01-05")["split_unknown_paise"] == 70_000


def test_a_manually_entered_split_day_is_counted_too(client, outlet_id):
    """Not every shop imports from a POS; a hand-written split must raise
    the same doubt as an imported one."""
    d = today_iso()
    _split(outlet_id, d, 300, source="manual")
    assert _day(client, outlet_id, d)["split_unknown_paise"] == 30_000


def test_closing_the_day_still_records_the_variance_honestly(client, outlet_id):
    """The doubt is shown to the owner; it must not silently absorb the
    variance in the books, or a genuine surplus would vanish."""
    d = today_iso()
    _cash(client, outlet_id, d, 1000)
    _split(outlet_id, d, 500)
    expected = _day(client, outlet_id, d)["expected_paise"]

    r = client.post("/api/cash/close", json={
        "outlet_id": outlet_id, "date": d,
        "counted_rupees": (expected + 30_000) / 100,
        "taken_home_rupees": 0, "note": "part payments"})
    assert r.status_code == 200, r.text
    assert r.json()["variance_paise"] == 30_000


def test_cash_close_rejects_malformed_and_future_dates(client, outlet_id):
    for close_date in ("not-a-date", (date.today() + timedelta(days=1)).isoformat()):
        r = client.post("/api/cash/close", json={
            "outlet_id": outlet_id, "date": close_date,
            "counted_rupees": 0, "taken_home_rupees": 0})
        assert r.status_code == 422, r.text
        assert "date" in r.json()["detail"].lower()
