"""Inventory hub: stock items, auto-ingested purchases, wastage, counts,
par-based order lists, and the auto-recipe learning engine."""
import math
from datetime import date, timedelta
from statistics import median

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..audit import audit, check_edit_window
from ..db import get_db
from ..periods import assert_month_open
from ..operating_evidence import menu_engineering
from ..models import (Expense, SalesDaily, SalesItem, StockCount,
                      StockCountLine, StockItem, StockLink, StockMovement,
                      User)
from ..security import current_user, require_owner
from ..util import now_local
from .helpers import assert_outlet_access, user_outlet_ids

router = APIRouter(prefix="/inventory", tags=["inventory"])


# ── helpers ───────────────────────────────────────────────────────────────

def _norm(s: str) -> str:
    return " ".join(str(s or "").lower().split())


def _unit_key(unit: str) -> str:
    value = _norm(unit) or "unit"
    aliases = {
        "kgs": "kg", "kilogram": "kg", "kilograms": "kg",
        "grams": "g", "gram": "g", "gms": "g",
        "litre": "l", "litres": "l", "liter": "l", "liters": "l",
        "millilitre": "ml", "millilitres": "ml",
        "milliliter": "ml", "milliliters": "ml",
        "pcs": "unit", "pc": "unit", "piece": "unit", "pieces": "unit",
    }
    return aliases.get(value, value)


def get_or_create_stock_item(db: Session, outlet_id: int, item_name: str,
                             unit: str = "") -> StockItem:
    key = _norm(item_name)
    unit_key = _unit_key(unit)
    si = db.query(StockItem).filter_by(outlet_id=outlet_id, name_key=key).first()
    if si is None:
        si = StockItem(outlet_id=outlet_id, name=item_name.strip(),
                       name_key=key, base_unit=unit_key, current_qty=0)
        db.add(si)
        db.flush()
    elif _unit_key(si.base_unit) != unit_key:
        raise HTTPException(
            422,
            f"{si.name} is tracked in {si.base_unit}; cannot add quantity in {unit_key}",
        )
    elif not si.is_active:
        si.is_active = True
    return si


def ensure_purchase_movement(db: Session, outlet_id: int, business_date: str,
                             item_name: str, qty: float, unit: str,
                             amount_paise: int, user_id: int,
                             expense_id: int | None) -> None:
    """Called whenever a qty-tracked expense line is created."""
    if not item_name or not qty or qty <= 0:
        return
    si = get_or_create_stock_item(db, outlet_id, item_name, unit)
    db.add(StockMovement(
        outlet_id=outlet_id, stock_item_id=si.id, business_date=business_date,
        type="purchase", qty=qty,
        unit_cost_paise=int(round(amount_paise / qty)) if qty else 0,
        ref_expense_id=expense_id, created_by=user_id))
    (db.query(StockItem)
       .filter(StockItem.id == si.id)
       .update({StockItem.current_qty: StockItem.current_qty + qty},
               synchronize_session=False))


def drop_purchase_movement(db: Session, expense_id: int) -> None:
    """Undo the stock a qty-tracked expense added.

    An expense and its purchase movement are two halves of one fact. Editing
    or deleting the expense without this leaves stock on the shelf that was
    never bought, and a unit price computed from an amount nobody paid.
    """
    movements = (db.query(StockMovement)
                   .filter_by(ref_expense_id=expense_id, type="purchase").all())
    for m in movements:
        (db.query(StockItem)
           .filter(StockItem.id == m.stock_item_id)
           .update({StockItem.current_qty: StockItem.current_qty - m.qty},
                   synchronize_session=False))
        db.delete(m)
    if movements:
        db.flush()


# ── items ─────────────────────────────────────────────────────────────────

class ItemIn(BaseModel):
    name: str
    base_unit: str = "kg"
    par_qty: float = 0
    min_qty: float = 0
    yield_percent: float = 100
    opening_qty: float | None = None


