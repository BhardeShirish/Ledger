"""The five lines a restaurant P&L is actually read on.

A flat list of expense categories can answer "what did I spend on?". It
cannot answer "am I spending too much?", because every published
restaurant benchmark is stated per group, not per category. Grouping is
what turns a spend log into a P&L.

Food and beverage are kept apart on purpose. A cafe's coffee runs at a
15-25% cost while its kitchen runs at 30%+; blended into one figure, a
profitable drinks trade can hide a leaking kitchen for a year.
"""
from __future__ import annotations

# key -> (label, what it means to an owner)
GROUPS: dict[str, tuple[str, str]] = {
    "cogs_food": ("Food cost", "Everything that goes onto a plate."),
    "cogs_bev": ("Beverage cost", "Coffee, tea, milk and drinks."),
    "labour": ("Labour", "Wages, staff food and welfare."),
    "occupancy": ("Rent & occupancy", "Rent, licences, insurance — the cost of the address."),
    "operating": ("Running costs", "Power, gas, water, repairs, transport, marketing."),
    "admin": ("Other", "Anything that fits nowhere else."),
}

COGS_GROUPS = ("cogs_food", "cogs_bev")

#: Prime cost is COGS + labour. Operators run the business on it because
#: those are the only large costs that can be changed this week — rent
#: cannot be renegotiated on a Tuesday, but tomorrow's vegetable order and
#: tomorrow's roster can.
PRIME_GROUPS = COGS_GROUPS + ("labour",)

#: Healthy bands as a share of net (ex-GST) sales for an Indian standalone
#: restaurant. Keyed by P&L line, not by group: food and beverage are
#: judged together as "cogs", and "prime" is the derived COGS + labour
#: line that operators actually steer on.
#:
#: These live here rather than in the report because they are part of the
#: group model: a band is what makes a group's number mean something. A
#: shop can override any of them (Settings -> Healthy bands), because a
#: delivery-only kitchen and a high-street dine-in room do not share a
#: rent band.
BANDS_DEFAULT: dict[str, list[float]] = {
    "cogs": [28.0, 35.0],
    "labour": [20.0, 25.0],
    "prime": [55.0, 60.0],
    "occupancy": [6.0, 10.0],
    "operating": [8.0, 14.0],
    "admin": [1.0, 3.0],
}

#: What each band is called on screen, and why an owner should care.
BAND_LABELS: dict[str, tuple[str, str]] = {
    "cogs": ("Food & beverage cost", "Everything you buy to sell."),
    "labour": ("Labour", "Wages, staff food and welfare."),
    "prime": ("Prime cost", "Food + labour. The one number to steer on."),
    "occupancy": ("Rent & occupancy", "Rent, licences, insurance."),
    "operating": ("Running costs", "Power, gas, water, repairs, transport."),
    "admin": ("Other", "Anything that fits nowhere else."),
}

