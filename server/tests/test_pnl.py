"""The restaurant P&L.

The danger with this page is not a wrong sum, it is a confident one. A
shop that has logged its wages but not its rent will read as wildly
profitable, and an owner who believes it will keep a loss-making shift
running for another year. Most of what follows checks that the page
refuses to answer rather than guessing.
"""
from datetime import date, timedelta

import pytest

from app.db import SessionLocal
from app.models import Employee, Expense, ExpenseCategory, SalesBill

MONTH = "2026-04"                       # a whole, safely past month
DAYS = 30


def _cats(client):
    r = client.get("/api/lists/categories")
    rows = r.json()
    rows = rows["items"] if isinstance(rows, dict) else rows
    return {c["name"].lower(): c for c in rows}


def _cat_in_group(db, group, name):
    cat = db.query(ExpenseCategory).filter(ExpenseCategory.name == name).first()
    if cat is None:
        cat = ExpenseCategory(name=name, cost_group=group, is_active=True)
        db.add(cat)
        db.flush()
    cat.cost_group = group
    return cat.id


def _spend(db, group, rupees, *, name=None, day=5, item="", month=MONTH):
    cat_id = _cat_in_group(db, group, name or f"Test {group}")
    db.add(Expense(outlet_id=1, business_date=f"{month}-{day:02d}",
                   category_id=cat_id, amount_paise=int(rupees * 100),
                   mode="cash", description=item, item_name=item,
                   idempotency_key=f"t:{group}:{name}:{month}:{day}:{rupees}:{item}"))


def _sell(db, *, net, tax=0.0, day=1, n=1, prefix="b", month=MONTH):
    """n bills of `net` rupees each, with `tax` rupees of GST on top."""
    for i in range(n):
        db.add(SalesBill(
            outlet_id=1, business_date=f"{month}-{day:02d}",
            invoice_no=f"{prefix}-{month}-{day}-{i}-{net}-{tax}",
            bill_ts=f"{month}-{day:02d} 13:00:00", order_type="Dine In",
            area="Dining", channel_kind="cash",
            gross_paise=int(net * 100), discount_paise=0,
            net_paise=int(net * 100), tip_paise=0,
            total_paise=int((net + tax) * 100)))


def _staff(db, count, salary):
    for i in range(count):
        db.add(Employee(outlet_id=1, name=f"Cook {i}", designation="cook",
                        monthly_salary_paise=int(salary * 100),
                        working_status="active", is_active=True))


def _pnl(client, month=MONTH):
    r = client.get("/api/pnl/summary", params={"month": month})
    assert r.status_code == 200, r.text
    return r.json()


def _line(d, key):
    return next(l for l in d["lines"] if l["key"] == key)


def _titles(d):
    return " | ".join(f["title"] for f in d["findings"])


def _find(d, needle):
    for f in d["findings"]:
        if needle.lower() in f["title"].lower():
            return f
    raise AssertionError(f"no finding for {needle!r} in: {_titles(d)}")


def _no_finding(d, needle):
    assert not any(needle.lower() in f["title"].lower() for f in d["findings"]), \
        f"unexpected finding {needle!r} in: {_titles(d)}"


@pytest.fixture()
def healthy(client):
    """A month with every cost logged and every ratio inside its band.

    ₹300,000 net sales: food 30%, labour 22%, occupancy 8%, running 10%.
    """
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, tax=25, day=day, n=20)      # ₹300,000 net
        _spend(db, "cogs_food", 90000, name="Vegetables")
        _staff(db, 6, 11000)                               # ₹66,000 = 22%
        _spend(db, "occupancy", 24000, name="Rent")
        _spend(db, "operating", 30000, name="Electricity")
        _spend(db, "admin", 6000, name="Accounting")
        db.commit()
    return client


# ── the denominator ─────────────────────────────────────────────────────────

def test_ratios_are_measured_on_net_sales_not_on_the_taxed_total(healthy):
    """GST is collected for the government, not earned. Leaving it in the
    denominator quietly flatters every single ratio on the page."""
    d = _pnl(healthy)
    assert d["sales"]["net_rupees"] == 300000.0
    assert d["sales"]["total_rupees"] == 315000.0
    assert d["measured_on"] == "net sales, excluding GST"
    assert _line(d, "cogs_food")["percent_of_net"] == 30.0   # not 28.6


