"""Day losses: drawer math, the cash-short control, and validation."""
from app.util import today_iso


def _expected(client, outlet_id, date):
    r = client.get(f"/api/cash/day?outlet_id={outlet_id}&date={date}")
    assert r.status_code == 200, r.text
    return r.json()


def test_cash_refund_reduces_expected_drawer(client, outlet_id):
    d = today_iso()
    before = _expected(client, outlet_id, d)["expected_paise"]

    r = client.post("/api/losses", json={
        "outlet_id": outlet_id, "business_date": d, "kind": "refund",
        "amount_rupees": 250, "from_drawer": True, "note": "cold biryani"})
    assert r.status_code == 200, r.text
    assert r.json()["amount_paise"] == 25_000

    after = _expected(client, outlet_id, d)
    assert after["expected_paise"] == before - 25_000
    assert after["cash_losses_paise"] == 25_000


def test_drawer_paid_other_loss_and_refund_both_reduce_expected_drawer(client, outlet_id):
    d = today_iso()
    before = _expected(client, outlet_id, d)["expected_paise"]
    for kind, rupees in (("refund", 250), ("other", 75)):
        r = client.post("/api/losses", json={
            "outlet_id": outlet_id, "business_date": d, "kind": kind,
            "amount_rupees": rupees, "from_drawer": True})
        assert r.status_code == 200, r.text
    after = _expected(client, outlet_id, d)
    assert after["expected_paise"] == before - 32_500
    assert after["cash_losses_paise"] == 32_500


def test_cash_short_cannot_be_taken_from_the_drawer(client, outlet_id):
    """The whole point of the variance is to reveal a shortage; declaring one
    must not be able to cancel it."""
    d = today_iso()
    r = client.post("/api/losses", json={
        "outlet_id": outlet_id, "business_date": d, "kind": "cash_short",
        "amount_rupees": 500, "from_drawer": True})
    assert r.status_code == 422
    assert "drawer" in r.json()["detail"].lower()


def test_cash_short_is_recorded_but_leaves_the_variance_intact(client, outlet_id):
    d = today_iso()
    before = _expected(client, outlet_id, d)["expected_paise"]
    r = client.post("/api/losses", json={
        "outlet_id": outlet_id, "business_date": d, "kind": "cash_short",
        "amount_rupees": 150, "note": "till came up short"})
    assert r.status_code == 200, r.text

    after = _expected(client, outlet_id, d)
    assert after["expected_paise"] == before, "a shortage must not lower expectations"
    assert after["cash_losses_paise"] == 0

    rows = client.get(f"/api/losses?outlet_id={outlet_id}&date={d}").json()
    assert rows["total_paise"] == 15_000
    assert rows["from_drawer_paise"] == 0


def test_non_cash_kinds_never_touch_the_drawer(client, outlet_id):
    d = today_iso()
    before = _expected(client, outlet_id, d)["expected_paise"]
    for kind in ("spoilage", "breakage"):
        r = client.post("/api/losses", json={
            "outlet_id": outlet_id, "business_date": d, "kind": kind,
            "amount_rupees": 90})
        assert r.status_code == 200, r.text
        assert client.post("/api/losses", json={
            "outlet_id": outlet_id, "business_date": d, "kind": kind,
            "amount_rupees": 90, "from_drawer": True}).status_code == 422
    assert _expected(client, outlet_id, d)["expected_paise"] == before


