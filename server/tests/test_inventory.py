"""Inventory: auto-ingest, dedupe, wastage, counts, order list,
auto-recipe learning goldens."""
from datetime import date, timedelta


def _today():
    return date.today().isoformat()


def _d_ago(n):
    return (date.today() - timedelta(days=n)).isoformat()


def _buy(client, outlet_id, cat_id, vendor_id, item, qty, day, total):
    return client.post("/api/expenses", json={
        "outlet_id": outlet_id, "business_date": day,
        "category_id": cat_id, "vendor_id": vendor_id,
        "amount_rupees": total, "mode": "cash",
        "item_name": item, "quantity": qty, "unit": "kg"},)


def test_autocreate_and_dedupe(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    cats = client.get("/api/lists/categories").json()
    rc = next(c for c in cats if c["name"].lower().startswith("raw"))
    v = client.post("/api/vendors", json={"name": "Inv Vendor"}).json()

    def basmati_rows():
        inv = client.get("/api/inventory/overview",
                         params={"outlet_id": outlet_id}).json()
        return [x for x in inv["items"]
                if " ".join(x["name"].lower().split()) == "basmati rice"]

    before = basmati_rows()
    before_qty = sum(x["current_qty"] for x in before)
    _buy(client, outlet_id, rc["id"], v["id"], "Basmati Rice", 10, _d_ago(5), 800)
    _buy(client, outlet_id, rc["id"], v["id"], "basmati  rice", 5, _d_ago(2), 450)

    after = basmati_rows()
    assert len(after) == (1 if not before else len(before)), "dedupe failed"
    after_qty = sum(x["current_qty"] for x in after)
    assert abs(after_qty - before_qty - 15) < 0.01      # +10 and +5 landed on ONE item


def test_wastage_flow(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    cats = client.get("/api/lists/categories").json()
    rc = next(c for c in cats if c["name"].lower().startswith("raw"))
    v = client.post("/api/vendors", json={"name": "Wastage Vendor"}).json()
    _buy(client, outlet_id, rc["id"], v["id"], "Paneer W", 10, _d_ago(3), 3000)
    inv = client.get("/api/inventory/overview", params={"outlet_id": outlet_id}).json()
    paneer = next(x for x in inv["items"] if "Paneer W" in x["name"])
    r = client.post("/api/inventory/wastage", json={
        "outlet_id": outlet_id, "business_date": _today(),
        "stock_item_id": paneer["id"], "qty": 2, "reason": "spoiled"})
    assert r.status_code == 201
    assert r.json()["cost_rupees"] == 600.0
    inv2 = client.get("/api/inventory/overview", params={"outlet_id": outlet_id}).json()
    paneer2 = next(x for x in inv2["items"] if "Paneer W" in x["name"])
    assert abs(paneer2["current_qty"] - 8) < 0.01
    wl = client.get("/api/inventory/wastage", params={
        "outlet_id": outlet_id, "start": _today(), "end": _today()}).json()
    assert wl[0]["reason"] == "spoiled"


def test_count_trueup_and_shrinkage(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    cats = client.get("/api/lists/categories").json()
    rc = next(c for c in cats if c["name"].lower().startswith("raw"))
    v = client.post("/api/vendors", json={"name": "Count Vendor"}).json()
    _buy(client, outlet_id, rc["id"], v["id"], "Counted Item", 20, _d_ago(4), 2000)
    inv = client.get("/api/inventory/overview", params={"outlet_id": outlet_id}).json()
    it = next(x for x in inv["items"] if x["name"] == "Counted Item")

    sc = client.post("/api/inventory/count/start",
                     params={"outlet_id": outlet_id}).json()
    lines = client.get(f"/api/inventory/count/{sc['count_id']}").json()["lines"]
    tgt = next(l for l in lines if l["stock_item_id"] == it["id"])
    incomplete = client.post(f"/api/inventory/count/{sc['count_id']}/done",
                             json={"lines": []})
    assert incomplete.status_code == 422
    submitted = [
        {
            "stock_item_id": line["stock_item_id"],
            "counted_qty": 17 if line["stock_item_id"] == it["id"]
                           else line["system_qty"],
        }
        for line in lines
    ]
    done = client.post(f"/api/inventory/count/{sc['count_id']}/done", json={
        "lines": submitted})  # 3kg missing
    assert done.status_code == 200
    assert done.json()["shrinkage_rupees"] == 300.0
    inv2 = client.get("/api/inventory/overview", params={"outlet_id": outlet_id}).json()
    it2 = next(x for x in inv2["items"] if x["name"] == "Counted Item")
    assert abs(it2["current_qty"] - 17) < 0.01


def test_order_list_withholds_par_order_without_consumption_evidence(client, outlet_id):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    cats = client.get("/api/lists/categories").json()
    rc = next(c for c in cats if c["name"].lower().startswith("raw"))
    v = client.post("/api/vendors", json={"name": "Par Vendor"}).json()
    _buy(client, outlet_id, rc["id"], v["id"], "Par Item", 5, _d_ago(2), 500)
    inv = client.get("/api/inventory/overview", params={"outlet_id": outlet_id}).json()
    it = next(x for x in inv["items"] if x["name"] == "Par Item")
    client.patch(f"/api/inventory/items/{it['id']}",
                 json={"par_qty": 40, "min_qty": 10})
    order = client.get("/api/inventory/order", params={
        "outlet_id": outlet_id}).json()
    assert not any(row["item"] == "Par Item" for row in order)


def test_learning_golden(client, outlet_id):
    """4 weeks: buy 40kg rice each Sunday; sell 100 plates Jeera Rice weekly.
    coefficient ≈ 0.4 kg/plate; usage estimate = 0.4 × sold."""
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    cats = client.get("/api/lists/categories").json()
    rc = next(c for c in cats if c["name"].lower().startswith("raw"))
    v = client.post("/api/vendors", json={"name": "Learn Vendor"}).json()

    today = date.today()
    monday_this_week = today - timedelta(days=today.weekday())
    for w in range(4, 0, -1):
        sunday = monday_this_week - timedelta(weeks=w)  # a day in each past week
        _buy(client, outlet_id, rc["id"], v["id"], "Learn Rice", 40,
             sunday.isoformat(), 4000)

    # dish sales on Tue/Thu of each past week (same weeks)
    for w in range(4, 0, -1):
        for off in (1, 3):
            day = monday_this_week - timedelta(weeks=w) + timedelta(days=off)
            client.post(f"/api/data/import/sales_items?outlet_id={outlet_id}",
                        files={"file": ("i.xlsx", _items_xlsx(day.isoformat(), 50),
                                        "application/octet-stream")})

    learn = client.get("/api/inventory/learn", params={
        "outlet_id": outlet_id}).json()
    sug = next(s for s in learn["suggestions"]
               if s["menu_item"] == "Jeera Rice" and s["stock_item"] == "Learn Rice")
    assert sug["coefficient"] == 0.4          # 40kg ÷ 100 plates
    assert sug["confidence"] in ("learning", "stable")

    # confirm → usage engine
    client.put("/api/insights/links" if False else "/api/inventory/links",
               params={"outlet_id": outlet_id}, json={
                   "stock_item_id": sug["stock_item_id"],
                   "menu_item_name": "Jeera Rice",
                   "coefficient": 0.4, "status": "confirmed"})
    start = (monday_this_week - timedelta(weeks=4)).isoformat()
    u = client.get("/api/inventory/usage", params={
        "outlet_id": outlet_id, "start": start, "end": _today()}).json()
    assert u["links_used"] >= 1
    assert abs(u["usage_value_rupees"] - 16000) < 1   # 4wk × 100 plates × 0.4kg × ₹100
    assert u["purchase_value_rupees"] >= 16000        # includes other tests' buys
    assert abs(u["variance_rupees"] -
               (u["purchase_value_rupees"] - u["usage_value_rupees"])) < 0.01
    assert "food_cost_percent" in u


def _items_xlsx(day, plates):
    import io
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Items"
    ws.append(["Date", "Item", "Category", "Qty", "Amount"])
    ws.append([day, "Jeera Rice", "Main Course", plates, plates * 120])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
