"""Payroll runs — owner only, step-up gated (salary data)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..audit import audit
from ..db import get_db
from ..models import (Employee, MonthLock, PayrollRun, Payslip,
                      PayslipAdjustment, User)
from ..payroll import finalize_run, rebuild_run
from ..periods import assert_month_open
from ..security import current_user, require_stepup

router = APIRouter(prefix="/payroll", tags=["payroll"],
                   dependencies=[Depends(require_stepup)])


class RunIn(BaseModel):
    outlet_id: int
    year: int
    month: int


class AdjustIn(BaseModel):
    kind: str                 # bonus_days | bonus_amt | deduction
    days: float | None = None     # for bonus_days
    amount_rupees: float | None = None  # for bonus_amt / deduction
    reason: str = ""


class PaidIn(BaseModel):
    mode: str = "upi"
    paid_on: str | None = None


@router.get("/runs")
def list_runs(outlet_id: int | None = None, db: Session = Depends(get_db),
              user: User = Depends(current_user)):
    q = db.query(PayrollRun)
    if outlet_id:
        q = q.filter_by(outlet_id=outlet_id)
    rows = q.order_by(PayrollRun.year.desc(), PayrollRun.month.desc()).limit(36).all()
    if not rows:
        return []

    # The list shows up to 36 months; fetch totals and locks in one query
    # each rather than two-plus per row.
    ids = [r.id for r in rows]
    sums = {
        run_id: (net, paid)
        for run_id, net, paid in
        db.query(Payslip.run_id,
                 func.coalesce(func.sum(Payslip.net_paise), 0),
                 func.coalesce(func.sum(Payslip.paid_paise), 0))
          .filter(Payslip.run_id.in_(ids)).group_by(Payslip.run_id).all()
    }
    locked = {
        (o, y, m) for o, y, m in
        db.query(MonthLock.outlet_id, MonthLock.year, MonthLock.month)
          .filter(MonthLock.outlet_id.in_({r.outlet_id for r in rows})).all()
    }
    return [{
        "id": r.id, "outlet_id": r.outlet_id, "year": r.year, "month": r.month,
        "status": r.status,
        "net_rupees": round(sums.get(r.id, (0, 0))[0] / 100, 2),
        "paid_rupees": round(sums.get(r.id, (0, 0))[1] / 100, 2),
        "finalized_at": r.finalized_at.isoformat() if r.finalized_at else None,
        "locked": (r.outlet_id, r.year, r.month) in locked,
    } for r in rows]


def _slip_json(db: Session, s: Payslip) -> dict:
    emp = db.get(Employee, s.employee_id)
    divisor = s.rate_divisor or 26
    per_day = round(s.monthly_salary_paise / divisor, 2)
    adj = [{
        "id": a.id, "kind": a.kind,
        "days": a.value_x10_or_paise / 10 if a.kind == "bonus_days" else None,
        "amount_rupees": round(a.value_x10_or_paise / 100, 2)
        if a.kind in ("bonus_amt", "deduction") else None,
        "reason": a.reason,
    } for a in db.query(PayslipAdjustment).filter_by(payslip_id=s.id).all()]
    return {
        "id": s.id, "employee_id": s.employee_id,
        "name": emp.name if emp else "?", "designation": emp.designation if emp else "",
        "monthly_salary_rupees": round(s.monthly_salary_paise / 100, 2),
        "divisor": divisor, "per_day_rupees": round(per_day / 100, 2),
        "presents": s.presents, "halves": s.halves, "doubles": s.doubles,
        "absents": s.absents, "lates_count": s.lates_count,
        "credited_days": s.credited_days_x10 / 10.0,
        "gross_rupees": round(s.gross_paise / 100, 2),
        "bonus_rupees": round(s.bonus_paise / 100, 2),
        "deduction_rupees": round(s.deduction_paise / 100, 2),
        "advance_recovery_rupees": round(s.advance_recovery_paise / 100, 2),
        "net_rupees": round(s.net_paise / 100, 2),
        "paid_rupees": round(s.paid_paise / 100, 2),
        "mode": s.mode, "paid_on": s.paid_on, "note": s.note,
        "adjustments": adj,
    }


@router.post("/runs")
def open_run(body: RunIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    run = (db.query(PayrollRun)
             .filter_by(outlet_id=body.outlet_id, year=body.year, month=body.month)
             .first())
    if run is None:
        locked = (db.query(MonthLock)
                    .filter_by(outlet_id=body.outlet_id, year=body.year, month=body.month)
                    .first())
        if locked:
            raise HTTPException(409, "Month is locked")
        run = PayrollRun(outlet_id=body.outlet_id, year=body.year, month=body.month)
        db.add(run)
        db.flush()
    if run.status == "draft":
        rebuild_run(db, run)
    db.commit()
    return _run_detail(db, run)


@router.get("/runs/{run_id}")
def get_run(run_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    run = db.get(PayrollRun, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    return _run_detail(db, run)


def _run_detail(db: Session, run: PayrollRun) -> dict:
    slips = (db.query(Payslip).filter_by(run_id=run.id).all())
    slips.sort(key=lambda s: _emp_name(db, s.employee_id))
    total_net = sum(s.net_paise for s in slips)
    total_paid = sum(s.paid_paise for s in slips)
    return {
        **{
            "id": run.id, "outlet_id": run.outlet_id, "year": run.year,
            "month": run.month, "status": run.status,
            "finalized_at": run.finalized_at.isoformat() if run.finalized_at else None,
            "total_net_rupees": round(total_net / 100, 2),
            "total_paid_rupees": round(total_paid / 100, 2),
        },
        "payslips": [_slip_json(db, s) for s in slips],
    }


def _emp_name(db: Session, emp_id: int) -> str:
    e = db.get(Employee, emp_id)
    return e.name if e else "~"


@router.post("/runs/{run_id}/rebuild")
def rebuild(run_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    run = db.get(PayrollRun, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    if run.status != "draft":
        raise HTTPException(409, "Finalized runs are immutable")
    assert_month_open(db, run.outlet_id, f"{run.year:04d}-{run.month:02d}-01")
    rebuild_run(db, run)
    db.commit()
    return _run_detail(db, run)


@router.post("/payslips/{slip_id}/adjust")
def adjust(slip_id: int, body: AdjustIn, db: Session = Depends(get_db),
           user: User = Depends(current_user)):
    slip = db.get(Payslip, slip_id)
    if slip is None:
        raise HTTPException(404, "Payslip not found")
    run = db.get(PayrollRun, slip.run_id)
    if run.status != "draft":
        raise HTTPException(409, "Finalized runs are immutable")
    assert_month_open(db, run.outlet_id, f"{run.year:04d}-{run.month:02d}-01")
    kind = body.kind
    value = None
    if kind == "bonus_days":
        value = int(round((body.days or 0) * 10))
    elif kind == "bonus_amt":
        value = int(round((body.amount_rupees or 0) * 100))
    elif kind == "deduction":
        value = int(round((body.amount_rupees or 0) * 100))
    else:
        raise HTTPException(422, "Bad adjustment kind")
    if not value:
        raise HTTPException(422, "Value required")
    a = PayslipAdjustment(payslip_id=slip.id, kind=kind, value_x10_or_paise=value,
                          reason=body.reason, added_by=user.id)
    db.add(a)
    rebuild_run(db, run)
    audit(db, None, user.id, "payroll-adjust", "payslip", slip.id,
          after={"kind": kind, "reason": body.reason})
    db.commit()
    return _slip_json(db, db.get(Payslip, slip.id))


@router.delete("/adjustments/{adj_id}")
def remove_adjust(adj_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    a = db.get(PayslipAdjustment, adj_id)
    if a is None:
        raise HTTPException(404, "Adjustment not found")
    slip = db.get(Payslip, a.payslip_id)
    run = db.get(PayrollRun, slip.run_id)
    if run.status != "draft":
        raise HTTPException(409, "Finalized runs are immutable")
    assert_month_open(db, run.outlet_id, f"{run.year:04d}-{run.month:02d}-01")
    db.delete(a)
    rebuild_run(db, run)
    audit(db, None, user.id, "payroll-adjust-remove", "payslip", slip.id)
    db.commit()
    return {"ok": True}


@router.post("/runs/{run_id}/finalize")
def finalize(run_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    run = db.get(PayrollRun, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")
    if run.status != "draft":
        raise HTTPException(409, "Finalized runs are immutable")
    assert_month_open(db, run.outlet_id, f"{run.year:04d}-{run.month:02d}-01")
    finalize_run(db, run, user.id)
    audit(db, None, user.id, "payroll-finalize", "payroll_run", run.id,
          note=f"{run.year}-{run.month:02d} finalized")
    db.commit()
    return _run_detail(db, run)


@router.post("/payslips/{slip_id}/paid")
def mark_paid(slip_id: int, body: PaidIn, db: Session = Depends(get_db),
              user: User = Depends(current_user)):
    slip = db.get(Payslip, slip_id)
    if slip is None:
        raise HTTPException(404, "Payslip not found")
    run = db.get(PayrollRun, slip.run_id)
    if run.status != "finalized":
        raise HTTPException(409, "Finalize the month before marking payouts")
    assert_month_open(db, run.outlet_id, f"{run.year:04d}-{run.month:02d}-01")
    slip.paid_paise = max(0, slip.net_paise)
    slip.mode = body.mode
    slip.paid_on = body.paid_on
    audit(db, None, user.id, "payslip-paid", "payslip", slip.id,
          after={"net_rupees": round(slip.net_paise / 100, 2), "mode": body.mode})
    db.commit()
    return _slip_json(db, slip)
