"""Shared rules for when a reported profit is safe to show."""
from __future__ import annotations

from typing import Mapping

from .audit import get_setting_db
from .costgroups import BANDS_DEFAULT, COGS_GROUPS, GROUPS

UNDERLOG_FRACTION = 0.5


def clean_band(value) -> list[float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    try:
        low, high = float(value[0]), float(value[1])
    except (TypeError, ValueError):
        return None
    if not 0 <= low < high <= 100:
        return None
    return [round(low, 1), round(high, 1)]


def effective_bands(db) -> dict[str, list[float]]:
    """Return safe saved P&L bands, falling back from corrupt settings."""
    result = {key: list(value) for key, value in BANDS_DEFAULT.items()}
    saved = get_setting_db(db, "pnl_bands", None)
    if isinstance(saved, dict):
        for key, value in saved.items():
            band = clean_band(value)
            if key in result and band is not None:
                result[key] = band
    return result


def financial_completeness(
    groups: Mapping[str, Mapping[str, int]],
    *,
    net_sales_paise: int,
    bands: Mapping[str, list[float]],
) -> dict:
    """Decide whether profit can be reported without making it flattering.

    Food and beverage are one major cost for this gate because their shared
    P&L band is what determines whether the cost of sales is believable.
    """
    cogs_paise = sum(groups.get(key, {}).get("paise", 0) for key in COGS_GROUPS)
    cogs_entries = sum(groups.get(key, {}).get("entries", 0) for key in COGS_GROUPS)
    cogs_floor = bands["cogs"][0] * UNDERLOG_FRACTION
    cogs_logged = bool(cogs_entries) and (
        not net_sales_paise or cogs_paise / net_sales_paise * 100 >= cogs_floor
    )
    missing_groups = []
    if not cogs_logged:
        missing_groups.append(GROUPS["cogs_food"][0])
    for key in ("occupancy", "operating"):
        if not groups.get(key, {}).get("entries", 0):
            missing_groups.append(GROUPS[key][0])

    known = not missing_groups
    reason = None if known else (
        f"Not shown: nothing believable is logged for {', '.join(missing_groups)}, "
        "so any figure here would flatter you rather than inform you."
    )
    return {
        "profit_known": known,
        "profit_unknown_reason": reason,
        "missing_cost_groups": missing_groups,
        "cogs_logged": cogs_logged,
    }
