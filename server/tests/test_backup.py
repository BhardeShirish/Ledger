"""The automatic backup is the last line of defence for the only copy of the
restaurant's books, so it gets its own checks."""
import sqlite3
from datetime import date
from pathlib import Path
from zipfile import ZipFile

from app import backup as backup_mod


def _make_db(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE money (id INTEGER PRIMARY KEY, paise INTEGER)")
    conn.executemany("INSERT INTO money (paise) VALUES (?)", [(1,), (2,), (3,)])
    conn.commit()
    conn.close()


def _point_at(tmp_path, monkeypatch):
    source = tmp_path / "ledger.db"
    _make_db(source)
    monkeypatch.setattr(backup_mod, "DB_PATH", source)
    monkeypatch.setattr(backup_mod, "BACKUP_DIR", tmp_path / "backups")
    return source


def test_backup_creates_a_complete_restorable_copy(tmp_path, monkeypatch):
    _point_at(tmp_path, monkeypatch)
    made = backup_mod.run_daily_backup()
    assert made is not None and made.exists()
    assert made.name == f"ledger-{date.today().isoformat()}.db"

    conn = sqlite3.connect(f"file:{made}?mode=ro", uri=True)
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert conn.execute("SELECT COUNT(*) FROM money").fetchone()[0] == 3
    conn.close()


def test_backup_runs_once_per_day(tmp_path, monkeypatch):
    _point_at(tmp_path, monkeypatch)
    assert backup_mod.run_daily_backup() is not None
    assert backup_mod.run_daily_backup() is None, "should not rewrite today's copy"


def test_backup_keeps_only_the_retention_window(tmp_path, monkeypatch):
    _point_at(tmp_path, monkeypatch)
    backups = tmp_path / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    for day in range(1, 26):            # 25 stale snapshots
        (backups / f"ledger-2020-01-{day:02d}.db").write_bytes(b"old")
    backup_mod.run_daily_backup()

    kept = sorted(backups.glob("ledger-*.db"))
    assert len(kept) == backup_mod.KEEP_DAYS
    # today's copy must survive the prune, and the newest old ones win
    assert any(k.name == f"ledger-{date.today().isoformat()}.db" for k in kept)


def test_backup_never_breaks_the_server(tmp_path, monkeypatch):
    """A failed backup must not stop the restaurant from working."""
    monkeypatch.setattr(backup_mod, "DB_PATH", tmp_path / "does-not-exist.db")
    monkeypatch.setattr(backup_mod, "BACKUP_DIR", tmp_path / "backups")
    assert backup_mod.run_daily_backup() is None


def test_partial_snapshot_is_not_left_behind(tmp_path, monkeypatch):
    _point_at(tmp_path, monkeypatch)
    backup_mod.run_daily_backup()
    assert not list((tmp_path / "backups").glob("*.partial"))


def test_recovery_backup_is_complete_and_outside_data_directory(tmp_path, monkeypatch):
    _point_at(tmp_path, monkeypatch)
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "receipt.jpg").write_bytes(b"receipt")
    secret = tmp_path / "secret.key"
    secret.write_text("stable-signing-key")
    recovery = tmp_path / "Documents" / "Ledger Backups"
    monkeypatch.setattr(backup_mod, "UPLOAD_DIR", uploads)
    monkeypatch.setattr(backup_mod, "SECRET_KEY_FILE", secret)
    monkeypatch.setattr(backup_mod, "RECOVERY_DIR", recovery)

    made = backup_mod.run_recovery_backup()

    assert made == recovery / f"ledger-recovery-{date.today().isoformat()}.zip"
    assert made.exists()
    with ZipFile(made) as archive:
        assert {"ledger.db", "uploads/receipt.jpg", "secret.key", "README.txt"} <= set(archive.namelist())
        restored = tmp_path / "restored.db"
        restored.write_bytes(archive.read("ledger.db"))
        assert archive.read("uploads/receipt.jpg") == b"receipt"
        assert archive.read("secret.key") == b"stable-signing-key"
    connection = sqlite3.connect(restored)
    assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert connection.execute("SELECT COUNT(*) FROM money").fetchone()[0] == 3
    connection.close()


def test_recovery_backup_runs_once_per_day_and_prunes_old_archives(tmp_path, monkeypatch):
    _point_at(tmp_path, monkeypatch)
    recovery = tmp_path / "Documents" / "Ledger Backups"
    recovery.mkdir(parents=True)
    monkeypatch.setattr(backup_mod, "RECOVERY_DIR", recovery)
    for day in range(1, 40):
        (recovery / f"ledger-recovery-2020-01-{day:02d}.zip").write_bytes(b"old")

    assert backup_mod.run_recovery_backup() is not None
    assert backup_mod.run_recovery_backup() is None
    archives = sorted(recovery.glob("ledger-recovery-*.zip"))
    assert len(archives) == backup_mod.RECOVERY_KEEP_DAYS
    assert Path(f"ledger-recovery-{date.today().isoformat()}.zip").name in {
        archive.name for archive in archives
    }
