"""Uploading the wrong kind of file must never be a 500.

openpyxl raises zipfile.BadZipFile for anything that is not really an .xlsx,
and the csv module refuses binary data outright. Every upload endpoint used
to let those escape as a bare "Internal server error", which told the owner
nothing about what to do.

The invariant locked in here is: whatever gets dropped on an upload button,
the server either explains the problem or reports that nothing was imported -
it never crashes, and it never quietly creates records out of garbage.
"""
import pytest

# The shapes a user actually drops on an upload button by mistake.
GARBAGE = [
    ("pdf", b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< >>\nendobj\n"),
    ("txt", b"this is just a note, not a spreadsheet"),
    ("empty", b""),
    ("png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"\x00" * 40),
    # Valid zip container, not a workbook: openpyxl gets further before
    # failing, so this exercises a different branch to the others.
    ("zip", b"PK\x03\x04" + b"\x00" * 60),
]
IDS = [label for label, _ in GARBAGE]


def assert_handled(response):
    assert response.status_code != 500, response.text
    # A 404/405 would mean the endpoint moved and this test silently stopped
    # guarding anything - exactly the trap that let the 500 survive.
    assert response.status_code not in (404, 405), \
        f"endpoint not reachable: {response.status_code} {response.text}"
    if response.status_code >= 400:
        assert response.json().get("detail"), "an error must explain itself"
    else:
        # Readable but meaningless: it must not have booked anything.
        body = response.json()
        assert body.get("created", 0) == 0, response.text
        assert body.get("rows_ok", 0) == 0 or body.get("new_rows", 0) == 0, \
            response.text


@pytest.mark.parametrize("label,payload", GARBAGE, ids=IDS)
def test_generic_import_survives_garbage(client, outlet_id, label, payload):
    assert_handled(client.post(
        f"/api/data/import/expenses?outlet_id={outlet_id}",
        files={"file": (f"thing.{label}", payload, "application/octet-stream")}))


@pytest.mark.parametrize("label,payload", GARBAGE, ids=IDS)
def test_pos_import_survives_garbage(client, outlet_id, label, payload):
    assert_handled(client.post(
        f"/api/imports/upload?outlet_id={outlet_id}",
        files={"file": (f"thing.{label}", payload, "application/octet-stream")}))


@pytest.mark.parametrize("label,payload", GARBAGE, ids=IDS)
def test_staff_import_survives_garbage(client, outlet_id, label, payload):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    assert_handled(client.post(
        f"/api/staff/import-sheet?outlet_id={outlet_id}",
        files={"file": (f"thing.{label}", payload, "application/octet-stream")}))


@pytest.mark.parametrize("label,payload", GARBAGE, ids=IDS)
def test_bank_import_survives_garbage(client, outlet_id, label, payload):
    assert_handled(client.post(
        f"/api/bank/upload?outlet_id={outlet_id}",
        files={"file": (f"thing.{label}", payload, "application/octet-stream")}))


def test_garbage_never_creates_expenses(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    for label, payload in GARBAGE:
        client.post(f"/api/data/import/expenses?outlet_id={outlet_id}",
                    files={"file": (f"thing.{label}", payload,
                                    "application/octet-stream")})
    rows = client.get(f"/api/expenses?outlet_id={outlet_id}").json()
    assert rows["total"] == 0, rows


def test_generic_import_now_accepts_a_plain_csv(client, outlet_id):
    """A CSV is what people have to hand; it should just work."""
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    cats = client.get("/api/lists/categories").json()
    csv = ("date,category,amount,mode,description\n"
           f"2099-01-05,{cats[0]['name']},250,cash,Test row\n").encode()
    r = client.post(f"/api/data/import/expenses?outlet_id={outlet_id}",
                    files={"file": ("expenses.csv", csv, "text/csv")})
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 1, r.text
