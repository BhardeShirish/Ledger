"""Forgotten-password recovery, and the ways it must refuse to help.

The security property under test is narrow and worth stating: a stranger
who can reach the login page must gain nothing, and someone who can read
the Ledger PC's data folder must be able to get back in. Everything below
is one of those two sentences.
"""
from fastapi.testclient import TestClient

from app.main import app
from app.password_reset import forget_all, reset_file
from tests.conftest import login


def ask(c, username="owner"):
    forget_all()
    r = c.post("/api/auth/forgot", json={"username": username})
    assert r.status_code == 200, r.text
    return r.json()


def code_from_disk() -> str:
    text = reset_file().read_text(encoding="utf-8")
    line = next(l for l in text.splitlines() if l.startswith("Code:"))
    return line.split(":", 1)[1].strip()


def test_the_code_never_travels_over_the_network(client):
    body = ask(client)

    assert "code" not in str(body).lower() or body.get("code") is None
    written = code_from_disk()
    assert written and written not in str(body)
    assert body["file"].endswith("password-reset.txt")


def test_reading_the_file_gets_you_back_in(client):
    ask(client)
    r = client.post("/api/auth/reset", json={
        "username": "owner", "code": code_from_disk(),
        "new_password": "a-brand-new-password"})
    assert r.status_code == 200, r.text
    assert not reset_file().exists()

    fresh = TestClient(app)
    assert fresh.post("/api/auth/login", json={
        "username": "owner", "password": "a-brand-new-password"}).status_code == 200
    assert fresh.post("/api/auth/login", json={
        "username": "owner", "password": "change-me-please"}).status_code == 401


def test_reset_clears_a_lockout(client):
    stranger = TestClient(app)
    for _ in range(6):
        stranger.post("/api/auth/login",
                      json={"username": "owner", "password": "wrong-one"})
    assert stranger.post("/api/auth/login", json={
        "username": "owner", "password": "change-me-please"}).status_code == 423

    ask(client)
    assert client.post("/api/auth/reset", json={
        "username": "owner", "code": code_from_disk(),
        "new_password": "unlocked-again-now"}).status_code == 200
    assert stranger.post("/api/auth/login", json={
        "username": "owner", "password": "unlocked-again-now"}).status_code == 200


def test_guessing_the_code_is_not_worth_trying(client):
    ask(client)
    real = code_from_disk()
    for _ in range(6):
        r = client.post("/api/auth/reset", json={
            "username": "owner", "code": "AAAA-BBBB-CCCC",
            "new_password": "some-long-password"})
        assert r.status_code == 401
    # The real code has been thrown away along with the guesses.
    assert client.post("/api/auth/reset", json={
        "username": "owner", "code": real,
        "new_password": "some-long-password"}).status_code == 401


def test_a_short_password_does_not_spend_the_code(client):
    ask(client)
    real = code_from_disk()
    assert client.post("/api/auth/reset", json={
        "username": "owner", "code": real, "new_password": "short"}
    ).status_code == 422
    assert client.post("/api/auth/reset", json={
        "username": "owner", "code": real,
        "new_password": "now-a-proper-one"}).status_code == 200


def test_an_unknown_account_looks_exactly_like_a_real_one(client):
    real = ask(client, "owner")
    invented = ask(client, "not-a-real-user")
    assert real["file"] == invented["file"]
    assert real.keys() == invented.keys()
    # ...but the code it wrote unlocks nothing.
    assert client.post("/api/auth/reset", json={
        "username": "not-a-real-user", "code": code_from_disk(),
        "new_password": "some-long-password"}).status_code == 401


def test_a_code_for_one_account_does_not_open_another(client):
    client.post("/api/users", json={
        "username": "mani", "full_name": "Mani", "password": "manager-pass-1",
        "role": "manager", "outlet_ids": [1]})
    ask(client, "mani")
    assert client.post("/api/auth/reset", json={
        "username": "owner", "code": code_from_disk(),
        "new_password": "some-long-password"}).status_code == 401


def test_reset_signs_the_old_sessions_out(client):
    other = TestClient(app)
    login(other, "owner", "change-me-please")
    assert other.get("/api/auth/me").status_code == 200

    ask(client)
    assert client.post("/api/auth/reset", json={
        "username": "owner", "code": code_from_disk(),
        "new_password": "yet-another-password"}).status_code == 200
    assert other.get("/api/auth/me").status_code == 401
