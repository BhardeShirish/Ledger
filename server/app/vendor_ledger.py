"""Keep vendor credit liabilities aligned with their source expenses."""
from sqlalchemy.orm import Session

from .models import Expense, VendorEntry


def sync_credit_entry_for_expense(db: Session, expense: Expense, user_id: int) -> None:
    entries = db.query(VendorEntry).filter_by(expense_id=expense.id).all()
    should_exist = expense.mode == "credit" and expense.vendor_id is not None
    if not should_exist:
        for entry in entries:
            db.delete(entry)
        return

    entry = entries[0] if entries else None
    if entry is None:
        entry = VendorEntry(
            vendor_id=expense.vendor_id,
            outlet_id=expense.outlet_id,
            date=expense.business_date,
            type="purchase_credit",
            amount_paise=expense.amount_paise,
            expense_id=expense.id,
            receipt_path=expense.receipt_path,
            note=expense.description,
            entered_by=user_id,
        )
        db.add(entry)
    else:
        entry.vendor_id = expense.vendor_id
        entry.outlet_id = expense.outlet_id
        entry.date = expense.business_date
        entry.amount_paise = expense.amount_paise
        entry.receipt_path = expense.receipt_path
        entry.note = expense.description
    for duplicate in entries[1:]:
        db.delete(duplicate)
