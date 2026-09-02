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
    """Optional sample content, so a stranger evaluating Ledger sees it doing
    its job instead of an empty shell.

    Two rules here. It is deterministic - the same seed every time, so a bug
    report against the demo is reproducible. And the day closures are computed
    with the application's own expected_breakdown() rather than a formula
    copied into this file, because a demo whose cash arithmetic disagrees with
    the real thing teaches the wrong number.
    """
    if db.query(Employee).count() > 0:
        return
    outlet = db.query(Outlet).first()
    if not outlet:
        return

    import random
    from datetime import date, timedelta

    from .models import (Advance, Attendance, DayClosure, DayLoss, Expense,
                         SalesDaily, Vendor)
    from .routers.dayclose import expected_breakdown

    rng = random.Random(20260101)      # fixed: the demo is the same every time
    shifts = db.query(Shift).all()
    owner = db.query(User).first()

    staff = []
    for name, desig, salary in [
        ("Ramesh", "Chef", 22000), ("Sunita", "Cashier", 14000),
        ("Anil", "Kitchen Helper", 12000), ("Priya", "Steward", 10000),
        ("Kiran", "Waiter", 11000), ("Mohan", "Cleaner", 9000),
    ]:
        e = Employee(name=name, designation=desig, outlet_id=outlet.id,
                     monthly_salary_paise=salary * 100, divisor=26,
                     default_shift_id=shifts[len(staff) % len(shifts)].id
                     if shifts else None,
                     join_date="2025-01-01")
        db.add(e)
        staff.append(e)

    vendors = {}
    for name in ("Anand Vegetables", "Sri Lakshmi Dairy", "Bharat Gas",
                 "Metro Cash & Carry"):
        v = Vendor(name=name)
        db.add(v)
        vendors[name] = v
    db.flush()

    cats = {c.name: c.id for c in db.query(ExpenseCategory).all()}

    def cat(name):
        return cats.get(name) or next(iter(cats.values()))

    # Runs through today, but today is deliberately left unclosed: the home
    # screen should show a day in progress with the drawer still to count,
    # which is what the routine actually looks like at 6pm.
    today = date.today()
    start = today - timedelta(days=60)

    for i in range((today - start).days + 1):
        d = start + timedelta(days=i)
        day = d.isoformat()
        is_today = d == today
        weekend = d.weekday() >= 4          # Fri/Sat/Sun are busier

        # ── takings ────────────────────────────────────────────────────
        base = rng.randint(16000, 24000) * (140 if weekend else 100) // 100
        split = {"cash": 40, "upi": 45, "card": 15}
        for kind, pct in split.items():
            amount = base * pct // 100 + rng.randint(-400, 400)
            db.add(SalesDaily(outlet_id=outlet.id, business_date=day,
                              channel_kind=kind, source="manual",
                              amount_paise=max(amount, 0) * 100,
                              bills=rng.randint(20, 60)))

        # ── money out ──────────────────────────────────────────────────
        db.add(Expense(outlet_id=outlet.id, business_date=day,
                       category_id=cat("Vegetables & Fruits"),
                       vendor_id=vendors["Anand Vegetables"].id,
                       amount_paise=rng.randint(1800, 3400) * 100, mode="cash",
                       description="Daily vegetables", item_name="Vegetables",
                       quantity=float(rng.randint(15, 30)), unit="kg",
                       entered_by=owner.id if owner else None))
        if d.weekday() in (0, 3):
            db.add(Expense(outlet_id=outlet.id, business_date=day,
                           category_id=cat("Dairy"),
                           vendor_id=vendors["Sri Lakshmi Dairy"].id,
                           amount_paise=rng.randint(900, 1500) * 100, mode="upi",
                           description="Milk and curd",
                           entered_by=owner.id if owner else None))
        if i % 9 == 0:
            db.add(Expense(outlet_id=outlet.id, business_date=day,
                           category_id=cat("Gas Cylinder"),
                           vendor_id=vendors["Bharat Gas"].id,
                           amount_paise=191000, mode="cash",
                           description="Commercial cylinder refill",
                           entered_by=owner.id if owner else None))
        if i % 14 == 6:
            db.add(Expense(outlet_id=outlet.id, business_date=day,
                           category_id=cat("Repairs & Maintenance"),
                           amount_paise=rng.randint(500, 4000) * 100, mode="upi",
                           description="Chimney servicing",
                           entered_by=owner.id if owner else None))

        # ── who worked ─────────────────────────────────────────────────
        for n, emp in enumerate(staff):
            if d.weekday() == (n % 7):
                status = "WO"
            else:
                roll = rng.random()
                status = "P" if roll > 0.06 else ("A" if roll > 0.03 else "L")
            shift = (db.get(Shift, emp.default_shift_id)
                     if emp.default_shift_id else None)
            late = rng.choice([0, 0, 0, 0, 5, 12, 20]) if status == "P" else 0
            db.add(Attendance(
                employee_id=emp.id, business_date=day, status=status,
                shift_id=emp.default_shift_id,
                in_min=(shift.start_min + late) if (shift and status == "P") else None,
                out_min=shift.end_min if (shift and status == "P") else None,
                late_min=late, source="bulk", marked_by=owner.id if owner else None))

        # ── the awkward days ───────────────────────────────────────────
        if i % 23 == 5:
            db.add(Advance(employee_id=staff[i % len(staff)].id, date=day,
                           amount_paise=rng.choice([200000, 300000, 500000]),
                           remaining_paise=rng.choice([200000, 300000, 500000]),
                           note="Family expense",
                           created_by=owner.id if owner else None))
        if i % 17 == 3:
            db.add(DayLoss(outlet_id=outlet.id, business_date=day, kind="refund",
                           amount_paise=rng.randint(150, 600) * 100,
                           from_drawer=True, note="Order returned by customer",
                           entered_by=owner.id if owner else None))
        if i % 19 == 11:
            db.add(DayLoss(outlet_id=outlet.id, business_date=day, kind="spoilage",
                           amount_paise=rng.randint(200, 900) * 100,
                           from_drawer=False, note="Curd turned in the heat",
                           entered_by=owner.id if owner else None))

        # ── closing the day ────────────────────────────────────────────
        db.flush()
        if is_today:
            continue                      # drawer not counted yet
        expected = expected_breakdown(db, outlet.id, day)["expected_paise"]
        # Most nights the drawer balances. A handful do not - that is the
        # whole point of counting it, and Insights has nothing to find in a
        # demo where every single night is perfect.
        if i % 13 == 4:
            counted = expected - rng.randint(200, 900) * 100
        elif i % 29 == 7:
            counted = expected + rng.randint(50, 200) * 100
        else:
            counted = expected
        keep = 500000                     # float left in the till overnight
        db.add(DayClosure(
            outlet_id=outlet.id, business_date=day,
            expected_cash_paise=expected, counted_cash_paise=counted,
            variance_paise=counted - expected,
            moved_to_bank_paise=max(counted - keep, 0),
            closed_by=owner.id if owner else None))
        db.flush()

    db.commit()
