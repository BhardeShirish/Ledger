"""Master lists: expense categories and money display config."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..costgroups import GROUPS, guess_group
from ..models import ExpenseCategory, User
from ..security import current_user, require_owner

router = APIRouter(prefix="/lists", tags=["lists"])


class CategoryIn(BaseModel):
    name: str
    cost_group: str | None = None


class CategoryGroupIn(BaseModel):
    cost_group: str


DEFAULT_CATEGORIES = [
    "Raw Material", "Vegetables & Fruits", "Dairy", "Meat & Fish",
    "Groceries", "Gas Cylinder", "Electricity", "Water",
    "Rent", "Internet & Phone", "Repairs & Maintenance",
    "Packaging", "Fuel & Transport", "Marketing", "Staff Welfare",
    "Licenses & Fees", "Cleaning", "Misc",
]


@router.get("/cost-groups")
def cost_groups(user: User = Depends(current_user)):
    """The P&L lines a category can belong to, for the Settings picker."""
    return [{"key": k, "label": label, "hint": hint}
            for k, (label, hint) in GROUPS.items()]


@router.get("/categories")
def categories(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = (db.query(ExpenseCategory)
              .order_by(ExpenseCategory.sort, ExpenseCategory.name).all())
    return [{"id": c.id, "name": c.name, "is_active": c.is_active,
             "cost_group": c.cost_group or "operating",
             "cost_group_label": GROUPS.get(c.cost_group or "operating",
                                            ("Running costs", ""))[0]}
            for c in rows]


@router.patch("/categories/{category_id}/group")
def set_category_group(category_id: int, body: CategoryGroupIn,
                       user: User = Depends(current_user),
                       db: Session = Depends(get_db)):
    if body.cost_group not in GROUPS:
        raise HTTPException(422, "That is not a P&L group.")
    c = db.get(ExpenseCategory, category_id)
    if c is None:
        raise HTTPException(404, "Not found")
    c.cost_group = body.cost_group
    db.commit()
    return {"id": c.id, "name": c.name, "cost_group": c.cost_group,
            "cost_group_label": GROUPS[c.cost_group][0]}


@router.post("/categories", status_code=201)
def add_category(body: CategoryIn, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise HTTPException(422, "Give the category a name.")
    if len(name) > 60:
        raise HTTPException(422, "That name is too long.")
    if body.cost_group is not None and body.cost_group not in GROUPS:
        raise HTTPException(422, "That is not a P&L group.")
    group = body.cost_group or guess_group(name)
    existing = db.query(ExpenseCategory).filter(func.lower(ExpenseCategory.name) == name.lower()).first()
    if existing:
        # Adding back a category that was switched off must switch it on
        # again, or the picker keeps hiding it and the button looks dead.
        if not existing.is_active:
            existing.is_active = True
            db.commit()
        return {"id": existing.id, "name": existing.name, "is_active": True,
                "cost_group": existing.cost_group or "operating"}
    sort = (db.query(func.max(ExpenseCategory.sort)).scalar() or 0) + 10
    c = ExpenseCategory(name=name, sort=sort, cost_group=group)
    db.add(c)
    db.commit()
    return {"id": c.id, "name": c.name, "is_active": True,
            "cost_group": c.cost_group}


@router.delete("/categories/{category_id}")
def deactivate_category(category_id: int, user: User = Depends(require_owner),
                        db: Session = Depends(get_db)):
    c = db.get(ExpenseCategory, category_id)
    if c is None:
        raise HTTPException(404, "Not found")
    c.is_active = False
    db.commit()
    return {"ok": True}


@router.get("/money-config")
def money_config(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Currency display + denomination list for the note calculator. Any role."""
    from ..audit import get_setting_db

    def denoms():
        v = get_setting_db(db, "denominations", None)
        return v if isinstance(v, list) and v else [500, 200, 100, 50, 20, 10, 5, 2, 1]

    return {
        "code": get_setting_db(db, "currency_code", "INR"),
        "symbol": get_setting_db(db, "currency_symbol", "₹"),
        "locale": get_setting_db(db, "currency_locale", "en-IN"),
        "denominations": sorted({int(d) for d in denoms()}, reverse=True),
        "timezone": get_setting_db(db, "timezone_name", "Asia/Kolkata"),
        "restaurant_name": get_setting_db(db, "restaurant_name", "My restaurant"),
    }
