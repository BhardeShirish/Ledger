"""Automatic local snapshots of the ledger database.

This is a restaurant's only financial record and it lives in one SQLite file
on one laptop. A manual "download backup" button only helps the day someone
remembers to press it, so the server takes its own daily copy.

sqlite3's online backup API is used rather than a file copy because the
database is usually open and in WAL mode while this runs.
"""
from __future__ import annotations

import sqlite3
from datetime import date
from pathlib import Path

from .config import DB_PATH, DATA_DIR

KEEP_DAYS = 14
BACKUP_DIR = Path(DATA_DIR) / "backups"


def _prune(keep: int = KEEP_DAYS) -> None:
    snaps = sorted(BACKUP_DIR.glob("ledger-*.db"), reverse=True)
    for old in snaps[keep:]:
        old.unlink(missing_ok=True)


def run_daily_backup() -> Path | None:
    """Snapshot today's database once. Returns the file, or None if current.

    Never raises: a failed backup must not stop the restaurant from working.
    """
    try:
        source_path = Path(DB_PATH)
        if not source_path.exists():
            return None
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        target = BACKUP_DIR / f"ledger-{date.today().isoformat()}.db"
        if target.exists():
            return None

        partial = target.with_suffix(".db.partial")
        partial.unlink(missing_ok=True)
        source = sqlite3.connect(f"file:{source_path}?mode=ro", uri=True)
        try:
            destination = sqlite3.connect(partial)
            try:
                source.backup(destination)
                ok = destination.execute("PRAGMA integrity_check").fetchone()[0]
            finally:
                destination.close()
        finally:
            source.close()

        if ok != "ok":
            partial.unlink(missing_ok=True)
            print(f"[ledger] backup rejected, integrity_check said: {ok}")
            return None

        # only becomes the day's backup once it is known to be complete
        partial.replace(target)
        _prune()
        return target
    except Exception as exc:                      # pragma: no cover - defensive
        print(f"[ledger] automatic backup failed: {exc}")
        return None
