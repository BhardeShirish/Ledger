"""Entry point for the standalone Windows build.

Everything the app needs is inside the .exe: the Python runtime, the API and
the built web pages. The person running it installs nothing.

Two things must be true before the app is imported, which is why this file
exists at all:

  * app/config.py reads LEDGER_DATA_DIR at import time, so the data directory
    has to be chosen first. It must never be the PyInstaller unpack folder -
    that lives in %TEMP% and is deleted when the program exits, which would
    silently destroy the ledger.
  * first run refuses to start without an owner password, so we ask for one
    here rather than showing a stack trace.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import webbrowser
from getpass import getpass
from pathlib import Path

APP_NAME = "OotaaLedger"
MIN_PASSWORD = 12


def bundle_dir() -> Path:
    """Read-only folder holding the bundled files (temporary when frozen)."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent.parent


def data_dir() -> Path:
    """Where the ledger lives. Survives upgrades and needs no admin rights."""
    override = os.environ.get("LEDGER_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(base) / APP_NAME / "data"


def read_secret(prompt: str) -> str:
    """Read a password, hiding it when there is a keyboard to hide it from.

    On Windows getpass reads the console handle directly and ignores a piped
    stdin, so it would wait forever for a keypress that is never coming.
    Anything other than a real terminal therefore falls back to input().
    """
    if sys.stdin is None or not sys.stdin.isatty():
        return input(prompt)
    return getpass(prompt)


def ask_for_password() -> str:
    """First run only: create the owner login."""
    print()
    print("  Welcome to Ootaa Ledger.")
    print("  Choose the owner password. You will need it every time you sign")
    print(f"  in, so write it down somewhere safe. Minimum {MIN_PASSWORD} characters.")
    print("  Nothing appears as you type - that is normal.")
    print(flush=True)
    while True:
        first = read_secret("  New owner password: ")
        if len(first) < MIN_PASSWORD:
            print(f"  Too short - use at least {MIN_PASSWORD} characters.\n", flush=True)
            continue
        if first == "change-me-please":
            print("  Please pick something of your own.\n", flush=True)
            continue
        if read_secret("  Type it again: ") != first:
            print("  Those did not match. Try again.\n", flush=True)
            continue
        print("\n  Thank you. Setting up your ledger...\n", flush=True)
        return first


def open_browser_when_ready(url: str, health: str) -> None:
    """Only open the browser once the server actually answers.

    Opening it immediately shows the owner a connection error on the very
    first screen they ever see of this program.
    """
    import urllib.error
    import urllib.request

    for _ in range(120):
        try:
            with urllib.request.urlopen(health, timeout=1) as r:
                if r.status == 200:
                    webbrowser.open(url)
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.5)


def main() -> int:
    bundle = bundle_dir()
    data = data_dir()
    data.mkdir(parents=True, exist_ok=True)

    os.environ["LEDGER_DATA_DIR"] = str(data)
    os.environ["LEDGER_WEB_DIST"] = str(bundle / "web" / "dist")
    sys.path.insert(0, str(bundle / "server"))

    first_run = not (data / "ledger.db").exists()
    if first_run and not os.environ.get("LEDGER_OWNER_PASSWORD"):
        os.environ["LEDGER_OWNER_PASSWORD"] = ask_for_password()

    host = os.environ.get("LEDGER_HOST", "127.0.0.1").strip() or "127.0.0.1"
    try:
        port = int(os.environ.get("LEDGER_PORT", "8080"))
    except ValueError:
        print("LEDGER_PORT must be a number, for example 8080")
        return 2

    url = f"http://localhost:{port}"
    print(f"  Ootaa Ledger is starting -> {url}")
    print(f"  Your records: {data}")
    if host not in ("127.0.0.1", "localhost", "::1"):
        print(f"  Listening on {host}: other devices on this network can reach it.")
    print("  Close this window to stop Ledger.\n", flush=True)

    threading.Thread(target=open_browser_when_ready,
                     args=(url, f"{url}/api/health"), daemon=True).start()

    import uvicorn
    from app.main import app  # imported last: needs the env vars set above

    try:
        uvicorn.run(app, host=host, port=port, log_level="warning")
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
