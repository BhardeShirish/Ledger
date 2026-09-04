"""Kitchen tickets that never became a bill.

Every dine-in order starts as a kitchen ticket and should end as a bill.
A number that never reaches a bill means food left the kitchen with
nothing recorded against it.

The trap this guards against is accusing the kitchen on the strength of
an import quirk: bills that arrive with no ticket number leave their
numbers looking unused. So the answer is a range, and the lower end -
the one an owner would act on - must always credit those bills first.
"""
from app.db import SessionLocal
from app.models import SalesBill


def _bill(db, date, invoice, kot, net=500, outlet_id=1):
    db.add(SalesBill(
        outlet_id=outlet_id, business_date=date, invoice_no=invoice,
        bill_ts=f"{date} 13:00:00", order_type="Dine In", area="Dining",
        channel_kind="cash", gross_paise=int(net * 100), discount_paise=0,
        net_paise=int(net * 100), tip_paise=0, total_paise=int(net * 100),
        raw_json=({"kot_no": kot} if kot is not None else {})))


def _day(db, date, kots, *, unnumbered=0, net=500, outlet_id=1):
    for i, k in enumerate(kots):
        _bill(db, date, f"{date}-{i}", str(k), net=net, outlet_id=outlet_id)
    for i in range(unnumbered):
        _bill(db, date, f"{date}-u{i}", None, net=net, outlet_id=outlet_id)


def _gaps(client, **params):
    r = client.get("/api/patterns/kot-gaps", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _only(d):
    assert len(d["days"]) == 1, d["days"]
    return d["days"][0]


def test_an_unbroken_run_of_tickets_has_no_gap(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 2, 3, 4, 5])
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["missing_at_most"] == 0
    assert day["missing_at_least"] == 0


def test_a_ticket_that_never_became_a_bill_is_counted(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 2, 4, 5])
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["missing_at_most"] == 1
    assert day["missing_at_least"] == 1
    assert day["missing_numbers"] == ["3"]


def test_a_bill_with_no_ticket_number_is_credited_before_blaming_anyone(client):
    """One number is unused and one bill has no number: those are most
    likely the same order, so the figure worth acting on is zero."""
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 2, 4, 5], unnumbered=1)
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["missing_at_most"] == 1
    assert day["missing_at_least"] == 0


def test_unnumbered_bills_cannot_credit_more_than_the_gap(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 2, 3], unnumbered=5)
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["missing_at_least"] == 0


def test_the_range_is_reported_at_both_ends(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 5], unnumbered=1)
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["missing_at_most"] == 3
    assert day["missing_at_least"] == 2


def test_gaps_are_counted_inside_the_days_own_range(client):
    """A day that starts at ticket 40 has not lost tickets 1-39; the
    counter simply carried on from yesterday."""
    with SessionLocal() as db:
        _day(db, "2026-03-02", [40, 41, 42])
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["first"] == 40 and day["last"] == 42
    assert day["missing_at_most"] == 0


def test_one_days_tickets_do_not_leak_into_another(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 2, 3])
        _day(db, "2026-03-03", [1, 2, 3])
        db.commit()
    d = _gaps(client, start="2026-03-02", end="2026-03-03")
    assert d["totals"]["missing_at_least"] == 0
    assert len(d["days"]) == 2


def test_consecutive_missing_numbers_read_as_a_range(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 5, 6, 9])
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["missing_numbers"] == ["2-4", "7-8"]


def test_missing_numbers_that_are_not_neighbours_stay_apart(client):
    """41 and 43 are two separate holes, not one range — 42 was billed."""
    with SessionLocal() as db:
        _day(db, "2026-03-02", [41, 43, 45])
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["missing_numbers"] == ["42", "44"]


def test_a_ticket_number_that_is_not_a_number_is_no_number_at_all(client):
    """The POS occasionally writes a label like 'A-12' or leaves it blank.
    Guessing at those would fabricate tickets nobody raised."""
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 2, 3])
        _bill(db, "2026-03-02", "2026-03-02-x", "A-12")
        _bill(db, "2026-03-02", "2026-03-02-y", "")
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["tickets_seen"] == 3
    assert day["unnumbered_bills"] == 2