@router.get("/items")
def list_items(outlet_id: int, user: User = Depends(current_user),
               db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    items = (db.query(StockItem)
               .filter_by(outlet_id=outlet_id, is_active=True)
               .order_by(StockItem.name).all())
    last_cost = {}
    for m in (db.query(StockMovement)
                .filter(StockMovement.outlet_id == outlet_id,
                        StockMovement.type == "purchase")
                .order_by(StockMovement.id.desc()).all()):
        last_cost.setdefault(m.stock_item_id, m.unit_cost_paise)
    out = []
    for it in items:
        uc = last_cost.get(it.id, 0)
        out.append({
            "id": it.id, "name": it.name, "base_unit": it.base_unit,
            "par_qty": it.par_qty, "min_qty": it.min_qty,
            "current_qty": round(it.current_qty, 2),
            "yield_percent": it.yield_percent,
            "value_rupees": round(it.current_qty * uc / 100, 2),
            "last_unit_price_rupees": round(uc / 100, 2),
        })
    return out


@router.post("/items", status_code=201)
def create_item(body: ItemIn, outlet_id: int, user: User = Depends(require_owner),
                db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    values = [body.par_qty, body.min_qty, body.yield_percent]
    if body.opening_qty is not None:
        values.append(body.opening_qty)
    if (not body.name.strip() or any(not math.isfinite(value) or value < 0
                                    for value in values)
            or body.yield_percent > 100):
        raise HTTPException(422, "Invalid stock item values")
    si = get_or_create_stock_item(db, outlet_id, body.name, body.base_unit)
    si.par_qty = body.par_qty
    si.min_qty = body.min_qty
    si.yield_percent = body.yield_percent
    if body.opening_qty and not db.query(StockMovement).filter_by(
            stock_item_id=si.id, type="opening").count():
        db.add(StockMovement(outlet_id=outlet_id, stock_item_id=si.id,
                             business_date=now_local().date().isoformat(),
                             type="opening", qty=body.opening_qty,
                             created_by=user.id))
        si.current_qty = (si.current_qty or 0) + body.opening_qty
    audit(db, None, user.id, "stock-item", "stock_item", si.id,
          after={"name": si.name})
    db.commit()
    return {"id": si.id, "name": si.name}


@router.patch("/items/{item_id}")
def update_item(item_id: int, body: dict, user: User = Depends(require_owner),
                db: Session = Depends(get_db)):
    si = db.get(StockItem, item_id)
    if si is None:
        raise HTTPException(404, "Not found")
    if "name" in body:
        name = str(body["name"]).strip()
        if not name:
            raise HTTPException(422, "Name is required")
        si.name = name
        si.name_key = _norm(name)
    if "base_unit" in body:
        new_unit = _unit_key(str(body["base_unit"]))
        has_movements = db.query(StockMovement.id).filter_by(
            stock_item_id=si.id).first()
        if has_movements and new_unit != _unit_key(si.base_unit):
            raise HTTPException(409, "Unit cannot change after stock movements exist")
        si.base_unit = new_unit
    for key in ("par_qty", "min_qty", "yield_percent"):
        if key in body:
            value = float(body[key])
            if not math.isfinite(value) or value < 0:
                raise HTTPException(422, f"{key} must be finite and non-negative")
            if key == "yield_percent" and value > 100:
                raise HTTPException(422, "yield_percent cannot exceed 100")
            setattr(si, key, value)
    if body.get("is_active") is False:
        si.is_active = False
    audit(db, None, user.id, "update", "stock_item", si.id,
          after={"name": si.name, "base_unit": si.base_unit})
    db.commit()
    return {"ok": True}


@router.post("/seed-from-expenses")
def seed_from_expenses(outlet_id: int, user: User = Depends(require_owner),
                       db: Session = Depends(get_db)):
    """One-time backfill: create stock items + purchase movements from every
    historical expense that carried item_name + quantity. Idempotent."""
    assert_outlet_access(db, user, outlet_id)
    rows = (db.query(Expense)
              .filter(Expense.outlet_id == outlet_id,
                      Expense.quantity.isnot(None),
                      Expense.quantity > 0,
                      Expense.item_name != "")
              .order_by(Expense.business_date, Expense.id).all())
    linked = {m.ref_expense_id for m in db.query(StockMovement)
              .filter_by(outlet_id=outlet_id, type="purchase")
              .filter(StockMovement.ref_expense_id.isnot(None)).all()}
    new_items = new_moves = 0
    for e in rows:
        if e.id in linked:
            continue
        before = db.query(StockItem).filter_by(
            outlet_id=outlet_id, name_key=_norm(e.item_name)).count()
        si = get_or_create_stock_item(db, outlet_id, e.item_name, e.unit or "unit")
        if before == 0:
            new_items += 1
        db.add(StockMovement(outlet_id=outlet_id, stock_item_id=si.id,
                             business_date=e.business_date, type="purchase",
                             qty=e.quantity,
                             unit_cost_paise=int(e.amount_paise / e.quantity),
                             ref_expense_id=e.id, created_by=user.id))
        si.current_qty = (si.current_qty or 0) + e.quantity
        new_moves += 1
    audit(db, None, user.id, "inventory-seed", "stock_item", outlet_id,
          after={"items": new_items, "movements": new_moves})
    db.commit()
    return {"items_created": new_items, "movements_created": new_moves}


# ── wastage ───────────────────────────────────────────────────────────────

class WastageIn(BaseModel):
    outlet_id: int
    business_date: str
    stock_item_id: int
    qty: float
    reason: str


@router.post("/wastage", status_code=201)
def add_wastage(body: WastageIn, user: User = Depends(current_user),
                db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    check_edit_window(body.business_date, user, db)
    assert_month_open(db, body.outlet_id, body.business_date)
    si = (
        db.query(StockItem)
        .filter_by(id=body.stock_item_id, outlet_id=body.outlet_id)
        .first()
    )
    if (si is None or not math.isfinite(body.qty) or body.qty <= 0
            or body.qty > si.current_qty):
        raise HTTPException(422, "Bad item or quantity")
    last = (db.query(StockMovement)
              .filter_by(stock_item_id=si.id, type="purchase")
              .order_by(StockMovement.id.desc()).first())
    cost = last.unit_cost_paise if last else 0
    db.add(StockMovement(outlet_id=body.outlet_id, stock_item_id=si.id,
                         business_date=body.business_date, type="wastage",
                         qty=-body.qty, unit_cost_paise=cost,
                         reason=body.reason, created_by=user.id))
    changed = (
        db.query(StockItem)
        .filter(StockItem.id == si.id, StockItem.current_qty >= body.qty)
        .update({StockItem.current_qty: StockItem.current_qty - body.qty},
                synchronize_session=False)
    )
    if changed != 1:
        raise HTTPException(409, "Stock changed; refresh and try again")
    audit(db, None, user.id, "wastage", "stock_movement", si.id,
          after={"qty": body.qty, "reason": body.reason})
    db.commit()
    return {"ok": True, "cost_rupees": round(body.qty * cost / 100, 2)}


@router.get("/wastage")
def wastage_list(outlet_id: int, start: str | None = None,
                 end: str | None = None, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    q = (db.query(StockMovement)
           .filter_by(outlet_id=outlet_id, type="wastage"))
    if start:
        q = q.filter(StockMovement.business_date >= start)
    if end:
        q = q.filter(StockMovement.business_date <= end)
    rows = q.order_by(StockMovement.business_date.desc()).limit(300).all()
    items = {i.id: i.name for i in db.query(StockItem).all()}
    return [{
        "date": m.business_date, "item": items.get(m.stock_item_id, "?"),
        "qty": round(-m.qty, 2),
        "cost_rupees": round(-m.qty * m.unit_cost_paise / 100, 2),
        "reason": m.reason,
    } for m in rows]


# ── overview + order list ─────────────────────────────────────────────────

def _usage_per_day(db, outlet_id: int, days: int = 30) -> dict[int, float]:
    """Purchase-rate baseline: total purchased ÷ days spanned (per item).

    A single purchase says nothing about the rate of use: dividing by a span
    of 1 concludes the whole sack is eaten the day it arrives, which flagged
    every item as about to run out. Two purchase days are the minimum needed
    to measure an interval at all.
    """
    start = (now_local().date() - timedelta(days=days)).isoformat()
    rows = (db.query(StockMovement.stock_item_id,
                     func.sum(StockMovement.qty),
                     func.min(StockMovement.business_date),
                     func.max(StockMovement.business_date),
                     func.count(func.distinct(StockMovement.business_date)))
              .filter_by(outlet_id=outlet_id, type="purchase")
              .filter(StockMovement.business_date >= start)
              .group_by(StockMovement.stock_item_id).all())
    out = {}
    for sid, qty, first, last, distinct_days in rows:
        if (distinct_days or 0) < 2:
            continue
        span = max(1, (date.fromisoformat(last) -
                       date.fromisoformat(first)).days)
        out[sid] = (qty or 0) / span
    return out


def _intelligence_window(start: str | None, end: str | None) -> tuple[str, str, int]:
    today = now_local().date()
    try:
        last = date.fromisoformat(end) if end else today
        first = date.fromisoformat(start) if start else last - timedelta(days=29)
    except ValueError:
        raise HTTPException(422, "start and end must be ISO dates") from None
    if first > last or last > today or (last - first).days > 366:
        raise HTTPException(422, "Choose a window from the past 367 days")
    return first.isoformat(), last.isoformat(), (last - first).days + 1


def _coverage(observed: int, required: int, label: str) -> dict:
    return {
        "observed": observed, "required": required,
        "status": "usable" if observed >= required else "insufficient",
        "caveat": None if observed >= required
        else f"{label} needs at least {required} recorded observation{'s' if required != 1 else ''}.",
    }


def build_inventory_intelligence(db: Session, outlet_id: int, start: str | None,
                                 end: str | None, stockout_lead_days: int = 3) -> dict:
    """Return deterministic evidence without treating recipe estimates as stock facts."""
    start, end, days = _intelligence_window(start, end)
    items = (db.query(StockItem).filter_by(outlet_id=outlet_id, is_active=True)
               .order_by(StockItem.name).all())
    item_by_id = {item.id: item for item in items}
    links_by_item: dict[int, list[StockLink]] = {}
    for link in (db.query(StockLink)
                   .filter_by(outlet_id=outlet_id, status="confirmed").all()):
        if (link.stock_item_id in item_by_id and math.isfinite(link.coefficient)
                and link.coefficient >= 0):
            links_by_item.setdefault(link.stock_item_id, []).append(link)

    sales_by_name: dict[str, list[SalesItem]] = {}
    for sale in (db.query(SalesItem)
                   .filter(SalesItem.outlet_id == outlet_id,
                           SalesItem.business_date >= start, SalesItem.business_date <= end,
                           SalesItem.qty > 0).all()):
        sales_by_name.setdefault(sale.item_name, []).append(sale)

    movements_by_item: dict[int, list[StockMovement]] = {}
    for movement in (db.query(StockMovement)
                       .filter(StockMovement.outlet_id == outlet_id,
                               StockMovement.business_date >= start,
                               StockMovement.business_date <= end).all()):
        if movement.stock_item_id in item_by_id:
            movements_by_item.setdefault(movement.stock_item_id, []).append(movement)

    counts_by_item: dict[int, list[dict]] = {}
    count_rows = (db.query(StockCount, StockCountLine)
                    .join(StockCountLine, StockCountLine.count_id == StockCount.id)
                    .filter(StockCount.outlet_id == outlet_id, StockCount.status == "done",
                            StockCount.business_date >= start, StockCount.business_date <= end)
                    .order_by(StockCount.business_date, StockCount.id).all())
    for count, line in count_rows:
        if line.stock_item_id in item_by_id and line.counted_qty is not None:
            # These are the frozen values saved when the count completed. Do not
            # replace system_qty with the item's live quantity.
            counts_by_item.setdefault(line.stock_item_id, []).append({
                "date": count.business_date,
                "system_qty": round(line.system_qty, 3),
                "counted_qty": round(line.counted_qty, 3),
                "variance_qty": round(line.counted_qty - line.system_qty, 3),
            })

    last_purchase_cost: dict[int, int] = {}
    for movement in (db.query(StockMovement)
                       .filter(StockMovement.outlet_id == outlet_id,
                               StockMovement.type == "purchase",
                               StockMovement.business_date <= end)
                       .order_by(StockMovement.business_date.desc(), StockMovement.id.desc()).all()):
        last_purchase_cost.setdefault(movement.stock_item_id, movement.unit_cost_paise)

    result = []
    for item in items:
        links = links_by_item.get(item.id, [])
        sales = [sale for link in links for sale in sales_by_name.get(link.menu_item_name, [])]
        # A sales row can only match one link for an ingredient because StockLink
        # is unique on stock item + menu item.
        raw_expected = (sum(sale.qty * link.coefficient for link in links
                            for sale in sales_by_name.get(link.menu_item_name, []))
                        if sales else None)
        purchase_rows = [m for m in movements_by_item.get(item.id, [])
                         if m.type == "purchase" and m.qty > 0]
        wastage_rows = [m for m in movements_by_item.get(item.id, [])
                        if m.type == "wastage"]
        adjustment_rows = [m for m in movements_by_item.get(item.id, [])
                           if m.type in ("count_fix", "adjustment")]
        sales_days = len({sale.business_date for sale in sales})
        purchase_days = len({movement.business_date for movement in purchase_rows})
        snapshots = counts_by_item.get(item.id, [])
        unit_compatible = bool(item.base_unit.strip()) and bool(links)
        sales_coverage = _coverage(sales_days, 2, "Velocity")
        purchase_coverage = _coverage(purchase_days, 2, "Purchase coverage")
        count_coverage = _coverage(len(snapshots), 1, "Physical count coverage")
        recipe_coverage = {
            "observed": len(links), "required": 1,
            "status": "usable" if unit_compatible else "insufficient",
            "caveat": None if unit_compatible
            else "A confirmed recipe expressed in this item's tracked base unit is required.",
        }
        # A single item-sales record proves neither a representative recipe
        # window nor a consumption rate. Withhold the estimate rather than
        # displaying a precise-looking one-observation conclusion.
        expected = raw_expected if unit_compatible and sales_coverage["status"] == "usable" else None
        can_forecast = (expected is not None and unit_compatible
                        and sales_coverage["status"] == "usable" and days >= 7)
        can_recommend = (can_forecast and purchase_coverage["status"] == "usable"
                         and count_coverage["status"] == "usable" and item.par_qty > 0)
        caveats = [
            "Current stock is a live snapshot, not historical evidence for this window.",
            "Recipe consumption is expected usage only; it never creates a stock movement.",
        ]
        for source in (recipe_coverage, sales_coverage, purchase_coverage, count_coverage):
            if source["caveat"]:
                caveats.append(source["caveat"])
        if days < 7:
            caveats.append("Velocity needs a window of at least seven calendar days.")
        if item.par_qty <= 0:
            caveats.append("Set a positive par level before a reorder can be recommended.")

        velocity = round(expected / days, 3) if can_forecast else None
        cover_days = round(item.current_qty / velocity, 1) if velocity and velocity > 0 else None
        recommendation = round(max(0.0, item.par_qty - item.current_qty), 2) \
            if can_recommend else None
        if not can_recommend:
            risk = None
        elif item.current_qty <= item.min_qty:
            risk = "at_or_below_minimum"
        elif cover_days is not None and cover_days <= stockout_lead_days:
            risk = "stockout_risk"
        elif recommendation and recommendation > 0:
            risk = "below_par"
        else:
            risk = "no_reorder_needed"
        confidence = "high" if can_recommend else "medium" if can_forecast else "insufficient"
        result.append({
            "stock_item_id": item.id, "item": item.name, "base_unit": item.base_unit,
            "current_qty": round(item.current_qty, 3), "min_qty": item.min_qty,
            "par_qty": item.par_qty,
            "expected_consumption_qty": round(expected, 3) if expected is not None else None,
            "expected_consumption_unit": item.base_unit if expected is not None else None,
            "confirmed_recipe_links": len(links),
            "purchases_qty": round(sum(m.qty for m in purchase_rows), 3) if purchase_rows else None,
            "recorded_wastage_qty": round(-sum(m.qty for m in wastage_rows), 3)
            if wastage_rows else None,
            "recorded_adjustments_qty": round(sum(m.qty for m in adjustment_rows), 3)
            if adjustment_rows else None,
            "count_variances": snapshots,
            "velocity_per_day": velocity, "days_of_cover": cover_days,
            "reorder_recommendation_qty": recommendation,
            "reorder_eligible": can_recommend, "risk": risk,
            "last_purchase_unit_cost_rupees": round(
                last_purchase_cost[item.id] / 100, 2) if item.id in last_purchase_cost else None,
            "confidence": confidence,
            "coverage": {
                "recipes": recipe_coverage, "sales": sales_coverage,
                "purchases": purchase_coverage, "counts": count_coverage,
                "unit_compatible": unit_compatible,
            },
            "caveats": caveats,
        })
    result.sort(key=lambda row: (
        not row["reorder_eligible"], row["reorder_recommendation_qty"] is None,
        -(row["reorder_recommendation_qty"] or 0), row["item"].lower()))
    return {
        "start": start, "end": end, "window_days": days,
        "method": "deterministic_computed_on_read",
        "stockout_lead_days": stockout_lead_days,
        "items": result,
    }


@router.get("/intelligence")
def inventory_intelligence(outlet_id: int, start: str | None = None, end: str | None = None,
                           user: User = Depends(current_user), db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    first, last, _ = _intelligence_window(start, end)
    from ..owner_controls import owner_policy
    return build_inventory_intelligence(
        db, outlet_id, first, last, owner_policy(db, outlet_id)["stockout_lead_days"])


@router.get("/overview")
def overview(outlet_id: int, user: User = Depends(current_user),
             db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    items = (db.query(StockItem)
               .filter_by(outlet_id=outlet_id, is_active=True)
               .order_by(StockItem.name).all())
    evidence_by_id = {
        row["stock_item_id"]: row
        for row in build_inventory_intelligence(
            db, outlet_id, None, None,
            __import__("app.owner_controls", fromlist=["owner_policy"]).owner_policy(
                db, outlet_id)["stockout_lead_days"])["items"]
    }
    out = []
    for it in items:
        evidence = evidence_by_id[it.id]
        supported = evidence["reorder_eligible"]
        out.append({
            "id": it.id, "name": it.name, "base_unit": it.base_unit,
            "current_qty": round(it.current_qty, 2),
            "min_qty": it.min_qty, "par_qty": it.par_qty,
            "usage_per_day": evidence["velocity_per_day"],
            "days_of_cover": evidence["days_of_cover"],
            "below_min": (evidence["risk"] in ("at_or_below_minimum", "stockout_risk"))
                         if supported else None,
            "below_par": evidence["risk"] == "below_par" if supported else None,
            "suggested_order": evidence["reorder_recommendation_qty"],
            "intelligence_confidence": evidence["confidence"],
        })
    out.sort(key=lambda x: (x["below_min"] is not True,
                            x["days_of_cover"] if x["days_of_cover"] is not None else 999))
    return {"items": out,
            "below_min_count": sum(1 for x in out if x["below_min"]),
            "below_par_count": sum(1 for x in out if x["below_par"])}


# ── counts ────────────────────────────────────────────────────────────────

class CountLineIn(BaseModel):
    stock_item_id: int
    counted_qty: float


class CountDoneIn(BaseModel):
    lines: list[CountLineIn]


@router.post("/count/start", status_code=201)
def start_count(outlet_id: int, business_date: str | None = None,
                user: User = Depends(current_user), db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    bd = business_date or now_local().date().isoformat()
    assert_month_open(db, outlet_id, bd)
    existing = (db.query(StockCount)
                  .filter_by(outlet_id=outlet_id, business_date=bd,
                             status="draft").first())
    if existing:
        return {"count_id": existing.id}
    sc = StockCount(outlet_id=outlet_id, business_date=bd, counted_by=user.id)
    db.add(sc)
    db.flush()
    for it in (db.query(StockItem)
                 .filter_by(outlet_id=outlet_id, is_active=True)
                 .order_by(StockItem.name).all()):
        db.add(StockCountLine(count_id=sc.id, stock_item_id=it.id,
                              system_qty=it.current_qty))
    db.commit()
    return {"count_id": sc.id}


@router.get("/count/{count_id}")
def get_count(count_id: int, user: User = Depends(current_user),
              db: Session = Depends(get_db)):
    sc = db.get(StockCount, count_id)
    if sc is None:
        raise HTTPException(404, "Not found")
    assert_outlet_access(db, user, sc.outlet_id)
    items = {i.id: i for i in db.query(StockItem)
             .filter_by(outlet_id=sc.outlet_id)}
    lines = db.query(StockCountLine).filter_by(count_id=count_id).all()
    return {
        "count_id": count_id, "business_date": sc.business_date,
        "status": sc.status,
        "lines": [{
            "stock_item_id": l.stock_item_id,
            "name": items[l.stock_item_id].name if l.stock_item_id in items else "?",
            "base_unit": items[l.stock_item_id].base_unit if l.stock_item_id in items else "",
            "system_qty": round(l.system_qty, 2),
            "counted_qty": l.counted_qty,
        } for l in lines],
    }


@router.get("/counts")
def count_history(outlet_id: int, start: str, end: str,
                  user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Immutable physical-versus-system facts captured when each count closed."""
    assert_outlet_access(db, user, outlet_id)
    counts = (db.query(StockCount)
                .filter(StockCount.outlet_id == outlet_id, StockCount.status == "done",
                        StockCount.business_date >= start, StockCount.business_date <= end)
                .order_by(StockCount.business_date.desc(), StockCount.id.desc()).all())
    item_map = {item.id: item for item in db.query(StockItem)
                .filter(StockItem.outlet_id == outlet_id).all()}
    purchase_costs = (db.query(StockMovement)
                        .filter(StockMovement.outlet_id == outlet_id,
                                StockMovement.type == "purchase")
                        .order_by(StockMovement.business_date.desc(), StockMovement.id.desc()).all())
    result = []
    for count in counts:
        costs = {}
        for movement in purchase_costs:
            if movement.business_date <= count.business_date:
                costs.setdefault(movement.stock_item_id, movement.unit_cost_paise)
        lines = []
        for line in db.query(StockCountLine).filter_by(count_id=count.id).all():
            item = item_map.get(line.stock_item_id)
            if item is None or line.counted_qty is None:
                continue
            variance_qty = round(line.counted_qty - line.system_qty, 3)
            unit_cost = costs.get(line.stock_item_id, 0)
            lines.append({
                "stock_item_id": item.id, "name": item.name, "base_unit": item.base_unit,
                "theoretical_qty": round(line.system_qty, 3),
                "physical_qty": round(line.counted_qty, 3),
                "variance_qty": variance_qty,
                "variance_percent": round(variance_qty / line.system_qty * 100, 1)
                if line.system_qty else None,
                "unit_cost_paise": unit_cost,
                "variance_value_paise": round(variance_qty * unit_cost),
            })
        result.append({
            "id": count.id, "date": count.business_date, "lines": lines,
            "variance_value_paise": sum(line["variance_value_paise"] for line in lines),
        })
    return {"counts": result}


@router.post("/count/{count_id}/done")
def finish_count(count_id: int, body: CountDoneIn,
                 user: User = Depends(current_user), db: Session = Depends(get_db)):
    sc = db.get(StockCount, count_id)
    if sc is None:
        raise HTTPException(404, "Not found")
    assert_outlet_access(db, user, sc.outlet_id)
    check_edit_window(sc.business_date, user, db)
    assert_month_open(db, sc.outlet_id, sc.business_date)
    if sc.status != "draft":
        raise HTTPException(409, "Count is already finalized")
    expected_ids = {
        line.stock_item_id
        for line in db.query(StockCountLine).filter_by(count_id=count_id).all()
    }
    submitted_ids = [line.stock_item_id for line in body.lines]
    if len(submitted_ids) != len(set(submitted_ids)):
        raise HTTPException(422, "Each stock item must appear once")
    if set(submitted_ids) != expected_ids:
        raise HTTPException(422, "Every count line is required")
    if any(
        not math.isfinite(line.counted_qty) or line.counted_qty < 0
        for line in body.lines
    ):
        raise HTTPException(422, "Counted quantities must be finite and non-negative")
    shrink_paise = 0
    last_cost = {}
    for m in (db.query(StockMovement)
                .filter_by(outlet_id=sc.outlet_id, type="purchase")
                .order_by(StockMovement.id.desc()).all()):
        last_cost.setdefault(m.stock_item_id, m.unit_cost_paise)
    for ln in body.lines:
        line = (db.query(StockCountLine)
                  .filter_by(count_id=count_id,
                             stock_item_id=ln.stock_item_id).first())
        si = db.get(StockItem, ln.stock_item_id)
        if line is None or si is None or si.outlet_id != sc.outlet_id:
            raise HTTPException(422, "Invalid stock item in count")
        line.counted_qty = ln.counted_qty
        diff = round(ln.counted_qty - (si.current_qty or 0), 3)
        if abs(diff) < 0.001:
            continue
        cost = last_cost.get(si.id, 0)
        db.add(StockMovement(outlet_id=sc.outlet_id,
                             stock_item_id=si.id,
                             business_date=sc.business_date,
                             type="count_fix", qty=diff,
                             unit_cost_paise=cost,
                             reason=f"count {sc.business_date}",
                             created_by=user.id))
        changed = (
            db.query(StockItem)
            .filter(StockItem.id == si.id,
                    StockItem.current_qty == line.system_qty)
            .update({StockItem.current_qty: ln.counted_qty},
                    synchronize_session=False)
        )
        if changed != 1:
            raise HTTPException(409, "Stock changed after this count started")
        if diff < 0:
            shrink_paise += -diff * cost
    sc.status = "done"
    sc.counted_by = user.id
    audit(db, None, user.id, "count-done", "stock_count", count_id,
          after={"shrink_rupees": round(shrink_paise / 100, 2)})
    db.commit()
    return {"ok": True, "shrinkage_rupees": round(shrink_paise / 100, 2)}


# ── order list ────────────────────────────────────────────────────────────

@router.get("/order")
def order_list(outlet_id: int, user: User = Depends(current_user),
               db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    evidence = build_inventory_intelligence(db, outlet_id, None, None)
    return [{
        "id": row["stock_item_id"], "item": row["item"], "base_unit": row["base_unit"],
        "current_qty": row["current_qty"], "par_qty": row["par_qty"],
        "suggested_order": row["reorder_recommendation_qty"],
        "days_of_cover": row["days_of_cover"], "last_vendor": None,
    } for row in evidence["items"] if row["reorder_eligible"]
    and (row["reorder_recommendation_qty"] or 0) > 0]


# ── auto-recipe learning ──────────────────────────────────────────────────

def _weekly(series_by_date: dict[str, float], lo: date, weeks: int):
    """Mon-Sun buckets starting from `lo`. Returns list[dict week_index→qty]."""
    out = [0.0] * weeks
    for ds, v in series_by_date.items():
        d = date.fromisoformat(ds)
        idx = (d - lo).days // 7
        if 0 <= idx < weeks:
            out[idx] += v or 0
    return out


@router.get("/learn")
def learn(outlet_id: int, weeks: int = 10,
          user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Correlation-ranked link suggestions + current confirmed links."""
    assert_outlet_access(db, user, outlet_id)
    weeks = max(4, min(weeks, 26))
    today = now_local().date()
    lo = today - timedelta(days=today.weekday()) - timedelta(weeks=weeks)
    hi = today

    # weekly purchases per stock item
    pur: dict[int, dict[str, float]] = {}
    for m in (db.query(StockMovement)
                .filter_by(outlet_id=outlet_id, type="purchase")
                .filter(StockMovement.business_date >= lo.isoformat(),
                        StockMovement.business_date <= hi.isoformat()).all()):
        pur.setdefault(m.stock_item_id, {})
        pur[m.stock_item_id][m.business_date] = \
            pur[m.stock_item_id].get(m.business_date, 0) + m.qty

    # weekly dish sales
    dish: dict[str, dict[str, float]] = {}
    for r in (db.query(SalesItem)
                .filter_by(outlet_id=outlet_id)
                .filter(SalesItem.business_date >= lo.isoformat(),
                        SalesItem.business_date <= hi.isoformat()).all()):
        dish.setdefault(r.item_name, {})
        dish[r.item_name][r.business_date] = \
            dish[r.item_name].get(r.business_date, 0) + r.qty

    def pearson(a: list[float], b: list[float]) -> float:
        n = len(a)
        if n < 3:
            return 0.0
        ma, mb = sum(a) / n, sum(b) / n
        num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
        da = sum((x - ma) ** 2 for x in a) ** 0.5
        dbb = sum((y - mb) ** 2 for y in b) ** 0.5
        if da == 0 or dbb == 0:
            return 0.0
        return num / (da * dbb)

    stock_items = {i.id: i for i in db.query(StockItem)
                   .filter_by(outlet_id=outlet_id, is_active=True)}
    existing = {(l.stock_item_id, l.menu_item_name): l
                for l in db.query(StockLink).filter_by(outlet_id=outlet_id)}

    suggestions = []
    for sid, pur_daily in pur.items():
        pw = _weekly(pur_daily, lo, weeks)
        if sum(pw) <= 0:
            continue
        for dish_name, dish_daily in dish.items():
            if (sid, dish_name) in existing and \
                    existing[(sid, dish_name)].status in ("confirmed", "rejected"):
                continue
            dw = _weekly(dish_daily, lo, weeks)
            overlap = [i for i in range(weeks) if pw[i] > 0 and dw[i] > 0]
            if len(overlap) < 3:
                continue
            r = pearson(pw, dw)
            if r < 0.6:
                continue
            ratios = [pw[i] / dw[i] for i in overlap]
            coef = round(median(ratios), 4)
            suggestions.append({
                "stock_item_id": sid,
                "stock_item": stock_items[sid].name if sid in stock_items else "?",
                "menu_item": dish_name,
                "correlation": round(r, 2),
                "coefficient": coef,
                "weeks_data": len(overlap),
                "confidence": ("stable" if len(overlap) >= 8
                               else "learning" if len(overlap) >= 3
                               else "insufficient"),
            })
    suggestions.sort(key=lambda x: -x["correlation"])
    confirmed = [{
        "stock_item_id": l.stock_item_id,
        "stock_item": stock_items[l.stock_item_id].name
                      if l.stock_item_id in stock_items else "?",
        "menu_item": l.menu_item_name,
        "coefficient": l.coefficient, "status": l.status,
        "confidence": l.confidence, "weeks_data": l.weeks_data,
    } for l in existing.values() if l.status in ("confirmed", "rejected")]
    return {"suggestions": suggestions[:50], "links": confirmed}


class LinkIn(BaseModel):
    stock_item_id: int
    menu_item_name: str
    coefficient: float
    status: str = "confirmed"     # confirmed | rejected


@router.put("/links")
def upsert_link(body: LinkIn, outlet_id: int,
                user: User = Depends(require_owner), db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    if (body.status not in ("confirmed", "rejected")
            or not math.isfinite(body.coefficient) or body.coefficient < 0
            or not body.menu_item_name.strip()):
        raise HTTPException(422, "Bad link payload")
    si = (db.query(StockItem)
            .filter_by(id=body.stock_item_id, outlet_id=outlet_id).first())
    if si is None:
        raise HTTPException(404, "Stock item not found")
    l = (db.query(StockLink)
           .filter_by(outlet_id=outlet_id, stock_item_id=body.stock_item_id,
                      menu_item_name=body.menu_item_name).first())
    if l is None:
        l = StockLink(outlet_id=outlet_id, stock_item_id=body.stock_item_id,
                      menu_item_name=body.menu_item_name)
        db.add(l)
    l.coefficient = body.coefficient
    l.status = body.status
    l.updated_at = func_now()
    audit(db, None, user.id, "stock-link", "stock_link", l.id,
          after={"coef": body.coefficient, "status": body.status})
    db.commit()
    return {"ok": True}


def func_now():
    from ..models import utcnow
    return utcnow()


# ── usage, variance, food cost ────────────────────────────────────────────

@router.get("/usage")
def usage(start: str, end: str, outlet_id: int,
          user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Expected daily usage per confirmed link; variance vs purchases; food cost."""
    assert_outlet_access(db, user, outlet_id)
    links = (db.query(StockLink)
               .filter_by(outlet_id=outlet_id, status="confirmed").all())
    dish_daily: dict[str, dict[str, float]] = {}
    for r in (db.query(SalesItem)
                .filter_by(outlet_id=outlet_id)
                .filter(SalesItem.business_date >= start,
                        SalesItem.business_date <= end).all()):
        dish_daily.setdefault(r.item_name, {})
        dish_daily[r.item_name][r.business_date] = \
            dish_daily[r.item_name].get(r.business_date, 0) + r.qty

    items = {i.id: i for i in db.query(StockItem)
             .filter_by(outlet_id=outlet_id)}
    last_cost = {}
    for m in (db.query(StockMovement)
                .filter_by(outlet_id=outlet_id, type="purchase")
                .order_by(StockMovement.id.desc()).all()):
        last_cost.setdefault(m.stock_item_id, m.unit_cost_paise)

    days: list[str] = []
    d0 = date.fromisoformat(start)
    d1 = date.fromisoformat(end)
    cur = d0
    while cur <= d1 and len(days) <= 370:
        days.append(cur.isoformat())
        cur = date.fromordinal(cur.toordinal() + 1)

    expected: dict[str, list[float]] = {}
    usage_value_paise = 0
    for l in links:
        si = items.get(l.stock_item_id)
        if si is None:
            continue
        dd = dish_daily.get(l.menu_item_name, {})
        series = [round((dd.get(d, 0) * l.coefficient), 3) for d in days]
        expected.setdefault(l.stock_item_id, [0.0] * len(days))
        for i, v in enumerate(series):
            expected[l.stock_item_id][i] += v
            usage_value_paise += int(round(v * last_cost.get(l.stock_item_id, 0)))

    pur_daily: dict[str, dict[int, float]] = {}
    for m in (db.query(StockMovement)
                .filter_by(outlet_id=outlet_id, type="purchase")
                .filter(StockMovement.business_date >= start,
                        StockMovement.business_date <= end).all()):
        pur_daily.setdefault(m.business_date, {})
        pur_daily[m.business_date][m.stock_item_id] = \
            pur_daily[m.business_date].get(m.stock_item_id, 0) + m.qty

    purchase_value_paise = sum(
        int(round(q * (last_cost.get(sid, 0))))
        for dd in pur_daily.values() for sid, q in dd.items())

    out_days = []
    for i, d in enumerate(days):
        exp_val = sum(expected[sid][i] * last_cost.get(sid, 0)
                      for sid in expected)
        pur_val = sum(q * last_cost.get(sid, 0)
                      for sid, q in pur_daily.get(d, {}).items())
        out_days.append({
            "date": d,
            "expected_usage_value_rupees": round(exp_val / 100, 2),
            "purchase_value_rupees": round(pur_val / 100, 2),
        })

    sales = (db.query(func.sum(SalesDaily.total_paise))
               .filter_by(outlet_id=outlet_id, source="petpooja")
               .filter(SalesDaily.business_date >= start,
                       SalesDaily.business_date <= end).scalar()) or 0
    manual = (db.query(func.sum(SalesDaily.amount_paise))
                .filter_by(outlet_id=outlet_id, source="manual")
                .filter(SalesDaily.business_date >= start,
                        SalesDaily.business_date <= end).scalar()) or 0
    sales_paise = sales + manual

    variance_paise = purchase_value_paise - usage_value_paise
    return {
        "start": start, "end": end,
        "days": out_days,
        "usage_value_rupees": round(usage_value_paise / 100, 2),
        "purchase_value_rupees": round(purchase_value_paise / 100, 2),
        "variance_rupees": round(variance_paise / 100, 2),
        "variance_percent": round(variance_paise * 100.0 /
                                  max(1, usage_value_paise), 1),
        "food_cost_percent": round(usage_value_paise * 100.0 /
                                   max(1, sales_paise), 1) if sales_paise else None,
        "links_used": len(links),
    }


@router.get("/dish-profitability")
def dish_profitability(start: str, end: str, outlet_id: int | None = None,
                       user: User = Depends(current_user),
                       db: Session = Depends(get_db)):
    """Deprecated compatibility view of evidence-gated menu costing."""
    from ..util import analytics_date_range
    lo, hi = analytics_date_range(start, end)
    if outlet_id is not None:
        assert_outlet_access(db, user, outlet_id)
        ids = [outlet_id]
    else:
        ids = user_outlet_ids(db, user)
    return menu_engineering(db, ids, lo, hi)["items"]
