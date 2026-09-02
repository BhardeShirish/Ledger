"""A day's shift decides its late/OT minutes, so it must belong to the outlet.

The save path used to accept any shift id at all, which let one outlet's
timings rewrite another outlet's attendance - and therefore its pay.
"""
from datetime import date

import pytest

TODAY = date.today().isoformat()


@pytest.fixture()
def own_shift(client, outlet_id):
    r = client.post("/api/staff/shifts", json={
        "name": "Morning", "start": "08:00", "end": "16:00",
        "outlet_id": outlet_id})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture()
def employee(client, outlet_id, own_shift):
    r = client.post("/api/staff/employees", json={
        "name": "Scope Test Cook", "outlet_id": outlet_id,
        "default_shift_id": own_shift["id"],
        "monthly_salary_rupees": 26000, "join_date": "2026-01-01"})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture()
def foreign_shift(client):
    """A shift belonging to a different outlet entirely."""
    r = client.post("/api/outlets", json={
        "name": "Far Away Kitchen", "address": "-", "phone": "-"})
    assert r.status_code in (200, 201), r.text
    other_id = r.json()["id"]
    r = client.post("/api/staff/shifts", json={
        "name": "Foreign Shift", "start": "00:00", "end": "02:00",
        "outlet_id": other_id})
    assert r.status_code == 201, r.text
    return r.json()


def test_shift_from_another_outlet_is_refused(client, employee, foreign_shift):
    r = client.post("/api/attendance/mark", json={
        "employee_id": employee["id"], "date": TODAY, "status": "P",
        "shift_id": foreign_shift["id"]})
    assert r.status_code == 422, r.text
    assert "outlet" in r.text.lower()


def test_a_shift_of_this_outlet_is_still_accepted(client, employee, own_shift):
    r = client.post("/api/attendance/mark", json={
        "employee_id": employee["id"], "date": TODAY, "status": "P",
        "shift_id": own_shift["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["shift"]["id"] == own_shift["id"]


def test_an_unknown_shift_id_is_refused(client, employee):
    r = client.post("/api/attendance/mark", json={
        "employee_id": employee["id"], "date": TODAY, "status": "P",
        "shift_id": 999999})
    assert r.status_code == 422, r.text
