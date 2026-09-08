"""Owner-only operational policy, recovery, and conservative cash controls."""
from __future__ import annotations

import hashlib
import math
import re
import shutil
import sqlite3
import calendar
from datetime import date, timedelta
from importlib import metadata

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..audit import audit, set_setting_db
from ..config import BACKUP_DIR, DATA_DIR, DB_PATH
from ..db import get_db
from ..models import (DayClosure, FindingResolution, PayrollRun,
                      Payslip, PurchaseOrder, RecurringCost,
                      User, VendorEntry, utcnow)
from ..owner_controls import owner_policy, policy_key
from ..security import require_owner
from ..util import days_in_month, now_local
from .helpers import assert_outlet_access
from .insights import forecast
from .purchases import planned_order_total_paise

router = APIRouter(prefix="/owner", tags=["owner-controls"])

RESOLUTION_STATES = {"resolved", "deferred", "accepted_not_applicable"}
SAFE_BACKUP_NAME = re.compile(r"^ledger-\d{4}-\d{2}-\d{2}\.db$")


class PolicyIn(BaseModel):
    outlet_id: int
    cash_variance_alert_rupees: float
    minimum_data_coverage_percent: float
    stock_count_cadence_days: float
    stockout_lead_days: float
    payable_overdue_days: float
    purchase_approval_limit_rupees: float
    minimum_cash_buffer_rupees: float | None = None


def _policy_out(policy: dict, outlet_id: int) -> dict:
    return {
        "outlet_id": outlet_id,
        "cash_variance_alert_rupees": policy["cash_variance_alert_paise"] / 100,
        "minimum_data_coverage_percent": policy["minimum_data_coverage_percent"],
        "stock_count_cadence_days": policy["stock_count_cadence_days"],
        "stockout_lead_days": policy["stockout_lead_days"],
        "payable_overdue_days": policy["payable_overdue_days"],
        "purchase_approval_limit_rupees": policy["purchase_approval_limit_paise"] / 100,
        "minimum_cash_buffer_rupees": (
            policy["minimum_cash_buffer_paise"] / 100
            if policy["minimum_cash_buffer_paise"] is not None else None
        ),
    }


