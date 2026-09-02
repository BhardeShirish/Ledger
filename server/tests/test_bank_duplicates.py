"""No bank line may ever be booked twice - and no real line may be lost.

The second half matters as much as the first: silently swallowing a genuine
second payment is worse than a duplicate, because nothing on screen says so.
"""

from app.models import Expense

CATS = "/api/lists/categories"


def stepup(client):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})


def upload(client, outlet_id, raw, name="stmt.csv"):
    return client.post(f"/api/bank/upload?outlet_id={outlet_id}",
                       files={"file": (name, raw, "text/csv")})


def commit(client, preview, cat, skip_defaults=True):
    decisions = [{"match_key": p["match_key"], "category_id": cat,
                  "vendor_id": None, "mode": p.get("mode", "bank"),
                  "skip": p["skip"] if skip_defaults else False,
                  "remember": False}
                 for p in preview["payees"]]
    return client.post(f"/api/bank/{preview['batch_id']}/commit",
                       json={"decisions": decisions})


def ledger(client, outlet_id):
    r = client.get(f"/api/expenses?outlet_id={outlet_id}"
                   "&start=2020-01-01&end=2035-12-31").json()
    return r["total"], sum(x["amount_paise"] for x in r["rows"])


def cat_id(client):
    return client.get(CATS).json()[0]["id"]


HEAD = b"Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance\n"


def line(date, narration, amount, ref="0"):
    return f"{date},{narration},{ref},{amount},,1000.00\n".encode()


APRIL = HEAD + b"".join([
    line("01/04/24", "UPI-SHOP A-SHOPA@YBL-HDFC0000076-111-UPI", "500.00"),
    line("02/04/24", "UPI-SHOP B-SHOPB@YBL-HDFC0000076-222-UPI", "300.00"),
])


def test_same_file_twice_adds_nothing_the_second_time(client, outlet_id):
    stepup(client)
    cat = cat_id(client)
    first = upload(client, outlet_id, APRIL).json()
    assert commit(client, first, cat).status_code == 200
    after_first = ledger(client, outlet_id)
    assert after_first == (2, 80000), after_first

    second = upload(client, outlet_id, APRIL).json()
    assert second["already_imported"] == 2, second
    assert second["new_rows"] == 0, second
    r = commit(client, second, cat)
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 0, r.json()
    assert r.json()["duplicates"] == 2, r.json()
    assert ledger(client, outlet_id) == after_first


def test_overlapping_statements_book_only_the_new_rows(client, outlet_id):
    """April-May then May-June: the shared May rows must not double up."""
    stepup(client)
    cat = cat_id(client)
    may_row = line("15/05/24", "UPI-SHOP C-SHOPC@YBL-HDFC0000076-333-UPI", "700.00")
    first = HEAD + APRIL[len(HEAD):] + may_row
    second = HEAD + may_row + line(
        "20/06/24", "UPI-SHOP D-SHOPD@YBL-HDFC0000076-444-UPI", "900.00")

    p1 = upload(client, outlet_id, first).json()
    commit(client, p1, cat)
    assert ledger(client, outlet_id) == (3, 150000)

    p2 = upload(client, outlet_id, second).json()
    assert p2["already_imported"] == 1, p2
    r = commit(client, p2, cat)
    assert r.json()["created"] == 1, r.json()
    assert r.json()["duplicates"] == 1, r.json()
    assert ledger(client, outlet_id) == (4, 240000)


def test_two_identical_lines_in_one_statement_are_both_kept(client, outlet_id):
    """Same day, same amount, same narration, same blank ref - two real payments.

    A fixed rental or a repeat QR payment looks exactly like this. Dropping
    the second would quietly under-state spend.
    """
    stepup(client)
    cat = cat_id(client)
    twice = HEAD + line("09/05/24", "SOUND BOX RENTAL MAY", "116.82", "0") * 2
    preview = upload(client, outlet_id, twice).json()
    assert preview["debits"] == 2, preview
    assert preview["new_rows"] == 2, "neither line has been imported before"

    r = commit(client, preview, cat, skip_defaults=False)
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 2, r.json()
    assert r.json()["duplicates"] == 0, r.json()
    assert ledger(client, outlet_id) == (2, 23364)


def test_that_pair_still_dedupes_against_itself_on_re_upload(client, outlet_id):
    """Numbering the repeats must not break matching on a re-download."""
    stepup(client)
    cat = cat_id(client)
    twice = HEAD + line("09/05/24", "SOUND BOX RENTAL MAY", "116.82", "0") * 2
    commit(client, upload(client, outlet_id, twice).json(), cat,
           skip_defaults=False)
    before = ledger(client, outlet_id)

    again = upload(client, outlet_id, twice).json()
    assert again["already_imported"] == 2, again
    r = commit(client, again, cat, skip_defaults=False)
    assert r.json()["created"] == 0, r.json()
    assert ledger(client, outlet_id) == before


def test_a_batch_cannot_be_committed_twice(client, outlet_id):
    """Double-clicking Import must not book everything a second time."""
    stepup(client)
    cat = cat_id(client)
    preview = upload(client, outlet_id, APRIL).json()
    assert commit(client, preview, cat).status_code == 200
    before = ledger(client, outlet_id)

    again = commit(client, preview, cat)
    assert again.status_code in (404, 409, 410), again.text
    assert ledger(client, outlet_id) == before


def test_skipped_rows_are_not_recorded_as_imported(client, outlet_id):
    """A row you chose to skip must stay offerable next time, not vanish."""
    stepup(client)
    cat = cat_id(client)
    preview = upload(client, outlet_id, APRIL).json()
    decisions = [{"match_key": p["match_key"], "category_id": cat,
                  "vendor_id": None, "mode": "bank", "skip": True,
                  "remember": False} for p in preview["payees"]]
    client.post(f"/api/bank/{preview['batch_id']}/commit",
                json={"decisions": decisions})
    assert ledger(client, outlet_id) == (0, 0)

    again = upload(client, outlet_id, APRIL).json()
    assert again["already_imported"] == 0, "skipping is not importing"
    assert again["new_rows"] == 2, again


def test_the_database_itself_refuses_a_duplicate_key(client, outlet_id):
    """The backstop: a unique index, not just a read-then-insert check."""
    stepup(client)
    cat = cat_id(client)
    commit(client, upload(client, outlet_id, APRIL).json(), cat)

    from app.db import SessionLocal
    db = SessionLocal()
    try:
        key = db.query(Expense.idempotency_key).filter(
            Expense.idempotency_key.isnot(None)).first()[0]
        assert key
        db.add(Expense(outlet_id=outlet_id, business_date="2024-04-01",
                       category_id=cat, amount_paise=500, mode="bank",
                       description="forged duplicate", entered_by=1,
                       idempotency_key=key))
        raised = False
        try:
            db.commit()
        except Exception:
            raised = True
            db.rollback()
        assert raised, "the unique index did not block a duplicate key"
    finally:
        db.close()


def test_hand_entered_expenses_are_never_blocked_by_that_index(client, outlet_id):
    """Two identical manual expenses are legitimate - both carry no key."""
    stepup(client)
    cat = cat_id(client)
    body = {"outlet_id": outlet_id, "business_date": "2024-04-01",
            "category_id": cat, "amount_rupees": 250, "mode": "cash",
            "description": "Tea"}
    for _ in range(2):
        r = client.post("/api/expenses", json=body)
        assert r.status_code == 201, r.text
    assert ledger(client, outlet_id) == (2, 50000)
