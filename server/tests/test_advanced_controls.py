"""Regression coverage for the connected owner-control additions."""
from datetime import date, timedelta

from app.db import SessionLocal
from app.models import BankCredit, DayClosure


def _stepup(client):
    assert client.post("/api/auth/stepup", json={"password": "change-me-please"}).status_code == 200


def _previous_month() -> tuple[str, str]:
    first = date.today().replace(day=1)
    last = first - timedelta(days=1)
    return f"{last.year:04d}-{last.month:02d}", last.isoformat()


def test_month_close_blocks_and_reopen_restores_a_financial_write(client, outlet_id):
    _stepup(client)
    month, business_date = _previous_month()
    closed = client.post("/api/control/month/close", json={
        "outlet_id": outlet_id, "month": month, "force": True, "reason": "test close",
    })
    assert closed.status_code == 200, closed.text
    blocked = client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": business_date,
        "channel_kind": "cash", "amount_rupees": 10,
    })
    assert blocked.status_code == 423
    reopened = client.post("/api/control/month/reopen", json={
        "outlet_id": outlet_id, "month": month, "reason": "test correction",
    })
    assert reopened.status_code == 200, reopened.text
    assert client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": business_date,
        "channel_kind": "cash", "amount_rupees": 10,
    }).status_code == 200


def test_new_analysis_endpoints_are_truthful_with_sparse_data(client, outlet_id):
    _stepup(client)
    today = date.today().isoformat()
    assert client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": today,
        "channel_kind": "cash", "amount_rupees": 100,
    }).status_code == 200
    month = today[:7]
    forecast = client.get("/api/insights/forecast", params={
        "outlet_id": outlet_id, "month": month,
    }).json()
    assert forecast["confidence"] == "low"
    assert forecast["scenarios"]["base_rupees"] == forecast["projected_rupees"]
    scenario = client.post("/api/insights/scenario", json={
        "outlet_id": outlet_id, "month": month, "sales_change_percent": 10,
    })
    assert scenario.status_code == 200
    labour = client.get("/api/stats/labour-productivity", params={
        "outlet_id": outlet_id, "start": today, "end": today,
    })
    assert labour.status_code == 200
    assert labour.json()["data_quality"]["manual_sales_unattributed"] is True


def test_cash_reconciliation_and_vendor_aging(client, outlet_id):
    _stepup(client)
    today = date.today().isoformat()
    with SessionLocal() as db:
        closure = DayClosure(outlet_id=outlet_id, business_date=today,
                             counted_cash_paise=5000, moved_to_bank_paise=5000)
        credit = BankCredit(outlet_id=outlet_id, business_date=today,
                            amount_paise=5000, narration="cash deposit",
                            reference="test", line_hash="test-credit-hash")
        db.add_all((closure, credit))
        db.commit()
        closure_id, credit_id = closure.id, credit.id
    recon = client.get("/api/bank/cash-reconciliation", params={
        "outlet_id": outlet_id, "start": today, "end": today,
    }).json()
    assert recon["closures"][0]["suggested_credit_id"] == credit_id
    match = client.post("/api/bank/cash-reconciliation/matches", json={
        "closure_id": closure_id, "bank_credit_id": credit_id, "amount_rupees": 50,
    })
    assert match.status_code == 201, match.text

    vendor = client.post("/api/vendors", json={"name": "Aging test vendor"}).json()
    old = (date.today() - timedelta(days=40)).isoformat()
    created = client.post(f"/api/vendors/{vendor['id']}/entries", json={
        "outlet_id": outlet_id, "date": old, "type": "purchase_credit",
        "amount_rupees": 100, "note": "test",
    })
    assert created.status_code == 201, created.text
    aging = client.get("/api/vendors/aging", params={"outlet_id": outlet_id, "as_of": today}).json()
    row = next(row for row in aging if row["vendor_id"] == vendor["id"])
    assert row["buckets"]["31_60"] == 10000
