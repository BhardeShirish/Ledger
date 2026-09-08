"""Daily sales sheet: manual channel rows merged with imported rollups."""
import math

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..audit import audit, check_edit_window
from ..db import get_db
from ..periods import assert_month_open
from ..models import SalesBill, SalesChannel, SalesDaily, User
from ..security import current_user, require_owner
from ..util import validate_business_date
from .helpers import assert_outlet_access

router = APIRouter(prefix="/sales", tags=["sales"])
CHANNEL_KINDS = {
    "cash", "upi", "card", "wallet", "aggregator", "split", "due", "other",
}


@router.get("/bills")
def bills(outlet_id: int, business_date: str | None = None,
          limit: int = 1000,
          user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Bill-level history (from Petpooja imports), newest first."""
    assert_outlet_access(db, user, outlet_id)
    q = db.query(SalesBill).filter_by(outlet_id=outlet_id)
    if business_date:
        q = q.filter(SalesBill.business_date == business_date)
    rows = (q.order_by(SalesBill.bill_ts.desc())
              .limit(min(limit, 5000)).all())
    return [{
        "id": b.id, "business_date": b.business_date,
        "invoice_no": b.invoice_no, "bill_ts": b.bill_ts,
        "order_type": b.order_type, "area": b.area, "persons": b.persons,
        "channel_kind": b.channel_kind,
        "net_paise": b.net_paise, "total_paise": b.total_paise,
        "discount_paise": b.discount_paise, "tip_paise": b.tip_paise,
        "tax_paise": b.tax_paise,
    } for b in rows]


class ManualIn(BaseModel):
    outlet_id: int
    business_date: str
    channel_kind: str          # cash|upi|card|wallet|aggregator|other
    amount_rupees: float = 0
    note: str = ""


class ChannelIn(BaseModel):
    name: str
    kind: str = "other"
    # No default: the rename screen sends only a name, and writing a default
    # here moved the channel to a new row on the till screen every rename.
    sort: int | None = None


@router.get("/channels")
def channels(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = (db.query(SalesChannel)
              .filter_by(is_active=True).order_by(SalesChannel.sort).all())
    return [{"id": c.id, "name": c.name, "kind": c.kind, "sort": c.sort} for c in rows]


@router.post("/channels", status_code=201)
def add_channel(body: ChannelIn, user: User = Depends(require_owner),
                db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name or body.kind not in CHANNEL_KINDS:
        raise HTTPException(422, "Channel name and kind are required")
    # A new channel goes after the existing ones rather than landing on a
    # shared default, where ties order themselves arbitrarily.
    sort = body.sort
    if sort is None:
        sort = (db.query(func.max(SalesChannel.sort)).scalar() or 0) + 10
    c = SalesChannel(name=name, kind=body.kind, sort=sort)
    db.add(c)
    db.flush()
    audit(db, None, user.id, "create", "sales_channel", c.id,
          after={"name": name, "kind": body.kind})
    db.commit()
    return {"id": c.id, "name": c.name, "kind": c.kind, "sort": c.sort}


@router.patch("/channels/{channel_id}")
def update_channel(channel_id: int, body: ChannelIn,
                   user: User = Depends(require_owner), db: Session = Depends(get_db)):
    from ..audit import audit as _audit
    c = db.get(SalesChannel, channel_id)
    if c is None:
        raise HTTPException(404, "Channel not found")
    name = body.name.strip()
    if not name or body.kind not in CHANNEL_KINDS:
        raise HTTPException(422, "Channel name and kind are required")
    c.name = name
    c.kind = body.kind
    if body.sort is not None:
        c.sort = body.sort
    _audit(db, None, user.id, "update", "sales_channel", c.id,
           after={"name": c.name})
    db.commit()
    return {"id": c.id, "name": c.name, "kind": c.kind, "sort": c.sort}


@router.delete("/channels/{channel_id}")
def deactivate_channel(channel_id: int, user: User = Depends(require_owner),
                       db: Session = Depends(get_db)):
    c = db.get(SalesChannel, channel_id)
    if c is None:
        raise HTTPException(404, "Channel not found")
    c.is_active = False
    audit(db, None, user.id, "deactivate", "sales_channel", c.id,
          after={"name": c.name})
    db.commit()
    return {"ok": True}


class SplitAllocIn(BaseModel):
    allocations: list[dict]     # [{channel_kind: "cash"|"upi"|..., amount_rupees: float}]


@router.post("/bills/{bill_id}/allocate-split")
def allocate_split(bill_id: int, body: SplitAllocIn,
                   user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Resolve a Part-Payment bill into its component channels.

    Moves the bill's total out of the 'split' rollup into the chosen channels
    (POS-source rows) and stamps the bill with the primary channel.
    """
    from ..audit import audit as _audit

    bill = db.get(SalesBill, bill_id)
    if bill is None:
        raise HTTPException(404, "Bill not found")
    assert_outlet_access(db, user, bill.outlet_id)
    assert_month_open(db, bill.outlet_id, bill.business_date)
    if bill.channel_kind != "split":
        raise HTTPException(409, "This bill is not an unresolved split")

    valid_kinds = {"cash", "upi", "card", "wallet", "aggregator", "other"}
    allocs = []
    for allocation in body.allocations:
        kind = allocation.get("channel_kind")
        try:
            rupees = float(allocation.get("amount_rupees"))
        except (TypeError, ValueError):
            raise HTTPException(422, "Allocation amounts must be numbers")
        if kind not in valid_kinds:
            raise HTTPException(422, f"Invalid allocation channel: {kind}")
        if not math.isfinite(rupees) or rupees <= 0:
            raise HTTPException(422, "Allocation amounts must be positive and finite")
        allocs.append((kind, int(round(rupees * 100))))
    if len(allocs) < 2:
        raise HTTPException(422, "A split payment needs at least two channels")
    if len({kind for kind, _ in allocs}) != len(allocs):
        raise HTTPException(422, "Each allocation channel may appear only once")
    total_alloc = sum(v for _, v in allocs)
    if total_alloc != bill.total_paise:
        raise HTTPException(422,
            f"Allocated ₹{total_alloc/100:.2f} but the bill is ₹{bill.total_paise/100:.2f} — must match exactly")

    bd = bill.business_date
    # shrink the split bucket
    split_row = (db.query(SalesDaily)
                   .filter_by(outlet_id=bill.outlet_id, business_date=bd,
                              channel_kind="split", source="petpooja").first())
    if split_row:
        split_row.bills = max(0, split_row.bills - 1)
        for f in ("gross_paise", "discount_paise", "net_paise",
                  "tax_paise", "tip_paise", "total_paise"):
            setattr(split_row, f, max(0, getattr(split_row, f) - getattr(bill, f)))
        split_row.amount_paise = split_row.total_paise

    primary_index = max(range(len(allocs)), key=lambda i: allocs[i][1])
    fields = ("gross_paise", "discount_paise", "net_paise",
              "tax_paise", "tip_paise", "total_paise")
    shares = {}
    for field in fields:
        value = getattr(bill, field)
        portions = [
            int(round(value * amount / total_alloc))
            for _, amount in allocs[:-1]
        ]
        portions.append(value - sum(portions))
        shares[field] = portions

    # Grow target channels. Count the bill once, on its primary channel.
    for index, (kind, _amt) in enumerate(allocs):
        row = (db.query(SalesDaily)
                 .filter_by(outlet_id=bill.outlet_id, business_date=bd,
                            channel_kind=kind, source="petpooja").first())
        if row is None:
            row = SalesDaily(outlet_id=bill.outlet_id, business_date=bd,
                             channel_kind=kind, source="petpooja",
                             bills=0, gross_paise=0, discount_paise=0,
                             net_paise=0, tax_paise=0, tip_paise=0,
                             total_paise=0)
            db.add(row)
        row.bills += 1 if index == primary_index else 0
        for field in fields:
            setattr(row, field, getattr(row, field) + shares[field][index])
        row.amount_paise = row.total_paise

    primary = allocs[primary_index][0]
    raw = dict(bill.raw_json or {})
    raw["split_allocated"] = [{"kind": k, "rupees": v / 100} for k, v in allocs]
    bill.raw_json = raw
    bill.channel_kind = primary

    _audit(db, None, user.id, "allocate-split", "sales_bill", bill.id,
           after=raw["split_allocated"])
    db.commit()
    return {"ok": True, "primary_channel": primary}


@router.get("/unresolved-splits")
def unresolved_splits(outlet_id: int, limit: int = 100,
                      user: User = Depends(current_user),
                      db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    rows = (db.query(SalesBill)
              .filter_by(outlet_id=outlet_id, channel_kind="split")
              .order_by(SalesBill.business_date.desc(), SalesBill.bill_ts.desc())
              .limit(min(limit, 500)).all())
    return [{
        "id": b.id, "business_date": b.business_date, "invoice_no": b.invoice_no,
        "bill_ts": b.bill_ts, "total_rupees": round(b.total_paise / 100, 2),
    } for b in rows]


@router.get("/sheet")
def sheet(outlet_id: int, date: str, user: User = Depends(current_user),
          db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    rows = (db.query(SalesDaily)
              .filter_by(outlet_id=outlet_id, business_date=date).all())
    kinds = ["cash", "upi", "card", "wallet", "aggregator", "split", "due", "other"]

    def pack(kind):
        manual = next((r for r in rows if r.channel_kind == kind and r.source == "manual"), None)
        imp_rows = [r for r in rows if r.channel_kind == kind and r.source == "petpooja"]
        imp = None
        if imp_rows:
            imp = {
                "bills": sum(r.bills for r in imp_rows),
                "net_paise": sum(r.net_paise for r in imp_rows),
                "total_paise": sum(r.total_paise for r in imp_rows),
                "tip_paise": sum(r.tip_paise for r in imp_rows),
                "tax_paise": sum(r.tax_paise for r in imp_rows),
                "discount_paise": sum(r.discount_paise for r in imp_rows),
            }
        return {
            "channel_kind": kind,
            "manual_amount_rupees": round(manual.amount_paise / 100, 2) if manual else None,
            "manual_note": manual.note if manual else "",
            "imported": imp,
            # display figure prefers the POS number when present
            "effective_rupees":
                round((imp["total_paise"] if imp else 0) / 100, 2) if imp else
                (round(manual.amount_paise / 100, 2) if manual else None),
        }

    data = [pack(k) for k in kinds]
    total = sum(d["effective_rupees"] or 0 for d in data)

    from .losses import LOSS_KINDS, _serialize as _loss
    from ..models import DayLoss
    loss_rows = (db.query(DayLoss)
                   .filter_by(outlet_id=outlet_id, business_date=date)
                   .order_by(DayLoss.id.desc()).all())
    losses_paise = sum(r.amount_paise for r in loss_rows)
    return {
        "outlet_id": outlet_id, "date": date,
        "rows": [d for d in data if d["imported"] or d["manual_amount_rupees"] is not None
                 or d["channel_kind"] in ("cash", "upi", "card")],
        "all_rows": data,
        "total_rupees": round(total, 2),
        "losses": [_loss(r) for r in loss_rows],
        "losses_rupees": round(losses_paise / 100, 2),
        "net_rupees": round(total - losses_paise / 100, 2),
        "loss_kinds": [{"kind": k, **v} for k, v in LOSS_KINDS.items()],
    }


@router.put("/manual")
def put_manual(body: ManualIn, user: User = Depends(current_user),
               db: Session = Depends(get_db)):
    assert_outlet_access(db, user, body.outlet_id)
    validate_business_date(body.business_date, no_future=True)
    check_edit_window(body.business_date, user, db)
    assert_month_open(db, body.outlet_id, body.business_date)
    if body.channel_kind not in CHANNEL_KINDS - {"split", "due"}:
        raise HTTPException(422, "Invalid manual sales channel")
    if not math.isfinite(body.amount_rupees) or body.amount_rupees < 0:
        raise HTTPException(422, "Amount must be finite and non-negative")
    amt = int(round(body.amount_rupees * 100))

    def write() -> None:
        row = (db.query(SalesDaily)
                 .filter_by(outlet_id=body.outlet_id, business_date=body.business_date,
                            channel_kind=body.channel_kind, source="manual").first())
        if row is None:
            if amt == 0:
                return
            row = SalesDaily(outlet_id=body.outlet_id, business_date=body.business_date,
                             channel_kind=body.channel_kind, source="manual")
            db.add(row)
        row.amount_paise = amt
        row.note = body.note
        audit(db, None, user.id, "sales-manual", "sales_daily",
              f"{body.outlet_id}@{body.business_date}/{body.channel_kind}",
              after={"amount_rupees": body.amount_rupees})
        db.commit()

    try:
        write()
    except IntegrityError:
        # Another save for this same cell landed between the lookup and the
        # insert, so the unique index rejected the second row. That is a
        # normal race here: clicking Save blurs the field, and two phones can
        # close the same day. Retry once and the row now exists, so it
        # updates instead of inserting.
        db.rollback()
        write()
    return {"ok": True, "amount_rupees": round(amt / 100, 2)}
