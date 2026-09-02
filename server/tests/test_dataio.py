"""Excel data-in/out: exports, templates, imports with old-data rules."""
import io
from datetime import date, timedelta

import openpyxl


def _wb_bytes(wb):
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _today():
    return date.today().isoformat()


def _old():
    return (date.today() - timedelta(days=10)).isoformat()


def test_template_has_instructions_and_example(client, owner):
    r = client.get("/api/data/template/expenses.xlsx")
    assert r.status_code == 200
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    assert "How to fill" in wb.sheetnames and "Expenses" in wb.sheetnames
    ws = wb["Expenses"]
    hdr = [c.value for c in ws[1]]
    assert "Date" in hdr and "Amount" in hdr and "Vendor" in hdr


def test_expense_roundtrip_and_old_guard(client, manager, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})

    def build(dates_modes):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Expenses"
        ws.append(["Date", "Category", "Vendor", "Mode", "Amount", "Description"])
        for d, mode in dates_modes:
            ws.append([d, "Gas Cylinder", "Roundtrip Gas", mode, 999,
                       "import check"])
        return _wb_bytes(wb)

    # manager CAN import today's rows
    x = build([(_today(), "cash")])
    r = manager.post(f"/api/data/import/expenses?outlet_id={outlet_id}",
                     files={"file": ("e.xlsx", x, "application/octet-stream")})
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 1
    retry = manager.post(
        f"/api/data/import/expenses?outlet_id={outlet_id}",
        files={"file": ("e.xlsx", x, "application/octet-stream")})
    assert retry.status_code == 200
    assert retry.json()["duplicate"] is True
    assert retry.json()["created"] == 0

    # vendor auto-created from the sheet
    vs = {v["name"]: v for v in client.get("/api/vendors").json()}
    assert "Roundtrip Gas" in vs

    # manager CANNOT import OLD rows
    x_old = build([(_old(), "upi")])
    r2 = manager.post(f"/api/data/import/expenses?outlet_id={outlet_id}",
                      files={"file": ("old.xlsx", x_old, "application/octet-stream")})
    assert r2.status_code == 403
    assert "older than the edit window" in r2.json()["detail"]

    # owner with elevation can
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    r3 = client.post(f"/api/data/import/expenses?outlet_id={outlet_id}",
                     files={"file": ("old.xlsx", x_old, "application/octet-stream")})
    assert r3.status_code == 200 and r3.json()["created"] == 1


def test_credit_expense_import_creates_vendor_liability(client, outlet_id):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Expenses"
    ws.append(["Date", "Category", "Vendor", "Mode", "Amount", "Description"])
    ws.append([_today(), "Gas Cylinder", "Credit Import Vendor", "credit",
               1250, "on account"])
    response = client.post(
        f"/api/data/import/expenses?outlet_id={outlet_id}",
        files={"file": ("credit.xlsx", _wb_bytes(wb),
                        "application/octet-stream")})
    assert response.status_code == 200, response.text
    vendor = next(
        row for row in client.get("/api/vendors").json()
        if row["name"] == "Credit Import Vendor"
    )
    ledger = client.get(f"/api/vendors/{vendor['id']}/ledger").json()
    assert ledger["vendor"]["balance_rupees"] == 1250


def test_attendance_import_creates_rows(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    shifts = client.get("/api/staff/shifts").json()
    emp = client.post("/api/staff/employees", json={
        "name": "Sheet Staff", "code": "SS1", "outlet_id": outlet_id,
        "monthly_salary_rupees": 12000,
        "default_shift_id": shifts[0]["id"]}).json()
    target = emp
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Attendance"
    ws.append(["Date", "Employee Code", "Employee Name", "Status",
               "In (HH:MM)", "Out (HH:MM)", "Double Duty", "Note"])
    ws.append([_today(), target["code"], "", "P", "07:10", "17:00", "Y",
               "sheet check"])
    x = _wb_bytes(wb)
    r = client.post(f"/api/data/import/attendance?outlet_id={outlet_id}",
                    files={"file": ("a.xlsx", x, "application/octet-stream")})
    assert r.status_code == 200, r.text
    grid = client.get("/api/attendance/grid", params={
        "outlet_id": outlet_id, "start": _today(), "end": _today()}).json()
    row = grid["employees"][0]["cells"][0]["row"]
    assert row is not None and row["status"] == "P"
    assert row["double_duty"] is True
    assert row["ot_min"] > 0          # out at 16:05 past shift end + grace


def test_sensitive_exports_owner_only(client, manager, outlet_id):
    for entity in ("employees", "advances"):
        r = manager.get(f"/api/data/export/{entity}.xlsx",
                        params={"outlet_id": outlet_id})
        assert r.status_code == 403, r.text
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    ok = client.get(f"/api/data/export/{entity}.xlsx",
                    params={"outlet_id": outlet_id})
    assert ok.status_code == 200


def test_sales_manual_import_upserts(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sales"
    ws.append(["Date", "Cash", "UPI", "Card", "Other"])
    d = date.today() - timedelta(days=2)   # old on purpose → owner path
    ws.append([d.isoformat(), 1200, 3400, 0, 0])
    x = _wb_bytes(wb)
    r = client.post(f"/api/data/import/sales_manual?outlet_id={outlet_id}",
                    files={"file": ("s.xlsx", x, "application/octet-stream")})
    assert r.status_code == 200
    retry = client.post(f"/api/data/import/sales_manual?outlet_id={outlet_id}",
                        files={"file": ("s.xlsx", x, "application/octet-stream")})
    assert retry.json()["duplicate"] is True
    day = client.get("/api/cash/day", params={
        "outlet_id": outlet_id, "date": d.isoformat()}).json()
    assert day["cash_sales_paise"] == 120_000
