import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("LEDGER_DATA_DIR", "./data"))
UPLOAD_DIR = DATA_DIR / "uploads"
BACKUP_DIR = DATA_DIR / "backups"
DB_PATH = DATA_DIR / "ledger.db"

SECRET_KEY_FILE = DATA_DIR / "secret.key"
TOKEN_TTL_HOURS = 24 * 30      # 30 days; a year with "keep me signed in"
REMEMBER_TTL_DAYS = 365
STEPUP_TTL_MINUTES = 60


def read_env_or_file(name: str, default: str = "") -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    path = os.environ.get(f"{name}_FILE", "").strip()
    if not path:
        return default
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise RuntimeError(f"Cannot read {name}_FILE: {path}") from exc


def _load_secret() -> str:
    """Stable across restarts — a rotating key logs everyone out."""
    env = read_env_or_file("LEDGER_SECRET_KEY")
    if env and env != "please-generate-a-long-random-string":
        return env
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if SECRET_KEY_FILE.exists():
        key = SECRET_KEY_FILE.read_text(encoding="utf-8").strip()
        if key:
            return key
        raise RuntimeError(f"Ledger secret file is empty: {SECRET_KEY_FILE}")
    import secrets as _s
    key = _s.token_urlsafe(48)
    try:
        SECRET_KEY_FILE.write_text(key, encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(
            "Cannot persist LEDGER_SECRET_KEY. Set the environment variable "
            "or make LEDGER_DATA_DIR writable."
        ) from exc
    return key


SECRET_KEY = _load_secret()

TZ_NAME = "Asia/Kolkata"

DEFAULT_EDIT_CUTOFF_HOURS = 48
DEFAULT_VARIANCE_ALERT_PAISE = 20_000  # ₹200

MAX_FAILED_LOGINS = 5
LOCKOUT_MINUTES = 10


def ensure_dirs() -> None:
    for d in (DATA_DIR, UPLOAD_DIR, BACKUP_DIR):
        d.mkdir(parents=True, exist_ok=True)
