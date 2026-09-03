"""Money moves by UPI here, so every unspecified payment mode must say so.

Leaving these at "cash" made the books claim cash left the drawer when it
never did — and for expenses, mode == "cash" is what the drawer arithmetic
counts.
"""
from datetime import date

from app.db import SessionLocal
from app.models import AdvanceRepayment
from app.routers.advances import RepayIn
from app.routers.expenses import ExpenseIn
from app.routers.payroll import PaidIn


def test_a_repayment_with_no_mode_is_recorded_as_upi(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    emp = client.post("/api/staff/employees", json={
        "name": "Default Test", "code": "DT1", "outlet_id": outlet_id,
        "monthly_salary_rupees": 10000,
    }).json()
    adv = client.post("/api/advances", json={
        "employee_id": emp["id"], "date": date.today().isoformat(),
        "amount_rupees": 500,
    }).json()
    r = client.post(f"/api/advances/{adv['id']}/repay", json={
        "date": date.today().isoformat(), "amount_rupees": 500,
    })
    assert r.status_code == 200, r.text

    with SessionLocal() as db:
        row = (db.query(AdvanceRepayment)
                 .filter(AdvanceRepayment.advance_id == adv["id"]).one())
        assert row.via == "upi"


def test_every_payment_model_defaults_to_upi():
    assert ExpenseIn.model_fields["mode"].default == "upi"
    assert RepayIn.model_fields["via"].default == "upi"
    assert PaidIn.model_fields["mode"].default == "upi"
