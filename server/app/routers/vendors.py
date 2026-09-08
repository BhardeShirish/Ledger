"""Vendors + khata ledger (purchase credits raise dues, payments lower them)."""
from datetime import date
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..audit import audit, check_edit_window
from ..db import get_db
from ..models import Expense, User, Vendor, VendorEntry
from ..periods import assert_month_open
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


def _balance(db: Session, vendor_id: int, outlet_ids: list[int] | None = None) -> int:
    r = (db.query(VendorEntry)
           .filter_by(vendor_id=vendor_id))
    if outlet_ids is not None:
        r = r.filter(VendorEntry.outlet_id.in_(outlet_ids))
    r = (r
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


def _serialize(v: Vendor, db: Session, outlet_ids: list[int] | None = None) -> dict:
    balance = _balance(db, v.id, outlet_ids)
    return {
        "id": v.id, "name": v.name, "phone": v.phone, "notes": v.notes,
        "is_active": v.is_active,
        "balance_paise": balance,
        "balance_rupees": round(balance / 100, 2),
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


def open_payable_lots(db: Session, outlet_id: int, as_of: date) -> list[dict]:
    """FIFO credit lots still open at a cutoff, after every prior settlement."""
    rows = (db.query(VendorEntry)
              .filter(VendorEntry.outlet_id == outlet_id,
                      VendorEntry.date <= as_of.isoformat())
              .order_by(VendorEntry.vendor_id, VendorEntry.date, VendorEntry.id).all())
    lots: dict[int, list[dict]] = {}
    for row in rows:
        vendor_lots = lots.setdefault(row.vendor_id, [])
        if row.type == "purchase_credit":
            vendor_lots.append({
                "entry_id": row.id, "vendor_id": row.vendor_id, "date": row.date,
                "original_paise": row.amount_paise, "remaining_paise": row.amount_paise,
            })
            continue
        remaining = row.amount_paise
        for lot in vendor_lots:
            applied = min(lot["remaining_paise"], remaining)
            lot["remaining_paise"] -= applied
            remaining -= applied
            if remaining == 0:
                break
    return [lot for vendor_lots in lots.values() for lot in vendor_lots
            if lot["remaining_paise"] > 0]


@router.get("")
def list_vendors(outlet_id: int | None = None, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    rows = db.query(Vendor).order_by(Vendor.is_active.desc(), Vendor.name).all()
    from .helpers import user_outlet_ids
    outlet_ids = user_outlet_ids(db, user)
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        outlet_ids = [outlet_id]
    return [_serialize(v, db, outlet_ids) for v in rows]


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
    from .helpers import user_outlet_ids
    outlet_ids = user_outlet_ids(db, user)
    rows = (db.query(VendorEntry)
              .filter_by(vendor_id=vendor_id)
              .filter(VendorEntry.outlet_id.in_(outlet_ids))
              .order_by(VendorEntry.date.desc(), VendorEntry.id.desc())
              .limit(limit).all())
    return {
        "vendor": _serialize(v, db, outlet_ids),
        "rows": [{
            "id": r.id, "date": r.date, "type": r.type,
            "amount_paise": r.amount_paise,
            "amount_rupees": round(r.amount_paise / 100, 2),
            "note": r.note, "receipt_path": r.receipt_path,
        } for r in rows],
    }


@router.get("/aging")
def aging(outlet_id: int, as_of: str,
          user: User = Depends(current_user), db: Session = Depends(get_db)):
    """FIFO payable aging derived from immutable vendor-credit ledger entries."""
    assert_outlet_access(db, user, outlet_id)
    try:
        cutoff = date.fromisoformat(as_of)
    except ValueError:
        raise HTTPException(422, "as_of must be a valid ISO date") from None
    vendors = {vendor.id: vendor for vendor in db.query(Vendor).all()}
    lots: dict[int, list[dict]] = {}
    for lot in open_payable_lots(db, outlet_id, cutoff):
        lots.setdefault(lot["vendor_id"], []).append(lot)
    output = []
    for vendor_id, vendor_lots in lots.items():
        buckets = {"current": 0, "1_30": 0, "31_60": 0, "61_90": 0, "over_90": 0}
        for lot in vendor_lots:
            age = max(0, (cutoff - date.fromisoformat(lot["date"])).days)
            bucket = "current" if age == 0 else "1_30" if age <= 30 else \
                "31_60" if age <= 60 else "61_90" if age <= 90 else "over_90"
            buckets[bucket] += lot["remaining_paise"]
            lot["age_days"] = age
        output.append({
            "vendor_id": vendor_id, "vendor": vendors.get(vendor_id).name
            if vendor_id in vendors else "Unknown vendor",
            "total_paise": sum(lot["remaining_paise"] for lot in vendor_lots),
            "oldest_date": min(lot["date"] for lot in vendor_lots),
            "buckets": buckets, "open_lots": vendor_lots,
        })
    return sorted(output, key=lambda row: (-row["total_paise"], row["vendor"].lower()))


@router.post("/{vendor_id}/entries", status_code=201)
def add_entry(vendor_id: int, body: EntryIn, user: User = Depends(current_user),
              db: Session = Depends(get_db)):
    v = db.get(Vendor, vendor_id)
    if v is None:
        raise HTTPException(404, "Vendor not found")
    assert_outlet_access(db, user, body.outlet_id)
    check_edit_window(body.date, user, db)
    assert_month_open(db, body.outlet_id, body.date)
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
