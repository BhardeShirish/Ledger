"""Patterns hiding in data you already have.

Two questions an owner asks that the ledger could always have answered but
never did:

  /patterns/bills      when do people come, how much do they spend, and
                       what will next week look like — from bill timestamps
  /patterns/purchases  what do I buy, from whom, how often, and is the
                       price creeping up — from expenses and stock movements

Both return plain figures plus findings written the way you'd say them out
loud. Neither invents anything: where the data can't answer, it says so.
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, datetime, timedelta
from statistics import median

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import (Expense, ExpenseCategory, SalesBill, User, Vendor)
from ..security import current_user
from .helpers import assert_outlet_access, user_outlet_ids
from .advisor import by_severity
from .insights import _today

router = APIRouter(prefix="/patterns", tags=["patterns"])

DOW = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
       "Saturday", "Sunday"]

TICKET_BUCKETS = [
    (0, 10000, "Under ₹100"),
    (10000, 30000, "₹100–₹300"),
    (30000, 60000, "₹300–₹600"),
    (60000, 100000, "₹600–₹1,000"),
    (100000, None, "Over ₹1,000"),
]

# A price move smaller than this is haggling, not a trend.
PRICE_MOVE_PCT = 10.0
# Same item, same short window, wildly different price = probably a typo.
SUSPECT_SPREAD_PCT = 60.0
MIN_WEEKS_FOR_FORECAST = 2


def _rupees(paise: int | float) -> float:
    return round((paise or 0) / 100, 2)


def _scope(db: Session, user: User, outlet_id: int | None) -> list[int]:
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        return [outlet_id]
    return user_outlet_ids(db, user)


def _window(start: str | None, end: str | None) -> tuple[str, str]:
    hi = end or _today().isoformat()
    lo = start or (date.fromisoformat(hi) - timedelta(days=89)).isoformat()
    try:
        if date.fromisoformat(lo) > date.fromisoformat(hi):
            raise HTTPException(422, "start must fall on or before end")
    except ValueError:
        raise HTTPException(422, "dates must look like 2025-08-31")
    return lo, hi


# ── when do people come, and what will next week look like ─────────────────

@router.get("/bills")
def bill_patterns(start: str | None = None, end: str | None = None,
                  outlet_id: int | None = None,
                  user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    lo, hi = _window(start, end)
    outlets = _scope(db, user, outlet_id)
    bills = (db.query(SalesBill)
               .filter(SalesBill.outlet_id.in_(outlets),
                       SalesBill.business_date >= lo,
                       SalesBill.business_date <= hi).all())

    hours = {h: {"hour": h, "bills": 0, "paise": 0} for h in range(24)}
    unstamped = 0
    by_dow: dict[int, dict] = {d: {"bills": 0, "paise": 0, "days": set()}
                               for d in range(7)}
    by_day: dict[str, int] = defaultdict(int)
    by_month: dict[str, dict] = {}
    tickets = [{"label": lbl, "bills": 0, "paise": 0} for _, _, lbl in TICKET_BUCKETS]
    order_types: dict[str, dict] = {}
    channels: dict[str, dict] = {}
    disc_bills = disc_paise = tip_bills = tip_paise = gross = 0

    for b in bills:
        amt = b.total_paise or 0
        # Hour needs a timestamp; a manually keyed bill may not carry one.
        stamp = (b.bill_ts or "").strip()
        if len(stamp) >= 13:
            try:
                h = datetime.strptime(stamp[:13], "%Y-%m-%d %H").hour
                hours[h]["bills"] += 1
                hours[h]["paise"] += amt
            except ValueError:
                unstamped += 1
        else:
            unstamped += 1

        d = date.fromisoformat(b.business_date)
        w = by_dow[d.weekday()]
        w["bills"] += 1
        w["paise"] += amt
        w["days"].add(b.business_date)
        by_day[b.business_date] += amt

        m = by_month.setdefault(b.business_date[:7],
                                {"month": b.business_date[:7], "bills": 0,
                                 "paise": 0, "days": set()})
        m["bills"] += 1
        m["paise"] += amt
        m["days"].add(b.business_date)

        for i, (blo, bhi, _) in enumerate(TICKET_BUCKETS):
            if amt >= blo and (bhi is None or amt < bhi):
                tickets[i]["bills"] += 1
                tickets[i]["paise"] += amt
                break

        for bucket, key in ((order_types, (b.order_type or "Unspecified")),
                            (channels, (b.channel_kind or "other"))):
            e = bucket.setdefault(key, {"name": key, "bills": 0, "paise": 0})
            e["bills"] += 1
            e["paise"] += amt

        gross += b.gross_paise or 0
        if (b.discount_paise or 0) > 0:
            disc_bills += 1
            disc_paise += b.discount_paise
        if (b.tip_paise or 0) > 0:
            tip_bills += 1
            tip_paise += b.tip_paise

    weekdays = []
    for d in range(7):
        w = by_dow[d]
        n = len(w["days"]) or 1
        weekdays.append({
            "dow": d, "name": DOW[d], "days_open": len(w["days"]),
            "bills": w["bills"],
            "bills_per_day": round(w["bills"] / n, 1),
            "rupees_per_day": _rupees(w["paise"] / n),
            "rupees": _rupees(w["paise"]),
        })

    months = [{"month": m["month"], "days": len(m["days"]), "bills": m["bills"],
               "rupees": _rupees(m["paise"]),
               "rupees_per_day": _rupees(m["paise"] / max(len(m["days"]), 1)),
               "avg_ticket_rupees": _rupees(m["paise"] / max(m["bills"], 1))}
              for m in sorted(by_month.values(), key=lambda x: x["month"])]

    total = sum(b.total_paise or 0 for b in bills)
    facts = {
        "period": {"start": lo, "end": hi},
        "totals": {
            "bills": len(bills),
            "rupees": _rupees(total),
            "days_open": len(by_day),
            "avg_ticket_rupees": _rupees(total / len(bills)) if bills else 0.0,
            "bills_without_a_time": unstamped,
        },
        "hours": [{"hour": h["hour"], "bills": h["bills"],
                   "rupees": _rupees(h["paise"])}
                  for h in hours.values()],
        "weekdays": weekdays,
        "months": months,
        "tickets": [{**t, "rupees": _rupees(t.pop("paise")),
                     "share_percent": round(t["bills"] / len(bills) * 100, 1)
                     if bills else 0.0}
                    for t in tickets],
        "order_types": sorted(
            [{"name": v["name"], "bills": v["bills"], "rupees": _rupees(v["paise"]),
              "avg_ticket_rupees": _rupees(v["paise"] / v["bills"]),
              "share_percent": round(v["paise"] / total * 100, 1) if total else 0.0}
             for v in order_types.values()], key=lambda x: -x["rupees"]),
        "channels": sorted(
            [{"name": v["name"], "bills": v["bills"], "rupees": _rupees(v["paise"]),
              "share_percent": round(v["paise"] / total * 100, 1) if total else 0.0}
             for v in channels.values()], key=lambda x: -x["rupees"]),
        "leakage": {
            "discounted_bills": disc_bills,
            "discount_rupees": _rupees(disc_paise),
            "discount_percent_of_gross": round(disc_paise / gross * 100, 2)
            if gross else 0.0,
            "tipped_bills": tip_bills,
            "tip_rupees": _rupees(tip_paise),
        },
        "forecast": _forecast(by_day, hi),
    }
    facts["findings"] = _bill_findings(facts)
    return facts


def _forecast(by_day: dict[str, int], end: str) -> dict:
    """Next seven days, each predicted from its own weekday's recent history.

    A median of the last few same-weekdays, not a mean: one wedding booking
    should not raise every future Tuesday. Sundays here run 3x a Tuesday, so
    a single blended average would be wrong on all seven days.
    """
    per_dow: dict[int, list[int]] = defaultdict(list)
    for iso, paise in sorted(by_day.items()):
        per_dow[date.fromisoformat(iso).weekday()].append(paise)

    last = date.fromisoformat(end)
    days, total, weakest = [], 0, []
    for i in range(1, 8):
        d = last + timedelta(days=i)
        hist = per_dow.get(d.weekday(), [])[-8:]
        if len(hist) < MIN_WEEKS_FOR_FORECAST:
            weakest.append(DOW[d.weekday()])
            days.append({"date": d.isoformat(), "weekday": DOW[d.weekday()],
                         "rupees": None, "based_on_days": len(hist)})
            continue
        est = int(median(hist))
        total += est
        days.append({"date": d.isoformat(), "weekday": DOW[d.weekday()],
                     "rupees": _rupees(est), "based_on_days": len(hist)})
    return {
        "days": days,
        "week_rupees": _rupees(total) if total else None,
        "unforecastable_weekdays": weakest,
        "method": "median of the last 8 same weekdays",
    }


def _bill_findings(f: dict) -> list[dict]:
    out: list[dict] = []

    def add(sev, title, detail, **extra):
        out.append({"severity": sev, "title": title, "detail": detail, **extra})

    if not f["totals"]["bills"]:
        add("info", "No bills in this period",
            "Import or record sales and the patterns appear here.")
        return out

    # busiest hour, and the real lull between services
    live = [h for h in f["hours"] if h["bills"]]
    if len(live) >= 3:
        peak = max(live, key=lambda h: h["rupees"])
        add("info", f"Busiest hour is {peak['hour']:02d}:00",
            f"₹{peak['rupees']:,.0f} across {peak['bills']} bills.")

        # An owner wants the gap between services, not the last hour of the
        # night. Find the second peak far enough from the first to be a
        # separate rush, then name the quietest hour sitting between them —
        # that is the window with staff already in and nothing to serve.
        far = [h for h in live if abs(h["hour"] - peak["hour"]) >= 4]
        second = max(far, key=lambda h: h["rupees"]) if far else None
        if second:
            a, b = sorted((peak["hour"], second["hour"]))
            between = [h for h in live if a < h["hour"] < b]
            if between:
                lull = min(between, key=lambda h: h["rupees"])
                add("info", f"Your quiet stretch is around {lull['hour']:02d}:00",
                    f"Two rushes — {a:02d}:00 and {b:02d}:00 — with "
                    f"{lull['hour']:02d}:00 the flattest hour between them at "
                    f"₹{lull['rupees']:,.0f}. That's the window for prep, "
                    "cleaning and staff breaks.")
        # a genuinely dead tail is worth naming
        tail = [h for h in sorted(live, key=lambda h: h["hour"])
                if h["hour"] >= 21 and h["bills"] < peak["bills"] * 0.1]
        if tail:
            lost = sum(h["rupees"] for h in tail)
            add("watch",
                f"After {tail[0]['hour']:02d}:00 you take ₹{lost:,.0f} in total",
                f"{sum(h['bills'] for h in tail)} bills across the whole period. "
                "Closing earlier would cost you very little and save a shift.")

    # weekday spread
    open_days = [w for w in f["weekdays"] if w["days_open"]]
    if len(open_days) >= 4:
        best = max(open_days, key=lambda w: w["rupees_per_day"])
        worst = min(open_days, key=lambda w: w["rupees_per_day"])
        if worst["rupees_per_day"] > 0:
            ratio = best["rupees_per_day"] / worst["rupees_per_day"]
            if ratio >= 1.5:
                add("act", f"{best['name']} is worth "
                           f"{ratio:.1f}× a {worst['name']}",
                    f"₹{best['rupees_per_day']:,.0f} a day against "
                    f"₹{worst['rupees_per_day']:,.0f}. Buy and roster for the "
                    f"week you actually have — heavy for {best['name']}, "
                    f"light for {worst['name']}.")

    # trend
    months = [m for m in f["months"] if m["days"] >= 7]
    if len(months) >= 2:
        first, last = months[0], months[-1]
        if first["rupees_per_day"]:
            chg = (last["rupees_per_day"] - first["rupees_per_day"]) \
                / first["rupees_per_day"] * 100
            if abs(chg) >= 10:
                add("good" if chg > 0 else "act",
                    f"Daily takings are {'up' if chg > 0 else 'down'} "
                    f"{abs(chg):.0f}% since {first['month']}",
                    f"₹{first['rupees_per_day']:,.0f} a day then, "
                    f"₹{last['rupees_per_day']:,.0f} now. Average bill went "
                    f"from ₹{first['avg_ticket_rupees']:,.0f} to "
                    f"₹{last['avg_ticket_rupees']:,.0f}.")

    # ticket mix
    small = f["tickets"][0]
    if small["share_percent"] >= 25:
        add("watch", f"{small['share_percent']:.0f}% of bills are {small['label'].lower()}",
            f"{small['bills']:,} bills bringing ₹{small['rupees']:,.0f}. "
            "A ₹20 add-on offered on those is worth "
            f"₹{small['bills'] * 20:,.0f} over this period.")

    # channel reality
    if len(f["order_types"]) >= 2:
        minor = f["order_types"][1:]
        for m in minor:
            if m["share_percent"] < 2:
                add("info", f"{m['name']} is only {m['share_percent']:.1f}% of takings",
                    f"{m['bills']} bills, ₹{m['rupees']:,.0f}. Either grow it "
                    "on purpose or stop counting on it in your plans.")

    # discounts
    lk = f["leakage"]
    if lk["discount_percent_of_gross"] >= 3:
        add("act", f"Discounts are {lk['discount_percent_of_gross']:.1f}% of gross",
            f"₹{lk['discount_rupees']:,.0f} given away over "
            f"{lk['discounted_bills']} bills. Worth knowing who approves them.")
    elif lk["discounted_bills"]:
        add("good", "Discounts are under control",
            f"₹{lk['discount_rupees']:,.0f} over {lk['discounted_bills']} bills "
            f"— {lk['discount_percent_of_gross']:.1f}% of gross.")

    if f["totals"]["bills_without_a_time"]:
        n = f["totals"]["bills_without_a_time"]
        add("info", f"{n} bills have no time on them",
            "Those are missing from the hourly chart. They still count in "
            "every daily and weekday figure.")

    return by_severity(out)


# ── what you buy, from whom, how often, at what price ──────────────────────

STOPWORDS = {"fresh", "local", "premium", "brand", "pkt", "packet", "bag",
             "loose", "org", "organic", "new", "old"}


def _norm(name: str) -> str:
    """Fold a written item name down to something comparable.

    Bills come in as "TOMATO HYBRID (अंग्रेज़ी टमाटर)" one day and "Tomato"
    the next. Without folding, those are two items and neither has a price
    history worth reading.
    """
    n = re.sub(r"\([^)]*\)", " ", name or "")        # drop the bracketed gloss
    n = re.sub(r"[^0-9a-zA-Z\u0900-\u097F ]+", " ", n).lower()
    return " ".join(n.split())


def _tokens(name: str) -> set[str]:
    return {t for t in _norm(name).split() if len(t) > 2 and t not in STOPWORDS}


@router.get("/purchases")
def purchases(start: str | None = None, end: str | None = None,
              outlet_id: int | None = None,
              user: User = Depends(current_user),
              db: Session = Depends(get_db)):
    lo, hi = _window(start, end)
    outlets = _scope(db, user, outlet_id)

    rows = (db.query(Expense)
              .filter(Expense.outlet_id.in_(outlets),
                      Expense.business_date >= lo,
                      Expense.business_date <= hi).all())
    cats = {c.id: c.name for c in db.query(ExpenseCategory).all()}
    vends = {v.id: v.name for v in db.query(Vendor).all()}

    total = sum(e.amount_paise for e in rows)

    by_cat: dict[str, dict] = {}
    by_vendor: dict[str, dict] = {}
    for e in rows:
        c = by_cat.setdefault(cats.get(e.category_id, "Uncategorised"),
                              {"name": cats.get(e.category_id, "Uncategorised"),
                               "paise": 0, "entries": 0})
        c["paise"] += e.amount_paise
        c["entries"] += 1
        vname = vends.get(e.vendor_id) or "No vendor recorded"
        v = by_vendor.setdefault(vname, {"name": vname, "paise": 0, "orders": 0,
                                         "dates": set()})
        v["paise"] += e.amount_paise
        v["orders"] += 1
        v["dates"].add(e.business_date)

    # per-item price history, from anything bought by quantity
    hist: dict[str, dict] = {}
    untracked_n = untracked_paise = 0
    for e in rows:
        name = (e.item_name or "").strip()
        if not name or not e.quantity or e.quantity <= 0:
            untracked_n += 1
            untracked_paise += e.amount_paise
            continue
        key = _norm(name) or name.lower()
        it = hist.setdefault(key, {"item": name, "unit": e.unit or "",
                                   "names": set(), "buys": []})
        it["names"].add(name)
        it["buys"].append({
            "date": e.business_date,
            "qty": round(e.quantity, 3),
            "rupees": _rupees(e.amount_paise),
            "unit_price_rupees": round(e.amount_paise / e.quantity / 100, 2),
            "vendor": vends.get(e.vendor_id) or "",
        })

    items = []
    for it in hist.values():
        buys = sorted(it["buys"], key=lambda b: (b["date"], b["unit_price_rupees"]))
        prices = [b["unit_price_rupees"] for b in buys]
        spend = sum(b["rupees"] for b in buys)
        qty = sum(b["qty"] for b in buys)
        dates = sorted({b["date"] for b in buys})
        gap = None
        if len(dates) >= 2:
            spans = [(date.fromisoformat(b) - date.fromisoformat(a)).days
                     for a, b in zip(dates, dates[1:])]
            gap = round(sum(spans) / len(spans), 1)
        items.append({
            "item": it["item"],
            "unit": it["unit"],
            "also_written_as": sorted(n for n in it["names"] if n != it["item"]),
            "times_bought": len(buys),
            "days_bought_on": len(dates),
            "avg_days_between": gap,
            "qty": round(qty, 2),
            "rupees": round(spend, 2),
            "avg_unit_price_rupees": round(spend / qty, 2) if qty else None,
            "first_unit_price_rupees": prices[0],
            "last_unit_price_rupees": prices[-1],
            "min_unit_price_rupees": min(prices),
            "max_unit_price_rupees": max(prices),
            "change_percent": round((prices[-1] - prices[0]) / prices[0] * 100, 1)
            if len(prices) > 1 and prices[0] else None,
            "history": buys,
        })
    items.sort(key=lambda i: -i["rupees"])

    facts = {
        "period": {"start": lo, "end": hi},
        "totals": {"rupees": _rupees(total), "entries": len(rows),
                   "items_price_tracked": len(items)},
        "categories": sorted(
            [{"name": c["name"], "rupees": _rupees(c["paise"]),
              "entries": c["entries"],
              "share_percent": round(c["paise"] / total * 100, 1) if total else 0.0}
             for c in by_cat.values()], key=lambda x: -x["rupees"]),
        "vendors": sorted(
            [{"name": v["name"], "rupees": _rupees(v["paise"]),
              "orders": v["orders"], "days_ordered_on": len(v["dates"]),
              "share_percent": round(v["paise"] / total * 100, 1) if total else 0.0}
             for v in by_vendor.values()], key=lambda x: -x["rupees"]),
        "items": items,
        "untracked": {"entries": untracked_n, "rupees": _rupees(untracked_paise)},
        "name_collisions": _name_collisions(items),
    }
    facts["findings"] = _purchase_findings(facts)
    return facts


def _name_collisions(items: list[dict]) -> list[dict]:
    """Items that are probably the same thing under two names.

    "Rice" and "Sona Masoori Rice" each build half a price history and
    neither is comparable. Flagged when one name's words are wholly
    contained in another's.
    """
    out = []
    for i, a in enumerate(items):
        ta = _tokens(a["item"])
        if not ta:
            continue
        for b in items[i + 1:]:
            tb = _tokens(b["item"])
            if not tb or ta == tb:
                continue
            if ta < tb or tb < ta:
                out.append({
                    "names": [a["item"], b["item"]],
                    "units": [a["unit"], b["unit"]],
                    "prices": [a["avg_unit_price_rupees"],
                               b["avg_unit_price_rupees"]],
                })
    return out[:10]


def _purchase_findings(f: dict) -> list[dict]:
    out: list[dict] = []

    def add(sev, title, detail, **extra):
        out.append({"severity": sev, "title": title, "detail": detail, **extra})

    if not f["totals"]["entries"]:
        add("info", "No purchases logged in this period",
            "Log expenses with an item and quantity and price tracking starts.")
        return out

    if f["categories"]:
        c = f["categories"][0]
        add("info", f"Most of your spend is {c['name']}",
            f"₹{c['rupees']:,.0f} over {c['entries']} entries — "
            f"{c['share_percent']}% of everything you bought.")

    if f["vendors"]:
        v = f["vendors"][0]
        if v["share_percent"] >= 40 and v["name"] != "No vendor recorded":
            add("watch", f"{v['name']} supplies {v['share_percent']:.0f}% of your buying",
                f"₹{v['rupees']:,.0f} across {v['orders']} orders. One supplier "
                "that large sets your prices — worth a second quote to keep "
                "them honest.")
        else:
            add("info", f"Biggest supplier: {v['name']}",
                f"₹{v['rupees']:,.0f} across {v['orders']} orders.")

    repeat = [i for i in f["items"] if i["times_bought"] >= 2]
    if repeat:
        top = max(repeat, key=lambda i: i["times_bought"])
        gap = f", about every {top['avg_days_between']:.0f} days" \
            if top["avg_days_between"] else ""
        add("info", f"Bought most often: {top['item']}",
            f"{top['times_bought']} times{gap} — {top['qty']:,.1f}{top['unit']} "
            f"for ₹{top['rupees']:,.0f}.")

    # price movement
    for i in f["items"]:
        chg = i["change_percent"]
        if chg is not None and abs(chg) >= PRICE_MOVE_PCT:
            u = f"/{i['unit']}" if i["unit"] else ""
            add("watch" if chg > 0 else "good",
                f"{i['item']} is {abs(chg):.0f}% "
                f"{'dearer' if chg > 0 else 'cheaper'} than your first buy",
                f"₹{i['first_unit_price_rupees']:,.2f}{u} then, "
                f"₹{i['last_unit_price_rupees']:,.2f}{u} now."
                + (" Worth a call to the supplier." if chg > 0 else ""),
                item=i["item"])

    # same item, wildly different price — usually a keying slip
    for i in f["items"]:
        lo_p, hi_p = i["min_unit_price_rupees"], i["max_unit_price_rupees"]
        if lo_p and hi_p and (hi_p - lo_p) / lo_p * 100 >= SUSPECT_SPREAD_PCT \
                and i["times_bought"] >= 2:
            u = f"/{i['unit']}" if i["unit"] else ""
            add("act", f"{i['item']} was bought at very different prices",
                f"Between ₹{lo_p:,.2f}{u} and ₹{hi_p:,.2f}{u} over "
                f"{i['times_bought']} purchases. Either two different grades "
                "are being logged as one item, or a quantity was keyed wrong.",
                item=i["item"])

    for col in f["name_collisions"]:
        a, b = col["names"]
        add("watch", f"“{a}” and “{b}” look like the same thing",
            "Logged under two names, so neither builds a price history you "
            "can read. Pick one name and stick to it.")

    if f["untracked"]["entries"]:
        u = f["untracked"]
        add("info", f"{u['entries']} purchases have no quantity",
            f"₹{u['rupees']:,.0f} recorded as lump sums, so their price per "
            "kg can't be tracked. Add item and quantity when you log them.")

    return by_severity(out)
