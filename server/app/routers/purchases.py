"""Purchase orders and controlled receiving.

Orders express an intention only.  The receipt finalization is the one point
where an expense, stock movement, and (when applicable) vendor payable exist.
"""
import math

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..audit import audit, check_edit_window
from ..db import get_db
from ..models import (Expense, ExpenseCategory, PurchaseOrder, PurchaseOrderLine,
                      PurchaseReceipt, PurchaseReceiptLine, User, Vendor, utcnow)
from ..periods import assert_month_open
from ..owner_controls import owner_policy
from ..security import current_user, require_owner
from ..util import paise, validate_business_date
from ..vendor_ledger import sync_credit_entry_for_expense
from .helpers import assert_outlet_access, user_outlet_ids
from .inventory import (_norm, _unit_key, build_inventory_intelligence,
                        ensure_purchase_movement)

router = APIRouter(prefix="/purchases", tags=["purchases"])

MODES = ("upi", "cash", "card", "bank", "credit", "other")


class OrderLineIn(BaseModel):
    item_name: str
    quantity: float
    unit: str
    unit_cost_rupees: float


class PurchaseOrderIn(BaseModel):
    outlet_id: int
    vendor_id: int
    category_id: int
    payment_mode: str = "credit"
    expected_date: str | None = None
    note: str = ""
    lines: list[OrderLineIn]


class IntelligenceDraftIn(BaseModel):
    outlet_id: int
    vendor_id: int
    category_id: int
    payment_mode: str = "credit"
    expected_date: str | None = None
    note: str = ""
    stock_item_ids: list[int]
    start: str | None = None
    end: str | None = None


class ReceiptLineIn(BaseModel):
    order_line_id: int
    received_quantity: float
    unit_price_rupees: float
    unit: str = ""


class ReceiptIn(BaseModel):
    business_date: str
    lines: list[ReceiptLineIn]
    finalize: bool = False
    idempotency_key: str | None = None


class ReceiptFinalizeIn(BaseModel):
    idempotency_key: str | None = None


def _vendor_and_category(db: Session, vendor_id: int, category_id: int) -> None:
    if db.get(Vendor, vendor_id) is None:
        raise HTTPException(422, "Supplier does not exist")
    if db.get(ExpenseCategory, category_id) is None:
        raise HTTPException(422, "Expense category does not exist")


def _validated_order_lines(lines: list[OrderLineIn]) -> list[dict]:
    if not lines:
        raise HTTPException(422, "An order needs at least one item")
    clean: list[dict] = []
    seen: dict[str, str] = {}
    for line in lines:
        name = line.item_name.strip()
        unit = line.unit.strip()
        if not name:
            raise HTTPException(422, "Every order line needs an item name")
        if not unit:
            raise HTTPException(422, f"{name} needs a unit")
        if (not math.isfinite(line.quantity) or line.quantity < 0
                or not math.isfinite(line.unit_cost_rupees) or line.unit_cost_rupees < 0):
            raise HTTPException(422, f"{name} quantity and unit cost cannot be negative")
        key, unit_key = _norm(name), _unit_key(unit)
        if key in seen:
            if seen[key] != unit_key:
                raise HTTPException(422, f"{name} has inconsistent units")
            raise HTTPException(422, f"{name} appears more than once")
        seen[key] = unit_key
        clean.append({"item_name": name[:120], "item_key": key[:120],
                      "quantity": line.quantity, "unit": unit_key,
                      "unit_cost_paise": paise(line.unit_cost_rupees)})
    return clean


def _order_lines(db: Session, order_id: int) -> list[PurchaseOrderLine]:
    return (db.query(PurchaseOrderLine)
              .filter_by(purchase_order_id=order_id)
              .order_by(PurchaseOrderLine.id).all())


def planned_order_total_paise(db: Session, order_id: int) -> int:
    return round(sum(line.ordered_quantity * line.planned_unit_cost_paise
                     for line in _order_lines(db, order_id)))


