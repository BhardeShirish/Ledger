"""Petpooja "Orders: Master Report" importer.

The export is bill-level with 47 known columns and 4 preamble metadata rows
(Date:, Name:, Restaurant Name:, blanks) before the header row. We detect the
format by header signature, normalize every Success bill, route Part/Due
payments to their own channel buckets, and dedupe on (outlet, invoice).
"""
from datetime import datetime

from sqlalchemy.orm import Session

from .models import ImportBatch, SalesBill, SalesDaily
from .util import read_sheet_rows

SIGNATURE = {"invoice no.", "payment type", "order type"}

SUMMARY_ROW_LABELS = {"total", "min.", "max.", "avg."}

# rupee columns we keep (header → bill field)
RUPEE_COLS = {
    "my amount (₹)": ("gross_paise", False),
    "discount (₹)": ("discount_paise", True),
    "net sales (₹)(m.a - d)": ("net_paise", False),
    "total tax (₹)": ("tax_paise", False),
    "round off": ("roundoff_paise", False),
    "tip (₹)": ("tip_paise", False),
    "total (₹)": ("total_paise", False),
}

CHARGE_COLS = ["delivery charge", "container charge", "service charge",
               "additional charge"]

PAYMENT_KIND = {
    "cash": "cash", "upi": "upi", "card": "card",
    "part payment": "split", "due payment": "due",
}


def _norm(s) -> str:
    return str(s or "").strip().lower()


def detect_and_load(file_bytes: bytes):
    """Returns (report_kind, headers:list[str], rows:list[list], meta:dict)."""
    rows = read_sheet_rows(file_bytes, max_rows=100_000, max_cols=200)
    header_idx = None
    for i, r in enumerate(rows[:15]):
        cells = {_norm(c) for c in r if c is not None}
        if SIGNATURE.issubset(cells):
            header_idx = i
            break
        if {"item name"} & cells and {"qty", "quantity", "sold qty"} & cells:
            header_idx = i
            break
    if header_idx is None:
        raise ValueError("Not a Petpooja report (neither Orders Master nor "
                         "Item-wise signature found)")
    headers = [_norm(c) for c in rows[header_idx]]
    meta = {}
    for r in rows[:header_idx]:
        vals = [c for c in r if c not in (None, "")]
        if len(vals) == 2:
            meta[_norm(vals[0]).rstrip(":")] = str(vals[1])
    data = rows[header_idx + 1:]
    kind = ("item_wise" if any(h.startswith("item") for h in headers)
            else "orders_master")
    return kind, headers, data, meta