# Words that decide a category's group when nobody has said otherwise.
# Longest match wins, so "staff welfare" beats a bare "staff".
_RULES: list[tuple[str, str]] = [
    # beverages first — "milk" and "coffee" would otherwise read as food
    ("beverage", "cogs_bev"), ("bevrage", "cogs_bev"), ("drink", "cogs_bev"),
    ("coffee", "cogs_bev"), ("tea", "cogs_bev"), ("juice", "cogs_bev"),
    ("milk", "cogs_bev"), ("water can", "cogs_bev"), ("soft drink", "cogs_bev"),
    ("cold drink", "cogs_bev"), ("bar", "cogs_bev"), ("liquor", "cogs_bev"),
    ("chai", "cogs_bev"), ("lassi", "cogs_bev"), ("chaas", "cogs_bev"),
    ("buttermilk", "cogs_bev"), ("soda", "cogs_bev"), ("syrup", "cogs_bev"),
    ("squash", "cogs_bev"), ("shake", "cogs_bev"), ("smoothie", "cogs_bev"),
    ("cocoa", "cogs_bev"), ("creamer", "cogs_bev"), ("badam", "cogs_bev"),
    # Bare "water" is the utility bill; qualified, it is stock you sell.
    ("mineral water", "cogs_bev"), ("bottled water", "cogs_bev"),
    ("packaged water", "cogs_bev"), ("drinking water", "cogs_bev"),

    ("raw material", "cogs_food"), ("vegetable", "cogs_food"),
    ("fruit", "cogs_food"), ("dairy", "cogs_food"), ("meat", "cogs_food"),
    ("fish", "cogs_food"), ("chicken", "cogs_food"), ("grocer", "cogs_food"),
    ("provision", "cogs_food"), ("kirana", "cogs_food"), ("spice", "cogs_food"),
    ("masala", "cogs_food"), ("oil", "cogs_food"), ("flour", "cogs_food"),
    ("bakery", "cogs_food"), ("food", "cogs_food"), ("kitchen", "cogs_food"),
    ("sabzi", "cogs_food"), ("subzi", "cogs_food"), ("sabji", "cogs_food"),
    ("atta", "cogs_food"), ("dal", "cogs_food"), ("rice", "cogs_food"),
    ("sugar", "cogs_food"), ("curd", "cogs_food"), ("dahi", "cogs_food"),
    ("paneer", "cogs_food"), ("ghee", "cogs_food"), ("butter", "cogs_food"),
    ("cheese", "cogs_food"), ("egg", "cogs_food"), ("bread", "cogs_food"),
    ("chutney", "cogs_food"), ("pickle", "cogs_food"), ("mutton", "cogs_food"),
    ("prawn", "cogs_food"), ("seafood", "cogs_food"), ("pulses", "cogs_food"),
    ("cereal", "cogs_food"), ("dry fruit", "cogs_food"), ("sauce", "cogs_food"),
    # Packaging and table consumables move with every cover sold, so they
    # belong with cost of sales rather than with the fixed running costs.
    ("packaging", "cogs_food"), ("packing", "cogs_food"),
    ("disposable", "cogs_food"), ("parcel", "cogs_food"),
    ("napkin", "cogs_food"), ("tissue", "cogs_food"), ("foil", "cogs_food"),
    ("straw", "cogs_food"), ("cutlery", "cogs_food"), ("container", "cogs_food"),

    ("salar", "labour"), ("wage", "labour"), ("payroll", "labour"),
    ("staff", "labour"), ("labour", "labour"), ("labor", "labour"),
    ("bonus", "labour"), ("pf", "labour"), ("esi", "labour"),

    ("rent", "occupancy"), ("lease", "occupancy"), ("licens", "occupancy"),
    ("licence", "occupancy"), ("insurance", "occupancy"),
    ("property tax", "occupancy"), ("deposit", "occupancy"),

    ("electric", "operating"), ("power", "operating"), ("gas", "operating"),
    ("water", "operating"), ("internet", "operating"), ("phone", "operating"),
    ("repair", "operating"), ("maintenance", "operating"),
    ("clean", "operating"), ("laundry", "operating"), ("pest", "operating"),
    ("fuel", "operating"), ("transport", "operating"), ("delivery", "operating"),
    ("market", "operating"), ("advertis", "operating"), ("commission", "operating"),
    ("software", "operating"), ("subscription", "operating"),

    ("misc", "admin"), ("other", "admin"), ("bank charge", "admin"),
    ("account", "admin"), ("legal", "admin"), ("audit", "admin"),
]


def guess_group(name: str) -> str:
    """Best guess at a category's P&L group from its name.

    Only ever a starting point: the owner can retag anything, and their
    choice is what the P&L uses. Longest rule wins so that a specific
    phrase beats a generic word contained in it. Anything unrecognised
    falls to running costs rather than "other": running costs carry a wide
    healthy band, so a misfiled rupee there stays quiet, whereas "other"
    is banded at 1-3% and would cry wolf over every unknown name.
    """
    text = (name or "").strip().lower()
    best, best_len = "operating", 0
    for needle, group in _RULES:
        if needle in text and len(needle) > best_len:
            best, best_len = group, len(needle)
    return best