def _serialize_receipt(db: Session, receipt: PurchaseReceipt, order_lines: list[PurchaseOrderLine]) -> dict:
    by_id = {line.id: line for line in order_lines}
    receipt_lines = (db.query(PurchaseReceiptLine)
                       .filter_by(purchase_receipt_id=receipt.id)
                       .order_by(PurchaseReceiptLine.id).all())
    return {
        "id": receipt.id,
        "business_date": receipt.business_date,
        "status": receipt.status,
        "finalized_at": receipt.finalized_at.isoformat() if receipt.finalized_at else None,
        "lines": [{
            "id": line.id,
            "order_line_id": line.purchase_order_line_id,
            "item_name": by_id[line.purchase_order_line_id].item_name,
            "ordered_quantity": by_id[line.purchase_order_line_id].ordered_quantity,
            "received_quantity": line.received_quantity,
            "short_quantity": max(0, by_id[line.purchase_order_line_id].ordered_quantity - line.received_quantity),
            "unit": line.unit,
            "planned_unit_cost_paise": by_id[line.purchase_order_line_id].planned_unit_cost_paise,
            "unit_price_paise": line.unit_price_paise,
            "price_variance_paise": line.unit_price_paise - by_id[line.purchase_order_line_id].planned_unit_cost_paise,
            "expense_id": line.expense_id,
        } for line in receipt_lines],
    }


def _serialize_order(db: Session, order: PurchaseOrder) -> dict:
    lines = _order_lines(db, order.id)
    receipt = db.query(PurchaseReceipt).filter_by(purchase_order_id=order.id).first()
    vendor = db.get(Vendor, order.vendor_id)
    planned_total = planned_order_total_paise(db, order.id)
    approval_limit = owner_policy(db, order.outlet_id)["purchase_approval_limit_paise"]
    return {
        "id": order.id, "outlet_id": order.outlet_id, "vendor_id": order.vendor_id,
        "vendor_name": vendor.name if vendor else "Unknown supplier",
        "category_id": order.category_id, "payment_mode": order.payment_mode,
        "expected_date": order.expected_date, "note": order.note, "status": order.status,
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "approved_at": order.approved_at.isoformat() if order.approved_at else None,
        "planned_total_paise": round(planned_total),
        "approval_policy_warning": bool(approval_limit and planned_total > approval_limit),
        "lines": [{
            "id": line.id, "item_name": line.item_name, "quantity": line.ordered_quantity,
            "unit": line.unit, "unit_cost_paise": line.planned_unit_cost_paise,
        } for line in lines],
        "receipt": _serialize_receipt(db, receipt, lines) if receipt else None,
    }


def _get_order(db: Session, user: User, order_id: int) -> PurchaseOrder:
    order = db.get(PurchaseOrder, order_id)
    if order is None:
        raise HTTPException(404, "Purchase order not found")
    assert_outlet_access(db, user, order.outlet_id)
    return order


@router.get("/orders")
def list_orders(outlet_id: int | None = None, status: str | None = None,
                user: User = Depends(current_user), db: Session = Depends(get_db)):
    allowed = user_outlet_ids(db, user)
    query = db.query(PurchaseOrder).filter(PurchaseOrder.outlet_id.in_(allowed))
    if outlet_id is not None:
        assert_outlet_access(db, user, outlet_id)
        query = query.filter(PurchaseOrder.outlet_id == outlet_id)
    if status:
        if status not in ("draft", "approved", "cancelled", "received"):
            raise HTTPException(422, "Bad purchase order status")
        query = query.filter(PurchaseOrder.status == status)
    rows = query.order_by(PurchaseOrder.created_at.desc(), PurchaseOrder.id.desc()).limit(200).all()
    return [_serialize_order(db, row) for row in rows]


def _create_order(db: Session, user: User, body: PurchaseOrderIn) -> dict:
    if body.payment_mode not in MODES:
        raise HTTPException(422, "Bad payment mode")
    if body.expected_date:
        validate_business_date(body.expected_date, label="Expected date")
    _vendor_and_category(db, body.vendor_id, body.category_id)
    lines = _validated_order_lines(body.lines)
    order = PurchaseOrder(outlet_id=body.outlet_id, vendor_id=body.vendor_id,
                          category_id=body.category_id, payment_mode=body.payment_mode,
                          expected_date=body.expected_date, note=body.note.strip(),
                          status="draft", created_by=user.id)
    db.add(order)
    db.flush()
    for line in lines:
        db.add(PurchaseOrderLine(purchase_order_id=order.id,
                                 item_name=line["item_name"], item_key=line["item_key"],
                                 ordered_quantity=line["quantity"], unit=line["unit"],
                                 planned_unit_cost_paise=line["unit_cost_paise"]))
    audit(db, None, user.id, "create", "purchase_order", order.id,
          after={"vendor_id": body.vendor_id, "line_count": len(lines)})
    db.commit()
    return _serialize_order(db, order)


