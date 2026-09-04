"""Adding a category from the expense screen must actually produce a usable one.

The button set a state nobody rendered, so nothing happened. Two server-side
traps sat behind it: a blank name became a nameless category, and re-adding a
switched-off category returned "is_active": true without switching it back on,
so the picker kept hiding it and the button still looked dead.
"""


def _names(client):
    return {c["name"]: c for c in client.get("/api/lists/categories").json()}


def test_a_new_category_can_be_added_and_then_used(client, outlet_id):
    r = client.post("/api/lists/categories", json={"name": "Festival Sweets"})
    assert r.status_code == 201, r.text
    cat = r.json()
    assert cat["is_active"] is True

    listed = _names(client)
    assert "Festival Sweets" in listed
    assert listed["Festival Sweets"]["id"] == cat["id"]

    spend = client.post("/api/expenses", json={
        "outlet_id": outlet_id, "business_date": "2026-09-04",
        "category_id": cat["id"], "amount_rupees": 250})
    assert spend.status_code == 201, spend.text


def test_a_category_with_no_name_is_refused(client):
    before = len(_names(client))
    for blank in ("", "   ", "\t"):
        r = client.post("/api/lists/categories", json={"name": blank})
        assert r.status_code == 422, f"{blank!r} was accepted: {r.text}"
    assert len(_names(client)) == before


def test_re_adding_a_switched_off_category_switches_it_back_on(client):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    cat = client.post("/api/lists/categories", json={"name": "Seasonal"}).json()
    assert client.delete(f"/api/lists/categories/{cat['id']}").status_code == 200
    assert _names(client)["Seasonal"]["is_active"] is False

    again = client.post("/api/lists/categories", json={"name": "seasonal"})
    assert again.status_code == 201
    assert again.json()["id"] == cat["id"], "a duplicate row was created"
    assert _names(client)["Seasonal"]["is_active"] is True, (
        "the picker hides inactive categories, so this one is still invisible")
