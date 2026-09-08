from datetime import datetime, timezone

from sqlalchemy import (
    JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text,
    UniqueConstraint, Index,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Timestamped:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ── Access ────────────────────────────────────────────────────────────────

class User(Base, Timestamped):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    full_name: Mapped[str] = mapped_column(String(120), default="")
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16))  # owner | manager
    is_active: Mapped[bool] = mapped_column(default=True)
    failed_attempts: Mapped[int] = mapped_column(default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    outlets = relationship("UserOutlet", cascade="all, delete-orphan")


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    csrf_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    elevated_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class UserOutlet(Base):
    __tablename__ = "user_outlets"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"), primary_key=True)


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(64))
    entity: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[str] = mapped_column(String(64), default="")
    before: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    ip: Mapped[str] = mapped_column(String(64), default="")


# ── Org & staff ───────────────────────────────────────────────────────────

class Outlet(Base, Timestamped):
    __tablename__ = "outlets"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    address: Mapped[str] = mapped_column(Text, default="")
    phone: Mapped[str] = mapped_column(String(32), default="")
    opening_float_paise: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(default=True)


class Shift(Base):
    __tablename__ = "shifts"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    start_min: Mapped[int] = mapped_column(Integer)   # minutes since midnight
    end_min: Mapped[int] = mapped_column(Integer)
    crosses_midnight: Mapped[bool] = mapped_column(default=False)
    grace_min: Mapped[int] = mapped_column(Integer, default=15)
    ot_grace_min: Mapped[int] = mapped_column(Integer, default=30)
    outlet_id: Mapped[int | None] = mapped_column(ForeignKey("outlets.id"), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True)


