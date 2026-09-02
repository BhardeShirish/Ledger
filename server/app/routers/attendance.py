from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..audit import audit, check_edit_window
from ..attendance_lib import absent_days, credited_days_x10, derive_times, resolve_shift
from ..db import get_db
from ..models import Attendance, Employee, ShiftPattern, User
from ..security import current_user
from .helpers import assert_outlet_access
from .staff import _shift_serialize

router = APIRouter(prefix="/attendance", tags=["attendance"])


class EntryIn(BaseModel):
    employee_id: int
    status: str = "P"            # P H A L WO
    in_time: str | None = None   # "08:12" or "812"
    out_time: str | None = None
    double_duty: bool = False
    shift_id: int | None = None  # which shift they actually worked (overrides roster)
    note: str = ""


class BulkIn(BaseModel):
    outlet_id: int
    date: str
    entries: list[EntryIn] = []
    fill_scheduled_for_rest: bool = False


class MarkIn(EntryIn):
    date: str


def _to_min(s):
    from ..util import hhmm_to_min
    return hhmm_to_min(s)


def _day_end_min(db: Session, emp: Employee) -> int | None:
    """End of the outlet's last shift — where a double duty finishes."""
    from ..models import Shift as ShiftM
    ends = [s.end_min for s in db.query(ShiftM).filter(
        ShiftM.is_active == True,  # noqa: E712
        (ShiftM.outlet_id == emp.outlet_id) | (ShiftM.outlet_id.is_(None)))]
    return max(ends) if ends else None


def _upsert(db: Session, emp: Employee, d: str, e: EntryIn, user_id: int,
            shift) -> dict:
    if e.status not in ("P", "H", "A", "L", "WO"):
        raise HTTPException(422, f"Bad status {e.status}")
    # explicit per-day shift choice wins over the roster resolution
    if e.shift_id:
        from ..models import Shift as ShiftM
        # Scoped like _day_end_min: a shift from another outlet would silently
        # rewrite this day's late/OT minutes and therefore its pay. Inactive
        # shifts stay usable so old days can still be corrected.
        chosen = db.query(ShiftM).filter(
            ShiftM.id == e.shift_id,
            (ShiftM.outlet_id == emp.outlet_id) | (ShiftM.outlet_id.is_(None)),
        ).first()
        if chosen is None:
            raise HTTPException(422, "That shift does not belong to this outlet")
        shift = chosen
    row = db.query(Attendance).filter_by(employee_id=emp.id, business_date=d).first()
    if row is None:
        row = Attendance(employee_id=emp.id, business_date=d)
        db.add(row)
    row.status = e.status
    row.shift_id = None if shift in (None, "off") else shift.id
    row.in_min = _to_min(e.in_time)
    row.out_min = _to_min(e.out_time)
    if e.status not in ("P", "H", "A"):
        row.double_duty = False
    else:
        # A double absent means both shifts were missed.
        row.double_duty = bool(e.double_duty)
    row.note = e.note
    row.marked_by = user_id
    derived = derive_times(e.status, shift, row.in_min, row.out_min,
                           row.double_duty, _day_end_min(db, emp))
    row.late_min = derived["late_min"]
    row.ot_min = derived["ot_min"]
    row.is_open = derived["is_open"]
    row.source = "manual"
    return _serialize_row(row, shift)


def _serialize_row(row: Attendance, shift) -> dict:
    return {
        "employee_id": row.employee_id, "date": row.business_date,
        "status": row.status, "shift": None if shift in (None, "off") else _shift_serialize(shift),
        # The screen needs the id on its own: it is what tells a day that was
        # deliberately moved to another shift apart from one merely following
        # the roster. Without it the grid re-guesses and the edit looks lost.
        "shift_id": row.shift_id,
        "in_min": row.in_min, "out_min": row.out_min,
        "late_min": row.late_min, "ot_min": row.ot_min,
        "double_duty": row.double_duty, "is_open": row.is_open,
        "note": row.note, "source": row.source,
    }


