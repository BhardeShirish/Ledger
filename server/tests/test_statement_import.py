"""The statement importer, exercised on the shapes that actually go wrong.

Every case here is taken from the real statements: a payment that appears in
both sources, a supplier carrying the shop's own name, and a person whose
name is a substring of an unrelated supplier's.
"""
from datetime import date

import pytest

from app.statement_import import (classify, classify_group, display_name,
                                  group_parties, merge, parse_neft, parse_upi,
                                  paytm_settlements, rupees, usable_vpa)


def hdfc_row(day, narration, ref, amount):
    return {"date": date(2026, 8, day), "narration": narration, "ref": ref,
            "withdrawal": amount, "deposit": 0.0}


def phonepe_row(day, details, utr, amount, account="1270"):
    return {"date": date(2026, 8, day), "details": details, "utr": utr,
            "direction": "DEBIT", "account": account, "amount": amount}


def test_a_payment_in_both_statements_is_counted_once():
    hdfc = [hdfc_row(5, "UPI-AMIT KHUBNANI KIRANA-khubnaniamit@axl-X-UPI",
                     "611749008851", 18391.0)]
    phonepe = [phonepe_row(5, "Paid to Amit Khubnani Kirana",
                           "611749008851", 18391.0)]

    records = merge(hdfc, phonepe, date(2026, 8, 1), "1270")

    assert len(records) == 1
    assert records[0]["amount"] == 18391.0
    # The bank truncates; PhonePe does not. Keep the readable name.
    assert records[0]["payee"] == "Amit Khubnani Kirana"


def test_phonepe_only_payments_are_still_imported():
    """September exists in PhonePe alone: the bank statement stops in August."""
    hdfc = [hdfc_row(5, "UPI-A-a@b-X-UPI", "111", 100.0)]
    phonepe = [phonepe_row(5, "Paid to A", "111", 100.0),
               phonepe_row(6, "Paid to Vimal gas service", "222", 5794.0)]

    records = merge(hdfc, phonepe, date(2026, 8, 1), "1270")

    assert len(records) == 2
    assert sum(r["amount"] for r in records) == pytest.approx(5894.0)


def test_payments_from_another_account_are_left_out():
    phonepe = [phonepe_row(5, "Paid to ZERODHA BROKING LIMITED", "333",
                           50000.0, account="0215")]

    assert merge([], phonepe, date(2026, 8, 1), "1270") == []


def test_a_name_inside_another_name_is_not_a_match():
    """'Aman' is a member of staff; 'DINESH RAMAN' is not him."""
    kind, name, _, _ = classify("DINESH RAMAN")

    assert kind == "vendor"
    assert name == "DINESH RAMAN"
    assert classify("Aman")[1] == "Akhilesh Khobragade"


def test_the_shops_own_name_does_not_make_a_supplier_into_staff():
    assert classify("Pawan Water Ootaa")[0] == "vendor"
    assert classify("Pawan Water Ootaa")[2] == "Water"
    assert classify("Easter Cashier Ootaa")[0] == "staff"


def test_legal_bank_names_merge_into_the_confirmed_staff_records():
    """HDFC uses legal middle names, unlike the owner's staff shorthand."""
    assert classify("RIYA VIJENDRA SINGH") == (
        "staff", "Riya Singh", "Salary & Wages", True)
    assert classify("BHUSHAN SHRIKISHAN SONONE") == (
        "staff", "Bhushan Sonone", "Salary & Wages", True)


def test_generic_bank_label_uses_the_phonepe_merchant_and_category():
    records = [
        {"date": date(2026, 8, 1), "amount": 1300.0,
         "payee": "XXXPGN KOTAK 811 OTP", "vpa": "914udbdi@ybl",
         "narration": "", "source": "hdfc"},
        {"date": date(2026, 8, 2), "amount": 1300.0,
         "payee": "Pawan Water Ootaa", "vpa": "914udbdi@ybl",
         "narration": "", "source": "phonepe"},
    ]

    groups = group_parties(records)

    assert len(groups) == 1
    rows = next(iter(groups.values()))
    assert display_name(rows) == "Pawan Water Ootaa"
    assert classify_group(rows)[2] == "Water"


