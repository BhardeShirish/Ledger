from datetime import date

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from sqlalchemy import func

from ..audit import audit, check_edit_window
from ..attendance_lib import resolve_shift
from ..db import get_db
from ..models import Employee, Shift, ShiftOverride, ShiftPattern, User
from ..security import current_user, require_owner
from ..util import paise, read_sheet_rows
from .helpers import assert_outlet_access, mask_salary

router = APIRouter(prefix="/staff", tags=["staff"])


class EmployeeIn(BaseModel):
    name: str
    code: str = ""
    phone: str = ""
    designation: str = ""
    outlet_id: int
    default_shift_id: int | None = None
    monthly_salary_rupees: float | None = None
    divisor: int | None = None
    join_date: str | None = None
    exit_date: str | None = None
    working_status: str = "active"
    pref_off_dow: int | None = None
    off_dow: int | None = None
    backup_employee_id: int | None = None
    upi_id: str = ""
    notes: str = ""
    pattern: list[dict] | None = None  # [{dow, shift_id|null}]


def _serialize(db: Session, e: Employee, role: str) -> dict:
    data = {
        "id": e.id, "code": e.code, "name": e.name, "phone": e.phone,
        "designation": e.designation, "outlet_id": e.outlet_id,
        "default_shift_id": e.default_shift_id,
        "join_date": e.join_date, "exit_date": e.exit_date,
        "working_status": e.working_status,
        "pref_off_dow": e.pref_off_dow, "off_dow": e.off_dow,
        "backup_employee_id": e.backup_employee_id,
        "upi_id": e.upi_id, "notes": e.notes, "is_active": e.is_active,
        "pattern": [
            {"dow": p.dow, "shift_id": p.shift_id}
            for p in db.query(ShiftPattern).filter_by(employee_id=e.id)
        ],
    }
    if role == "owner":
        data["monthly_salary_paise"] = e.monthly_salary_paise
        data["monthly_salary_rupees"] = round(e.monthly_salary_paise / 100, 2)
        data["divisor"] = e.divisor
        data["per_day_rupees"] = round(e.monthly_salary_paise / (e.divisor or 26) / 100, 2)
        # KYC — never leaves the server for managers
        data["aadhaar_no"] = e.aadhaar_no or ""
        data["pan_no"] = e.pan_no or ""
        data["aadhaar_doc_path"] = e.aadhaar_doc_path
        data["pan_doc_path"] = e.pan_doc_path
    return mask_salary(role, data)


