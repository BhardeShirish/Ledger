"""Bank statement import: parsing, payee clubbing, rules and dedupe.

The fixtures deliberately mimic what banks actually hand out - an account
details preamble, a footer total, blank rows, comma-formatted amounts and
two-digit years - because those are exactly what breaks a naive reader.
"""
import io
import pathlib

import pytest

from app import bankstmt

HEADER = ("Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,"
          "Deposit Amt.,Closing Balance")

PREAMBLE = """HDFC BANK LTD.
Statement of account

Account Branch  :,KORAMANGALA
Address         :,80 FEET ROAD BANGALORE
Account No      :,50100123456789  INR
Statement From  :,01/04/2024  To  :,30/04/2024

"""

ROWS = [
    '01/04/24,UPI-ANNAPURNA VEG-ANNAPURNA@OKAXIS-SBIN0001234-412300001-PAYMENT,'
    '0000000000000000,01/04/24,"3,400.00",,"82,030.20"',
    '05/04/24,UPI-ANNAPURNA VEG-ANNAPURNA@OKAXIS-SBIN0001234-412300999-PAYMENT,'
    '0000000000000000,05/04/24,"2,100.00",,"79,930.20"',
    '07/04/24,NEFT DR-HDFC0000123-METRO CASH AND CARRY-N123456789,'
    'N123456789,07/04/24,"12,000.00",,"67,930.20"',
    '09/04/24,ATW-421012XXXXXX1234-S1BLR001-BANGALORE,'
    '0000000000000000,09/04/24,"10,000.00",,"57,930.20"',
    '11/04/24,UPI-RAZORPAY-RAZORPAY@ICICI-ICIC0000001-4123-SETTLEMENT,'
    '0000000000000000,11/04/24,,"25,000.00","82,930.20"',
]

FOOTER = '\n\n*Closing Bal,,,,,,"82,930.20"\n'


def statement_csv(rows=None) -> bytes:
    body = "\n".join(rows if rows is not None else ROWS)
    return (PREAMBLE + HEADER + "\n" + body + FOOTER).encode("utf-8")


# --- parser -----------------------------------------------------------------

def test_preamble_and_footer_are_ignored():
    parsed = bankstmt.parse(statement_csv(), "stmt.csv")
    assert parsed.header_row == 9
    assert [t.date for t in parsed.debits] == [
        "2024-04-01", "2024-04-05", "2024-04-07", "2024-04-09"]
    assert parsed.debits[0].amount_paise == 340000
    # The credit is read but kept out of the expense candidates.
    assert len(parsed.credits) == 1
    assert parsed.credits[0].amount_paise == 2500000


def test_missing_transaction_table_is_a_clear_error():
    with pytest.raises(ValueError, match="transaction table"):
        bankstmt.parse(b"Account No,50100123456789\nAddress,Bangalore\n", "x.csv")


def test_semicolon_and_tab_files_are_read():
    for delimiter in (";", "\t"):
        raw = (f"Date{delimiter}Narration{delimiter}Debit{delimiter}Credit\n"
               f"01/04/2024{delimiter}UPI-SHOP-SHOP@YBL-X-1{delimiter}100.00"
               f"{delimiter}\n").encode()
        parsed = bankstmt.parse(raw, "stmt.csv")
        assert parsed.debits[0].amount_paise == 10000


def test_html_table_named_xls_is_read():
    """Banks routinely serve an HTML table with an .xls extension."""
    raw = (b"<html><body><table>"
           b"<tr><td>Account No</td><td>50100123456789</td></tr>"
           b"<tr><th>Date</th><th>Narration</th><th>Withdrawal Amt.</th>"
           b"<th>Deposit Amt.</th></tr>"
           b"<tr><td>02/04/2024</td><td>UPI-SHOP-SHOP@YBL-X-1</td>"
           b"<td>1,234.50</td><td></td></tr>"
           b"</table></body></html>")
    parsed = bankstmt.parse(raw, "statement.xls")
    assert len(parsed.debits) == 1
    assert parsed.debits[0].amount_paise == 123450


def test_xlsx_is_read_with_real_dates():
    from openpyxl import Workbook
    from datetime import date

    book = Workbook()
    sheet = book.active
    sheet.append(["Account No", "50100123456789"])
    sheet.append([])
    sheet.append(["Date", "Narration", "Withdrawal Amt.", "Deposit Amt."])
    sheet.append([date(2024, 4, 3), "UPI-SHOP-SHOP@YBL-X-1", 250.75, None])
    buffer = io.BytesIO()
    book.save(buffer)

    parsed = bankstmt.parse(buffer.getvalue(), "stmt.xlsx")
    assert parsed.debits[0].date == "2024-04-03"
    assert parsed.debits[0].amount_paise == 25075