@router.get("/grid")
def grid(outlet_id: int, start: str, end: str | None = None,
         user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Roster grid for a date range (≤31 days): employees × days with resolved shifts."""
    assert_outlet_access(db, user, outlet_id)
    s = date.fromisoformat(start)
    e = date.fromisoformat(end or start)
    if (e - s).days > 62:
        raise HTTPException(422, "Range too long")
    emps = (db.query(Employee)
              .filter(Employee.outlet_id == outlet_id,
                      Employee.working_status != "left",
                      Employee.is_active == True)  # noqa: E712
              .order_by(Employee.name).all())
    ids = [x.id for x in emps]
    rows = (db.query(Attendance)
              .filter(Attendance.employee_id.in_(ids),
                      Attendance.business_date >= start,
                      Attendance.business_date <= end).all()) if ids else []
    by_key = {(r.employee_id, r.business_date): r for r in rows}
    days = [(s + timedelta(days=i)) for i in range((e - s).days + 1)]

    emp_list = []
    for emp in emps:
        pattern = {p.dow: p.shift_id for p in
                   db.query(ShiftPattern).filter_by(employee_id=emp.id)}
        cells = []
        for d in days:
            key = (emp.id, d.isoformat())
            row = by_key.get(key)
            shift = resolve_shift(db, emp, d)
            off_day = (shift == "off") or (emp.off_dow is not None and d.weekday() == emp.off_dow)
            cells.append({
                "date": d.isoformat(), "dow": d.weekday(),
                "off_day": bool(off_day),
                "shift_name": "-" if shift == "off" else getattr(shift, "name", "-"),
                "scheduled_in": "-" if shift in (None, "off") else
                f"{getattr(shift,'start_min',0)//60:02d}:{getattr(shift,'start_min',0)%60:02d}",
                "row": _serialize_row(row, shift) if row else None,
            })
        emp_list.append({
            "id": emp.id, "name": emp.name, "designation": emp.designation,
            "backup_employee_id": emp.backup_employee_id,
            "pref_off_dow": emp.pref_off_dow, "off_dow": emp.off_dow,
            "cells": cells,
        })
    return {"start": start, "end": e.isoformat(), "employees": emp_list}


@router.post("/mark")
def mark(body: MarkIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    emp = db.get(Employee, body.employee_id)
    if emp is None:
        raise HTTPException(404, "Employee not found")
    assert_outlet_access(db, user, emp.outlet_id)
    check_edit_window(body.date, user, db, no_future=True)
    d = date.fromisoformat(body.date)
    shift = resolve_shift(db, emp, d)
    # MarkIn extends EntryIn, so hand it over whole. Rebuilding it field by
    # field is how shift_id got silently dropped here once already.
    data = _upsert(db, emp, body.date, body, user.id, shift)
    audit(db, None, user.id, "mark", "attendance",
          f"{body.employee_id}@{body.date}", after={"status": body.status})
    db.commit()
    return data


@router.post("/bulk")
def bulk(body: BulkIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    check_edit_window(body.date, user, db, no_future=True)
    emps = (db.query(Employee)
              .filter(Employee.outlet_id == body.outlet_id,
                      Employee.working_status != "left",
                      Employee.is_active == True)  # noqa: E712)
              .all())
    by_id = {e.id: e for e in emps}
    handled = set()
    out = []
    d = date.fromisoformat(body.date)
    for entry in body.entries:
        emp = by_id.get(entry.employee_id)
        if emp is None:
            # Saying nothing here loses the mark: the screen clears its unsaved
            # edits as soon as the save reports success.
            raise HTTPException(404, f"Employee {entry.employee_id} is not on "
                                     "this outlet's active roster")
        shift = resolve_shift(db, emp, d)
        out.append(_upsert(db, emp, body.date, entry, user.id, shift))
        handled.add(emp.id)
    if body.fill_scheduled_for_rest:
        for emp in emps:
            if emp.id in handled:
                continue
            shift = resolve_shift(db, emp, d)
            if shift in (None, "off"):
                continue
            entry = EntryIn(employee_id=emp.id, status="P",
                            in_time=f"{shift.start_min // 60:02d}:{shift.start_min % 60:02d}",
                            out_time=f"{shift.end_min // 60:02d}:{shift.end_min % 60:02d}")
            out.append(_upsert(db, emp, body.date, entry, user.id, shift, ))
    audit(db, None, user.id, "bulk-mark", "attendance", body.date,
          note=f"{len(body.entries)} entries, outlet {body.outlet_id}")
    db.commit()
    return {"saved": len(out), "rows": out}


@router.get("/month-summary")
def month_summary(employee_id: int, year: int, month: int,
                  user: User = Depends(current_user), db: Session = Depends(get_db)):
    from ..util import month_bounds
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise HTTPException(404, "Employee not found")
    assert_outlet_access(db, user, employee.outlet_id)
    lo, hi = month_bounds(year, month)
    rows = (db.query(Attendance)
              .filter(Attendance.employee_id == employee_id,
                      Attendance.business_date >= lo.isoformat(),
                      Attendance.business_date <= hi.isoformat()).all())
    presents = sum(1 for r in rows if r.status == "P")
    halves = sum(1 for r in rows if r.status == "H")
    doubles = sum(1 for r in rows if r.double_duty and r.status in ("P", "H"))
    absents = sum(absent_days(r) for r in rows)
    offs = sum(1 for r in rows if r.status == "WO")
    credit_x10 = sum(credited_days_x10(r) for r in rows)
    return {
        "presents": presents, "halves": halves, "doubles": doubles,
        "absents": absents, "offs": offs, "credited_days": credit_x10 / 10.0,
        "open_rows": [r.business_date for r in rows if r.is_open],
    }


@router.get("/month-overview")
def month_overview(outlet_id: int, year: int, month: int,
                   user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Per-staff month tally incl. OFF days — shown under the week grid."""
    from datetime import date as D

    from ..util import month_bounds, now_local
    assert_outlet_access(db, user, outlet_id)
    lo, hi = month_bounds(year, month)
    today = now_local().date()
    if hi > today:
        hi = today
    emps = (db.query(Employee)
              .filter_by(outlet_id=outlet_id)
              .filter(Employee.working_status != "left",
                      Employee.is_active == True).all())  # noqa: E712
    ids = [e.id for e in emps]
    rows = (db.query(Attendance)
              .filter(Attendance.employee_id.in_(ids),
                      Attendance.business_date >= lo.isoformat(),
                      Attendance.business_date <= hi.isoformat()).all()) if ids else []
    by_emp: dict[int, list[Attendance]] = {}
    for r in rows:
        by_emp.setdefault(r.employee_id, []).append(r)

    out = []
    for e in emps:
        rs = by_emp.get(e.id, [])
        marked_offs = sum(1 for r in rs if r.status == "WO")
        # rostered off-days that already passed without any attendance row
        unmarked = 0
        d = lo
        while d <= hi:
            has_row = any(r.business_date == d.isoformat() for r in rs)
            if not has_row and e.off_dow is not None and d.weekday() == e.off_dow:
                unmarked += 1
            d = D.fromordinal(d.toordinal() + 1)
        credit_x10 = sum(credited_days_x10(r) for r in rs)
        out.append({
            "employee_id": e.id, "name": e.name,
            "presents": sum(1 for r in rs if r.status == "P"),
            "halves": sum(1 for r in rs if r.status == "H"),
            "doubles": sum(1 for r in rs if r.double_duty and r.status in ("P", "H")),
            "absents": sum(absent_days(r) for r in rs),
            "offs": marked_offs + unmarked,
            "credited_days": credit_x10 / 10.0,
        })
    return {"year": year, "month": month, "rows": out}
