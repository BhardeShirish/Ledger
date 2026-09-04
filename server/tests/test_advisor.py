"""The spend review: does it tell the owner the truth?

Every rule gets a scenario built for it, because a findings engine that
silently stops firing looks exactly like a quiet month.
"""
from datetime import date, timedelta

import pytest

from app.db import SessionLocal
from app.models import Employee, Expense, ExpenseCategory, SalesDaily


def _month_start(back: int) -> date:
    """First day of the month `back` months before this one."""
    d = date.today().replace(day=1)
    for _ in range(back):
        d = (d - timedelta(days=1)).replace(day=1)
    return d


CUR = _month_start(2)      # two complete months back, so nothing is partial
PREV = _month_start(3)


def _cat(db, name: str) -> int:
    c = db.query(ExpenseCategory).filter(ExpenseCategory.name == name).first()
    if c is None:
        c = ExpenseCategory(name=name, is_active=True, sort=99)
        db.add(c)
        db.flush()
    return c.id


def _exp(db, when: date, cat: str, rupees: float, *, item="", qty=None, unit=""):
    db.add(Expense(outlet_id=1, business_date=when.isoformat(),
                   category_id=_cat(db, cat), amount_paise=int(rupees * 100),
                   mode="upi", description="test", item_name=item,
                   quantity=qty, unit=unit))


def _sales(db, when: date, rupees: float):
    db.add(SalesDaily(outlet_id=1, business_date=when.isoformat(),
                      channel_kind="dine_in", source="manual",
                      amount_paise=int(rupees * 100)))


@pytest.fixture()
def books(client):
    """Two full months, built so each finding has something to find."""
    with SessionLocal() as db:
        # last month
        _exp(db, PREV + timedelta(days=1), "Rent", 20000)
        _exp(db, PREV + timedelta(days=2), "Vegetables", 10000)
        _exp(db, PREV + timedelta(days=3), "Gas", 5000)
        _exp(db, PREV + timedelta(days=4), "Packaging", 4000)
        _exp(db, PREV + timedelta(days=5), "Vegetables", 2000,
             item="Rice", qty=40, unit="kg")          # ₹50/kg
        # this month
        _exp(db, CUR + timedelta(days=1), "Rent", 25000)          # fixed, +5000
        _exp(db, CUR + timedelta(days=2), "Vegetables", 18000)    # +8000
        _exp(db, CUR + timedelta(days=3), "Gas", 5000)            # flat
        _exp(db, CUR + timedelta(days=4), "Repairs", 3000)        # brand new
        _exp(db, CUR + timedelta(days=5), "Vegetables", 2400,
             item="Rice", qty=40, unit="kg")          # ₹60/kg, +20%
        # Packaging: nothing this month, so it should read as a fall
        for i in range(10):
            _sales(db, PREV + timedelta(days=i), 20000)
            _sales(db, CUR + timedelta(days=i), 20000)
        db.add(Employee(code="NEW1", name="Newly Joined", outlet_id=1,
                        monthly_salary_paise=1500000,
                        join_date=(CUR + timedelta(days=2)).isoformat(),
                        working_status="active"))
        db.commit()
    return client


def _review(c, month: date):
    r = c.get("/api/advisor/review",
              params={"month": month.strftime("%Y-%m"), "outlet_id": 1})
    assert r.status_code == 200, r.text
    return r.json()


def _titles(d):
    return " | ".join(f["title"] for f in d["findings"])


def _detail(d, needle):
    """The whole finding (title + detail) that mentions `needle`."""
    for f in d["findings"]:
        if needle.lower() in f["title"].lower():
            return f["title"] + " — " + f["detail"]
    raise AssertionError(f"no finding mentioning {needle!r} in: {_titles(d)}")


# ── the facts ───────────────────────────────────────────────────────────────

def test_totals_and_comparison(books):
    d = _review(books, CUR)
    assert d["totals"]["spend_rupees"] == 53400        # 25000+18000+5000+3000+2400
    assert d["totals"]["prev_spend_rupees"] == 41000
    assert d["data_quality"]["enough_to_compare"] is True


