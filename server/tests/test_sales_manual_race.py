"""Two saves landing on the same sales cell at once must not 500.

The day sheet saves a row when the field loses focus *and* when the Save
button is clicked - and clicking the button is what removes the focus. So a
single click can put two writes for the same cell in flight. Two phones
closing the same day do the same thing. Before the fix the second write hit
the unique index on (outlet, date, channel, source) and the user got a 500
with no idea whether the money had been recorded.
"""

from datetime import date

from app.db import SessionLocal
from app.models import SalesDaily

DAY = date.today().isoformat()


def _rows(outlet_id, kind="cash"):
    db = SessionLocal()
    try:
        return (db.query(SalesDaily)
                  .filter_by(outlet_id=outlet_id, business_date=DAY,
                             channel_kind=kind, source="manual").all())
    finally:
        db.close()


def test_a_racing_save_of_the_same_cell_still_succeeds(client, outlet_id, monkeypatch):
    import app.routers.sales as sales

    real_audit = sales.audit
    fired = {"n": 0}

    def audit_then_race(*a, **kw):
        # audit() runs just before commit, so this is the exact window: a
        # second request commits the same cell before ours does.
        if fired["n"] == 0:
            fired["n"] = 1
            other = SessionLocal()
            try:
                other.add(SalesDaily(outlet_id=outlet_id, business_date=DAY,
                                     channel_kind="cash", source="manual",
                                     amount_paise=50000))
                other.commit()
            finally:
                other.close()
        return real_audit(*a, **kw)

    monkeypatch.setattr(sales, "audit", audit_then_race)

    r = client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": DAY,
        "channel_kind": "cash", "amount_rupees": 1234.0,
    })

    assert fired["n"] == 1, "the race never happened, so this proves nothing"
    assert r.status_code == 200, r.text
    # The user's number is the one that must survive, not the racing write.
    assert r.json()["amount_rupees"] == 1234.0
    rows = _rows(outlet_id)
    assert len(rows) == 1, f"the race duplicated the cell: {rows}"
    assert rows[0].amount_paise == 123400


def test_saving_the_same_cell_twice_in_a_row_overwrites(client, outlet_id):
    for amount in (100.0, 250.0):
        r = client.put("/api/sales/manual", json={
            "outlet_id": outlet_id, "business_date": DAY,
            "channel_kind": "upi", "amount_rupees": amount,
        })
        assert r.status_code == 200, r.text
    rows = _rows(outlet_id, "upi")
    assert len(rows) == 1
    assert rows[0].amount_paise == 25000
