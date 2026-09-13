"""Settings + audit log + backup download."""
import io
import math
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
from ..backup import configure_recovery_backup_directory, recovery_backup_status
from ..config import DEFAULT_EDIT_CUTOFF_HOURS, SECRET_KEY_FILE, UPLOAD_DIR
from ..db import get_db
from ..models import AuditLog, User
from ..security import require_owner, require_stepup

router = APIRouter(prefix="/admin", tags=["admin"])


class SettingIn(BaseModel):
    key: str
    value: object


class SettingsBulkIn(BaseModel):
    values: dict[str, object]


class RecoveryLocationIn(BaseModel):
    directory: str | None = None


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

MAX_EDIT_CUTOFF_HOURS = 8_760
MAX_VARIANCE_ALERT_PAISE = 1_000_000_000
MAX_DENOMINATION = 1_000_000
VALID_TIP_POLICIES = {"record-only"}
VALID_OCR_PROVIDERS = {"openai_compat", "tesseract"}


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


def _whole_number(value: object, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HTTPException(422, f"{label} must be a whole number")
    try:
        number = float(value)
    except OverflowError:
        raise HTTPException(422, f"{label} must be a finite number") from None
    if not math.isfinite(number):
        raise HTTPException(422, f"{label} must be a finite number")
    if not number.is_integer() or not minimum <= number <= maximum:
        raise HTTPException(422, f"{label} must be a whole number from {minimum} to {maximum}")
    return int(number)


def _text(value: object, label: str, *, allow_blank: bool = False) -> str:
    if not isinstance(value, str):
        raise HTTPException(422, f"{label} must be text")
    text = value.strip()
    if not text and not allow_blank:
        raise HTTPException(422, f"{label} cannot be blank")
    return text


def _validate_setting(key: str, value: object):
    if key not in ALLOWED_KEYS:
        raise HTTPException(422, f"Unknown setting {key}")
    if key == "edit_cutoff_hours":
        return _whole_number(value, "Edit window", 0, MAX_EDIT_CUTOFF_HOURS)
    if key == "variance_alert_paise":
        return _whole_number(value, "Variance alert", 0, MAX_VARIANCE_ALERT_PAISE)
    if key == "salary_divisor_default":
        return _whole_number(value, "Salary divisor", 1, 60)
    if key == "denominations":
        if not isinstance(value, list):
            raise HTTPException(422, "Denominations must be positive numbers")
        vals = sorted({
            _whole_number(item, "Denominations", 1, MAX_DENOMINATION)
            for item in value
        }, reverse=True)
        if not vals:
            raise HTTPException(422, "Denominations must be positive numbers")
        return vals
    if key in {"currency_code", "currency_symbol", "currency_locale"}:
        return _text(value, key)
    if key == "restaurant_name":
        text = _text(value, "Business name")
        if len(text) > 80:
            raise HTTPException(422, "Business name must be 80 characters or fewer")
        return text
    if key == "timezone_name":
        text = _text(value, "Timezone")
        try:
            ZoneInfo(text)
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(422, "Unknown timezone")
        return text
    if key == "tip_policy":
        if value not in VALID_TIP_POLICIES:
            raise HTTPException(422, "Unknown tip policy")
        return value
    if key == "ocr_enabled":
        if not isinstance(value, bool):
            raise HTTPException(422, "OCR enabled must be true or false")
        return value
    if key == "ocr_provider":
        provider = _text(value, "OCR provider")
        if provider not in VALID_OCR_PROVIDERS:
            raise HTTPException(422, "Unknown OCR provider")
        return provider
    if key in {"ocr_base_url", "ocr_model", "ocr_api_key"}:
        return _text(value, key, allow_blank=True)
    raise HTTPException(422, f"Unknown setting {key}")


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
            if SECRET_KEY_FILE.exists():
                z.write(SECRET_KEY_FILE, arcname="secret.key")
    data = buf.getvalue()
    audit(db, None, user.id, "backup-download", "backup", stamp)
    db.commit()
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="ledger-backup-{stamp}.zip"'},
    )


@router.get("/backup/status")
def backup_status(user: User = Depends(require_owner)):
    return recovery_backup_status()


@router.put("/backup/recovery-location")
def set_backup_recovery_location(body: RecoveryLocationIn,
                                 user: User = Depends(require_stepup),
                                 db: Session = Depends(get_db)):
    try:
        status = configure_recovery_backup_directory(body.directory)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(
            422, "Ledger cannot write to that recovery folder. Check the path and Drive sync."
        ) from exc
    audit(db, None, user.id, "backup-location", "backup",
          "default" if body.directory is None else "owner-selected")
    db.commit()
    return status
