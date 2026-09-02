"""Every page's API is reachable, and a signed-in session keeps working."""

from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.main import app

TODAY = date.today().isoformat()
MONTH = TODAY[:7]

# Query arguments the page routers need; anything absent uses no parameters.
PAGE_QUERY = {
    "/api/advances": {"month": MONTH},
    "/api/attendance/grid": {"start": TODAY},
    "/api/attendance/month-overview": {"month": MONTH},
    "/api/attendance/month-summary": {"month": MONTH},
    "/api/cash/day": {"date": TODAY},
    "/api/cash/closures": {"month": MONTH},
    "/api/expenses": {"month": MONTH},
    "/api/insights/anomalies": {"month": MONTH},
    "/api/insights/benchmark": {"month": MONTH},
    "/api/insights/breakeven": {"month": MONTH},
    "/api/insights/budgets": {"month": MONTH},
    "/api/insights/forecast": {"month": MONTH},
    "/api/insights/items": {"month": MONTH},
    "/api/insights/unit-economics": {"month": MONTH},
    "/api/inventory/dish-profitability": {"month": MONTH},
    "/api/inventory/usage": {"month": MONTH},
    "/api/reports/ca-pack": {"month": MONTH},
    "/api/sales/bills": {"date": TODAY},
    "/api/sales/sheet": {"month": MONTH},
    "/api/stats/analytics": {"month": MONTH},
    "/api/stats/dashboard": {"date": TODAY},
    "/api/stats/home": {"date": TODAY},
    "/api/stats/offday-coverage": {"month": MONTH},
}

# Downloads and docs are not page data; path-parameter routes need real ids.
SKIP = {"/api/docs", "/api/openapi.json", "/api/admin/backup/download"}


def page_endpoints() -> list[str]:
    return sorted(
        route.path
        for route in app.routes
        if getattr(route, "methods", None)
        and "GET" in route.methods
        and route.path.startswith("/api")
        and "{" not in route.path
        and route.path not in SKIP
    )


@pytest.mark.parametrize("path", page_endpoints())
def test_page_endpoint_is_reachable(client, path):
    response = client.get(path, params=PAGE_QUERY.get(path, {}))
    assert response.status_code != 404, f"{path} is missing"
    assert response.status_code < 500, f"{path} failed: {response.text[:200]}"


def test_signed_in_browser_is_not_asked_to_log_in_again(client):
    """The cookie session a browser receives must keep working on its own."""
    browser = TestClient(app)
    signin = browser.post(
        "/api/auth/login",
        json={"username": "owner", "password": "change-me-please", "remember": True},
    )
    assert signin.status_code == 200, signin.text
    # No Authorization header: exactly what the browser sends on later visits.
    assert "Authorization" not in browser.headers

    for _ in range(3):
        assert browser.get("/api/auth/me").status_code == 200


def test_sessions_last_long_enough_for_daily_use():
    from app.config import TOKEN_TTL_HOURS

    assert TOKEN_TTL_HOURS >= 24 * 30, "a local ledger should not expire weekly"