class Employee(Base):
    __tablename__ = "employees"
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), default="")
    name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str] = mapped_column(String(20), default="")
    designation: Mapped[str] = mapped_column(String(80), default="")
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    default_shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"), nullable=True)
    monthly_salary_paise: Mapped[int] = mapped_column(Integer, default=0)
    divisor: Mapped[int] = mapped_column(Integer, default=26)
    join_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    exit_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    working_status: Mapped[str] = mapped_column(String(12), default="active")  # active|notice|left
    pref_off_dow: Mapped[int | None] = mapped_column(Integer, nullable=True)   # 0=Mon..6=Sun
    off_dow: Mapped[int | None] = mapped_column(Integer, nullable=True)
    backup_employee_id: Mapped[int | None] = mapped_column(
        ForeignKey("employees.id", use_alter=True), nullable=True)
    upi_id: Mapped[str] = mapped_column(String(120), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(default=True)
    # KYC documents — owner-only access
    aadhaar_no: Mapped[str] = mapped_column(String(24), default="")
    pan_no: Mapped[str] = mapped_column(String(16), default="")
    aadhaar_doc_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    pan_doc_path: Mapped[str | None] = mapped_column(String(255), nullable=True)


def migrate(db_engine) -> None:
    """Run idempotent, versioned SQLite schema upgrades."""
    from sqlalchemy import inspect, text

    migrations = [
        (1, "employees", {
            "aadhaar_no": "ALTER TABLE employees ADD COLUMN aadhaar_no VARCHAR(24) DEFAULT ''",
            "pan_no": "ALTER TABLE employees ADD COLUMN pan_no VARCHAR(16) DEFAULT ''",
            "aadhaar_doc_path": "ALTER TABLE employees ADD COLUMN aadhaar_doc_path VARCHAR(255)",
            "pan_doc_path": "ALTER TABLE employees ADD COLUMN pan_doc_path VARCHAR(255)",
        }),
        (2, "day_closures", {
            "counted_breakdown": "ALTER TABLE day_closures ADD COLUMN counted_breakdown JSON",
        }),
        (3, "expenses", {
            "item_name": "ALTER TABLE expenses ADD COLUMN item_name VARCHAR(120) DEFAULT ''",
            "quantity": "ALTER TABLE expenses ADD COLUMN quantity FLOAT",
            "unit": "ALTER TABLE expenses ADD COLUMN unit VARCHAR(16) DEFAULT ''",
        }),
        (4, "users", {
            "failed_attempts": (
                "ALTER TABLE users ADD COLUMN failed_attempts INTEGER "
                "NOT NULL DEFAULT 0"
            ),
            "locked_until": "ALTER TABLE users ADD COLUMN locked_until DATETIME",
            "last_login_at": "ALTER TABLE users ADD COLUMN last_login_at DATETIME",
        }),
        (5, "import_batches", {
            "content_hash": (
                "ALTER TABLE import_batches ADD COLUMN content_hash "
                "VARCHAR(64)"
            ),
        }),
        (6, "expenses", {
            "idempotency_key": (
                "ALTER TABLE expenses ADD COLUMN idempotency_key VARCHAR(64)"
            ),
        }),
        (7, "expense_categories", {
            "cost_group": (
                "ALTER TABLE expense_categories ADD COLUMN cost_group "
                "VARCHAR(16) NOT NULL DEFAULT 'operating'"
            ),
        }),
        (8, "recurring_costs", {
            "last_owner_review_at": (
            "ALTER TABLE recurring_costs ADD COLUMN last_owner_review_at DATETIME"
            ),
            "review_cadence_days": (
            "ALTER TABLE recurring_costs ADD COLUMN review_cadence_days INTEGER NOT NULL DEFAULT 90"
            ),
        }),
    ]
    with db_engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL)"
        ))
        applied = {
            row[0] for row in conn.execute(
                text("SELECT version FROM schema_migrations")
            )
        }
        for version, table, columns in migrations:
            if version in applied:
                continue
            if not inspect(conn).has_table(table):
                conn.execute(
                    text(
                        "INSERT INTO schema_migrations(version, applied_at) "
                        "VALUES (:version, CURRENT_TIMESTAMP)"
                    ),
                    {"version": version},
                )
                continue
            existing = {c["name"] for c in inspect(conn).get_columns(table)}
            for column, statement in columns.items():
                if column not in existing:
                    conn.execute(text(statement))
            conn.execute(
                text(
                    "INSERT INTO schema_migrations(version, applied_at) "
                    "VALUES (:version, CURRENT_TIMESTAMP)"
                ),
                {"version": version},
            )

        # A hard guarantee that one bank statement line can never be booked
        # twice, even if two commits race past the read-then-insert check in
        # the importer. SQLite treats NULLs as distinct, so hand-entered
        # expenses (which carry no key) are unaffected. IF NOT EXISTS makes
        # this safe to run on every start.
        if inspect(conn).has_table("expenses"):
            try:
                conn.execute(text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_expenses_idempotency "
                    "ON expenses(outlet_id, idempotency_key)"
                ))
            except Exception as exc:  # pragma: no cover - pre-existing dupes
                print("[ledger] duplicate-expense guard not added:", exc)

        # Give existing books their P&L groups. Without this every category
        # lands on the 'operating' default, food cost reads as zero and the
        # whole P&L is wrong on an upgrade — so this runs once, only over
        # rows nobody has classified yet.
        if inspect(conn).has_table("expense_categories"):
            cols = {c["name"] for c in inspect(conn).get_columns("expense_categories")}
            if "cost_group" in cols:
                from .costgroups import guess_group

                rows = conn.execute(text(
                    "SELECT id, name FROM expense_categories "
                    "WHERE cost_group IS NULL OR cost_group = '' "
                    "OR cost_group = 'operating'"
                )).fetchall()
                for row_id, name in rows:
                    guess = guess_group(name or "")
                    if guess != "operating":
                        conn.execute(
                            text("UPDATE expense_categories SET cost_group = :g "
                                 "WHERE id = :i"),
                            {"g": guess, "i": row_id})


class ShiftPattern(Base):
    __tablename__ = "employee_shift_pattern"
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), primary_key=True)
    dow: Mapped[int] = mapped_column(Integer, primary_key=True)  # 0..6 Mon..Sun
    shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"), nullable=True)


class ShiftOverride(Base):
    __tablename__ = "shift_overrides"
    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    date: Mapped[str] = mapped_column(String(10))  # ISO business date
    shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"), nullable=True)
    __table_args__ = (UniqueConstraint("employee_id", "date"),)


