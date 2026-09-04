"""The P&L an owner can actually act on.

A spend log tells you what left the till. A P&L tells you whether that
was too much. The difference is two things this module supplies: costs
grouped onto the five lines every restaurant benchmark is quoted against,
and a denominator that excludes GST — a ratio measured against the
tax-inclusive total flatters every figure by roughly the tax rate, and a
flattering figure is worse than none because it gets believed.

Two deliberate positions:

* Labour comes from the staff master, not from expense entries. The
  salaries are already recorded there, so asking an owner to log them
  again as expenses is asking for the one number that is never missing to
  go missing.
* A cost far *below* its benchmark is reported as suspicious, not as a
  triumph. A kitchen does not run at 3% food cost; that figure means the
  invoices are in a drawer, and telling the owner they are doing brilliantly
  would be the single most harmful thing this page could do.
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..audit import get_setting_db, set_setting_db
from ..costgroups import (
    BAND_LABELS, BANDS_DEFAULT, COGS_GROUPS, GROUPS, PRIME_GROUPS,
)
from ..db import get_db
from ..models import Employee, Expense, ExpenseCategory, SalesBill, User
from ..security import current_user, require_stepup
from .advisor import by_severity
from .insights import _today as _today_date
from .patterns import _rupees, _scope
from .recurring import post_due

router = APIRouter(prefix="/pnl", tags=["pnl"])

#: Above this, prime cost is not a warning, it is the whole problem.
PRIME_DANGER = 65.0

#: Below this share of the band's floor, a cost is not "efficient", it is
#: missing. Half of the lowest healthy figure is generous.
UNDERLOG_FRACTION = 0.5

ROLLING_DAYS = 28

STAFF_MEAL_WORDS = ("staff", "स्टाफ", "employee", "worker")


def _month_bounds(month: str) -> tuple[str, str, int]:
    try:
        y, m = (int(x) for x in month.split("-"))
        last = calendar.monthrange(y, m)[1]
    except (ValueError, TypeError, calendar.IllegalMonthError):
        raise HTTPException(422, "Month must look like 2026-04.")
    if not (2000 <= y <= 2999 and 1 <= m <= 12):
        raise HTTPException(422, "Month must look like 2026-04.")
    return f"{month}-01", f"{month}-{last:02d}", last


def _status(pct: float | None, band: list[float], *, logged: bool) -> str:
    """Where a ratio sits against its healthy band.

    'unlogged' is a separate answer from 'good'. A figure well under the
    band is only good news if the costs behind it were actually recorded.
    """
    if pct is None:
        return "unknown"
    lo, hi = band
    if pct > hi * 1.15:
        return "over"
    if pct > hi:
        return "high"
    if pct < lo * UNDERLOG_FRACTION or not logged:
        return "unlogged"
    if pct < lo:
        return "low"
    return "good"


def _payroll(db: Session, outlets: list[int], days: int, in_month: int) -> dict:
    """The wage bill for the period, from the staff master.

    Prorated for a part month so that a month-to-date P&L compares like
    with like: eleven days of sales must not be measured against a whole
    month of salary.
    """
    staff = (db.query(Employee)
               .filter(Employee.outlet_id.in_(outlets),
                       Employee.working_status != "left",
                       Employee.is_active == True)  # noqa: E712
               .all())
    monthly = sum(e.monthly_salary_paise or 0 for e in staff)
    share = days / in_month if in_month else 0
    return {
        "headcount": len(staff),
        "monthly_rupees": _rupees(monthly),
        "period_paise": int(round(monthly * share)),
        "prorated": days < in_month,
        "days_counted": days,
        "days_in_month": in_month,
    }


def _spend_by_group(db: Session, outlets: list[int], lo: str, hi: str) -> dict:
    rows = (db.query(Expense, ExpenseCategory)
              .join(ExpenseCategory, Expense.category_id == ExpenseCategory.id)
              .filter(Expense.outlet_id.in_(outlets),
                      Expense.business_date >= lo,
                      Expense.business_date <= hi).all())
    by_group: dict[str, dict] = {
        g: {"paise": 0, "entries": 0, "categories": {}} for g in GROUPS}
    staff_meals = {"paise": 0, "entries": 0}
    for e, cat in rows:
        g = cat.cost_group if cat.cost_group in GROUPS else "operating"
        slot = by_group[g]
        slot["paise"] += e.amount_paise
        slot["entries"] += 1
        slot["categories"][cat.name] = slot["categories"].get(cat.name, 0) + e.amount_paise
        if g in COGS_GROUPS:
            label = f"{e.item_name or ''} {e.description or ''}".lower()
            if any(w in label for w in STAFF_MEAL_WORDS):
                staff_meals["paise"] += e.amount_paise
                staff_meals["entries"] += 1
    return {"groups": by_group, "staff_meals": staff_meals}


def _sales(db: Session, outlets: list[int], lo: str, hi: str) -> dict:
    bills = (db.query(SalesBill)
               .filter(SalesBill.outlet_id.in_(outlets),
                       SalesBill.business_date >= lo,
                       SalesBill.business_date <= hi).all())
    net = sum(b.net_paise or 0 for b in bills)
    total = sum(b.total_paise or 0 for b in bills)
    days = len({b.business_date for b in bills})
    return {
        "net_paise": net, "total_paise": total,
        "tax_paise": max(total - net, 0),
        "bills": len(bills), "days_open": days,
        "net_rupees": _rupees(net), "total_rupees": _rupees(total),
        "avg_ticket_net_rupees": _rupees(net / len(bills)) if bills else 0.0,
    }


def _pct(paise: int, net: int) -> float | None:
    return round(paise / net * 100, 1) if net else None


def _today() -> str:
    """Today as an ISO string — everything in this module compares dates
    as text, so a bare date object would silently break the comparisons."""
    return _today_date().isoformat()


def _clean_band(value) -> list[float] | None:
    """A band is a pair low < high inside 0-100, or it is not a band.

    Anything else is rejected rather than repaired: a band decides whether
    a cost reads 'healthy', and silently swapping a reversed pair would
    hand the owner a verdict they never asked for.
    """
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    try:
        lo, hi = float(value[0]), float(value[1])
    except (TypeError, ValueError):
        return None
    if not (0 <= lo < hi <= 100):
        return None
    return [round(lo, 1), round(hi, 1)]


def _bands(db: Session) -> dict[str, list[float]]:
    """The bands in force: the published defaults, overridden by whatever
    this shop saved. Sanitised on the way out as well as on the way in,
    so a hand-edited or downgraded setting can never take the report down
    with it."""
    saved = get_setting_db(db, "pnl_bands", None)
    out = {k: list(v) for k, v in BANDS_DEFAULT.items()}
    if isinstance(saved, dict):
        for key, value in saved.items():
            band = _clean_band(value)
            if key in BANDS_DEFAULT and band:
                out[key] = band
    return out


@router.get("/bands")
def get_bands(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """What the report judges each line against, and what it would judge
    against out of the box — so the editor can offer 'back to standard'."""
    live = _bands(db)
    return {"items": [{"key": k, "label": label, "hint": hint,
                       "low": live[k][0], "high": live[k][1],
                       "default_low": BANDS_DEFAULT[k][0],
                       "default_high": BANDS_DEFAULT[k][1],
                       "is_custom": live[k] != BANDS_DEFAULT[k]}
                      for k, (label, hint) in BAND_LABELS.items()]}


@router.put("/bands")
def put_bands(body: dict, user: User = Depends(require_stepup),
              db: Session = Depends(get_db)):
    """Save this shop's own bands. Sending a key back at its default drops
    the override, so the shop follows the published figure again if that
    ever changes."""
    if not isinstance(body, dict):
        raise HTTPException(422, "Send a map of line to [low, high].")
    unknown = [k for k in body if k not in BANDS_DEFAULT]
    if unknown:
        raise HTTPException(422, f"Not a P&L line: {', '.join(sorted(unknown))}")
    overrides: dict[str, list[float]] = {}
    for key, value in body.items():
        band = _clean_band(value)
        if band is None:
            label = BAND_LABELS[key][0]
            raise HTTPException(
                422, f"{label}: give a low and a high between 0 and 100, "
                     "with the low smaller than the high.")
        if band != BANDS_DEFAULT[key]:
            overrides[key] = band
    set_setting_db(db, "pnl_bands", overrides or None, user.id)
    db.commit()
    return get_bands(user=user, db=db)


@router.get("/summary")
def summary(month: str | None = None, outlet_id: int | None = None,
            user: User = Depends(current_user), db: Session = Depends(get_db)):
    outlets = _scope(db, user, outlet_id)
    month = month or _today()[:7]
    lo, hi, days_in_month = _month_bounds(month)

    # A standing cost that has fallen due but was never posted would make
    # this month look cheaper than it was. Posting is idempotent.
    post_due(db)

    today = _today()
    end = min(hi, today) if hi > today else hi
    days_counted = min(
        int(end[8:10]) if end[:7] == month else days_in_month, days_in_month)
    partial = end < hi

    sales = _sales(db, outlets, lo, end)
    net = sales["net_paise"]

    spend = _spend_by_group(db, outlets, lo, end)
    groups = spend["groups"]
    pay = _payroll(db, outlets, days_counted, days_in_month)

    # Labour is payroll plus anything booked to a labour category (staff
    # food, welfare, bonus). Salaries themselves must not be logged twice;
    # the warning below catches a shop that does.
    labour_paise = pay["period_paise"] + groups["labour"]["paise"]
    cogs_paise = sum(groups[g]["paise"] for g in COGS_GROUPS)
    prime_paise = cogs_paise + labour_paise
    other_paise = sum(groups[g]["paise"] for g in
                      ("occupancy", "operating", "admin"))
    total_cost = prime_paise + other_paise

    bands = _bands(db)

    def line(key: str, paise: int, band_key: str, logged: bool) -> dict:
        band = bands.get(band_key, BANDS_DEFAULT.get(band_key, [0.0, 100.0]))
        pct = _pct(paise, net)
        return {
            "key": key, "label": GROUPS.get(key, (key.title(), ""))[0],
            "rupees": _rupees(paise), "percent_of_net": pct,
            "band_low": band[0], "band_high": band[1],
            "status": _status(pct, band, logged=logged),
        }

    lines = [
        {**line("cogs_food", groups["cogs_food"]["paise"], "cogs",
                groups["cogs_food"]["entries"] > 0),
         "note": "Benchmarked as part of total food & beverage cost."},
        {**line("cogs_bev", groups["cogs_bev"]["paise"], "cogs",
                groups["cogs_bev"]["entries"] > 0),
         "note": "Drinks cost is only truly comparable against drinks sales, "
                 "which the till does not separate yet."},
        line("labour", labour_paise, "labour",
             pay["period_paise"] > 0 or groups["labour"]["entries"] > 0),
        line("occupancy", groups["occupancy"]["paise"], "occupancy",
             groups["occupancy"]["entries"] > 0),
        line("operating", groups["operating"]["paise"], "operating",
             groups["operating"]["entries"] > 0),
        line("admin", groups["admin"]["paise"], "admin",
             groups["admin"]["entries"] > 0),
    ]

    cogs_band = bands.get("cogs", BANDS_DEFAULT["cogs"])
    prime_band = bands.get("prime", BANDS_DEFAULT["prime"])
    cogs_pct = _pct(cogs_paise, net)
    prime_pct = _pct(prime_paise, net)

    profit_paise = net - total_cost
    quality = _quality(groups, pay, spend["staff_meals"], sales)
    # "Logged" is not the same as "believable". A single ₹120 vegetable
    # slip is an entry, but a food cost far under its band means the real
    # buying is still on paper somewhere. _status already draws that line
    # for the bands; contribution and per-bill food use the same line so
    # the page cannot call a number good and rely on it in the same breath.
    cogs_status = _status(cogs_pct, cogs_band,
                          logged=any(groups[g]["entries"] for g in COGS_GROUPS))
    cogs_ok = cogs_status != "unlogged"
    # One exported source of truth, so the findings, the totals and the
    # screen cannot disagree about what is known.
    if not cogs_ok and GROUPS["cogs_food"][0] not in quality["missing_groups"]:
        quality["missing_groups"].insert(0, GROUPS["cogs_food"][0])
    quality["cogs_logged"] = cogs_ok
    quality["costs_complete"] = complete = not quality["missing_groups"]
    gap = ", ".join(quality["missing_groups"]) or "some costs"
    unknown = (f"Not shown: nothing believable is logged for {gap}, so any "
               "figure here would flatter you rather than inform you.")
    facts = {
        "month": month,
        "period": {"start": lo, "end": end, "partial": partial,
                   "days_counted": days_counted,
                   "days_in_month": days_in_month},
        "sales": sales,
        "measured_on": "net sales, excluding GST",
        "payroll": pay,
        "cogs": {
            "rupees": _rupees(cogs_paise), "percent_of_net": cogs_pct,
            "band_low": cogs_band[0], "band_high": cogs_band[1],
            "status": cogs_status,
            "food_share_percent": round(
                groups["cogs_food"]["paise"] / cogs_paise * 100, 1)
            if cogs_paise else None,
        },
        "prime_cost": {
            "rupees": _rupees(prime_paise), "percent_of_net": prime_pct,
            "band_low": prime_band[0], "band_high": prime_band[1],
            "danger_above": PRIME_DANGER,
            "status": _status(prime_pct, prime_band,
                              logged=cogs_paise > 0 and labour_paise > 0),
        },
        "lines": lines,
        "totals": {
            "cost_rupees": _rupees(total_cost),
            "cost_percent_of_net": _pct(total_cost, net),
            "profit_known": complete,
            "profit_unknown_why": None if complete else unknown,
            "profit_rupees": _rupees(profit_paise) if complete else None,
            "profit_percent_of_net": _pct(profit_paise, net) if complete else None,
        },
        "per_bill": _per_bill(sales, total_cost, cogs_paise,
                              complete=complete, cogs_ok=cogs_ok),
        "breakeven": _breakeven(sales, cogs_paise, labour_paise + other_paise,
                                days_counted, days_in_month,
                                complete=complete, why=unknown),
        "rolling_food_cost": _rolling(db, outlets, end),
        "sensitivity": _sensitivity(sales, cogs_paise, days_counted,
                                    cogs_ok=cogs_ok, band=cogs_band),
        "budgets": _budgets(db, outlets, groups),
    }
    facts["data_quality"] = quality
    facts["findings"] = _findings(facts)
    return facts


def _per_bill(sales: dict, total_cost: int, cogs: int, *,
              complete: bool, cogs_ok: bool) -> dict:
    n = sales["bills"]
    if not n:
        return {"bills": 0, "cost_rupees": None, "profit_rupees": None,
                "contribution_rupees": None, "net_rupees": None,
                "food_cost_rupees": None}
    return {
        "bills": n,
        "net_rupees": _rupees(sales["net_paise"] / n),
        "cost_rupees": _rupees(total_cost / n),
        "food_cost_rupees": _rupees(cogs / n) if cogs_ok else None,
        # What is actually left over per bill. Reconciles with cost above:
        # net minus cost. Withheld unless every cost is in, or it is just
        # the missing costs showing up as imaginary profit.
        "profit_rupees": _rupees((sales["net_paise"] - total_cost) / n)
        if complete else None,
        # What one more bill adds once its ingredients are paid for. This
        # is the number that decides whether chasing volume is worth it.
        "contribution_rupees": _rupees((sales["net_paise"] - cogs) / n)
        if cogs_ok else None,
    }


def _breakeven(sales: dict, variable: int, fixed: int,
               days_counted: int, days_in_month: int, *,
               complete: bool, why: str) -> dict:
    """Break-even expressed in bills a day.

    Rupees a month is the accountant's answer; a floor manager can only
    act on covers. Salaried staff are treated as fixed, which is how an
    Indian restaurant on monthly wages actually behaves.
    """
    net = sales["net_paise"]
    if not net or not sales["bills"]:
        return {"possible": False, "why": "No sales in this period yet."}
    if not complete:
        # Break-even from fixed costs nobody entered is the most dangerous
        # number on the page: it always says you are comfortably clear.
        return {"possible": False, "why": why}
    cm_ratio = 1 - (variable / net)
    if cm_ratio <= 0:
        return {"possible": False,
                "why": "Ingredients cost more than the food sells for."}
    # Fixed costs so far are for days_counted days; scale to the month.
    monthly_fixed = fixed / days_counted * days_in_month if days_counted else fixed
    month_paise = monthly_fixed / cm_ratio
    per_day = month_paise / days_in_month
    ticket = net / sales["bills"]
    return {
        "possible": True,
        "contribution_margin_percent": round(cm_ratio * 100, 1),
        "month_rupees": _rupees(month_paise),
        "day_rupees": _rupees(per_day),
        "bills_per_day": int(round(per_day / ticket)) if ticket else None,
        "actual_bills_per_day": round(
            sales["bills"] / sales["days_open"], 1) if sales["days_open"] else None,
        "fixed_costs_rupees": _rupees(monthly_fixed),
    }


def _rolling(db: Session, outlets: list[int], end: str) -> dict:
    """Food cost over the last four weeks rather than the calendar month.

    One drum of oil bought on the 30th spikes that month and hollows out
    the next. A rolling window is the only honest read for a shop that
    buys in bulk.
    """
    last = date.fromisoformat(end)
    start = (last - timedelta(days=ROLLING_DAYS - 1)).isoformat()
    sales = _sales(db, outlets, start, end)
    spend = _spend_by_group(db, outlets, start, end)["groups"]
    cogs = sum(spend[g]["paise"] for g in COGS_GROUPS)
    return {
        "days": ROLLING_DAYS, "start": start, "end": end,
        "net_rupees": sales["net_rupees"], "cogs_rupees": _rupees(cogs),
        "percent_of_net": _pct(cogs, sales["net_paise"]),
    }


def _sensitivity(sales: dict, cogs: int, days: int, *,
                 cogs_ok: bool, band: list[float]) -> list[dict]:
    """What each lever is worth in rupees a month, at this month's rate.

    Volume levers depend on the contribution margin. When food cost is
    not yet believable the real margin is unknown, so rather than assume
    a near-100% margin and treble every answer, this falls back to the
    middle of the healthy band and says out loud that it did.
    """
    net = sales["net_paise"]
    if not net or not days:
        return []
    monthly_net = net / days * 30
    assumed = None
    if cogs_ok:
        cm = 1 - (cogs / net)
    else:
        assumed = round((band[0] + band[1]) / 2, 1)
        cm = 1 - assumed / 100
    note = ("" if assumed is None else
            f" Assumes a {assumed}% food cost, since yours is not logged yet.")
    out = [
        {"lever": "Cut food cost by 1 point",
         "monthly_rupees": _rupees(monthly_net * 0.01),
         "how": "Better buying, less waste, or a portion check."},
        {"lever": "Cut labour by 1 point",
         "monthly_rupees": _rupees(monthly_net * 0.01),
         "how": "Usually one shift on your quietest weekday."},
    ]
    if sales["bills"]:
        ticket = net / sales["bills"]
        per_day = sales["bills"] / max(sales["days_open"], 1)
        out.append({
            "lever": "Add ₹20 to the average bill",
            "monthly_rupees": _rupees(2000 * per_day * 30 * cm),
            "assumed_food_cost_percent": assumed,
            "how": "One side or one drink attached to each order." + note})
        out.append({
            "lever": "Serve 5 more bills a day",
            "monthly_rupees": _rupees(ticket * 5 * 30 * cm),
            "assumed_food_cost_percent": assumed,
            "how": f"At today's ₹{ticket / 100:,.0f} average bill." + note})
    return out


def _budgets(db: Session, outlets: list[int], groups: dict) -> list[dict]:
    raw = get_setting_db(db, "category_budgets", None) or {}
    if not isinstance(raw, dict):
        return []
    spent_by_cat: dict[str, int] = {}
    for g in groups.values():
        for name, paise in g["categories"].items():
            spent_by_cat[name] = spent_by_cat.get(name, 0) + paise
    out = []
    for key, budget in raw.items():
        try:
            out_id, cat_id = (int(x) for x in str(key).split(":"))
        except ValueError:
            continue
        if out_id not in outlets:
            continue
        cat = db.get(ExpenseCategory, cat_id)
        if cat is None:
            continue
        spent = spent_by_cat.get(cat.name, 0)
        budget_paise = round(float(budget) * 100)
        out.append({
            "category": cat.name,
            "budget_rupees": _rupees(budget_paise),
            "spent_rupees": _rupees(spent),
            "left_rupees": _rupees(budget_paise - spent),
            "used_percent": round(spent / budget_paise * 100, 1)
            if budget_paise else None,
            "over": spent > budget_paise,
        })
    return sorted(out, key=lambda b: -(b["used_percent"] or 0))


def _quality(groups: dict, pay: dict, staff_meals: dict, sales: dict) -> dict:
    missing = [GROUPS[g][0] for g in
               ("cogs_food", "occupancy", "operating")
               if groups[g]["entries"] == 0]
    # Salaries booked as an expense on top of the staff master would count
    # the wage bill twice and make labour look catastrophic.
    salary_cats = [
        name for name in groups["labour"]["categories"]
        if any(w in name.lower() for w in ("salar", "wage", "payroll"))]
    return {
        "missing_groups": missing,
        "payroll_from_staff_master": pay["period_paise"] > 0,
        "staff_meals_in_food_rupees": _rupees(staff_meals["paise"]),
        "staff_meal_entries": staff_meals["entries"],
        "possible_double_counted_salary": salary_cats,
        "has_sales": sales["bills"] > 0,
        # Two gates that decide what this page is allowed to conclude.
        # A profit figure computed from costs nobody logged is not a
        # cautious estimate, it is a lie that reads as good news.
        "costs_complete": not missing,
        "cogs_logged": any(groups[g]["entries"] for g in COGS_GROUPS),
    }


def _findings(f: dict) -> list[dict]:
    out: list[dict] = []

    def add(sev, title, detail):
        out.append({"severity": sev, "title": title, "detail": detail})

    sales = f["sales"]
    if not sales["bills"]:
        add("info", "No sales recorded this month",
            "Import or enter sales and the whole P&L fills in by itself.")
        return by_severity(out)

    q = f["data_quality"]
    prime = f["prime_cost"]

    # Nothing else on this page can be believed until the costs are in.
    if prime["status"] == "unlogged" or q["missing_groups"]:
        gaps = ", ".join(q["missing_groups"]) or "some cost groups"
        add("act", "These figures are not yet trustworthy",
            f"Nothing has been logged this month for: {gaps}. Until it is, "
            "your margin and break-even are guesses that flatter you. "
            "Set the standing monthly costs once and they post themselves.")

    if prime["percent_of_net"] is not None and prime["status"] != "unlogged":
        p = prime["percent_of_net"]
        if p > PRIME_DANGER:
            add("act", f"Prime cost is {p}% — the business cannot carry this",
                f"Food and labour together should stay under "
                f"{prime['band_high']}%. Above {PRIME_DANGER}% there is "
                "nothing left for rent, power and you. This is the one "
                "number to fix before any other.")
        elif p > prime["band_high"]:
            add("watch", f"Prime cost is {p}%, above the {prime['band_high']}% ceiling",
                "Food and labour are the only big costs you can change this "
                "week. Rent cannot be renegotiated on a Tuesday; tomorrow's "
                "order and tomorrow's roster can.")
        else:
            add("good", f"Prime cost is {p}% — inside the healthy band",
                f"Food and labour together are under {prime['band_high']}%, "
                "which is where a restaurant should sit.")

    for line in f["lines"]:
        if line["percent_of_net"] is None or line["key"] == "cogs_bev":
            continue
        pct, hi = line["percent_of_net"], line["band_high"]
        if line["status"] == "over":
            # A point of sales is the same rupees whichever line it is on;
            # sensitivity may be empty if there is nothing to scale from.
            point = f["sensitivity"][0]["monthly_rupees"] if f["sensitivity"] else None
            worth = (f" Every point above it is ₹{point:,.0f} a month at "
                     "your current sales." if point else "")
            add("act", f"{line['label']} is {pct}% of sales",
                f"The healthy band is {line['band_low']}–{hi}%.{worth}")
        elif line["status"] == "high":
            add("watch", f"{line['label']} is {pct}%, just over the band",
                f"{line['band_low']}–{hi}% is where this should sit.")

    be = f["breakeven"]
    if be.get("possible") and be.get("bills_per_day"):
        actual = be["actual_bills_per_day"]
        gap = actual - be["bills_per_day"]
        sev = "good" if gap >= 0 else "act"
        add(sev, f"You need {be['bills_per_day']} bills a day to break even",
            f"You are averaging {actual}. "
            + ("That is a real cushion — keep it."
               if gap >= 0 else
               f"You are {abs(round(gap, 1))} bills a day short, so the month "
               "is running at a loss."))

    if q["staff_meal_entries"]:
        add("watch", "Staff meals are counted as food cost",
            f"₹{q['staff_meals_in_food_rupees']:,.0f} across "
            f"{q['staff_meal_entries']} entries mentions staff. Staff food is "
            "a labour cost — left in food cost it makes your kitchen look "
            "wasteful and your wage bill look lean, which is backwards.")

    if q["possible_double_counted_salary"]:
        add("act", "Salaries may be counted twice",
            "Wages already come from the staff master, but there are also "
            f"entries under: {', '.join(q['possible_double_counted_salary'])}. "
            "Move those to Staff Welfare or delete them, or labour will read "
            "roughly double.")

    roll = f["rolling_food_cost"]
    month_pct = f["cogs"]["percent_of_net"]
    if roll["percent_of_net"] is not None and month_pct is not None:
        if abs(roll["percent_of_net"] - month_pct) >= 5:
            add("info", "Bulk buying is distorting the month",
                f"Food cost reads {month_pct}% for the month but "
                f"{roll['percent_of_net']}% over the last "
                f"{roll['days']} days. The rolling figure is the honest one "
                "when a big order lands near a month end.")

    over = [b for b in f["budgets"] if b["over"]]
    if over:
        add("watch", f"{len(over)} budget(s) already spent",
            ", ".join(f"{b['category']} ₹{b['spent_rupees']:,.0f} of "
                      f"₹{b['budget_rupees']:,.0f}" for b in over[:3]))

    return by_severity(out)
