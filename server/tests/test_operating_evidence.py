"""Evidence gates for menu engineering and service-period planning."""
from datetime import date, timedelta

from app.db import SessionLocal
from app.models import (Attendance, Employee, SalesBill, SalesDaily, SalesItem,
                        StockItem, StockLink, StockMovement)


def _window(days: int = 55) -> tuple[str, str]:
    end = date.today() - timedelta(days=1)
    return (end - timedelta(days=days)).isoformat(), end.isoformat()


def _stock(db, outlet_id: int, name: str) -> StockItem:
    item = StockItem(outlet_id=outlet_id, name=name, name_key=name.lower(), base_unit="kg")
    db.add(item)
    db.flush()
    return item


def test_partial_recipe_withholds_food_cost_and_contribution(client, outlet_id):
    start, end = _window(28)
    with SessionLocal() as db:
        rice, oil = _stock(db, outlet_id, "ME Rice"), _stock(db, outlet_id, "ME Oil")
        db.add_all([
            SalesItem(outlet_id=outlet_id, business_date=end, item_name="Partial bowl",
                      qty=2, amount_paise=20_000),
            StockLink(outlet_id=outlet_id, stock_item_id=rice.id, menu_item_name="Partial bowl",
                      coefficient=.2, status="confirmed"),
            StockLink(outlet_id=outlet_id, stock_item_id=oil.id, menu_item_name="Partial bowl",
                      coefficient=.1, status="suggested"),
            StockMovement(outlet_id=outlet_id, stock_item_id=rice.id, business_date=end,
                          type="purchase", qty=5, unit_cost_paise=8_000),
        ])
        db.commit()

    response = client.get("/api/insights/menu-engineering", params={
        "outlet_id": outlet_id, "start": start, "end": end,
    })
    assert response.status_code == 200, response.text
    row = response.json()["items"][0]
    assert row["cost_status"] == "withheld"
    assert "partial" in row["cost_withheld_reason"].lower()
    assert "food_cost_per_dish_rupees" not in row
    assert "recorded_contribution_after_food_cost_rupees" not in row
    assert not any("margin" in key for key in row)


def test_confirmed_recipe_uses_latest_compatible_quantity_tracked_cost(client, outlet_id):
    start, end = _window(28)
    with SessionLocal() as db:
        rice = _stock(db, outlet_id, "Confirmed Rice")
        db.add_all([
            SalesItem(outlet_id=outlet_id, business_date=end, item_name="Confirmed bowl",
                      qty=2, amount_paise=20_000),
            StockLink(outlet_id=outlet_id, stock_item_id=rice.id, menu_item_name="Confirmed bowl",
                      coefficient=.25, status="confirmed"),
            StockMovement(outlet_id=outlet_id, stock_item_id=rice.id, business_date=end,
                          type="purchase", qty=10, unit_cost_paise=8_000),
        ])
        db.commit()

    response = client.get("/api/insights/menu-engineering", params={
        "outlet_id": outlet_id, "start": start, "end": end,
    })
    assert response.status_code == 200, response.text
    row = response.json()["items"][0]
    assert row["cost_status"] == "recorded"
    assert row["food_cost_per_dish_rupees"] == 20.0
    assert row["food_cost_percent"] == 20.0
    assert row["recorded_contribution_after_food_cost_rupees"] == 160.0


def test_staffing_withholds_without_timed_pos_and_clocked_history(client, outlet_id):
    start, end = _window(28)
    with SessionLocal() as db:
        db.add(SalesDaily(outlet_id=outlet_id, business_date=end, channel_kind="cash",
                          source="manual", amount_paise=999_999))
        db.commit()
    response = client.get("/api/stats/staffing-plan", params={
        "outlet_id": outlet_id, "start": start, "end": end,
    })
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["recommendations"] == []
    assert result["data_quality"]["recommendations_withheld_reason"]
    assert result["data_quality"]["manual_daily_sales_excluded"] is True


def test_manual_daily_sales_do_not_change_service_hour_evidence(client, outlet_id):
    start, end = _window()
    with SessionLocal() as db:
        employee = Employee(outlet_id=outlet_id, name="Clocked planner")
        db.add(employee)
        db.flush()
        cursor = date.fromisoformat(start)
        index = 0
        while cursor <= date.fromisoformat(end):
            if cursor.weekday() == 0:
                day = cursor.isoformat()
                db.add_all([
                    Attendance(employee_id=employee.id, business_date=day, status="P",
                               in_min=11 * 60, out_min=13 * 60),
                    SalesBill(outlet_id=outlet_id, business_date=day, invoice_no=f"plan-{index}",
                              bill_ts=f"{day} 12:15:00", total_paise=10_000),
                ])
                index += 1
            cursor += timedelta(days=1)
        db.commit()

    params = {"outlet_id": outlet_id, "start": start, "end": end}
    before = client.get("/api/stats/staffing-plan", params=params)
    assert before.status_code == 200, before.text
    with SessionLocal() as db:
        db.add(SalesDaily(outlet_id=outlet_id, business_date=end, channel_kind="cash",
                          source="manual", amount_paise=99_999_999))
        db.commit()
    after = client.get("/api/stats/staffing-plan", params=params)
    assert after.status_code == 200, after.text
    assert after.json()["demand_bands"] == before.json()["demand_bands"]
    assert after.json()["recommendations"] == before.json()["recommendations"]


def test_menu_evidence_is_outlet_isolated(client, outlet_id):
    other = client.post("/api/outlets", json={"name": "Menu evidence other outlet"}).json()["id"]
    start, end = _window(28)
    with SessionLocal() as db:
        local, foreign = _stock(db, outlet_id, "Local ingredient"), _stock(db, other, "Foreign ingredient")
        db.add_all([
            SalesItem(outlet_id=outlet_id, business_date=end, item_name="Local dish", qty=1, amount_paise=10_000),
            SalesItem(outlet_id=other, business_date=end, item_name="Other dish", qty=1, amount_paise=10_000),
            StockLink(outlet_id=outlet_id, stock_item_id=local.id, menu_item_name="Local dish",
                      coefficient=.1, status="confirmed"),
            StockLink(outlet_id=other, stock_item_id=foreign.id, menu_item_name="Other dish",
                      coefficient=.1, status="confirmed"),
            StockMovement(outlet_id=outlet_id, stock_item_id=local.id, business_date=end,
                          type="purchase", qty=2, unit_cost_paise=1_000),
            StockMovement(outlet_id=other, stock_item_id=foreign.id, business_date=end,
                          type="purchase", qty=2, unit_cost_paise=9_000),
        ])
        db.commit()
    result = client.get("/api/insights/menu-engineering", params={
        "outlet_id": outlet_id, "start": start, "end": end,
    }).json()
    assert [row["item"] for row in result["items"]] == ["Local dish"]
    assert result["items"][0]["food_cost_per_dish_rupees"] == 1.0