class Attendance(Base):
    __tablename__ = "attendance"
    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    business_date: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(4), default="P")  # P H A L WO
    shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"), nullable=True)
    in_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    out_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    late_min: Mapped[int] = mapped_column(Integer, default=0)
    ot_min: Mapped[int] = mapped_column(Integer, default=0)
    double_duty: Mapped[bool] = mapped_column(default=False)
    is_open: Mapped[bool] = mapped_column(default=False)
    source: Mapped[str] = mapped_column(String(12), default="manual")  # manual|scheduled|bulk
    note: Mapped[str] = mapped_column(Text, default="")
    marked_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    marked_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    __table_args__ = (
        UniqueConstraint("employee_id", "business_date"),
        Index("ix_attendance_date", "business_date"),
    )


# ── Advances ──────────────────────────────────────────────────────────────

class Advance(Base):
    __tablename__ = "advances"
    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    date: Mapped[str] = mapped_column(String(10))
    amount_paise: Mapped[int] = mapped_column(Integer)
    remaining_paise: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(8), default="open")  # open|cleared
    note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class AdvanceRepayment(Base):
    __tablename__ = "advance_repayments"
    id: Mapped[int] = mapped_column(primary_key=True)
    advance_id: Mapped[int] = mapped_column(ForeignKey("advances.id"))
    date: Mapped[str] = mapped_column(String(10))
    amount_paise: Mapped[int] = mapped_column(Integer)
    via: Mapped[str] = mapped_column(String(8))  # payroll|cash
    payslip_id: Mapped[int | None] = mapped_column(ForeignKey("payslips.id"), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")


# ── Money out ─────────────────────────────────────────────────────────────

class ExpenseCategory(Base):
    __tablename__ = "expense_categories"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)
    is_active: Mapped[bool] = mapped_column(default=True)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    # Which line of the P&L this category belongs to. A flat list of
    # categories can tell you what you spent; only a grouped one can tell
    # you whether you are spending too much, because every restaurant
    # benchmark is stated per group.
    cost_group: Mapped[str] = mapped_column(String(16), default="operating")


class RecurringCost(Base):
    """A cost that arrives every month whether or not anyone logs it.

    Rent, internet and licences are the costs most often missing from a
    small restaurant's books, and their absence does not merely understate
    spending — it makes margin, break-even and every ratio wrong. Recording
    the standing amount once and posting it automatically is the only
    version of this that survives a busy month.
    """
    __tablename__ = "recurring_costs"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    category_id: Mapped[int] = mapped_column(ForeignKey("expense_categories.id"))
    name: Mapped[str] = mapped_column(String(80), default="")
    amount_paise: Mapped[int] = mapped_column(Integer, default=0)
    day_of_month: Mapped[int] = mapped_column(Integer, default=1)
    start_month: Mapped[str] = mapped_column(String(7))          # YYYY-MM
    end_month: Mapped[str | None] = mapped_column(String(7), nullable=True)
    vendor_id: Mapped[int | None] = mapped_column(
        ForeignKey("vendors.id"), nullable=True)
    mode: Mapped[str] = mapped_column(String(12), default="bank")
    note: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(default=True)
    last_owner_review_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    review_cadence_days: Mapped[int] = mapped_column(Integer, default=90)


class Expense(Base, Timestamped):
    __tablename__ = "expenses"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    business_date: Mapped[str] = mapped_column(String(10), index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("expense_categories.id"))
    vendor_id: Mapped[int | None] = mapped_column(ForeignKey("vendors.id"), nullable=True)
    amount_paise: Mapped[int] = mapped_column(Integer)
    mode: Mapped[str] = mapped_column(String(8), default="upi")  # upi|cash|card|bank|credit|other
    description: Mapped[str] = mapped_column(Text, default="")
    receipt_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # unit economics (raw materials): e.g. item "Rice", qty 20, unit "kg"
    item_name: Mapped[str] = mapped_column(String(120), default="")
    quantity: Mapped[float | None] = mapped_column(Float, nullable=True)
    unit: Mapped[str] = mapped_column(String(16), default="")
    entered_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(64), nullable=True)


