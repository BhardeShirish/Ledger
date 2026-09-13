"""The recovery importer, exercised on a database built to hurt it.

The synthetic "old" database deliberately uses different primary keys for
the same outlet and category, because that is exactly what two independent
installations do, and an importer that copies ids instead of meaning would
book every recovered expense against the wrong outlet while reporting
success.
"""
import sqlite3

import pytest
from sqlalchemy import create_engine

from app.db import Base
from app.recovery_import import ImportError_, import_database


def make_db(path):
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(bind=engine)
    engine.dispose()
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


OUTLET_SQL = (
    "INSERT INTO outlets (id, name, address, phone, opening_float_paise,"
    " is_active, created_at) VALUES (?, ?, '', '', 0, 1, '2026-09-01 00:00:00')"
)
USER_SQL = (
    "INSERT INTO users (id, username, full_name, password_hash, role,"
    " is_active, failed_attempts, created_at)"
    " VALUES (?, 'owner', 'Owner', 'x', 'owner', 1, 0, '2026-09-01 00:00:00')"
)


def seed_live(conn):
    conn.execute(OUTLET_SQL, (1, "Main Kitchen"))
    conn.execute(
        "INSERT INTO expense_categories (id, name, is_active, sort, cost_group)"
        " VALUES (1, 'Vegetables', 1, 0, 'cogs')"
    )
    conn.execute(USER_SQL, (1,))
    conn.commit()


def seed_recovered(conn):
    # Same outlet and category as the live database, different ids.
    conn.execute(OUTLET_SQL, (7, "Main Kitchen"))
    conn.execute(OUTLET_SQL, (8, "Terrace"))
    conn.execute(
        "INSERT INTO expense_categories (id, name, is_active, sort, cost_group)"
        " VALUES (9, 'Vegetables', 1, 0, 'cogs')"
    )
    conn.execute(
        "INSERT INTO expense_categories (id, name, is_active, sort, cost_group)"
        " VALUES (10, 'Gas', 1, 0, 'operating')"
    )
    conn.execute(
        "INSERT INTO vendors (id, name, phone, notes, is_active)"
        " VALUES (3, 'Ramesh Traders', '9999999999', '', 1)"
    )
    conn.execute(USER_SQL, (42,))
    rows = [
        (1, 7, "2026-09-01", 9, 3, 125000, "cash", "Onions 20kg", "Onion", 20.0, "kg"),
        (2, 7, "2026-09-05", 10, None, 90000, "upi", "Gas cylinder", "", None, ""),
        (3, 8, "2026-09-09", 9, 3, 47550, "upi", "Tomatoes", "Tomato", 9.0, "kg"),
    ]
    for (
        eid, outlet, date, cat, vendor, paise, mode, desc, item, qty, unit
    ) in rows:
        conn.execute(
            "INSERT INTO expenses (id, outlet_id, business_date, category_id,"
            " vendor_id, amount_paise, mode, description, item_name, quantity,"
            " unit, entered_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,42,"
            " '2026-09-09 10:00:00')",
            (eid, outlet, date, cat, vendor, paise, mode, desc, item, qty, unit),
        )
    conn.commit()


@pytest.fixture()
def dbs(tmp_path):
    live_path = tmp_path / "live.db"
    old_path = tmp_path / "recovered.db"
    live = make_db(live_path)
    old = make_db(old_path)
    seed_live(live)
    seed_recovered(old)
    live.close()
    old.close()
    return old_path, live_path


def expenses(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(
            "SELECT e.*, o.name AS outlet, c.name AS category"
            " FROM expenses e JOIN outlets o ON o.id = e.outlet_id"
            " JOIN expense_categories c ON c.id = e.category_id"
            " ORDER BY e.business_date"
        )]
    finally:
        conn.close()


def test_rehearsal_writes_nothing(dbs):
    old, live = dbs
    result = import_database(old, live)

    assert result["applied"] is False
    assert result["tables"]["expenses"]["inserted"] == 3
    assert expenses(live) == []


def test_apply_remaps_by_name_not_by_id(dbs):
    old, live = dbs
    result = import_database(old, live, apply=True)

    assert result["tables"]["expenses"]["inserted"] == 3
    assert result["date_ranges"]["expenses"] == ["2026-09-01", "2026-09-09"]
    # The live outlet was reused, the unknown one created: two, not three.
    assert result["tables"]["outlets"]["matched"] == 1
    assert result["tables"]["outlets"]["inserted"] == 1

    rows = expenses(live)
    assert [r["amount_paise"] for r in rows] == [125000, 90000, 47550]
    first = rows[0]
    assert first["outlet"] == "Main Kitchen"
    assert first["outlet_id"] == 1          # live id, not the recovered 7
    assert first["category"] == "Vegetables"
    assert first["category_id"] == 1
    assert first["quantity"] == 20.0 and first["unit"] == "kg"
    assert first["entered_by"] == 1         # owner matched by username
    assert rows[2]["outlet"] == "Terrace"


def test_second_run_adds_nothing(dbs):
    old, live = dbs
    import_database(old, live, apply=True)
    again = import_database(old, live, apply=True)

    assert again["tables"]["expenses"]["inserted"] == 0
    assert again["tables"]["expenses"]["matched"] == 3
    assert len(expenses(live)) == 3


