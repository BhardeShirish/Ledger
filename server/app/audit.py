import json

from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from .models import AuditLog, Setting, utcnow
from .security import has_stepup
from .config import DEFAULT_EDIT_CUTOFF_HOURS
from .util import parse_date, now_local


def audit(db: Session, request: Request | None, user_id: int | None, action: str,
          entity: str, entity_id="", before=None, after=None, note="") -> None:
    db.add(AuditLog(
        user_id=user_id,
        action=action,
        entity=entity,
        entity_id=str(entity_id or ""),
        before=_safe(before),
        after=_safe(after),
        note=note or "",
        ip=(request.client.host if request and request.client else ""),
    ))


def _safe(v):
    if v is None:
        return None
    try:
        json.loads(json.dumps(v, default=str))
        return v
    except Exception:
        return {"repr": str(v)[:500]}


def get_setting_db(db: Session, key: str, default):
    row = db.get(Setting, key)
    if row is None or row.value is None:
        return default
    return row.value.get("v", default)


def set_setting_db(db: Session, key: str, value, user_id: int | None) -> None:
    row = db.get(Setting, key)
    if row is None:
        row = Setting(key=key)
        db.add(row)
    row.value = {"v": value}
    row.updated_at = utcnow()
    row.updated_by = user_id


def check_edit_window(date_iso: str | None, user, db: Session,
                      no_future: bool = False) -> None:
    """Raise 403 when the record's business date is older than the cutoff.

    - manager: never allowed past the window
    - owner: allowed past the window only with a recent step-up verification

    `no_future` additionally refuses dates that have not happened yet. It is
    opt-in because roster overrides and join dates are legitimately planned
    ahead; things that record what actually happened are not.
    """
    if not date_iso:
        return
    cutoff_hours = int(get_setting_db(db, "edit_cutoff_hours", DEFAULT_EDIT_CUTOFF_HOURS))
    d = parse_date(date_iso)
    if d is None:
        return
    today = now_local().date()
    if no_future and d > today:
        raise HTTPException(422, "That day has not happened yet.")
    age_hours = (today - d).total_seconds() / 3600.0
    if age_hours <= cutoff_hours:
        return
    if user.role == "owner" and has_stepup(user):
        return
    raise HTTPException(
        403,
        "This record is older than the edit window. Owner password re-verification required."
        if user.role == "owner" else
        "Only the owner can change records this old.",
    )
