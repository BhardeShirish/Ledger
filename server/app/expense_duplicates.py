"""Exact-match duplicate evidence shared by manual and statement expense entry."""
from __future__ import annotations

from collections import defaultdict

from sqlalchemy.orm import Session

from .models import Expense


def _row(expense: Expense) -> dict:
    return {
        "id": expense.id,
        "business_date": expense.business_date,
        "amount_paise": expense.amount_paise,
        "description": expense.description or expense.item_name or "No note",
        "vendor_id": expense.vendor_id,
        "category_id": expense.category_id,
    }


def candidates(db: Session, outlet_id: int, business_date: str,
               amount_paise: int) -> list[dict]:
    """Existing records with exactly the same date and amount."""
    rows = (db.query(Expense)
              .filter(Expense.outlet_id == outlet_id,
                      Expense.business_date == business_date,
                      Expense.amount_paise == amount_paise)
              .order_by(Expense.id.desc()).limit(5).all())
    return [_row(row) for row in rows]


def candidate_map(db: Session, outlet_id: int, transactions: list[dict]) -> dict[tuple[str, int], list[dict]]:
    """Batch version of candidates(), for a statement preview."""
    keys = {(row["date"], row["amount_paise"]) for row in transactions}
    if not keys:
        return {}
    dates = {key[0] for key in keys}
    rows = (db.query(Expense)
              .filter(Expense.outlet_id == outlet_id,
                      Expense.business_date.in_(dates)).all())
    grouped: dict[tuple[str, int], list[dict]] = defaultdict(list)
    for row in rows:
        key = (row.business_date, row.amount_paise)
        if key in keys and len(grouped[key]) < 5:
            grouped[key].append(_row(row))
    return grouped
