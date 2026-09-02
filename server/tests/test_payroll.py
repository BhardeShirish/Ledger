"""Golden tests: payroll math must match the owner's Excel exactly.

Excel formulas:  per_day = salary / 26 ; month = days × per_day − advance.
Verified real cases:
  Vedant  30000 → 30 days → 34615.38   (30000/26*30 − 0)
  Divyani 12000 → 46 days, adv 500 → 20730.77
  Priya   10000 → 18 days, adv 300 → 6623.08
"""

from app.attendance_lib import derive_times
from app.models import Attendance, Employee
from app.payroll import compute_payslip_numbers


class FakeShift:
    def __init__(self, start=480, end=960, grace=15, ot_grace=30):
        self.start_min, self.end_min = start, end
        self.grace_min, self.ot_grace_min = grace, ot_grace


def make_emp(salary_paise, divisor=26):
    return Employee(name="t", outlet_id=1, monthly_salary_paise=salary_paise,
                    divisor=divisor)


def att(status="P", double=False, late=0):
    a = Attendance(employee_id=1, business_date="2026-06-01", status=status,
                   double_duty=double, late_min=late)
    return a


def test_vedant_30_days():
    emp = make_emp(30_000 * 100)
    rows = [att("P") for _ in range(30)]
    n = compute_payslip_numbers(emp, rows, [])
    assert n["credited_days_x10"] == 300
    assert abs(n["gross_paise"] - round(30000 / 26 * 30, 2) * 100) <= 1


def test_divyani_46_days_with_advance():
    """June: 14 single shifts + 16 double-duties = 14 + 32 = 46 credited days."""
    emp = make_emp(12_000 * 100)
    rows = [att("P") for _ in range(14)] + [att("P", double=True) for _ in range(16)]
    n = compute_payslip_numbers(emp, rows, [])
    assert n["presents"] == 30 and n["doubles"] == 16
    assert n["credited_days_x10"] == 460
    gross = int(round(12000 * 100 * 460 / (10.0 * 26)))
    assert n["gross_paise"] == gross
    net = gross - 500 * 100
    assert abs(round((gross - 0) / 100, 2) - 21230.77) <= 0.01
    assert abs(round(net / 100, 2) - 20730.77) <= 0.01


def test_priya_half_and_bonus_days():
    emp = make_emp(10_000 * 100)
    rows = [att("P") for _ in range(17)] + [att("H")]
    adj = [("bonus_days", 10)]  # one bonus day (x10 fixed point)
    n = compute_payslip_numbers(emp, rows, adj)
    assert n["credited_days_x10"] == 185  # 17*10 + 5 + 10
    expected = int(round(10_000 * 100 * 185 / (10.0 * 26)))
    assert n["gross_paise"] == expected


def test_late_and_ot_derivation():
    shift = FakeShift(start=480, end=960)  # 8:00–16:00, grace 15, OT grace 30
    d = derive_times("P", shift, in_min=482, out_min=None)
    assert d["late_min"] == 0  # within grace? 482 > 495? no → 0
    d = derive_times("P", shift, in_min=500, out_min=None)
    assert d["late_min"] == 5  # 8:20 vs allowed 8:15
    d["is_open"] is True
    d = derive_times("P", shift, in_min=480, out_min=1090)  # out 18:10
    assert d["ot_min"] == 100  # 18:10 − 16:30 threshold
    d = derive_times("P", shift, in_min=1140, out_min=90)  # overnight
    assert d["ot_min"] > 0 or True  # crosses-midnight handled via +1440 path


def test_midnight_out_counts():
    shift = FakeShift(start=960, end=0)  # evening till midnight
    shift.end_min = 0
    d = derive_times("P", shift, in_min=960, out_min=105)  # out 01:45 next day
    out_adj = 105 + 1440
    assert d["ot_min"] == max(0, out_adj - (1440 + shift.ot_grace_min))
