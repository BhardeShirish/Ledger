"""The bill list filters, searches and pages in SQL.

A busy outlet holds tens of thousands of bills, so the screen must never
depend on the server handing back the whole history.
"""


def seed_bills(outlet_id, specs):
    from app.db import SessionLocal
    from app.models import SalesBill

    db = SessionLocal()
    try:
        for invoice, ts, kind, area in specs:
            db.add(SalesBill(
                outlet_id=outlet_id, business_date=ts[:10], invoice_no=invoice,
                bill_ts=ts, order_type="Dine In", area=area, persons=2,
                channel_kind=kind, gross_paise=10_000, discount_paise=0,
                net_paise=10_000, charges_paise=0, tax_paise=500,
                roundoff_paise=0, tip_paise=0, total_paise=10_500))
        db.commit()
    finally:
        db.close()


SPECS = [
    ("5001", "2026-08-01 11:00:00", "cash", "Dining"),
    ("5002", "2026-08-01 12:00:00", "upi", "Terrace"),
    ("5003", "2026-08-01 13:00:00", "cash", "Dining"),
    ("5004", "2026-08-02 11:00:00", "card", "Terrace"),
    ("5005", "2026-08-02 12:00:00", "cash", "Garden 50%"),
]


def test_bill_list_pages_newest_first_without_repeating_rows(client, outlet_id):
    seed_bills(outlet_id, SPECS)

    first = client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "per_page": 2, "page": 1}).json()
    assert first["total"] == 5
    assert first["page"] == 1 and first["per_page"] == 2
    assert [r["invoice_no"] for r in first["rows"]] == ["5005", "5004"]

    second = client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "per_page": 2, "page": 2}).json()
    assert [r["invoice_no"] for r in second["rows"]] == ["5003", "5002"]
    assert second["total"] == 5

    last = client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "per_page": 2, "page": 3}).json()
    assert [r["invoice_no"] for r in last["rows"]] == ["5001"]

    seen = [r["id"] for page in (first, second, last) for r in page["rows"]]
    assert len(seen) == len(set(seen)) == 5
    # The split sheet reads the amount straight off a listed bill.
    assert first["rows"][0]["total_rupees"] == 105.0


def test_bill_list_filters_by_date_and_mode_on_the_server(client, outlet_id):
    seed_bills(outlet_id, SPECS)

    day = client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "business_date": "2026-08-01"}).json()
    assert day["total"] == 3
    assert {r["business_date"] for r in day["rows"]} == {"2026-08-01"}

    cash = client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "kind": "cash"}).json()
    assert cash["total"] == 3
    assert {r["channel_kind"] for r in cash["rows"]} == {"cash"}

    both = client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "business_date": "2026-08-02",
        "kind": "cash"}).json()
    assert [r["invoice_no"] for r in both["rows"]] == ["5005"]


def test_bill_search_matches_invoice_or_area_and_treats_wildcards_literally(
        client, outlet_id):
    seed_bills(outlet_id, SPECS)

    by_invoice = client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "q": "500"}).json()
    assert by_invoice["total"] == 5

    exact = client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "q": "5004"}).json()
    assert [r["invoice_no"] for r in exact["rows"]] == ["5004"]

    by_area = client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "q": "terrace"}).json()
    assert {r["invoice_no"] for r in by_area["rows"]} == {"5002", "5004"}

    # A typed % is text the user is looking for, not a wildcard.
    wildcard = client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "q": "%"}).json()
    assert [r["invoice_no"] for r in wildcard["rows"]] == ["5005"]

    nothing = client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "q": "nowhere"}).json()
    assert nothing["total"] == 0 and nothing["rows"] == []


def test_bill_list_rejects_unsafe_parameters(client, outlet_id):
    assert client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "business_date": "01-08-2026"}).status_code == 422
    assert client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "kind": "bogus"}).status_code == 422
    assert client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "page": 0}).status_code == 422
    assert client.get("/api/sales/bills", params={
        "outlet_id": outlet_id, "per_page": 5000}).status_code == 422


def test_bill_list_stays_inside_the_outlets_a_user_can_see(client, manager,
                                                           outlet_id):
    other = client.post("/api/outlets", json={"name": "Far Outlet"})
    assert other.status_code in (200, 201), other.text
    other_id = other.json()["id"]
    seed_bills(other_id, [("6001", "2026-08-01 11:00:00", "cash", "Dining")])

    assert manager.get("/api/sales/bills",
                       params={"outlet_id": outlet_id}).status_code == 200
    assert manager.get("/api/sales/bills",
                       params={"outlet_id": other_id}).status_code == 403