def test_a_ticket_number_stored_as_a_number_still_counts(client):
    """Older imports wrote kot_no as a string, newer ones as an integer."""
    with SessionLocal() as db:
        _bill(db, "2026-03-02", "2026-03-02-a", 1)
        _bill(db, "2026-03-02", "2026-03-02-b", 2)
        _bill(db, "2026-03-02", "2026-03-02-c", 4)
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["tickets_seen"] == 3
    assert day["unnumbered_bills"] == 0
    assert day["missing_numbers"] == ["3"]


def test_a_wall_of_numbers_is_cut_but_the_count_is_not(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 500])
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["missing_at_most"] == 498
    assert day["missing_numbers"] == ["2-61"]


def test_the_loss_is_valued_at_that_days_own_average_bill(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 2, 4], net=300)
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["value_at_least_rupees"] == 300.0


def test_a_day_with_no_ticket_numbers_at_all_says_so_rather_than_zero(client):
    """Silence is not a clean bill of health."""
    with SessionLocal() as db:
        _day(db, "2026-03-02", [], unnumbered=4)
        db.commit()
    day = _only(_gaps(client, start="2026-03-02", end="2026-03-02"))
    assert day["measurable"] is False
    assert day["missing_at_least"] == 0
    assert _gaps(client, start="2026-03-02",
                 end="2026-03-02")["totals"]["days_measurable"] == 0


def test_a_period_with_nothing_to_measure_refuses_to_congratulate(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [], unnumbered=3)
        db.commit()
    d = _gaps(client, start="2026-03-02", end="2026-03-02")
    titles = [f["title"] for f in d["findings"]]
    assert any("No kitchen ticket numbers" in t for t in titles)
    assert not any("Every kitchen ticket" in t for t in titles)


def test_a_clean_period_is_allowed_to_say_so(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 2, 3])
        db.commit()
    d = _gaps(client, start="2026-03-02", end="2026-03-02")
    assert any("Every kitchen ticket" in f["title"] for f in d["findings"])


def test_a_real_leak_is_raised_as_something_to_act_on(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 2, 10])
        db.commit()
    d = _gaps(client, start="2026-03-02", end="2026-03-02")
    top = d["findings"][0]
    assert top["severity"] == "act"
    assert "never became a bill" in top["title"]


def test_the_worst_day_is_named_with_numbers_to_look_up(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 2, 3])
        _day(db, "2026-03-03", [1, 9])
        db.commit()
    d = _gaps(client, start="2026-03-02", end="2026-03-03")
    assert d["worst_days"][0]["date"] == "2026-03-03"
    detail = next(f["detail"] for f in d["findings"] if "Worst day" in f["title"])
    assert "2-8" in detail


def test_the_share_of_bills_with_no_number_is_admitted(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 2, 3], unnumbered=1)
        db.commit()
    d = _gaps(client, start="2026-03-02", end="2026-03-02")
    assert any("carry no ticket number" in f["title"] for f in d["findings"])


def test_totals_add_up_across_days(client):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 3])
        _day(db, "2026-03-03", [1, 3])
        db.commit()
    t = _gaps(client, start="2026-03-02", end="2026-03-03")["totals"]
    assert t["missing_at_least"] == 2
    assert t["bills"] == 4
    assert t["tickets_seen"] == 4


def test_a_backwards_date_range_is_refused(client):
    r = client.get("/api/patterns/kot-gaps",
                   params={"start": "2026-03-10", "end": "2026-03-01"})
    assert r.status_code == 422


def test_only_your_own_outlets_are_counted(client, manager):
    with SessionLocal() as db:
        _day(db, "2026-03-02", [1, 5], outlet_id=1)
        db.commit()
    mine = _gaps(client, start="2026-03-02", end="2026-03-02")
    assert mine["totals"]["missing_at_least"] == 3
    r = manager.get("/api/patterns/kot-gaps",
                    params={"start": "2026-03-02", "end": "2026-03-02",
                            "outlet_id": 999})
    assert r.status_code in (403, 404)


def test_the_page_needs_a_login(client):
    from fastapi.testclient import TestClient

    from app.main import app
    assert TestClient(app).get("/api/patterns/kot-gaps").status_code == 401
