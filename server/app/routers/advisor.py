"""Spend review: what changed this month, and what to do about it.

Two layers, deliberately separate:

  facts   — computed here, on this machine, from the books. Deterministic,
            reproducible, and correct whether or not AI is configured.
  advice  — optional. Hands the *aggregates only* (category totals, deltas,
            headcount) to the configured model to write the paragraph a
            person actually reads. No bill, no name, no raw row ever leaves.

Written that way round on purpose: an owner deciding whether to cut a
vendor needs numbers that don't change between refreshes. The model is
allowed to phrase and prioritise, never to compute.
"""
from __future__ import annotations

import json
from datetime import date, timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..audit import get_setting_db
from ..db import get_db
from ..models import (Employee, Expense, ExpenseCategory, PayrollRun,
                      Payslip, User)
from ..security import current_user
from ..util import days_in_month
from .helpers import assert_outlet_access, user_outlet_ids
from .insights import FIXED_CATEGORIES_DEFAULT, _sales_by_day, _today
from .ocr import _cfg, _provider_headers, _validate_remote_url

router = APIRouter(prefix="/advisor", tags=["advisor"])

# A month with barely any expenses logged produces impressive-looking
# percentages built on two rows. Below this, we compare nothing and say so.
MIN_ROWS_TO_COMPARE = 3

# Don't shout about a rounding error. A change has to clear both bars.
MATERIAL_PAISE = 50_000        # ₹500
MATERIAL_PCT = 15.0
PRICE_RISE_PCT = 10.0


def _rupees(paise: int | float) -> float:
    return round((paise or 0) / 100, 2)


def _pct(new: float, old: float) -> float | None:
    """Percent change, or None when there's no baseline to change from."""
    if not old:
        return None
    return round((new - old) / old * 100, 1)


def _month_bounds(y: int, m: int) -> tuple[date, date]:
    lo = date(y, m, 1)
    return lo, lo + timedelta(days=days_in_month(y, m) - 1)


def _prev_month(y: int, m: int) -> tuple[int, int]:
    return (y - 1, 12) if m == 1 else (y, m - 1)


def _parse_month(month: str | None) -> tuple[int, int]:
    if not month:
        t = _today()
        return t.year, t.month
    try:
        y, m = month.split("-")
        y, m = int(y), int(m)
        if not (1 <= m <= 12 and 2000 <= y <= 2999):
            raise ValueError
    except (ValueError, AttributeError):
        raise HTTPException(422, "month must look like 2025-03")
    return y, m


def _expenses(db: Session, outlets: list[int], lo: date, hi: date) -> list[Expense]:
    return (db.query(Expense)
              .filter(Expense.outlet_id.in_(outlets),
                      Expense.business_date >= lo.isoformat(),
                      Expense.business_date <= hi.isoformat()).all())