def test_the_tax_collected_is_reported_separately(healthy):
    assert _pnl(healthy)["sales"]["tax_paise"] == 1500000


# ── the bands ───────────────────────────────────────────────────────────────

def test_a_healthy_month_reads_healthy(healthy):
    d = _pnl(healthy)
    assert _line(d, "cogs_food")["status"] == "good"
    assert _line(d, "labour")["status"] == "good"
    assert d["prime_cost"]["percent_of_net"] == 52.0
    assert d["totals"]["profit_known"] is True
    assert d["totals"]["profit_rupees"] == 84000.0


def test_food_over_the_band_is_called_out(client):
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        _spend(db, "cogs_food", 150000, name="Vegetables")   # 50%
        _staff(db, 6, 11000)
        _spend(db, "occupancy", 24000, name="Rent")
        _spend(db, "operating", 30000, name="Electricity")
        db.commit()
    d = _pnl(client)
    assert _line(d, "cogs_food")["status"] == "over"
    assert "50.0%" in _find(d, "Food cost")["title"]


def test_prime_cost_above_the_danger_line_is_the_loudest_finding(client):
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        _spend(db, "cogs_food", 135000, name="Vegetables")   # 45%
        _staff(db, 6, 15000)                                 # ₹90,000 = 30%
        _spend(db, "occupancy", 24000, name="Rent")
        _spend(db, "operating", 30000, name="Electricity")
        db.commit()
    d = _pnl(client)
    assert d["prime_cost"]["percent_of_net"] == 75.0
    f = _find(d, "Prime cost")
    assert f["severity"] == "act"
    assert "cannot carry" in f["title"]


# ── the trust gate: the point of the whole page ─────────────────────────────

def test_a_cost_far_under_its_band_is_unlogged_not_excellent(client):
    """The single most harmful thing this page could do is congratulate a
    shop for a 2% food cost that only means the buying is not in the book."""
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        _spend(db, "cogs_food", 6000, name="Vegetables")     # 2%
        _staff(db, 6, 11000)
        db.commit()
    d = _pnl(client)
    assert _line(d, "cogs_food")["percent_of_net"] == 2.0
    assert _line(d, "cogs_food")["status"] == "unlogged"


def test_no_profit_is_shown_while_costs_are_missing(client):
    """Sales minus the costs you happened to log is not profit."""
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        _staff(db, 6, 11000)                    # wages only, no rent, no food
        db.commit()
    d = _pnl(client)
    t = d["totals"]
    assert t["profit_known"] is False
    assert t["profit_rupees"] is None
    assert t["profit_percent_of_net"] is None
    assert "flatter you" in t["profit_unknown_why"]
    assert d["per_bill"]["profit_rupees"] is None


def test_no_break_even_is_shown_while_costs_are_missing(client):
    """Break-even from fixed costs nobody entered always says you are
    comfortably clear, which is the most expensive lie available."""
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        _staff(db, 6, 11000)
        db.commit()
    d = _pnl(client)
    assert d["breakeven"]["possible"] is False
    assert "flatter" in d["breakeven"]["why"]
    _no_finding(d, "break even")
    _find(d, "not yet trustworthy")


def test_contribution_is_withheld_when_food_cost_is_not_believable(client):
    """Contribution needs a real food cost; with a token ₹100 logged it
    would read as a ~100% margin."""
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        _spend(db, "cogs_food", 100, name="Vegetables")
        _staff(db, 6, 11000)
        _spend(db, "occupancy", 24000, name="Rent")
        _spend(db, "operating", 30000, name="Electricity")
        db.commit()
    d = _pnl(client)
    assert d["per_bill"]["contribution_rupees"] is None
    assert d["breakeven"]["possible"] is False


def test_everything_is_shown_once_the_costs_are_really_there(healthy):
    d = _pnl(healthy)
    assert d["data_quality"]["missing_groups"] == []
    assert d["data_quality"]["costs_complete"] is True
    assert d["breakeven"]["possible"] is True
    assert d["per_bill"]["contribution_rupees"] is not None
    _no_finding(d, "not yet trustworthy")


# ── break-even ──────────────────────────────────────────────────────────────