@router.get("/employees")
def list_employees(outlet_id: int | None = None, include_inactive: bool = False,
                   user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = db.query(Employee)
    if not include_inactive:
        q = q.filter(Employee.working_status != "left")
    if outlet_id is not None:
        assert_outlet_access(db, user, outlet_id)
        q = q.filter(Employee.outlet_id == outlet_id)
    elif user.role == "manager":
        from .helpers import user_outlet_ids
        ids = user_outlet_ids(db, user)
        q = q.filter(Employee.outlet_id.in_(ids))
    rows = q.order_by(Employee.name).all()
    return [_serialize(db, e, user.role) for e in rows]


@router.get("/employees/{emp_id}")
def get_employee(emp_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    e = db.get(Employee, emp_id)
    if e is None:
        raise HTTPException(404, "Employee not found")
    assert_outlet_access(db, user, e.outlet_id)
    return _serialize(db, e, user.role)


@router.post("/employees", status_code=201)
def create_employee(body: EmployeeIn, user: User = Depends(require_owner),
                    db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    from ..audit import get_setting_db

    e = Employee(
        name=body.name.strip(), code=body.code, phone=body.phone,
        designation=body.designation, outlet_id=body.outlet_id,
        default_shift_id=body.default_shift_id,
        monthly_salary_paise=int(round((body.monthly_salary_rupees or 0) * 100)),
        divisor=max(1, body.divisor or int(
            get_setting_db(db, "salary_divisor_default", 26))),
        join_date=body.join_date, exit_date=body.exit_date,
        working_status=body.working_status,
        pref_off_dow=body.pref_off_dow, off_dow=body.off_dow,
        backup_employee_id=body.backup_employee_id, upi_id=body.upi_id,
        notes=body.notes,
    )
    db.add(e)
    db.flush()
    if body.pattern is not None:
        _save_pattern(db, e.id, body.pattern)
    audit(db, None, user.id, "create", "employee", e.id, after={"name": e.name})
    db.commit()
    return _serialize(db, e, "owner")


@router.patch("/employees/{emp_id}")
async def update_employee(emp_id: int, body: dict, user: User = Depends(require_owner),
                          db: Session = Depends(get_db)):
    e = db.get(Employee, emp_id)
    if e is None:
        raise HTTPException(404, "Employee not found")
    check_edit_window(e.join_date, user, db)  # profile changes are not dated; window n/a
    fields = {"name", "code", "phone", "designation", "default_shift_id", "divisor",
              "join_date", "exit_date", "working_status", "pref_off_dow", "off_dow",
              "backup_employee_id", "upi_id", "notes"}
    for k in fields:
        if k in body:
            setattr(e, k, body[k])
    if "monthly_salary_rupees" in body and body["monthly_salary_rupees"] is not None:
        e.monthly_salary_paise = paise(body["monthly_salary_rupees"])
    if "pattern" in body and body["pattern"] is not None:
        _save_pattern(db, e.id, body["pattern"])
    audit(db, None, user.id, "update", "employee", e.id, after={k: body.get(k) for k in body})
    db.commit()
    return _serialize(db, e, "owner")


def _save_pattern(db: Session, emp_id: int, pattern: list[dict]) -> None:
    db.query(ShiftPattern).filter_by(employee_id=emp_id).delete()
    for item in pattern:
        dow = item.get("dow")
        if dow is None or not (0 <= int(dow) <= 6):
            continue
        db.add(ShiftPattern(employee_id=emp_id, dow=int(dow),
                            shift_id=item.get("shift_id")))


KYC_PATCH_FIELDS = {"aadhaar_no", "pan_no"}


@router.patch("/employees/{emp_id}/kyc")
def update_kyc(emp_id: int, body: dict, user: User = Depends(require_owner),
               db: Session = Depends(get_db)):
    e = db.get(Employee, emp_id)
    if e is None:
        raise HTTPException(404, "Employee not found")
    changed = {}
    for k in KYC_PATCH_FIELDS | {"aadhaar_doc_path", "pan_doc_path"}:
        if k in body:
            setattr(e, k, body[k])
            changed[k] = bool(body[k])
    audit(db, None, user.id, "kyc-update", "employee", e.id, after=changed)
    db.commit()
    return _serialize(db, e, "owner")


@router.post("/employees/{emp_id}/doc/{kind}")
async def upload_doc(emp_id: int, kind: str, file: UploadFile,
                     user: User = Depends(require_owner), db: Session = Depends(get_db)):
    """Attach an Aadhaar/PAN image. Stored under uploads/docs/, served to owner only."""
    import uuid
    from pathlib import Path as _Path

    from ..config import UPLOAD_DIR
    from fastapi import HTTPException as _HX

    if kind not in ("aadhaar", "pan"):
        raise _HX(422, "kind must be aadhaar or pan")
    e = db.get(Employee, emp_id)
    if e is None:
        raise _HX(404, "Employee not found")
    ext = _Path(file.filename or "").suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp", ".pdf"}:
        raise _HX(422, f"File type {ext} not allowed")
    docs_dir = UPLOAD_DIR / "docs"
    docs_dir.mkdir(exist_ok=True)
    name = f"{emp_id}-{kind}-{uuid.uuid4().hex[:8]}{ext}"
    size = 0
    with (docs_dir / name).open("wb") as out:
        while chunk := await file.read(512 * 1024):
            size += len(chunk)
            if size > 8 * 1024 * 1024:
                (docs_dir / name).unlink(missing_ok=True)
                raise _HX(413, "Document larger than 8 MB")
            out.write(chunk)
    path = f"/api/staff/doc/{name}"
    if kind == "aadhaar":
        e.aadhaar_doc_path = path
    else:
        e.pan_doc_path = path
    audit(db, None, user.id, "doc-upload", "employee", e.id,
          after={"kind": kind})
    db.commit()
    return {"path": path}


@router.get("/doc/{name}")
def get_doc(name: str, user: User = Depends(require_owner)):
    """ID documents are owner-only; no manager, ever."""
    from pathlib import Path as _Path

    from ..config import UPLOAD_DIR
    from fastapi.responses import FileResponse as _FR

    safe = _Path(name).name
    p = UPLOAD_DIR / "docs" / safe
    if not p.exists():
        raise HTTPException(404, "Not found")
    media = "application/pdf" if p.suffix == ".pdf" else f"image/{p.suffix.lstrip('.')}"
    return _FR(p, media_type=media)


class DivisorIn(BaseModel):
    divisor: int
    apply_to_all: bool = False


@router.post("/set-divisor")
def set_divisor(body: DivisorIn, user: User = Depends(require_owner),
                db: Session = Depends(get_db)):
    """Change the salary ÷ divisor rule — optionally for every active employee."""
    from ..audit import set_setting_db

    if not 1 <= body.divisor <= 60:
        raise HTTPException(422, "Divisor must be between 1 and 60")
    set_setting_db(db, "salary_divisor_default", body.divisor, user.id)
    changed = 0
    if body.apply_to_all:
        for e in db.query(Employee).filter(Employee.working_status != "left").all():
            e.divisor = body.divisor
            changed += 1
    audit(db, None, user.id, "set-divisor", "settings", "salary_divisor_default",
          after={"divisor": body.divisor, "applied_to": changed})
    db.commit()
    return {"ok": True, "employees_updated": changed}


# ── One-time Employees.xlsx import ───────────────────────────────────────

DOW_BY_NAME = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
               "friday": 4, "saturday": 5, "sunday": 6}


@router.post("/import-sheet")
async def import_sheet(file: UploadFile, outlet_id: int, confirm: bool = False,
                       user: User = Depends(require_owner),
                       db: Session = Depends(get_db)):
    """Bulk-import staff from the owner's salary workbook.

    Expected columns: Emp Id, Employee Name, Phone No, Working Status,
    Off Day (preffered), Off Day, Backup, Designation, Monthly Salary.
    Historical month tallies are ignored — attendance starts fresh here.
    Re-running is safe: existing names are updated, new names are created.
    """
    assert_outlet_access(db, user, outlet_id)
    raw = await file.read(10 * 1024 * 1024 + 1)
    if len(raw) > 10 * 1024 * 1024:
        raise HTTPException(413, "Staff workbook is larger than 10 MB")
    rows = read_sheet_rows(raw, max_rows=10_000, max_cols=100,
                           label="Staff workbook")

    header_i = None
    wanted = {"employee name"}
    for i, r in enumerate(rows[:10]):
        cells = {str(c or "").strip().lower() for c in r}
        if wanted.issubset(cells):
            header_i = i
            break
    if header_i is None:
        raise HTTPException(422, "Couldn't find an 'Employee Name' column — is this the salary workbook?")

    hdr = [str(c or "").strip().lower() for c in rows[header_i]]
    idx = {h: j for j, h in enumerate(hdr)}

    def cell(r, *names, default=None):
        for n in names:
            j = idx.get(n)
            if j is not None and j < len(r) and r[j] not in (None, ""):
                return r[j]
        return default

    parsed = []
    for r in rows[header_i + 1:]:
        emp_id_raw = cell(r, "emp id")
        name = str(cell(r, "employee name", default="") or "").strip()
        if not name:
            continue
        try:
            float(emp_id_raw)          # summary/label rows fail this and get skipped
        except (TypeError, ValueError):
            continue
        phone = str(cell(r, "phone no") or "")
        phone = phone.split(".")[0].strip() if "." in phone else phone.strip()
        status = str(cell(r, "working status") or "").strip().lower()

        def dow_of(*names):
            v = str(cell(r, *names) or "").strip().lower()
            return DOW_BY_NAME.get(v) if v != "any" else None

        parsed.append({
            "code": str(emp_id_raw).split(".")[0],
            "name": name,
            "phone": phone,
            "working_status": "left" if status == "no" else "active",
            "pref_off_dow": dow_of("off day (preffered)", "off day (preferred)", "off day preffered"),
            "off_dow": dow_of("off day"),
            "backup_name": str(cell(r, "backup") or "").strip() or None,
            "designation": str(cell(r, "designation") or "").strip(),
            "salary_paise": paise(cell(r, "monthly salary") or 0),
        })

    existing_names = {
        employee.name.lower()
        for employee in db.query(Employee).filter_by(outlet_id=outlet_id).all()
    }
    preview_created = sum(p["name"].lower() not in existing_names for p in parsed)
    preview_updated = len(parsed) - preview_created
    if not confirm:
        return {
            "created": preview_created, "updated": preview_updated,
            "backups_linked": sum(bool(p["backup_name"]) for p in parsed),
            "errors": [], "names": [p["name"] for p in parsed],
            "committed": False,
        }

    created = updated = 0
    errors = []
    made = {}
    for p in parsed:
        try:
            e = db.query(Employee).filter(
                Employee.outlet_id == outlet_id,
                func.lower(Employee.name) == p["name"].lower()).first()
            if e is None:
                e = Employee(code=p["code"], name=p["name"],
                             outlet_id=outlet_id)
                db.add(e)
                db.flush()
                created += 1
            else:
                updated += 1
            e.phone = p["phone"] or e.phone
            e.working_status = p["working_status"]
            e.pref_off_dow = p["pref_off_dow"]
            e.off_dow = p["off_dow"]
            e.designation = p["designation"] or e.designation
            if p["salary_paise"]:
                e.monthly_salary_paise = p["salary_paise"]
            e.divisor = e.divisor or 26
            made[p["name"].lower()] = e
        except Exception as ex:                      # noqa: BLE001
            errors.append({"name": p["name"], "error": str(ex)[:120]})
    db.flush()

    # second pass: link backup colleagues once everyone exists
    linked = 0
    for p in parsed:
        e = made.get(p["name"].lower())
        if e is None or not p["backup_name"]:
            continue
        b = made.get(p["backup_name"].lower())
        if b is not None and b.id != e.id:
            e.backup_employee_id = b.id
            linked += 1

    audit(db, None, user.id, "sheet-import", "employees", "",
          after={"created": created, "updated": updated})
    db.commit()
    return {
        "created": created, "updated": updated,
        "backups_linked": linked,
        "errors": errors,
        "names": [p["name"] for p in parsed],
        "committed": True,
    }
# ── Shift master ─────────────────────────────────────────────────────────

class ShiftIn(BaseModel):
    name: str
    start: str   # "08:00"
    end: str     # "16:00"
    crosses_midnight: bool = False
    grace_min: int = 15
    ot_grace_min: int = 30
    outlet_id: int | None = None


def hhmm(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def _shift_serialize(s: Shift) -> dict:
    return {
        "id": s.id, "name": s.name,
        "start_min": s.start_min, "end_min": s.end_min,
        "start": f"{s.start_min // 60:02d}:{s.start_min % 60:02d}",
        "end": f"{s.end_min // 60:02d}:{s.end_min % 60:02d}",
        "crosses_midnight": s.crosses_midnight,
        "grace_min": s.grace_min, "ot_grace_min": s.ot_grace_min,
        "outlet_id": s.outlet_id, "is_active": s.is_active,
    }


@router.get("/shifts")
def list_shifts(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return [_shift_serialize(s) for s in db.query(Shift)
            .filter_by(is_active=True).order_by(Shift.start_min).all()]


@router.post("/shifts", status_code=201)
def create_shift(body: ShiftIn, user: User = Depends(require_owner), db: Session = Depends(get_db)):
    s = Shift(name=body.name.strip(), start_min=hhmm(body.start), end_min=hhmm(body.end),
              crosses_midnight=body.crosses_midnight or hhmm(body.end) <= hhmm(body.start),
              grace_min=body.grace_min, ot_grace_min=body.ot_grace_min,
              outlet_id=body.outlet_id)
    db.add(s)
    db.commit()
    return _shift_serialize(s)


@router.patch("/shifts/{shift_id}")
def update_shift(shift_id: int, body: ShiftIn, user: User = Depends(require_owner),
                 db: Session = Depends(get_db)):
    s = db.get(Shift, shift_id)
    if s is None:
        raise HTTPException(404, "Shift not found")
    s.name = body.name.strip()
    s.start_min = hhmm(body.start)
    s.end_min = hhmm(body.end)
    s.crosses_midnight = body.crosses_midnight or hhmm(body.end) <= hhmm(body.start)
    s.grace_min = body.grace_min
    s.ot_grace_min = body.ot_grace_min
    s.outlet_id = body.outlet_id
    db.commit()
    return _shift_serialize(s)


@router.delete("/shifts/{shift_id}")
def deactivate_shift(shift_id: int, user: User = Depends(require_owner),
                     db: Session = Depends(get_db)):
    s = db.get(Shift, shift_id)
    if s is None:
        raise HTTPException(404, "Shift not found")
    s.is_active = False
    db.commit()
    return {"ok": True}


# ── Overrides ────────────────────────────────────────────────────────────

class OverrideIn(BaseModel):
    employee_id: int
    date: str
    shift_id: int | None = None


@router.post("/override")
def set_override(body: OverrideIn, user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    e = db.get(Employee, body.employee_id)
    if e is None:
        raise HTTPException(404, "Employee not found")
    assert_outlet_access(db, user, e.outlet_id)
    check_edit_window(body.date, user, db)
    ov = db.query(ShiftOverride).filter_by(employee_id=body.employee_id, date=body.date).first()
    if ov is None:
        ov = ShiftOverride(employee_id=body.employee_id, date=body.date)
        db.add(ov)
    ov.shift_id = body.shift_id
    db.commit()
    d = date.fromisoformat(body.date)
    resolved = resolve_shift(db, e, d)
    return {"ok": True,
            "resolved": "off" if resolved == "off" else _shift_serialize(resolved)}
