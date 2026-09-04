"""Standing monthly costs.

Rent posting itself is only safe if it posts exactly once. These tests
are mostly about the ways money could be double-counted, back-dated or
invented, because each of those corrupts every ratio on the P&L.
"""
from datetime import date

import pytest

from app.db import SessionLocal
from app.models import Expense, ExpenseCategory
from app.routers.recurring import _due_date, _months_between, post_due


def _cat(client, name):
    r = client.get("/api/lists/categories")
    assert r.status_code == 200, r.text
    rows = r.json()
    rows = rows["items"] if isinstance(rows, dict) else rows
    for c in rows:
        if c["name"].lower() == name.lower():
            return c["id"]
    r = client.post("/api/lists/categories", json={"name": name})
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


@pytest.fixture()
def rent_cat(client):
    return _cat(client, "Rent")


def _add(client, cat, **kw):
    body = {"category_id": cat, "name": "Shop rent", "amount_rupees": 40000,
            "day_of_month": 1, "start_month": "2026-01", **kw}
    r = client.post("/api/recurring", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _expenses(key_prefix="rec:"):
    with SessionLocal() as db:
        return [e for e in db.query(Expense).all()
                if (e.idempotency_key or "").startswith(key_prefix)]


def _add_quietly(cat, **kw):
    """A standing cost created without the POST route's immediate catch-up,
    so a test can choose the date it is posted up to."""
    from app.models import RecurringCost
    fields = {"outlet_id": 1, "category_id": cat, "name": "Shop rent",
              "amount_paise": 4000000, "day_of_month": 1,
              "start_month": "2026-01", "end_month": None, "mode": "bank",
              "note": "", "is_active": True, **kw}
    with SessionLocal() as db:
        r = RecurringCost(**fields)
        db.add(r)
        db.commit()
        return r.id


# ── the month walk ──────────────────────────────────────────────────────────

def test_months_between_is_inclusive_and_rolls_the_year():
    assert _months_between("2025-11", "2026-02") == [
        "2025-11", "2025-12", "2026-01", "2026-02"]


def test_months_between_a_single_month():
    assert _months_between("2026-03", "2026-03") == ["2026-03"]


def test_months_between_refuses_to_walk_forever():
    """A typo of 2999 must not post a thousand years of rent."""
    assert len(_months_between("2026-01", "2999-12")) <= 37


def test_due_date_clamps_to_a_short_month():
    """Rent set for the 31st must still land in February rather than
    vanishing for that month."""
    assert _due_date("2026-02", 31) == "2026-02-28"
    assert _due_date("2024-02", 31) == "2024-02-29"      # leap year
    assert _due_date("2026-04", 31) == "2026-04-30"
    assert _due_date("2026-01", 31) == "2026-01-31"


# ── posting ─────────────────────────────────────────────────────────────────

def test_a_standing_cost_posts_a_real_expense(client, rent_cat):
    _add(client, rent_cat, start_month="2026-01", end_month="2026-01")
    rows = _expenses()
    assert len(rows) == 1
    assert rows[0].amount_paise == 4000000
    assert rows[0].business_date == "2026-01-01"


def test_posting_twice_does_not_post_twice(client, rent_cat):
    """The whole design rests on this: the report calls post_due on every
    load, so a second call must be a no-op."""
    _add(client, rent_cat, start_month="2026-01", end_month="2026-02")
    before = len(_expenses())
    with SessionLocal() as db:
        again = post_due(db, upto="2026-12-31")
        third = post_due(db, upto="2026-12-31")
    assert (again, third) == (0, 0)
    assert len(_expenses()) == before == 2


def test_it_backfills_every_month_from_the_start(client, rent_cat):
    _add(client, rent_cat, start_month="2026-01", end_month="2026-04")
    dates = sorted(e.business_date for e in _expenses())
    assert dates == ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]


def test_it_never_posts_a_cost_before_it_is_due(client, rent_cat):
    """Posting next month's rent today would make this month look worse
    and next month look free."""
    _add_quietly(rent_cat, end_month="2026-12")
    with SessionLocal() as db:
        post_due(db, upto="2026-03-15")
    dates = sorted(e.business_date for e in _expenses())
    assert dates == ["2026-01-01", "2026-02-01", "2026-03-01"]