def test_damaged_rows_do_not_stop_the_rest(dbs, tmp_path):
    old, live = dbs
    # A vendor id that no longer exists anywhere: the link is optional, so
    # the money must still come back, just without the vendor.
    conn = sqlite3.connect(old)
    conn.execute(
        "INSERT INTO expenses (id, outlet_id, business_date, category_id,"
        " vendor_id, amount_paise, mode, description, item_name, unit,"
        " created_at) VALUES (99, 7, '2026-09-02', 9, 555, 30000, 'cash',"
        " 'Coriander', 'Coriander', 'kg', '2026-09-02 09:00:00')"
    )
    conn.commit()
    conn.close()

    result = import_database(old, live, apply=True)
    assert result["tables"]["expenses"]["inserted"] == 4
    orphan = [r for r in expenses(live) if r["description"] == "Coriander"][0]
    assert orphan["vendor_id"] is None
    assert orphan["amount_paise"] == 30000


def test_folder_of_fragments_is_merged_as_a_union(dbs, tmp_path):
    """Two partial copies, one zipped, must add up to everything."""
    import shutil
    import zipfile

    from app.recovery_import import find_databases, import_databases, unpack_archives

    old, live = dbs
    scattered = tmp_path / "fragments"
    scattered.mkdir()
    # A loose fragment, and the same-era copy buried in an archive. The
    # archive copy carries one expense the loose one never had.
    shutil.copy(old, scattered / "ledger.db")
    extra = tmp_path / "extra.db"
    shutil.copy(old, extra)
    conn = sqlite3.connect(extra)
    conn.execute(
        "INSERT INTO expenses (id, outlet_id, business_date, category_id,"
        " vendor_id, amount_paise, mode, description, item_name, unit,"
        " created_at) VALUES (77, 7, '2026-08-28', 9, NULL, 15000, 'cash',"
        " 'Milk', 'Milk', 'l', '2026-08-28 08:00:00')"
    )
    conn.commit()
    conn.close()
    with zipfile.ZipFile(scattered / "evidence.zip", "w") as bundle:
        bundle.write(extra, "01_MASTER/ledger.db")
    # A truncated bundle must not abort the run.
    (scattered / "broken.zip").write_bytes(b"PK\x03\x04 not really a zip")

    unpack_archives(scattered)
    # A stray Windows database from the same deep scan must be left alone.
    stranger = scattered / "SecStore.db"
    other = sqlite3.connect(stranger)
    other.execute("CREATE TABLE secrets (id INTEGER PRIMARY KEY, blob TEXT)")
    other.execute("INSERT INTO secrets (blob) VALUES ('x')")
    other.commit()
    other.close()

    sources, strangers = find_databases(scattered)
    assert len(sources) == 2
    assert strangers == 1

    result = import_databases(sources, live, apply=True)
    assert result["tables"]["expenses"]["inserted"] == 4
    assert result["date_ranges"]["expenses"] == ["2026-08-28", "2026-09-09"]
    assert len(expenses(live)) == 4


def test_reports_the_money_not_just_the_row_count(dbs):
    from app.recovery_import import money_out_totals, rupees

    old, live = dbs
    result = import_database(old, live)

    assert result["money_out_before"] == {}
    assert result["money_out_after"]["expenses"]["2026-09"] == (3, 262550)
    # The owner remembers lakhs, so the grouping has to be Indian.
    assert rupees(90000000) == "9,00,000.00"
    assert rupees(262550) == "2,625.50"


def test_money_out_counts_vendor_credit_and_advances_without_double_counting(dbs):
    """Spending hides in three tables, and one of them can double-count."""
    from app.recovery_import import money_out_totals

    _, live = dbs
    conn = sqlite3.connect(live)
    try:
        conn.execute(
            "INSERT INTO expenses (id, outlet_id, business_date, category_id,"
            " amount_paise, mode, description, item_name, unit, entered_by,"
            " created_at) VALUES (1, 1, '2026-09-02', 1, 500000, 'cash',"
            " 'Rice', '', '', 1, '2026-09-02 10:00:00')"
        )
        for eid, kind, paise, expense_id in [
            (1, "purchase_credit", 300000, None),   # unpaid purchase: counts
            (2, "purchase_credit", 500000, 1),      # already an expense: must not
            (3, "payment", 300000, None),           # settling a debt: must not
        ]:
            conn.execute(
                "INSERT INTO vendor_entries (id, vendor_id, outlet_id, date,"
                " type, amount_paise, expense_id, note)"
                " VALUES (?, 1, 1, '2026-09-02', ?, ?, ?, '')",
                (eid, kind, paise, expense_id),
            )
        conn.execute(
            "INSERT INTO advances (id, employee_id, date, amount_paise,"
            " remaining_paise, status, note)"
            " VALUES (1, 1, '2026-09-03', 200000, 200000, 'open', '')"
        )
        conn.commit()
        totals = money_out_totals(conn)
    finally:
        conn.close()

    assert totals["expenses"]["2026-09"] == (1, 500000)
    assert totals["vendor credit"]["2026-09"] == (1, 300000)
    assert totals["staff advances"]["2026-09"] == (1, 200000)
    grand = sum(v[1] for source in totals.values() for v in source.values())
    assert grand == 1000000  # not 1,800,000: the payment and the linked row


def test_missing_file_is_reported_plainly(tmp_path):
    with pytest.raises(ImportError_):
        import_database(tmp_path / "nope.db", tmp_path / "also-nope.db")
