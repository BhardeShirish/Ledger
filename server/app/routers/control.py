"""Owner period controls and the computed close-ready exception inbox."""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..audit import audit
from ..db import get_db
from ..models import (Attendance, CashBankMatch, DayClosure, ImportBatch,
                      MonthLock, PayrollRun, SalesBill, SalesDaily, StockCount,
                      User, VendorEntry)
from ..security import current_user, require_stepup
from ..util import days_in_month, now_local
from ..owner_controls import owner_policy
from .helpers import assert_outlet_access, user_outlet_ids
from .vendors import open_payable_lots

router = APIRouter(prefix="/control", tags=["control"])


def _bounds(month: str) -> tuple[str, str, int, int]:
    try:
        year, number = map(int, month.split("-"))
        lo = date(year, number, 1)
    except (TypeError, ValueError):
        raise HTTPException(422, "Month must be YYYY-MM") from None
    return lo.isoformat(), (lo + timedelta(days=days_in_month(year, number) - 1)).isoformat(), year, number


def _inbox(db: Session, outlet_id: int, month: str) -> dict:
    start, end, year, number = _bounds(month)
    items: list[dict] = []
    sale_days = {
        row[0] for row in db.query(SalesDaily.business_date)
        .filter(SalesDaily.outlet_id == outlet_id,
                SalesDaily.business_date >= start, SalesDaily.business_date <= end)
        .distinct()
    }
    closed_days = {
        row[0] for row in db.query(DayClosure.business_date)
        .filter(DayClosure.outlet_id == outlet_id,
                DayClosure.business_date >= start, DayClosure.business_date <= end,
                DayClosure.reopened_at.is_(None))
        .distinct()
    }
    for business_date in sorted(sale_days - closed_days):
        items.append({"id": f"cash-close:{business_date}", "kind": "cash_close",
                      "severity": "blocker", "date": business_date,
                      "title": "Drawer has not been closed", "link": "/money/cash"})

    open_attendance = (db.query(Attendance)
                         .join(__import__("app.models", fromlist=["Employee"]).Employee)
                         .filter(__import__("app.models", fromlist=["Employee"]).Employee.outlet_id == outlet_id,
                                 Attendance.business_date >= start, Attendance.business_date <= end,
                                 Attendance.is_open == True).all())  # noqa: E712
    for row in open_attendance:
        items.append({"id": f"open-attendance:{row.id}", "kind": "attendance",
                      "severity": "blocker", "date": row.business_date,
                      "title": "An attendance clock is still open", "link": "/staff/attendance"})

    for bill in (db.query(SalesBill)
                   .filter(SalesBill.outlet_id == outlet_id, SalesBill.channel_kind == "split",
                           SalesBill.business_date >= start, SalesBill.business_date <= end).all()):
        items.append({"id": f"split:{bill.id}", "kind": "payment_split",
                      "severity": "blocker", "date": bill.business_date,
                      "title": f"Bill {bill.invoice_no} has an unresolved payment split",
                      "link": "/sales/bills"})

    policy = owner_policy(db, outlet_id)
    alert = int(policy["cash_variance_alert_paise"])
    closures = (db.query(DayClosure)
                  .filter(DayClosure.outlet_id == outlet_id, DayClosure.reopened_at.is_(None),
                          DayClosure.business_date >= start, DayClosure.business_date <= end).all())
    matched = dict(db.query(CashBankMatch.closure_id, func.sum(CashBankMatch.amount_paise))
                   .group_by(CashBankMatch.closure_id).all())
    for closure in closures:
        remaining = closure.moved_to_bank_paise - (matched.get(closure.id) or 0)
        if remaining > 0:
            items.append({"id": f"deposit:{closure.id}", "kind": "cash_deposit",
                          "severity": "blocker", "date": closure.business_date,
                          "title": "Cash removed from drawer is not reconciled to bank",
                          "amount_paise": remaining, "link": "/money/bank"})
        if abs(closure.variance_paise) > alert:
            items.append({"id": f"variance:{closure.id}", "kind": "cash_variance",
                          "severity": "warning", "date": closure.business_date,
                          "title": "Cash variance needs an explanation",
                          "amount_paise": closure.variance_paise, "link": "/money/cash"})

    cadence_start = (date.fromisoformat(end) - timedelta(
        days=int(policy["stock_count_cadence_days"]) - 1)).isoformat()
    if not db.query(StockCount.id).filter(
        StockCount.outlet_id == outlet_id, StockCount.status == "done",
        StockCount.business_date >= cadence_start, StockCount.business_date <= end,
    ).first():
        items.append({"id": f"stock-count:{month}", "kind": "stock_count",
                      "severity": "warning", "date": end,
                      "title": "No physical stock count was finalized in the review cadence",
                      "link": "/inventory/counts"})
    run = db.query(PayrollRun).filter_by(outlet_id=outlet_id, year=year, month=number).first()
    if run is None or run.status != "finalized":
        items.append({"id": f"payroll:{month}", "kind": "payroll", "severity": "warning",
                      "date": end, "title": "Payroll is not finalized", "link": "/staff/payroll"})

    close_date = date.fromisoformat(end)
    open_lots = open_payable_lots(db, outlet_id, close_date)
    due = sum(lot["remaining_paise"] for lot in open_lots)
    overdue_due = sum(
        lot["remaining_paise"] for lot in open_lots
        if (close_date - date.fromisoformat(lot["date"])).days
        >= int(policy["payable_overdue_days"])
    )
    if due > 0:
        items.append({"id": f"payables:{month}", "kind": "payables", "severity": "warning",
                      "date": end, "title": "Supplier liabilities remain open",
                      "amount_paise": due, "link": "/money/vendors"})
    if overdue_due > 0:
        items.append({"id": f"payables-overdue:{month}", "kind": "payables_overdue",
                      "severity": "warning", "date": end,
                      "title": "Supplier liabilities exceed the overdue policy",
                      "amount_paise": overdue_due, "link": "/money/vendors"})

    items.sort(key=lambda item: (item["severity"] != "blocker", item["date"], item["id"]))
    lock = db.query(MonthLock).filter_by(outlet_id=outlet_id, year=year, month=number).first()
    return {"outlet_id": outlet_id, "month": month, "locked": bool(lock),
            "blockers": sum(item["severity"] == "blocker" for item in items), "items": items}


