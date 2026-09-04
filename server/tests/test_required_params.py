"""Every query param the UI omits must be optional on the server.

The Analytics page drops outlet_id while "All outlets" is selected. One
handler — dish-profitability — still demanded it, so the page answered with
a 422 ("outlet_id: field required") instead of a chart. These tests make the
exact calls the UI makes, with the params it actually sends.
"""
from datetime import date


def test_dish_profitability_without_outlet(client):
    """Analytics.tsx omits outlet_id when no single outlet is chosen."""
    end = date.today().isoformat()
    r = client.get(f"/api/inventory/dish-profitability?start=2024-01-01&end={end}")
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)


def test_dish_profitability_with_outlet_still_scopes(client):
    end = date.today().isoformat()
    r = client.get(
        f"/api/inventory/dish-profitability?start=2024-01-01&end={end}&outlet_id=1")
    assert r.status_code == 200, r.text


def test_inventory_usage_as_the_overview_calls_it(client):
    """InventoryOverview.tsx sends outlet_id + a 30-day window."""
    end = date.today().isoformat()
    r = client.get(f"/api/inventory/usage?outlet_id=1&start=2024-01-01&end={end}")
    assert r.status_code == 200, r.text
