"""Shared immutable-period guard for dated financial facts."""
from datetime import date

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .models import MonthLock


def month_parts(business_date: str) -> tuple[int, int]:
    try:
        parsed = date.fromisoformat(business_date)
    except ValueError:
        raise HTTPException(422, "Business date must be a valid ISO date") from None
    return parsed.year, parsed.month


def assert_month_open(db: Session, outlet_id: int, business_date: str) -> None:
    year, month = month_parts(business_date)
    if (db.query(MonthLock.id)
          .filter_by(outlet_id=outlet_id, year=year, month=month)
          .first()):
        raise HTTPException(
            423,
            f"{year:04d}-{month:02d} is closed. Reopen the month before changing its books.",
        )


def assert_dates_open(db: Session, outlet_id: int, business_dates: set[str]) -> None:
    for business_date in sorted(business_dates):
        assert_month_open(db, outlet_id, business_date)
