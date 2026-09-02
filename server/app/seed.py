"""First-run bootstrap: owner account, default outlet, master lists."""
from sqlalchemy.orm import Session

from .config import ensure_dirs, read_env_or_file
from .models import (Employee, ExpenseCategory, Outlet, SalesChannel,
                     Shift, User)
from .security import hash_password

DEFAULT_CATEGORIES = [
    "Raw Material", "Vegetables & Fruits", "Dairy", "Meat & Fish",
    "Groceries", "Gas Cylinder", "Electricity", "Water", "Rent",
    "Internet & Phone", "Repairs & Maintenance", "Packaging",
    "Fuel & Transport", "Marketing", "Staff Welfare", "Licenses & Fees",
    "Cleaning", "Misc",
]

DEFAULT_CHANNELS = [
    ("Cash", "cash", 10), ("UPI", "upi", 20), ("Card", "card", 30),
    ("Zomato", "aggregator", 40), ("Swiggy", "aggregator", 50),
]


def bootstrap(db: Session) -> dict:
    ensure_dirs()
    created = {"user": False, "outlet": False}
    if db.query(User).count() == 0:
        import os
        username = os.environ.get("LEDGER_OWNER_USER", "owner")
        password = read_env_or_file("LEDGER_OWNER_PASSWORD")
        testing = os.environ.get("LEDGER_TESTING") == "1"
        if len(password) < 12 or (password == "change-me-please" and not testing):
            raise RuntimeError(
                "First run requires LEDGER_OWNER_PASSWORD with at least "
                "12 characters and no default password."
            )
        u = User(username=username.lower(), full_name="Owner", role="owner",
                 password_hash=hash_password(password))
        db.add(u)
        created["user"] = True
        created["owner_username"] = username
    if db.query(Outlet).count() == 0:
        o = Outlet(name="Main Outlet")
        db.add(o)
        created["outlet"] = True
    if db.query(ExpenseCategory).count() == 0:
        for i, name in enumerate(DEFAULT_CATEGORIES):
            db.add(ExpenseCategory(name=name, sort=(i + 1) * 10))
    if db.query(SalesChannel).count() == 0:
        for name, kind, sort in DEFAULT_CHANNELS:
            db.add(SalesChannel(name=name, kind=kind, sort=sort))
    if db.query(Shift).count() == 0:
        db.add(Shift(name="Shift 1 · 7–4", start_min=420, end_min=960))     # 7:00–16:00
        db.add(Shift(name="Shift 2 · 3–11", start_min=900, end_min=1380))   # 15:00–23:00
    else:
        # upgrade legacy seeds to the owner's real shift times (idempotent)
        legacy = {"general 10–19": (600, 1140)}
        renames = {
            "morning 8–16": ("Shift 1 · 7–4", 420, 960),
            "evening 16–00": ("Shift 2 · 3–11", 900, 1380),
        }
        for s in db.query(Shift).all():
            key = s.name.strip().lower()
            if key in renames and not any(
                x.id != s.id and x.name == renames[key][0] for x in db.query(Shift).all()):
                s.name, s.start_min, s.end_min = renames[key]
                s.crosses_midnight = False
        for name, st, en in (("Shift 1 · 7–4", 420, 960),
                             ("Shift 2 · 3–11", 900, 1380)):
            if not any(s.name == name for s in db.query(Shift).all()):
                db.add(Shift(name=name, start_min=st, end_min=en))
    db.commit()
    return created


def demo_seed(db: Session) -> None:
    """Optional: sample outlet content so the UI is never empty on first run."""
    if db.query(Employee).count() > 0:
        return
    outlet = db.query(Outlet).first()
    if not outlet:
        return
    shift = db.query(Shift).first()
    for name, desig, salary in [
        ("Ramesh", "Chef", 22000), ("Sunita", "Cashier", 14000),
        ("Anil", "Kitchen Helper", 12000), ("Priya", "Steward", 10000),
    ]:
        db.add(Employee(name=name, designation=desig, outlet_id=outlet.id,
                        monthly_salary_paise=salary * 100, divisor=26,
                        default_shift_id=shift.id if shift else None,
                        join_date="2025-01-01"))
    db.commit()
