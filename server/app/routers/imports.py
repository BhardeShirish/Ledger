"""Petpooja import flow: upload → validate → preview → commit (owner)."""
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..audit import audit
from ..db import get_db
from ..importer import commit as importer_commit
from ..importer import parse as importer_parse
from ..models import ImportBatch, SalesItem, User
from ..periods import assert_dates_open
from ..security import require_owner, require_stepup

router = APIRouter(prefix="/imports", tags=["imports"])


@router.post("/upload")
async def upload(file: UploadFile, outlet_id: int,
                 user: User = Depends(require_owner), db: Session = Depends(get_db)):
    """Validate-only pass; nothing touches sales tables until /commit.
    Orders-Master → bill rows; Item-wise → sales_items rows."""
    raw = await file.read(25 * 1024 * 1024 + 1)
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(413, "Import file is larger than 25 MB")
    try:
        parsed = importer_parse(raw, outlet_id)
    except ValueError as ex:
        raise HTTPException(422, str(ex))

    if parsed["report_kind"] == "item_wise":
        return await _upload_itemwise(raw, outlet_id, file.filename or
                                      "items.xlsx", user, db)

    batch = ImportBatch(
        outlet_id=outlet_id, filename=file.filename or "report.xlsx",
        report_kind=parsed["report_kind"], uploaded_by=user.id,
        rows_total=parsed["rows_total"], rows_ok=parsed["rows_ok"],
        rows_skipped=parsed["rows_skipped"],
        part_payments_unresolved=parsed["part_payments_unresolved"],
        status="validated")
    db.add(batch)
    db.flush()
    # stash parse result for commit: re-parse at commit keeps DB clean of blobs
    import json
    from ..config import DATA_DIR
    stash_dir = DATA_DIR / "imports"
    stash_dir.mkdir(exist_ok=True)
    (stash_dir / f"batch_{batch.id}.json").write_text(
        json.dumps(parsed, ensure_ascii=False), encoding="utf-8")
    dates = sorted({b["business_date"] for b in parsed["bills"]})
    db.commit()
    return {
        "batch_id": batch.id,
        "rows_ok": parsed["rows_ok"], "rows_skipped": parsed["rows_skipped"],
        "part_payments_unresolved": parsed["part_payments_unresolved"],
        "date_from": dates[0] if dates else None,
        "date_to": dates[-1] if dates else None,
        "meta": parsed["meta"],
        "preview": [
            {"date": k.split("|", 1)[0], "channel_kind": k.split("|", 1)[1],
             "bills": v["bills"], "total_rupees": round(v["total_paise"] / 100, 2)}
            for k, v in sorted(parsed["rollup"].items())[-14:]
        ],
    }


@router.post("/{batch_id}/commit")
def commit_batch(batch_id: int, user: User = Depends(require_stepup),
                 db: Session = Depends(get_db)):
    batch = db.get(ImportBatch, batch_id)
    if batch is None:
        raise HTTPException(404, "Batch not found")
    if batch.status != "validated":
        raise HTTPException(409, f"Batch is {batch.status}")
    import json
    from ..config import DATA_DIR
    stash = DATA_DIR / "imports" / f"batch_{batch.id}.json"
    if not stash.exists():
        raise HTTPException(410, "Staged file missing — upload again")
    claimed = (
        db.query(ImportBatch)
        .filter(ImportBatch.id == batch_id,
                ImportBatch.status == "validated")
        .update({ImportBatch.status: "committing"},
                synchronize_session=False)
    )
    if claimed != 1:
        raise HTTPException(409, "Batch is already being processed")
    db.commit()
    parsed = json.loads(stash.read_text(encoding="utf-8"))
    batch = db.get(ImportBatch, batch_id)
    try:
        imported_dates = {
            row["business_date"] for row in (
                parsed.get("items") if parsed.get("report_kind") == "item_wise"
                else parsed.get("bills", [])
            )
        }
        assert_dates_open(db, batch.outlet_id, imported_dates)
        if parsed.get("report_kind") == "item_wise":
            imported = _commit_itemwise(db, batch, parsed["items"])
        else:
            importer_commit(db, batch.outlet_id, parsed, batch)
            imported = batch.rows_ok
        batch.status = "committed"
        audit(db, None, user.id, "import-commit", "import_batch", batch.id,
              after={"rows_ok": batch.rows_ok})
        db.commit()
    except Exception:
        db.rollback()
        failed = db.get(ImportBatch, batch_id)
        if failed and failed.status == "committing":
            failed.status = "validated"
            db.commit()
        raise
    stash.unlink(missing_ok=True)
    return {"ok": True, "bills": imported}


@router.delete("/{batch_id}")
def discard_batch(batch_id: int, user: User = Depends(require_owner),
                  db: Session = Depends(get_db)):
    batch = db.get(ImportBatch, batch_id)
    if batch is None:
        raise HTTPException(404, "Batch not found")
    changed = (
        db.query(ImportBatch)
        .filter(ImportBatch.id == batch_id,
                ImportBatch.status == "validated")
        .update({ImportBatch.status: "discarded"},
                synchronize_session=False)
    )
    if changed != 1:
        raise HTTPException(409, f"Batch is {batch.status}")
    audit(db, None, user.id, "import-discard", "import_batch", batch.id)
    from ..config import DATA_DIR
    db.commit()
    (DATA_DIR / "imports" / f"batch_{batch.id}.json").unlink(missing_ok=True)
    return {"ok": True}


