"""Evidence-backed owner intelligence, computed locally from Ledger facts."""
from __future__ import annotations

import json
from datetime import date, timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import FindingResolution, PurchaseOrder, RecurringCost, SalesItem, StockLink, User
from ..operating_evidence import menu_engineering, staffing_plan
from ..owner_controls import owner_policy, recurring_review_signal
from ..security import require_owner
from ..util import days_in_month, now_local
from .advisor import build_facts, build_findings
from .control import _inbox
from .inventory import build_inventory_intelligence
from .insights import forecast
from .purchases import planned_order_total_paise
from .ocr import _cfg, _provider_headers, _validate_remote_url
from .stats import labour_productivity
from .vendors import aging

router = APIRouter(prefix="/intelligence", tags=["intelligence"])

RULE_VERSION = "ledger-intelligence-v1"
BUCKET_PRIORITY = {"act_today": 300, "watch_this_week": 200, "improve_data": 100}


def _parse_as_of(value: str | None) -> date:
    today = now_local().date()
    if value is None:
        return today
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise HTTPException(422, "as_of must be a valid ISO date") from None
    if parsed > today:
        raise HTTPException(422, "as_of cannot be in the future")
    if parsed != today and parsed.day != days_in_month(parsed.year, parsed.month):
        raise HTTPException(
            422, "Historical as_of must be the final day of its calendar month")
    return parsed


def _month_window(as_of: date) -> tuple[str, str, int]:
    start = as_of.replace(day=1)
    end = date(as_of.year, as_of.month, days_in_month(as_of.year, as_of.month))
    return start.isoformat(), end.isoformat(), (as_of - start).days + 1


def _source(observed: int, expected: int, *, action: dict | None = None,
            usable_at: float = 0.7) -> dict:
    ratio = observed / expected if expected else 0
    status = "usable" if ratio >= usable_at else "partial" if observed else "insufficient"
    return {
        "observed": observed, "expected": expected, "ratio": round(ratio, 2),
        "status": status, "action": action,
    }


def _finding(*, finding_id: str, kind: str, bucket: str, dimension: str,
             severity: str, title: str, detail: str, action: dict,
             confidence: str = "high", confidence_reason: str = "Computed from recorded Ledger facts.",
             metric: dict | None = None, coverage: dict | None = None,
             impact: dict | None = None) -> dict:
    priority = BUCKET_PRIORITY[bucket] + {
        "critical": 50, "warning": 25, "positive": 10, "information": 0,
    }[severity]
    return {
        "id": finding_id, "kind": kind, "bucket": bucket, "dimension": dimension,
        "priority": priority, "severity": severity, "title": title, "detail": detail,
        "action": action,
        "confidence": {"level": confidence, "reason": confidence_reason},
        "metric": metric,
        "coverage": coverage,
        "impact": impact,
        "rule": {"id": finding_id.split(":", 1)[0], "version": 1, "deterministic": True},
    }


def _attach_resolution_state(db: Session, outlet_id: int, covered_period: str,
                             findings: list[dict]) -> tuple[list[dict], list[dict]]:
    """Resolved evidence is retained separately, but no longer outranks new work."""
    rows = {
        row.finding_id: row for row in db.query(FindingResolution).filter_by(
            outlet_id=outlet_id, covered_period=covered_period).all()
    }
    active, resolved = [], []
    for finding in findings:
        row = rows.get(finding["id"])
        state = {
            "status": row.status if row else "open",
            "updated_at": row.updated_at.isoformat() if row and row.updated_at else None,
            # This is deliberately owner UI data only. _ai_payload below
            # never serializes it, including the note.
            "note": row.note if row else "",
        }
        finding["resolution"] = state
        (resolved if state["status"] == "resolved" else active).append(finding)
    return active, resolved


def _health_dimension(key: str, label: str, score: int | None, *, confidence: str,
                      summary: str, coverage: dict | None = None,
                      trend: str | None = None) -> dict:
    return {
        "key": key, "label": label, "score": score,
        "status": "insufficient_data" if score is None
        else "healthy" if score >= 75 else "watch" if score >= 50 else "needs_attention",
        "confidence": confidence, "summary": summary, "coverage": coverage, "trend": trend,
    }


