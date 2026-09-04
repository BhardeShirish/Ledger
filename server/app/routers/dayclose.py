"""Cash register: expected-drawer math, day close with variance, reopen."""
import math
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..audit import audit, check_edit_window, get_setting_db
from ..config import DEFAULT_VARIANCE_ALERT_PAISE
from ..db import get_db
from ..models import (Advance, DayClosure, Employee, Expense, SalesDaily, User)
from ..security import current_user
from .helpers import assert_outlet_access

router = APIRouter(prefix="/cash", tags=["cash"])


class CloseIn(BaseModel):
    outlet_id: int
    date: str
    counted_rupees: float
    taken_home_rupees: float = 0
    breakdown: dict | None = None      # {"500": 3, "100": 2, ...} note denominations
    note: str = ""


_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _day_label(iso: str) -> str:
    """'2026-08-25' -> '25 Aug'. This string is shown to the user as-is."""
    try:
        y, m, d = (int(x) for x in iso[:10].split("-"))
        return f"{d} {_MON[m - 1]}"
    except (ValueError, IndexError):
        return iso


def _opening_float(db: Session, outlet_id: int, d: str) -> tuple[int, str]:
    """Yesterday's counted − moved-to-bank, else the outlet's seeded float."""
    from datetime import date as D, timedelta
    prev = (D.fromisoformat(d) - timedelta(days=1)).isoformat()
    last = (db.query(DayClosure)
              .filter_by(outlet_id=outlet_id)
              .filter(DayClosure.business_date < d)
              .order_by(DayClosure.business_date.desc())
              .first())
    if last and last.business_date == prev:
        return last.counted_cash_paise - last.moved_to_bank_paise, \
            f"carried from {_day_label(prev)}"
    from ..models import Outlet
    o = db.get(Outlet, outlet_id)
    base = o.opening_float_paise if o else 0
    if last:
        # gap days: drawer persisted untouched; base float only applies when
        # no closure history exists at all
        return last.counted_cash_paise - last.moved_to_bank_paise, \
            f"carried from {_day_label(last.business_date)}"
    return base, "outlet default"


def expected_breakdown(db: Session, outlet_id: int, d: str) -> dict:
    opening, opening_src = _opening_float(db, outlet_id, d)

    cs_rows = (db.query(SalesDaily)
                 .filter_by(outlet_id=outlet_id, business_date=d,
                            channel_kind="cash").all())
    # manual rows carry the amount in amount_paise; POS imports in total_paise
    cash_sales = sum(
        (r.total_paise if r.source == "petpooja" else (r.amount_paise or 0))
        for r in cs_rows)

    cash_expenses = (db.query(Expense)
                       .filter_by(outlet_id=outlet_id, business_date=d, mode="cash")
                       .with_entities(Expense.amount_paise).all())
    cash_expenses = sum((r[0] or 0) for r in cash_expenses)

    advs = (db.query(Advance)
              .join(Employee, Advance.employee_id == Employee.id)
              .filter(Employee.outlet_id == outlet_id,
                      Advance.date == d).with_entities(Advance.amount_paise).all())
    advances = sum((r[0] or 0) for r in advs)

    # Cash refunds and similar known payouts left the till, so the day should
    # expect less. Shortages are excluded by design (see losses.LOSS_KINDS).
    from .losses import drawer_losses_paise
    losses = drawer_losses_paise(db, outlet_id, d)

    # Vendor cash payments are already recorded as cash expenses, so no double count.

    # A part-paid bill was settled across two modes, and the POS report does
    # not say how much of it was cash. Those rupees are therefore missing
    # from cash_sales above, and the drawer will legitimately count high by
    # somewhere between nothing and the whole amount. Stating that band is
    # the only honest option: guessing a share would invent a variance, and
    # staying silent makes an unexplained surplus look like a mistake — or
    # trains the owner to wave every alert away.
    split_rows = (db.query(SalesDaily)
                    .filter_by(outlet_id=outlet_id, business_date=d,
                               channel_kind="split").all())
    split_unknown = sum(
        (r.total_paise if r.source == "petpooja" else (r.amount_paise or 0))
        for r in split_rows)

    expected = opening + cash_sales - cash_expenses - advances - losses
    return {
        "opening_paise": opening, "opening_source": opening_src,
        "cash_sales_paise": cash_sales, "cash_expenses_paise": cash_expenses,
        "advances_given_paise": advances,
        "cash_losses_paise": losses,
        "split_unknown_paise": split_unknown,
        "expected_paise": expected,
        "variance_alert_paise": int(get_setting_db(
            db, "variance_alert_paise", DEFAULT_VARIANCE_ALERT_PAISE)),
    }


