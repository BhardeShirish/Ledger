"""The launcher's address handling.

The installer registers a scheduled task with --host/--port, and a task does
not see environment variables set after logon. If this parsing breaks, Ledger
silently starts on the wrong port and looks dead.
"""
import importlib.util
import sys
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "run_ledger", Path(__file__).resolve().parents[2] / "run_ledger.py")
run_ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_ledger)


def test_defaults_to_loopback_on_8080():
    assert run_ledger.resolve_binding(["run_ledger.py"], {}) == ("127.0.0.1", 8080)


def test_environment_is_used_when_there_are_no_arguments():
    binding = run_ledger.resolve_binding(
        ["run_ledger.py"], {"LEDGER_HOST": "0.0.0.0", "LEDGER_PORT": "9000"})
    assert binding == ("0.0.0.0", 9000)


def test_arguments_beat_the_environment():
    binding = run_ledger.resolve_binding(
        ["run_ledger.py", "--host", "0.0.0.0", "--port", "8095"],
        {"LEDGER_HOST": "127.0.0.1", "LEDGER_PORT": "8080"})
    assert binding == ("0.0.0.0", 8095)


def test_a_flag_with_no_value_falls_back_instead_of_crashing():
    assert run_ledger.resolve_binding(["run_ledger.py", "--port"], {}) == ("127.0.0.1", 8080)


def test_a_blank_host_still_means_loopback():
    assert run_ledger.resolve_binding(["run_ledger.py"], {"LEDGER_HOST": "  "})[0] == "127.0.0.1"


def test_a_port_that_is_not_a_number_says_so_plainly():
    with pytest.raises(SystemExit) as failure:
        run_ledger.resolve_binding(["run_ledger.py", "--port", "eight"], {})
    assert "number" in str(failure.value)