def _recipe_coverage(db: Session, outlet_id: int, start: str, end: str) -> dict:
    menu_items = {
        row[0] for row in db.query(SalesItem.item_name).filter(
            SalesItem.outlet_id == outlet_id, SalesItem.business_date >= start,
            SalesItem.business_date <= end, SalesItem.qty > 0).distinct()
    }
    confirmed = {
        row[0] for row in db.query(StockLink.menu_item_name).filter(
            StockLink.outlet_id == outlet_id, StockLink.status == "confirmed").distinct()
    }
    return _source(
        len(menu_items & confirmed), len(menu_items),
        action={"label": "Confirm recipe links", "href": "/inventory/links"},
    )


def _build_brief(db: Session, user: User, outlet_id: int, as_of: date) -> dict:
    start, end, expected_days = _month_window(as_of)
    month = start[:7]
    policy = owner_policy(db, outlet_id)
    facts = build_facts(db, user, month, outlet_id)
    coverage = facts["recording_coverage"]
    sales_source = _source(
        coverage["sales_days"], expected_days,
        action={"label": "Enter missing sales", "href": "/sales"},
    )
    cash_source = _source(
        coverage["cash_closed_among_sales_days"], coverage["sales_days"],
        action={"label": "Close sales days", "href": "/money/cash"},
    )
    expense_source = {
        "observed": coverage["expense_days"], "expected": None,
        "ratio": None, "status": "recorded" if coverage["expense_days"] else "insufficient",
        "action": {"label": "Log expenses", "href": "/money/expenses"},
    }
    recipe_source = _recipe_coverage(db, outlet_id, start, as_of.isoformat())
    labour = labour_productivity(outlet_id, start, as_of.isoformat(), user, db)
    menu_evidence = menu_engineering(db, [outlet_id], date.fromisoformat(start), as_of)
    staffing_evidence = staffing_plan(
        db, outlet_id, as_of - timedelta(days=55), as_of)
    clock_gaps = labour["data_quality"]["attendance_clock_gaps"]
    labour_source = {
        "observed": labour["labour_hours"], "expected": None, "ratio": None,
        "status": "usable" if labour["labour_hours"] and not clock_gaps
        else "partial" if labour["labour_hours"] else "insufficient",
        "action": {"label": "Review staff clocks", "href": "/staff/attendance"},
    }
    sources = {
        "sales": sales_source, "cash_closes": cash_source, "expenses": expense_source,
        "recipes": recipe_source, "attendance": labour_source,
    }
    ratios = [source["ratio"] for source in sources.values() if source["ratio"] is not None]
    data_score = round(sum(ratios) / len(ratios) * 100) if ratios else None

    inbox = _inbox(db, outlet_id, month)
    inbox_items = [item for item in inbox["items"] if item["date"] <= as_of.isoformat()]
    forecast_data = forecast(month, outlet_id, user, db)
    payable_rows = aging(outlet_id, as_of.isoformat(), user, db)
    overdue_payables = sum(
        lot["remaining_paise"] for row in payable_rows for lot in row["open_lots"]
        if lot["age_days"] >= policy["payable_overdue_days"])
    total_payable = sum(row["total_paise"] for row in payable_rows)
    inventory_evidence = None
    credible_stock_risks = []
    if as_of == now_local().date():
        inventory_evidence = build_inventory_intelligence(
            db, outlet_id, start, as_of.isoformat(), policy["stockout_lead_days"])
        credible_stock_risks = [
            item for item in inventory_evidence["items"]
            if item["reorder_eligible"]
            and item["risk"] in ("at_or_below_minimum", "stockout_risk", "below_par")
        ]
    low_stock = len(credible_stock_risks)

    facts_total = facts["totals"]
    comparable = facts["data_quality"]["enough_to_compare"]
    cash_blockers = sum(item["kind"] in {"cash_close", "cash_deposit", "cash_variance"}
                        and item["severity"] == "blocker" for item in inbox_items)
    cash_score = None if not coverage["sales_days"] else max(0, 100 - cash_blockers * 30 -
        coverage["cash_open_among_sales_days"] * 10)
    sales_score = None if not comparable or facts_total["sales_delta_percent"] is None else max(
        0, min(100, round(70 + facts_total["sales_delta_percent"])))
    cost_score = None if facts_total["spend_percent_of_sales"] is None else max(
        0, min(100, round(100 - facts_total["spend_percent_of_sales"])))
    profit_score = None
    if facts["fixed_variable"]["payroll_paid_rupees"] and facts_total["sales_rupees"]:
        contribution = (facts_total["sales_rupees"] - facts_total["spend_rupees"]
                        - facts["fixed_variable"]["payroll_paid_rupees"])
        profit_score = 75 if contribution >= 0 else 35
    inventory_score = (max(0, 85 - low_stock * 10)
                       if inventory_evidence and any(
                           item["reorder_eligible"] for item in inventory_evidence["items"])
                       else None)
    workforce_score = None if not labour["labour_hours"] else max(0, 100 - len(clock_gaps) * 15)
    payable_score = None if not total_payable else max(0, round(
        100 - overdue_payables / total_payable * 100))
    dimensions = [
        _health_dimension("recorded_contribution", "Recorded contribution", profit_score,
                          confidence="medium" if profit_score is not None else "low",
                          summary="Recorded sales less expenses and finalized payroll; not profit."),
        _health_dimension("sales_momentum", "Sales momentum", sales_score,
                          confidence="medium" if comparable else "low",
                          summary="Compared with the matching stretch of the prior month.",
                          coverage=sales_source,
                          trend="up" if (facts_total["sales_delta_percent"] or 0) > 0 else "down"),
        _health_dimension("cost_control", "Cost control", cost_score,
                          confidence="medium" if coverage["expense_days"] else "low",
                          summary="Recorded spend relative to recorded sales.", coverage=expense_source),
        _health_dimension("cash_control", "Cash control", cash_score, confidence="high",
                          summary="Closed drawers and bank-deposit reconciliation.", coverage=cash_source),
        _health_dimension("inventory", "Inventory", inventory_score,
                          confidence="high" if inventory_score is not None else "low",
                          summary="Evidence-backed consumption, count, and current-stock review.",
                          coverage=recipe_source),
        _health_dimension("workforce", "Workforce evidence", workforce_score,
                          confidence="high" if workforce_score is not None else "low",
                          summary="Clocked labour hours and complete attendance.", coverage=labour_source),
        _health_dimension("payables", "Supplier payables", payable_score,
                          confidence="high" if total_payable else "low",
                          summary="Open vendor credits aged from their purchase dates."),
        _health_dimension("data_quality", "Data quality", data_score,
                          confidence="high" if data_score is not None else "low",
                          summary="Coverage of the inputs needed for reliable decisions."),
    ]
    eligible = [dimension for dimension in dimensions if dimension["score"] is not None]
    overall = round(sum(dimension["score"] for dimension in eligible) / len(eligible)) \
        if len(eligible) >= 4 else None
    health = {
        "overall_score": overall,
        "status": "ready" if overall is not None and len(eligible) >= 7
        else "provisional" if overall is not None else "insufficient_data",
        "eligible_dimensions": len(eligible), "dimensions": dimensions,
    }

    feed: list[dict] = []
    for item in inbox_items:
        bucket = "act_today" if item["severity"] == "blocker" else "watch_this_week"
        severity = "critical" if item["severity"] == "blocker" else "warning"
        feed.append(_finding(
            finding_id=f"control.{item['kind']}:{item['id']}", kind="risk", bucket=bucket,
            dimension="cash_control" if item["kind"].startswith("cash") else item["kind"],
            severity=severity, title=item["title"], detail="This is blocking or weakening a controlled month close.",
            action={"label": "Review and resolve", "href": item["link"], "requires_owner": True},
            metric={"value_paise": item.get("amount_paise"), "observations": 1},
        ))
    for advisor_index, finding in enumerate(build_findings(facts)):
        # Control inbox owns the canonical drawer-close finding; do not make
        # the same unresolved close look like two independent problems.
        if finding["severity"] == "good" or finding["title"] == "Cash closure missing on sales days":
            continue
        severity = {"act": "critical", "watch": "warning", "info": "information"}[finding["severity"]]
        bucket = "act_today" if finding["severity"] == "act" else "watch_this_week"
        topic = "cost_control" if any(word in finding["title"].lower()
                                      for word in ("cost", "spend", "supplier", "price")) else "data_quality"
        feed.append(_finding(
            finding_id=f"advisor.{topic}:{advisor_index}", kind="trend", bucket=bucket,
            dimension=topic, severity=severity, title=finding["title"], detail=finding["detail"],
            action={"label": "Review the evidence", "href": "/reports/analytics"},
            confidence="medium" if comparable else "low",
            confidence_reason="Comparison uses matching recorded periods." if comparable
            else "More recorded history is needed for a dependable comparison.",
        ))
    if not forecast_data["has_basis"]:
        feed.append(_finding(
            finding_id="forecast.no-basis", kind="data_quality", bucket="improve_data",
            dimension="sales_momentum", severity="information", title="Forecast is waiting for recorded sales",
            detail="Enter or import a sales day before using a month-end projection.",
            action={"label": "Enter sales", "href": "/sales"}, confidence="high",
        ))
    elif forecast_data["confidence"] == "low":
        feed.append(_finding(
            finding_id="forecast.low-confidence", kind="data_quality", bucket="improve_data",
            dimension="sales_momentum", severity="information", title="Forecast confidence is still low",
            detail="More recorded days and prior history will narrow the scenario range.",
            action={"label": "View forecast and scenarios", "href": "/reports"},
            confidence="high", metric={"observed_days": forecast_data["observed_days"]},
        ))
    if recipe_source["status"] != "usable":
        feed.append(_finding(
            finding_id="inventory.recipe-coverage", kind="data_quality", bucket="improve_data",
            dimension="inventory", severity="information", title="Recipe coverage limits inventory intelligence",
            detail="Confirm recipe links for selling dishes before using theoretical consumption as a control.",
            action=recipe_source["action"], confidence="high", coverage=recipe_source,
        ))
    if clock_gaps:
        feed.append(_finding(
            finding_id="workforce.clock-gaps", kind="data_quality", bucket="improve_data",
            dimension="workforce", severity="warning", title="Open staff clocks weaken labour analysis",
            detail=f"{len(clock_gaps)} recorded workday{'s' if len(clock_gaps) != 1 else ''} lack a clock-out time.",
            action=labour_source["action"], confidence="high",
        ))
    if overdue_payables:
        feed.append(_finding(
            finding_id="payables.over-ninety", kind="risk", bucket="act_today",
            dimension="payables", severity="critical", title="Supplier credit is overdue",
            detail="Some open supplier credit exceeds the owner overdue policy.",
            action={"label": "Review supplier balances", "href": "/money/vendors", "requires_owner": True},
            confidence="high", metric={"value_paise": overdue_payables},
        ))
    if data_score is not None and data_score < policy["minimum_data_coverage_percent"]:
        feed.append(_finding(
            finding_id="policy.minimum-data-coverage", kind="data_quality",
            bucket="improve_data", dimension="data_quality", severity="warning",
            title="Recorded coverage is below the owner policy",
            detail="Complete the missing source records before relying on operating comparisons.",
            action={"label": "Review data coverage", "href": "/brief"}, confidence="high",
            coverage={"observed": data_score, "expected": 100,
                      "ratio": round(data_score / 100, 2), "status": "partial"},
        ))
    if policy["purchase_approval_limit_paise"]:
        pending_orders = db.query(PurchaseOrder).filter(
            PurchaseOrder.outlet_id == outlet_id,
            PurchaseOrder.status.in_(("draft", "approved"))).all()
        above_limit = [
            order for order in pending_orders
            if planned_order_total_paise(db, order.id) > policy["purchase_approval_limit_paise"]
        ]
        if above_limit:
            feed.append(_finding(
                finding_id="policy.purchase-approval-limit", kind="risk",
                bucket="watch_this_week", dimension="cost_control", severity="warning",
                title="Planned purchases exceed the owner warning limit",
                detail="Review these draft or approved purchase commitments; an owner approval is still required.",
                action={"label": "Review purchase orders", "href": "/money/purchase-orders",
                        "requires_owner": True},
                confidence="high", metric={"observations": len(above_limit)},
            ))
    due_reviews = [
        row for row in db.query(RecurringCost).filter(
            RecurringCost.outlet_id == outlet_id, RecurringCost.is_active == True).all()  # noqa: E712
        if recurring_review_signal(row, as_of)["review_due"]
    ]
    if due_reviews:
        feed.append(_finding(
            finding_id="recurring.owner-review-due", kind="risk", bucket="watch_this_week",
            dimension="cost_control", severity="warning", title="Recurring costs need owner review",
            detail="Confirm active standing costs and their cadence before relying on upcoming outflows.",
            action={"label": "Review standing costs", "href": "/settings"}, confidence="high",
            metric={"observations": len(due_reviews)},
        ))
    # The cash endpoint owns its conservative source qualification. Import
    # locally to avoid a module-level router cycle.
    from .owner import runway
    cash_runway = runway(outlet_id, 30, user, db)
    if cash_runway["status"] != "available":
        feed.append(_finding(
            finding_id="cash-flow.starting-cash-unknown", kind="data_quality",
            bucket="improve_data", dimension="cash_control", severity="information",
            title="Cash-flow runway is withheld until total starting cash is known",
            detail="A drawer close alone does not establish the bank-account balance.",
            action={"label": "Review cash-flow sources", "href": "/reports"}, confidence="high",
        ))

    opportunities = []
    for item in facts["items"]:
        if item["delta_percent"] is not None and item["delta_percent"] >= 10:
            opportunities.append(_finding(
                finding_id=f"opportunity.price-review:{item['item'].lower()}",
                kind="opportunity", bucket="watch_this_week", dimension="cost_control",
                severity="warning", title="Request a second quote for a rising ingredient",
                detail="A quantity-tracked purchase price has increased materially against its prior-period baseline.",
                action={"label": "Review supplier pricing", "href": "/money/unitprices"},
                confidence="medium", metric={"change_percent": item["delta_percent"]},
                impact={"basis": "Quantity-tracked price movement; no savings are assumed."},
            ))
    if low_stock:
        opportunities.append(_finding(
            finding_id="opportunity.low-stock", kind="opportunity", bucket="watch_this_week",
            dimension="inventory", severity="warning", title="Review evidence-backed reorder risks",
            detail=f"{low_stock} tracked item{'s' if low_stock != 1 else ''} have sufficient recipe, sales, purchase, and count evidence for a reorder review.",
            action={"label": "Open order list", "href": "/inventory/order"}, confidence="high",
        ))
    for opportunity in menu_evidence["opportunities"]:
        opportunities.append(_finding(
            finding_id=f"opportunity.menu-{opportunity['id']}", kind="opportunity",
            bucket="watch_this_week", dimension="cost_control", severity="warning",
            title="Review a high-velocity dish's recorded food-cost signal",
            detail="Its confirmed recipe and quantity-tracked purchase costs make this a credible menu review.",
            action={"label": "Review menu evidence", "href": "/reports/analytics"},
            confidence=opportunity["confidence"],
            confidence_reason="Every linked recipe ingredient has a compatible recorded purchase cost.",
        ))
    for candidate in staffing_evidence["recommendations"][:3]:
        opportunities.append(_finding(
            finding_id=f"opportunity.service-{candidate['kind']}:{candidate['weekday']}-{candidate['hour']}",
            kind="opportunity", bucket="watch_this_week", dimension="workforce",
            severity="warning" if candidate["kind"] == "under_coverage" else "information",
            title="Review a service-period coverage candidate",
            detail="Timestamped POS demand and actual clocked attendance show a repeatable coverage difference; review it before changing a roster.",
            action={"label": "Review shift evidence", "href": "/staff/shifts"},
            confidence=candidate["confidence"],
            confidence_reason="This uses only repeated timestamped service periods and recorded clocked hours.",
        ))

    coaching = [finding for finding in feed if finding["kind"] == "data_quality"]
    feed.extend(opportunities)
    feed.sort(key=lambda finding: (-finding["priority"], finding["id"]))
    feed, resolved_findings = _attach_resolution_state(db, outlet_id, month, feed)
    return {
        "schema_version": "1.0", "rule_version": RULE_VERSION,
        "generated_at": now_local().isoformat(), "scope": {
            "outlet_id": outlet_id, "as_of": as_of.isoformat(), "month": month,
        },
        "health": health, "feed": feed[:20], "resolved_findings": resolved_findings,
        "opportunities": opportunities,
        "data_quality": {"score": data_score, "sources": sources, "coaching": coaching},
        "simulator": {
            "available": forecast_data["has_basis"], "href": "/reports",
            "baseline_confidence": forecast_data["confidence"],
        },
        "cash_flow": {"status": cash_runway["status"],
                      "source_coverage": cash_runway["source_coverage"]},
        "ai": {"configured": False, "generated": False,
               "privacy": "aggregate_only_explicit_request"},
    }