def test_a_part_month_scales_fixed_costs_before_finding_break_even(client):
    """Rent paid on the 1st is a whole month's rent even on the 4th. Left
    unscaled, a month-to-date break-even looks a fraction of the real one
    and tells the owner they are clear when they are not."""
    today = date.today()
    month = today.strftime("%Y-%m")
    with SessionLocal() as db:
        for day in range(1, today.day + 1):
            _sell(db, net=500, day=day, n=20, month=month)
        net = 500 * 20 * today.day
        _spend(db, "cogs_food", net * 0.30, name="Vegetables", day=1,
               month=month)
        _staff(db, 6, 11000)
        _spend(db, "occupancy", 24000, name="Rent", day=1, month=month)
        _spend(db, "operating", 30000, name="Electricity", day=1, month=month)
        db.commit()
    d = _pnl(client, month)
    be, p = d["breakeven"], d["payroll"]
    assert p["prorated"] is (today.day < p["days_in_month"])
    raw = p["period_paise"] + 5400000                  # rent + power as entered
    scaled = raw / p["days_counted"] * p["days_in_month"]
    assert be["fixed_costs_rupees"] == pytest.approx(scaled / 100, abs=1.0)
    if today.day < p["days_in_month"]:
        assert be["fixed_costs_rupees"] > raw / 100, "a part month was not scaled"


def test_break_even_is_expressed_in_bills_a_day(healthy):
    """Rupees a month is the accountant's answer; a floor manager can only
    act on covers."""
    be = _pnl(healthy)["breakeven"]
    assert be["contribution_margin_percent"] == 70.0        # 100 - 30% food
    # fixed = labour 66,000 + rent 24,000 + running 30,000 + admin 6,000
    assert be["fixed_costs_rupees"] == 126000.0
    assert be["month_rupees"] == 180000.0                   # 126,000 / 0.70
    assert be["bills_per_day"] == 12                        # ₹6,000/day ÷ ₹500
    assert be["actual_bills_per_day"] == 20.0


def test_a_shop_below_break_even_is_told_so(client):
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=6)            # ₹90,000 net
        _spend(db, "cogs_food", 27000, name="Vegetables")
        _staff(db, 6, 11000)
        _spend(db, "occupancy", 24000, name="Rent")
        _spend(db, "operating", 30000, name="Electricity")
        db.commit()
    d = _pnl(client)
    f = _find(d, "break even")
    assert f["severity"] == "act"
    assert "short" in f["detail"]


def test_break_even_is_impossible_when_food_costs_more_than_it_sells_for(client):
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        _spend(db, "cogs_food", 400000, name="Vegetables")
        _staff(db, 6, 11000)
        _spend(db, "occupancy", 24000, name="Rent")
        _spend(db, "operating", 30000, name="Electricity")
        db.commit()
    be = _pnl(client)["breakeven"]
    assert be["possible"] is False
    assert "cost more than" in be["why"]


def test_no_sales_says_so_and_stops(client):
    d = _pnl(client, "2026-03")
    assert d["breakeven"]["possible"] is False
    assert d["findings"][0]["title"] == "No sales recorded this month"
    assert len(d["findings"]) == 1


# ── labour ──────────────────────────────────────────────────────────────────

def test_labour_comes_from_the_staff_master(healthy):
    p = _pnl(healthy)["payroll"]
    assert p["headcount"] == 6
    assert p["monthly_rupees"] == 66000.0
    assert _line(_pnl(healthy), "labour")["percent_of_net"] == 22.0


def test_a_part_month_prorates_the_wage_bill(client):
    """Eleven days of sales against a whole month of salary would read as
    a catastrophic wage bill and panic an owner mid-month."""
    this_month = date.today().strftime("%Y-%m")
    with SessionLocal() as db:
        _staff(db, 6, 30000)
        db.commit()
    d = _pnl(client, this_month)
    p = d["payroll"]
    assert p["monthly_rupees"] == 180000.0
    assert p["days_counted"] == date.today().day
    assert p["prorated"] is True
    share = p["days_counted"] / p["days_in_month"]
    assert p["period_paise"] == pytest.approx(18000000 * share, abs=100)


def test_a_whole_past_month_is_not_prorated(healthy):
    p = _pnl(healthy)["payroll"]
    assert p["prorated"] is False
    assert p["period_paise"] == 6600000
    assert p["days_counted"] == DAYS


