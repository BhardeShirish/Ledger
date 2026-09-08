"""Higher-order insights: forecast, anomalies, targets/budgets,
break-even, outlet benchmarking, unit economics and menu-item analytics."""
import math
from datetime import date, timedelta
from statistics import mean, pstdev

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..audit import audit, get_setting_db, set_setting_db
from ..db import get_db
from ..owner_controls import owner_policy
from ..models import Attendance, DayClosure, Employee, Expense, ExpenseCategory, Outlet, PayrollRun, Payslip, SalesDaily, SalesItem, User, Vendor
from ..operating_evidence import menu_engineering
from ..security import current_user, require_owner
from ..util import analytics_date_range, days_in_month, now_local
from .helpers import assert_outlet_access, user_outlet_ids
from .losses import losses_paise

router = APIRouter(prefix="/insights", tags=["insights"])

FIXED_CATEGORIES_DEFAULT = ["rent", "electricity", "water",
                            "internet & phone", "licenses & fees"]


def _today():
    return now_local().date()


def _sales_by_day(db, outlets, lo, hi):
    rows = (db.query(SalesDaily)
              .filter(SalesDaily.outlet_id.in_(outlets),
                      SalesDaily.business_date >= lo.isoformat(),
                      SalesDaily.business_date <= hi.isoformat()).all())
    imp = {}
    for r in rows:
        if r.source == "petpooja":
            imp.setdefault((r.outlet_id, r.business_date), set()).add(r.channel_kind)
    out: dict[str, int] = {}
    for r in rows:
        if (
            r.source != "petpooja"
            and r.channel_kind in imp.get((r.outlet_id, r.business_date), set())
        ):
            continue
        amt = r.total_paise if r.source == "petpooja" else (r.amount_paise or 0)
        out[r.business_date] = out.get(r.business_date, 0) + amt
    return out


def _weekday_factors(db, outlets, upto: date, weeks: int = 8) -> dict[int, float]:
    """Trailing weekday averages relative to overall mean (1.0 = neutral)."""
    start = upto - timedelta(days=weeks * 7)
    daily = _sales_by_day(db, outlets, start, upto - timedelta(days=1))
    per_dow: dict[int, list] = {}
    for dstr, v in daily.items():
        w = date.fromisoformat(dstr).weekday()
        per_dow.setdefault(w, []).append(v)
    all_vals = list(daily.values())
    overall = mean(all_vals) if all_vals else 0
    if overall <= 0:
        return {}
    return {w: mean(vs) / overall for w, vs in per_dow.items()}