def test_legacy_biff_xls_is_read():
    """A genuine old-Excel statement, frozen as a fixture.

    Generating one needs a writer library we do not ship, and a test that
    skipped itself when that library was absent would quietly stop guarding
    this path - so the file is committed instead.
    """
    raw = (pathlib.Path(__file__).parent / "fixtures" / "hdfc_legacy.xls").read_bytes()
    assert raw[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "fixture is not real BIFF"
    parsed = bankstmt.parse(raw, "statement.xls")
    assert [(t.date, t.amount_paise) for t in parsed.debits] == [
        ("2024-04-12", 187525), ("2024-04-13", 900000)]
    assert len(parsed.credits) == 1
    assert bankstmt.counterparty(parsed.debits[0].narration)[0] == "annapurna@okaxis"


def test_single_amount_column_uses_the_dr_cr_marker():
    raw = (b"Date,Description,Amount,Dr/Cr\n"
           b"04/04/2024,UPI-SHOP-SHOP@YBL-X-1,500.00,DR\n"
           b"05/04/2024,SALARY CREDIT,900.00,CR\n")
    parsed = bankstmt.parse(raw, "stmt.csv")
    assert [t.amount_paise for t in parsed.debits] == [50000]
    assert [t.amount_paise for t in parsed.credits] == [90000]


# --- payee ------------------------------------------------------------------

def test_same_upi_payee_clubs_across_transactions():
    parsed = bankstmt.parse(statement_csv(), "stmt.csv")
    keys = [bankstmt.counterparty(t.narration)[0] for t in parsed.debits]
    # Two different transaction ids, one payee.
    assert keys[0] == keys[1] == "annapurna@okaxis"
    assert bankstmt.counterparty(parsed.debits[0].narration)[1] == "Annapurna Veg"


def test_business_name_survives_noise_stripping():
    key, label = bankstmt.counterparty(
        "NEFT DR-HDFC0000123-METRO CASH AND CARRY-N123456789")
    assert label == "Metro Cash And Carry"
    assert key == "METRO CASH AND CARRY"


def test_atm_and_charges_are_recognised_as_never_expenses():
    assert bankstmt.classify("ATW-421012XXXXXX1234-S1BLR001-BLR")[0] == "atm"
    assert bankstmt.counterparty("ATW-421012XXXXXX1234-S1BLR001-BLR")[0] == \
        "ATM WITHDRAWAL"
    assert bankstmt.classify("AMB CHRG INCL GST FOR APR2024-MIR24")[0] == "charge"


def test_initials_in_a_firm_name_are_kept():
    """"A R Kitchen Equipments" must not become "Kitchen Equipments".

    Dropping the initials both mangles the name and lets two unrelated
    suppliers collapse onto one key, which would merge their spend.
    """
    key, label = bankstmt.counterparty(
        "NEFT DR-UTIB0002011-A R KITCHEN EQUIPMENTS-NETBANK, MUM-HDFCH009-HDFCE7D8")
    assert label == "A R Kitchen Equipments"
    assert key == "A R KITCHEN EQUIPMENTS"
    other, _ = bankstmt.counterparty(
        "NEFT DR-UTIB0002011-B K KITCHEN EQUIPMENTS-NETBANK, MUM-HDFCH009-HDFCE7D8")
    assert other != key, "two different firms must not share one key"


def test_vpa_containing_a_hyphen_is_read_whole():
    """A VPA is hyphen-delimited but may contain a hyphen itself."""
    key, label = bankstmt.counterparty(
        "UPI-TARIQUE PARVEZ ANSAR-T.PARVEZANSARI-1@OKHDFCBANK-UBIN0576263-"
        "612867117848-UPI SEND MONEY")
    assert key == "t.parvezansari-1@okhdfcbank"
    assert label == "Tarique Parvez Ansar"


def test_hyphen_repair_does_not_swallow_the_previous_field():
    """The name before the VPA must never be dragged into the key."""
    key, _ = bankstmt.counterparty(
        "UPI-SHIRISH OMPRAKASH BH-SHIRISHBHARDE@OKHDFCBANK-HDFC0000076-"
        "121891928168-UPI")
    assert key == "shirishbharde@okhdfcbank"


def test_hdfc_footer_and_separator_rows_are_ignored():
    """The real download wraps the table in asterisk rules and a summary block."""
    raw = (
        b"Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n"
        b"********,********,********,********,********,********,********\n"
        b"26/04/26,UPI-SHOP-SHOP@YBL-HDFC0000076-611636133453-UPI SEND MONEY,0,26/04/26,1000.00,,5000.00\n"
        b"********,********,********,********,********,********,********\n"
        b"STATEMENT SUMMARY  :-,,,,,,\n"
        b"Opening Balance,,,,Debits,Credits,Closing Bal\n"
        b"0.00,,,,1000.00,0.00,5000.00\n"
        b"---  End Of Statement ---,,,,,,\n"
    )
    parsed = bankstmt.parse(raw, "stmt.csv")
    assert [t.amount_paise for t in parsed.debits] == [100000], \
        "the summary total must not be booked as a second expense"
    assert parsed.credits == []
    assert parsed.debits[0].date == "2026-04-26", "dd/mm/yy is day-first here"


# --- API --------------------------------------------------------------------

def upload(client, outlet_id, raw=None, name="stmt.csv"):
    return client.post(
        f"/api/bank/upload?outlet_id={outlet_id}",
        files={"file": (name, raw if raw is not None else statement_csv(),
                        "text/csv")})


def expenses(client, outlet_id):
    return client.get(f"/api/expenses?outlet_id={outlet_id}"
                      "&start=2024-04-01&end=2024-04-30").json()["rows"]


def category_id(client, name="Vegetables"):
    rows = client.get("/api/lists/categories").json()
    for row in rows:
        if name.lower() in row["name"].lower():
            return row["id"]
    return rows[0]["id"]


def test_upload_previews_without_writing_anything(client, outlet_id):
    before = len(expenses(client, outlet_id))
    body = upload(client, outlet_id).json()
    assert body["debits"] == 4
    assert body["credits"] == 1
    assert body["credits_ignored"] == 0
    assert body["new_rows"] == 4
    payees = {p["match_key"]: p for p in body["payees"]}
    assert payees["annapurna@okaxis"]["count"] == 2
    assert payees["annapurna@okaxis"]["total_rupees"] == 5500.0
    # An ATM withdrawal is cash moved to the drawer, not spend.
    assert payees["ATM WITHDRAWAL"]["skip"] is True
    after = expenses(client, outlet_id)
    assert len(after) == before


def test_commit_creates_expenses_and_remembers_the_payee(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    body = upload(client, outlet_id).json()
    cat = category_id(client)

    result = client.post(f"/api/bank/{body['batch_id']}/commit", json={
        "decisions": [
            {"match_key": "annapurna@okaxis", "category_id": cat,
             "vendor_name": "Annapurna Veg", "mode": "upi", "remember": True},
            {"match_key": "ATM WITHDRAWAL", "skip": True, "remember": True},
        ]}).json()
    assert result["created"] == 2
    assert result["rules_saved"] == 2

    rows = expenses(client, outlet_id)
    assert sorted(r["amount_rupees"] for r in rows) == [2100.0, 3400.0]
    assert {r["mode"] for r in rows} == {"upi"}
    assert all(r["vendor_id"] for r in rows)

    # The remembered payee comes back pre-filled next time.
    again = upload(client, outlet_id).json()
    remembered = {p["match_key"]: p for p in again["payees"]}
    assert remembered["annapurna@okaxis"]["known"] is True
    assert remembered["annapurna@okaxis"]["category_id"] == cat
    assert remembered["ATM WITHDRAWAL"]["skip"] is True


def test_reimporting_an_overlapping_statement_does_not_double_post(client,
                                                                  outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    cat = category_id(client)
    first = upload(client, outlet_id).json()
    client.post(f"/api/bank/{first['batch_id']}/commit", json={"decisions": [
        {"match_key": "annapurna@okaxis", "category_id": cat, "mode": "upi"}]})

    # Next month's download overlaps the first two weeks, as they always do.
    second = upload(client, outlet_id).json()
    assert second["already_imported"] == 2
    result = client.post(f"/api/bank/{second['batch_id']}/commit", json={
        "decisions": [{"match_key": "annapurna@okaxis", "category_id": cat,
                       "mode": "upi"}]}).json()
    assert result["created"] == 0
    assert result["duplicates"] == 2

    rows = expenses(client, outlet_id)
    assert len(rows) == 2


def test_unmapped_payees_are_reported_not_guessed(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    body = upload(client, outlet_id).json()
    result = client.post(f"/api/bank/{body['batch_id']}/commit",
                         json={"decisions": [
                             {"match_key": "METRO CASH AND CARRY"}]}).json()
    assert result["created"] == 0
    assert result["unmapped"] == ["METRO CASH AND CARRY"]


def test_a_batch_cannot_be_committed_twice(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    body = upload(client, outlet_id).json()
    payload = {"decisions": [{"match_key": "annapurna@okaxis",
                              "category_id": category_id(client), "mode": "upi"}]}
    assert client.post(f"/api/bank/{body['batch_id']}/commit",
                       json=payload).status_code == 200
    assert client.post(f"/api/bank/{body['batch_id']}/commit",
                       json=payload).status_code == 410


def test_manager_cannot_import_a_statement(manager, outlet_id):
    r = manager.post(f"/api/bank/upload?outlet_id={outlet_id}",
                     files={"file": ("stmt.csv", statement_csv(), "text/csv")})
    assert r.status_code == 403


def test_rules_can_be_listed_and_deleted(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    body = upload(client, outlet_id).json()
    client.post(f"/api/bank/{body['batch_id']}/commit", json={"decisions": [
        {"match_key": "annapurna@okaxis", "category_id": category_id(client),
         "mode": "upi", "remember": True}]})
    rules = client.get("/api/bank/rules").json()
    assert [r["match_key"] for r in rules] == ["annapurna@okaxis"]
    assert client.delete(f"/api/bank/rules/{rules[0]['id']}").status_code == 200
    assert client.get("/api/bank/rules").json() == []


def test_garbage_upload_is_rejected_with_a_readable_message(client, outlet_id):
    r = upload(client, outlet_id, raw=b"not a statement at all")
    assert r.status_code == 422
    assert "transaction table" in r.json()["detail"]
