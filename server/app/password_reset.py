"""Getting back into a Ledger nobody can sign into any more.

There is no email server here, and there must not be one: the whole point
of this application is that the restaurant's books live on the
restaurant's own PC. That rules out the usual "we sent you a link", and it
rules out a self-service reset on the login page even harder — Ledger is
reachable from the owner's phone, so anything that could be completed
entirely through the browser would be a way in, not a way back in.

What is left is the one thing an attacker on the network cannot fake:
being able to read a file on the machine itself. Asking to reset writes a
code into the data folder; completing the reset requires typing that code
back. Somebody who can already read that folder can read the database
anyway, so this gives away nothing that was not already theirs.

The pending code lives in memory, not on disk. Restarting Ledger therefore
cancels a reset in progress, which is the safe direction to fail in.
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .config import DATA_DIR

RESET_TTL_MINUTES = 15
MAX_RESET_ATTEMPTS = 5
# No O/0 or I/1: this code is read off a screen and typed on a phone.
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def reset_file() -> Path:
    return DATA_DIR / "password-reset.txt"


@dataclass
class _Pending:
    code: str
    expires_at: datetime
    attempts: int = field(default=0)


_pending: dict[str, _Pending] = {}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _make_code() -> str:
    groups = ["".join(secrets.choice(_ALPHABET) for _ in range(4)) for _ in range(3)]
    return "-".join(groups)


def request_reset(username: str) -> Path:
    """Issue a code and write it where only this PC can read it.

    A code is written whether or not the account exists. Telling the
    browser which usernames are real would hand an attacker the first half
    of the job for free.
    """
    code = _make_code()
    _pending[username] = _Pending(
        code=code, expires_at=_now() + timedelta(minutes=RESET_TTL_MINUTES)
    )
    path = reset_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    expires_local = (_now() + timedelta(minutes=RESET_TTL_MINUTES)).astimezone()
    path.write_text(
        "LEDGER PASSWORD RESET\n"
        "=====================\n\n"
        f"Account:  {username}\n"
        f"Code:     {code}\n"
        f"Valid until {expires_local:%d %b %Y, %I:%M %p} "
        f"({RESET_TTL_MINUTES} minutes).\n\n"
        "Type this code into the 'Forgot password' screen together with the\n"
        "new password you want.\n\n"
        "If you did not ask for this, someone tried to reset the Ledger\n"
        "password. The code alone changes nothing, and it expires on its own.\n"
        "Delete this file and carry on.\n",
        encoding="utf-8",
    )
    return path


def verify_and_consume(username: str, code: str) -> bool:
    """Check a code, spending it whether or not it was right.

    Wrong guesses are counted and the code is thrown away after a few, so
    a 12-character code cannot be worn down by repetition.
    """
    pending = _pending.get(username)
    if pending is None:
        return False
    if pending.expires_at <= _now():
        _pending.pop(username, None)
        return False
    pending.attempts += 1
    if pending.attempts > MAX_RESET_ATTEMPTS:
        _pending.pop(username, None)
        return False
    if not secrets.compare_digest(pending.code, code.strip().upper()):
        return False
    _pending.pop(username, None)
    return True


def clear_reset_file() -> None:
    try:
        reset_file().unlink(missing_ok=True)
    except OSError:
        # A leftover file is untidy, not dangerous: its code is already spent.
        pass


def forget_all() -> None:
    """Used by tests, and by anything that needs a clean slate."""
    _pending.clear()
