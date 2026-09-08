"""Bank statement → expenses.

The bank already knows what was spent; typing it in again is where mistakes
come from. This reads the account statement, groups the debits by who was
paid, and remembers the answer so the same shop is classified automatically
next month.

Nothing is written until /commit, and every created expense carries a hash of
the statement line so re-importing an overlapping statement cannot double-post.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import bankstmt
from ..audit import audit, check_edit_window
from ..config import DATA_DIR
from ..db import get_db
from ..models import (BankCredit, BankRule, CashBankMatch, DayClosure, Expense,
                      ExpenseCategory, ImportBatch, User, Vendor)
from ..periods import assert_dates_open
from ..security import current_user, require_owner, require_stepup
from .helpers import assert_outlet_access

router = APIRouter(prefix="/bank", tags=["bank"])

REPORT_KIND = "bank_stmt"
VALID_MODES = {"cash", "upi", "card", "bank", "credit", "other"}

# Debits the statement shows that are not restaurant expenses. Suggested as
# "skip" so the owner sees them but they never silently become spend.
NEVER_EXPENSE = {"atm", "charge"}


def _stash_path(batch_id: int):
    return DATA_DIR / "imports" / f"batch_{batch_id}.json"


def _line_hash(outlet_id: int, txn: dict, occurrence: int = 1) -> str:
    """Identify one statement line, stably, across re-downloads.

    The reference number alone is not enough - some rails leave it blank or
    reuse zeros - so the date, amount and narration go in too.

    A statement can legitimately list the same payment twice on one day with
    an identical narration and a blank reference (fixed rentals, repeat QR
    payments). Numbering the repeats keeps the second one bookable instead of
    silently swallowing it as a duplicate, while still matching itself on a
    re-download - the same file always yields the same numbering.
    """
    raw = "|".join([
        "bank", str(outlet_id), txn["date"], str(txn["amount_paise"]),
        (txn.get("ref") or "").strip().upper(),
        " ".join((txn.get("narration") or "").split()).upper(),
        txn.get("direction") or "",
    ])
    if occurrence > 1:
        raw = f"{raw}|#{occurrence}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@router.post("/upload")
async def upload(file: UploadFile, outlet_id: int,
                 user: User = Depends(require_owner),
                 db: Session = Depends(get_db)):
    """Parse a statement and preview it. Nothing is booked here."""
    assert_outlet_access(db, user, outlet_id)
    raw = await file.read(bankstmt.MAX_BYTES + 1)
    if len(raw) > bankstmt.MAX_BYTES:
        raise HTTPException(413, "Statement file is larger than 25 MB")
    try:
        statement = bankstmt.parse(raw, file.filename or "statement.csv")
    except ValueError as ex:
        raise HTTPException(422, str(ex))

    rules = {r.match_key: r for r in db.query(BankRule).all()}
    seen = {
        key for (key,) in db.query(Expense.idempotency_key)
        .filter(Expense.outlet_id == outlet_id,
                Expense.idempotency_key.isnot(None))
    }
    credit_seen = {
        key for (key,) in db.query(BankCredit.line_hash)
        .filter(BankCredit.outlet_id == outlet_id)
    }

    txns: list[dict] = []
    occurrences: Counter[str] = Counter()
    for txn in statement.debits:
        key, label = bankstmt.counterparty(txn.narration)
        channel, mode = bankstmt.classify(txn.narration)
        row = {
            "date": txn.date, "narration": txn.narration,
            "amount_paise": txn.amount_paise, "ref": txn.ref,
            "row_number": txn.row_number,
            "match_key": key, "label": label, "channel": channel,
            "mode": mode,
        }
        occurrences[base := _line_hash(outlet_id, row)] += 1
        row["hash"] = _line_hash(outlet_id, row, occurrences[base])
        row["already_imported"] = row["hash"] in seen
        txns.append(row)

    credits: list[dict] = []
    credit_occurrences: Counter[str] = Counter()
    for txn in statement.credits:
        row = {
            "date": txn.date, "narration": txn.narration,
            "amount_paise": txn.amount_paise, "ref": txn.ref,
            "row_number": txn.row_number, "direction": "credit",
        }
        credit_occurrences[base := _line_hash(outlet_id, row)] += 1
        row["hash"] = _line_hash(outlet_id, row, credit_occurrences[base])
        row["already_imported"] = row["hash"] in credit_seen
        credits.append(row)

    # Group by payee: the owner classifies a shop once, not every line.
    groups: dict[str, dict] = {}
    for row in txns:
        group = groups.setdefault(row["match_key"], {
            "match_key": row["match_key"], "label": row["label"],
            "channel": row["channel"], "mode": row["mode"],
            "count": 0, "total_paise": 0, "new_count": 0,
            "dates": [],
        })
        group["count"] += 1
        group["total_paise"] += row["amount_paise"]
        group["dates"].append(row["date"])
        if not row["already_imported"]:
            group["new_count"] += 1

    for group in groups.values():
        rule = rules.get(group["match_key"])
        group["date_from"] = min(group["dates"])
        group["date_to"] = max(group["dates"])
        group.pop("dates")
        group["total_rupees"] = round(group["total_paise"] / 100, 2)
        group["rule_id"] = rule.id if rule else None
        group["category_id"] = rule.category_id if rule else None
        group["vendor_id"] = rule.vendor_id if rule else None
        if rule:
            group["mode"] = rule.mode
            group["skip"] = bool(rule.skip)
        else:
            group["skip"] = group["channel"] in NEVER_EXPENSE
        group["known"] = rule is not None

    ordered = sorted(groups.values(), key=lambda g: -g["total_paise"])
    new_rows = [t for t in txns if not t["already_imported"]]

    batch = ImportBatch(
        outlet_id=outlet_id, filename=file.filename or "statement.csv",
        report_kind=REPORT_KIND, uploaded_by=user.id,
        rows_total=len(statement.debits) + len(statement.credits),
        rows_ok=len(new_rows),
        rows_skipped=len(txns) - len(new_rows) + statement.skipped_rows,
        content_hash=hashlib.sha256(raw).hexdigest(),
        status="validated")
    db.add(batch)
    db.flush()

    stash_dir = DATA_DIR / "imports"
    stash_dir.mkdir(exist_ok=True)
    _stash_path(batch.id).write_text(json.dumps({
        "report_kind": REPORT_KIND, "outlet_id": outlet_id, "txns": txns,
        "credits": credits,
    }, ensure_ascii=False), encoding="utf-8")
    db.commit()

    dates = sorted({t["date"] for t in txns + credits})
    return {
        "batch_id": batch.id,
        "filename": batch.filename,
        "date_from": dates[0] if dates else None,
        "date_to": dates[-1] if dates else None,
        "debits": len(txns),
        "credits": len(credits),
        # Kept for older web clients during the rolling local upgrade. Credits
        # are retained now; this field no longer describes their treatment.
        "credits_ignored": 0,
        "credits_already_imported": sum(t["already_imported"] for t in credits),
        "credits_new_rows": sum(not t["already_imported"] for t in credits),
        "already_imported": len(txns) - len(new_rows),
        "new_rows": len(new_rows),
        "unreadable_rows": statement.skipped_rows,
        "payees": ordered,
        "transactions": txns,
    }


class Decision(BaseModel):
    """How one payee's transactions should be booked."""
    match_key: str
    category_id: int | None = None
    vendor_id: int | None = None
    vendor_name: str = ""        # create-and-use, so the owner never leaves the wizard
    mode: str = "bank"
    skip: bool = False
    remember: bool = True