@router.get("/day")
def day(outlet_id: int, date: str, user: User = Depends(current_user),
        db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    live = expected_breakdown(db, outlet_id, date)
    closure = (db.query(DayClosure)
                 .filter_by(outlet_id=outlet_id, business_date=date).first())
    data = {
        "opening_paise": live["opening_paise"],
        "opening_source": live["opening_source"],
        "cash_sales_paise": live["cash_sales_paise"],
        "cash_expenses_paise": live["cash_expenses_paise"],
        "advances_given_paise": live["advances_given_paise"],
        "cash_losses_paise": live["cash_losses_paise"],
        "split_unknown_paise": live["split_unknown_paise"],
        "expected_paise": live["expected_paise"],
        "variance_alert_paise": live["variance_alert_paise"],
    }
    if closure and not closure.reopened_at:
        # a closed day shows its frozen expectation, not today's hindsight
        data["expected_paise"] = closure.expected_cash_paise
        data["frozen"] = True
    else:
        data["frozen"] = False
    data["closure"] = _serialize(closure) if closure else None
    return data


@router.post("/close")
def close(body: CloseIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    check_edit_window(body.date, user, db)
    if (
        not math.isfinite(body.counted_rupees)
        or not math.isfinite(body.taken_home_rupees)
        or body.counted_rupees < 0
        or body.taken_home_rupees < 0
    ):
        raise HTTPException(422, "Cash values must be finite and non-negative")
    if body.taken_home_rupees > body.counted_rupees:
        raise HTTPException(422, "Taken-home cash cannot exceed counted cash")
    exp = expected_breakdown(db, body.outlet_id, body.date)
    counted = int(round(body.counted_rupees * 100))
    row = (db.query(DayClosure)
             .filter_by(outlet_id=body.outlet_id, business_date=body.date).first())
    if row is not None and row.reopened_at is None:
        # Authorized callers may re-close directly: the save itself counts as
        # the reopen. Managers only for today; owner any day.
        if not (user.role == "owner" or body.date == __import__("app.util", fromlist=["today_iso"]).today_iso()):
            raise HTTPException(403,
                "This day is closed and locked. Only the owner can change past days.")
        audit(db, None, user.id, "auto-reopen-day", "day_closure",
              f"{body.outlet_id}@{body.date}",
              note="re-closed directly over an existing closure")
    if row is None:
        row = DayClosure(outlet_id=body.outlet_id, business_date=body.date)
        db.add(row)
    row.expected_cash_paise = exp["expected_paise"]
    row.counted_cash_paise = counted
    row.variance_paise = counted - exp["expected_paise"]
    row.moved_to_bank_paise = int(round(body.taken_home_rupees * 100))
    row.counted_breakdown = body.breakdown
    row.note = body.note
    row.reopened_at = None
    row.closed_by = user.id
    audit(db, None, user.id, "close-day", "day_closure",
          f"{body.outlet_id}@{body.date}",
          after={"counted_rupees": body.counted_rupees,
                 "taken_home_rupees": body.taken_home_rupees,
                 "variance_rupees": row.variance_paise / 100})
    db.commit()
    return _serialize(row)


@router.post("/{closure_id}/reopen")
def reopen(closure_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Manager may reopen TODAY's closure only; older days need the owner
    (step-up elevation is enforced by the edit-window rule)."""
    row = db.get(DayClosure, closure_id)
    if row is None:
        raise HTTPException(404, "Closure not found")
    assert_outlet_access(db, user, row.outlet_id)
    check_edit_window(row.business_date, user, db)
    if row.business_date != __import__("app.util", fromlist=["today_iso"]).today_iso() \
            and user.role != "owner":
        raise HTTPException(403, "Only the owner can reopen past days")
    row.reopened_at = datetime.now()
    row.reopened_by = user.id
    audit(db, None, user.id, "reopen-day", "day_closure",
          f"{row.outlet_id}@{row.business_date}")
    db.commit()
    return {"ok": True}


@router.get("/closures")
def closures(outlet_id: int, limit: int = 31,
             user: User = Depends(current_user), db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    rows = (db.query(DayClosure)
              .filter_by(outlet_id=outlet_id)
              .order_by(DayClosure.business_date.desc()).limit(limit).all())
    alert = int(get_setting_db(db, "variance_alert_paise", DEFAULT_VARIANCE_ALERT_PAISE))
    return {"alert_paise": alert, "rows": [_serialize(r) for r in rows]}


def _serialize(r: DayClosure) -> dict:
    return {
        "id": r.id, "outlet_id": r.outlet_id, "date": r.business_date,
        "expected_paise": r.expected_cash_paise, "counted_paise": r.counted_cash_paise,
        "variance_paise": r.variance_paise,
        "taken_home_paise": r.moved_to_bank_paise,
        "left_in_drawer_paise": r.counted_cash_paise - r.moved_to_bank_paise,
        "counted_breakdown": r.counted_breakdown,
        "note": r.note, "closed_at": r.closed_at.isoformat() if r.closed_at else None,
        "reopened": bool(r.reopened_at),
    }
