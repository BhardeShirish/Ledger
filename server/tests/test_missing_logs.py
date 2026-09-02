"""The catch-up reminder: which past days still have nothing recorded."""
from datetime import date, timedelta

from app.util import today_iso


def _dates(rows, kind):
    return sorted({r["date"] for r in rows if r["type"] == kind})


def test_quiet_on_a_brand_new_ledger(client, outlet_id):
    """Nothing recorded ever means nothing to catch up on - otherwise a fresh
    install would report every day since the beginning of time."""
    assert client.get("/api/insights/missing-logs").json() == []


def test_reports_the_days_with_no_sales(client, outlet_id):
    two = (date.today() - timedelta(days=2)).isoformat()
    one = (date.today() - timedelta(days=1)).isoformat()
    client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": two,
        "channel_kind": "cash", "amount_rupees": 500})

    rows = client.get("/api/insights/missing-logs?days=5").json()
    missing = _dates(rows, "sales")
    assert one in missing, "yesterday had no sales and should be flagged"
    assert two not in missing, "the day with sales must not be flagged"


def test_never_nags_about_today_or_the_future(client, outlet_id):
    today = today_iso()
    client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": (date.today() - timedelta(days=3)).isoformat(),
        "channel_kind": "cash", "amount_rupees": 100})
    rows = client.get("/api/insights/missing-logs?days=10").json()
    assert all(r["date"] < today for r in rows)


def test_never_nags_about_days_before_the_ledger_began(client, outlet_id):
    began = (date.today() - timedelta(days=3)).isoformat()
    client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": began,
        "channel_kind": "cash", "amount_rupees": 100})
    rows = client.get("/api/insights/missing-logs?days=30").json()
    assert all(r["date"] >= began for r in rows), \
        "flagged a day from before this outlet was ever used"


def test_flags_an_uncounted_drawer_only_when_there_were_sales(client, outlet_id):
    day = (date.today() - timedelta(days=1)).isoformat()
    client.put("/api/sales/manual", json={
        "outlet_id": outlet_id, "business_date": day,
        "channel_kind": "cash", "amount_rupees": 800})
    rows = client.get("/api/insights/missing-logs?days=5").json()
    assert day in _dates(rows, "cash")

    client.post("/api/cash/close", json={
        "outlet_id": outlet_id, "date": day, "counted_rupees": 800})
    rows = client.get("/api/insights/missing-logs?days=5").json()
    assert day not in _dates(rows, "cash"), "a counted drawer is still reported"


def test_rows_carry_a_link_to_the_page_that_fixes_them(client, outlet_id):
    client.put("/api/sales/manual", json={
        "outlet_id": outlet_id,
        "business_date": (date.today() - timedelta(days=2)).isoformat(),
        "channel_kind": "cash", "amount_rupees": 100})
    rows = client.get("/api/insights/missing-logs?days=5").json()
    assert rows, "expected at least one gap"
    for r in rows:
        assert r["link"].startswith("/")
        assert r["outlet"]
        assert r["detail"]


def test_window_is_clamped(client, outlet_id):
    client.put("/api/sales/manual", json={
        "outlet_id": outlet_id,
        "business_date": (date.today() - timedelta(days=2)).isoformat(),
        "channel_kind": "cash", "amount_rupees": 100})
    for days in (0, -5, 9999):
        assert client.get(f"/api/insights/missing-logs?days={days}").status_code == 200
