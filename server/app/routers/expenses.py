
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..audit import audit, check_edit_window
from ..db import get_db
from ..periods import assert_month_open
from ..models import Expense, PurchaseReceipt, PurchaseReceiptLine, User, utcnow
from ..security import current_user
from ..util import paise, validate_business_date
from .helpers import assert_outlet_access
from .inventory import drop_purchase_movement, ensure_purchase_movement
from ..vendor_ledger import sync_credit_entry_for_expense

router = APIRouter(prefix="/expenses", tags=["expenses"])

# UPI first: it is how most bills are paid now, and it is the safe default -
# a cash entry silently lowers the drawer the shop counts at closing.
MODES = ("upi", "cash", "card", "bank", "credit", "other")


def _assert_not_finalized_receipt_expense(db: Session, expense_id: int) -> None:
    """Receipt posting is immutable even through the general expense route."""
    line = (db.query(PurchaseReceiptLine.id)
              .join(PurchaseReceipt,
                    PurchaseReceipt.id == PurchaseReceiptLine.purchase_receipt_id)
              .filter(PurchaseReceiptLine.expense_id == expense_id,
                      PurchaseReceipt.status == "finalized")
              .first())
    if line:
        raise HTTPException(
            409,
            "This expense belongs to a finalized receipt and cannot be edited or deleted. "
            "Record any correction separately.",
        )


class ExpenseIn(BaseModel):
    outlet_id: int
    business_date: str
    category_id: int
    vendor_id: int | None = None
    amount_rupees: float
    mode: str = "upi"
    description: str = ""
    receipt_path: str | None = None
    item_name: str = ""          # unit economics (raw materials)
    quantity: float | None = None
    unit: str = ""


def _serialize(e: Expense) -> dict:
    return {
        "id": e.id, "outlet_id": e.outlet_id, "business_date": e.business_date,
        "category_id": e.category_id, "vendor_id": e.vendor_id,
        "amount_paise": e.amount_paise,
        "amount_rupees": round(e.amount_paise / 100, 2),
        "mode": e.mode, "description": e.description,
        "receipt_path": e.receipt_path,
        "item_name": e.item_name or "",
        "quantity": e.quantity,
        "unit": e.unit or "",
        "unit_price_rupees":
            round(e.amount_paise / 100 / e.quantity, 2) if e.quantity else None,
        "entered_at": e.created_at.isoformat() if e.created_at else None,
    }


class LineIn(BaseModel):
    item_name: str
    quantity: float | None = None
    unit: str = ""
    amount_rupees: float


class BulkExpenseIn(BaseModel):
    """One bill, many lines → one Expense per line (shared vendor/date/mode)."""
    outlet_id: int
    business_date: str
    category_id: int
    vendor_id: int | None = None
    mode: str = "upi"
    receipt_path: str | None = None
    note: str = ""
    bill_total_rupees: float | None = None      # from the bill; remainder booked as adjustment
    lines: list[LineIn]


