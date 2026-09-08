"""Focused checks for owner policies, resolution learning, and safe recovery."""
from datetime import date

from app.db import SessionLocal
from app.models import BankCredit, Expense, ExpenseCategory, RecurringCost


def _policy(outlet_id):
    return {
        "outlet_id": outlet_id,
        "cash_variance_alert_rupees": 123,
        "minimum_data_coverage_percent": 75,
        "stock_count_cadence_days": 14,
        "stockout_lead_days": 5,
        "payable_overdue_days": 45,
        "purchase_approval_limit_rupees": 2000,
        "minimum_cash_buffer_rupees": None,
    }


def test_owner_policy_validates_and_denies_manager(client, manager, outlet_id):
    assert manager.get("/api/owner/policies", params={"outlet_id": outlet_id}).status_code == 403
    assert manager.post("/api/owner/resolutions", json={
        "outlet_id": outlet_id, "finding_id": "forecast.no-basis",
        "covered_period": date.today().strftime("%Y-%m"), "status": "resolved",
    }).status_code == 403
    bad = _policy(outlet_id)
    bad["stockout_lead_days"] = 0
    assert client.put("/api/owner/policies", json=bad).status_code == 422
    saved = client.put("/api/owner/policies", json=_policy(outlet_id))
    assert saved.status_code == 200, saved.text
    assert saved.json()["cash_variance_alert_rupees"] == 123
    assert client.get("/api/cash/day", params={
        "outlet_id": outlet_id, "date": date.today().isoformat(),
    }).json()["variance_alert_paise"] == 12_300
    assert client.get("/api/owner/policies", params={"outlet_id": outlet_id}).json()[
        "stock_count_cadence_days"] == 14


def test_resolution_excludes_only_resolved_and_never_sends_note(client, outlet_id, monkeypatch):
    period = date.today().strftime("%Y-%m")
    resolution = client.post("/api/owner/resolutions", json={
        "outlet_id": outlet_id, "finding_id": "forecast.no-basis",
        "covered_period": period, "status": "resolved", "note": "private owner note",
    })
    assert resolution.status_code == 200, resolution.text
    brief = client.get("/api/intelligence/brief", params={"outlet_id": outlet_id}).json()
    assert "forecast.no-basis" not in [row["id"] for row in brief["feed"]]
    assert "forecast.no-basis" in [row["id"] for row in brief["resolved_findings"]]
    deferred = client.post("/api/owner/resolutions", json={
        "outlet_id": outlet_id, "finding_id": "inventory.recipe-coverage",
        "covered_period": period, "status": "deferred", "note": "never give this to AI",
    })
    assert deferred.status_code == 200
    payload = __import__("app.routers.intelligence", fromlist=["_ai_payload"])._ai_payload(
        client.get("/api/intelligence/brief", params={"outlet_id": outlet_id}).json())
    assert "never give this to AI" not in str(payload)
    reopened = client.post("/api/owner/resolutions/reopen", json={
        "outlet_id": outlet_id, "finding_id": "forecast.no-basis",
        "covered_period": period, "status": "resolved",
    })
    assert reopened.status_code == 200
    assert any(row["id"] == "forecast.no-basis" for row in client.get(
        "/api/intelligence/brief", params={"outlet_id": outlet_id}).json()["feed"])


def test_recurring_review_is_signal_only(client, outlet_id):
    with SessionLocal() as db:
        cat = ExpenseCategory(name="Review category", is_active=True)
        db.add(cat)
        db.flush()
        cost = RecurringCost(outlet_id=outlet_id, category_id=cat.id, name="Insurance",
                             amount_paise=5000, day_of_month=1,
                             start_month="2999-01", review_cadence_days=30)
        db.add(cost)
        db.commit()
        cost_id = cost.id
    before = SessionLocal().query(Expense).count()
    rows = client.get("/api/recurring").json()["items"]
    assert next(row for row in rows if row["id"] == cost_id)["review_due"] is True
    reviewed = client.post(f"/api/recurring/{cost_id}/review")
    assert reviewed.status_code == 200
    assert reviewed.json()["review_due"] is False
    assert SessionLocal().query(Expense).count() == before


def test_runway_withholds_unknown_balance_and_health_does_not_write(client, outlet_id):
    with SessionLocal() as db:
        db.add(BankCredit(outlet_id=outlet_id, business_date=date.today().isoformat(),
                          amount_paise=100_00, narration="credit", reference="x",
                          line_hash="owner-controls-credit"))
        db.commit()
    runway = client.get("/api/owner/runway", params={"outlet_id": outlet_id}).json()
    assert runway["status"] == "withheld"
    assert runway["starting_cash_paise"] is None
    assert runway["base_range_paise"] is None
    with SessionLocal() as db:
        before = db.query(Expense).count()
    health = client.get("/api/owner/system-health", params={"outlet_id": outlet_id})
    assert health.status_code == 200, health.text
    assert len(health.json()["restore_playbook"]) == 4
    with SessionLocal() as db:
        assert db.query(Expense).count() == before