def _by_category(rows: list[Expense], names: dict[int, str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for e in rows:
        key = names.get(e.category_id, "Uncategorised")
        out[key] = out.get(key, 0) + e.amount_paise
    return out


def _unit_prices(rows: list[Expense]) -> dict[str, dict]:
    """Average price per unit for each named item bought by quantity.

    Only expenses that recorded a quantity can answer "did my supplier
    raise the price"; the rest are lump sums and tell us nothing per-kg.
    """
    acc: dict[str, dict] = {}
    for e in rows:
        name = (e.item_name or "").strip()
        if not name or not e.quantity or e.quantity <= 0:
            continue
        a = acc.setdefault(name.lower(), {
            "item": name, "unit": e.unit or "", "paise": 0, "qty": 0.0})
        a["paise"] += e.amount_paise
        a["qty"] += e.quantity
    for a in acc.values():
        a["unit_price_rupees"] = round(a["paise"] / a["qty"] / 100, 2)
    return acc


def _headcount(db: Session, outlets: list[int], lo: date, hi: date) -> dict:
    """Who was actually on the books during the month.

    An employee counts if they'd joined by the end of it and hadn't left
    before it started — so a leaver still counts in the month they left,
    which is the month you still paid them.
    """
    emps = db.query(Employee).filter(Employee.outlet_id.in_(outlets)).all()
    lo_s, hi_s = lo.isoformat(), hi.isoformat()
    present, joined, left = [], [], []
    for e in emps:
        jd, xd = e.join_date or "", e.exit_date or ""
        if jd and jd > hi_s:
            continue
        if xd and xd < lo_s:
            continue
        present.append(e)
        if jd and lo_s <= jd <= hi_s:
            joined.append(e.name)
        if xd and lo_s <= xd <= hi_s:
            left.append(e.name)
    return {
        "headcount": len(present),
        "joined": sorted(joined),
        "left": sorted(left),
        "committed_salary_paise": sum(e.monthly_salary_paise or 0 for e in present),
    }


def _payroll_paid(db: Session, outlets: list[int], y: int, m: int) -> int:
    runs = (db.query(PayrollRun)
              .filter(PayrollRun.outlet_id.in_(outlets),
                      PayrollRun.year == y, PayrollRun.month == m).all())
    total = 0
    for run in runs:
        total += sum(s.gross_paise
                     for s in db.query(Payslip).filter_by(run_id=run.id).all())
    return total


def build_facts(db: Session, user: User, month: str | None,
                outlet_id: int | None) -> dict:
    """Everything the review needs, in rupees, with no opinions attached."""
    y, m = _parse_month(month)
    py, pm = _prev_month(y, m)
    lo, hi = _month_bounds(y, m)
    plo, phi = _month_bounds(py, pm)

    outlets = user_outlet_ids(db, user)
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        outlets = [outlet_id]

    today = _today()
    # A month still running must be compared like-for-like: 12 days of this
    # month against the first 12 days of last month, never against its whole.
    partial = (y, m) == (today.year, today.month)
    hi_eff = min(hi, today) if partial else hi
    phi_eff = min(phi, plo + timedelta(days=(hi_eff - lo).days)) if partial else phi

    names = {c.id: c.name for c in db.query(ExpenseCategory).all()}
    cur_rows = _expenses(db, outlets, lo, hi_eff)
    prev_rows = _expenses(db, outlets, plo, phi_eff)

    cur_cat = _by_category(cur_rows, names)
    prev_cat = _by_category(prev_rows, names)

    fixed_names = {n.lower() for n in get_setting_db(
        db, "fixed_categories", FIXED_CATEGORIES_DEFAULT)}

    def split(by_cat: dict[str, int]) -> tuple[int, int]:
        fixed = sum(v for k, v in by_cat.items() if k.lower() in fixed_names)
        return fixed, sum(by_cat.values()) - fixed

    cur_fixed, cur_var = split(cur_cat)
    prev_fixed, prev_var = split(prev_cat)

    cur_sales = sum(_sales_by_day(db, outlets, lo, hi_eff).values())
    prev_sales = sum(_sales_by_day(db, outlets, plo, phi_eff).values())
    cur_spend = sum(cur_cat.values())
    prev_spend = sum(prev_cat.values())

    cur_staff = _headcount(db, outlets, lo, hi)
    prev_staff = _headcount(db, outlets, plo, phi)

    categories = []
    for name in sorted(set(cur_cat) | set(prev_cat)):
        now_p, was_p = cur_cat.get(name, 0), prev_cat.get(name, 0)
        categories.append({
            "category": name,
            "rupees": _rupees(now_p),
            "prev_rupees": _rupees(was_p),
            "delta_rupees": _rupees(now_p - was_p),
            "delta_percent": _pct(now_p, was_p),
            "share_percent": round(now_p / cur_spend * 100, 1) if cur_spend else 0.0,
            "is_fixed": name.lower() in fixed_names,
        })
    categories.sort(key=lambda c: -c["delta_rupees"])

    cur_items, prev_items = _unit_prices(cur_rows), _unit_prices(prev_rows)
    items = []
    for key, a in cur_items.items():
        b = prev_items.get(key)
        items.append({
            "item": a["item"], "unit": a["unit"],
            "qty": round(a["qty"], 2),
            "unit_price_rupees": a["unit_price_rupees"],
            "prev_unit_price_rupees": b["unit_price_rupees"] if b else None,
            "delta_percent": _pct(a["unit_price_rupees"],
                                  b["unit_price_rupees"]) if b else None,
        })
    items.sort(key=lambda i: -(i["delta_percent"] or -999))

    enough = (len(cur_rows) >= MIN_ROWS_TO_COMPARE
              and len(prev_rows) >= MIN_ROWS_TO_COMPARE)
    notes = []
    if not enough:
        notes.append(
            "Not enough logged expenses to compare the two months yet — "
            f"{len(cur_rows)} this month, {len(prev_rows)} last. "
            "Keep logging and this fills in.")
    if partial:
        notes.append(
            f"This month is still running, so it's measured to {hi_eff.isoformat()} "
            "against the same stretch of last month.")
    if not cur_sales:
        notes.append("No sales recorded for this period, so cost-vs-sales is blank.")
    if _payroll_paid(db, outlets, y, m) == 0 and cur_staff["committed_salary_paise"]:
        notes.append(
            "No payroll run finalised for this month, so salary figures are the "
            "committed monthly amounts, not what was actually paid out.")

    return {
        "month": f"{y:04d}-{m:02d}",
        "prev_month": f"{py:04d}-{pm:02d}",
        "outlet_id": outlet_id,
        "period": {"start": lo.isoformat(), "end": hi_eff.isoformat(),
                   "prev_start": plo.isoformat(), "prev_end": phi_eff.isoformat(),
                   "partial": partial},
        "totals": {
            "spend_rupees": _rupees(cur_spend),
            "prev_spend_rupees": _rupees(prev_spend),
            "spend_delta_percent": _pct(cur_spend, prev_spend),
            "sales_rupees": _rupees(cur_sales),
            "prev_sales_rupees": _rupees(prev_sales),
            "sales_delta_percent": _pct(cur_sales, prev_sales),
            "spend_percent_of_sales":
                round(cur_spend / cur_sales * 100, 1) if cur_sales else None,
            "prev_spend_percent_of_sales":
                round(prev_spend / prev_sales * 100, 1) if prev_sales else None,
        },
        "fixed_variable": {
            "fixed_rupees": _rupees(cur_fixed),
            "prev_fixed_rupees": _rupees(prev_fixed),
            "variable_rupees": _rupees(cur_var),
            "prev_variable_rupees": _rupees(prev_var),
            "payroll_paid_rupees": _rupees(_payroll_paid(db, outlets, y, m)),
        },
        "staff": {
            "headcount": cur_staff["headcount"],
            "prev_headcount": prev_staff["headcount"],
            "joined": cur_staff["joined"],
            "left": cur_staff["left"],
            "committed_salary_rupees": _rupees(cur_staff["committed_salary_paise"]),
            "prev_committed_salary_rupees":
                _rupees(prev_staff["committed_salary_paise"]),
        },
        "categories": categories,
        "items": items[:15],
        "data_quality": {
            "expenses_this_month": len(cur_rows),
            "expenses_prev_month": len(prev_rows),
            "enough_to_compare": enough,
            "notes": notes,
        },
    }


def build_findings(f: dict) -> list[dict]:
    """The rules an accountant would apply, spelled out.

    These run with AI switched off, which is the point: the page has to be
    worth opening on a machine that has never seen the internet.
    """
    out: list[dict] = []
    t, fv, st = f["totals"], f["fixed_variable"], f["staff"]
    comparable = f["data_quality"]["enough_to_compare"]

    def add(sev, title, detail, **extra):
        out.append({"severity": sev, "title": title, "detail": detail, **extra})

    if not comparable:
        add("info", "Too early to compare months",
            f["data_quality"]["notes"][0])

    # ── where the money went, this month, no comparison needed ──────────
    spenders = [c for c in f["categories"] if c["rupees"] > 0]
    if spenders:
        top = max(spenders, key=lambda c: c["rupees"])
        add("info", f"Biggest cost: {top['category']}",
            f"₹{top['rupees']:,.0f} — {top['share_percent']}% of everything "
            f"you spent in {f['month']}.")

    if t["spend_percent_of_sales"] is not None:
        now = t["spend_percent_of_sales"]
        # Last month's percentage is only a fair comparison when last month
        # was actually written up. Otherwise "was 0%" reads as if costs
        # appeared from nowhere, when really nobody logged them.
        prev = t["prev_spend_percent_of_sales"] if comparable else None
        if prev is not None and now - prev >= 3:
            add("act", "Costs are eating more of each rupee you take",
                f"Spending is {now}% of sales, up from {prev}% last month. "
                f"Every 1% here is about ₹{t['sales_rupees'] / 100:,.0f} a month.")
        elif prev is not None and prev - now >= 3:
            add("good", "You're keeping more of each rupee",
                f"Spending fell to {now}% of sales from {prev}%.")
        else:
            add("info", "Cost as a share of sales",
                f"You spent {now}% of your sales in {f['month']}"
                + (f" (was {prev}% last month)." if prev is not None else "."))

    if not comparable:
        return out

    # ── what went up ────────────────────────────────────────────────────
    risers = [c for c in f["categories"]
              if c["delta_rupees"] * 100 >= MATERIAL_PAISE
              and (c["delta_percent"] is None
                   or c["delta_percent"] >= MATERIAL_PCT)]
    for c in risers[:5]:
        if c["prev_rupees"] == 0:
            add("watch", f"New spend: {c['category']}",
                f"₹{c['rupees']:,.0f} this month, nothing last month.",
                category=c["category"], delta_rupees=c["delta_rupees"])
        else:
            add("act" if c["is_fixed"] else "watch",
                f"{c['category']} is up ₹{c['delta_rupees']:,.0f}",
                f"₹{c['rupees']:,.0f} this month against ₹{c['prev_rupees']:,.0f} "
                f"last month — {c['delta_percent']:+.0f}%."
                + (" This is a fixed cost, so it repeats every month until "
                   "you renegotiate it." if c["is_fixed"] else ""),
                category=c["category"], delta_rupees=c["delta_rupees"])

    fallers = [c for c in f["categories"] if c["delta_rupees"] * 100 <= -MATERIAL_PAISE]
    if fallers:
        c = fallers[-1]
        add("good", f"{c['category']} came down ₹{abs(c['delta_rupees']):,.0f}",
            f"₹{c['rupees']:,.0f} against ₹{c['prev_rupees']:,.0f} last month.")

    # ── why the fixed costs moved ───────────────────────────────────────
    fixed_delta = fv["fixed_rupees"] - fv["prev_fixed_rupees"]
    if abs(fixed_delta) * 100 >= MATERIAL_PAISE:
        movers = [c for c in f["categories"]
                  if c["is_fixed"] and abs(c["delta_rupees"]) * 100 >= MATERIAL_PAISE]
        who = ", ".join(f"{c['category']} {c['delta_rupees']:+,.0f}"
                        for c in movers[:4]) or "several small changes"
        add("act" if fixed_delta > 0 else "good",
            f"Fixed costs {'rose' if fixed_delta > 0 else 'fell'} "
            f"₹{abs(fixed_delta):,.0f}",
            f"₹{fv['fixed_rupees']:,.0f} against ₹{fv['prev_fixed_rupees']:,.0f}. "
            f"The change came from: {who}.")

    # ── staff ───────────────────────────────────────────────────────────
    if st["headcount"] != st["prev_headcount"]:
        diff = st["headcount"] - st["prev_headcount"]
        who = []
        if st["joined"]:
            who.append("joined: " + ", ".join(st["joined"]))
        if st["left"]:
            who.append("left: " + ", ".join(st["left"]))
        salary_delta = st["committed_salary_rupees"] - st["prev_committed_salary_rupees"]
        add("act" if diff > 0 else "info",
            f"Staff count {'went up' if diff > 0 else 'went down'} by {abs(diff)}",
            f"{st['prev_headcount']} last month, {st['headcount']} now"
            + (f" ({'; '.join(who)})" if who else "")
            + f". That moves committed salary by ₹{salary_delta:+,.0f} a month.")
    elif abs(st["committed_salary_rupees"]
             - st["prev_committed_salary_rupees"]) * 100 >= MATERIAL_PAISE:
        add("watch", "Salary bill changed without headcount changing",
            f"Same {st['headcount']} people, but committed salary went from "
            f"₹{st['prev_committed_salary_rupees']:,.0f} to "
            f"₹{st['committed_salary_rupees']:,.0f} — a raise or a correction.")

    # ── supplier prices ─────────────────────────────────────────────────
    for i in f["items"][:4]:
        if i["delta_percent"] is not None and i["delta_percent"] >= PRICE_RISE_PCT:
            unit = f"/{i['unit']}" if i["unit"] else ""
            add("watch", f"{i['item']} costs {i['delta_percent']:+.0f}% more",
                f"₹{i['unit_price_rupees']:,.2f}{unit} now, was "
                f"₹{i['prev_unit_price_rupees']:,.2f}{unit}. "
                "Worth a call to the supplier or a second quote.",
                item=i["item"])

    # ── where to cut ────────────────────────────────────────────────────
    variable = [c for c in f["categories"]
                if not c["is_fixed"] and c["rupees"] > 0]
    if variable and t["sales_rupees"]:
        biggest = max(variable, key=lambda c: c["rupees"])
        add("info", f"Easiest place to save: {biggest['category']}",
            f"It's your largest cost you can actually control — "
            f"₹{biggest['rupees']:,.0f}, {biggest['share_percent']}% of spend. "
            f"Trimming it 10% keeps ₹{biggest['rupees'] * 0.1:,.0f} a month.")

    order = {"act": 0, "watch": 1, "good": 2, "info": 3}
    out.sort(key=lambda x: order.get(x["severity"], 9))
    return out


@router.get("/review")
def review(month: str | None = None, outlet_id: int | None = None,
           user: User = Depends(current_user), db: Session = Depends(get_db)):
    facts = build_facts(db, user, month, outlet_id)
    return {**facts, "findings": build_findings(facts)}


# ── the optional AI paragraph ───────────────────────────────────────────────

ADVICE_PROMPT = (
    "You advise the owner of a small Indian restaurant. Below is a JSON "
    "summary of their month: totals, per-category spend against last month, "
    "fixed vs variable split, staff changes and ingredient unit prices. All "
    "amounts are already in rupees.\n\n"
    "Write plain, direct advice for a busy owner. Rules:\n"
    "- Use ONLY the numbers given. Never invent a figure or a trend.\n"
    "- If data_quality.enough_to_compare is false, say clearly that there "
    "isn't enough logged data yet and keep it to one short paragraph.\n"
    "- Lead with the single most important thing.\n"
    "- Explain WHY a cost moved when the data shows it, and name what to do.\n"
    "- Be specific: name the category and the rupee amount.\n"
    "- No preamble, no headings, no markdown. At most 200 words.\n"
)


class AdviceIn(BaseModel):
    month: str | None = None
    outlet_id: int | None = None


def _slim(facts: dict) -> dict:
    """What we're willing to send out: aggregates, nothing identifying.

    Staff names are stripped — the model needs to know two people joined,
    not who they are.
    """
    s = dict(facts["staff"])
    s["joined"], s["left"] = len(s["joined"]), len(s["left"])
    return {
        "month": facts["month"], "prev_month": facts["prev_month"],
        "totals": facts["totals"], "fixed_variable": facts["fixed_variable"],
        "staff": s,
        "categories": [c for c in facts["categories"]
                       if c["rupees"] or c["prev_rupees"]][:20],
        "items": [{k: v for k, v in i.items() if k != "qty"}
                  for i in facts["items"][:10]],
        "data_quality": facts["data_quality"],
    }


@router.post("/advice")
def advice(body: AdviceIn, user: User = Depends(current_user),
           db: Session = Depends(get_db)):
    c = _cfg(db)
    if not c["enabled"] or not c["base_url"] or not c["model"]:
        raise HTTPException(
            400, "AI isn't set up yet. Add a model under Settings → AI first.")
    if c["provider"] != "openai_compat":
        raise HTTPException(
            400, "Written advice needs an OpenAI-compatible model "
                 "(the same one bill scanning uses).")
    _validate_remote_url(c["base_url"], bool(c.get("key")))

    facts = build_facts(db, user, body.month, body.outlet_id)
    payload = _slim(facts)

    req = {
        "model": c["model"],
        "temperature": 0.2,
        "max_tokens": 700,
        "messages": [{"role": "user",
                      "content": ADVICE_PROMPT + "\n" + json.dumps(payload)}],
    }
    try:
        r = httpx.post(f"{c['base_url']}/chat/completions", json=req,
                       headers=_provider_headers(c), timeout=90)
    except httpx.HTTPError as ex:
        raise HTTPException(502, f"Couldn't reach the AI endpoint: {ex}")
    if r.status_code != 200:
        raise HTTPException(502, f"AI API said {r.status_code}: {r.text[:200]}")
    try:
        text = r.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError):
        raise HTTPException(502, "AI reply didn't look like a chat completion.")
    if not isinstance(text, str):
        text = json.dumps(text)
    text = text.strip()
    if not text:
        raise HTTPException(502, "The model sent back an empty answer — try again.")
    return {"text": text, "model": c["model"],
            "findings": build_findings(facts), "facts": facts}
