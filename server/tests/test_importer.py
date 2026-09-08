"""Importer: build a synthetic Petpooja Orders Master Report and parse/commit it."""
import io

import openpyxl

HEADERS = ["Invoice No.", "Date", "Biller", "KOT No.", "Payment Type",
           "Payment Description", "Order Type", "Status", "Area",
           "Sub Order Type", "Group Name", "Brand Name", "GSTIN", "Assign To",
           "Phone", "Name", "Address", "Locality", "Persons",
           "Order Cancel Reason", "My Amount (₹)", "Discount (₹)",
           "Net Sales (₹)(M.A - D)", "Delivery Charge", "Container Charge",
           "Service Charge", "Additional Charge", "Deduction Charge",
           "Total Tax (₹)", "Round Off", "Waived off", "Total (₹)",
           "Online Tax Calculated", "GST Paid by Merchant",
           "GST Paid by Ecommerce", "Tip (₹)", "Non Taxable",
           "Amount (CGST@2.5)", "CGST@2.5", "Amount (SGST@2.5)", "SGST@2.5",
           "Amount (CGST@9)", "CGST@9", "Amount (SGST@9)", "SGST@9",
           "Amount (Unknown Tax)", "Unknown Tax"]

META = [("Date:", "2026-04-01 to 2026-08-25"), ("Name:", "Orders: Master Report"),
        ("Restaurant Name:", "Sample Kitchen")]


def bill_row(inv, ts, pay, status="Success", my=100.0, disc=0.0, net=None,
             tax=5.0, ro=0.0, tip=0.0, total=None, persons=2):
    net = my - disc if net is None else net
    total = net + tax + ro + tip if total is None else total
    row = [None] * len(HEADERS)
    vals = {"Invoice No.": inv, "Date": ts, "Biller": "biller", "KOT No.": str(inv),
            "Payment Type": pay, "Payment Description": "", "Order Type": "Dine In",
            "Status": status, "Area": "Dining", "Sub Order Type": "Dining",
            "My Amount (₹)": my, "Discount (₹)": disc,
            "Net Sales (₹)(M.A - D)": net, "Delivery Charge": 0,
            "Container Charge": 0, "Service Charge": 0, "Additional Charge": 0,
            "Deduction Charge": 0, "Total Tax (₹)": tax, "Round Off": ro,
            "Waived off": 0, "Total (₹)": total, "Tip (₹)": tip,
            "Persons": persons}
    for h, v in vals.items():
        row[HEADERS.index(h)] = v
    return row