@router.get("/brief")
def brief(outlet_id: int, as_of: str | None = None, user: User = Depends(require_owner),
          db: Session = Depends(get_db)):
    as_of_date = _parse_as_of(as_of)
    result = _build_brief(db, user, outlet_id, as_of_date)
    cfg = _cfg(db)
    result["ai"]["configured"] = bool(cfg["enabled"] and cfg["base_url"] and cfg["model"])
    return result


class AiBriefIn(BaseModel):
    outlet_id: int
    as_of: str | None = None


AI_PROMPT = (
    "You prioritize precomputed restaurant operating themes. Return ONLY JSON: "
    '{"finding_indexes":[0],"commentary":"short number-free guidance"}. '
    "Choose up to three valid indexes. Do not calculate, repeat, infer, or invent "
    "numbers, dates, names, records, or facts. Commentary has no digits, markdown, "
    "or headings, and stays under sixty words."
)


def _ai_payload(result: dict) -> dict:
    return {
        "health": [{
            "dimension": dimension["key"], "score_band": dimension["status"],
            "confidence": dimension["confidence"],
        } for dimension in result["health"]["dimensions"]],
        "coverage_bands": {
            key: value["status"] for key, value in result["data_quality"]["sources"].items()
        },
        "finding_candidates": [{
            "index": index, "bucket": finding["bucket"], "topic": finding["dimension"],
            "severity": finding["severity"],
        } for index, finding in enumerate(result["feed"])],
    }


