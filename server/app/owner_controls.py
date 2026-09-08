"""Shared owner policy and recurring-review calculations.

The settings are per outlet.  Keeping the old variance key as a fallback
means existing books retain their threshold until an owner deliberately saves
the new policy card.
"""
from __future__ import annotations

from datetime import date, timedelta

from .audit import get_setting_db

POLICY_DEFAULTS = {
    "cash_variance_alert_paise": None,
    "minimum_data_coverage_percent": 70,
    "stock_count_cadence_days": 30,
    "stockout_lead_days": 7,
    "payable_overdue_days": 90,
    "purchase_approval_limit_paise": 0,
    "minimum_cash_buffer_paise": None,
}


def policy_key(outlet_id: int) -> str:
    return f"owner_policy:{outlet_id}"


def owner_policy(db, outlet_id: int) -> dict:
    values = get_setting_db(db, policy_key(outlet_id), {})
    values = values if isinstance(values, dict) else {}
    policy = dict(POLICY_DEFAULTS)
    policy.update({key: value for key, value in values.items() if key in policy})
    if policy["cash_variance_alert_paise"] is None:
        policy["cash_variance_alert_paise"] = int(
            get_setting_db(db, "variance_alert_paise", 20_000))
    return policy


def recurring_review_signal(cost, today: date | None = None) -> dict:
    """Return the non-posting review and expected-outflow state for one cost."""
    today = today or date.today()
    cadence = max(1, int(cost.review_cadence_days or 90))
    last = cost.last_owner_review_at.date() if cost.last_owner_review_at else None
    next_review = last + timedelta(days=cadence) if last else today
    due = bool(cost.is_active and next_review <= today)
    return {
        "last_owner_review_at": cost.last_owner_review_at.isoformat()
        if cost.last_owner_review_at else None,
        "review_cadence_days": cadence,
        "next_review_date": next_review.isoformat(),
        "review_due": due,
    }