def build_xlsx(rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    for meta in META:
        ws.append(list(meta))
    ws.append([])
    ws.append(HEADERS)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_item_xlsx():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Item Name", "Date", "Qty", "Amount", "Category"])
    ws.append(["Masala Dosa", "2026-08-20", 3, 450, "Dosa"])
    ws.append(["Masala Dosa", "2026-08-20", 2, 300, "Dosa"])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_itemwise_import_stages_before_commit(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    up = client.post(
        "/api/imports/upload",
        params={"outlet_id": outlet_id},
        files={"file": (
            "items.xlsx",
            build_item_xlsx(),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )},
    )
    assert up.status_code == 200, up.text
    assert up.json()["rows_ok"] == 1

    from app.db import SessionLocal
    from app.models import SalesItem
    db = SessionLocal()
    assert db.query(SalesItem).filter_by(item_name="Masala Dosa").count() == 0
    db.close()

    committed = client.post(f"/api/imports/{up.json()['batch_id']}/commit")
    assert committed.status_code == 200, committed.text
    db = SessionLocal()
    row = db.query(SalesItem).filter_by(item_name="Masala Dosa").one()
    assert row.qty == 5
    assert row.amount_paise == 75_000
    db.close()


def test_parse_and_commit_roundtrip(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    xlsx = build_xlsx([
        bill_row(9001, "2026-08-01 13:00:00", "UPI"),
        bill_row(9002, "2026-08-01 19:30:00", "Cash", my=250.0, tip=20.0),
        bill_row(9003, "2026-08-01 21:00:00", "Part Payment", my=400.0),
        bill_row(9004, "2026-08-02 12:00:00", "UPI", status="Cancelled"),
        bill_row("Total", None, "", my=0),
    ])
    up = client.post("/api/imports/upload",
                     params={"outlet_id": outlet_id},
                     files={"file": ("orders.xlsx", xlsx,
                                     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert up.status_code == 200, up.text
    data = up.json()
    assert data["rows_ok"] == 3
    assert data["rows_skipped"] == 1          # the cancelled bill
    assert data["part_payments_unresolved"] == 1
    batch = data["batch_id"]

    com = client.post(f"/api/imports/{batch}/commit")
    assert com.status_code == 200, com.text

    sheet = client.get("/api/sales/sheet",
                       params={"outlet_id": outlet_id, "date": "2026-08-01"}).json()
    by_kind = {r["channel_kind"]: r for r in sheet["all_rows"]}
    assert by_kind["upi"]["imported"]["bills"] == 1
    assert abs(by_kind["upi"]["imported"]["total_paise"] / 100 - 105.0) < 0.001
    assert by_kind["cash"]["imported"]["tip_paise"] / 100 == 20.0
    assert by_kind["split"]["imported"]["bills"] == 1

    # Reimporting the same report is idempotent.
    stash_rebuild = build_xlsx([
        bill_row(9001, "2026-08-01 13:00:00", "UPI"),
        bill_row(9002, "2026-08-01 19:30:00", "Cash", my=250.0, tip=20.0),
        bill_row(9003, "2026-08-01 21:00:00", "Part Payment", my=400.0),
    ])
    up2 = client.post("/api/imports/upload",
                      params={"outlet_id": outlet_id},
                      files={"file": ("again.xlsx", stash_rebuild,
                                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    b2 = up2.json()["batch_id"]
    client.post(f"/api/imports/{b2}/commit")
    from app.db import SessionLocal
    from app.models import SalesBill
    db = SessionLocal()
    count = (db.query(SalesBill)
               .filter(SalesBill.outlet_id == outlet_id,
                       SalesBill.invoice_no.in_(["9001", "9002", "9003"])).count())
    db.close()
    assert count == 3


def test_reimport_removes_stale_bills_and_rollups(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    first = build_xlsx([
        bill_row(9101, "2026-08-03 13:00:00", "UPI"),
        bill_row(9102, "2026-08-03 19:30:00", "Cash"),
    ])
    up = client.post("/api/imports/upload", params={"outlet_id": outlet_id},
                     files={"file": ("first.xlsx", first,
                                     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert client.post(f"/api/imports/{up.json()['batch_id']}/commit").status_code == 200

    replacement = build_xlsx([
        bill_row(9101, "2026-08-03 13:00:00", "UPI", my=150),
    ])
    up = client.post("/api/imports/upload", params={"outlet_id": outlet_id},
                     files={"file": ("replacement.xlsx", replacement,
                                     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert client.post(f"/api/imports/{up.json()['batch_id']}/commit").status_code == 200

    refreshed = client.get("/api/sales/sheet",
                           params={"outlet_id": outlet_id,
                                   "date": "2026-08-03"}).json()
    imported = {
        row["channel_kind"]: row["imported"]
        for row in refreshed["all_rows"] if row["imported"]
    }
    assert set(imported) == {"upi"}


def test_itemwise_reimport_replaces_values(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    for _ in range(2):
        up = client.post(
            "/api/imports/upload", params={"outlet_id": outlet_id},
            files={"file": ("items.xlsx", build_item_xlsx(),
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
        assert client.post(
            f"/api/imports/{up.json()['batch_id']}/commit").status_code == 200

    from app.db import SessionLocal
    from app.models import SalesItem
    db = SessionLocal()
    row = db.query(SalesItem).filter_by(item_name="Masala Dosa").one()
    assert row.qty == 5
    assert row.amount_paise == 75_000
    db.close()


def test_cash_day_variance_math(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    xlsx = build_xlsx([
        bill_row(9201, "2026-08-01 19:30:00", "Cash", my=250.0, tip=20.0),
    ])
    up = client.post(
        "/api/imports/upload",
        params={"outlet_id": outlet_id},
        files={"file": ("cash.xlsx", xlsx, "application/octet-stream")},
    )
    assert up.status_code == 200, up.text
    assert client.post(
        f"/api/imports/{up.json()['batch_id']}/commit"
    ).status_code == 200

    d = client.get("/api/cash/day", params={"outlet_id": outlet_id,
                                            "date": "2026-08-01"}).json()
    # opening float 0 + cash bill total ₹275 (250 net + 5 tax + 20 tip)
    assert d["cash_sales_paise"] == 27_500
    assert d["expected_paise"] == 27_500
    cl = client.post("/api/cash/close", json={
        "outlet_id": outlet_id, "date": "2026-08-01",
        "counted_rupees": 260.0, "taken_home_rupees": 260.0, "note": "short ₹15"})
    assert cl.status_code == 200
    body = cl.json()
    assert body["variance_paise"] == -1500
    assert body["left_in_drawer_paise"] == 0          # took everything home


def test_manual_sales_count_in_cash_math(client, outlet_id):
    """Regression: manual sales live in amount_paise — they must count everywhere."""
    from datetime import date as D
    day = D.today().isoformat()
    r = client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": day,
        "channel_kind": "cash", "amount_rupees": 3000})
    assert r.status_code == 200

    d = client.get("/api/cash/day", params={"outlet_id": outlet_id,
                                            "date": day}).json()
    assert d["cash_sales_paise"] == 300_000

    home = client.get("/api/stats/home", params={"date": day}).json()
    mine = next(o for o in home["outlets"] if o["outlet_id"] == outlet_id)
    assert mine["sales"]["rupees_paise"] == 300_000   # was the reported ₹0 bug

    # expense shows in totals too
    cats = client.get("/api/lists/categories").json()
    client.post("/api/expenses", json={
        "outlet_id": outlet_id, "business_date": day,
        "category_id": cats[0]["id"], "amount_rupees": 250,
        "mode": "upi", "description": "regression check"})
    home2 = client.get("/api/stats/home", params={"date": day}).json()
    mine2 = next(o for o in home2["outlets"] if o["outlet_id"] == outlet_id)
    assert mine2["expenses"]["total_paise"] >= 25_000
    rows_today = client.get("/api/expenses", params={
        "outlet_id": outlet_id, "start": day, "end": day}).json()["rows"]
    mine_row = next(r for r in rows_today if r["description"] == "regression check")
    assert mine_row["mode"] == "upi"          # non-cash stays out of drawer math