def test_fixed_variable_split_matches_breakeven_rules(books):
    d = _review(books, CUR)
    fv = d["fixed_variable"]
    assert fv["fixed_rupees"] == 25000                 # Rent only
    assert fv["prev_fixed_rupees"] == 20000
    assert fv["variable_rupees"] == 53400 - 25000


def test_category_deltas_are_sorted_biggest_riser_first(books):
    d = _review(books, CUR)
    first = d["categories"][0]
    assert first["category"] == "Vegetables"
    assert first["delta_rupees"] == 8400
    assert first["prev_rupees"] == 12000


# ── the findings ────────────────────────────────────────────────────────────

def test_names_the_biggest_cost(books):
    assert "Rent" in _titles(_review(books, CUR))


def test_flags_the_category_that_rose(books):
    d = _review(books, CUR)
    assert "8,400" in _detail(d, "Vegetables")


def test_calls_a_fixed_cost_rise_out_as_repeating(books):
    d = _review(books, CUR)
    assert "repeats every month" in _detail(d, "Rent is up")


def test_explains_why_fixed_costs_moved(books):
    d = _review(books, CUR)
    detail = _detail(d, "Fixed costs rose")
    assert "Rent" in detail, detail


def test_spots_a_brand_new_cost(books):
    d = _review(books, CUR)
    assert "nothing last month" in _detail(d, "New spend: Repairs")


def test_spots_a_cost_that_came_down(books):
    d = _review(books, CUR)
    assert "Packaging" in _titles(d)


def test_spots_a_supplier_price_rise(books):
    d = _review(books, CUR)
    detail = _detail(d, "Rice")
    assert "60.00/kg" in detail and "50.00/kg" in detail, detail


def test_notices_a_new_hire_and_the_salary_it_commits(books):
    d = _review(books, CUR)
    detail = _detail(d, "Staff count went up")
    assert "Newly Joined" in detail
    assert "15,000" in detail


def test_suggests_where_to_cut_and_never_a_fixed_cost(books):
    d = _review(books, CUR)
    detail = _detail(d, "Easiest place to save")
    assert "Vegetables" in detail
    # Rent is the biggest line of all, but you cannot trim rent this month,
    # so the suggestion must skip it and pick the largest *variable* cost.
    assert "Rent" not in detail


def test_severities_are_ordered_act_first(books):
    sev = [f["severity"] for f in _review(books, CUR)["findings"]]
    order = {"act": 0, "watch": 1, "good": 2, "info": 3}
    assert sev == sorted(sev, key=lambda s: order[s])


# ── honesty when there is little data ───────────────────────────────────────

def test_says_so_rather_than_inventing_a_trend(client):
    """A first month must not report a triumphant fall from nothing.

    The trap: last month has sales recorded but nobody logged the expenses,
    so its cost ratio computes as a clean 0%. Compared against a real 25%
    this month, that reads as costs exploding — when all that happened is
    someone started writing bills down.
    """
    with SessionLocal() as db:
        _sales(db, PREV + timedelta(days=1), 20000)   # sales, but no expenses
        _exp(db, CUR + timedelta(days=1), "Vegetables", 5000)
        _sales(db, CUR + timedelta(days=1), 20000)
        db.commit()
    d = _review(client, CUR)
    assert d["data_quality"]["enough_to_compare"] is False
    assert "Too early to compare months" in _titles(d)
    # no percentage change invented off a baseline nobody wrote down
    assert "was 0.0% last month" not in str(d["findings"])
    assert not [f for f in d["findings"] if f["severity"] in ("act", "watch")], \
        _titles(d)


def test_empty_ledger_does_not_crash(client):
    r = client.get("/api/advisor/review")
    assert r.status_code == 200, r.text
    assert r.json()["findings"] == [] or isinstance(r.json()["findings"], list)


def test_rejects_a_nonsense_month(client):
    assert client.get("/api/advisor/review?month=banana").status_code == 422
    assert client.get("/api/advisor/review?month=2025-13").status_code == 422