def _percentile(values: list[float], percent: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * percent
    low, high = int(index), min(len(ordered) - 1, int(index) + 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (index - low)


# ── Forecast + target pace ────────────────────────────────────────────────

@router.get("/forecast")
def forecast(month: str | None = None, outlet_id: int | None = None,
             user: User = Depends(current_user), db: Session = Depends(get_db)):
    t = _today()
    if month:
        y, m = map(int, month.split("-"))
    else:
        y, m = t.year, t.month
    lo = date(y, m, 1)
    dim = days_in_month(y, m)
    hi = lo + timedelta(days=dim - 1)

    outlets = user_outlet_ids(db, user)
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        outlets = [outlet_id]

    cutoff = min(hi, t)
    daily_p = _sales_by_day(db, outlets, lo, cutoff) if cutoff >= lo else {}
    so_far = sum(daily_p.values())
    days_elapsed = max(0, (cutoff - lo).days + 1) if cutoff >= lo else 0
    base_rate = so_far / days_elapsed if days_elapsed else 0

    factors = _weekday_factors(db, outlets, t)
    remaining: list[date] = []
    cur = max(lo, t + timedelta(days=1))
    while cur <= hi:
        remaining.append(cur)
        cur += timedelta(days=1)

    projected_tail = sum(base_rate * factors.get(d.weekday(), 1.0) for d in remaining)
    projected = so_far + projected_tail

    # A month with nothing recorded yet gives no basis for a projection.
    # Printing "₹0 projected month-end" on the 4th reads as a forecast of
    # ruin when the truth is only that this month's sales aren't in yet.
    has_basis = so_far > 0
    history = _sales_by_day(db, outlets, t - timedelta(days=56), t - timedelta(days=1))
    history_days = len(history)
    coverage = len(daily_p) / days_elapsed if days_elapsed else 0
    confidence_score = round((min(1.0, coverage) * 0.6 +
                              min(1.0, history_days / 28) * 0.4) * 100)
    confidence = "high" if confidence_score >= 75 else \
        "medium" if confidence_score >= 45 else "low"
    overall_history = mean(history.values()) if history else 0
    residuals = [
        amount / max(1, overall_history * factors.get(date.fromisoformat(day).weekday(), 1.0))
        for day, amount in history.items()
    ] if overall_history else []
    low_factor = _percentile(residuals, 0.25) if len(residuals) >= 14 else 0.85
    high_factor = _percentile(residuals, 0.75) if len(residuals) >= 14 else 1.15
    scenarios = None if not has_basis else {
        "conservative_rupees": round((so_far + projected_tail * low_factor) / 100, 2),
        "base_rupees": round(projected / 100, 2),
        "stretch_rupees": round((so_far + projected_tail * high_factor) / 100, 2),
        "method": "historic weekday variation" if len(residuals) >= 14
        else "wide default band: limited history",
    }

    # target & pace
    targets = get_setting_db(db, "sales_targets", {})
    target_values = [
        float(targets[f"{oid}:{y}-{m:02d}"])
        for oid in outlets if targets.get(f"{oid}:{y}-{m:02d}")
    ]
    target = sum(target_values) if target_values else None
    resp = {
        "month": f"{y:04d}-{m:02d}",
        "days_total": dim,
        "days_elapsed": days_elapsed,
        "so_far_rupees": round(so_far / 100, 2),
        "base_rate_rupees": round(base_rate / 100, 2),
        "has_basis": has_basis,
        "projected_rupees": round(projected / 100, 2) if has_basis else None,
        "target_rupees": target,
        "outlet_id": outlets[0] if len(outlets) == 1 else None,
        "observed_days": len(daily_p),
        "history_days": history_days,
        "coverage_ratio": round(coverage, 2),
        "confidence_score": confidence_score if has_basis else 0,
        "confidence": confidence if has_basis else "low",
        "scenarios": scenarios,
        "algorithm_version": "weekday-v2",
    }
    if target:
        target_paise = target * 100
        pace_needed = max(0.0, (target_paise - so_far)) / 100.0 / max(1, len(remaining))
        resp.update({
            "pace_needed_per_day_rupees": round(pace_needed, 2),
            "on_track": projected >= target_paise if has_basis else None,
            "percent_of_target": round(projected / target_paise * 100, 1)
            if has_basis else None,
        })
    return resp


class ScenarioIn(BaseModel):
    outlet_id: int
    month: str
    sales_change_percent: float = 0
    expense_change_percent: float = 0
    payroll_change_rupees: float = 0


@router.post("/scenario")
def scenario(body: ScenarioIn, user: User = Depends(require_owner),
             db: Session = Depends(get_db)):
    """A local, unsaved what-if over the same forecast and recorded cost base."""
    if any(not math.isfinite(value) or abs(value) > 1000 for value in (
        body.sales_change_percent, body.expense_change_percent, body.payroll_change_rupees,
    )):
        raise HTTPException(422, "Scenario values must be finite and reasonable")
    baseline = forecast(body.month, body.outlet_id, user, db)
    if baseline["projected_rupees"] is None:
        raise HTTPException(422, "Record sales before running a scenario")
    start = f"{body.month}-01"
    year, number = map(int, body.month.split("-"))
    end = f"{body.month}-{days_in_month(year, number):02d}"
    expense_paise = db.query(func.coalesce(func.sum(Expense.amount_paise), 0)).filter(
        Expense.outlet_id == body.outlet_id,
        Expense.business_date >= start, Expense.business_date <= end).scalar()
    payroll_paise = 0
    run = db.query(PayrollRun).filter_by(
        outlet_id=body.outlet_id, year=year, month=number).first()
    if run:
        payroll_paise = sum(s.gross_paise for s in db.query(Payslip).filter_by(run_id=run.id).all())
    sales = baseline["projected_rupees"] * (1 + body.sales_change_percent / 100)
    expenses = expense_paise / 100 * (1 + body.expense_change_percent / 100)
    payroll = payroll_paise / 100 + body.payroll_change_rupees
    return {
        "month": body.month, "scenario_sales_rupees": round(sales, 2),
        "scenario_expenses_rupees": round(expenses, 2),
        "scenario_payroll_rupees": round(payroll, 2),
        "contribution_after_recorded_costs_rupees": round(sales - expenses - payroll, 2),
        "note": "Scenario only. It does not change the ledger and excludes unrecorded costs.",
    }


class TargetIn(BaseModel):
    outlet_id: int
    month: str            # YYYY-MM
    amount_rupees: float


@router.put("/target")
def set_target(body: TargetIn, user: User = Depends(require_owner),
               db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    if not math.isfinite(body.amount_rupees):
        raise HTTPException(422, "Target must be finite")
    store = dict(get_setting_db(db, "sales_targets", {}))
    key = f"{body.outlet_id}:{body.month}"
    if body.amount_rupees <= 0:
        store.pop(key, None)
    else:
        store[key] = body.amount_rupees
    set_setting_db(db, "sales_targets", store, user.id)
    audit(db, None, user.id, "sales-target", "settings", key,
          after={"amount_rupees": body.amount_rupees})
    db.commit()
    return {"ok": True}


# ── Anomalies ─────────────────────────────────────────────────────────────

@router.get("/anomalies")
def anomalies(month: str | None = None, outlet_id: int | None = None,
              user: User = Depends(current_user), db: Session = Depends(get_db)):
    t = _today()
    y, m = (map(int, month.split("-")) if month else (t.year, t.month))
    lo = date(y, m, 1)
    hi = lo + timedelta(days=days_in_month(y, m) - 1)
    outlets = user_outlet_ids(db, user)
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        outlets = [outlet_id]
    alerts = {oid: owner_policy(db, oid)["cash_variance_alert_paise"] for oid in outlets}
    out = []

    closures = (db.query(DayClosure)
                  .filter(DayClosure.outlet_id.in_(outlets),
                          DayClosure.business_date >= lo.isoformat(),
                          DayClosure.business_date <= hi.isoformat(),
                          DayClosure.reopened_at.is_(None)).all())
    for c in closures:
        alert_paise = alerts[c.outlet_id]
        if abs(c.variance_paise) > alert_paise:
            out.append({"date": c.business_date, "type": "cash_variance",
                        "severity": "high" if abs(c.variance_paise) > alert_paise * 2 else "med",
                        "rupees": round(c.variance_paise / 100, 2),
                        "detail": f"drawer off by ₹{c.variance_paise/100:.0f}"})

    exp_rows = (db.query(Expense)
                  .filter(Expense.outlet_id.in_(outlets),
                          Expense.business_date >= lo.isoformat(),
                          Expense.business_date <= hi.isoformat()).all())
    per_day: dict[str, int] = {}
    for e in exp_rows:
        per_day[e.business_date] = per_day.get(e.business_date, 0) + e.amount_paise
    vals = [v for v in per_day.values() if v > 0]
    if len(vals) >= 5:
        mu = mean(vals)
        sd = max(pstdev(vals), mu * 0.25)
        for dd, v in sorted(per_day.items()):
            if v > mu + 2 * sd:
                out.append({"date": dd, "type": "expense_spike", "severity": "med",
                            "rupees": round(v / 100, 2),
                            "detail": f"₹{v/100:.0f} vs typical ₹{mu/100:.0f}"})

    bill_rows = (db.query(SalesDaily)
                   .filter(SalesDaily.outlet_id.in_(outlets),
                           SalesDaily.business_date >= lo.isoformat(),
                           SalesDaily.business_date <= hi.isoformat()).all())
    disc_day: dict[str, tuple[int, int]] = {}
    for r in bill_rows:
        g = disc_day.setdefault(r.business_date, [0, 0])
        g[0] += r.discount_paise or 0
        g[1] += r.total_paise or 0
    pct_series = {d: (x / t * 100 if t else 0) for d, (x, t) in disc_day.items() if t > 0}
    if len(pct_series) >= 5:
        pvals = list(pct_series.values())
        pmu, psd = mean(pvals), max(1.0, pstdev(pvals))
        for d, p in sorted(pct_series.items()):
            if p > pmu + 2 * psd and p > 5:
                out.append({"date": d, "type": "discount_spike", "severity": "med",
                            "percent": round(p, 1),
                            "detail": f"discounts at {p:.1f}% of sales"})
    out.sort(key=lambda x: x["date"], reverse=True)
    return out


# ── Missed paperwork ──────────────────────────────────────────────────────

@router.get("/missing-logs")
def missing_logs(days: int = 14, outlet_id: int | None = None,
                 user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Days in the recent past with nothing recorded, so they can be filled in.

    Today is excluded (the day is not over) and so is anything before an
    outlet's very first record, otherwise a brand-new ledger would report
    every day since the beginning of time as missing.
    """
    days = max(1, min(int(days), 90))
    t = _today()
    outlets = user_outlet_ids(db, user)
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        outlets = [outlet_id]
    window = [(t - timedelta(days=i)).isoformat() for i in range(1, days + 1)]
    if not window or not outlets:
        return []
    lo, hi = window[-1], window[0]

    out = []
    for oid in outlets:
        o = db.get(Outlet, oid)
        name = o.name if o else str(oid)

        # Never nag about days before this outlet started being used.
        firsts = [
            db.query(func.min(SalesDaily.business_date)).filter_by(outlet_id=oid).scalar(),
            db.query(func.min(Expense.business_date)).filter_by(outlet_id=oid).scalar(),
            db.query(func.min(DayClosure.business_date)).filter_by(outlet_id=oid).scalar(),
        ]
        firsts = [f for f in firsts if f]
        if not firsts:
            continue
        began = min(firsts)

        sales_days = {r[0] for r in db.query(SalesDaily.business_date)
                      .filter(SalesDaily.outlet_id == oid,
                              SalesDaily.business_date >= lo,
                              SalesDaily.business_date <= hi).distinct()}
        closed_days = {r[0] for r in db.query(DayClosure.business_date)
                       .filter(DayClosure.outlet_id == oid,
                               DayClosure.reopened_at.is_(None),
                               DayClosure.business_date >= lo,
                               DayClosure.business_date <= hi).distinct()}
        att_days = {r[0] for r in db.query(Attendance.business_date)
                    .join(Employee, Attendance.employee_id == Employee.id)
                    .filter(Employee.outlet_id == oid,
                            Attendance.business_date >= lo,
                            Attendance.business_date <= hi).distinct()}
        has_staff = db.query(Employee).filter_by(outlet_id=oid, is_active=True).count() > 0

        for d in window:
            if d < began:
                continue
            if d not in sales_days:
                out.append({"date": d, "outlet_id": oid, "outlet": name,
                            "type": "sales", "detail": "Sales not entered",
                            "link": "/sales"})
            if has_staff and d not in att_days:
                out.append({"date": d, "outlet_id": oid, "outlet": name,
                            "type": "attendance", "detail": "Attendance not marked",
                            "link": "/staff/attendance"})
            if d in sales_days and d not in closed_days:
                out.append({"date": d, "outlet_id": oid, "outlet": name,
                            "type": "cash", "detail": "Drawer not counted",
                            "link": "/money/cash"})

    out.sort(key=lambda x: (x["date"], x["type"]), reverse=True)
    return out


# ── Budgets ───────────────────────────────────────────────────────────────

class BudgetIn(BaseModel):
    category_id: int
    monthly_rupees: float
    outlet_id: int | None = None


@router.get("/budgets")
def get_budgets(outlet_id: int | None = None, month: str | None = None,
                user: User = Depends(current_user), db: Session = Depends(get_db)):
    t = _today()
    y, m = (map(int, month.split("-")) if month else (t.year, t.month))
    budgets = get_setting_db(db, "category_budgets", {})
    key_scope = str(outlet_id) if outlet_id else "all"
    accessible = user_outlet_ids(db, user)
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        spend_outlets = [outlet_id]
    else:
        spend_outlets = accessible
    from ..models import ExpenseCategory
    cats = {c.id: c.name for c in db.query(ExpenseCategory).all()}
    lo = date(y, m, 1)
    hi = lo + timedelta(days=days_in_month(y, m) - 1)
    spent_rows = (db.query(Expense.category_id, func.sum(Expense.amount_paise))
                    .filter(Expense.outlet_id.in_(spend_outlets),
                            Expense.business_date >= lo.isoformat(),
                            Expense.business_date <= hi.isoformat())
                    .group_by(Expense.category_id).all())
    spent = {cid: v for cid, v in spent_rows}
    out = []
    for k, b in budgets.items():
        if not str(k).startswith(key_scope + ":"):
            continue
        cid = int(str(k).split(":")[1])
        used = spent.get(cid, 0)
        cap = float(b) * 100
        out.append({
            "category_id": cid, "category": cats.get(cid, f"#{cid}"),
            "budget_rupees": float(b),
            "used_rupees": round(used / 100, 2),
            "percent_used": round(used / cap * 100, 1) if cap else 0,
            "over": used > cap,
        })
    return sorted(out, key=lambda x: -x["percent_used"])


@router.put("/budgets")
def put_budget(body: BudgetIn, user: User = Depends(require_owner),
               db: Session = Depends(get_db)):
    if body.outlet_id:
        assert_outlet_access(db, user, body.outlet_id)
    if not math.isfinite(body.monthly_rupees) or body.monthly_rupees < 0:
        raise HTTPException(422, "Budget must be finite and non-negative")
    scope = body.outlet_id or "all"
    store = dict(get_setting_db(db, "category_budgets", {}))
    store[f"{scope}:{body.category_id}"] = body.monthly_rupees
    set_setting_db(db, "category_budgets", store, user.id)
    audit(db, None, user.id, "category-budget", "settings",
          f"{scope}:{body.category_id}",
          after={"monthly_rupees": body.monthly_rupees})
    db.commit()
    return {"ok": True}


@router.delete("/budgets/{category_id}")
def del_budget(category_id: int, outlet_id: int | None = None,
               user: User = Depends(require_owner), db: Session = Depends(get_db)):
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
    store = dict(get_setting_db(db, "category_budgets", {}))
    store.pop(f"{outlet_id or 'all'}:{category_id}", None)
    set_setting_db(db, "category_budgets", store, user.id)
    audit(db, None, user.id, "category-budget-delete", "settings",
          f"{outlet_id or 'all'}:{category_id}")
    db.commit()
    return {"ok": True}


# ── Break-even / unit economics of the business ───────────────────────────

@router.get("/breakeven")
def breakeven(month: str | None = None, outlet_id: int | None = None,
              user: User = Depends(current_user), db: Session = Depends(get_db)):
    t = _today()
    y, m = (map(int, month.split("-")) if month else (t.year, t.month))
    lo = date(y, m, 1)
    hi = lo + timedelta(days=days_in_month(y, m) - 1)
    outlets = user_outlet_ids(db, user)
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        outlets = [outlet_id]

    fixed_names = [n.lower() for n in get_setting_db(
        db, "fixed_categories", FIXED_CATEGORIES_DEFAULT)]
    cats = {c.id: c.name.lower() for c in db.query(ExpenseCategory).all()}
    exp_rows = (db.query(Expense)
                  .filter(Expense.outlet_id.in_(outlets),
                          Expense.business_date >= lo.isoformat(),
                          Expense.business_date <= hi.isoformat()).all())
    fixed = var = 0
    for e in exp_rows:
        if cats.get(e.category_id, "") in fixed_names:
            fixed += e.amount_paise
        else:
            var += e.amount_paise
    payroll_gross = 0
    runs = (db.query(PayrollRun)
              .filter(PayrollRun.outlet_id.in_(outlets),
                      PayrollRun.year == y, PayrollRun.month == m).all())
    for run in runs:
        slips = db.query(Payslip).filter_by(run_id=run.id).all()
        payroll_gross += sum(s.gross_paise for s in slips)
    total_fixed = fixed + payroll_gross

    sales = sum(_sales_by_day(db, outlets, lo, min(hi, t)).values()) \
        if (y, m) == (t.year, t.month) else sum(_sales_by_day(db, outlets, lo, hi).values())

    bills = (db.query(func.coalesce(func.sum(SalesDaily.bills), 0))
               .filter(SalesDaily.outlet_id.in_(outlets),
                       SalesDaily.source == "petpooja",
                       SalesDaily.business_date >= lo.isoformat(),
                       SalesDaily.business_date <= hi.isoformat()).scalar()) or 0
    manual_days = (db.query(SalesDaily)
                     .filter(SalesDaily.outlet_id.in_(outlets),
                             SalesDaily.source == "manual",
                             SalesDaily.business_date >= lo.isoformat(),
                             SalesDaily.business_date <= hi.isoformat(),
                             SalesDaily.amount_paise > 0).count())
    total_bills = bills + manual_days

    dim = days_in_month(y, m)
    return {
        "month": f"{y:04d}-{m:02d}",
        "fixed_costs_rupees": round(total_fixed / 100, 2),
        "fixed_cover_per_day_rupees": round(total_fixed / 100 / dim, 2),
        "variable_costs_rupees": round(var / 100, 2),
        "sales_rupees": round(sales / 100, 2),
        "breakeven_met": sales >= total_fixed + var,
        "coverage_percent": (
            round(sales / (total_fixed + var) * 100, 1)
            if total_fixed + var else None
        ),
        "cost_per_bill_rupees": round((var + total_fixed) / 100 / total_bills, 2)
                                if total_bills else None,
        "bills_count": total_bills,
    }


# ── Outlet benchmarking ───────────────────────────────────────────────────

@router.get("/benchmark")
def benchmark(start: str, end: str, user: User = Depends(current_user),
              db: Session = Depends(get_db)):
    lo, hi = analytics_date_range(start, end)
    start, end = lo.isoformat(), hi.isoformat()
    ids = user_outlet_ids(db, user)
    rows_out = []
    for oid in ids:
        o = db.get(Outlet, oid)
        sales = _sales_by_day(db, [oid], lo, hi)
        total = sum(sales.values())
        dow_best = None
        by_dow: dict[int, int] = {}
        for ds, v in sales.items():
            by_dow[date.fromisoformat(ds).weekday()] = \
                by_dow.get(date.fromisoformat(ds).weekday(), 0) + v
        if by_dow:
            best = max(by_dow.items(), key=lambda kv: kv[1])[0]
            dow_best = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][best]
        active_days = len([v for v in sales.values() if v > 0])
        exp_q = (db.query(func.sum(Expense.amount_paise))
                   .filter(Expense.outlet_id == oid,
                           Expense.business_date >= start,
                           Expense.business_date <= end).scalar()) or 0
        loss_q = losses_paise(db, [oid], start, end)
        rows_out.append({
            "outlet_id": oid, "name": o.name if o else "?",
            "sales_rupees": round(total / 100, 2),
            "expenses_rupees": round(exp_q / 100, 2),
            "losses_rupees": round(loss_q / 100, 2),
            # Payroll cannot be reliably attributed to an arbitrary range
            # without fabricating it from the current staff master.
            "contribution_before_payroll_rupees":
                round((total - exp_q - loss_q) / 100, 2),
            "profit_rupees": None,
            "profit_known": False,
            "profit_unknown_why":
                "Payroll is not included in outlet benchmarks.",
            "active_days": active_days,
            "avg_active_day_rupees": round(total / 100 / max(1, active_days), 2),
            "best_weekday": dow_best,
        })
    return sorted(rows_out, key=lambda x: -x["sales_rupees"])


# ── Unit economics (raw materials with qty) ───────────────────────────────

@router.get("/unit-economics")
def unit_economics(start: str, end: str, q: str | None = None,
                   outlet_id: int | None = None,
                   user: User = Depends(current_user), db: Session = Depends(get_db)):
    lo, hi = analytics_date_range(start, end)
    start, end = lo.isoformat(), hi.isoformat()
    ids = user_outlet_ids(db, user)
    qry = (db.query(Expense)
             .filter(Expense.outlet_id.in_(ids),
                     Expense.quantity.isnot(None),
                     Expense.quantity > 0,
                     Expense.business_date >= start,
                     Expense.business_date <= end))
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        qry = qry.filter(Expense.outlet_id == outlet_id)
    if q:
        qry = qry.filter(func.lower(Expense.item_name).contains(q.lower()))
    rows = qry.order_by(Expense.item_name, Expense.business_date).all()
    vens = {v.id: v.name for v in db.query(Vendor)}
    cats = {c.id: c.name for c in db.query(ExpenseCategory).all()}

    items: dict[str, dict] = {}
    for e in rows:
        it = items.setdefault(e.item_name.lower(), {
            "item": e.item_name, "unit": e.unit, "category": cats.get(e.category_id, ""),
            "purchases": [], })
        price = e.amount_paise / e.quantity / 100
        it["purchases"].append({
            "date": e.business_date,
            "vendor": vens.get(e.vendor_id) if e.vendor_id else "",
            "qty": e.quantity, "unit": e.unit,
            "total_rupees": round(e.amount_paise / 100, 2),
            "unit_price_rupees": round(price, 2)})
    out = []
    for it in items.values():
        prices = [p["unit_price_rupees"] for p in it["purchases"]]
        cheapest = min(it["purchases"], key=lambda p: p["unit_price_rupees"])
        first, last = prices[0], prices[-1]
        it.update({
            "purchases_count": len(prices),
            "avg_unit_price": round(mean(prices), 2),
            "cheapest_vendor": cheapest["vendor"],
            "cheapest_unit_price": cheapest["unit_price_rupees"],
            "trend_percent": round((last - first) / first * 100, 1)
                             if first and len(prices) > 1 else 0,
        })
        it["purchases"].sort(key=lambda p: p["date"])
        out.append(it)
    return sorted(out, key=lambda x: -x["purchases_count"])


# ── Menu item analytics ───────────────────────────────────────────────────

@router.get("/menu-engineering")
def menu_engineering_analysis(start: str, end: str, outlet_id: int | None = None,
                              user: User = Depends(current_user),
                              db: Session = Depends(get_db)):
    """Popularity and food-cost signals, strictly limited to complete recipe evidence."""
    lo, hi = analytics_date_range(start, end)
    outlet_ids = user_outlet_ids(db, user)
    if outlet_id is not None:
        assert_outlet_access(db, user, outlet_id)
        outlet_ids = [outlet_id]
    return menu_engineering(db, outlet_ids, lo, hi)


@router.get("/items")
def item_analytics(start: str, end: str, outlet_id: int | None = None,
                   user: User = Depends(current_user), db: Session = Depends(get_db)):
    lo, hi = analytics_date_range(start, end)
    start, end = lo.isoformat(), hi.isoformat()
    ids = user_outlet_ids(db, user)
    qry = (db.query(SalesItem)
             .filter(SalesItem.outlet_id.in_(ids),
                     SalesItem.business_date >= start,
                     SalesItem.business_date <= end))
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        qry = qry.filter(SalesItem.outlet_id == outlet_id)
    rows = qry.all()
    agg: dict[str, dict] = {}
    for r in rows:
        a = agg.setdefault(r.item_name, {
            "item": r.item_name, "category": r.category,
            "qty": 0.0, "revenue_paise": 0, "days_sold": set()})
        a["qty"] += r.qty
        a["revenue_paise"] += r.amount_paise
        a["days_sold"].add(r.business_date)
    span_days = (hi - lo).days + 1
    top = sorted(agg.values(), key=lambda x: -x["revenue_paise"])
    dead_cutoff = (lo - timedelta(days=14)).isoformat()

    def ever_sold_before(name):
        return db.query(SalesItem.id).filter(
            SalesItem.outlet_id.in_(ids),
            SalesItem.item_name == name,
            SalesItem.business_date < start,
            SalesItem.business_date >= dead_cutoff).count() > 0

    out = [{
        "item": a["item"], "category": a["category"],
        "qty": round(a["qty"], 1),
        "revenue_rupees": round(a["revenue_paise"] / 100, 2),
        "sold_on_days": len(a["days_sold"]),
        "menu_presence_percent": round(len(a["days_sold"]) / span_days * 100, 1),
    } for a in top]

    dead = [{"item": n, "last_seen": ""} for n, a in agg.items()
            if len(a["days_sold"]) == 0]  # placeholder; real dead via query below
    # true dead items: sold in prior 30d window but absent in range
    prior_names = {r[0] for r in db.query(SalesItem.item_name).distinct()
                   .filter(SalesItem.outlet_id.in_(ids),
                           SalesItem.business_date < start).limit(2000).all()}
    current_names = set(agg.keys())
    dead_list = sorted(prior_names - current_names)[:50]
    return {"top": out[:50], "dead_items": dead_list}
