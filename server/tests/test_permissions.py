"""Permission matrix + step-up gating + edit-window enforcement."""
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text

from app.main import app
from app.models import migrate
from tests.conftest import login


def test_manager_cannot_create_employee(client, manager, outlet_id):
    r = manager.post("/api/staff/employees", json={
        "name": "X", "outlet_id": outlet_id, "monthly_salary_rupees": 1})
    assert r.status_code == 403


def test_manager_salary_masked(client, manager, outlet_id):
    r = client.post("/api/staff/employees", json={
        "name": "Masked Emp", "outlet_id": outlet_id,
        "monthly_salary_rupees": 12000})
    emp_id = r.json()["id"]
    mine = manager.get(f"/api/staff/employees/{emp_id}").json()
    assert "monthly_salary_paise" not in mine
    assert "monthly_salary_rupees" not in mine
    assert "per_day_rupees" not in mine
    theirs = client.get(f"/api/staff/employees/{emp_id}").json()
    assert theirs["monthly_salary_rupees"] == 12000


def test_payroll_requires_owner_and_stepup(manager):
    r = manager.post("/api/payroll/runs", json={"outlet_id": 1, "year": 2026, "month": 7})
    assert r.status_code == 403  # manager blocked outright


def test_advances_require_stepup_for_owner(fresh_owner):
    c = fresh_owner
    r = c.get("/api/advances")
    assert r.status_code == 428  # not elevated yet
    r = c.post("/api/auth/stepup", json={"password": "change-me-please"})
    assert r.status_code == 200
    r = c.get("/api/advances")
    assert r.status_code == 200


def test_old_expense_edit_requires_elevation(fresh_owner, outlet_id):
    """Owner editing a >48h-old expense without elevation → 403."""
    from datetime import date as D
    old_date = (D.today() - timedelta(days=10)).isoformat()
    cats = fresh_owner.get("/api/lists/categories").json()
    r = fresh_owner.post("/api/expenses", json={
        "outlet_id": outlet_id, "business_date": old_date,
        "category_id": cats[0]["id"], "amount_rupees": 100, "mode": "cash"})
    if r.status_code == 201:
        eid = r.json()["id"]
        r2 = fresh_owner.patch(f"/api/expenses/{eid}", json={"amount_rupees": 150})
        assert r2.status_code == 403  # old record, no elevation
        fresh_owner.post("/api/auth/stepup", json={"password": "change-me-please"})
        r3 = fresh_owner.patch(f"/api/expenses/{eid}", json={"amount_rupees": 150})
        assert r3.status_code == 200
    else:
        assert r.status_code == 403


def test_manager_cannot_reopen_another_outlets_closed_day(client, manager, outlet_id):
    """A manager scoped to outlet A must not unlock outlet B's cash book.

    Reopening is what makes a closed day editable again, so an outlet check
    here matters as much as it does on the read path.
    """
    from datetime import date as D

    other = client.post("/api/outlets", json={"name": "Far Outlet"})
    assert other.status_code in (200, 201), other.text
    other_id = other.json()["id"]
    assert other_id != outlet_id

    today = D.today().isoformat()
    client.put("/api/sales/manual", json={
        "outlet_id": other_id, "business_date": today,
        "channel_kind": "cash", "amount_rupees": 500})
    day = client.get(f"/api/cash/day?outlet_id={other_id}&date={today}").json()
    closed = client.post("/api/cash/close", json={
        "outlet_id": other_id, "date": today,
        "counted_rupees": round(day["expected_paise"] / 100, 2),
        "taken_home_rupees": 0, "breakdown": {}, "note": ""})
    assert closed.status_code == 200, closed.text
    closure_id = closed.json()["id"]

    # the manager cannot even read that outlet...
    assert manager.get(f"/api/cash/closures?outlet_id={other_id}").status_code == 403
    # ...so it must not be able to reopen it either
    assert manager.post(f"/api/cash/{closure_id}/reopen").status_code == 403


def test_expense_idempotency_key_prevents_offline_duplicates(client, outlet_id):
    from datetime import date

    category = client.get("/api/lists/categories").json()[0]
    body = {
        "outlet_id": outlet_id, "business_date": date.today().isoformat(),
        "category_id": category["id"], "amount_rupees": 321,
        "mode": "cash", "description": "offline retry",
    }
    headers = {"X-Idempotency-Key": "offline-expense-1"}
    first = client.post("/api/expenses", json=body, headers=headers)
    retry = client.post("/api/expenses", json=body, headers=headers)
    assert first.status_code == 201 and retry.status_code == 201
    assert first.json()["id"] == retry.json()["id"]


def test_audit_log_records(client, owner):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    rows = client.get("/api/admin/audit").json()
    assert rows["total"] > 0
    actions = {r["action"] for r in rows["rows"]}
    assert any(a.startswith(("create", "update", "login", "mark")) for a in actions)


def test_login_wrong_password(client):
    r = client.post("/api/auth/login",
                    json={"username": "owner", "password": "nope-nope"})
    assert r.status_code == 401


def test_cookie_writes_require_csrf():
    c = TestClient(app)
    r = c.post("/api/auth/login", json={
        "username": "owner", "password": "change-me-please",
    })
    assert r.status_code == 200
    csrf = c.cookies.get("ledger_csrf")
    assert csrf
    assert c.post("/api/auth/stepdown").status_code == 403
    assert c.post(
        "/api/auth/stepdown", headers={"X-CSRF-Token": csrf}
    ).status_code == 200


def test_logout_revokes_issued_bearer():
    c = TestClient(app)
    r = c.post("/api/auth/login", json={
        "username": "owner", "password": "change-me-please",
    })
    token = r.json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    assert c.post("/api/auth/logout", headers=auth).status_code == 200
    assert c.get("/api/auth/me", headers=auth).status_code == 401


def test_stepup_is_bound_to_durable_session():
    c = TestClient(app)
    r = c.post("/api/auth/login", json={
        "username": "owner", "password": "change-me-please",
    })
    token = r.json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    assert c.post(
        "/api/auth/stepup",
        json={"password": "change-me-please"},
        headers=auth,
    ).status_code == 200
    other_process_client = TestClient(app)
    assert other_process_client.get("/api/advances", headers=auth).status_code == 200


def test_migration_upgrades_legacy_user_security_columns(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE employees (id INTEGER PRIMARY KEY)"))
        conn.execute(text("CREATE TABLE day_closures (id INTEGER PRIMARY KEY)"))
        conn.execute(text("CREATE TABLE expenses (id INTEGER PRIMARY KEY)"))
        conn.execute(text(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR(64))"
        ))
    migrate(engine)
    columns = {column["name"] for column in inspect(engine).get_columns("users")}
    assert {"failed_attempts", "locked_until", "last_login_at"} <= columns