@router.post("/bulk", status_code=201)
def create_bulk_expenses(body: BulkExpenseIn, user: User = Depends(current_user),
                         db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    validate_business_date(body.business_date, no_future=True)
    check_edit_window(body.business_date, user, db)
    assert_month_open(db, body.outlet_id, body.business_date)
    clean_lines = [ln for ln in body.lines
                   if ln.item_name.strip() and float(ln.amount_rupees or 0) > 0]
    if not clean_lines:
        raise HTTPException(422, "At least one item line with an amount is needed")
    if any((ln.quantity or 0) > 0 for ln in clean_lines) and not body.vendor_id:
        raise HTTPException(422,
            "Quantity given without a vendor — pick who the bill is from so "
            "unit prices can be compared later.")
    if body.mode not in MODES:
        raise HTTPException(422, "Bad payment mode")

    created_ids = []
    base_desc = body.note.strip()

    def add_line(item_name, qty, unit, rupees, desc):
        e = Expense(outlet_id=body.outlet_id, business_date=body.business_date,
                    category_id=body.category_id, vendor_id=body.vendor_id,
                    amount_paise=paise(rupees), mode=body.mode,
                    description=(desc or "").strip(),
                    receipt_path=body.receipt_path,
                    item_name=item_name.strip()[:120],
                    quantity=qty, unit=unit.strip(),
                    entered_by=user.id)
        db.add(e)
        db.flush()
        created_ids.append(e.id)
        if qty and qty > 0:
            ensure_purchase_movement(db, body.outlet_id, body.business_date,
                                     item_name, qty, unit,
                                     paise(rupees), user.id, e.id)
        sync_credit_entry_for_expense(db, e, user.id)

    lines_paise = 0
    for ln in clean_lines:
        amt = round(float(ln.amount_rupees), 2)
        lines_paise += paise(amt)
        desc = f"{ln.item_name.strip()} · {base_desc}" if base_desc \
            else f"{ln.item_name.strip()} — from bill"
        add_line(ln.item_name, ln.quantity, ln.unit, amt, desc)

    # reconcile against the printed bill total: positive diff becomes its own line
    mismatch_paise = 0
    if body.bill_total_rupees is not None:
        bill_paise = paise(body.bill_total_rupees)
        diff = bill_paise - lines_paise
        if diff > 0:
            add_line("Other charges / rounding", None, "",
                     diff / 100.0,
                     f"Other charges / rounding · balance of bill {base_desc}".strip())
        elif diff < 0:
            mismatch_paise = diff

    audit(db, None, user.id, "create-bulk", "expense",
          f"{len(created_ids)} lines @ {body.business_date}",
          after={"lines": len(clean_lines),
                 "bill_total_rupees": body.bill_total_rupees})
    db.commit()
    return {"created": len(created_ids),
            "mismatch_rupees": round(mismatch_paise / 100, 2)}


@router.get("")
def list_expenses(outlet_id: int | None = None, start: str | None = None,
                  end: str | None = None, category_id: int | None = None,
                  limit: int = 200, offset: int = 0,
                  user: User = Depends(current_user), db: Session = Depends(get_db)):
    from .helpers import user_outlet_ids
    q = db.query(Expense)
    ids = set(user_outlet_ids(db, user))
    q = q.filter(Expense.outlet_id.in_(ids))
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        q = q.filter(Expense.outlet_id == outlet_id)
    if start:
        q = q.filter(Expense.business_date >= start)
    if end:
        q = q.filter(Expense.business_date <= end)
    if category_id:
        q = q.filter(Expense.category_id == category_id)
    total = q.count()
    rows = (q.order_by(Expense.business_date.desc(), Expense.id.desc())
              .offset(offset).limit(min(limit, 500)).all())
    return {"total": total, "rows": [_serialize(e) for e in rows]}


@router.post("", status_code=201)
def create_expense(body: ExpenseIn, user: User = Depends(current_user),
                   idempotency_key: str | None = Header(
                       default=None, alias="X-Idempotency-Key"),
                   db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    validate_business_date(body.business_date, no_future=True)
    if idempotency_key:
        existing = (
            db.query(Expense)
            .filter_by(outlet_id=body.outlet_id,
                      idempotency_key=idempotency_key[:64])
            .first()
        )
        if existing:
            return _serialize(existing)
    check_edit_window(body.business_date, user, db)
    assert_month_open(db, body.outlet_id, body.business_date)
    if body.mode not in MODES:
        raise HTTPException(422, "Bad payment mode")
    if body.amount_rupees <= 0:
        raise HTTPException(422, "Amount must be positive")
    if (body.quantity is not None and body.quantity > 0) and not body.vendor_id:
        raise HTTPException(422,
            "Quantity given without a vendor — pick who you bought it from so "
            "unit prices can be compared later.")
    e = Expense(outlet_id=body.outlet_id, business_date=body.business_date,
                category_id=body.category_id, vendor_id=body.vendor_id,
                amount_paise=int(round(body.amount_rupees * 100)), mode=body.mode,
                description=body.description, receipt_path=body.receipt_path,
                item_name=body.item_name.strip(),
                quantity=body.quantity, unit=body.unit.strip(),
                entered_by=user.id,
                idempotency_key=idempotency_key[:64]
                if idempotency_key else None)
    db.add(e)
    db.flush()
    ensure_purchase_movement(db, body.outlet_id, body.business_date,
                             body.item_name, body.quantity or 0, body.unit,
                             e.amount_paise, user.id, e.id)
    sync_credit_entry_for_expense(db, e, user.id)
    audit(db, None, user.id, "create", "expense", e.id,
          after={"amount_rupees": body.amount_rupees, "date": body.business_date})
    db.commit()
    return _serialize(e)


@router.patch("/{expense_id}")
def update_expense(expense_id: int, body: dict, user: User = Depends(current_user),
                   db: Session = Depends(get_db)):
    e = db.get(Expense, expense_id)
    if e is None:
        raise HTTPException(404, "Expense not found")
    assert_outlet_access(db, user, e.outlet_id)
    _assert_not_finalized_receipt_expense(db, e.id)
    check_edit_window(e.business_date, user, db)
    assert_month_open(db, e.outlet_id, e.business_date)
    new_date = body.get("business_date")
    if "business_date" in body:
        validate_business_date(new_date, no_future=True)
        if new_date != e.business_date:
            check_edit_window(new_date, user, db)
            assert_month_open(db, e.outlet_id, new_date)
    before = {"amount_rupees": round(e.amount_paise / 100, 2), "mode": e.mode}
    if "mode" in body and body["mode"] not in MODES:
        raise HTTPException(422, f"Mode must be one of {', '.join(MODES)}")
    if "amount_rupees" in body:
        amount_paise = paise(body["amount_rupees"])
        if amount_paise <= 0:
            raise HTTPException(422, "Amount must be positive")
        e.amount_paise = amount_paise
    for k in ("mode", "description", "category_id", "vendor_id",
              "business_date", "receipt_path"):
        if k in body:
            setattr(e, k, body[k])
    e.updated_at = utcnow()
    e.updated_by = user.id
    # The amount and the date both live in the stock movement too, so rebuild
    # it from what the expense now says rather than leaving a stale copy.
    drop_purchase_movement(db, e.id)
    ensure_purchase_movement(db, e.outlet_id, e.business_date, e.item_name or "",
                             e.quantity or 0, e.unit or "", e.amount_paise,
                             user.id, e.id)
    sync_credit_entry_for_expense(db, e, user.id)
    audit(db, None, user.id, "update", "expense", e.id, before=before,
          after={"amount_rupees": round(e.amount_paise / 100, 2)})
    db.commit()
    return _serialize(e)


@router.delete("/{expense_id}")
def delete_expense(expense_id: int, user: User = Depends(current_user),
                   db: Session = Depends(get_db)):
    e = db.get(Expense, expense_id)
    if e is None:
        raise HTTPException(404, "Expense not found")
    assert_outlet_access(db, user, e.outlet_id)
    _assert_not_finalized_receipt_expense(db, e.id)
    check_edit_window(e.business_date, user, db)
    assert_month_open(db, e.outlet_id, e.business_date)
    drop_purchase_movement(db, e.id)
    db.delete(e)
    audit(db, None, user.id, "delete", "expense", e.id,
          before={"amount_rupees": round(e.amount_paise / 100, 2)})
    db.commit()
    return {"ok": True}