def test_generic_bank_labels_with_different_upi_ids_stay_separate():
    records = [
        {"date": date(2026, 8, 1), "amount": 1300.0,
         "payee": "XXXPGN KOTAK 811 OTP", "vpa": "pawan@ybl",
         "narration": "", "source": "hdfc"},
        {"date": date(2026, 8, 2), "amount": 500.0,
         "payee": "XXXPGN KOTAK 811 OTP", "vpa": "other@ybl",
         "narration": "", "source": "hdfc"},
    ]

    assert len(group_parties(records)) == 2


def test_truncated_legal_staff_name_joins_its_confirmed_record():
    records = [
        {"date": date(2026, 6, 3), "amount": 67.0,
         "payee": "CHANDRASHEKHAR NARAY", "vpa": "8483910717@upi",
         "narration": "", "source": "hdfc"},
        {"date": date(2026, 9, 5), "amount": 28133.0,
         "payee": "CHANDRASHEKHAR NARAYAN CHOUDHARI",
         "vpa": "8483910717@upi", "narration": "", "source": "hdfc"},
    ]

    groups = group_parties(records)

    assert len(groups) == 1
    assert next(iter(groups)).startswith("staff:")
    assert sum(r["amount"] for r in next(iter(groups.values()))) == 28200.0


def test_one_person_paying_into_two_upi_ids_is_one_party():
    records = [
        {"date": date(2026, 8, 1), "amount": 100.0, "payee": "Aman",
         "vpa": "9168761469@axl", "narration": "", "source": "hdfc"},
        {"date": date(2026, 8, 2), "amount": 200.0, "vpa": "9168761469@ybl",
         "payee": "Akhilesh Khobragade Ootaa Staff", "narration": "",
         "source": "hdfc"},
        {"date": date(2026, 8, 3), "amount": 300.0, "payee": "Mrs Varsha Varsha",
         "vpa": "9168761469@ybl", "narration": "", "source": "hdfc"},
    ]

    groups = group_parties(records)

    assert len(groups) == 1
    assert sum(r["amount"] for r in next(iter(groups.values()))) == 600.0


def test_aggregator_handles_never_merge_two_shops():
    """Thousands of merchants share a PayTM QR handle."""
    assert usable_vpa("paytmqr6m1m0e@ptys") is None
    assert usable_vpa("q634006268@ybl") is None
    assert usable_vpa("khubnaniamit@axl") == "khubnaniamit@axl"


def test_unknown_payees_are_flagged_rather_than_guessed():
    kind, _, category, confident = classify("AJINKYA SALES SERVICES")

    assert kind == "vendor"
    assert category == "Misc"
    assert confident is False


def test_upi_narration_yields_payee_and_id():
    payee, vpa = parse_upi("UPI-FRESHEZY AND CO-infofreshezy@okaxis-UTIB-1-UPI")

    assert payee == "FRESHEZY AND CO"
    assert vpa == "infofreshezy@okaxis"


def test_bank_transfer_narration_yields_a_clean_payee():
    """Without this the IFSC and the channel end up in the vendor's name."""
    assert (parse_neft("NEFT DR-SVCB0000120-AJINKYA SALES SERVICES-NET")
            == "AJINKYA SALES SERVICES")
    assert (parse_neft("NEFT DR-PUNB0244300-RAVINDRAKUMAR SHARMA-NETBANK")
            == "RAVINDRAKUMAR SHARMA")
    assert parse_neft("UPI-SOMEONE-a@b-X-UPI") == ""


def test_only_paytm_payment_service_credits_become_sales():
    hdfc = [
        {"date": date(2026, 8, 1), "deposit": 10_000.0,
         "narration": "NEFT CR-YESB-PAYTM PAYMENTS SERVICES LIMITED PA",
         "ref": "", "withdrawal": 0.0},
        {"date": date(2026, 8, 1), "deposit": 100.0,
         "narration": "UPI-CUSTOMER-a@ptaxis-SENT USING PAYTM",
         "ref": "", "withdrawal": 0.0},
        {"date": date(2026, 8, 2), "deposit": 4_500.50,
         "narration": "NEFT CR-YESB-PAYTM PAYMENTS SERVICES LTD",
         "ref": "", "withdrawal": 0.0},
    ]

    assert paytm_settlements(hdfc, date(2026, 8, 1)) == {
        "2026-08-01": 1_000_000,
        "2026-08-02": 450_050,
    }


def test_money_is_grouped_the_indian_way():
    assert rupees(1250811.67) == "12,50,811.67"
    assert rupees(230183) == "2,30,183.00"
