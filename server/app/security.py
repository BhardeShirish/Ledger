import hashlib
import hmac
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .config import (
    LOCKOUT_MINUTES,
    MAX_FAILED_LOGINS,
    REMEMBER_TTL_DAYS,
    SECRET_KEY,
    STEPUP_TTL_MINUTES,
    TOKEN_TTL_HOURS,
)
from .db import get_db
from .models import AuthSession, User


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _future(value: datetime | None) -> bool:
    if value is None:
        return False
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value > _utcnow()


# Password hashing
#
# The work factor is written into the stored hash rather than fixed in the
# code. That is what lets the test suite hash cheaply without any risk to a
# real ledger: a password saved at one cost is still verified at that cost,
# so the two can never be confused. Hashes written before this carried no
# cost and are read at the original 2**14.

_SCRYPT_N = 2**14
#: Tests hash thousands of times and care about none of it. Only a run that
#: has declared itself a test gets the cheap factor.
if os.environ.get("LEDGER_TESTING") == "1":
    _SCRYPT_N = 2**8


def _scrypt(password: str, salt: bytes, n: int) -> str:
    return hashlib.scrypt(password.encode(), salt=salt, n=n, r=8, p=1,
                          dklen=32).hex()


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    return f"scrypt{_SCRYPT_N}${salt.hex()}${_scrypt(password, salt, _SCRYPT_N)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, salt_hex, dk_hex = stored.split("$")
        n = int(algo[len("scrypt"):]) if algo != "scrypt" else 2**14
        # A floor, because a tampered file could otherwise ask for a cost
        # so low the password is trivial to guess. Costs that are absurdly
        # high or not a power of two need no check here: scrypt itself
        # refuses them immediately, and that lands in the except below.
        if n < 2**8:
            return False
        dk = _scrypt(password, bytes.fromhex(salt_hex), n)
        return hmac.compare_digest(dk, dk_hex)
    except (ValueError, TypeError):
        return False


# Durable authentication sessions

def make_token(
    user_id: int, db: Session, remember: bool = False
) -> tuple[str, str, datetime]:
    now = _utcnow()
    expires = now + (
        timedelta(days=REMEMBER_TTL_DAYS)
        if remember
        else timedelta(hours=TOKEN_TTL_HOURS)
    )
    session_id = uuid.uuid4().hex
    csrf_token = secrets.token_urlsafe(32)
    db.add(AuthSession(
        id=session_id,
        user_id=user_id,
        csrf_hash=hashlib.sha256(csrf_token.encode()).hexdigest(),
        expires_at=expires,
    ))
    token = jwt.encode(
        {
            "sub": str(user_id),
            "sid": session_id,
            "exp": expires.replace(tzinfo=timezone.utc),
        },
        SECRET_KEY,
        algorithm="HS256",
    )
    return token, csrf_token, expires


def parse_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        int(payload["sub"])
        if not payload.get("sid"):
            return None
        return payload
    except (jwt.PyJWTError, KeyError, TypeError, ValueError):
        return None


def _request_token(request: Request) -> tuple[str, bool]:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:], False
    cookie = request.cookies.get("ledger_token")
    if cookie:
        return cookie, True
    raise HTTPException(401, "Not signed in")


def _check_csrf(request: Request, session: AuthSession) -> None:
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    cookie = request.cookies.get("ledger_csrf", "")
    header = request.headers.get("X-CSRF-Token", "")
    supplied_hash = hashlib.sha256(header.encode()).hexdigest()
    if not cookie or not header or not hmac.compare_digest(cookie, header):
        raise HTTPException(403, "Invalid CSRF token")
    if not hmac.compare_digest(session.csrf_hash, supplied_hash):
        raise HTTPException(403, "Invalid CSRF token")


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token, cookie_auth = _request_token(request)
    payload = parse_token(token)
    if payload is None:
        raise HTTPException(401, "Session expired")
    session = db.get(AuthSession, payload["sid"])
    user_id = int(payload["sub"])
    if (
        session is None
        or session.user_id != user_id
        or session.revoked_at is not None
        or not _future(session.expires_at)
    ):
        raise HTTPException(401, "Session expired")
    if cookie_auth:
        _check_csrf(request, session)
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(401, "Account disabled")
    if _future(user.locked_until):
        raise HTTPException(423, "Account temporarily locked. Try later.")
    request.state.auth_session = session
    user._auth_session = session
    return user


def require_owner(user: User = Depends(current_user)) -> User:
    if user.role != "owner":
        raise HTTPException(403, "Owner access required")
    return user


def has_stepup(user: User) -> bool:
    session = getattr(user, "_auth_session", None)
    return session is not None and _future(session.elevated_until)


def grant_stepup(user: User, db: Session) -> datetime:
    session = getattr(user, "_auth_session", None)
    if session is None:
        raise HTTPException(401, "Session expired")
    session.elevated_until = _utcnow() + timedelta(minutes=STEPUP_TTL_MINUTES)
    db.commit()
    return session.elevated_until


def revoke_stepup(user: User, db: Session) -> None:
    session = getattr(user, "_auth_session", None)
    if session is not None:
        session.elevated_until = None
        db.commit()


def revoke_session(user: User, db: Session) -> None:
    session = getattr(user, "_auth_session", None)
    if session is not None and session.revoked_at is None:
        session.revoked_at = _utcnow()
        session.elevated_until = None
        db.commit()


def revoke_other_sessions(user: User, db: Session) -> None:
    current = getattr(user, "_auth_session", None)
    q = db.query(AuthSession).filter(
        AuthSession.user_id == user.id,
        AuthSession.revoked_at.is_(None),
    )
    if current is not None:
        q = q.filter(AuthSession.id != current.id)
    now = _utcnow()
    for session in q.all():
        session.revoked_at = now
        session.elevated_until = None


def require_stepup(user: User = Depends(current_user)) -> User:
    if user.role != "owner":
        raise HTTPException(403, "Owner access required")
    if not has_stepup(user):
        raise HTTPException(428, "Password re-verification required")
    return user


def register_failed_login(user: User, db: Session) -> None:
    user.failed_attempts += 1
    if user.failed_attempts >= MAX_FAILED_LOGINS:
        user.locked_until = _utcnow() + timedelta(minutes=LOCKOUT_MINUTES)
        user.failed_attempts = 0
    db.commit()


def clear_lock(user: User, db: Session) -> None:
    if _future(user.locked_until):
        raise HTTPException(423, "Account temporarily locked. Try later.")
    user.locked_until = None
    db.commit()