class CommitIn(BaseModel):
    decisions: list[Decision]


@router.post("/{batch_id}/commit")
def commit_batch(batch_id: int, body: CommitIn,
                 user: User = Depends(require_stepup),
                 db: Session = Depends(get_db)):
    batch = db.get(ImportBatch, batch_id)
    if batch is None or batch.report_kind != REPORT_KIND:
        raise HTTPException(404, "Batch not found")
    stash = _stash_path(batch_id)
    if not stash.exists():
        raise HTTPException(410, "Staged file missing — upload again")

    claimed = (
        db.query(ImportBatch)
        .filter(ImportBatch.id == batch_id, ImportBatch.status == "validated")
        .update({ImportBatch.status: "committing"}, synchronize_session=False)
    )
    if claimed != 1:
        raise HTTPException(409, f"Batch is {batch.status}")
    db.commit()

    try:
        result = _apply(db, batch, json.loads(stash.read_text(encoding="utf-8")),
                        body.decisions, user)
        batch = db.get(ImportBatch, batch_id)
        batch.status = "committed"
        batch.rows_ok = result["created"]
        batch.rows_skipped = result["skipped"] + result["duplicates"]
        audit(db, None, user.id, "bank-import-commit",
              "import_batch", batch.id, after=result)
        db.commit()
    except Exception:
        db.rollback()
        _release(db, batch_id)
        raise
    stash.unlink(missing_ok=True)
    return {"ok": True, **result}


