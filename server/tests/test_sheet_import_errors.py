"""The generic "Upload sheet" importer must be honest about what went wrong.

A bank statement dropped here used to report "bad date or amount" on every
row, which tells the owner nothing. Comma-formatted money crashed outright.
Non-ISO dates - what Excel actually produces in India - failed every row.
"""
import pytest

BANK_STATEMENT = (
    b"HDFC BANK LTD.\n"
    b"Account No,50100123456789\n"
    b"\n"
    b"Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n"
    b'01/04/24,UPI-SHOP-SHOP@YBL-X-1,0,01/04/24,"1,250.00",,"85,430.20"\n'
    b'02/04/24,UPI-OTHER-OTHER@YBL-X-2,0,02/04/24,"340.00",,"85,090.20"\n'
)


def stepup(client):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})


def import_expenses(client, outlet_id, payload, name="sheet.csv"):
    return client.post(f"/api/data/import/expenses?outlet_id={outlet_id}",
                       files={"file": (name, payload, "text/csv")})


def test_bank_statement_points_at_the_right_page(client, outlet_id):
    stepup(client)
    r = import_expenses(client, outlet_id, BANK_STATEMENT, "hdfc.csv")
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert "bank statement" in detail.lower()
    assert "Bank statement" in detail, "must name the page to use instead"


def test_bank_statement_creates_nothing(client, outlet_id):
    stepup(client)
    import_expenses(client, outlet_id, BANK_STATEMENT, "hdfc.csv")
    assert client.get(f"/api/expenses?outlet_id={outlet_id}").json()["total"] == 0


@pytest.mark.parametrize("written,expected", [
    ("2026-01-05", "2026-01-05"),
    ("05/01/2026", "2026-01-05"),   # Indian day-first, what Excel writes
    ("05-01-2026", "2026-01-05"),
    ("5 Jan 2026", "2026-01-05"),
])
def test_common_date_formats_are_accepted(client, outlet_id, written, expected):
    stepup(client)
    cats = client.get("/api/lists/categories").json()
    csv = (f"date,category,amount,mode,description\n"
           f"{written},{cats[0]['name']},250,cash,Row\n").encode()
    r = import_expenses(client, outlet_id, csv)
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 1, r.text
    rows = client.get(f"/api/expenses?outlet_id={outlet_id}").json()["rows"]
    assert rows[0]["business_date"] == expected


@pytest.mark.parametrize("written,paise", [
    ("1250", 125000),
    ('"1,250.00"', 125000),
    ('"1,250.50"', 125050),
    ('"₹1,250"', 125000),
    ("1250.5", 125050),
])
def test_money_with_separators_is_read_not_crashed(client, outlet_id,
                                                   written, paise):
    stepup(client)
    cats = client.get("/api/lists/categories").json()
    csv = (f"date,category,amount,mode,description\n"
           f"2026-01-05,{cats[0]['name']},{written},cash,Row\n").encode("utf-8")
    r = import_expenses(client, outlet_id, csv)
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 1, r.text
    rows = client.get(f"/api/expenses?outlet_id={outlet_id}").json()["rows"]
    assert rows[0]["amount_paise"] == paise


def test_row_errors_say_which_field_was_wrong(client, outlet_id):
    stepup(client)
    cats = client.get("/api/lists/categories").json()
    csv = ("date,category,amount,mode,description\n"
           f"not-a-date,{cats[0]['name']},250,cash,Bad date\n"
           f"2026-01-05,{cats[0]['name']},abc,cash,Bad amount\n").encode()
    r = import_expenses(client, outlet_id, csv)
    assert r.status_code == 200, r.text
    whys = [e["why"] for e in r.json()["errors"]]
    assert whys == ["no valid date", "no valid amount"], r.text


def test_sales_sheets_also_survive_formatted_money(client, outlet_id):
    stepup(client)
    csv = ('date,cash,upi,card,other\n'
           '2026-01-06,"12,500.00","3,200.50",0,0\n').encode()
    r = client.post(f"/api/data/import/sales_manual?outlet_id={outlet_id}",
                    files={"file": ("sales.csv", csv, "text/csv")})
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 1, r.text