def test_staff_who_left_are_not_paid(client):
    with SessionLocal() as db:
        _staff(db, 3, 10000)
        db.add(Employee(outlet_id=1, name="Gone", designation="cook",
                        monthly_salary_paise=5000000,
                        working_status="left", is_active=True))
        db.commit()
    assert _pnl(client)["payroll"]["monthly_rupees"] == 30000.0


def test_salaries_booked_as_an_expense_too_are_flagged(client):
    """Wages already come from the staff master. Logged again as an
    expense they double the one cost an owner cannot afford to misread."""
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        _staff(db, 6, 11000)
        _spend(db, "labour", 66000, name="Salaries")
        db.commit()
    f = _find(_pnl(client), "counted twice")
    assert f["severity"] == "act"
    assert "Salaries" in f["detail"]


def test_staff_meals_hiding_in_food_cost_are_flagged(client):
    """Staff food left in food cost makes the kitchen look wasteful and
    the wage bill look lean, which is backwards."""
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        _spend(db, "cogs_food", 90000, name="Vegetables")
        _spend(db, "cogs_food", 4000, name="Vegetables", day=6,
               item="staff sabzi")
        db.commit()
    d = _pnl(client)
    assert d["data_quality"]["staff_meal_entries"] == 1
    assert d["data_quality"]["staff_meals_in_food_rupees"] == 4000.0
    _find(d, "Staff meals")


def test_ordinary_food_is_not_mistaken_for_a_staff_meal(client):
    """A page that cries wolf on every vegetable entry gets ignored."""
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        _spend(db, "cogs_food", 90000, name="Vegetables", item="tomatoes")
        db.commit()
    d = _pnl(client)
    assert d["data_quality"]["staff_meal_entries"] == 0
    _no_finding(d, "Staff meals")


# ── rolling window ──────────────────────────────────────────────────────────

def test_a_bulk_order_at_the_month_end_is_reported_as_a_distortion(client):
    """One drum of oil bought on the 30th spikes that month and hollows
    out the next; the rolling window is the honest read."""
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        _spend(db, "cogs_food", 30000, name="Vegetables", day=2)
        _spend(db, "cogs_food", 60000, name="Vegetables", day=29)
        _staff(db, 6, 11000)
        _spend(db, "occupancy", 24000, name="Rent")
        _spend(db, "operating", 30000, name="Electricity")
        db.commit()
    d = _pnl(client)
    roll = d["rolling_food_cost"]
    assert roll["days"] == 28
    assert roll["start"] == "2026-04-03"
    assert roll["percent_of_net"] != d["cogs"]["percent_of_net"]


# ── levers ──────────────────────────────────────────────────────────────────

def test_levers_use_the_real_margin_when_food_cost_is_known(healthy):
    d = _pnl(healthy)
    lever = next(l for l in d["sensitivity"] if "5 more bills" in l["lever"])
    assert lever["assumed_food_cost_percent"] is None
    # ₹500 ticket x 5 x 30 days x 70% margin
    assert lever["monthly_rupees"] == 52500.0


def test_levers_assume_a_band_margin_when_food_cost_is_unknown(client):
    """Without a food cost the margin looks like 100% and every lever
    treble-counts. Assuming the middle of the band, and saying so, is
    more use than either a wrong number or a blank."""
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        _staff(db, 6, 11000)
        db.commit()
    lever = next(l for l in _pnl(client)["sensitivity"]
                 if "5 more bills" in l["lever"])
    assert lever["assumed_food_cost_percent"] == 31.5
    assert lever["monthly_rupees"] == 51375.0        # not the 75,000 of a 100% margin
    assert "not logged yet" in lever["how"]


# ── plumbing ────────────────────────────────────────────────────────────────

def test_categories_carry_their_cost_group(client):
    cats = _cats(client)
    assert cats["rent"]["cost_group"] == "occupancy"
    assert cats["vegetables & fruits"]["cost_group"] == "cogs_food"
    assert cats["rent"]["cost_group_label"] == "Rent & occupancy"


def test_a_category_can_be_retagged(client):
    cat = _cats(client)["rent"]
    r = client.patch(f"/api/lists/categories/{cat['id']}/group",
                     json={"cost_group": "admin"})
    assert r.status_code == 200, r.text
    assert _cats(client)["rent"]["cost_group"] == "admin"