def _release(db: Session, batch_id: int) -> None:
    stuck = db.get(ImportBatch, batch_id)
    if stuck and stuck.status == "committing":
        stuck.status = "validated"
        db.commit()


def _apply(db: Session, batch: ImportBatch, parsed: dict,
           decisions: list[Decision], user: User) -> dict:
    outlet_id = batch.outlet_id
    chosen = {d.match_key: d for d in decisions}

    seen = {
        key for (key,) in db.query(Expense.idempotency_key)
        .filter(Expense.outlet_id == outlet_id,
                Expense.idempotency_key.isnot(None))
    }

    created = skipped = duplicates = 0
    unmapped: set[str] = set()
    vendor_cache: dict[str, int] = {}

    # A statement is always imported after the fact, so validate every
    # affected period before this batch writes anything.
    bookable = [t for t in parsed["txns"]
                if (d := chosen.get(t["match_key"])) is not None and not d.skip]
    if bookable:
        check_edit_window(min(t["date"] for t in bookable), user, db)
    assert_dates_open(db, outlet_id, {
        t["date"] for t in bookable + parsed.get("credits", [])
    })

    for txn in parsed["txns"]:
        decision = chosen.get(txn["match_key"])
        if decision is None or decision.skip:
            skipped += 1
            continue
        if decision.category_id is None:
            unmapped.add(txn["match_key"])
            skipped += 1
            continue
        if txn["hash"] in seen:
            duplicates += 1
            continue

        category = db.get(ExpenseCategory, decision.category_id)
        if category is None:
            raise HTTPException(422, f"Unknown expense category for {txn['label']}")

        mode = decision.mode if decision.mode in VALID_MODES else "bank"
        vendor_id = decision.vendor_id
        if vendor_id is None and decision.vendor_name.strip():
            vendor_id = _ensure_vendor(db, decision.vendor_name.strip(),
                                       vendor_cache)
        if vendor_id is not None and db.get(Vendor, vendor_id) is None:
            raise HTTPException(422, f"Unknown vendor for {txn['label']}")

        db.add(Expense(
            outlet_id=outlet_id, business_date=txn["date"],
            category_id=decision.category_id, vendor_id=vendor_id,
            amount_paise=txn["amount_paise"], mode=mode,
            description=txn["narration"][:500],
            entered_by=user.id, idempotency_key=txn["hash"]))
        seen.add(txn["hash"])
        created += 1

    credit_seen = {
        key for (key,) in db.query(BankCredit.line_hash)
        .filter(BankCredit.outlet_id == outlet_id)
    }
    credits_created = credits_duplicates = 0
    for credit in parsed.get("credits", []):
        if credit["hash"] in credit_seen:
            credits_duplicates += 1
            continue
        db.add(BankCredit(
            outlet_id=outlet_id, business_date=credit["date"],
            amount_paise=credit["amount_paise"], narration=credit["narration"][:500],
            reference=(credit.get("ref") or "")[:120], line_hash=credit["hash"],
            import_batch_id=batch.id,
        ))
        credit_seen.add(credit["hash"])
        credits_created += 1

    rules_saved = _save_rules(db, decisions, parsed, user, vendor_cache)
    db.flush()
    return {
        "created": created, "skipped": skipped, "duplicates": duplicates,
        "rules_saved": rules_saved, "credits_created": credits_created,
        "credits_duplicates": credits_duplicates,
        "unmapped": sorted(unmapped),
    }


class CashMatchIn(BaseModel):
    closure_id: int
    bank_credit_id: int
    amount_rupees: float