class Vendor(Base):
    __tablename__ = "vendors"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str] = mapped_column(String(20), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(default=True)


class BankRule(Base):
    """Remembers how a bank-statement payee should be booked.

    Bank narrations are machine strings, so the payee is matched on a key
    derived from the narration (a UPI VPA where there is one, otherwise the
    cleaned merchant name) rather than on the raw text, which carries a
    different transaction id every time.
    """
    __tablename__ = "bank_rules"
    id: Mapped[int] = mapped_column(primary_key=True)
    match_key: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    label: Mapped[str] = mapped_column(String(120), default="")
    vendor_id: Mapped[int | None] = mapped_column(ForeignKey("vendors.id"), nullable=True)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("expense_categories.id"), nullable=True)
    mode: Mapped[str] = mapped_column(String(8), default="bank")
    # Not every debit is an expense: ATM withdrawals move cash to the drawer,
    # card-bill payments and owner transfers are already booked elsewhere.
    skip: Mapped[bool] = mapped_column(default=False)
    hits: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class VendorEntry(Base):
    __tablename__ = "vendor_entries"
    id: Mapped[int] = mapped_column(primary_key=True)
    vendor_id: Mapped[int] = mapped_column(ForeignKey("vendors.id"), index=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    date: Mapped[str] = mapped_column(String(10))
    type: Mapped[str] = mapped_column(String(20))  # purchase_credit|payment|adjustment
    amount_paise: Mapped[int] = mapped_column(Integer)
    expense_id: Mapped[int | None] = mapped_column(ForeignKey("expenses.id"), nullable=True)
    receipt_path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    entered_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class PurchaseOrder(Base, Timestamped):
    """A supplier commitment. It is intentionally not a financial fact."""
    __tablename__ = "purchase_orders"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"), index=True)
    vendor_id: Mapped[int] = mapped_column(ForeignKey("vendors.id"))
    category_id: Mapped[int] = mapped_column(ForeignKey("expense_categories.id"))
    payment_mode: Mapped[str] = mapped_column(String(8), default="credit")
    expected_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(12), default="draft")
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    approved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cancelled_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class PurchaseOrderLine(Base):
    __tablename__ = "purchase_order_lines"
    id: Mapped[int] = mapped_column(primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_orders.id", ondelete="CASCADE"), index=True)
    item_name: Mapped[str] = mapped_column(String(120))
    item_key: Mapped[str] = mapped_column(String(120))
    ordered_quantity: Mapped[float] = mapped_column(Float, default=0)
    unit: Mapped[str] = mapped_column(String(16))
    planned_unit_cost_paise: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (UniqueConstraint("purchase_order_id", "item_key"),)


class PurchaseReceipt(Base, Timestamped):
    """The single receiving record for an order; only finalization posts books."""
    __tablename__ = "purchase_receipts"
    id: Mapped[int] = mapped_column(primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_orders.id"), unique=True, index=True)
    business_date: Mapped[str] = mapped_column(String(10), index=True)
    status: Mapped[str] = mapped_column(String(12), default="draft")
    idempotency_key: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    finalized_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class PurchaseReceiptLine(Base):
    __tablename__ = "purchase_receipt_lines"
    id: Mapped[int] = mapped_column(primary_key=True)
    purchase_receipt_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_receipts.id", ondelete="CASCADE"), index=True)
    purchase_order_line_id: Mapped[int] = mapped_column(ForeignKey("purchase_order_lines.id"))
    received_quantity: Mapped[float] = mapped_column(Float, default=0)
    unit: Mapped[str] = mapped_column(String(16))
    unit_price_paise: Mapped[int] = mapped_column(Integer, default=0)
    expense_id: Mapped[int | None] = mapped_column(ForeignKey("expenses.id"), unique=True, nullable=True)
    __table_args__ = (UniqueConstraint("purchase_receipt_id", "purchase_order_line_id"),)


# ── Money in ──────────────────────────────────────────────────────────────

class SalesChannel(Base):
    __tablename__ = "sales_channels"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(40))
    kind: Mapped[str] = mapped_column(String(16))  # cash|upi|card|wallet|aggregator|split|due|other
    is_active: Mapped[int | bool] = mapped_column(Boolean, default=True)
    sort: Mapped[int] = mapped_column(Integer, default=0)


class SalesBill(Base):
    """Normalized Petpooja bill row."""
    __tablename__ = "sales_bills"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    business_date: Mapped[str] = mapped_column(String(10), index=True)
    invoice_no: Mapped[str] = mapped_column(String(40))
    bill_ts: Mapped[str] = mapped_column(String(19), default="")
    order_type: Mapped[str] = mapped_column(String(24), default="")
    area: Mapped[str] = mapped_column(String(40), default="")
    persons: Mapped[int | None] = mapped_column(Integer, nullable=True)
    channel_kind: Mapped[str] = mapped_column(String(16), default="other")
    gross_paise: Mapped[int] = mapped_column(Integer, default=0)
    discount_paise: Mapped[int] = mapped_column(Integer, default=0)
    net_paise: Mapped[int] = mapped_column(Integer, default=0)
    charges_paise: Mapped[int] = mapped_column(Integer, default=0)
    tax_paise: Mapped[int] = mapped_column(Integer, default=0)
    roundoff_paise: Mapped[int] = mapped_column(Integer, default=0)
    tip_paise: Mapped[int] = mapped_column(Integer, default=0)
    total_paise: Mapped[int] = mapped_column(Integer, default=0)
    raw_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    import_batch_id: Mapped[int | None] = mapped_column(ForeignKey("import_batches.id"), nullable=True)
    __table_args__ = (UniqueConstraint("outlet_id", "business_date", "invoice_no"),)


class SalesDaily(Base):
    __tablename__ = "sales_daily"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    business_date: Mapped[str] = mapped_column(String(10), index=True)
    channel_kind: Mapped[str] = mapped_column(String(16))
    bills: Mapped[int] = mapped_column(Integer, default=0)
    gross_paise: Mapped[int] = mapped_column(Integer, default=0)
    discount_paise: Mapped[int] = mapped_column(Integer, default=0)
    net_paise: Mapped[int] = mapped_column(Integer, default=0)
    tax_paise: Mapped[int] = mapped_column(Integer, default=0)
    tip_paise: Mapped[int] = mapped_column(Integer, default=0)
    total_paise: Mapped[int] = mapped_column(Integer, default=0)
    amount_paise: Mapped[int] = mapped_column(Integer, default=0)  # manual entry amount
    source: Mapped[str] = mapped_column(String(12), default="manual")  # manual|petpooja
    note: Mapped[str] = mapped_column(Text, default="")
    __table_args__ = (UniqueConstraint("outlet_id", "business_date", "channel_kind", "source"),)


class ImportTemplate(Base):
    __tablename__ = "import_templates"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    report_kind: Mapped[str] = mapped_column(String(24))
    column_map: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class ImportBatch(Base):
    __tablename__ = "import_batches"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    filename: Mapped[str] = mapped_column(String(255))
    report_kind: Mapped[str] = mapped_column(String(24))
    template_id: Mapped[int | None] = mapped_column(ForeignKey("import_templates.id"), nullable=True)
    uploaded_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    rows_total: Mapped[int] = mapped_column(Integer, default=0)
    rows_ok: Mapped[int] = mapped_column(Integer, default=0)
    rows_skipped: Mapped[int] = mapped_column(Integer, default=0)
    part_payments_unresolved: Mapped[int] = mapped_column(Integer, default=0)
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="validated")  # validated|committed|discarded


