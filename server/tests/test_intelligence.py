"""The owner intelligence feed must stay evidence-backed and privacy-safe."""
from datetime import date, timedelta

import pytest

from app.db import SessionLocal
from app.models import (Attendance, Employee, Expense, ExpenseCategory, SalesBill,
                        SalesDaily, SalesItem, StockItem, StockLink, StockMovement)
from app.util import days_in_month


def _month_start(back: int) -> date:
    current = date.today().replace(day=1)
    for _ in range(back):
        current = (current - timedelta(days=1)).replace(day=1)
    return current


CUR = _month_start(2)
PREV = _month_start(3)
AS_OF = CUR.replace(day=days_in_month(CUR.year, CUR.month))


def _category(db):
    row = db.query(ExpenseCategory).filter_by(name="Vegetables").first()
    if row is None:
        row = ExpenseCategory(name="Vegetables", is_active=True, sort=99)
        db.add(row)
        db.flush()
    return row.id


@pytest.fixture()
def records(client):
    with SessionLocal() as db:
        category_id = _category(db)
        for day in range(5):
            for month, amount in ((PREV, 10_000), (CUR, 12_000)):
                db.add(SalesDaily(outlet_id=1, business_date=(month + timedelta(days=day)).isoformat(),
                                  channel_kind="dine_in", source="manual",
                                  amount_paise=amount * 100))
        db.add(Expense(outlet_id=1, business_date=(PREV + timedelta(days=1)).isoformat(),
                       category_id=category_id, amount_paise=2_000_00, mode="upi",
                       description="Older supplier invoice", item_name="Rice", quantity=40, unit="kg"))
        db.add(Expense(outlet_id=1, business_date=(CUR + timedelta(days=1)).isoformat(),
                       category_id=category_id, amount_paise=2_800_00, mode="upi",
                       description="Current supplier invoice", item_name="Rice", quantity=40, unit="kg"))
        ingredient = StockItem(outlet_id=1, name="Secret ingredient",
                               name_key="secret ingredient", base_unit="kg")
        db.add(ingredient)
        db.flush()
        db.add_all([
            SalesItem(outlet_id=1, business_date=CUR.isoformat(),
                      item_name="Secret Menu Dish", qty=2, amount_paise=20_000),
            SalesItem(outlet_id=1, business_date=CUR.isoformat(),
                      item_name="Unlinked dish", qty=1, amount_paise=5_000),
            StockLink(outlet_id=1, stock_item_id=ingredient.id,
                      menu_item_name="Secret Menu Dish", coefficient=1, status="confirmed"),
            StockMovement(outlet_id=1, stock_item_id=ingredient.id,
                          business_date=CUR.isoformat(), type="purchase",
                          qty=5, unit_cost_paise=5_000),
        ])
        db.commit()
    return client


def _brief(client):
    response = client.get("/api/intelligence/brief", params={
        "outlet_id": 1, "as_of": AS_OF.isoformat(),
    })
    assert response.status_code == 200, response.text
    return response.json()


def _configure_ai(client):
    response = client.post("/api/auth/stepup", json={"password": "change-me-please"})
    assert response.status_code == 200, response.text
    response = client.put("/api/ocr/config", json={
        "enabled": True, "provider": "openai_compat",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": "local-test", "api_key": "test-key-123",
    })
    assert response.status_code == 200, response.text


def test_brief_has_ranked_action_buckets_and_explicitly_provisional_health(records):
    result = _brief(records)
    priorities = [finding["priority"] for finding in result["feed"]]
    assert priorities == sorted(priorities, reverse=True)
    assert result["health"]["status"] in {"provisional", "insufficient_data"}
    assert any(finding["bucket"] == "act_today" for finding in result["feed"])
    assert all(finding["rule"]["deterministic"] for finding in result["feed"])


