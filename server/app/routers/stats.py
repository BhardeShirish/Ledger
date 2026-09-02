"""Stats: home checklist, dashboard aggregations, off-day coverage, CA pack."""
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..audit import get_setting_db
from ..db import get_db
from ..models import DayClosure, Employee, Expense, PayrollRun, Payslip, SalesDaily, User
from ..security import current_user
from .helpers import assert_outlet_access, user_outlet_ids
from .losses import losses_paise

router = APIRouter(prefix="/stats", tags=["stats"])

CHANNEL_KINDS = ["cash", "upi", "card", "wallet", "aggregator", "split", "due", "other"]


@router.get("/last-activity")
def last_activity(outlet_id: int | None = None,
                  user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    """The most recent day that has anything recorded.

    A month-scoped page showing all zeros looks identical whether the business
    was shut or the owner is simply looking at the wrong month. The UI uses
    this to say "your last activity was August" instead of implying the data
    is gone.
    """
    outlets = user_outlet_ids(db, user)
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        outlets = [outlet_id]
    if not outlets:
        return {"date": None, "month": None}

    latest = None
    for model, col in ((SalesDaily, SalesDaily.business_date),
                       (Expense, Expense.business_date),
                       (DayClosure, DayClosure.business_date)):
        row = (db.query(col)
                 .filter(model.outlet_id.in_(outlets))
                 .order_by(col.desc()).first())
        if row and row[0] and (latest is None or row[0] > latest):
            latest = row[0]
    return {"date": latest, "month": latest[:7] if latest else None}


@router.get("/analytics")
def analytics(start: str, end: str, outlet_id: int | None = None,
              user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Any-range, multi-series engine. Returns every daily series we hold,
    so the UI can compare any combination without refetching."""
    from datetime import date as D

    outlets = user_outlet_ids(db, user)
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        outlets = [outlet_id]

    srows = (db.query(SalesDaily)
               .filter(SalesDaily.outlet_id.in_(outlets),
                       SalesDaily.business_date >= start,
                       SalesDaily.business_date <= end).all())
    erows = (db.query(Expense)
               .filter(Expense.outlet_id.in_(outlets),
                       Expense.business_date >= start,
                       Expense.business_date <= end).all())

    eff: dict[tuple[str, str], int] = {}
    net_eff: dict[tuple[str, str], int] = {}
    tips_m: dict[str, int] = {}
    disc_m: dict[str, int] = {}
    tax_m: dict[str, int] = {}
    bills_m: dict[str, int] = {}
    imp_kinds_by_day: dict[str, set] = {}

    for r in srows:
        if r.source == "petpooja":
            imp_kinds_by_day.setdefault(r.business_date, set()).add(r.channel_kind)
    for r in srows:
        amount = r.total_paise if r.source == "petpooja" else (r.amount_paise or 0)
        if r.source != "petpooja" and r.channel_kind in imp_kinds_by_day.get(r.business_date, set()):
            continue
        key = (r.business_date, r.channel_kind)
        eff[key] = eff.get(key, 0) + amount
        net_eff[key] = net_eff.get(key, 0) + (r.net_paise if r.source == "petpooja"
                                              else (r.amount_paise or 0))
        if r.source == "petpooja":
            tips_m[r.business_date] = tips_m.get(r.business_date, 0) + (r.tip_paise or 0)
            disc_m[r.business_date] = disc_m.get(r.business_date, 0) + (r.discount_paise or 0)
            tax_m[r.business_date] = tax_m.get(r.business_date, 0) + (r.tax_paise or 0)
            bills_m[r.business_date] = bills_m.get(r.business_date, 0) + r.bills
        elif amount > 0:
            bills_m[r.business_date] = bills_m.get(r.business_date, 0) + 1

    days: list[str] = []
    d0 = D.fromisoformat(start)
    d1 = D.fromisoformat(end)
    cur = d0
    while cur <= d1 and len(days) <= 370:
        days.append(cur.isoformat())
        cur = D.fromordinal(cur.toordinal() + 1)

    series: dict[str, list[float]] = {}
    totals: dict[str, float] = {}

    def reg(key, getter):
        vals = [round(getter(day) / 100, 2) for day in days]
        series[key] = vals
        totals[key] = round(sum(vals), 2)

    kinds_present = sorted({k for (_, k) in eff} | set(CHANNEL_KINDS[:3]))
    for kind in kinds_present:
        reg(f"sales_{kind}", lambda day, _k=kind: eff.get((day, _k), 0))

    def day_total(day):
        return sum(v for (bd, _), v in eff.items() if bd == day)

    def day_net(day):
        return sum(v for (bd, _), v in net_eff.items() if bd == day)

    reg("sales_total", day_total)
    reg("sales_net", day_net)
    reg("expenses", lambda day: sum(e.amount_paise for e in erows
                                    if e.business_date == day))
    reg("expense_cash", lambda day: sum(e.amount_paise for e in erows
                                        if e.business_date == day
                                        and e.mode == "cash"))
    reg("tips", lambda day: tips_m.get(day, 0))
    reg("discounts", lambda day: disc_m.get(day, 0))
    reg("tax", lambda day: tax_m.get(day, 0))
    series["bills"] = [bills_m.get(day, 0) for day in days]
    totals["bills"] = sum(series["bills"])
    series["avg_ticket"] = [
        round(day_total(day) / max(1, bills_m.get(day, 0)) / 100, 2)
        for day in days]
    totals["avg_ticket"] = round(
        sum(eff.values()) / max(1, sum(bills_m.values())) / 100, 2)

    # weekday averages of total sales (Mon..Sun index 0..6)
    dow_sum: dict[int, float] = {}
    dow_pos_days: dict[int, int] = {}
    for i, day in enumerate(days):
        w = D.fromisoformat(day).weekday()
        if series["sales_total"][i] > 0:
            dow_sum[w] = dow_sum.get(w, 0) + series["sales_total"][i]
            dow_pos_days[w] = dow_pos_days.get(w, 0) + 1
    weekday_avg = [round(dow_sum.get(i, 0) / max(1, dow_pos_days.get(i, 1)), 2)
                   for i in range(7)]

    return {
        "start": start, "end": end,
        "days": days,
        "series": series,
        "totals": totals,
        "weekday_avg_sales": weekday_avg,
        "kinds_present": kinds_present,
        "days_recorded": sum(1 for v in series["sales_total"] if v > 0),
    }


def _today() -> date:
    from ..util import now_local
    return now_local().date()


@router.get("/home")
def home(outlet_id: int | None = None, date_str: str | None = None,
         user: User = Depends(current_user), db: Session = Depends(get_db)):
    d = date_str or _today().isoformat()
    outlets = user_outlet_ids(db, user)
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        outlets = [outlet_id]
    per_outlet = []
    for oid in outlets:
        outlet = db.get(__import__("app.models", fromlist=["Outlet"]).Outlet, oid) \
            if False else _get_outlet(db, oid)
        if not outlet:
            continue
        emps = (db.query(Employee.id)
                  .filter_by(outlet_id=oid).filter(
                      Employee.working_status != "left",
                      Employee.is_active == True).all())  # noqa: E712
        emp_ids = [r[0] for r in emps]
        marked = open_rows = 0
        sales_total = exp_count = exp_cash = 0
        closed = None
        if emp_ids:
            from ..models import Attendance
            rows = (db.query(Attendance)
                      .filter(Attendance.employee_id.in_(emp_ids),
                              Attendance.business_date == d).all())
            marked = sum(1 for r in rows if r.status in ("P", "H", "A", "L", "WO"))
            open_rows = sum(1 for r in rows if r.is_open)
        srows = (db.query(SalesDaily)
                   .filter_by(outlet_id=oid, business_date=d,
                              source="manual").all())
        irows = (db.query(SalesDaily)
                   .filter_by(outlet_id=oid, business_date=d,
                              source="petpooja").all())
        sales_total += sum(r.total_paise for r in irows)
        imp_kinds = {r.channel_kind for r in irows}
        for r in srows:
            if r.channel_kind not in imp_kinds:
                sales_total += (r.amount_paise or 0)
        erows = (db.query(Expense)
                   .filter_by(outlet_id=oid, business_date=d).all())
        exp_count = len(erows)
        exp_cash = sum(e.amount_paise for e in erows if e.mode == "cash")
        exp_total = sum(e.amount_paise for e in erows)
        closure = db.query(DayClosure).filter_by(outlet_id=oid, business_date=d).first()
        closed = bool(closure and not closure.reopened_at)
        attendance_ok = bool(emp_ids) and marked >= len(emp_ids) and open_rows == 0
        sales_ok = bool(irows) or any(r.amount_paise > 0 for r in srows)
        per_outlet.append({
            "outlet_id": oid, "outlet_name": outlet.name,
            "attendance": {"marked": marked, "total": len(emp_ids),
                           "open": open_rows, "done": attendance_ok},
            "sales": {"done": sales_ok, "rupees_paise": sales_total},
            "expenses": {"count": exp_count, "cash_paise": exp_cash,
                         "total_paise": exp_total},
            "closed": closed,
            "steps_done": int(attendance_ok) + int(sales_ok) + int(closed),
        })
    return {"date": d, "outlets": per_outlet}


def _get_outlet(db, oid):
    from ..models import Outlet
    return db.get(Outlet, oid)


@router.get("/dashboard")
def dashboard(outlet_id: int | None = None, month: str | None = None,
              user: User = Depends(current_user), db: Session = Depends(get_db)):
    """month=YYYY-MM; defaults to current month."""
    d = _today()
    if month:
        y, m = map(int, month.split("-"))
    else:
        y, m = d.year, d.month
    lo = date(y, m, 1)
    hi = date(y + (m == 12), (m % 12) + 1, 1) - timedelta(days=1)

    outlets = user_outlet_ids(db, user)
    if outlet_id:
        assert_outlet_access(db, user, outlet_id)
        outlets = [outlet_id]

    def sale_series(source):
        rows = (db.query(SalesDaily)
                  .filter(SalesDaily.outlet_id.in_(outlets),
                          SalesDaily.business_date >= lo.isoformat(),
                          SalesDaily.business_date <= hi.isoformat(),
                          SalesDaily.source == source)
                  .with_entities(SalesDaily.business_date,
                                 SalesDaily.channel_kind,
                                 SalesDaily.net_paise,
                                 SalesDaily.total_paise,
                                 SalesDaily.tip_paise,
                                 SalesDaily.tax_paise,
                                 SalesDaily.discount_paise,
                                 SalesDaily.amount_paise).all())
        # A manual entry is one number the owner typed - there is no separate
        # gross and net for it, so the amount has to stand in for both. Leaving
        # net at net_paise (which manual rows never fill) made the payment-mix
        # card read zero for everyone not importing from a POS.
        return [(bd, kind,
                 (net if source == "petpooja" else (amount or 0)),
                 (total if source == "petpooja" else (amount or 0)),
                 tip, tax, disc)
                for bd, kind, net, total, tip, tax, disc, amount in rows]

    manual_rows = sale_series("manual")
    imported_rows = sale_series("petpooja")

    # daily totals: imported wins where present; manual fills the gaps/other kinds
    by_day: dict[str, dict] = {}
    by_kind: dict[str, dict] = {}
    imported_keys = {(r[0], r[1]) for r in imported_rows}
    tips_paise = 0
    for src_rows, is_imported in ((imported_rows, True), (manual_rows, False)):
        for bd, kind, net, total, tip, tax, disc in src_rows:
            if not is_imported and (bd, kind) in imported_keys:
                continue  # POS already covers this channel that day
            day = by_day.setdefault(bd, {"net": 0, "total": 0})
            kk = by_kind.setdefault(kind, {"net": 0, "total": 0})
            day["net"] += (net or 0); day["total"] += (total or 0)
            kk["net"] += (net or 0); kk["total"] += (total or 0)
            tips_paise += (tip or 0)

    exp_rows = (db.query(Expense)
                  .filter(Expense.outlet_id.in_(outlets),
                          Expense.business_date >= lo.isoformat(),
                          Expense.business_date <= hi.isoformat())
                  .with_entities(Expense.category_id, Expense.amount_paise,
                                 Expense.business_date).all())
    by_cat: dict[int, int] = {}
    exp_by_day: dict[str, int] = {}
    total_expense = 0
    for cid, amt, bd in exp_rows:
        by_cat[cid] = by_cat.get(cid, 0) + amt
        exp_by_day[bd] = exp_by_day.get(bd, 0) + amt
        total_expense += amt

    payroll_gross = paid_out = 0
    runs = (db.query(PayrollRun)
              .filter(PayrollRun.outlet_id.in_(outlets),
                      PayrollRun.year == y, PayrollRun.month == m).all())
    for run in runs:
        slips = db.query(Payslip).filter_by(run_id=run.id).all()
        payroll_gross += sum(s.gross_paise for s in slips)
        paid_out += sum(s.paid_paise for s in slips)

    closures = (db.query(DayClosure)
                  .filter(DayClosure.outlet_id.in_(outlets),
                          DayClosure.business_date >= lo.isoformat(),
                          DayClosure.business_date <= hi.isoformat()).all())
    variance = sum(c.variance_paise for c in closures)
    bad_days = [{"date": c.business_date, "variance_rupees": round(c.variance_paise / 100, 2)}
                for c in closures if abs(c.variance_paise) >
                int(get_setting_db(db, "variance_alert_paise", 20_000))]

    trend = []
    for k, v in sorted(by_day.items()):
        exp = exp_by_day.get(k, 0)
        trend.append({"date": k,
                      "total_rupees": round(v["total"] / 100, 2),
                      "expense_rupees": round(exp / 100, 2)})
    days_recorded = len(by_day)
    avg_day_rupees = (round(sum(v["total"] for v in by_day.values()) / 100
                            / max(1, days_recorded), 2))
    best = max(by_day.items(), key=lambda kv: kv[1]["total"], default=None)
    modes = [{"kind": k, "net_rupees": round(v["net"] / 100, 2)}
             for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1]["net"])]

    from ..models import ExpenseCategory
    cat_names = {c.id: c.name for c in db.query(ExpenseCategory).all()}
    expense_donut = [{"name": cat_names.get(cid, f"#{cid}"),
                      "rupees": round(amt / 100, 2)}
                     for cid, amt in sorted(by_cat.items(), key=lambda kv: -kv[1])][:12]

    is_owner = user.role == "owner"
    month_losses = losses_paise(db, outlets, lo.isoformat(), hi.isoformat())
    return {
        "month": f"{y:04d}-{m:02d}",
        "sales_total_rupees": round(sum(v["total"] for v in by_day.values()) / 100, 2),
        "sales_net_rupees": round(sum(v["net"] for v in by_day.values()) / 100, 2),
        "expense_total_rupees": round(total_expense / 100, 2),
        "loss_total_rupees": round(month_losses / 100, 2),
        "profit_rupees": round((sum(v["total"] for v in by_day.values())
                                - total_expense - payroll_gross
                                - month_losses) / 100, 2) if is_owner else None,
        "payroll_accrual_rupees": round(payroll_gross / 100, 2) if is_owner else None,
        "labor_cost_percent": (round(payroll_gross * 100.0 /
                                     max(1, sum(v["total"] for v in by_day.values())), 1)
                               if is_owner else None),
        "cash_variance_rupees": round(variance / 100, 2) if is_owner else None,
        "cash_gap_days": bad_days[:10] if is_owner else [],
        "trend": trend,
        "modes": modes,
        "tips_rupees": round(tips_paise / 100, 2),
        "expense_donut": expense_donut,
        "avg_day_rupees": avg_day_rupees,
        "best_day": {"date": best[0], "total_rupees": round(best[1]["total"] / 100, 2)}
        if best else None,
        "days_recorded": days_recorded,
    }


@router.get("/offday-coverage")
def offday_coverage(outlet_id: int, user: User = Depends(current_user),
                    db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    emps = (db.query(Employee)
              .filter_by(outlet_id=outlet_id)
              .filter(Employee.working_status != "left",
                      Employee.is_active == True).all())  # noqa: E712
    grid = []
    for dow in range(7):
        off_today = [e for e in emps
                     if e.off_dow == dow or e.pref_off_dow == dow and e.off_dow is None]
        backups = []
        for e in off_today:
            b = db.get(Employee, e.backup_employee_id) if e.backup_employee_id else None
            backups.append({"off": e.name, "backup": b.name if b else None})
        grid.append({
            "dow": dow, "off_count": len(off_today), "detail": backups,
        })
    return {"outlet_id": outlet_id, "days": grid}
