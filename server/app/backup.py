"""Automatic local snapshots and full recovery archives.

This is a restaurant's only financial record and it lives in one SQLite file
on one laptop. A manual "download backup" button only helps the day someone
remembers to press it, so the server takes its own daily copy.

sqlite3's online backup API is used rather than a file copy because the
database is usually open and in WAL mode while this runs.
"""
from __future__ import annotations

import sqlite3
import zipfile
from datetime import date
from pathlib import Path

from .config import (DB_PATH, DATA_DIR, RECOVERY_DIR, SECRET_KEY_FILE, UPLOAD_DIR,
                     set_recovery_directory)

KEEP_DAYS = 14
BACKUP_DIR = Path(DATA_DIR) / "backups"
RECOVERY_KEEP_DAYS = 30
RECOVERY_ARCHIVE_PREFIX = "ledger-recovery-"


def _prune(keep: int = KEEP_DAYS) -> None:
    snaps = sorted(BACKUP_DIR.glob("ledger-*.db"), reverse=True)
    for old in snaps[keep:]:
        old.unlink(missing_ok=True)


def _snapshot_database(target: Path) -> bool:
    """Use SQLite's online backup API so a WAL database is always complete."""
    source_path = Path(DB_PATH)
    source = sqlite3.connect(f"file:{source_path}?mode=ro", uri=True)
    try:
        destination = sqlite3.connect(target)
        try:
            source.backup(destination)
            return destination.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        finally:
            destination.close()
    finally:
        source.close()


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
        if not _snapshot_database(partial):
            partial.unlink(missing_ok=True)
            print("[ledger] backup rejected: integrity_check failed")
            return None

        # only becomes the day's backup once it is known to be complete
        partial.replace(target)
        _prune()
        return target
    except Exception as exc:                      # pragma: no cover - defensive
        print(f"[ledger] automatic backup failed: {exc}")
        return None


def _prune_recovery_archives() -> None:
    archives = sorted(
        RECOVERY_DIR.glob(f"{RECOVERY_ARCHIVE_PREFIX}*.zip"), reverse=True
    )
    for old in archives[RECOVERY_KEEP_DAYS:]:
        old.unlink(missing_ok=True)


def _archive_uploads(archive: zipfile.ZipFile) -> None:
    """Archive only physical receipt files inside the configured uploads root."""
    if not UPLOAD_DIR.exists():
        return
    root = UPLOAD_DIR.resolve()
    for path in UPLOAD_DIR.rglob("*"):
        if path.is_file() and path.resolve().is_relative_to(root):
            archive.write(path, arcname=f"uploads/{path.relative_to(UPLOAD_DIR)}")


def run_recovery_backup() -> Path | None:
    """Write one verified, complete recovery archive for today.

    The archive intentionally lives outside Ledger's normal data directory.
    It includes the database, receipts and signing key, so reinstallation plus
    the restore helper can recover from deleting the whole application folder.
    """
    try:
        source_path = Path(DB_PATH)
        if not source_path.exists():
            return None
        RECOVERY_DIR.mkdir(parents=True, exist_ok=True)
        target = RECOVERY_DIR / f"{RECOVERY_ARCHIVE_PREFIX}{date.today().isoformat()}.zip"
        if target.exists():
            return None
        partial = target.with_suffix(".zip.partial")
        partial.unlink(missing_ok=True)
        snapshot = RECOVERY_DIR / f".ledger-recovery-{date.today().isoformat()}.db.partial"
        snapshot.unlink(missing_ok=True)
        try:
            if not _snapshot_database(snapshot):
                print("[ledger] recovery backup rejected: database integrity_check failed")
                return None
            with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.write(snapshot, arcname="ledger.db")
                _archive_uploads(archive)
                if SECRET_KEY_FILE.exists():
                    archive.write(SECRET_KEY_FILE, arcname="secret.key")
                archive.writestr(
                    "README.txt",
                    "Ledger full recovery archive. Reinstall Ledger, then run "
                    "setup\\Restore-LedgerBackup.ps1 with this ZIP.\n",
                )
            with zipfile.ZipFile(partial) as archive:
                if archive.testzip() is not None or "ledger.db" not in archive.namelist():
                    raise RuntimeError("archive verification failed")
            partial.replace(target)
            _prune_recovery_archives()
            return target
        finally:
            snapshot.unlink(missing_ok=True)
            partial.unlink(missing_ok=True)
    except Exception as exc:                      # pragma: no cover - defensive
        print(f"[ledger] full recovery backup failed: {exc}")
        return None


def recovery_backup_status() -> dict:
    """Return local, non-sensitive backup metadata for the owner settings UI."""
    archives = sorted(
        RECOVERY_DIR.glob(f"{RECOVERY_ARCHIVE_PREFIX}*.zip"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    ) if RECOVERY_DIR.exists() else []
    latest = archives[0] if archives else None
    return {
        "directory": str(RECOVERY_DIR),
        "retention_days": RECOVERY_KEEP_DAYS,
        "latest": {
            "name": latest.name,
            "size_bytes": latest.stat().st_size,
        } if latest else None,
    }


def configure_recovery_backup_directory(directory: str | None) -> dict:
    """Change destination only after it is writable, then make a fresh copy."""
    global RECOVERY_DIR
    RECOVERY_DIR = set_recovery_directory(directory)
    run_recovery_backup()
    return recovery_backup_status()