def test_a_nonsense_group_is_refused(client):
    cat = _cats(client)["rent"]
    r = client.patch(f"/api/lists/categories/{cat['id']}/group",
                     json={"cost_group": "banana"})
    assert r.status_code == 422


def test_the_group_list_is_offered_with_labels(client):
    r = client.get("/api/lists/cost-groups")
    assert r.status_code == 200, r.text
    rows = r.json()
    rows = rows["items"] if isinstance(rows, dict) else rows
    keys = {g["key"] for g in rows}
    assert {"cogs_food", "labour", "occupancy", "operating", "admin"} <= keys
    assert all(g["label"] and g["hint"] for g in rows)


def test_an_expense_in_no_recognised_group_still_lands_somewhere(client):
    with SessionLocal() as db:
        for day in range(1, DAYS + 1):
            _sell(db, net=500, day=day, n=20)
        cat = ExpenseCategory(name="Mystery", cost_group="nonsense",
                              is_active=True)
        db.add(cat)
        db.flush()
        db.add(Expense(outlet_id=1, business_date=f"{MONTH}-05",
                       category_id=cat.id, amount_paise=100000, mode="cash",
                       description="", item_name="", idempotency_key="t:myst"))
        db.commit()
    d = _pnl(client)
    assert _line(d, "operating")["rupees"] == 1000.0


def test_the_month_defaults_to_this_one(client):
    r = client.get("/api/pnl/summary")
    assert r.status_code == 200, r.text
    assert r.json()["month"] == date.today().strftime("%Y-%m")


def test_a_future_month_is_empty_rather_than_an_error(client):
    d = _pnl(client, "2099-01")
    assert d["sales"]["bills"] == 0
    assert d["breakeven"]["possible"] is False


def test_the_page_needs_a_login(client):
    bare = client.__class__(client.app) if hasattr(client, "app") else None
    if bare is None:
        pytest.skip("no bare client available")
    assert bare.get("/api/pnl/summary").status_code == 401


# ---------------------------------------------------------------- bands --
# A band is not decoration: it decides whether a cost reads "healthy", and
# a cost far below its band is reported as unlogged rather than excellent.
# So a shop that cannot set its own bands is told off for running a cloud
# kitchen, and a corrupt band would take the whole report down.


def _bands(client):
    r = client.get("/api/pnl/bands")
    assert r.status_code == 200, r.text
    return {row["key"]: row for row in r.json()["items"]}


def _elevate(client):
    """Bands are step-up gated like every other setting that changes what
    the books say. The screen re-asks for the password; tests must too."""
    r = client.post("/api/auth/stepup", json={"password": "change-me-please"})
    assert r.status_code == 200, r.text
    return client


def test_out_of_the_box_the_published_figures_are_in_force(client):
    rows = _bands(client)
    assert rows["prime"]["low"] == 55.0 and rows["prime"]["high"] == 60.0
    assert all(not r["is_custom"] for r in rows.values())


def test_every_line_the_report_judges_can_be_edited(client):
    d = _pnl(client)
    judged = {l["key"] for l in d["lines"]} | {"prime"}
    editable = set(_bands(client))
    # food and beverage share one band; everything else must be reachable
    assert judged - {"cogs_food", "cogs_bev"} <= editable
    assert "cogs" in editable


def test_each_band_says_what_it_is_for(client):
    assert all(r["label"] and r["hint"] for r in _bands(client).values())


def test_a_shop_can_set_its_own_band(client):
    r = _elevate(client).put("/api/pnl/bands", json={"occupancy": [12.0, 20.0]})
    assert r.status_code == 200, r.text
    rows = _bands(client)
    assert rows["occupancy"]["low"] == 12.0
    assert rows["occupancy"]["is_custom"] is True


def test_setting_one_band_leaves_the_rest_alone(client):
    _elevate(client).put("/api/pnl/bands", json={"occupancy": [12.0, 20.0]})
    rows = _bands(client)
    assert rows["labour"]["low"] == 20.0
    assert rows["labour"]["is_custom"] is False


def test_the_defaults_are_still_shown_so_the_owner_can_go_back(client):
    _elevate(client).put("/api/pnl/bands", json={"occupancy": [12.0, 20.0]})
    row = _bands(client)["occupancy"]
    assert (row["default_low"], row["default_high"]) == (6.0, 10.0)


