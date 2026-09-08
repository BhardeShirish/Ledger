"""Regression tests for controls that protect already-reconciled books."""
from datetime import date, timedelta

from app.db import SessionLocal
from app.models import (BankCredit, CashBankMatch, DayClosure, Employee, MonthLock,
                        PayrollRun, Payslip, Vendor, VendorEntry)


def _stepup(client):
    response = client.post("/api/auth/stepup", json={"password": "change-me-please"})
    assert response.status_code == 200, response.text


def test_reclosing_cannot_reduce_a_bank_reconciled_cash_close(client, outlet_id):
    today = date.today().isoformat()
    with SessionLocal() as db:
        closure = DayClosure(outlet_id=outlet_id, business_date=today,
                             counted_cash_paise=10_000, moved_to_bank_paise=10_000)
        credit = BankCredit(outlet_id=outlet_id, business_date=today, amount_paise=10_000,
                            narration="deposit", reference="test", line_hash="integrity-match")
        db.add_all((closure, credit))
        db.flush()
        db.add(CashBankMatch(closure_id=closure.id, bank_credit_id=credit.id,
                             amount_paise=10_000))
        db.commit()

    response = client.post("/api/cash/close", json={
        "outlet_id": outlet_id, "date": today, "counted_rupees": 100,
        "taken_home_rupees": 90,
    })
    assert response.status_code == 409
    assert "reconciled" in response.json()["detail"].lower()


def test_settled_old_supplier_credit_is_not_reported_as_overdue(client, outlet_id):
    today = date.today()
    with SessionLocal() as db:
        vendor = Vendor(name="Settled supplier")
        db.add(vendor)
        db.flush()
        db.add_all((
            VendorEntry(vendor_id=vendor.id, outlet_id=outlet_id,
                        date=(today - timedelta(days=100)).isoformat(),
                        type="purchase_credit", amount_paise=10_000),
            VendorEntry(vendor_id=vendor.id, outlet_id=outlet_id,
                        date=today.isoformat(), type="payment", amount_paise=10_000),
        ))
        db.commit()

    inbox = client.get("/api/control/close-inbox", params={
        "outlet_id": outlet_id, "month": today.strftime("%Y-%m"),
    })
    assert inbox.status_code == 200, inbox.text
    assert not any(item["kind"] == "payables_overdue" for item in inbox.json()["items"])


def test_locked_month_blocks_late_payroll_payment_updates(client, outlet_id):
    prior_month_end = date.today().replace(day=1) - timedelta(days=1)
    with SessionLocal() as db:
        employee = Employee(code="PAYLOCK", name="Payroll lock", outlet_id=outlet_id)
        db.add(employee)
        db.flush()
        run = PayrollRun(outlet_id=outlet_id, year=prior_month_end.year,
                         month=prior_month_end.month, status="finalized")
        db.add(run)
        db.flush()
        slip = Payslip(run_id=run.id, employee_id=employee.id,
                       monthly_salary_paise=8_000, net_paise=8_000)
        db.add(slip)
        db.add(MonthLock(outlet_id=outlet_id, year=prior_month_end.year,
                         month=prior_month_end.month))
        db.commit()
        slip_id = slip.id

    _stepup(client)
    response = client.post(f"/api/payroll/payslips/{slip_id}/paid", json={})
    assert response.status_code == 423