async def _upload_itemwise(raw: bytes, outlet_id: int, filename: str,
                           user, db):
    """Item-wise reports land in sales_items via the generic importer engine."""
    from datetime import date as _date, datetime as _dt

    from ..util import read_sheet_rows

    rows = read_sheet_rows(raw, max_rows=100_000, max_cols=200)
    hdr_i = next(i for i, r in enumerate(rows[:15])
                 if any(str(x or "").lower().startswith("item") for x in r))
    headers = [str(h or "").strip().lower() for h in rows[hdr_i]]

    def find(*names):
        for n in names:
            if n in headers:
                return headers.index(n)
        return None

    i_item = find("item name", "item", "dish")
    i_date = find("date", "business date")
    i_qty = find("qty", "quantity", "sold qty")
    i_amt = find("net amount", "amount", "net sales (₹)(m.a - d)", "value",
                 "gross amount")
    i_cat = find("group name", "category", "department")
    if i_item is None or i_amt is None:
        raise HTTPException(422,
            "Couldn't find Item/Amount columns — save as the plain item-wise "
            "export or use the Items template.")

    created = skipped = 0
    items = []
    for r in rows[hdr_i + 1:]:
        name = str(r[i_item] or "").strip()
        if not name or str(name).lower() in ("total", "grand total"):
            continue
        d_raw = r[i_date] if i_date is not None else None
        try:
            if isinstance(d_raw, _dt):
                d = d_raw.date()
            elif isinstance(d_raw, _date):
                d = d_raw
            elif d_raw:
                d = _dt.fromisoformat(str(d_raw).strip()).date()
            else:
                raise ValueError("missing date")
        except (TypeError, ValueError):
            skipped += 1
            continue
        qty = float(r[i_qty] or 0) if i_qty is not None else 0
        amt_v = r[i_amt] if i_amt is not None else 0
        try:
            amt = float(amt_v or 0)
        except (TypeError, ValueError):
            amt = 0.0
        cat = str(r[i_cat] or "")[:80] if i_cat is not None else ""
        items.append({"outlet_id": outlet_id, "business_date": d.isoformat(),
                      "item_name": name[:160], "category": cat,
                      "qty": qty, "amount_paise": int(round(amt * 100))})
        created += 1

    # dedupe within file on (date,item): sum quantities/amounts
    merged: dict[tuple, dict] = {}
    for it in items:
        key = (it["business_date"], it["item_name"])
        m = merged.setdefault(key, it)
        if m is not it:
            m["qty"] += it["qty"]
            m["amount_paise"] += it["amount_paise"]
            m.pop("_dup", None)

    batch = ImportBatch(outlet_id=outlet_id, filename=filename,
                        report_kind="item_wise", uploaded_by=user.id,
                        rows_total=created, rows_ok=len(merged),
                        status="validated")
    db.add(batch)
    db.flush()

    import json
    from ..config import DATA_DIR
    stash_dir = DATA_DIR / "imports"
    stash_dir.mkdir(exist_ok=True)
    (stash_dir / f"batch_{batch.id}.json").write_text(
        json.dumps(
            {"report_kind": "item_wise", "items": list(merged.values())},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    db.commit()
    return {"kind": "item_wise", "batch_id": batch.id,
            "rows_ok": len(merged), "rows_skipped": skipped_unused(created - len(merged)),
            "note": "Validated. Review and commit to menu-item analytics."}


def _commit_itemwise(db: Session, batch: ImportBatch, items: list[dict]) -> int:
    dates = {it["business_date"] for it in items}
    existing = {}
    if dates:
        rows = (
            db.query(SalesItem)
            .filter(
                SalesItem.outlet_id == batch.outlet_id,
                SalesItem.business_date.in_(dates),
            )
            .all()
        )
        existing = {(row.business_date, row.item_name): row for row in rows}
    for item in items:
        key = (item["business_date"], item["item_name"])
        row = existing.get(key)
        if row is None:
            db.add(SalesItem(**item, import_batch_id=batch.id))
        else:
            row.category = item["category"]
            row.qty = item["qty"]
            row.amount_paise = item["amount_paise"]
            row.import_batch_id = batch.id
    incoming = {
        (item["business_date"], item["item_name"])
        for item in items
    }
    for key, row in existing.items():
        if key not in incoming:
            db.delete(row)
    return len(items)


def skipped_unused(n):
    return max(0, n)


@router.get("")
def list_imports(outlet_id: int | None = None, limit: int = 30,
                 user: User = Depends(require_owner), db: Session = Depends(get_db)):
    q = db.query(ImportBatch)
    if outlet_id:
        q = q.filter_by(outlet_id=outlet_id)
    rows = q.order_by(ImportBatch.id.desc()).limit(limit).all()
    return [{
        "id": b.id, "filename": b.filename, "outlet_id": b.outlet_id,
        "status": b.status, "rows_ok": b.rows_ok, "rows_skipped": b.rows_skipped,
        "part_payments_unresolved": b.part_payments_unresolved,
        "uploaded_at": b.uploaded_at.isoformat() if b.uploaded_at else None,
    } for b in rows]