def test_running_month_compares_like_for_like(client):
    """A half-finished month must meet the same half of the month before."""
    today = date.today()
    r = client.get("/api/advisor/review",
                   params={"month": today.strftime("%Y-%m")})
    assert r.status_code == 200, r.text
    p = r.json()["period"]
    assert p["partial"] is True
    assert p["end"] == today.isoformat()
    span = (date.fromisoformat(p["end"]) - date.fromisoformat(p["start"])).days
    prev_span = (date.fromisoformat(p["prev_end"])
                 - date.fromisoformat(p["prev_start"])).days
    assert span == prev_span


# ── the AI layer ────────────────────────────────────────────────────────────

def test_advice_refuses_politely_when_ai_is_not_set_up(books):
    r = books.post("/api/advisor/advice", json={"month": CUR.strftime("%Y-%m")})
    assert r.status_code == 400
    assert "Settings" in r.json()["detail"]


def test_nothing_identifying_is_sent_to_the_model(books):
    """Staff names must never leave the machine."""
    from app.routers.advisor import _slim, build_facts
    from app.db import SessionLocal as S
    from app.models import User
    with S() as db:
        user = db.query(User).filter_by(role="owner").first()
        facts = build_facts(db, user, CUR.strftime("%Y-%m"), 1)
    assert "Newly Joined" in str(facts["staff"]["joined"])
    payload = _slim(facts)
    assert "Newly Joined" not in str(payload)
    assert payload["staff"]["joined"] == 1


def _configure_ai(c):
    c.post("/api/auth/stepup", json={"password": "change-me-please"})
    r = c.put("/api/ocr/config", json={
        "enabled": True, "provider": "openai_compat",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": "gemini-2.0-flash", "api_key": "test-key-123"})
    assert r.status_code == 200, r.text


class _Reply:
    status_code = 200

    def __init__(self, text):
        self._text = text

    def json(self):
        return {"choices": [{"message": {"content": self._text}}]}


def test_advice_sends_the_figures_and_returns_the_words(books, monkeypatch):
    """The whole AI path, with a stub in place of the network.

    Proves the request we build is a valid chat completion, that the key
    goes in a header rather than the body, and that only aggregates travel.
    """
    _configure_ai(books)
    seen = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        seen["url"] = url
        seen["body"] = json
        seen["headers"] = headers
        return _Reply("Vegetables cost you ₹8,400 more. Get a second quote.")

    monkeypatch.setattr("app.routers.advisor.httpx.post", fake_post)

    r = books.post("/api/advisor/advice", json={"month": CUR.strftime("%Y-%m"),
                                                "outlet_id": 1})
    assert r.status_code == 200, r.text
    assert "second quote" in r.json()["text"]
    assert r.json()["model"] == "gemini-2.0-flash"
    assert r.json()["findings"], "the deterministic findings ride along too"

    assert seen["url"].endswith("/chat/completions")
    assert seen["body"]["model"] == "gemini-2.0-flash"
    sent = str(seen["body"])
    assert "Vegetables" in sent and "Newly Joined" not in sent
    assert "test-key-123" not in sent, "the key must travel as a header, not a prompt"


def test_advice_reports_an_upstream_failure_instead_of_pretending(books, monkeypatch):
    _configure_ai(books)

    class Boom:
        status_code = 429
        text = "rate limited, slow down"

    monkeypatch.setattr("app.routers.advisor.httpx.post",
                        lambda *a, **k: Boom())
    r = books.post("/api/advisor/advice", json={"month": CUR.strftime("%Y-%m")})
    assert r.status_code == 502
    assert "429" in r.json()["detail"]


def test_advice_rejects_an_empty_answer(books, monkeypatch):
    """An empty reply must not render as a blank, authoritative-looking box."""
    _configure_ai(books)
    monkeypatch.setattr("app.routers.advisor.httpx.post",
                        lambda *a, **k: _Reply("   "))
    r = books.post("/api/advisor/advice", json={"month": CUR.strftime("%Y-%m")})
    assert r.status_code == 502
    assert "empty" in r.json()["detail"].lower()
