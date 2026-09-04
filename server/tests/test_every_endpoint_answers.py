"""Every GET endpoint must answer, not crash.

A page that renders fine can still be backed by a query that throws the
moment real data reaches it. This walks every registered GET route on a
seeded ledger and fails on any 5xx - the errors no one sees until a
customer opens that screen.
"""
import pytest

from app.main import app

SAMPLE = {
    "outlet_id": "1", "employee_id": "1", "vendor_id": "1", "category_id": "1",
    "item_id": "1", "run_id": "1", "advance_id": "1", "user_id": "1",
    "day": "2026-09-04", "date": "2026-09-04", "business_date": "2026-09-04",
    "month": "2026-09", "id": "1", "path": "x.png", "name": "x",
}


def _get_routes():
    seen = []
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", set()) or set()
        if "GET" not in methods or not path.startswith("/api"):
            continue
        filled, ok = path, True
        for part in path.split("/"):
            if part.startswith("{") and part.endswith("}"):
                key = part[1:-1].split(":")[0]
                if key not in SAMPLE:
                    ok = False
                    break
                filled = filled.replace(part, SAMPLE[key])
        if ok:
            seen.append((path, filled))
    return sorted(set(seen))


ROUTES = _get_routes()


def test_the_sweep_actually_covers_the_api():
    assert len(ROUTES) >= 40, f"only found {len(ROUTES)} GET routes - discovery broke"


@pytest.mark.parametrize("template,url", ROUTES, ids=[r[0] for r in ROUTES])
def test_every_get_endpoint_answers(client, outlet_id, template, url):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    r = client.get(f"{url}?outlet_id={outlet_id}&month=2026-09&day=2026-09-04")
    assert r.status_code < 500, f"{template} returned {r.status_code}: {r.text[:400]}"