@router.post("/ai-brief")
def ai_brief(body: AiBriefIn, user: User = Depends(require_owner),
             db: Session = Depends(get_db)):
    cfg = _cfg(db)
    if not cfg["enabled"] or not cfg["base_url"] or not cfg["model"]:
        raise HTTPException(400, "AI isn't set up yet. Add a model under Settings → AI first.")
    if cfg["provider"] != "openai_compat":
        raise HTTPException(400, "Written advice needs an OpenAI-compatible model.")
    _validate_remote_url(cfg["base_url"], bool(cfg.get("key")))
    result = _build_brief(db, user, body.outlet_id, _parse_as_of(body.as_of))
    payload = _ai_payload(result)
    try:
        response = httpx.post(
            f"{cfg['base_url']}/chat/completions",
            json={"model": cfg["model"], "temperature": 0.2, "max_tokens": 500,
                  "messages": [{"role": "user", "content": AI_PROMPT + "\n" + json.dumps(payload)}]},
            headers=_provider_headers(cfg), timeout=90)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Couldn't reach the AI endpoint: {exc}") from None
    if response.status_code != 200:
        raise HTTPException(502, f"AI API said {response.status_code}: {response.text[:200]}")
    try:
        raw = response.json()["choices"][0]["message"]["content"]
        parsed = json.loads(raw)
        indexes, commentary = parsed["finding_indexes"], parsed["commentary"]
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
        raise HTTPException(502, "AI reply must contain finding_indexes and commentary JSON.") from None
    if (not isinstance(indexes, list) or not isinstance(commentary, str) or not commentary.strip()
            or any(char.isdigit() for char in commentary)):
        raise HTTPException(502, "AI reply had invalid selections or non-number-free commentary.")
    selected = []
    for index in indexes:
        if type(index) is not int or not 0 <= index < len(result["feed"]):
            raise HTTPException(502, "AI reply selected an invalid finding index.")
        if index not in selected and len(selected) < 3:
            selected.append(index)
    return {
        "text": commentary.strip(), "model": cfg["model"],
        "selected_finding_indexes": selected, "findings": result["feed"],
        "privacy": "aggregate_only_explicit_request",
    }