def test_rejects_unknown_kind_and_bad_amounts(client, outlet_id):
    import json

    d = today_iso()
    base = {"outlet_id": outlet_id, "business_date": d, "kind": "refund"}
    assert client.post("/api/losses", json={
        **base, "kind": "shrinkage", "amount_rupees": 10}).status_code == 422
    for bad in (0, -5, "abc"):
        r = client.post("/api/losses", json={**base, "amount_rupees": bad})
        assert r.status_code == 422, f"{bad!r} was accepted"

    # NaN has no JSON literal, so it can only arrive as a raw body. It must be
    # refused rather than sail past the `amount <= 0` guard (NaN <= 0 is False).
    raw = json.dumps({**base, "amount_rupees": 1}).replace(
        '"amount_rupees": 1', '"amount_rupees": NaN')
    r = client.post("/api/losses", content=raw,
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 422, "NaN was accepted"


def test_deleting_a_refund_restores_expected_cash(client, outlet_id):
    d = today_iso()
    before = _expected(client, outlet_id, d)["expected_paise"]
    lid = client.post("/api/losses", json={
        "outlet_id": outlet_id, "business_date": d, "kind": "refund",
        "amount_rupees": 60, "from_drawer": True}).json()["id"]
    assert _expected(client, outlet_id, d)["expected_paise"] == before - 6_000
    assert client.delete(f"/api/losses/{lid}").status_code == 200
    assert _expected(client, outlet_id, d)["expected_paise"] == before


def test_day_sheet_reports_losses_and_net(client, outlet_id):
    d = today_iso()
    client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": d,
        "channel_kind": "cash", "amount_rupees": 1000})
    client.post("/api/losses", json={
        "outlet_id": outlet_id, "business_date": d, "kind": "refund",
        "amount_rupees": 100, "from_drawer": True})

    sheet = client.get(f"/api/sales/sheet?outlet_id={outlet_id}&date={d}").json()
    assert sheet["total_rupees"] == 1000
    assert sheet["losses_rupees"] == 100
    assert sheet["net_rupees"] == 900
    assert len(sheet["losses"]) == 1
    assert sheet["losses"][0]["label"] == "Refund / return to customer"
    assert {k["kind"] for k in sheet["loss_kinds"]} == {
        "refund", "cash_short", "spoilage", "breakage", "other"}


def test_future_dated_losses_are_refused(client, outlet_id):
    from datetime import date, timedelta
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    r = client.post("/api/losses", json={
        "outlet_id": outlet_id, "business_date": tomorrow, "kind": "refund",
        "amount_rupees": 10})
    assert r.status_code in (403, 422)


def test_losses_are_scoped_to_the_users_outlets(manager, client, outlet_id):
    d = today_iso()
    other = client.post("/api/outlets", json={"name": "Second"}).json()
    r = manager.post("/api/losses", json={
        "outlet_id": other["id"], "business_date": d, "kind": "refund",
        "amount_rupees": 10})
    assert r.status_code == 403


def test_losses_reduce_the_monthly_profit_estimate(client, outlet_id):
    """A refund or a smashed crate left the business; profit must show it."""
    d = today_iso()
    url = f"/api/stats/dashboard?month={d[:7]}&outlet_id={outlet_id}"

    before = client.get(url)
    assert before.status_code == 200, before.text
    base_profit = before.json()["profit_rupees"]
    assert base_profit is not None, "owner should see a profit figure"

    for kind, rupees in (("refund", 250), ("spoilage", 100), ("cash_short", 50)):
        r = client.post("/api/losses", json={
            "outlet_id": outlet_id, "business_date": d,
            "kind": kind, "amount_rupees": rupees})
        assert r.status_code == 200, r.text

    after = client.get(url).json()
    assert after["loss_total_rupees"] == 400
    assert round(base_profit - after["profit_rupees"], 2) == 400


def test_deleting_a_loss_restores_the_profit_estimate(client, outlet_id):
    d = today_iso()
    url = f"/api/stats/dashboard?month={d[:7]}&outlet_id={outlet_id}"
    base = client.get(url).json()["profit_rupees"]

    loss_id = client.post("/api/losses", json={
        "outlet_id": outlet_id, "business_date": d,
        "kind": "breakage", "amount_rupees": 75}).json()["id"]
    assert round(base - client.get(url).json()["profit_rupees"], 2) == 75

    assert client.delete(f"/api/losses/{loss_id}").status_code == 200
    assert client.get(url).json()["profit_rupees"] == base
