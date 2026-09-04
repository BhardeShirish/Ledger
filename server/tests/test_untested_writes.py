"""The write endpoints no test had ever pressed.

Every one of these sits behind a button someone taps in Settings or Payroll.
An untested write is where the "+ New category" class of bug hides: the
button looks right, the request goes out, and something quietly wrong
happens on the way back.
"""
from app.db import SessionLocal
from app.models import Payslip, PayrollRun, SalesChannel


def stepup(client):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})


# ── sales channels ──────────────────────────────────────────────────────────

def _sorts():
    with SessionLocal() as db:
        return {c.name: c.sort for c in db.query(SalesChannel).all()}


def test_a_sales_channel_can_be_added_renamed_and_removed(client):
    stepup(client)
    made = client.post("/api/sales/channels",
                       json={"name": "Zomato", "kind": "aggregator"})
    assert made.status_code == 201, made.text
    cid = made.json()["id"]

    renamed = client.patch(f"/api/sales/channels/{cid}",
                           json={"name": "Zomato Gold", "kind": "aggregator"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Zomato Gold"

    assert client.delete(f"/api/sales/channels/{cid}").status_code == 200
    names = [c["name"] for c in client.get("/api/sales/channels").json()]
    assert "Zomato Gold" not in names


def test_renaming_a_channel_leaves_it_where_it_was(client):
    """The sales sheet is ordered by `sort`, and the rename screen never sends
    one. If the handler writes the default anyway, renaming a channel makes it
    jump rows on the till screen."""
    stepup(client)
    before = _sorts()
    row = client.get("/api/sales/channels").json()[0]

    r = client.patch(f"/api/sales/channels/{row['id']}",
                     json={"name": row["name"] + " ", "kind": row["kind"]})
    assert r.status_code == 200, r.text

    after = _sorts()
    assert after[row["name"]] == before[row["name"]], (
        "renaming moved the channel: sort went "
        f"{before[row['name']]} -> {after[row['name']]}")


def test_a_channel_needs_a_real_name_and_kind(client):
    stepup(client)
    assert client.post("/api/sales/channels",
                       json={"name": "  ", "kind": "aggregator"}).status_code == 422
    assert client.post("/api/sales/channels",
                       json={"name": "Ok", "kind": "moonbeams"}).status_code == 422


# ── profile and password ────────────────────────────────────────────────────

def test_the_owner_can_rename_themselves(client):
    r = client.patch("/api/auth/profile", json={"full_name": "  Ravi Kumar  "})
    assert r.status_code == 200, r.text
    assert r.json()["full_name"] == "Ravi Kumar"
    assert client.get("/api/auth/me").json()["full_name"] == "Ravi Kumar"


def test_changing_the_password_checks_the_old_one(client):
    wrong = client.post("/api/auth/change-password",
                        json={"old_password": "not-it", "new_password": "brand-new-pass"})
    assert wrong.status_code == 401

    short = client.post("/api/auth/change-password",
                        json={"old_password": "change-me-please", "new_password": "abc"})
    assert short.status_code == 422

    ok = client.post("/api/auth/change-password",
                     json={"old_password": "change-me-please",
                           "new_password": "brand-new-pass"})
    assert ok.status_code == 200, ok.text
    assert client.post("/api/auth/login",
                       json={"username": "owner", "password": "brand-new-pass"}
                       ).status_code == 200
    assert client.post("/api/auth/login",
                       json={"username": "owner", "password": "change-me-please"}
                       ).status_code == 401


# ── salary divisor ──────────────────────────────────────────────────────────

def test_the_salary_divisor_can_be_set_and_pushed_to_everyone(client, outlet_id):
    stepup(client)
    emp = client.post("/api/staff/employees", json={
        "name": "Divisor Person", "code": "DV1", "outlet_id": outlet_id,
        "monthly_salary_rupees": 26000}).json()

    assert client.post("/api/staff/set-divisor",
                       json={"divisor": 0, "apply_to_all": False}).status_code == 422
    assert client.post("/api/staff/set-divisor",
                       json={"divisor": 99, "apply_to_all": False}).status_code == 422

    r = client.post("/api/staff/set-divisor", json={"divisor": 30, "apply_to_all": True})
    assert r.status_code == 200, r.text
    assert r.json()["employees_updated"] >= 1

    rows = client.get(f"/api/staff/employees?outlet_id={outlet_id}").json()
    mine = next(e for e in (rows["employees"] if isinstance(rows, dict) else rows) if e["id"] == emp["id"])
    assert mine["divisor"] == 30


# ── settings in bulk ────────────────────────────────────────────────────────

def test_settings_save_together_and_refuse_unknown_keys(client):
    stepup(client)
    r = client.put("/api/admin/settings/bulk",
                   json={"values": {"edit_cutoff_hours": 168}})
    assert r.status_code == 200, r.text
    assert int(client.get("/api/admin/settings").json()["edit_cutoff_hours"]) == 168

    bad = client.put("/api/admin/settings/bulk",
                     json={"values": {"drop_all_tables": 1}})
    assert bad.status_code == 422
    assert int(client.get("/api/admin/settings").json()["edit_cutoff_hours"]) == 168, (
        "a rejected key must not half-apply the batch")


# ── payslip adjustments and payment ─────────────────────────────────────────

def _slip(outlet_id):
    with SessionLocal() as db:
        run = PayrollRun(outlet_id=outlet_id, year=2026, month=9, status="draft")
        db.add(run)
        db.flush()
        emp = client_employee(db, outlet_id)
        slip = Payslip(run_id=run.id, employee_id=emp, monthly_salary_paise=2600000,
                       net_paise=2600000, paid_paise=0)
        db.add(slip)
        db.commit()
        return slip.id


def client_employee(db, outlet_id):
    from app.models import Employee
    e = Employee(name="Slip Person", outlet_id=outlet_id,
                 monthly_salary_paise=2600000, divisor=26)
    db.add(e)
    db.flush()
    return e.id


def test_a_payslip_can_be_adjusted_and_the_adjustment_undone(client, outlet_id):
    stepup(client)
    slip_id = _slip(outlet_id)

    add = client.post(f"/api/payroll/payslips/{slip_id}/adjust",
                      json={"kind": "bonus_amt", "amount_rupees": 500,
                            "reason": "festival"})
    assert add.status_code in (200, 201), add.text

    detail = client.get(f"/api/payroll/runs/{_run_of(slip_id)}").json()
    slip = next(s for s in detail["payslips"] if s["id"] == slip_id)
    assert slip["adjustments"], "the adjustment never came back with the payslip"
    adj_id = slip["adjustments"][0]["id"]

    gone = client.delete(f"/api/payroll/adjustments/{adj_id}")
    assert gone.status_code == 200, gone.text
    detail = client.get(f"/api/payroll/runs/{_run_of(slip_id)}").json()
    slip = next(s for s in detail["payslips"] if s["id"] == slip_id)
    assert not slip["adjustments"]


def test_marking_a_payslip_paid_defaults_to_upi(client, outlet_id):
    stepup(client)
    slip_id = _slip(outlet_id)
    run_id = _run_of(slip_id)

    early = client.post(f"/api/payroll/payslips/{slip_id}/paid", json={})
    assert early.status_code == 409, "a draft month must not be payable"

    assert client.post(f"/api/payroll/runs/{run_id}/finalize").status_code == 200
    r = client.post(f"/api/payroll/payslips/{slip_id}/paid", json={})
    assert r.status_code == 200, r.text
    with SessionLocal() as db:
        assert db.get(Payslip, slip_id).mode == "upi"


def _run_of(slip_id):
    with SessionLocal() as db:
        return db.get(Payslip, slip_id).run_id


# ── uploads ─────────────────────────────────────────────────────────────────

def test_a_receipt_photo_can_be_uploaded_and_read_back(client):
    png = (b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
    r = client.post("/api/uploads", files={"file": ("bill.png", png, "image/png")})
    assert r.status_code in (200, 201), r.text
    path = r.json().get("path") or r.json().get("filename")
    assert path, f"upload returned nothing usable: {r.json()}"

    back = client.get(f"/api/files/{path.split('/')[-1]}")
    assert back.status_code == 200, "the uploaded receipt cannot be fetched back"
