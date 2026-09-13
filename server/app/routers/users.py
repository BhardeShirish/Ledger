from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..audit import audit
from ..db import get_db
from ..models import UserOutlet, User
from ..security import hash_password, require_owner

router = APIRouter(prefix="/users", tags=["users"])
VALID_ROLES = {"owner", "manager"}


class UserIn(BaseModel):
    username: str
    full_name: str = ""
    password: str | None = None
    role: str = "manager"
    outlet_ids: list[int] = []
    is_active: bool = True


def _serialize(u: User, db: Session) -> dict:
    return {
        "id": u.id, "username": u.username, "full_name": u.full_name,
        "role": u.role, "is_active": u.is_active,
        "outlet_ids": [r.outlet_id for r in db.query(UserOutlet).filter_by(user_id=u.id)],
    }

def _validate_role(role: str) -> None:
    if role not in VALID_ROLES:
        raise HTTPException(422, "Role must be owner or manager")


def _guard_final_active_owner(db: Session, current: User, role: str, is_active: bool) -> None:
    loses_owner_access = current.role == "owner" and current.is_active and (
        role != "owner" or not is_active
    )
    if loses_owner_access and db.query(User).filter_by(role="owner", is_active=True).count() <= 1:
        raise HTTPException(422, "Ledger must retain at least one active owner")


@router.get("")
def list_users(user: User = Depends(require_owner), db: Session = Depends(get_db)):
    return [_serialize(u, db) for u in db.query(User).order_by(User.username).all()]


@router.post("", status_code=201)
def create_user(body: UserIn, user: User = Depends(require_owner), db: Session = Depends(get_db)):
    _validate_role(body.role)
    if not body.password or len(body.password) < 8:
        raise HTTPException(422, "Password must be at least 8 characters")
    uname = body.username.strip().lower()
    if db.query(User).filter_by(username=uname).count():
        raise HTTPException(409, "Username already exists")
    u = User(username=uname, full_name=body.full_name, role=body.role,
             password_hash=hash_password(body.password), is_active=body.is_active)
    db.add(u)
    db.flush()
    for oid in body.outlet_ids:
        db.add(UserOutlet(user_id=u.id, outlet_id=oid))
    db.commit()
    audit(db, None, user.id, "create", "user", u.id, after={"username": uname, "role": body.role})
    db.commit()
    return _serialize(u, db)


@router.patch("/{user_id}")
def update_user(user_id: int, body: UserIn, user: User = Depends(require_owner),
                db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if u is None:
        raise HTTPException(404, "User not found")
    _validate_role(body.role)
    _guard_final_active_owner(db, u, body.role, body.is_active)
    u.full_name = body.full_name
    u.role = body.role
    u.is_active = body.is_active
    if body.password:
        if len(body.password) < 8:
            raise HTTPException(422, "Password must be at least 8 characters")
        u.password_hash = hash_password(body.password)
    db.query(UserOutlet).filter_by(user_id=u.id).delete()
    for oid in body.outlet_ids:
        db.add(UserOutlet(user_id=u.id, outlet_id=oid))
    audit(db, None, user.id, "update", "user", u.id, after={"role": u.role, "active": u.is_active})
    db.commit()
    return _serialize(u, db)
