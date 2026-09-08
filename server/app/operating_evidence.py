"""Deterministic, evidence-gated menu and service-period calculations."""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from statistics import mean

from sqlalchemy.orm import Session

from .attendance_lib import worked_minutes
from .models import Attendance, Employee, SalesBill, SalesItem, StockItem, StockLink, StockMovement


def menu_engineering(db: Session, outlet_ids: list[int], start: date, end: date) -> dict:
    """Return menu signals, withholding every cost claim unless its evidence is complete."""
    sales: dict[tuple[int, str], dict] = {}
    for row in (db.query(SalesItem)
                 .filter(SalesItem.outlet_id.in_(outlet_ids),
                         SalesItem.business_date >= start.isoformat(),
                         SalesItem.business_date <= end.isoformat()).all()):
        item = sales.setdefault((row.outlet_id, row.item_name), {
            "outlet_id": row.outlet_id, "item": row.item_name, "category": row.category,
            "qty": 0.0, "revenue_paise": 0, "by_date": defaultdict(float),
        })
        item["qty"] += row.qty
        item["revenue_paise"] += row.amount_paise
        item["by_date"][row.business_date] += row.qty

    links_by_dish: dict[tuple[int, str], list[StockLink]] = defaultdict(list)
    for link in db.query(StockLink).filter(StockLink.outlet_id.in_(outlet_ids)).all():
        links_by_dish[(link.outlet_id, link.menu_item_name)].append(link)
    stock_by_id = {
        item.id: item for item in db.query(StockItem)
        .filter(StockItem.outlet_id.in_(outlet_ids)).all()
    }
    latest_cost: dict[tuple[int, int], int] = {}
    for movement in (db.query(StockMovement)
                       .filter(StockMovement.outlet_id.in_(outlet_ids),
                               StockMovement.type == "purchase",
                               StockMovement.qty > 0,
                               StockMovement.unit_cost_paise > 0,
                               StockMovement.business_date <= end.isoformat())
                       .order_by(StockMovement.business_date.desc(), StockMovement.id.desc()).all()):
        latest_cost.setdefault((movement.outlet_id, movement.stock_item_id), movement.unit_cost_paise)

    span_days = (end - start).days + 1
    rows = []
    for key, item in sales.items():
        links = links_by_dish.get(key, [])
        reason = None
        if not links:
            reason = "No confirmed recipe links for this dish."
        elif any(link.status != "confirmed" or link.coefficient <= 0 for link in links):
            reason = "Recipe links are partial or not fully confirmed."
        elif any(stock_by_id.get(link.stock_item_id) is None for link in links):
            reason = "A confirmed recipe ingredient is unavailable."
        elif any((link.outlet_id, link.stock_item_id) not in latest_cost for link in links):
            reason = "Some confirmed ingredients lack quantity-tracked purchase costs."

        midpoint = start + timedelta(days=span_days // 2)
        first_days = max(1, (midpoint - start).days)
        second_days = max(1, (end - midpoint).days + 1)
        first_qty = sum(qty for day, qty in item["by_date"].items() if day < midpoint.isoformat())
        second_qty = sum(qty for day, qty in item["by_date"].items() if day >= midpoint.isoformat())
        first_velocity, second_velocity = first_qty / first_days, second_qty / second_days
        price_paise = item["revenue_paise"] / item["qty"] if item["qty"] else None
        row = {
            "outlet_id": item["outlet_id"], "item": item["item"], "category": item["category"],
            "qty": round(item["qty"], 2),
            "revenue_rupees": round(item["revenue_paise"] / 100, 2),
            "average_recorded_price_rupees": round(price_paise / 100, 2) if price_paise else None,
            "sales_velocity_per_day": round(item["qty"] / span_days, 2),
            "momentum_percent": round((second_velocity - first_velocity) / first_velocity * 100, 1)
            if first_velocity > 0 else None,
            "cost_status": "withheld" if reason else "recorded",
            "cost_withheld_reason": reason,
            "evidence": {
                "recipe_links": len(links),
                "confirmed_recipe_links": sum(link.status == "confirmed" for link in links),
                "compatible_purchase_costs": sum(
                    (link.outlet_id, link.stock_item_id) in latest_cost for link in links),
            },
        }
        if reason is None:
            food_cost_paise = sum(
                link.coefficient * latest_cost[(link.outlet_id, link.stock_item_id)]
                for link in links)
            total_food_cost_paise = food_cost_paise * item["qty"]
            row.update({
                "food_cost_per_dish_rupees": round(food_cost_paise / 100, 2),
                "food_cost_percent": round(food_cost_paise / price_paise * 100, 1)
                if price_paise else None,
                "recorded_contribution_after_food_cost_rupees": round(
                    (item["revenue_paise"] - total_food_cost_paise) / 100, 2),
            })
        rows.append(row)

    priced = [row for row in rows if row["cost_status"] == "recorded"
              and row["food_cost_percent"] is not None]
    velocity_baseline = mean(row["sales_velocity_per_day"] for row in rows) if rows else 0
    opportunities = [{
        "id": f"food-cost:{row['item'].lower()}",
        "kind": "high_food_cost_high_velocity",
        "item": row["item"],
        "confidence": "high",
    } for row in priced if row["food_cost_percent"] >= 45
       and row["sales_velocity_per_day"] >= velocity_baseline]
    return {
        "start": start.isoformat(), "end": end.isoformat(), "items": sorted(
            rows, key=lambda row: (-row["revenue_rupees"], row["item"].lower())),
        "evidence": {"sales_dishes": len(rows), "costed_dishes": len(priced)},
        "opportunities": opportunities[:5],
    }


def _clocked_service_hours(rows: list[Attendance]) -> dict[tuple[str, int, int], float]:
    """Split recorded clock time into real weekday/hour service buckets."""
    hours: dict[tuple[str, int, int], float] = defaultdict(float)
    for row in rows:
        minutes = worked_minutes(row)
        if minutes is None:
            continue
        day = date.fromisoformat(row.business_date)
        cursor, remaining = row.in_min or 0, minutes
        while remaining:
            day_offset, minute_of_day = divmod(cursor, 1440)
            service_date = day + timedelta(days=day_offset)
            chunk = min(remaining, 60 - minute_of_day % 60)
            hours[(service_date.isoformat(), service_date.weekday(), minute_of_day // 60)] += chunk / 60
            cursor += chunk
            remaining -= chunk
    return hours


def staffing_plan(db: Session, outlet_id: int, start: date, end: date) -> dict:
    """Return observed service coverage only; this never creates or infers shifts."""
    span_days = (end - start).days + 1
    employees = [row[0] for row in db.query(Employee.id).filter(
        Employee.outlet_id == outlet_id, Employee.working_status != "left").all()]
    attendance = (db.query(Attendance).filter(
        Attendance.employee_id.in_(employees),
        Attendance.business_date >= start.isoformat(),
        Attendance.business_date <= end.isoformat()).all()) if employees else []
    service_hours = _clocked_service_hours(attendance)
    clocked_dates = {key[0] for key, value in service_hours.items() if value > 0}

    demand: dict[tuple[str, int, int], dict] = {}
    timestamped_bills = 0
    for bill in (db.query(SalesBill).filter(
            SalesBill.outlet_id == outlet_id, SalesBill.business_date >= start.isoformat(),
            SalesBill.business_date <= end.isoformat()).all()):
        try:
            hour = int((bill.bill_ts or "")[11:13])
            bill_date = date.fromisoformat(bill.business_date)
        except (TypeError, ValueError):
            continue
        if not 0 <= hour <= 23:
            continue
        timestamped_bills += 1
        key = (bill_date.isoformat(), bill_date.weekday(), hour)
        bucket = demand.setdefault(key, {"bills": 0, "sales_paise": 0})
        bucket["bills"] += 1
        bucket["sales_paise"] += bill.total_paise

    calendar_days = defaultdict(int)
    for offset in range(span_days):
        calendar_days[(start + timedelta(days=offset)).weekday()] += 1
    cells: dict[tuple[int, int], dict] = {}
    for (service_date, dow, hour), value in demand.items():
        cell = cells.setdefault((dow, hour), {
            "weekday": dow, "hour": hour, "bills": 0, "sales_paise": 0,
            "demand_dates": set(), "staff_hours_on_demand_dates": 0.0,
            "clocked_dates": set(),
        })
        cell["bills"] += value["bills"]
        cell["sales_paise"] += value["sales_paise"]
        cell["demand_dates"].add(service_date)
        cell["staff_hours_on_demand_dates"] += service_hours.get((service_date, dow, hour), 0)
        if service_hours.get((service_date, dow, hour), 0) > 0:
            cell["clocked_dates"].add(service_date)

    baseline_bills = sum(cell["bills"] for cell in cells.values()
                         if cell["staff_hours_on_demand_dates"] > 0)
    baseline_hours = sum(cell["staff_hours_on_demand_dates"] for cell in cells.values())
    bills_per_clocked_hour = baseline_bills / baseline_hours if baseline_hours else None
    weekly_rates: dict[int, list[float]] = defaultdict(list)
    for cell in cells.values():
        weekly_rates[cell["weekday"]].append(cell["bills"] / len(cell["demand_dates"]))

    bands, recommendations = [], []
    for cell in cells.values():
        observed_days = len(cell["demand_dates"])
        demand_per_day = cell["bills"] / observed_days
        weekday_average = mean(weekly_rates[cell["weekday"]])
        clocked_per_service_day = cell["staff_hours_on_demand_dates"] / observed_days
        staff_history_days = sum(
            1 for (service_date, dow, hour), value in service_hours.items()
            if dow == cell["weekday"] and hour == cell["hour"] and value > 0)
        eligible = (span_days >= 28 and observed_days >= 4 and staff_history_days >= 4
                    and cell["bills"] >= 8 and bills_per_clocked_hour is not None)
        band = "high" if demand_per_day >= weekday_average * 1.25 else (
            "low" if demand_per_day <= weekday_average * 0.75 else "typical")
        row = {
            "weekday": cell["weekday"], "hour": cell["hour"], "demand_band": band,
            "timestamped_bills": cell["bills"], "observed_service_days": observed_days,
            "average_bills_per_observed_day": round(demand_per_day, 2),
            "average_clocked_staff_hours_per_service_day": round(clocked_per_service_day, 2),
            "clocked_history_days": staff_history_days,
            "confidence": "high" if observed_days >= 8 and cell["bills"] >= 24
            else "medium" if eligible else "insufficient",
        }
        bands.append(row)
        if not eligible:
            continue
        expected_hours = demand_per_day / bills_per_clocked_hour
        kind = ("under_coverage" if clocked_per_service_day < expected_hours * 0.75
                else "over_coverage" if clocked_per_service_day > expected_hours * 1.4 else None)
        if kind:
            recommendations.append({
                **row, "kind": kind,
                "observed_coverage_gap_hours_per_service_day": round(
                    expected_hours - clocked_per_service_day, 2),
                "confidence": "high" if row["confidence"] == "high" else "medium",
            })
    withheld_reason = (
        "At least 28 days of trailing history are required."
        if span_days < 28 else
        "Timestamped POS bills and actual clocked attendance are both required."
        if not timestamped_bills or not clocked_dates else None
    )
    return {
        "start": start.isoformat(), "end": end.isoformat(),
        "demand_bands": sorted(bands, key=lambda row: (row["weekday"], row["hour"])),
        "recommendations": sorted(recommendations, key=lambda row: (
            row["kind"], row["weekday"], row["hour"])),
        "data_quality": {
            "history_days": span_days, "timestamped_bills": timestamped_bills,
            "clocked_attendance_days": len(clocked_dates),
            "manual_daily_sales_excluded": True, "recommendations_withheld_reason": withheld_reason,
        },
    }