@router.get("/cash-reconciliation")
def cash_reconciliation(outlet_id: int, start: str, end: str,
                        user: User = Depends(require_owner), db: Session = Depends(get_db)):
    assert_outlet_access(db, user, outlet_id)
    closures = (db.query(DayClosure)
                  .filter(DayClosure.outlet_id == outlet_id, DayClosure.reopened_at.is_(None),
                          DayClosure.business_date >= start, DayClosure.business_date <= end,
                          DayClosure.moved_to_bank_paise > 0).all())
    credits = (db.query(BankCredit)
                 .filter(BankCredit.outlet_id == outlet_id,
                         BankCredit.business_date >= start, BankCredit.business_date <= end).all())
    allocations = db.query(CashBankMatch).all()
    closure_used: dict[int, int] = {}
    credit_used: dict[int, int] = {}
    for allocation in allocations:
        closure_used[allocation.closure_id] = closure_used.get(allocation.closure_id, 0) + allocation.amount_paise
        credit_used[allocation.bank_credit_id] = credit_used.get(allocation.bank_credit_id, 0) + allocation.amount_paise
    credit_rows = [{
        "id": credit.id, "date": credit.business_date, "amount_paise": credit.amount_paise,
        "remaining_paise": credit.amount_paise - credit_used.get(credit.id, 0),
        "narration": credit.narration, "reference": credit.reference,
    } for credit in credits]
    closure_rows = [{
        "id": closure.id, "date": closure.business_date,
        "expected_paise": closure.moved_to_bank_paise,
        "remaining_paise": closure.moved_to_bank_paise - closure_used.get(closure.id, 0),
    } for closure in closures]
    for closure in closure_rows:
        closure["suggested_credit_id"] = next((
            credit["id"] for credit in credit_rows
            if credit["remaining_paise"] == closure["remaining_paise"]
            and abs(date.fromisoformat(credit["date"]) -
                    date.fromisoformat(closure["date"])).days <= 7
        ), None)
    return {"closures": closure_rows, "credits": credit_rows}


@router.post("/cash-reconciliation/matches", status_code=201)
def add_cash_match(body: CashMatchIn, user: User = Depends(require_stepup),
                   db: Session = Depends(get_db)):
    if body.amount_rupees <= 0:
        raise HTTPException(422, "Match amount must be positive")
    closure = db.get(DayClosure, body.closure_id)
    credit = db.get(BankCredit, body.bank_credit_id)
    if closure is None or credit is None or closure.outlet_id != credit.outlet_id:
        raise HTTPException(422, "Cash close and bank credit must belong to the same outlet")
    assert_outlet_access(db, user, closure.outlet_id)
    amount = int(round(body.amount_rupees * 100))
    closure_used = db.query(func.coalesce(func.sum(CashBankMatch.amount_paise), 0)).filter(
        CashBankMatch.closure_id == closure.id).scalar()
    credit_used = db.query(func.coalesce(func.sum(CashBankMatch.amount_paise), 0)).filter(
        CashBankMatch.bank_credit_id == credit.id).scalar()
    if amount > closure.moved_to_bank_paise - closure_used or amount > credit.amount_paise - credit_used:
        raise HTTPException(422, "Match exceeds the remaining cash close or bank credit")
    match = CashBankMatch(closure_id=closure.id, bank_credit_id=credit.id,
                          amount_paise=amount, matched_by=user.id)
    db.add(match)
    audit(db, None, user.id, "cash-bank-match", "cash_bank_match", match.id,
          after={"amount_rupees": body.amount_rupees})
    db.commit()
    return {"id": match.id}


@router.delete("/cash-reconciliation/matches/{match_id}")
def remove_cash_match(match_id: int, user: User = Depends(require_stepup),
                      db: Session = Depends(get_db)):
    match = db.get(CashBankMatch, match_id)
    if match is None:
        raise HTTPException(404, "Match not found")
    closure = db.get(DayClosure, match.closure_id)
    assert_outlet_access(db, user, closure.outlet_id)
    db.delete(match)
    audit(db, None, user.id, "cash-bank-unmatch", "cash_bank_match", match_id)
    db.commit()
    return {"ok": True}


