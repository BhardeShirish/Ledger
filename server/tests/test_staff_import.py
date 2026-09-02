"""Sheet import + KYC document security."""
import io

import openpyxl


def mini_sheet():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Emp Id", "Employee Name", "Phone No", "Working Status",
               "Off Day (preffered)", "Off Day", "Backup", "Designation",
               "Monthly Salary", "Per Day"])
    ws.append([1, "Amit", 9876543210.0, "Yes", "Tuesday", "Tuesday", "Bhavna", "Chef", 20000])
    ws.append([2, "Bhavna", None, "Yes", "Monday", "Monday", "Amit", "Steward", 12000])
    ws.append([3, "Chotu", None, "No", None, None, None, "Helper", 9000])
    ws.append([None, None])                      # blank spacer
    ws.append([None, "Total Salary", 295000])    # summary junk row
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_import_creates_and_links(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    preview = client.post("/api/staff/import-sheet",
                    params={"outlet_id": outlet_id},
                    files={"file": ("e.xlsx", mini_sheet(), "application/octet-stream")})
    assert preview.status_code == 200
    assert preview.json()["committed"] is False
    assert preview.json()["created"] == 3
    before_names = {
        employee["name"] for employee in client.get(
            "/api/staff/employees",
            params={"outlet_id": outlet_id, "include_inactive": True},
        ).json()
    }
    assert not {"Amit", "Bhavna", "Chotu"} & before_names
    r = client.post("/api/staff/import-sheet",
                    params={"outlet_id": outlet_id, "confirm": True},
                    files={"file": ("e.xlsx", mini_sheet(), "application/octet-stream")})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["created"] == 3 and d["errors"] == []
    emps = {e["name"]: e for e in client.get(
        "/api/staff/employees", params={"include_inactive": True}).json()}
    assert emps["Amit"]["phone"] == "9876543210"
    assert emps["Amit"]["monthly_salary_rupees"] == 20000
    assert emps["Amit"]["off_dow"] == 1            # Tuesday
    assert emps["Amit"]["backup_employee_id"] == emps["Bhavna"]["id"]
    assert emps["Chotu"]["working_status"] == "left"
    # re-import updates instead of duplicating
    r2 = client.post("/api/staff/import-sheet",
                     params={"outlet_id": outlet_id, "confirm": True},
                     files={"file": ("e.xlsx", mini_sheet(), "application/octet-stream")})
    assert r2.json()["created"] == 0 and r2.json()["updated"] == 3


PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def test_kyc_docs_owner_only(client, manager, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    e = client.post("/api/staff/employees", json={
        "name": "Doc Guy", "outlet_id": outlet_id,
        "monthly_salary_rupees": 10000}).json()
    up = client.post(f"/api/staff/employees/{e['id']}/doc/aadhaar",
                     files={"file": ("a.png", PNG, "image/png")})
    assert up.status_code == 200
    path = up.json()["path"]

    # owner sees number field + can fetch the image
    detail = client.get(f"/api/staff/employees/{e['id']}").json()
    assert detail["aadhaar_doc_path"] == path
    img = client.get(path)
    assert img.status_code == 200 and img.content.startswith(b"\x89PNG")

    # manager gets NO kyc keys and CANNOT fetch the image
    m = manager.get(f"/api/staff/employees/{e['id']}").json()
    assert "aadhaar_no" not in m and "aadhaar_doc_path" not in m
    blocked = manager.get(path)
    assert blocked.status_code == 403
    up2 = manager.post(f"/api/staff/employees/{e['id']}/doc/pan",
                       files={"file": ("p.png", PNG, "image/png")})
    assert up2.status_code == 403


def test_manager_cannot_import_sheet(manager):
    r = manager.post("/api/staff/import-sheet",
                     params={"outlet_id": 1},
                     files={"file": ("e.xlsx", mini_sheet(), "application/octet-stream")})
    assert r.status_code == 403
