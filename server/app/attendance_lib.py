"""Attendance engine: shift resolution, late/OT derivation, credited-days math.

All minutes are "minutes since midnight"; an out earlier than the in implies a
past-midnight shift end (+1440). Credited days use x10 fixed-point so halves
and double-duties stay exact.
"""
from datetime import date

from sqlalchemy.orm import Session

from .models import Attendance, Employee, ShiftOverride


def resolve_shift(db: Session, emp: Employee, d: date):
    """override > weekday pattern > default shift. Returns Shift|None ('off' when pattern says off)."""
    ov = db.query(ShiftOverride).filter_by(employee_id=emp.id, date=d.isoformat()).first()
    if ov is not None:
        return _shift_or_off(db, ov.shift_id)
    pat_row = _pattern_row(db, emp.id, d.weekday())
    if pat_row is not None or _has_pattern(db, emp.id):
        # an explicit pattern exists: its row (possibly NULL = off) wins over default
        return _shift_or_off(db, pat_row)
    # No roster at all. Someone whose default shift was never filled in is
    # unscheduled, not rostered off; calling it "off" makes the grid refuse to
    # mark them at all, every day, for ever.
    from .models import Shift
    return db.get(Shift, emp.default_shift_id) if emp.default_shift_id else None


def _has_pattern(db: Session, employee_id: int) -> bool:
    from .models import ShiftPattern
    return db.query(ShiftPattern).filter_by(employee_id=employee_id).count() > 0


def _pattern_row(db: Session, employee_id: int, dow: int):
    from .models import ShiftPattern
    r = db.get(ShiftPattern, (employee_id, dow))
    return None if r is None else r.shift_id


def _shift_or_off(db: Session, shift_id):
    from .models import Shift
    if shift_id is None:
        return "off"
    return db.get(Shift, shift_id)


def derive_times(status: str, shift, in_min: int | None, out_min: int | None,
                 double_duty: bool = False, double_end_min: int | None = None) -> dict:
    """Compute late/ot/open for one attendance row.

    An out earlier than the in means the shift crossed midnight; the effective
    shift end then also shifts +1440 so OT math stays sane.

    A double duty is already paid as a whole extra day, so the second shift is
    not also overtime: the effective end moves to the end of the later shift.
    """
    late = ot = 0
    if status in ("P", "H") and shift not in (None, "off"):
        if in_min is not None:
            late = max(0, in_min - (shift.start_min + shift.grace_min))
        if out_min is not None and in_min is not None:
            out_adj = out_min + 1440 if out_min < in_min else out_min
            end_adj = shift.end_min
            if double_duty and double_end_min is not None:
                end_adj = max(end_adj, double_end_min)
            if out_adj > 1440 and end_adj <= in_min:
                end_adj += 1440
            ot = max(0, out_adj - (end_adj + shift.ot_grace_min))
    is_open = status in ("P", "H") and in_min is not None and out_min is None
    return {"late_min": late, "ot_min": ot, "is_open": is_open}


def credited_days_x10(a: Attendance) -> int:
    base = {"P": 10, "H": 5}.get(a.status, 0)
    # Only a worked double earns the extra day. Without this guard an "absent
    # twice" row would credit a full day's pay for not turning up.
    extra = 10 if a.double_duty and a.status in ("P", "H") else 0
    return base + extra


def absent_days(a: Attendance) -> int:
    """Days missed. A double absent missed both shifts, so it counts as two."""
    if a.status != "A":
        return 0
    return 2 if a.double_duty else 1


def worked_minutes(a: Attendance) -> int | None:
    """Actual clocked minutes, preserving overnight shifts and missing clocks."""
    if a.status not in ("P", "H") or a.in_min is None or a.out_min is None:
        return None
    return a.out_min - a.in_min if a.out_min >= a.in_min else a.out_min + 1440 - a.in_min


def month_credit_totals(rows: list[Attendance]) -> dict:
    presents = sum(1 for r in rows if r.status == "P")
    halves = sum(1 for r in rows if r.status == "H")
    doubles = sum(1 for r in rows if r.double_duty and r.status in ("P", "H"))
    absents = sum(absent_days(r) for r in rows)
    lates = sum(1 for r in rows if r.late_min > 0)
    credit_x10 = sum(credited_days_x10(r) for r in rows)
    return {
        "presents": presents, "halves": halves, "doubles": doubles,
        "absents": absents, "lates_count": lates,
        "credited_days_x10": credit_x10,
    }