class SalesItem(Base):
    """Normalized item-level sales row (Petpooja item-wise imports)."""
    __tablename__ = "sales_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    business_date: Mapped[str] = mapped_column(String(10), index=True)
    item_name: Mapped[str] = mapped_column(String(160))
    category: Mapped[str] = mapped_column(String(80), default="")
    qty: Mapped[float] = mapped_column(Float, default=0)
    amount_paise: Mapped[int] = mapped_column(Integer, default=0)
    import_batch_id: Mapped[int | None] = mapped_column(ForeignKey("import_batches.id"), nullable=True)
    __table_args__ = (UniqueConstraint("outlet_id", "business_date", "item_name"),)


# ── Inventory ─────────────────────────────────────────────────────────────

class StockItem(Base):
    __tablename__ = "stock_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    name: Mapped[str] = mapped_column(String(120))
    name_key: Mapped[str] = mapped_column(String(120))   # normalized dedupe key
    base_unit: Mapped[str] = mapped_column(String(16), default="kg")
    par_qty: Mapped[float] = mapped_column(Float, default=0)   # order-up-to level
    min_qty: Mapped[float] = mapped_column(Float, default=0)   # reorder point
    current_qty: Mapped[float] = mapped_column(Float, default=0)
    yield_percent: Mapped[float] = mapped_column(Float, default=100)
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    __table_args__ = (UniqueConstraint("outlet_id", "name_key"),)


