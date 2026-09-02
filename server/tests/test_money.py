"""Money conversion is the one place rupees become paise.

Guards two things that used to be wrong: 3-decimal input rounded down
(0.145 -> 14 paise), and NaN/junk amounts crashing int() as a 500.
"""
import pytest
from fastapi import HTTPException

from app.util import paise


def test_two_decimal_rupees_are_exact():
    for cents in range(0, 100000, 7):
        assert paise(f"{cents / 100:.2f}") == cents


def test_half_paise_rounds_up_not_down():
    assert paise("0.145") == 15
    assert paise("1.005") == 101
    assert paise(1234.565) == 123457


def test_blank_amounts_are_zero():
    assert paise(None) == 0
    assert paise("") == 0
    assert paise(0) == 0


@pytest.mark.parametrize("bad", ["nan", "inf", "-inf", float("nan"),
                                 float("inf"), "abc", "12,000"])
def test_unusable_amounts_are_rejected_not_crashed(bad):
    with pytest.raises(HTTPException) as err:
        paise(bad)
    assert err.value.status_code == 422


def test_negative_amounts_survive_round_trip():
    assert paise("-45.50") == -4550
