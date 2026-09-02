"""Ledger must be able to resolve its timezone on a clean Windows PC.

Windows ships no IANA timezone database. app/util.py builds
ZoneInfo("Asia/Kolkata") at import time, so if the tzdata package is not a
declared dependency the whole app fails to start on a new machine with
ZoneInfoNotFoundError - which is exactly what happened during a migration.

Checking the declaration matters: the developer machine already had tzdata
installed by chance, so a plain ZoneInfo() call passed there and hid the bug.
"""
from pathlib import Path
from zoneinfo import ZoneInfo

REQUIREMENTS = Path(__file__).resolve().parents[1] / "requirements.txt"


def test_timezone_resolves():
    from app.config import TZ_NAME
    from app.util import TZ

    assert ZoneInfo(TZ_NAME) is not None
    assert TZ is not None


def test_tzdata_is_a_declared_dependency():
    declared = [
        line.split("==")[0].strip().lower()
        for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    assert "tzdata" in declared, (
        "tzdata missing from requirements.txt - Ledger will fail to start on a "
        "clean Windows PC with ZoneInfoNotFoundError"
    )
