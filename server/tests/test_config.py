import pytest

from app.config import read_env_or_file


def test_read_env_or_file_prefers_direct_value(monkeypatch, tmp_path):
    secret_file = tmp_path / "secret"
    secret_file.write_text("from-file", encoding="utf-8")
    monkeypatch.setenv("TEST_SECRET", "from-env")
    monkeypatch.setenv("TEST_SECRET_FILE", str(secret_file))
    assert read_env_or_file("TEST_SECRET") == "from-env"


def test_read_env_or_file_reads_secret_file(monkeypatch, tmp_path):
    secret_file = tmp_path / "secret"
    secret_file.write_text("  from-file\n", encoding="utf-8")
    monkeypatch.delenv("TEST_SECRET", raising=False)
    monkeypatch.setenv("TEST_SECRET_FILE", str(secret_file))
    assert read_env_or_file("TEST_SECRET") == "from-file"


def test_read_env_or_file_surfaces_missing_file(monkeypatch, tmp_path):
    monkeypatch.delenv("TEST_SECRET", raising=False)
    monkeypatch.setenv("TEST_SECRET_FILE", str(tmp_path / "missing"))
    with pytest.raises(RuntimeError, match="TEST_SECRET_FILE"):
        read_env_or_file("TEST_SECRET")