def _ensure_vendor(db: Session, name: str, cache: dict[str, int]) -> int:
    key = name.lower()
    if key in cache:
        return cache[key]
    vendor = db.query(Vendor).filter(Vendor.name.ilike(name)).first()
    if vendor is None:
        vendor = Vendor(name=name[:120])
        db.add(vendor)
        db.flush()
    cache[key] = vendor.id
    return vendor.id


def _save_rules(db: Session, decisions: list[Decision], parsed: dict,
                user: User, vendor_cache: dict[str, int]) -> int:
    labels = {t["match_key"]: t["label"] for t in parsed["txns"]}
    counts: dict[str, int] = {}
    for txn in parsed["txns"]:
        counts[txn["match_key"]] = counts.get(txn["match_key"], 0) + 1

    saved = 0
    for decision in decisions:
        if not decision.remember or not decision.match_key:
            continue
        if decision.category_id is None and not decision.skip:
            continue
        vendor_id = decision.vendor_id
        if vendor_id is None and decision.vendor_name.strip():
            vendor_id = vendor_cache.get(decision.vendor_name.strip().lower())
        rule = (db.query(BankRule)
                .filter(BankRule.match_key == decision.match_key).first())
        if rule is None:
            rule = BankRule(match_key=decision.match_key[:120],
                            created_by=user.id)
            db.add(rule)
        rule.label = (labels.get(decision.match_key) or decision.match_key)[:120]
        rule.category_id = decision.category_id
        rule.vendor_id = vendor_id
        rule.mode = decision.mode if decision.mode in VALID_MODES else "bank"
        rule.skip = decision.skip
        rule.hits = (rule.hits or 0) + counts.get(decision.match_key, 0)
        saved += 1
    return saved


@router.delete("/{batch_id}")
def discard_batch(batch_id: int, user: User = Depends(require_owner),
                  db: Session = Depends(get_db)):
    batch = db.get(ImportBatch, batch_id)
    if batch is None or batch.report_kind != REPORT_KIND:
        raise HTTPException(404, "Batch not found")
    changed = (
        db.query(ImportBatch)
        .filter(ImportBatch.id == batch_id, ImportBatch.status == "validated")
        .update({ImportBatch.status: "discarded"}, synchronize_session=False)
    )
    if changed != 1:
        raise HTTPException(409, f"Batch is {batch.status}")
    audit(db, None, user.id, "bank-import-discard",
          "import_batch", batch.id)
    db.commit()
    _stash_path(batch_id).unlink(missing_ok=True)
    return {"ok": True}


@router.get("/rules")
def list_rules(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rules = db.query(BankRule).order_by(BankRule.hits.desc()).all()
    return [{
        "id": r.id, "match_key": r.match_key, "label": r.label,
        "vendor_id": r.vendor_id, "category_id": r.category_id,
        "mode": r.mode, "skip": bool(r.skip), "hits": r.hits or 0,
    } for r in rules]


class RuleIn(BaseModel):
    category_id: int | None = None
    vendor_id: int | None = None
    mode: str = "bank"
    skip: bool = False


@router.patch("/rules/{rule_id}")
def update_rule(rule_id: int, body: RuleIn, user: User = Depends(require_owner),
                db: Session = Depends(get_db)):
    rule = db.get(BankRule, rule_id)
    if rule is None:
        raise HTTPException(404, "Rule not found")
    if body.category_id is not None and db.get(ExpenseCategory, body.category_id) is None:
        raise HTTPException(422, "Unknown expense category")
    if body.vendor_id is not None and db.get(Vendor, body.vendor_id) is None:
        raise HTTPException(422, "Unknown vendor")
    rule.category_id = body.category_id
    rule.vendor_id = body.vendor_id
    rule.mode = body.mode if body.mode in VALID_MODES else "bank"
    rule.skip = body.skip
    audit(db, None, user.id, "bank-rule-update", "bank_rule", rule.id)
    db.commit()
    return {"ok": True}


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: int, user: User = Depends(require_owner),
                db: Session = Depends(get_db)):
    rule = db.get(BankRule, rule_id)
    if rule is None:
        raise HTTPException(404, "Rule not found")
    audit(db, None, user.id, "bank-rule-delete", "bank_rule", rule.id,
          before={"match_key": rule.match_key})
    db.delete(rule)
    db.commit()
    return {"ok": True}