@router.get("/policies")
def get_policies(outlet_id: int, user: User = Depends(require_owner),
                 db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    return _policy_out(owner_policy(db, outlet_id), outlet_id)


@router.put("/policies")
def put_policies(body: PolicyIn, user: User = Depends(require_owner),
                 db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    numbers = (
        body.cash_variance_alert_rupees, body.minimum_data_coverage_percent,
        body.stock_count_cadence_days, body.stockout_lead_days,
        body.payable_overdue_days, body.purchase_approval_limit_rupees,
        *( [body.minimum_cash_buffer_rupees] if body.minimum_cash_buffer_rupees is not None else []),
    )
    if any(not math.isfinite(value) or value < 0 for value in numbers):
        raise HTTPException(422, "Policy thresholds must be finite, nonnegative numbers")
    if body.minimum_data_coverage_percent > 100:
        raise HTTPException(422, "Minimum data coverage cannot exceed 100 percent")
    for value, label in (
        (body.stock_count_cadence_days, "Stock count cadence"),
        (body.stockout_lead_days, "Stock-out lead time"),
        (body.payable_overdue_days, "Payable overdue days"),
    ):
        if value < 1 or value != int(value):
            raise HTTPException(422, f"{label} must be a whole number of at least one day")
    values = {
        "cash_variance_alert_paise": round(body.cash_variance_alert_rupees * 100),
        "minimum_data_coverage_percent": body.minimum_data_coverage_percent,
        "stock_count_cadence_days": int(body.stock_count_cadence_days),
        "stockout_lead_days": int(body.stockout_lead_days),
        "payable_overdue_days": int(body.payable_overdue_days),
        "purchase_approval_limit_paise": round(body.purchase_approval_limit_rupees * 100),
        "minimum_cash_buffer_paise": (
            round(body.minimum_cash_buffer_rupees * 100)
            if body.minimum_cash_buffer_rupees is not None else None
        ),
    }
    set_setting_db(db, policy_key(body.outlet_id), values, user.id)
    audit(db, None, user.id, "owner-policy", "settings", policy_key(body.outlet_id),
          after={"outlet_id": body.outlet_id, **values})
    db.commit()
    return _policy_out(owner_policy(db, body.outlet_id), body.outlet_id)


class ResolutionIn(BaseModel):
    outlet_id: int
    finding_id: str = Field(min_length=1, max_length=160)
    covered_period: str = Field(pattern=r"^\d{4}-\d{2}$")
    status: str
    note: str = Field(default="", max_length=4000)


def _resolution_fingerprint(finding_id: str, covered_period: str) -> str:
    return hashlib.sha256(f"{finding_id}|{covered_period}".encode()).hexdigest()


def _resolution_shape(row: FindingResolution) -> dict:
    return {
        "id": row.id, "outlet_id": row.outlet_id, "finding_id": row.finding_id,
        "covered_period": row.covered_period, "fingerprint": row.fingerprint,
        "status": row.status, "note": row.note,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.get("/resolutions")
def list_resolutions(outlet_id: int, covered_period: str | None = None,
                     user: User = Depends(require_owner), db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    q = db.query(FindingResolution).filter_by(outlet_id=outlet_id)
    if covered_period:
        q = q.filter_by(covered_period=covered_period)
    return {"items": [_resolution_shape(row) for row in q.order_by(
        FindingResolution.updated_at.desc(), FindingResolution.id.desc()).limit(100).all()]}


@router.post("/resolutions")
def resolve_finding(body: ResolutionIn, user: User = Depends(require_owner),
                    db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    if body.status not in RESOLUTION_STATES:
        raise HTTPException(422, "Resolution status must be resolved, deferred, or accepted_not_applicable")
    note = body.note.strip()
    if body.status != "resolved" and not note:
        raise HTTPException(422, "A note is required when deferring or accepting a finding")
    fingerprint = _resolution_fingerprint(body.finding_id, body.covered_period)
    row = db.query(FindingResolution).filter_by(
        outlet_id=body.outlet_id, finding_id=body.finding_id,
        covered_period=body.covered_period).first()
    before = _resolution_shape(row) if row else None
    if row is None:
        row = FindingResolution(outlet_id=body.outlet_id, finding_id=body.finding_id,
                                covered_period=body.covered_period, fingerprint=fingerprint)
        db.add(row)
    row.status, row.note, row.updated_by, row.updated_at = body.status, note, user.id, utcnow()
    audit(db, None, user.id, "finding-resolution", "finding_resolution",
          f"{body.outlet_id}:{fingerprint}", before=before,
          after={"status": body.status, "covered_period": body.covered_period},
          note=note)
    db.commit()
    return _resolution_shape(row)


@router.post("/resolutions/reopen")
def reopen_finding(body: ResolutionIn, user: User = Depends(require_owner),
                   db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    row = db.query(FindingResolution).filter_by(
        outlet_id=body.outlet_id, finding_id=body.finding_id,
        covered_period=body.covered_period).first()
    if row is None:
        raise HTTPException(404, "No resolution exists for this finding")
    before = _resolution_shape(row)
    row.status, row.note, row.updated_by, row.updated_at = "open", body.note.strip(), user.id, utcnow()
    audit(db, None, user.id, "finding-reopen", "finding_resolution",
          f"{body.outlet_id}:{row.fingerprint}", before=before,
          after={"status": "open", "covered_period": body.covered_period}, note=row.note)
    db.commit()
    return _resolution_shape(row)


def _approved_order_total(db: Session, outlet_id: int, horizon: str) -> int:
    rows = (db.query(PurchaseOrder.id)
              .filter(PurchaseOrder.outlet_id == outlet_id,
                      PurchaseOrder.status == "approved",
                      (PurchaseOrder.expected_date.is_(None) |
                       (PurchaseOrder.expected_date <= horizon))).all())
    ids = [row[0] for row in rows]
    if not ids:
        return 0
    return sum(planned_order_total_paise(db, order_id) for order_id in ids)


def _recurring_outflow_through(costs: list[RecurringCost], today: date, end: date) -> int:
    """Scheduled occurrences only; this does not invoke post_due or write rows."""
    total = 0
    year, month = today.year, today.month
    while (year, month) <= (end.year, end.month):
        month_key = f"{year:04d}-{month:02d}"
        for cost in costs:
            if cost.start_month > month_key or (cost.end_month and cost.end_month < month_key):
                continue
            due = date(year, month, min(cost.day_of_month, calendar.monthrange(year, month)[1]))
            if today <= due <= end:
                total += cost.amount_paise
        month = 1 if month == 12 else month + 1
        if month == 1:
            year += 1
    return total


@router.get("/runway")
def runway(outlet_id: int, horizon_days: int = 30, user: User = Depends(require_owner),
           db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    if not 1 <= horizon_days <= 180:
        raise HTTPException(422, "Horizon must be between 1 and 180 days")
    today = now_local().date()
    horizon = (today + timedelta(days=horizon_days)).isoformat()
    closure = (db.query(DayClosure).filter(
        DayClosure.outlet_id == outlet_id, DayClosure.reopened_at.is_(None),
        DayClosure.business_date <= today.isoformat())
        .order_by(DayClosure.business_date.desc(), DayClosure.id.desc()).first())
    known_drawer = max(0, closure.counted_cash_paise - closure.moved_to_bank_paise) if closure else None
    recurring = [row for row in db.query(RecurringCost).filter_by(
        outlet_id=outlet_id, is_active=True).all()
        if row.start_month <= horizon[:7] and (not row.end_month or row.end_month >= today.strftime("%Y-%m"))]
    recurring_outflow = _recurring_outflow_through(recurring, today, date.fromisoformat(horizon))
    payables = sum(
        row.amount_paise if row.type == "purchase_credit" else -row.amount_paise
        for row in db.query(VendorEntry).filter(
            VendorEntry.outlet_id == outlet_id, VendorEntry.date <= horizon).all())
    approved_orders = _approved_order_total(db, outlet_id, horizon)
    year, month = today.year, today.month
    run = db.query(PayrollRun).filter_by(outlet_id=outlet_id, year=year, month=month,
                                         status="finalized").first()
    payroll = int(db.query(func.coalesce(func.sum(Payslip.net_paise), 0)).filter(
        Payslip.run_id == run.id).scalar()) if run else None
    sales = forecast(today.strftime("%Y-%m"), outlet_id, user, db)
    caveats = [
        "No bank-account balance is recorded. Imported statement credits are not treated as sales or as a bank balance.",
        "Approved orders and recurring bills are expected outflows, not posted expenses.",
        "This is a cash-planning view, not profit, contribution, or a financial statement.",
    ]
    total_cash_known = False  # Ledger has drawer closures, but no reconciled account-balance source.
    projected_outflow = max(0, payables) + recurring_outflow + approved_orders + (payroll or 0)
    return {
        "outlet_id": outlet_id, "as_of": today.isoformat(), "horizon_days": horizon_days,
        "horizon_end": horizon, "status": "withheld" if not total_cash_known else "available",
        "starting_cash_paise": None,
        "known_drawer_paise": known_drawer,
        "base_range_paise": None,
        "cautious_range_paise": None,
        "horizons": {"base_days": None, "cautious_days": None},
        "expected_outflows_paise": {
            "open_payables": max(0, payables), "recurring_bills": recurring_outflow,
            "approved_purchase_orders": approved_orders, "finalized_payroll": payroll,
            "total": projected_outflow,
        },
        "forecast_scenarios": {
            "available": bool(sales["scenarios"]),
            "base_sales_paise": round((sales["scenarios"] or {}).get("base_rupees", 0) * 100)
            if sales["scenarios"] else None,
            "cautious_sales_paise": round((sales["scenarios"] or {}).get("conservative_rupees", 0) * 100)
            if sales["scenarios"] else None,
        },
        "source_coverage": {
            "drawer": "recorded" if closure else "unknown",
            "bank_balance": "unknown",
            "payables": "recorded", "recurring_bills": "recorded",
            "approved_purchase_orders": "recorded", "payroll": "finalized" if run else "unknown",
        },
        "caveats": caveats,
    }


def _backup_integrity(path) -> dict:
    try:
        connection = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
        try:
            result = connection.execute("PRAGMA integrity_check").fetchone()
        finally:
            connection.close()
        return {"status": "ok" if result and result[0] == "ok" else "failed",
                "detail": result[0] if result else "No integrity result"}
    except (OSError, sqlite3.Error) as exc:
        return {"status": "unavailable", "detail": str(exc)}


@router.get("/system-health")
def system_health(outlet_id: int, user: User = Depends(require_owner),
                  db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    try:
        free = shutil.disk_usage(DATA_DIR).free
        disk = {"status": "available", "free_bytes": free}
    except OSError as exc:
        disk = {"status": "unavailable", "detail": str(exc), "free_bytes": None}
    try:
        database = {"status": "available", "size_bytes": DB_PATH.stat().st_size}
    except OSError as exc:
        database = {"status": "unavailable", "detail": str(exc), "size_bytes": None}
    backups = sorted(BACKUP_DIR.glob("ledger-*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    latest = backups[0] if backups else None
    try:
        app_version = {"status": "available", "value": metadata.version("ledger")}
    except metadata.PackageNotFoundError:
        app_version = {"status": "unavailable", "value": None}
    return {
        "app_version": app_version,
        "data_directory": {"status": "available"},
        "disk": disk, "database": database,
        "last_automatic_backup": {
            "status": "available" if latest else "unavailable",
            "name": latest.name if latest else None,
            "created_at": latest.stat().st_mtime if latest else None,
            "size_bytes": latest.stat().st_size if latest else None,
            "integrity": _backup_integrity(latest) if latest else {
                "status": "unavailable", "detail": "No automatic backup is available"},
            "download_path": f"/owner/system-health/backups/{latest.name}" if latest else None,
        },
        "restore_playbook": [
            "Download a backup and stop Ledger on the affected computer.",
            "Keep a copy of the current data folder before changing anything.",
            "Replace ledger.db while Ledger is stopped, then restart and verify the date and totals.",
            "Do not restore over the running database from this screen.",
        ],
    }


@router.get("/system-health/backups/{backup_name}")
def download_automatic_backup(backup_name: str, outlet_id: int,
                              user: User = Depends(require_owner),
                              db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    if not SAFE_BACKUP_NAME.fullmatch(backup_name):
        raise HTTPException(404, "Backup not found")
    path = BACKUP_DIR / backup_name
    if not path.is_file():
        raise HTTPException(404, "Backup not found")
    return FileResponse(path, filename=backup_name, media_type="application/octet-stream")