def parse(file_bytes: bytes, outlet_id: int) -> dict:
    """Parse + validate. Returns dict with bills[], rollup per (date, kind), stats."""
    kind, headers, data, meta = detect_and_load(file_bytes)
    if kind == "item_wise":
        return {"report_kind": kind}
    idx = {h: i for i, h in enumerate(headers)}
    missing = [h for h in ["invoice no.", "date", "payment type"] if h not in idx]
    if missing:
        raise ValueError(f"Missing required columns: {missing}")

    def num(row, col):
        i = idx.get(col)
        if i is None:
            return 0.0
        v = row[i] if i < len(row) else None
        try:
            return float(v or 0)
        except (TypeError, ValueError):
            return 0.0

    bills, skipped, unresolved = [], 0, 0
    rollup: dict[tuple[str, str], dict] = {}

    for r in data:
        first = _norm(r[0]) if r else ""
        if not any(_norm(c) for c in (r or [])):
            continue
        if first in SUMMARY_ROW_LABELS:
            continue
        inv = str(r[idx["invoice no."]] or "").strip()
        ts_raw = r[idx["date"]]
        pay = _norm(r[idx["payment type"]])
        status = _norm(r[idx["status"]] if "status" in idx else "success")
        if not inv:
            continue
        if status != "success":
            skipped += 1
            continue
        try:
            ts = datetime.strptime(str(ts_raw)[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            try:
                ts = datetime.fromisoformat(str(ts_raw))
            except ValueError:
                skipped += 1
                continue
        pkind = PAYMENT_KIND.get(pay, "other")
        if pkind == "split":
            unresolved += 1
        charges = sum(num(r, c) for c in CHARGE_COLS)

        def rp(col):
            return int(round(num(r, col) * 100))

        bill = {
            "outlet_id": outlet_id,
            "business_date": ts.date().isoformat(),
            "invoice_no": inv,
            "bill_ts": ts.strftime("%Y-%m-%d %H:%M:%S"),
            "order_type": str(r[idx["order type"]] or "") if "order type" in idx else "",
            "area": str(r[idx["area"]] or "") if "area" in idx else "",
            "persons": int(num(r, "persons")) if "persons" in idx else None,
            "channel_kind": pkind,
            "gross_paise": rp("my amount (₹)") if "my amount (₹)" in idx else 0,
            "discount_paise": rp("discount (₹)") if "discount (₹)" in idx else 0,
            "net_paise": rp("net sales (₹)(m.a - d)") if "net sales (₹)(m.a - d)" in idx else 0,
            "charges_paise": int(round(charges * 100)),
            "tax_paise": rp("total tax (₹)") if "total tax (₹)" in idx else 0,
            "roundoff_paise": rp("round off") if "round off" in idx else 0,
            "tip_paise": rp("tip (₹)") if "tip (₹)" in idx else 0,
            "total_paise": rp("total (₹)") if "total (₹)" in idx else 0,
        }
        # net fallback when column absent
        if "net sales (₹)(m.a - d)" not in idx:
            bill["net_paise"] = max(0, bill["gross_paise"] - bill["discount_paise"])
        if "total (₹)" not in idx:
            bill["total_paise"] = (bill["net_paise"] + bill["charges_paise"]
                                   + bill["tax_paise"] + bill["roundoff_paise"])
        bill["_raw"] = {
            "payment_type": pay,
            "payment_description": str(r[idx["payment description"]] or "")
            if "payment description" in idx else "",
            "biller": str(r[idx["biller"]] or "") if "biller" in idx else "",
            "kot_no": str(r[idx["kot no."]] or "") if "kot no." in idx else "",
        }
        bills.append(bill)

        key = bill["business_date"] + "|" + pkind
        agg = rollup.setdefault(key, {
            "bills": 0, "gross_paise": 0, "discount_paise": 0, "net_paise": 0,
            "charges_paise": 0, "tax_paise": 0, "roundoff_paise": 0,
            "tip_paise": 0, "total_paise": 0})
        for f in ("gross_paise", "discount_paise", "net_paise", "charges_paise",
                  "tax_paise", "roundoff_paise", "tip_paise", "total_paise"):
            agg[f] += bill[f]
        agg["bills"] += 1

    return {
        "report_kind": kind, "meta": meta, "bills": bills, "rollup": rollup,
        "rows_total": len(data), "rows_ok": len(bills), "rows_skipped": skipped,
        "part_payments_unresolved": unresolved,
    }


def commit(db: Session, outlet_id: int, parsed: dict, batch: ImportBatch) -> None:
    """Replace imported data for every date represented in the report."""
    existing = {}
    dates = {b["business_date"] for b in parsed["bills"]}
    if dates:
        q = (db.query(SalesBill)
               .filter(SalesBill.outlet_id == outlet_id,
                       SalesBill.business_date.in_(dates)))
        for b in q.all():
            existing[(b.business_date, b.invoice_no)] = b

    for b in parsed["bills"]:
        raw = b.pop("_raw", None)
        row = existing.get((b["business_date"], b["invoice_no"]))
        if row is None:
            data = {k: v for k, v in b.items() if k != "outlet_id"}
            row = SalesBill(**data, outlet_id=outlet_id)
            db.add(row)
        else:
            for k, v in b.items():
                if k != "outlet_id":
                    setattr(row, k, v)
        row.raw_json = raw
        row.import_batch_id = batch.id
    incoming = {
        (b["business_date"], b["invoice_no"])
        for b in parsed["bills"]
    }
    for key, row in existing.items():
        if key not in incoming:
            db.delete(row)
    db.flush()

    # Rebuild every touched date from persisted bills so removed channels vanish.
    if dates:
        (db.query(SalesDaily)
           .filter(SalesDaily.outlet_id == outlet_id,
                   SalesDaily.business_date.in_(dates),
                   SalesDaily.source == "petpooja")
           .delete(synchronize_session=False))
        rollup = {}
        for bill in (db.query(SalesBill)
                       .filter(SalesBill.outlet_id == outlet_id,
                               SalesBill.business_date.in_(dates)).all()):
            key = (bill.business_date, bill.channel_kind)
            agg = rollup.setdefault(key, {
                "bills": 0, "gross_paise": 0, "discount_paise": 0,
                "net_paise": 0, "tax_paise": 0, "tip_paise": 0,
                "total_paise": 0,
            })
            agg["bills"] += 1
            for field in ("gross_paise", "discount_paise", "net_paise",
                          "tax_paise", "tip_paise", "total_paise"):
                agg[field] += getattr(bill, field)
        for (day, kind), agg in rollup.items():
            db.add(SalesDaily(
                outlet_id=outlet_id, business_date=day,
                channel_kind=kind, source="petpooja",
                amount_paise=agg["total_paise"], **agg,
            ))
    db.flush()
