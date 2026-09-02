"""Re-sending a queued entry must never record it twice.

The offline outbox retries whatever did not reach the server, and it cannot
tell "the reply was lost" from "the write never happened" - so it re-sends.
It also flushes on the `online` event *and* on a timer, so the same item can
genuinely arrive twice. If any of these endpoints appended instead of
upserting, a lost reply would quietly double a day's sales or an expense and
the owner would only find it at month end.

Every endpoint listed in OFFLINE_OK (web/src/api/client.ts) is covered here.
Adding an endpoint there without adding it here is how that guarantee gets
lost.
"""
import pytest
from datetime import date

from app.db import SessionLocal
from app.models import Attendance

DAY = date.today().isoformat()   # today is always inside the edit window


def _attendance_rows(employee_id):
    """Count the stored rows, not the grid: the grid always renders one cell
    per day, so it would happily hide a duplicate underneath."""
    db = SessionLocal()
    try:
        return (db.query(Attendance)
                  .filter_by(employee_id=employee_id, business_date=DAY).all())
    finally:
        db.close()


@pytest.fixture()
def category_id(client):
    return client.get("/api/lists/categories").json()[0]["id"]


@pytest.fixture()
def emp(client, outlet_id):
    r = client.post("/api/staff/employees", json={
        "name": "Test Cook", "outlet_id": outlet_id,
        "monthly_salary_rupees": 26000, "join_date": "2026-01-01"})
    assert r.status_code == 201, r.text
    return r.json()


def test_replaying_an_expense_records_it_once(client, outlet_id, category_id):
    body = {"outlet_id": outlet_id, "business_date": DAY,
            "amount_rupees": 450.0, "category_id": category_id, "mode": "cash",
            "description": "Gas cylinder"}
    key = "9f1c7d2e-0000-4000-8000-000000000001"

    first = client.post("/api/expenses", json=body,
                        headers={"X-Idempotency-Key": key})
    assert first.status_code == 201, first.text
    second = client.post("/api/expenses", json=body,
                         headers={"X-Idempotency-Key": key})
    assert second.status_code in (200, 201), second.text
    assert second.json()["id"] == first.json()["id"], "replay made a new expense"

    rows = client.get(f"/api/expenses?outlet_id={outlet_id}"
                      f"&start={DAY}&end={DAY}").json()["rows"]
    assert len(rows) == 1, f"the replay doubled the expense: {rows}"
    assert rows[0]["amount_rupees"] == 450.0


def test_two_different_expenses_are_not_collapsed(client, outlet_id, category_id):
    """The guard must key off the idempotency key, not the amount - a shop
    really can buy two ₹450 gas cylinders on one day."""
    body = {"outlet_id": outlet_id, "business_date": DAY,
            "amount_rupees": 450.0, "category_id": category_id, "mode": "cash", "description": "Gas cylinder"}
    for key in ("9f1c7d2e-0000-4000-8000-00000000000a",
                "9f1c7d2e-0000-4000-8000-00000000000b"):
        r = client.post("/api/expenses", json=body,
                        headers={"X-Idempotency-Key": key})
        assert r.status_code == 201, r.text
    rows = client.get(f"/api/expenses?outlet_id={outlet_id}"
                      f"&start={DAY}&end={DAY}").json()["rows"]
    assert len(rows) == 2, "distinct entries were wrongly treated as a replay"


def test_replaying_a_sales_figure_does_not_add_up(client, outlet_id):
    body = {"outlet_id": outlet_id, "business_date": DAY,
            "channel_kind": "cash", "amount_rupees": 8500.0}
    for _ in range(2):
        r = client.put("/api/sales/manual", json=body,
                       headers={"X-Idempotency-Key": "s-0001"})
        assert r.status_code == 200, r.text
        # An upsert must assign the figure, never accumulate it.
        assert r.json()["amount_rupees"] == 8500.0


def test_replaying_attendance_mark_keeps_one_day(client, outlet_id, emp):
    body = {"employee_id": emp["id"], "date": DAY, "status": "P"}
    for _ in range(2):
        r = client.post("/api/attendance/mark", json=body,
                        headers={"X-Idempotency-Key": "a-0001"})
        assert r.status_code == 200, r.text

    rows = _attendance_rows(emp["id"])
    assert len(rows) == 1, f"the replay created a second attendance row: {rows}"
    assert rows[0].status == "P"


def test_replaying_attendance_bulk_keeps_one_day(client, outlet_id, emp):
    body = {"outlet_id": outlet_id, "date": DAY,
            "entries": [{"employee_id": emp["id"], "status": "P"}]}
    for _ in range(2):
        r = client.post("/api/attendance/bulk", json=body,
                        headers={"X-Idempotency-Key": "b-0001"})
        assert r.status_code == 200, r.text

    rows = _attendance_rows(emp["id"])
    assert len(rows) == 1, f"the replay created a second attendance row: {rows}"
    assert rows[0].status == "P"
