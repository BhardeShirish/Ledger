"""Which line of the P&L a purchase belongs on.

The rules decide whether a shop's rent lands under occupancy or gets
buried in "other", so they are worth checking one name at a time —
including the Indian names an owner actually types.
"""
import pytest

from app.costgroups import COGS_GROUPS, GROUPS, PRIME_GROUPS, guess_group


@pytest.mark.parametrize("name,group", [
    # the four categories this shop has actually used
    ("Groceries", "cogs_food"),
    ("Raw Material", "cogs_food"),
    ("Vegetables & Fruits", "cogs_food"),
    ("Dairy", "cogs_food"),
    # the rest of the seeded list
    ("Rent", "occupancy"),
    ("Electricity", "operating"),
    ("Gas", "operating"),
    ("Salaries", "labour"),
    ("Staff Welfare", "labour"),
    ("Repairs & Maintenance", "operating"),
    ("Marketing", "operating"),
    ("Cleaning & Housekeeping", "operating"),
    ("Accounting", "admin"),
    ("Licenses & Fees", "occupancy"),
    # the words an Indian kitchen actually writes
    ("Sabzi", "cogs_food"),
    ("Paneer", "cogs_food"),
    ("Dahi", "cogs_food"),
    ("Atta", "cogs_food"),
    ("Dal", "cogs_food"),
    ("Masala", "cogs_food"),
    ("Chai patti", "cogs_bev"),
    ("Coffee beans", "cogs_bev"),
    ("Cold drinks", "cogs_bev"),
])
def test_names_land_on_the_right_line(name, group):
    assert guess_group(name) == group, name


def test_water_the_utility_is_not_water_the_stock():
    """A bare water bill is a running cost; bottled water is stock you
    sell, and mixing the two moves real money onto the wrong line."""
    assert guess_group("Water") == "operating"
    assert guess_group("Mineral Water") == "cogs_bev"
    assert guess_group("Drinking Water") == "cogs_bev"


def test_unknown_names_fall_to_operating_not_to_food():
    """Guessing food would quietly inflate the one ratio owners judge
    themselves on. Operating is the honest dustbin."""
    assert guess_group("Sundry") == "operating"
    assert guess_group("") == "operating"
    assert guess_group("Zzzz") == "operating"


def test_matching_ignores_case_and_padding():
    assert guess_group("  RENT  ") == "occupancy"
    assert guess_group("rEnT") == "occupancy"


def test_longest_match_wins():
    """'Staff Food' contains 'food' and 'staff'. Staff food is a labour
    cost; scoring it as food would flatter the wage bill."""
    assert guess_group("Staff Food") == "labour"


def test_every_group_key_has_a_label_and_a_blurb():
    for key, val in GROUPS.items():
        label, blurb = val
        assert label and blurb, key


def test_prime_is_cogs_plus_labour():
    assert set(PRIME_GROUPS) == set(COGS_GROUPS) | {"labour"}


def test_guessed_groups_are_all_real_groups():
    for name in ("Rent", "Sabzi", "Coffee", "Accounting", "Nonsense"):
        assert guess_group(name) in GROUPS