class StockMovement(Base):
    __tablename__ = "stock_movements"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    stock_item_id: Mapped[int] = mapped_column(ForeignKey("stock_items.id"))
    business_date: Mapped[str] = mapped_column(String(10), index=True)
    type: Mapped[str] = mapped_column(String(14))  # opening|purchase|wastage|adjustment|count_fix
    qty: Mapped[float] = mapped_column(Float)      # signed: + in, − out
    unit_cost_paise: Mapped[int] = mapped_column(Integer, default=0)
    reason: Mapped[str] = mapped_column(Text, default="")
    ref_expense_id: Mapped[int | None] = mapped_column(ForeignKey("expenses.id"), nullable=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class StockLink(Base):
    __tablename__ = "stock_links"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    stock_item_id: Mapped[int] = mapped_column(ForeignKey("stock_items.id"))
    menu_item_name: Mapped[str] = mapped_column(String(160))
    coefficient: Mapped[float] = mapped_column(Float, default=0)  # base_unit per dish
    status: Mapped[str] = mapped_column(String(12), default="suggested")  # suggested|confirmed|rejected
    confidence: Mapped[str] = mapped_column(String(12), default="insufficient")
    weeks_data: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    __table_args__ = (UniqueConstraint("outlet_id", "stock_item_id", "menu_item_name"),)


class StockCount(Base):
    __tablename__ = "stock_counts"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    business_date: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(8), default="draft")  # draft|done
    counted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class StockCountLine(Base):
    __tablename__ = "stock_count_lines"
    id: Mapped[int] = mapped_column(primary_key=True)
    count_id: Mapped[int] = mapped_column(ForeignKey("stock_counts.id"))
    stock_item_id: Mapped[int] = mapped_column(ForeignKey("stock_items.id"))
    system_qty: Mapped[float] = mapped_column(Float, default=0)
    counted_qty: Mapped[float | None] = mapped_column(Float, nullable=True)


# ── Payroll ───────────────────────────────────────────────────────────────

class PayrollRun(Base):
    __tablename__ = "payroll_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    year: Mapped[int] = mapped_column(Integer)
    month: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(10), default="draft")  # draft|finalized
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finalized_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    __table_args__ = (UniqueConstraint("outlet_id", "year", "month"),)