def test_an_open_ended_cost_stops_at_today(client, rent_cat):
    """Rent with no end date is the normal case. It must post up to this
    month and no further, or the books show costs not yet incurred."""
    _add_quietly(rent_cat)                        # end_month is None
    with SessionLocal() as db:
        post_due(db, upto="2026-03-10")
    dates = sorted(e.business_date for e in _expenses())
    assert dates == ["2026-01-01", "2026-02-01", "2026-03-01"]


def test_a_cost_due_late_in_the_month_waits_for_its_day(client, rent_cat):
    _add_quietly(rent_cat, end_month="2026-12", day_of_month=20)
    with SessionLocal() as db:
        post_due(db, upto="2026-02-19")
    dates = sorted(e.business_date for e in _expenses())
    assert dates == ["2026-01-20"], "February is not due until the 20th"
    with SessionLocal() as db:
        post_due(db, upto="2026-02-20")
    assert len(_expenses()) == 2


def test_an_inactive_cost_stops_posting_but_keeps_its_history(client, rent_cat):
    """Open-ended on purpose: with an end month already past, a broken
    'is this still active' check would have nothing left to post and the
    bug would hide behind the idempotency key."""
    r = _add(client, rent_cat, start_month="2026-01", end_month=None)
    before = len(_expenses())
    assert before >= 8, "January to today should have posted"
    assert client.delete(f"/api/recurring/{r['id']}").status_code == 200
    with SessionLocal() as db:
        assert post_due(db, upto="2027-12-31") == 0
    assert len(_expenses()) == before, "stopping must neither post nor delete"


def test_editing_the_amount_does_not_rewrite_a_posted_month(client, rent_cat):
    r = _add(client, rent_cat, start_month="2026-01", end_month="2026-01")
    client.put(f"/api/recurring/{r['id']}", json={
        "category_id": rent_cat, "name": "Shop rent", "amount_rupees": 55000,
        "day_of_month": 1, "start_month": "2026-01", "end_month": "2026-01"})
    rows = _expenses()
    assert len(rows) == 1
    assert rows[0].amount_paise == 4000000, "March's rent was really ₹40,000"


def test_extending_the_end_month_posts_the_new_months_only(client, rent_cat):
    r = _add(client, rent_cat, start_month="2026-01", end_month="2026-01")
    client.put(f"/api/recurring/{r['id']}", json={
        "category_id": rent_cat, "name": "Shop rent", "amount_rupees": 40000,
        "day_of_month": 1, "start_month": "2026-01", "end_month": "2026-03"})
    with SessionLocal() as db:
        post_due(db, upto="2026-12-31")
    assert len(_expenses()) == 3


# ── validation ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("bad", [
    {"start_month": "not-a-month"},
    {"start_month": "2026-13"},
    {"start_month": "2026-03", "end_month": "2026-01"},
    {"amount_rupees": 0},
    {"amount_rupees": -500},
    {"day_of_month": 0},
    {"day_of_month": 32},
])
def test_nonsense_is_refused(client, rent_cat, bad):
    body = {"category_id": rent_cat, "name": "x", "amount_rupees": 100,
            "day_of_month": 1, "start_month": "2026-01", **bad}
    assert client.post("/api/recurring", json=body).status_code in (400, 422)


def test_an_unknown_category_is_refused(client):
    r = client.post("/api/recurring", json={
        "category_id": 999999, "name": "x", "amount_rupees": 100,
        "day_of_month": 1, "start_month": "2026-01"})
    assert r.status_code == 422


def test_the_list_totals_only_active_costs(client, rent_cat):
    a = _add(client, rent_cat, start_month="2026-01", end_month="2026-01")
    _add(client, rent_cat, name="Internet", amount_rupees=1500,
         start_month="2026-01", end_month="2026-01")
    assert client.get("/api/recurring").json()["monthly_total_rupees"] == 41500.0
    client.delete(f"/api/recurring/{a['id']}")
    assert client.get("/api/recurring").json()["monthly_total_rupees"] == 1500.0


def test_the_yearly_figure_is_the_monthly_times_twelve(client, rent_cat):
    r = _add(client, rent_cat, start_month="2026-01", end_month="2026-01")
    assert r["yearly_rupees"] == 480000.0


def test_stopping_something_that_is_not_there(client):
    assert client.delete("/api/recurring/424242").status_code == 404
