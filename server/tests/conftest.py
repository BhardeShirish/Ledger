import os
import shutil
from pathlib import Path

# Run tests against a throwaway data dir, wiped fresh every session. Under
# xdist each worker gets its own, or they would fight over one SQLite file.
_worker = os.environ.get("PYTEST_XDIST_WORKER", "")
_tmp = Path(__file__).parent / (f".tmpdata{_worker}" if _worker else ".tmpdata")
shutil.rmtree(_tmp, ignore_errors=True)
os.environ["LEDGER_DATA_DIR"] = str(_tmp)
os.environ["LEDGER_SECRET_KEY"] = "x" * 40  # silence the short-key warning
os.environ["LEDGER_OWNER_PASSWORD"] = "change-me-please"
os.environ["LEDGER_TESTING"] = "1"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client():
    engine.dispose()
    shutil.rmtree(_tmp, ignore_errors=True)
    with TestClient(app) as c:
        login(c, "owner", "change-me-please")
        yield c
    engine.dispose()


def login(c, username, password):
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    token = r.json()["token"]
    c.headers.update({"Authorization": f"Bearer {token}"})
    return r.json()["user"]


@pytest.fixture()
def owner(client):
    return client.get("/api/auth/me").json()


@pytest.fixture()
def manager(client, owner):
    # create manager scoped to outlet 1
    r = client.post("/api/users", json={
        "username": "mani", "full_name": "Mani Manager",
        "password": "manager-pass-1", "role": "manager", "outlet_ids": [1]})
    if r.status_code == 409:
        pass
    c2 = TestClient(app)
    login(c2, "mani", "manager-pass-1")
    return c2


@pytest.fixture()
def outlet_id(client, owner):
    rows = client.get("/api/outlets").json()
    assert rows, "no outlets seeded"
    return rows[0]["id"]


@pytest.fixture()
def fresh_owner(client):
    """A client with elevation explicitly cleared — for gating tests."""
    c = TestClient(app)
    login(c, "owner", "change-me-please")
    c.post("/api/auth/stepdown")
    return c
