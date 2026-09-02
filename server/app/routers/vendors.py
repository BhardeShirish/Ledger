"""Vendors + khata ledger (purchase credits raise dues, payments lower them)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..audit import audit, check_edit_window
from ..db import get_db
from ..models import Expense, User, Vendor, VendorEntry
from ..security import current_user, require_owner
from .helpers import assert_outlet_access

router = APIRouter(prefix="/vendors", tags=["vendors"])


class VendorIn(BaseModel):
    name: str
    phone: str = ""
    notes: str = ""


class EntryIn(BaseModel):
    outlet_id: int
    date: str
    type: str                       # purchase_credit | payment | adjustment
    amount_rupees: float
    mode: str | None = None         # informational for payments
    expense_category_id: int | None = None   # category for the auto credit-expense
    note: str = ""
    receipt_path: str | None = None


def _balance(db: Session, vendor_id: int) -> int:
    r = (db.query(VendorEntry)
           .filter_by(vendor_id=vendor_id)
           .with_entities(
               VendorEntry.type,
               VendorEntry.amount_paise).all())
    bal = 0
    for t, amt in r:
        if t == "purchase_credit":
            bal += amt
        elif t == "payment":
            bal -= amt
        else:
            bal -= amt  # adjustment reduces dues
    return bal


def _serialize(v: Vendor, db: Session) -> dict:
    return {
        "id": v.id, "name": v.name, "phone": v.phone, "notes": v.notes,
        "is_active": v.is_active,
        "balance_paise": _balance(db, v.id),
        "balance_rupees": round(_balance(db, v.id) / 100, 2),
    }


def _default_credit_category(db: Session) -> int:
    """Raw Material is the sensible default bucket for credit purchases."""
    from ..models import ExpenseCategory
    cat = (db.query(ExpenseCategory)
             .filter(func.lower(ExpenseCategory.name).like("raw%"))
             .first()) or db.query(ExpenseCategory).order_by(ExpenseCategory.id).first()
    if cat is None:
        cat = ExpenseCategory(name="Credit Purchases")
        db.add(cat)
        db.flush()
    return cat.id


@router.get("")
def list_vendors(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.query(Vendor).order_by(Vendor.is_active.desc(), Vendor.name).all()
    return [_serialize(v, db) for v in rows]


@router.post("", status_code=201)
def create_vendor(body: VendorIn, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    v = Vendor(name=body.name.strip(), phone=body.phone, notes=body.notes)
    db.add(v)
    db.flush()
    audit(db, None, user.id, "create", "vendor", v.id, after={"name": v.name})
    db.commit()
    return _serialize(v, db)


@router.patch("/{vendor_id}")
def update_vendor(vendor_id: int, body: VendorIn, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    v = db.get(Vendor, vendor_id)
    if v is None:
        raise HTTPException(404, "Vendor not found")
    v.name = body.name.strip()
    v.phone = body.phone
    v.notes = body.notes
    db.commit()
    return _serialize(v, db)


@router.delete("/{vendor_id}")
def deactivate_vendor(vendor_id: int, user: User = Depends(require_owner),
                      db: Session = Depends(get_db)):
    v = db.get(Vendor, vendor_id)
    if v is None:
        raise HTTPException(404, "Vendor not found")
    v.is_active = False
    audit(db, None, user.id, "deactivate", "vendor", vendor_id)
    db.commit()
    return {"ok": True}


@router.get("/{vendor_id}/ledger")
def ledger(vendor_id: int, limit: int = 200,
           user: User = Depends(current_user), db: Session = Depends(get_db)):
    v = db.get(Vendor, vendor_id)
    if v is None:
        raise HTTPException(404, "Vendor not found")
    rows = (db.query(VendorEntry)
              .filter_by(vendor_id=vendor_id)
              .order_by(VendorEntry.date.desc(), VendorEntry.id.desc())
              .limit(limit).all())
    return {
        "vendor": _serialize(v, db),
        "rows": [{
            "id": r.id, "date": r.date, "type": r.type,
            "amount_paise": r.amount_paise,
            "amount_rupees": round(r.amount_paise / 100, 2),
            "note": r.note, "receipt_path": r.receipt_path,
        } for r in rows],
    }


@router.post("/{vendor_id}/entries", status_code=201)
def add_entry(vendor_id: int, body: EntryIn, user: User = Depends(current_user),
              db: Session = Depends(get_db)):
    v = db.get(Vendor, vendor_id)
    if v is None:
        raise HTTPException(404, "Vendor not found")
    assert_outlet_access(db, user, body.outlet_id)
    check_edit_window(body.date, user, db)
    if body.amount_rupees <= 0:
        raise HTTPException(422, "Amount must be positive")
    if body.type not in ("purchase_credit", "payment", "adjustment"):
        raise HTTPException(422, "Bad entry type")
    expense_id = None
    if body.type == "purchase_credit":
        # Credit purchase counts as an expense immediately (mode=credit) so
        # the month's P&L shows true cost; the later payment is settlement.
        e = Expense(outlet_id=body.outlet_id, business_date=body.date,
                    category_id=body.expense_category_id
                    or _default_credit_category(db),
                    vendor_id=vendor_id,
                    amount_paise=int(round(body.amount_rupees * 100)),
                    mode="credit",
                    description=f"Credit purchase from {v.name}"
                                + (f" — {body.note}" if body.note else ""),
                    receipt_path=body.receipt_path, entered_by=user.id)
        db.add(e)
        db.flush()
        expense_id = e.id
    # payments/adjustments are settlements: they change dues, never P&L.
    entry = VendorEntry(vendor_id=vendor_id, outlet_id=body.outlet_id,
                        date=body.date, type=body.type,
                        amount_paise=int(round(body.amount_rupees * 100)),
                        expense_id=expense_id, note=body.note,
                        receipt_path=body.receipt_path, entered_by=user.id)
    db.add(entry)
    db.flush()
    audit(db, None, user.id, f"vendor-{body.type}", "vendor_entry", entry.id,
          after={"amount_rupees": body.amount_rupees})
    db.commit()
    return {"id": entry.id, "expense_id": expense_id,
            "balance_rupees": round(_balance(db, vendor_id) / 100, 2)}
