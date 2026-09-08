"""The launcher must never start a second, empty ledger from a setup folder.

Extracting a package leaves Start-Ledger.cmd sitting in the download
folder. Run from there it used to find no database, invent a random owner
password and serve an empty ledger on the same port - which looks exactly
like "my password changed and all my data is gone".
"""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
POWERSHELL = shutil.which("powershell") or shutil.which("pwsh")

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or POWERSHELL is None,
    reason="the launcher is a Windows PowerShell script",
)

# The guard recognises a setup folder by the installer sitting beside it.
# Renaming either file without updating start.ps1/stop.ps1 would silently
# disable the protection, so pin the names here too.
INSTALLER_NAMES = ("Install-Ledger.cmd",)


def test_the_installer_names_the_guard_looks_for_still_exist():
    for name in INSTALLER_NAMES:
        assert (REPO / "setup" / name).is_file(), (
            f"{name} was renamed or removed; start.ps1 and stop.ps1 use it to "
            f"tell a setup folder from an installed Ledger."
        )
    for script in ("start.ps1", "stop.ps1"):
        text = (REPO / script).read_text(encoding="utf-8")
        for name in INSTALLER_NAMES:
            assert name in text, f"{script} no longer guards against {name}"


def _extracted_package(tmp_path: Path, installer: str) -> Path:
    """Mimic a ZIP the owner just extracted: installer beside a Ledger folder."""
    app = tmp_path / "Ledger"
    (app / "server" / "data").mkdir(parents=True)
    for script in ("start.ps1", "stop.ps1"):
        shutil.copy(REPO / script, app / script)
    (tmp_path / installer).write_text("rem installer", encoding="utf-8")
    return app


@pytest.mark.parametrize("installer", INSTALLER_NAMES)
def test_start_refuses_to_run_from_an_extracted_package(tmp_path, installer):
    app = _extracted_package(tmp_path, installer)

    r = subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass",
         "-File", str(app / "start.ps1"), "-NoBrowser"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=180)

    assert r.returncode != 0, "the setup folder must not report a healthy start"
    assert "setup folder" in r.stdout.lower(), r.stdout
    assert not (app / "server" / "data" / "ledger.db").exists(), (
        "a second, empty ledger was created in the setup folder")


def test_stop_refuses_to_run_from_an_extracted_package(tmp_path):
    app = _extracted_package(tmp_path, "Install-Ledger.cmd")

    r = subprocess.run(
        [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass",
         "-File", str(app / "stop.ps1")],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=120)

    assert "setup folder" in r.stdout.lower(), r.stdout