def test_missing_recipe_evidence_is_coached_not_misrepresented_as_inventory_health(records):
    result = _brief(records)
    inventory = next(dimension for dimension in result["health"]["dimensions"]
                     if dimension["key"] == "inventory")
    assert inventory["score"] is None
    finding = next(finding for finding in result["feed"]
                   if finding["id"] == "inventory.recipe-coverage")
    assert finding["bucket"] == "improve_data"
    assert finding["kind"] == "data_quality"


def test_brief_surfaces_complete_menu_cost_evidence_as_an_opportunity(records):
    result = _brief(records)
    assert any(finding["id"].startswith("opportunity.menu-food-cost:")
               for finding in result["feed"])


def test_brief_surfaces_repeated_service_coverage_candidates(records):
    as_of = date.today()
    start = as_of - timedelta(days=55)
    with SessionLocal() as db:
        lunch = Employee(outlet_id=1, name="Planner lunch")
        late = Employee(outlet_id=1, name="Planner late")
        db.add_all((lunch, late))
        db.flush()
        cursor, index = start, 0
        while cursor <= as_of:
            if cursor.weekday() == 0:
                day = cursor.isoformat()
                db.add_all([
                    Attendance(employee_id=lunch.id, business_date=day, status="P",
                               in_min=12 * 60, out_min=12 * 60 + 30),
                    Attendance(employee_id=late.id, business_date=day, status="P",
                               in_min=13 * 60, out_min=14 * 60),
                    *[SalesBill(outlet_id=1, business_date=day, invoice_no=f"busy-{index}-{bill}",
                                bill_ts=f"{day} 12:1{bill}:00", total_paise=10_000)
                      for bill in range(3)],
                    SalesBill(outlet_id=1, business_date=day, invoice_no=f"quiet-{index}",
                              bill_ts=f"{day} 13:15:00", total_paise=10_000),
                ])
                index += 1
            cursor += timedelta(days=1)
        db.commit()
    response = records.get("/api/intelligence/brief", params={
        "outlet_id": 1, "as_of": as_of.isoformat(),
    })
    assert response.status_code == 200, response.text
    assert any(finding["id"].startswith("opportunity.service-under_coverage:")
               for finding in response.json()["feed"])


def test_ai_receives_only_anonymous_bands_and_validates_its_selection(records, monkeypatch):
    _configure_ai(records)
    seen = {}

    class Reply:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {"choices": [{"message": {"content":
                '{"finding_indexes":[0,0,1],"commentary":"Review the selected local evidence before acting."}'}}]}

    def fake_post(url, json=None, headers=None, timeout=None):
        seen["body"] = json
        return Reply()

    monkeypatch.setattr("app.routers.intelligence.httpx.post", fake_post)
    response = records.post("/api/intelligence/ai-brief", json={
        "outlet_id": 1, "as_of": AS_OF.isoformat(),
    })
    assert response.status_code == 200, response.text
    assert response.json()["selected_finding_indexes"] == [0, 1]
    sent = str(seen["body"])
    assert "Vegetables" not in sent
    assert "Rice" not in sent
    assert "supplier invoice" not in sent
    assert "2,800" not in sent
    assert "Secret Menu Dish" not in sent
    assert "Secret ingredient" not in sent


@pytest.mark.parametrize("reply", [
    "not-json",
    '{"finding_indexes":[999],"commentary":"Review the local evidence."}',
    '{"finding_indexes":[0],"commentary":"Save 20 percent today."}',
])
def test_ai_rejects_malformed_or_unsafe_model_output(records, monkeypatch, reply):
    _configure_ai(records)

    class Reply:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {"choices": [{"message": {"content": reply}}]}

    monkeypatch.setattr("app.routers.intelligence.httpx.post", lambda *args, **kwargs: Reply())
    response = records.post("/api/intelligence/ai-brief", json={
        "outlet_id": 1, "as_of": AS_OF.isoformat(),
    })
    assert response.status_code == 502, response.text
