"""Day losses: refunds, drawer shortages, spoilage and breakage.

Kept apart from expenses on purpose. An expense buys something; a loss is
value that simply left the business, and the two must not be mixed in
category analytics or vendor spend.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..audit import audit, check_edit_window
from ..db import get_db
from ..periods import assert_month_open
from ..models import DayLoss, User
from ..security import current_user
from ..util import paise
from .helpers import assert_outlet_access

router = APIRouter(prefix="/losses", tags=["losses"])

# `cash_capable` says whether this kind may be taken straight out of the till.
# cash_short is deliberately False: a shortage is exactly what the day-close
# variance measures, so allowing it to reduce expected cash would cancel the
# number that reveals it and let a shortage be declared away.
LOSS_KINDS: dict[str, dict] = {
    "refund":     {"label": "Refund / return to customer", "cash_capable": True},
    "cash_short": {"label": "Cash short (missing)", "cash_capable": False},
    "spoilage":   {"label": "Spoilage / wastage", "cash_capable": False},
    "breakage":   {"label": "Breakage", "cash_capable": False},
    "other":      {"label": "Other loss", "cash_capable": True},
}


class LossIn(BaseModel):
    outlet_id: int
    business_date: str
    kind: str
    amount_rupees: float
    from_drawer: bool = False
    note: str = ""


def _serialize(r: DayLoss) -> dict:
    return {
        "id": r.id, "outlet_id": r.outlet_id, "business_date": r.business_date,
        "kind": r.kind, "label": LOSS_KINDS.get(r.kind, {}).get("label", r.kind),
        "amount_paise": r.amount_paise,
        "amount_rupees": round(r.amount_paise / 100, 2),
        "from_drawer": bool(r.from_drawer),
        "note": r.note or "",
        "entered_at": r.created_at.isoformat() if r.created_at else None,
    }


def drawer_losses_paise(db: Session, outlet_id: int, date: str) -> int:
    """Cash that left the till for a known reason, so the day close can expect
    less without it looking like a shortage."""
    rows = (db.query(DayLoss)
              .filter_by(outlet_id=outlet_id, business_date=date, from_drawer=True)
              .all())
    return sum(r.amount_paise for r in rows)


def losses_paise(db: Session, outlet_ids: list[int], start: str, end: str) -> int:
    """Every recorded loss in a date range, whatever its kind.

    Profit figures subtract this: a refund, a smashed crate or cash gone
    missing all left the business just as surely as an expense did.
    """
    total = (db.query(func.sum(DayLoss.amount_paise))
               .filter(DayLoss.outlet_id.in_(outlet_ids),
                       DayLoss.business_date >= start,
                       DayLoss.business_date <= end).scalar())
    return int(total or 0)


@router.get("/kinds")
def kinds(user: User = Depends(current_user)):
    return [{"kind": k, **v} for k, v in LOSS_KINDS.items()]


@router.get("")
def list_losses(outlet_id: int, date: str | None = None,
                start: str | None = None, end: str | None = None,
                user: User = Depends(current_user), db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    q = db.query(DayLoss).filter_by(outlet_id=outlet_id)
    if date:
        q = q.filter(DayLoss.business_date == date)
    if start:
        q = q.filter(DayLoss.business_date >= start)
    if end:
        q = q.filter(DayLoss.business_date <= end)
    rows = q.order_by(DayLoss.business_date.desc(), DayLoss.id.desc()).all()
    return {
        "rows": [_serialize(r) for r in rows],
        "total_paise": sum(r.amount_paise for r in rows),
        "from_drawer_paise": sum(r.amount_paise for r in rows if r.from_drawer),
    }


@router.post("")
def create(body: LossIn, user: User = Depends(current_user),
           db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    check_edit_window(body.business_date, user, db, no_future=True)
    assert_month_open(db, body.outlet_id, body.business_date)

    spec = LOSS_KINDS.get(body.kind)
    if spec is None:
        raise HTTPException(422, f"Unknown loss type '{body.kind}'")
    amount = paise(body.amount_rupees)
    if amount <= 0:
        raise HTTPException(422, "A loss must be more than zero")
    if body.from_drawer and not spec["cash_capable"]:
        raise HTTPException(
            422,
            f"'{spec['label']}' cannot be taken out of the drawer. A cash "
            "shortage already shows up as the day-close variance.")

    row = DayLoss(outlet_id=body.outlet_id, business_date=body.business_date,
                  kind=body.kind, amount_paise=amount,
                  from_drawer=bool(body.from_drawer), note=body.note.strip(),
                  entered_by=user.id)
    db.add(row)
    db.flush()
    audit(db, None, user.id, "create-loss", "day_loss", row.id,
          after={"kind": row.kind, "amount_rupees": amount / 100,
                 "from_drawer": row.from_drawer, "date": row.business_date})
    db.commit()
    return _serialize(row)


@router.delete("/{loss_id}")
def delete(loss_id: int, user: User = Depends(current_user),
           db: Session = Depends(get_db)):
    row = db.get(DayLoss, loss_id)
    if row is None:
        raise HTTPException(404, "Loss not found")
    assert_outlet_access(db, user, row.outlet_id)
    check_edit_window(row.business_date, user, db)
    assert_month_open(db, row.outlet_id, row.business_date)
    audit(db, None, user.id, "delete-loss", "day_loss", row.id,
          before={"kind": row.kind, "amount_rupees": row.amount_paise / 100,
                  "from_drawer": row.from_drawer, "date": row.business_date})
    db.delete(row)
    db.commit()
    return {"ok": True}