class Payslip(Base):
    __tablename__ = "payslips"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("payroll_runs.id"))
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    monthly_salary_paise: Mapped[int] = mapped_column(Integer)
    rate_divisor: Mapped[int] = mapped_column(Integer, default=26)
    presents: Mapped[int] = mapped_column(Integer, default=0)
    halves: Mapped[int] = mapped_column(Integer, default=0)
    doubles: Mapped[int] = mapped_column(Integer, default=0)
    absents: Mapped[int] = mapped_column(Integer, default=0)
    lates_count: Mapped[int] = mapped_column(Integer, default=0)
    credited_days_x10: Mapped[int] = mapped_column(Integer, default=0)
    gross_paise: Mapped[int] = mapped_column(Integer, default=0)
    bonus_paise: Mapped[int] = mapped_column(Integer, default=0)
    deduction_paise: Mapped[int] = mapped_column(Integer, default=0)
    advance_recovery_paise: Mapped[int] = mapped_column(Integer, default=0)
    net_paise: Mapped[int] = mapped_column(Integer, default=0)
    paid_paise: Mapped[int] = mapped_column(Integer, default=0)
    mode: Mapped[str | None] = mapped_column(String(8), nullable=True)
    paid_on: Mapped[str | None] = mapped_column(String(10), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    __table_args__ = (UniqueConstraint("run_id", "employee_id"),)


class PayslipAdjustment(Base):
    __tablename__ = "payslip_adjustments"
    id: Mapped[int] = mapped_column(primary_key=True)
    payslip_id: Mapped[int] = mapped_column(ForeignKey("payslips.id"))
    kind: Mapped[str] = mapped_column(String(16))  # bonus_days|bonus_amt|deduction
    value_x10_or_paise: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(Text, default="")
    added_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


# ── Day / month control ───────────────────────────────────────────────────

class DayClosure(Base):
    __tablename__ = "day_closures"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    business_date: Mapped[str] = mapped_column(String(10))
    expected_cash_paise: Mapped[int] = mapped_column(Integer, default=0)
    counted_cash_paise: Mapped[int] = mapped_column(Integer, default=0)
    variance_paise: Mapped[int] = mapped_column(Integer, default=0)
    moved_to_bank_paise: Mapped[int] = mapped_column(Integer, default=0)  # taken home / deposited
    counted_breakdown: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # note denominations
    note: Mapped[str] = mapped_column(Text, default="")
    closed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    closed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    reopened_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reopened_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    __table_args__ = (UniqueConstraint("outlet_id", "business_date"),)


class DayLoss(Base):
    """Money or goods lost on a given day: refunds, drawer shortages, spoilage.

    Only kinds marked cash-capable may set from_drawer, and `cash_short` never
    can: a shortage is what the day-close variance already measures, so letting
    it reduce expected cash would silently cancel the very number that reveals
    it.
    """
    __tablename__ = "day_losses"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    business_date: Mapped[str] = mapped_column(String(10), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    amount_paise: Mapped[int] = mapped_column(Integer)
    from_drawer: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str] = mapped_column(Text, default="")
    entered_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class MonthLock(Base):
    __tablename__ = "month_locks"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    year: Mapped[int] = mapped_column(Integer)
    month: Mapped[int] = mapped_column(Integer)
    locked_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    locked_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    __table_args__ = (UniqueConstraint("outlet_id", "year", "month"),)


class BankCredit(Base):
    """A statement credit retained only for cash-deposit reconciliation."""
    __tablename__ = "bank_credits"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"))
    business_date: Mapped[str] = mapped_column(String(10), index=True)
    amount_paise: Mapped[int] = mapped_column(Integer)
    narration: Mapped[str] = mapped_column(Text, default="")
    reference: Mapped[str] = mapped_column(String(120), default="")
    line_hash: Mapped[str] = mapped_column(String(64))
    import_batch_id: Mapped[int | None] = mapped_column(ForeignKey("import_batches.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    __table_args__ = (UniqueConstraint("outlet_id", "line_hash"),)


class CashBankMatch(Base):
    """An owner-confirmed allocation between a cash close and bank credit."""
    __tablename__ = "cash_bank_matches"
    id: Mapped[int] = mapped_column(primary_key=True)
    closure_id: Mapped[int] = mapped_column(ForeignKey("day_closures.id"))
    bank_credit_id: Mapped[int] = mapped_column(ForeignKey("bank_credits.id"))
    amount_paise: Mapped[int] = mapped_column(Integer)
    matched_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    matched_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    __table_args__ = (UniqueConstraint("closure_id", "bank_credit_id"),)


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class FindingResolution(Base):
    """An owner decision about one deterministic finding in one evidence period."""
    __tablename__ = "finding_resolutions"
    id: Mapped[int] = mapped_column(primary_key=True)
    outlet_id: Mapped[int] = mapped_column(ForeignKey("outlets.id"), index=True)
    finding_id: Mapped[str] = mapped_column(String(160))
    covered_period: Mapped[str] = mapped_column(String(32))
    fingerprint: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(20), default="open")
    note: Mapped[str] = mapped_column(Text, default="")
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    __table_args__ = (
        UniqueConstraint("outlet_id", "finding_id", "covered_period"),
        Index("ix_finding_resolution_fingerprint", "outlet_id", "fingerprint"),
    )
