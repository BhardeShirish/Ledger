"""The payroll month list must show what each month actually costs.

The list used to render "Net payable" with no figure after it, because the
endpoint never sent a total. Owners scanning twelve months of salary had no
number to scan. These tests pin the totals to the payslips.
"""

from app.db import SessionLocal
from app.models import Employee, MonthLock, PayrollRun, Payslip


def stepup(client):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})


def _make_run(outlet_id, year, month, nets, paids=None):
    """Create a run with one payslip per net amount (in rupees)."""
    paids = paids or [0] * len(nets)
    db = SessionLocal()
    try:
        run = PayrollRun(outlet_id=outlet_id, year=year, month=month,
                         status="draft")
        db.add(run)
        db.flush()
        for net, paid in zip(nets, paids):
            emp = Employee(name=f"emp{net}", outlet_id=outlet_id,
                           monthly_salary_paise=net * 100, divisor=26)
            db.add(emp)
            db.flush()
            db.add(Payslip(run_id=run.id, employee_id=emp.id,
                           monthly_salary_paise=net * 100,
                           net_paise=int(round(net * 100)),
                           paid_paise=int(round(paid * 100))))
        db.commit()
        return run.id
    finally:
        db.close()


def test_month_list_reports_the_summed_net_payable(client, outlet_id):
    stepup(client)
    _make_run(outlet_id, 2025, 3, nets=[30000, 12000, 10000.5])

    r = client.get(f"/api/payroll/runs?outlet_id={outlet_id}")
    assert r.status_code == 200, r.text
    row = next(x for x in r.json() if (x["year"], x["month"]) == (2025, 3))

    assert row["net_rupees"] == 52000.5, row
    assert row["paid_rupees"] == 0


def test_paid_is_tracked_separately_from_payable(client, outlet_id):
    stepup(client)
    _make_run(outlet_id, 2025, 4, nets=[20000, 5000], paids=[20000, 1000])

    r = client.get(f"/api/payroll/runs?outlet_id={outlet_id}")
    row = next(x for x in r.json() if (x["year"], x["month"]) == (2025, 4))

    assert row["net_rupees"] == 25000
    assert row["paid_rupees"] == 21000, "partial payment must not read as full"


def test_a_month_with_no_payslips_reports_zero_not_null(client, outlet_id):
    """The UI does inr(net_rupees) - null would render as a blank again."""
    stepup(client)
    _make_run(outlet_id, 2025, 5, nets=[])

    r = client.get(f"/api/payroll/runs?outlet_id={outlet_id}")
    row = next(x for x in r.json() if (x["year"], x["month"]) == (2025, 5))

    assert row["net_rupees"] == 0
    assert row["paid_rupees"] == 0


def test_lock_applies_to_its_own_month_only(client, outlet_id):
    """`locked` is now derived from a batch fetch, not a per-row query."""
    stepup(client)
    _make_run(outlet_id, 2024, 8, nets=[100])
    _make_run(outlet_id, 2024, 9, nets=[200])
    db = SessionLocal()
    try:
        db.add(MonthLock(outlet_id=outlet_id, year=2024, month=8))
        db.commit()
    finally:
        db.close()

    rows = {(x["year"], x["month"]): x for x in
            client.get(f"/api/payroll/runs?outlet_id={outlet_id}").json()}

    assert rows[(2024, 8)]["locked"] is True
    assert rows[(2024, 9)]["locked"] is False, "lock leaked to another month"


def test_totals_do_not_leak_between_months(client, outlet_id):
    stepup(client)
    _make_run(outlet_id, 2025, 6, nets=[1000])
    _make_run(outlet_id, 2025, 7, nets=[9000])

    rows = {(x["year"], x["month"]): x for x in
            client.get(f"/api/payroll/runs?outlet_id={outlet_id}").json()}

    assert rows[(2025, 6)]["net_rupees"] == 1000
    assert rows[(2025, 7)]["net_rupees"] == 9000
