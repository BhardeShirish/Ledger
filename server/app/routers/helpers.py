"""Shared router helpers."""
from sqlalchemy.orm import Session

from ..models import UserOutlet, User


def user_outlet_ids(db: Session, user: User) -> list[int]:
    """Owner sees every active outlet; managers only their scoped ones."""
    from ..models import Outlet
    if user.role == "owner":
        return [r.id for r in db.query(Outlet).filter_by(is_active=True).all()]
    rows = (db.query(UserOutlet.outlet_id)
              .filter(UserOutlet.user_id == user.id).all())
    return [r[0] for r in rows]


def assert_outlet_access(db: Session, user: User, outlet_id: int) -> None:
    if outlet_id not in user_outlet_ids(db, user):
        from fastapi import HTTPException
        raise HTTPException(403, "No access to this outlet")


def mask_salary(role: str, data: dict) -> dict:
    if role == "owner":
        return data
    for k in ("monthly_salary_paise", "divisor", "monthly_salary_rupees",
              "per_day_rupees"):
        data.pop(k, None)
    return data