@router.get("/close-inbox")
def close_inbox(month: str, outlet_id: int, user: User = Depends(current_user),
                db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    return _inbox(db, outlet_id, month)


@router.get("/month")
def month_status(month: str, outlet_id: int, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    return _inbox(db, outlet_id, month)


class MonthActionIn(BaseModel):
    outlet_id: int
    month: str
    force: bool = False
    reason: str = ""


@router.post("/month/close")
def close_month(body: MonthActionIn, user: User = Depends(require_stepup),
                db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    start, end, year, number = _bounds(body.month)
    if end >= now_local().date().isoformat():
        raise HTTPException(422, "Only completed months can be closed")
    readiness = _inbox(db, body.outlet_id, body.month)
    if readiness["locked"]:
        raise HTTPException(409, "Month is already closed")
    if readiness["blockers"] and not body.force:
        raise HTTPException(409, "Resolve close blockers before closing this month")
    if body.force and not body.reason.strip():
        raise HTTPException(422, "A reason is required to close with blockers")
    db.add(MonthLock(outlet_id=body.outlet_id, year=year, month=number, locked_by=user.id))
    audit(db, None, user.id, "month-close", "month_lock", f"{body.outlet_id}@{body.month}",
          after={"force": body.force, "blockers": readiness["blockers"]}, note=body.reason.strip())
    db.commit()
    return _inbox(db, body.outlet_id, body.month)


@router.post("/month/reopen")
def reopen_month(body: MonthActionIn, user: User = Depends(require_stepup),
                 db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    _start, _end, year, number = _bounds(body.month)
    lock = db.query(MonthLock).filter_by(
        outlet_id=body.outlet_id, year=year, month=number).first()
    if lock is None:
        raise HTTPException(409, "Month is not closed")
    if not body.reason.strip():
        raise HTTPException(422, "A reason is required to reopen a month")
    db.delete(lock)
    audit(db, None, user.id, "month-reopen", "month_lock", f"{body.outlet_id}@{body.month}",
          note=body.reason.strip())
    db.commit()
    return _inbox(db, body.outlet_id, body.month)
