"""Payroll engine — mirrors the owner's Excel exactly:

    per_day        = monthly_salary / divisor          (divisor default 26)
    credited_days  = presents + halves*0.5 + doubles + bonus_days
    month_gross    = round(monthly_salary * credited_days / divisor)
    net            = gross + bonus_amount - deductions - advance_recovery

Days are tracked x10 fixed-point. Payslips freeze salary & divisor so later
raises never rewrite history.
"""
from datetime import date

from sqlalchemy.orm import Session

from .models import (
    Advance, AdvanceRepayment, Employee, PayrollRun, Payslip,
    PayslipAdjustment, utcnow,
)
from .attendance_lib import month_credit_totals
from .util import month_bounds


def compute_payslip_numbers(emp: Employee, rows, adjustments) -> dict:
    """Pure math over attendance rows + adjustment lines. adjustments = [(kind,value_x10_or_paise)]."""
    t = month_credit_totals(rows)
    credit_x10 = t["credited_days_x10"]
    bonus_days_x10 = bonus_amt = deduction = 0
    for kind, value in adjustments:
        if kind == "bonus_days":
            bonus_days_x10 += value
        elif kind == "bonus_amt":
            bonus_amt += value
        elif kind == "deduction":
            deduction += value
    credit_x10 += bonus_days_x10
    gross = int(round(emp.monthly_salary_paise * credit_x10 / (10.0 * (emp.divisor or 26))))
    return {
        **t,
        "credited_days_x10": credit_x10,
        "gross_paise": gross,
        "bonus_paise": bonus_amt,
        "deduction_paise": deduction,
    }


def auto_advance_recovery(db: Session, emp_id: int, year: int, month: int) -> tuple[int, list[Advance]]:
    """Advances given during this month are recovered in full that same month."""
    lo, hi = month_bounds(year, month)
    advs = (db.query(Advance)
              .filter(Advance.employee_id == emp_id,
                      Advance.date >= lo.isoformat(),
                      Advance.date <= hi.isoformat())
              .all())
    return sum(a.amount_paise for a in advs), advs


def rebuild_run(db: Session, run: PayrollRun) -> None:
    """(Re)compute every payslip in a draft run from current data."""
    assert run.status == "draft", "finalized runs are immutable"
    lo, hi = month_bounds(run.year, run.month)
    emps = (db.query(Employee)
              .filter(Employee.outlet_id == run.outlet_id,
                      Employee.is_active == True,  # noqa: E712
                      Employee.working_status != "left")
              .order_by(Employee.name).all())
    existing = {p.employee_id: p for p in db.query(Payslip).filter_by(run_id=run.id).all()}

    for emp in emps:
        if emp.join_date and emp.join_date > hi.isoformat():
            continue
        if emp.exit_date and emp.exit_date < lo.isoformat():
            continue
        att_rows = _attendance_rows(db, emp.id, lo, hi)
        slip = existing.get(emp.id) or Payslip(run_id=run.id, employee_id=emp.id)
        adj_rows = (db.query(PayslipAdjustment)
                      .filter_by(payslip_id=slip.id).all()
                      ) if slip.id else []
        numbers = compute_payslip_numbers(
            emp, att_rows,
            [(a.kind, a.value_x10_or_paise) for a in adj_rows])
        rec_amount, rec_advs = auto_advance_recovery(db, emp.id, run.year, run.month)

        slip.monthly_salary_paise = emp.monthly_salary_paise
        slip.rate_divisor = emp.divisor or 26
        slip.presents = numbers["presents"]
        slip.halves = numbers["halves"]
        slip.doubles = numbers["doubles"]
        slip.absents = numbers["absents"]
        slip.lates_count = numbers["lates_count"]
        slip.credited_days_x10 = numbers["credited_days_x10"]
        slip.gross_paise = numbers["gross_paise"]
        slip.bonus_paise = numbers["bonus_paise"]
        slip.deduction_paise = numbers["deduction_paise"]
        slip.advance_recovery_paise = rec_amount
        slip.net_paise = (numbers["gross_paise"] + numbers["bonus_paise"]
                          - numbers["deduction_paise"] - rec_amount)
        db.add(slip)
        db.flush()
        existing.pop(emp.id, None)

    for stale in existing.values():          # employees who left mid-setup
        db.query(PayslipAdjustment).filter_by(payslip_id=stale.id).delete()
        db.delete(stale)
    db.flush()


def _attendance_rows(db: Session, emp_id: int, lo: date, hi: date):
    from .models import Attendance
    return (db.query(Attendance)
              .filter(Attendance.employee_id == emp_id,
                      Attendance.business_date >= lo.isoformat(),
                      Attendance.business_date <= hi.isoformat())
              .all())


def finalize_run(db: Session, run: PayrollRun, user_id: int) -> None:
    if run.status != "draft":
        raise ValueError("Finalized runs are immutable")
    rebuild_run(db, run)
    run.status = "finalized"
    run.finalized_at = utcnow()
    run.finalized_by = user_id
    # mark this month's advances as recovered via payroll
    for slip in db.query(Payslip).filter_by(run_id=run.id):
        amount = slip.advance_recovery_paise
        if amount <= 0:
            continue
        _, advs = auto_advance_recovery(db, slip.employee_id, run.year, run.month)
        left = amount
        for a in advs:
            take = min(left, a.remaining_paise)
            if take <= 0:
                continue
            a.remaining_paise -= take
            if a.remaining_paise <= 0:
                a.status = "cleared"
            db.add(AdvanceRepayment(advance_id=a.id,
                                    date=f"{run.year:04d}-{run.month:02d}-28",
                                    amount_paise=take, via="payroll", payslip_id=slip.id))
            left -= take
