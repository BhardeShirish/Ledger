"""The web bundle must not become a file server for the data folder.

`server/data` sits two levels above the built bundle and holds the ledger
database and the token-signing key, so a '..' in the URL used to hand both
out to anyone who asked, with no login at all.
"""
import importlib
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def spa_client(tmp_path, monkeypatch):
    """A server serving a real (tiny) web bundle, with a secret next door."""
    dist = tmp_path / "web" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Ledger</title>",
                                     encoding="utf-8")
    (dist / "assets" / "app-abc123.js").write_text("console.log(1)", encoding="utf-8")

    secrets = tmp_path / "server" / "data"
    secrets.mkdir(parents=True)
    (secrets / "secret.key").write_text("ledger-TOP-SECRET-KEY", encoding="utf-8")
    (secrets / "ledger.db").write_bytes(b"SQLite format 3\x00pretend-database")

    monkeypatch.setenv("LEDGER_WEB_DIST", str(dist))
    import app.main as main
    importlib.reload(main)
    try:
        with TestClient(main.app) as client:
            yield client, main, dist
    finally:
        # Leave the module as the rest of the suite expects to find it.
        monkeypatch.delenv("LEDGER_WEB_DIST", raising=False)
        importlib.reload(main)


ESCAPES = [
    "./../../server/data/secret.key",
    "./../../server/data/ledger.db",
    "../../server/data/secret.key",
    "assets/../../../server/data/secret.key",
    "./../../../etc/passwd",
]


@pytest.mark.parametrize("path", ESCAPES)
def test_dotdot_cannot_read_outside_the_web_bundle(spa_client, path):
    """Call the handler directly: an HTTP client collapses '..' on the way out,
    which would make this test pass even with the guard removed. A hostile
    client does not have to be so polite."""
    _, main, dist = spa_client
    response = main.spa(path)

    served = Path(response.path).resolve()
    assert served == (dist / "index.html").resolve(), (
        f"{path} escaped the bundle and served {served}")


@pytest.mark.parametrize("path", ESCAPES)
def test_dotdot_over_real_http_is_also_safe(spa_client, path):
    client, _, _ = spa_client
    body = client.get("/" + path).content
    assert b"TOP-SECRET-KEY" not in body, f"{path} leaked the signing key"
    assert not body.startswith(b"SQLite format 3"), f"{path} leaked the database"


def test_real_bundle_files_are_still_served(spa_client):
    client, _, _ = spa_client
    r = client.get("/assets/app-abc123.js")
    assert r.status_code == 200
    assert "console.log(1)" in r.text


def test_index_is_never_cached(spa_client):
    """A cached index.html asks for chunk names that an update deleted, which
    shows the owner a blank screen until they hard-refresh."""
    client, _, _ = spa_client
    cache = client.get("/").headers.get("cache-control", "")
    assert "no-store" in cache.lower(), f"index.html cache-control was {cache!r}"


def test_unknown_api_paths_still_fail_as_api(spa_client):
    client, _, _ = spa_client
    r = client.get("/api/definitely-not-a-route")
    assert r.status_code == 404
    assert r.json()["detail"] == "Not found"
