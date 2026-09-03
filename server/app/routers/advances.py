"""Salary advances — owner only."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..audit import audit
from ..db import get_db
from ..models import Advance, AdvanceRepayment, Employee, User
from ..security import current_user, require_stepup

router = APIRouter(prefix="/advances", tags=["advances"], dependencies=[Depends(require_stepup)])


class AdvanceIn(BaseModel):
    employee_id: int
    date: str
    amount_rupees: float
    note: str = ""


class RepayIn(BaseModel):
    date: str
    amount_rupees: float
    via: str = "upi"
    note: str = ""


def _serialize(db: Session, a: Advance) -> dict:
    emp = db.get(Employee, a.employee_id)
    return {
        "id": a.id, "employee_id": a.employee_id,
        "employee_name": emp.name if emp else "?",
        "date": a.date,
        "amount_paise": a.amount_paise,
        "remaining_paise": a.remaining_paise,
        "amount_rupees": round(a.amount_paise / 100, 2),
        "remaining_rupees": round(a.remaining_paise / 100, 2),
        "status": a.status, "note": a.note,
    }


@router.get("")
def list_advances(employee_id: int | None = None, status: str | None = None,
                  db: Session = Depends(get_db), user: User = Depends(current_user)):
    q = db.query(Advance)
    if employee_id:
        q = q.filter(Advance.employee_id == employee_id)
    if status:
        q = q.filter(Advance.status == status)
    rows = q.order_by(Advance.date.desc(), Advance.id.desc()).limit(300).all()
    return [_serialize(db, a) for a in rows]


@router.post("", status_code=201)
def give_advance(body: AdvanceIn, db: Session = Depends(get_db),
                 user: User = Depends(current_user)):
    paise_amt = int(round(body.amount_rupees * 100))
    if paise_amt <= 0:
        raise HTTPException(422, "Amount must be positive")
    a = Advance(employee_id=body.employee_id, date=body.date,
                amount_paise=paise_amt, remaining_paise=paise_amt,
                note=body.note, created_by=user.id)
    db.add(a)
    db.flush()
    audit(db, None, user.id, "advance-give", "advance", a.id,
          after={"employee_id": body.employee_id, "amount_rupees": body.amount_rupees})
    db.commit()
    return _serialize(db, a)


@router.post("/{advance_id}/repay")
def repay(advance_id: int, body: RepayIn, db: Session = Depends(get_db),
          user: User = Depends(current_user)):
    a = db.get(Advance, advance_id)
    if a is None:
        raise HTTPException(404, "Advance not found")
    amt = int(round(body.amount_rupees * 100))
    if amt <= 0 or amt > a.remaining_paise:
        raise HTTPException(422, "Invalid repayment amount")
    a.remaining_paise -= amt
    if a.remaining_paise == 0:
        a.status = "cleared"
    db.add(AdvanceRepayment(advance_id=a.id, date=body.date, amount_paise=amt,
                            via=body.via, note=body.note))
    audit(db, None, user.id, "advance-repay", "advance", a.id,
          after={"amount_rupees": body.amount_rupees, "via": body.via})
    db.commit()
    return _serialize(db, a)
