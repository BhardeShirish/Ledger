from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..audit import audit
from ..db import get_db
from ..models import User
from ..security import (
    clear_lock,
    current_user,
    grant_stepup,
    hash_password,
    has_stepup,
    make_token,
    parse_token,
    register_failed_login,
    revoke_other_sessions,
    revoke_session,
    revoke_stepup,
    verify_password,
)
from .helpers import user_outlet_ids

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str
    password: str
    remember: bool = False


class StepUpIn(BaseModel):
    password: str


class ChangePwIn(BaseModel):
    old_password: str
    new_password: str


def _user_payload(u: User, db: Session) -> dict:
    session = getattr(u, "_auth_session", None)
    elevated_until = (
        session.elevated_until.replace(tzinfo=timezone.utc).isoformat()
        if session is not None and has_stepup(u) else None
    )
    return {
        "id": u.id, "username": u.username, "full_name": u.full_name,
        "role": u.role,
        "outlet_ids": user_outlet_ids(db, u),
        "elevated_until": elevated_until,
    }


@router.post("/login")
def login(body: LoginIn, response: Response, request: Request, db: Session = Depends(get_db)):
    u = db.query(User).filter_by(username=body.username.strip().lower()).first()
    if u is None or not u.is_active:
        raise HTTPException(401, "Invalid username or password")
    clear_lock(u, db)
    if not verify_password(body.password, u.password_hash):
        register_failed_login(u, db)
        raise HTTPException(401, "Invalid username or password")
    u.failed_attempts = 0
    u.locked_until = None
    u.last_login_at = datetime.now(timezone.utc)
    db.commit()
    token, csrf_token, expires = make_token(u.id, db, remember=body.remember)
    db.commit()
    max_age = int((expires - datetime.now(timezone.utc).replace(tzinfo=None)).total_seconds())
    secure = request.url.scheme == "https"
    response.set_cookie("ledger_token", token, httponly=True, samesite="lax",
                        secure=secure, max_age=max_age, path="/")
    response.set_cookie("ledger_csrf", csrf_token, httponly=False, samesite="lax",
                        secure=secure, max_age=max_age, path="/")
    audit(db, request, u.id, "login", "user", u.id)
    db.commit()
    return {"token": token, "user": _user_payload(u, db)}


@router.post("/logout")
def logout(response: Response, user: User = Depends(current_user),
           db: Session = Depends(get_db)):
    revoke_session(user, db)
    response.delete_cookie("ledger_token", path="/")
    response.delete_cookie("ledger_csrf", path="/")
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return _user_payload(user, db)


@router.post("/stepup")
def stepup(body: StepUpIn, user: User = Depends(current_user),
           db: Session = Depends(get_db)):
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "Wrong password")
    until = grant_stepup(user, db)
    return {"ok": True, "elevated_until": until.replace(tzinfo=timezone.utc).isoformat()}


@router.post("/stepdown")
def stepdown(user: User = Depends(current_user), db: Session = Depends(get_db)):
    revoke_stepup(user, db)
    return {"ok": True}


class ProfileIn(BaseModel):
    full_name: str


@router.patch("/profile")
def update_profile(body: ProfileIn, user: User = Depends(current_user),
                   db: Session = Depends(get_db)):
    user.full_name = body.full_name.strip()[:120]
    db.commit()
    return _user_payload(user, db)


@router.post("/change-password")
def change_password(body: ChangePwIn, user: User = Depends(current_user),
                    db: Session = Depends(get_db)):
    if not verify_password(body.old_password, user.password_hash):
        raise HTTPException(401, "Current password is wrong")
    if len(body.new_password) < 8:
        raise HTTPException(422, "New password must be at least 8 characters")
    user.password_hash = hash_password(body.new_password)
    revoke_other_sessions(user, db)
    session = getattr(user, "_auth_session", None)
    if session is not None:
        session.elevated_until = None
    db.commit()
    return {"ok": True}
