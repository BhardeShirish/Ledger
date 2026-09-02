"""End-to-end formula audit: money math verified through the real API."""

from datetime import date

DAY = date.today().isoformat()
MONTH = DAY[:7]
DIM = {1: 31, 2: 28, 3: 31, 4: 30, 5: 31, 6: 30,
       7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}


def rupees(paise: int) -> float:
    return round(paise / 100, 2)


def set_cash_sales(client, outlet_id, amount, day=DAY):
    r = client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": day,
        "channel_kind": "cash", "amount_rupees": amount,
    })
    assert r.status_code in (200, 201), r.text


def add_cash_expense(client, outlet_id, amount, day=DAY):
    cats = client.get("/api/lists/categories").json()
    if cats:
        cid = cats[0]["id"]
    else:
        cid = client.post("/api/lists/categories", json={"name": "Audit"}).json()["id"]
    r = client.post("/api/expenses", json={
        "outlet_id": outlet_id, "business_date": day, "category_id": cid,
        "amount_rupees": amount, "mode": "cash", "description": "audit",
    })
    assert r.status_code in (200, 201), r.text


def test_cash_drawer_expected_equals_float_plus_cash_sales_minus_cash_out(
    client, outlet_id
):
    """expected = opening float + cash sales - cash expenses - advances."""
    set_cash_sales(client, outlet_id, 5000)
    add_cash_expense(client, outlet_id, 1200)

    day = client.get(f"/api/cash/day?outlet_id={outlet_id}&date={DAY}").json()
    assert day["cash_sales_paise"] == 5000 * 100
    assert day["cash_expenses_paise"] == 1200 * 100
    assert day["expected_paise"] == (
        day["opening_paise"]
        + day["cash_sales_paise"]
        - day["cash_expenses_paise"]
        - day["advances_given_paise"]
    )


def test_counted_cash_variance_is_counted_minus_expected(client, outlet_id):
    set_cash_sales(client, outlet_id, 4000)
    day = client.get(f"/api/cash/day?outlet_id={outlet_id}&date={DAY}").json()
    counted = rupees(day["expected_paise"]) - 250  # a real short-count

    closed = client.post("/api/cash/close", json={
        "outlet_id": outlet_id, "date": DAY, "counted_rupees": counted,
        "taken_home_rupees": 0, "breakdown": {}, "note": "audit",
    })
    assert closed.status_code == 200, closed.text
    assert closed.json()["variance_paise"] == -250 * 100


def test_closed_day_freezes_its_expectation(client, outlet_id):
    """Hindsight must not rewrite a day that was already counted and closed."""
    set_cash_sales(client, outlet_id, 1000)
    before = client.get(f"/api/cash/day?outlet_id={outlet_id}&date={DAY}").json()
    r = client.post("/api/cash/close", json={
        "outlet_id": outlet_id, "date": DAY,
        "counted_rupees": rupees(before["expected_paise"]),
        "taken_home_rupees": 0, "breakdown": {}, "note": "",
    })
    assert r.status_code == 200, r.text

    set_cash_sales(client, outlet_id, 9999)  # late-arriving sales, same day
    after = client.get(f"/api/cash/day?outlet_id={outlet_id}&date={DAY}").json()
    assert after["frozen"] is True
    assert after["expected_paise"] == before["expected_paise"]


def test_taken_home_leaves_the_rest_in_the_drawer(client, outlet_id):
    set_cash_sales(client, outlet_id, 3000)
    day = client.get(f"/api/cash/day?outlet_id={outlet_id}&date={DAY}").json()
    r = client.post("/api/cash/close", json={
        "outlet_id": outlet_id, "date": DAY,
        "counted_rupees": rupees(day["expected_paise"]),
        "taken_home_rupees": 1000, "breakdown": {}, "note": "",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["taken_home_paise"] == 1000 * 100
    assert body["left_in_drawer_paise"] == \
        body["counted_paise"] - body["taken_home_paise"]


def test_manual_sales_replace_rather_than_accumulate(client, outlet_id):
    """Re-entering a day's sales must correct it, never double it."""
    set_cash_sales(client, outlet_id, 1000)
    set_cash_sales(client, outlet_id, 2500)
    day = client.get(f"/api/cash/day?outlet_id={outlet_id}&date={DAY}").json()
    assert day["cash_sales_paise"] == 2500 * 100


def test_negative_sales_are_rejected(client, outlet_id):
    r = client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": DAY,
        "channel_kind": "cash", "amount_rupees": -1,
    })
    assert r.status_code == 422, r.text


def test_non_finite_sales_are_rejected(client, outlet_id):
    """Infinity/NaN are not valid JSON, so they must be sent raw to be tested."""
    for bad in ("Infinity", "-Infinity", "NaN"):
        body = (f'{{"outlet_id": {outlet_id}, "business_date": "{DAY}", '
                f'"channel_kind": "cash", "amount_rupees": {bad}}}')
        r = client.put("/api/sales/manual", content=body,
                       headers={"Content-Type": "application/json"})
        assert r.status_code == 422, f"{bad} was accepted: {r.text}"


def test_unknown_channel_kind_is_rejected(client, outlet_id):
    r = client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": DAY,
        "channel_kind": "bitcoin", "amount_rupees": 100,
    })
    assert r.status_code == 422, r.text


def test_breakeven_coverage_matches_sales_over_costs(client, outlet_id):
    add_cash_expense(client, outlet_id, 2000)
    set_cash_sales(client, outlet_id, 6000)

    b = client.get(
        f"/api/insights/breakeven?month={MONTH}&outlet_id={outlet_id}").json()
    total_cost = b["fixed_costs_rupees"] + b["variable_costs_rupees"]
    assert b["breakeven_met"] == (b["sales_rupees"] >= total_cost)
    if total_cost:
        assert abs(b["coverage_percent"]
                   - round(b["sales_rupees"] / total_cost * 100, 1)) <= 0.1
    dim = DIM[int(MONTH[5:7])]
    assert abs(b["fixed_cover_per_day_rupees"]
               - round(b["fixed_costs_rupees"] / dim, 2)) <= 0.02


def test_breakeven_handles_an_empty_month_without_dividing_by_zero(client, outlet_id):
    r = client.get(f"/api/insights/breakeven?month=2019-02&outlet_id={outlet_id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["sales_rupees"] == 0
    assert body["coverage_percent"] is None
    assert body["cost_per_bill_rupees"] is None
