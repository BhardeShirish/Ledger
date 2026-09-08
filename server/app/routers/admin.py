"""Settings + audit log + backup download."""
import io
import sqlite3
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..audit import audit, get_setting_db, set_setting_db
from ..config import DEFAULT_EDIT_CUTOFF_HOURS, UPLOAD_DIR
from ..db import get_db
from ..models import AuditLog, User
from ..security import require_owner, require_stepup

router = APIRouter(prefix="/admin", tags=["admin"])


class SettingIn(BaseModel):
    key: str
    value: object


class SettingsBulkIn(BaseModel):
    values: dict[str, object]


ALLOWED_KEYS = {
    "edit_cutoff_hours", "variance_alert_paise", "tip_policy",
    "restaurant_name", "salary_divisor_default",
    "currency_code", "currency_symbol", "currency_locale",
    "denominations", "timezone_name",
    "ocr_enabled", "ocr_provider", "ocr_base_url",
    "ocr_model", "ocr_api_key",
}

DEFAULTS = {
    "edit_cutoff_hours": DEFAULT_EDIT_CUTOFF_HOURS,
    "variance_alert_paise": 20_000,
    "tip_policy": "record-only",
    "salary_divisor_default": 26,
    "currency_code": "INR",
    "currency_symbol": "₹",
    "currency_locale": "en-IN",
    "denominations": [500, 200, 100, 50, 20, 10, 5, 2, 1],
    "timezone_name": "Asia/Kolkata",
    "restaurant_name": "My restaurant",
}


@router.get("/settings")
def read_settings(user: User = Depends(require_owner), db: Session = Depends(get_db)):
    out = dict(DEFAULTS)
    for k in ALLOWED_KEYS:
        out[k] = get_setting_db(db, k, DEFAULTS.get(k))
    return out


@router.put("/settings")
def write_setting(body: SettingIn, user: User = Depends(require_stepup),
                  db: Session = Depends(get_db)):
    value = _validate_setting(body.key, body.value)
    set_setting_db(db, body.key, value, user.id)
    audit(db, None, user.id, "setting", "settings", body.key, after={"v": value})
    db.commit()
    return {"ok": True}


@router.put("/settings/bulk")
def write_settings_bulk(body: SettingsBulkIn,
                        user: User = Depends(require_stepup),
                        db: Session = Depends(get_db)):
    validated = {
        key: _validate_setting(key, value)
        for key, value in body.values.items()
    }
    for key, value in validated.items():
        set_setting_db(db, key, value, user.id)
        audit(db, None, user.id, "setting", "settings", key,
              after={"v": value})
    db.commit()
    return {"ok": True}


def _validate_setting(key: str, value: object):
    if key not in ALLOWED_KEYS:
        raise HTTPException(422, f"Unknown setting {key}")
    if key == "denominations":
        vals = sorted({int(v) for v in value}, reverse=True) \
            if isinstance(value, list) else None
        if not vals or any(v < 1 for v in vals):
            raise HTTPException(422, "Denominations must be positive numbers")
        return vals
    if key in {"currency_code", "currency_symbol", "currency_locale"}:
        text = str(value).strip()
        if not text:
            raise HTTPException(422, f"{key} cannot be blank")
        return text
    if key == "restaurant_name":
        text = str(value).strip()
        if not text:
            raise HTTPException(422, "Business name cannot be blank")
        if len(text) > 80:
            raise HTTPException(422, "Business name must be 80 characters or fewer")
        return text
    if key == "timezone_name":
        text = str(value).strip()
        try:
            ZoneInfo(text)
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(422, "Unknown timezone")
        return text
    return value


@router.get("/audit")
def audit_log(entity: str | None = None, action: str | None = None, page: int = 1,
              user: User = Depends(require_owner), db: Session = Depends(get_db)):
    q = db.query(AuditLog)
    if entity:
        q = q.filter_by(entity=entity)
    if action:
        q = q.filter_by(action=action)
    per = 100
    total = q.count()
    rows = (q.order_by(AuditLog.ts.desc())
              .offset((max(1, page) - 1) * per).limit(per).all())
    return {
        "total": total,
        "rows": [{
            "id": a.id, "ts": a.ts.isoformat() if a.ts else None,
            "user_id": a.user_id, "action": a.action, "entity": a.entity,
            "entity_id": a.entity_id, "before": a.before, "after": a.after,
            "note": a.note, "ip": a.ip,
        } for a in rows],
    }


@router.get("/backup/download")
def backup(user: User = Depends(require_stepup), db: Session = Depends(get_db)):
    """Zip a consistent SQLite snapshot + receipts."""
    raw = db.connection().connection.dbapi_connection  # underlying sqlite3 conn
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    buf = io.BytesIO()
    # A plain copy of ledger.db can miss commits still sitting in the -wal
    # sidecar, which the zip does not carry. The online backup API folds the
    # WAL in and cannot hand back a half-written page.
    with tempfile.TemporaryDirectory() as tmp:
        snapshot = Path(tmp) / "ledger.db"
        destination = sqlite3.connect(snapshot)
        try:
            raw.backup(destination)
        finally:
            destination.close()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(snapshot, arcname="ledger.db")
            for p in UPLOAD_DIR.rglob("*"):
                if p.is_file():
                    z.write(p, arcname=f"uploads/{p.relative_to(UPLOAD_DIR)}")
    data = buf.getvalue()
    audit(db, None, user.id, "backup-download", "backup", stamp)
    db.commit()
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="ledger-backup-{stamp}.zip"'},
    )
