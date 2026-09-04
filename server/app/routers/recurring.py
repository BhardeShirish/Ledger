"""Costs that arrive every month whether or not anyone remembers them.

Rent, internet, licences and insurance are the costs most often missing
from a small restaurant's books. Their absence does not just understate
spending — it makes margin, break-even and every benchmark ratio wrong,
which is worse than having no figures at all, because a wrong figure gets
believed.

The fix is to record the standing amount once and post it automatically.
Posting real Expense rows rather than adding a number at report time is
deliberate: every existing screen, export and total then includes rent
with no changes, and the owner can see and correct the entry like any
other. The unique index on (outlet_id, idempotency_key) makes a double
post impossible even if two requests race.
"""
from __future__ import annotations

import calendar
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Expense, ExpenseCategory, RecurringCost, User, Vendor
from ..security import current_user, require_owner
from .insights import _today

router = APIRouter(prefix="/recurring", tags=["recurring"])

MAX_BACKFILL_MONTHS = 36


class RecurringIn(BaseModel):
    category_id: int
    name: str = ""
    amount_rupees: float = Field(gt=0)
    day_of_month: int = Field(default=1, ge=1, le=31)
    start_month: str                      # YYYY-MM
    end_month: str | None = None
    vendor_id: int | None = None
    mode: str = "bank"
    note: str = ""
    outlet_id: int | None = None


def _month_key(iso_month: str) -> tuple[int, int]:
    y, m = iso_month.split("-")
    return int(y), int(m)


def _valid_month(value: str) -> bool:
    try:
        y, m = _month_key(value)
    except (ValueError, AttributeError):
        return False
    return 2000 <= y <= 2999 and 1 <= m <= 12


def _months_between(start: str, end: str) -> list[str]:
    """Every YYYY-MM from start to end inclusive."""
    sy, sm = _month_key(start)
    ey, em = _month_key(end)
    out = []
    y, m = sy, sm
    while (y, m) <= (ey, em) and len(out) <= MAX_BACKFILL_MONTHS:
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def _due_date(month: str, day: int) -> str:
    """The day this cost lands, clamped to months that are shorter.

    A rent set for the 31st must still post in February rather than
    silently skipping the month.
    """
    y, m = _month_key(month)
    return date(y, m, min(day, calendar.monthrange(y, m)[1])).isoformat()


def post_due(db: Session, *, upto: str | None = None) -> int:
    """Post every standing cost that is due and not already posted.

    Idempotent by construction: the key is the cost and the month, and the
    database refuses a second row with the same key.
    """
    today = upto or _today().isoformat()
    this_month = today[:7]
    made = 0
    rows = db.query(RecurringCost).filter(RecurringCost.is_active == True).all()  # noqa: E712
    for r in rows:
        if not _valid_month(r.start_month):
            continue
        last = min(m for m in (r.end_month or this_month, this_month) if m)
        for month in _months_between(r.start_month, last):
            when = _due_date(month, r.day_of_month)
            if when > today:
                continue          # not due yet — never post a cost early
            key = f"rec:{r.id}:{month}"
            seen = (db.query(Expense.id)
                      .filter(Expense.outlet_id == r.outlet_id,
                              Expense.idempotency_key == key).first())
            if seen:
                continue
            db.add(Expense(
                outlet_id=r.outlet_id, business_date=when,
                category_id=r.category_id, vendor_id=r.vendor_id,
                amount_paise=r.amount_paise, mode=r.mode,
                description=(r.name or "Monthly cost"),
                item_name=r.name or "", idempotency_key=key,
                entered_by=None))
            made += 1
    if made:
        db.commit()
    return made


def _shape(db: Session, r: RecurringCost) -> dict:
    cat = db.get(ExpenseCategory, r.category_id)
    ven = db.get(Vendor, r.vendor_id) if r.vendor_id else None
    return {
        "id": r.id, "outlet_id": r.outlet_id, "category_id": r.category_id,
        "category": cat.name if cat else "", "name": r.name,
        "amount_rupees": round(r.amount_paise / 100, 2),
        "day_of_month": r.day_of_month, "start_month": r.start_month,
        "end_month": r.end_month, "vendor_id": r.vendor_id,
        "vendor": ven.name if ven else "", "mode": r.mode, "note": r.note,
        "is_active": r.is_active,
        "yearly_rupees": round(r.amount_paise * 12 / 100, 2),
    }


@router.get("")
def list_recurring(user: User = Depends(current_user),
                   db: Session = Depends(get_db)):
    post_due(db)
    rows = db.query(RecurringCost).order_by(RecurringCost.id).all()
    active = [r for r in rows if r.is_active]
    return {
        "items": [_shape(db, r) for r in rows],
        "monthly_total_rupees": round(
            sum(r.amount_paise for r in active) / 100, 2),
    }


def _check(db: Session, body: RecurringIn) -> None:
    if not _valid_month(body.start_month):
        raise HTTPException(422, "Start month must look like 2026-04.")
    if body.end_month is not None and body.end_month != "":
        if not _valid_month(body.end_month):
            raise HTTPException(422, "End month must look like 2026-04.")
        if body.end_month < body.start_month:
            raise HTTPException(422, "The end month is before the start month.")
    if db.get(ExpenseCategory, body.category_id) is None:
        raise HTTPException(422, "Pick a category that exists.")
    if round(body.amount_rupees * 100) <= 0:
        raise HTTPException(422, "Give the amount.")


@router.post("", status_code=201)
def add_recurring(body: RecurringIn, user: User = Depends(require_owner),
                  db: Session = Depends(get_db)):
    _check(db, body)
    r = RecurringCost(
        outlet_id=body.outlet_id or 1, category_id=body.category_id,
        name=body.name.strip(), amount_paise=round(body.amount_rupees * 100),
        day_of_month=body.day_of_month, start_month=body.start_month,
        end_month=(body.end_month or None), vendor_id=body.vendor_id,
        mode=body.mode, note=body.note, is_active=True)
    db.add(r)
    db.commit()
    posted = post_due(db)
    return {**_shape(db, r), "posted_now": posted}


@router.put("/{cost_id}")
def edit_recurring(cost_id: int, body: RecurringIn,
                   user: User = Depends(require_owner),
                   db: Session = Depends(get_db)):
    r = db.get(RecurringCost, cost_id)
    if r is None:
        raise HTTPException(404, "Not found")
    _check(db, body)
    r.category_id = body.category_id
    r.name = body.name.strip()
    r.amount_paise = round(body.amount_rupees * 100)
    r.day_of_month = body.day_of_month
    r.start_month = body.start_month
    r.end_month = body.end_month or None
    r.vendor_id = body.vendor_id
    r.mode = body.mode
    r.note = body.note
    db.commit()
    # Changing the amount must not rewrite months already posted and
    # possibly already reconciled against a bank statement. A correction to
    # a past month is an edit of that expense, not a rewrite of history.
    posted = post_due(db)
    return {**_shape(db, r), "posted_now": posted}


@router.delete("/{cost_id}")
def stop_recurring(cost_id: int, user: User = Depends(require_owner),
                   db: Session = Depends(get_db)):
    r = db.get(RecurringCost, cost_id)
    if r is None:
        raise HTTPException(404, "Not found")
    # Stopping a standing cost leaves the months it already posted alone:
    # the rent for March was really paid, and deleting it would silently
    # improve a month that is already closed.
    r.is_active = False
    db.commit()
    return {"ok": True, "kept_past_entries": True}