@router.post("/orders", status_code=201)
def create_order(body: PurchaseOrderIn, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    return _create_order(db, user, body)


@router.post("/orders/from-inventory-intelligence", status_code=201)
def create_intelligence_draft(body: IntelligenceDraftIn,
                              user: User = Depends(require_owner),
                              db: Session = Depends(get_db)):
    """Create only a draft from recommendations still supported by local facts."""
    assert_outlet_access(db, user, body.outlet_id)
    if not body.stock_item_ids or len(body.stock_item_ids) != len(set(body.stock_item_ids)):
        raise HTTPException(422, "Select one or more distinct reorder recommendations")
    intelligence = build_inventory_intelligence(
        db, body.outlet_id, body.start, body.end,
    )
    recommended = {
        row["stock_item_id"]: row for row in intelligence["items"]
        if row["reorder_eligible"] and row["reorder_recommendation_qty"]
    }
    selected = []
    for item_id in body.stock_item_ids:
        row = recommended.get(item_id)
        if row is None:
            raise HTTPException(
                422,
                "Every selected item must still have a supported reorder recommendation",
            )
        selected.append(OrderLineIn(
            item_name=row["item"], quantity=row["reorder_recommendation_qty"],
            unit=row["base_unit"],
            # A draft may carry the last recorded unit cost as an editable
            # planning reference. It is not a receipt price or a cost claim.
            unit_cost_rupees=row["last_purchase_unit_cost_rupees"] or 0,
        ))
    return _create_order(db, user, PurchaseOrderIn(
        outlet_id=body.outlet_id, vendor_id=body.vendor_id,
        category_id=body.category_id, payment_mode=body.payment_mode,
        expected_date=body.expected_date, note=body.note,
        lines=selected,
    ))


@router.put("/orders/{order_id}")
def update_order(order_id: int, body: PurchaseOrderIn, user: User = Depends(require_owner),
                 db: Session = Depends(get_db)):
    order = _get_order(db, user, order_id)
    if order.status != "draft":
        raise HTTPException(409, "Only draft purchase orders can be edited")
    if body.outlet_id != order.outlet_id:
        raise HTTPException(422, "A purchase order cannot be moved between outlets")
    if body.payment_mode not in MODES:
        raise HTTPException(422, "Bad payment mode")
    if body.expected_date:
        validate_business_date(body.expected_date, label="Expected date")
    _vendor_and_category(db, body.vendor_id, body.category_id)
    lines = _validated_order_lines(body.lines)
    before = {"vendor_id": order.vendor_id, "line_count": len(_order_lines(db, order.id))}
    order.vendor_id, order.category_id, order.payment_mode = body.vendor_id, body.category_id, body.payment_mode
    order.expected_date, order.note, order.updated_at = body.expected_date, body.note.strip(), utcnow()
    db.query(PurchaseOrderLine).filter_by(purchase_order_id=order.id).delete()
    for line in lines:
        db.add(PurchaseOrderLine(purchase_order_id=order.id,
                                 item_name=line["item_name"], item_key=line["item_key"],
                                 ordered_quantity=line["quantity"], unit=line["unit"],
                                 planned_unit_cost_paise=line["unit_cost_paise"]))
    audit(db, None, user.id, "update", "purchase_order", order.id, before=before,
          after={"vendor_id": body.vendor_id, "line_count": len(lines)})
    db.commit()
    return _serialize_order(db, order)


@router.post("/orders/{order_id}/approve")
def approve_order(order_id: int, user: User = Depends(require_owner),
                  db: Session = Depends(get_db)):
    order = _get_order(db, user, order_id)
    if order.status != "draft":
        raise HTTPException(409, "Only draft purchase orders can be approved")
    order.status, order.approved_by, order.approved_at = "approved", user.id, utcnow()
    audit(db, None, user.id, "approve", "purchase_order", order.id)
    db.commit()
    return _serialize_order(db, order)


@router.post("/orders/{order_id}/cancel")
def cancel_order(order_id: int, user: User = Depends(require_owner),
                 db: Session = Depends(get_db)):
    order = _get_order(db, user, order_id)
    if order.status not in ("draft", "approved"):
        raise HTTPException(409, "Finalized or cancelled purchase orders cannot be cancelled")
    order.status, order.cancelled_by, order.cancelled_at = "cancelled", user.id, utcnow()
    audit(db, None, user.id, "cancel", "purchase_order", order.id)
    db.commit()
    return _serialize_order(db, order)


def _replace_receipt_lines(db: Session, receipt: PurchaseReceipt,
                           order_lines: list[PurchaseOrderLine],
                           input_lines: list[ReceiptLineIn]) -> None:
    if len(input_lines) != len(order_lines):
        raise HTTPException(422, "Enter received quantities for every ordered item")
    expected = {line.id: line for line in order_lines}
    seen: set[int] = set()
    normalized = []
    for line in input_lines:
        ordered = expected.get(line.order_line_id)
        if ordered is None or line.order_line_id in seen:
            raise HTTPException(422, "Receipt lines must match the purchase order exactly once")
        seen.add(line.order_line_id)
        if (not math.isfinite(line.received_quantity) or line.received_quantity < 0
                or not math.isfinite(line.unit_price_rupees) or line.unit_price_rupees < 0):
            raise HTTPException(422, f"{ordered.item_name} quantity and price cannot be negative")
        unit = _unit_key(line.unit.strip() or ordered.unit)
        if unit != _unit_key(ordered.unit):
            raise HTTPException(422, f"{ordered.item_name} must be received in {ordered.unit}")
        normalized.append((ordered, line.received_quantity, unit, paise(line.unit_price_rupees)))
    db.query(PurchaseReceiptLine).filter_by(purchase_receipt_id=receipt.id).delete()
    for ordered, qty, unit, price in normalized:
        db.add(PurchaseReceiptLine(purchase_receipt_id=receipt.id,
                                   purchase_order_line_id=ordered.id,
                                   received_quantity=qty, unit=unit,
                                   unit_price_paise=price))


def _matches_finalized_receipt(db: Session, receipt: PurchaseReceipt,
                               body: ReceiptIn) -> bool:
    if receipt.business_date != body.business_date:
        return False
    existing = {
        line.purchase_order_line_id: line for line in
        db.query(PurchaseReceiptLine).filter_by(purchase_receipt_id=receipt.id).all()
    }
    if len(existing) != len(body.lines):
        return False
    for line in body.lines:
        saved = existing.get(line.order_line_id)
        if saved is None:
            return False
        try:
            same_price = saved.unit_price_paise == paise(line.unit_price_rupees)
            same_qty = math.isclose(saved.received_quantity, line.received_quantity)
        except (TypeError, ValueError):
            return False
        if not same_price or not same_qty or (
            line.unit and _unit_key(line.unit) != _unit_key(saved.unit)
        ):
            return False
    return True


def _finalize_receipt(db: Session, user: User, order: PurchaseOrder,
                      receipt: PurchaseReceipt, idempotency_key: str | None) -> dict:
    if receipt.status == "finalized":
        return _serialize_order(db, order)
    validate_business_date(receipt.business_date, no_future=True)
    # Period safety is checked before the edit window so a closed month always
    # reports the stronger, immutable-books reason (423).
    assert_month_open(db, order.outlet_id, receipt.business_date)
    check_edit_window(receipt.business_date, user, db)
    _vendor_and_category(db, order.vendor_id, order.category_id)
    if idempotency_key and receipt.idempotency_key and receipt.idempotency_key != idempotency_key[:64]:
        raise HTTPException(409, "This receipt already has a different finalization key")
    receipt.idempotency_key = (idempotency_key or f"receipt-{receipt.id}")[:64]
    lines = _order_lines(db, order.id)
    receipt_lines = (db.query(PurchaseReceiptLine)
                       .filter_by(purchase_receipt_id=receipt.id)
                       .order_by(PurchaseReceiptLine.id).all())
    if len(receipt_lines) != len(lines):
        raise HTTPException(422, "Enter received quantities for every ordered item before finalizing")
    for line in receipt_lines:
        ordered = next(item for item in lines if item.id == line.purchase_order_line_id)
        if line.expense_id is not None:
            continue
        if line.received_quantity == 0:
            continue
        amount_paise = int(round(line.received_quantity * line.unit_price_paise))
        expense = Expense(
            outlet_id=order.outlet_id, business_date=receipt.business_date,
            category_id=order.category_id, vendor_id=order.vendor_id,
            amount_paise=amount_paise, mode=order.payment_mode,
            description=f"PO #{order.id} receipt · {ordered.item_name}",
            item_name=ordered.item_name, quantity=line.received_quantity,
            unit=line.unit, entered_by=user.id,
            idempotency_key=f"receipt:{receipt.id}:line:{ordered.id}"[:64],
        )
        db.add(expense)
        db.flush()
        line.expense_id = expense.id
        ensure_purchase_movement(db, order.outlet_id, receipt.business_date,
                                 ordered.item_name, line.received_quantity, line.unit,
                                 amount_paise, user.id, expense.id)
        sync_credit_entry_for_expense(db, expense, user.id)
    receipt.status, receipt.finalized_by, receipt.finalized_at = "finalized", user.id, utcnow()
    order.status = "received"
    audit(db, None, user.id, "finalize", "purchase_receipt", receipt.id,
          after={"purchase_order_id": order.id, "business_date": receipt.business_date})
    db.commit()
    return _serialize_order(db, order)


@router.post("/orders/{order_id}/receive")
def receive_order(order_id: int, body: ReceiptIn, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    order = _get_order(db, user, order_id)
    receipt = db.query(PurchaseReceipt).filter_by(purchase_order_id=order.id).first()
    # A retried mobile request arrives after the order moved to "received".
    # It must report the committed fact, never re-enter the posting path.
    if receipt and receipt.status == "finalized":
        if _matches_finalized_receipt(db, receipt, body):
            return _serialize_order(db, order)
        raise HTTPException(
            409,
            "A finalized receipt cannot be edited. Record any correction separately.",
        )
    if order.status != "approved":
        raise HTTPException(409, "An owner must approve this purchase order before receiving")
    validate_business_date(body.business_date, no_future=True)
    lines = _order_lines(db, order.id)
    if receipt is None:
        receipt = PurchaseReceipt(purchase_order_id=order.id, business_date=body.business_date,
                                  status="draft", created_by=user.id)
        db.add(receipt)
        db.flush()
    else:
        receipt.business_date = body.business_date
    _replace_receipt_lines(db, receipt, lines, body.lines)
    if body.finalize:
        db.flush()
        return _finalize_receipt(db, user, order, receipt, body.idempotency_key)
    audit(db, None, user.id, "save", "purchase_receipt", receipt.id,
          after={"purchase_order_id": order.id})
    db.commit()
    return _serialize_order(db, order)


@router.get("/orders/{order_id}/receipt")
def get_receipt(order_id: int, user: User = Depends(current_user),
                db: Session = Depends(get_db)):
    order = _get_order(db, user, order_id)
    receipt = db.query(PurchaseReceipt).filter_by(purchase_order_id=order.id).first()
    if receipt is None:
        raise HTTPException(404, "Receipt not found")
    return _serialize_receipt(db, receipt, _order_lines(db, order.id))


@router.post("/orders/{order_id}/receipts/{receipt_id}/finalize")
def finalize_receipt(order_id: int, receipt_id: int, body: ReceiptFinalizeIn,
                     user: User = Depends(current_user), db: Session = Depends(get_db)):
    order = _get_order(db, user, order_id)
    receipt = db.get(PurchaseReceipt, receipt_id)
    if receipt is None or receipt.purchase_order_id != order.id:
        raise HTTPException(404, "Receipt not found")
    if order.status not in ("approved", "received"):
        raise HTTPException(409, "An owner must approve this purchase order before receiving")
    return _finalize_receipt(db, user, order, receipt, body.idempotency_key)


@router.get("/orders/{order_id}")
def get_order(order_id: int, user: User = Depends(current_user),
              db: Session = Depends(get_db)):
    return _serialize_order(db, _get_order(db, user, order_id))