def test_saving_the_default_back_drops_the_override(client):
    """Not merely 'reads the same': the override must be gone from the
    settings, or a shop that went back to standard would stay pinned to
    today's figure if the published band were ever revised."""
    from app.audit import get_setting_db

    _elevate(client).put("/api/pnl/bands", json={"occupancy": [12.0, 20.0]})
    _elevate(client).put("/api/pnl/bands", json={"occupancy": [6.0, 10.0]})
    assert _bands(client)["occupancy"]["is_custom"] is False
    with SessionLocal() as db:
        assert not (get_setting_db(db, "pnl_bands", None) or {})


def test_a_band_the_shop_set_changes_the_verdict(client):
    """The point of the whole feature: a mall counter paying 15% rent is
    not overspending, and must stop being told that it is."""
    with SessionLocal() as db:
        _sell(db, net=1000, n=100, day=3)
        _spend(db, "occupancy", 15000, name="Mall rent")
        db.commit()
    assert _line(_pnl(client), "occupancy")["status"] in ("high", "over")

    _elevate(client).put("/api/pnl/bands", json={"occupancy": [12.0, 20.0]})
    assert _line(_pnl(client), "occupancy")["status"] == "good"


def test_a_reversed_band_is_refused(client):
    r = _elevate(client).put("/api/pnl/bands", json={"labour": [30.0, 10.0]})
    assert r.status_code == 422
    assert "smaller" in r.json()["detail"]
    assert _bands(client)["labour"]["is_custom"] is False


def test_a_band_that_is_not_a_share_of_sales_is_refused(client):
    assert _elevate(client).put("/api/pnl/bands", json={"labour": [10.0, 140.0]}).status_code == 422
    assert _elevate(client).put("/api/pnl/bands", json={"labour": [-5.0, 20.0]}).status_code == 422


def test_a_zero_width_band_is_refused(client):
    assert _elevate(client).put("/api/pnl/bands", json={"labour": [20.0, 20.0]}).status_code == 422


def test_words_where_numbers_belong_are_refused(client):
    assert _elevate(client).put("/api/pnl/bands", json={"labour": ["low", "high"]}).status_code == 422


def test_a_band_needs_exactly_a_low_and_a_high(client):
    assert _elevate(client).put("/api/pnl/bands", json={"labour": [20.0]}).status_code == 422
    assert _elevate(client).put("/api/pnl/bands", json={"labour": [1.0, 2.0, 3.0]}).status_code == 422
    assert _elevate(client).put("/api/pnl/bands", json={"labour": 20.0}).status_code == 422


def test_a_line_that_does_not_exist_is_refused(client):
    r = _elevate(client).put("/api/pnl/bands", json={"parking": [1.0, 2.0]})
    assert r.status_code == 422
    assert "parking" in r.json()["detail"]


def test_one_bad_line_saves_none_of_them(client):
    r = _elevate(client).put("/api/pnl/bands",
                   json={"occupancy": [12.0, 20.0], "labour": [30.0, 10.0]})
    assert r.status_code == 422
    assert _bands(client)["occupancy"]["is_custom"] is False


def test_a_corrupt_setting_cannot_take_the_report_down(client):
    """Hand-edited databases and downgrades happen. The report must fall
    back to the published figure rather than 500."""
    from app.audit import set_setting_db

    with SessionLocal() as db:
        set_setting_db(db, "pnl_bands",
                       {"labour": "twenty", "occupancy": [9.0],
                        "parking": [1.0, 2.0], "prime": [40.0, 50.0]}, None)
        db.commit()
    rows = _bands(client)
    assert rows["labour"]["low"] == 20.0
    assert rows["occupancy"]["low"] == 6.0
    assert "parking" not in rows
    assert rows["prime"]["low"] == 40.0
    assert _pnl(client)["month"] == MONTH


def test_only_the_owner_may_change_the_bands(client, manager):
    assert manager.put("/api/pnl/bands", json={"labour": [10.0, 20.0]}).status_code == 403


def test_changing_the_bands_needs_the_password_again(client, fresh_owner):
    assert fresh_owner.put("/api/pnl/bands",
                           json={"labour": [10.0, 20.0]}).status_code == 428


def test_anyone_logged_in_may_read_the_bands(client, manager):
    assert manager.get("/api/pnl/bands").status_code == 200