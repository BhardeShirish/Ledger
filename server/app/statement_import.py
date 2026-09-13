"""Build a Ledger database from HDFC and PhonePe statements.

Two statements describe the same money. PhonePe is a front end to the bank
account, so most of its rows are already in the HDFC statement; importing
both naively would double every UPI payment made in the overlap. The UTR
settles it: PhonePe records it directly and HDFC stores the same value in
Chq./Ref.No., so a payment present in both can be recognised exactly rather
than guessed at from date and amount.

Where a payment appears in both, the bank is taken as the authority on the
money and PhonePe on the payee name, because the bank truncates a narration
to sixty characters while PhonePe keeps "Amit Khubnani Kirana".

Parties are identified by UPI id, not by name. The same person appears as
"Aman" and as "Akhilesh Khobragade Ootaa Staff Service Evening" while paying
into one id, and one shop arrives as "SAGAR ELECTRONICS  " and as "Sagar
Electronics". Aggregator handles (paytmqr..., gpay, q123...) are excluded
from that matching: they are shared by thousands of merchants and would
collapse unrelated shops into a single vendor.
"""
from __future__ import annotations

import argparse
import re
import shutil
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}

#: UPI handles owned by a payment aggregator rather than by the payee.
SHARED_HANDLE = re.compile(
    r"(?i)^(gpay|paytm|q\d|paytmqr|eazypay|zepto|blinkit|bigbasket|bbnow|"
    r"vyapar|bajajpay|cf\.|sv\d)"
)

#: Words that mark a payee as somebody on the payroll rather than a supplier.
#: Deliberately role words only. "Ootaa" alone is not one: the shop's name
#: also appears on suppliers such as "Pawan Water Ootaa".
STAFF_WORDS = (
    "staff", "cashier", "chef", "helper", "steward",
    "cleaning", "plating", "manager", "cook", "waiter",
)

#: Parties the owner named. Highest precedence, because a human said so.
#: payee substring -> (kind, display name, category)
#: kind is "staff" or "vendor".
KNOWN: list[tuple[str, tuple[str, str, str]]] = [
    ("ravindrakumar dongarmal sharma", ("vendor", "Ravindrakumar Sharma (Landlord)", "Rent")),
    ("hiveway media", ("vendor", "Hiveway Media", "Marketing")),
    ("nilesh gupta", ("vendor", "Nilesh Gupta (Broker)", "Rent")),
    ("tushar amesar", ("vendor", "CA Tushar Amesar", "Professional Fees")),
    ("chandrashekhar narayan choudhari", ("staff", "Shekhar Choudhari (Cook)", "Salary & Wages")),
    ("shekhar choudhari", ("staff", "Shekhar Choudhari (Cook)", "Salary & Wages")),
    ("manushi", ("staff", "Manushi (Cashier)", "Salary & Wages")),
    ("priya", ("staff", "Priya", "Salary & Wages")),
    ("mrs varsha varsha", ("staff", "Akhilesh Khobragade", "Salary & Wages")),
    ("akhilesh khobragade", ("staff", "Akhilesh Khobragade", "Salary & Wages")),
    ("aman", ("staff", "Akhilesh Khobragade", "Salary & Wages")),
    ("abhishek gangadhar kumbhare", ("staff", "Abhishek Kumbhare", "Salary & Wages")),
    ("abhishek kumbhare", ("staff", "Abhishek Kumbhare", "Salary & Wages")),
    ("pratibha samilal khandelwal", ("staff", "Pratibha Khandelwal", "Salary & Wages")),
    ("pratibha khandelwal", ("staff", "Pratibha Khandelwal", "Salary & Wages")),
    ("varun yadav", ("staff", "Varun Yadav (Chef)", "Salary & Wages")),
    ("esha hemane", ("staff", "Esha Hemane (Cashier)", "Salary & Wages")),
    ("brajesh maladhari", ("staff", "Brajesh Maladhari (Helper)", "Salary & Wages")),
    ("kiran jambhule", ("staff", "Kiran Jambhule (Cleaning)", "Salary & Wages")),
    ("bhushan sonone", ("staff", "Bhushan Sonone", "Salary & Wages")),
    ("riya singh", ("staff", "Riya Singh", "Salary & Wages")),
    ("bhushan shrikishan sonone", ("staff", "Bhushan Sonone", "Salary & Wages")),
    ("riya vijendra singh", ("staff", "Riya Singh", "Salary & Wages")),
    ("esha vinayak hemane", ("staff", "Esha Hemane (Cashier)", "Salary & Wages")),
    ("abhishek gangadhar k", ("staff", "Abhishek Kumbhare", "Salary & Wages")),
    ("chandrashekhar naray", ("staff", "Shekhar Choudhari (Cook)", "Salary & Wages")),
    ("easter cashier", ("staff", "Easter (Cashier)", "Salary & Wages")),
    ("mahadev patle", ("staff", "Mahadev Patle (Manager)", "Salary & Wages")),
    ("kishan jaiswal", ("staff", "Kishan Jaiswal (Manager)", "Salary & Wages")),
    ("jay agrawal", ("vendor", "Jay Agrawal (Parcel & Containers)", "Packaging")),
]

#: Supplier categorisation by payee substring. Order matters: first hit wins.
VENDOR_RULES: list[tuple[str, str]] = [
    ("kirana", "Groceries"),
    ("kisan kirana", "Groceries"),
    ("gajanan agencies", "Groceries"),
    ("general store", "Groceries"),
    ("pankaj store", "Groceries"),
    ("mohammadi stores", "Groceries"),
    ("nip sales", "Groceries"),

    ("vegetable", "Vegetables & Fruits"),
    ("freshezy", "Vegetables & Fruits"),
    ("vegifarm", "Vegetables & Fruits"),
    ("fruit", "Vegetables & Fruits"),

    ("dairy", "Dairy"),
    ("ghee", "Dairy"),
    ("madhur dairy", "Dairy"),

    ("wines", "Liquor"),
    ("icecream", "Raw Material"),
    ("naturals", "Raw Material"),
    ("snacks and juice", "Raw Material"),
    ("bakes", "Raw Material"),

    ("gas service", "Gas Cylinder"),
    ("cpil", "Gas Cylinder"),
    ("confidence petroleum", "Gas Cylinder"),

    ("electricity bill", "Electricity"),
    ("water", "Water"),
    ("water tanker", "Water"),

    ("disposal", "Packaging"),
    ("dispoware", "Packaging"),

    ("electronics", "Repairs & Maintenance"),
    ("electrician", "Repairs & Maintenance"),
    ("rewinding", "Repairs & Maintenance"),
    ("hardware", "Repairs & Maintenance"),
    ("scale traders", "Repairs & Maintenance"),

    ("facebook", "Marketing"),
    ("meesho", "Marketing"),

    ("stationer", "Misc"),
    ("books and stationers", "Misc"),
    ("uniform", "Staff Welfare"),
    ("poshak", "Staff Welfare"),

    ("zepto", "Groceries"),
    ("blinkit", "Groceries"),
    ("bigbasket", "Groceries"),
    ("bbnow", "Groceries"),
    ("innovative retail", "Groceries"),
    ("avenue supermarts", "Groceries"),
    ("dmart", "Groceries"),
]

EXTRA_CATEGORIES = [
    ("Salary & Wages", "labour"),
    ("Liquor", "cogs_bev"),
    ("Professional Fees", "admin"),
]


# --------------------------------------------------------------------------
# reading


def read_hdfc(path: Path) -> list[dict]:
    import xlrd

    sheet = xlrd.open_workbook(path).sheet_by_index(0)
    rows: list[dict] = []
    started = False
    for i in range(sheet.nrows):
        cells = [str(c.value).strip() for c in sheet.row(i)]
        if len(cells) < 7:
            continue
        if cells[0] == "Date" and cells[1] == "Narration":
            started = True
            continue
        if not started or not re.fullmatch(r"\d{2}/\d{2}/\d{2}", cells[0]):
            continue
        try:
            when = datetime.strptime(cells[0], "%d/%m/%y").date()
        except ValueError:
            continue
        rows.append({
            "date": when,
            "narration": cells[1],
            "ref": cells[2].lstrip("0"),
            "withdrawal": float(cells[4]) if cells[4] else 0.0,
            "deposit": float(cells[5]) if cells[5] else 0.0,
        })
    return rows


def read_phonepe(path: Path) -> list[dict]:
    import openpyxl

    sheet = openpyxl.load_workbook(path, data_only=True)["Sheet1"]
    rows: list[dict] = []
    for values in sheet.iter_rows(values_only=True):
        if not values or len(values) < 8 or values[0] is None:
            continue
        cells = ["" if v is None else str(v).strip() for v in values]
        when = _phonepe_date(values[0], cells[0])
        if when is None:
            continue
        try:
            amount = float(cells[7])
        except ValueError:
            continue
        account = re.search(r"(\d{4})\s*$", cells[6])
        rows.append({
            "date": when,
            "details": cells[2],
            "utr": cells[4].split(".")[0],
            "direction": cells[5].upper(),
            "account": account.group(1) if account else "?",
            "amount": amount,
        })
    return rows


def paytm_settlements(hdfc: list[dict], since: date) -> dict[str, int]:
    """Confirmed Paytm settlement revenue, aggregated per business day.

    Individual UPI credits merely say that the sender used Paytm and can be
    transfers.  A credit from Paytm Payments Services is the restaurant's
    settlement and is safe to record as aggregator sales.
    """
    totals: dict[str, int] = defaultdict(int)
    for row in hdfc:
        if (row["date"] >= since and row["deposit"]
                and "PAYTM PAYMENTS SERVICES" in row["narration"].upper()):
            totals[row["date"].isoformat()] += int(round(row["deposit"] * 100))
    return dict(totals)


def _phonepe_date(raw, text: str):
    """The export mixes real datetimes with strings like 'Sept 01, 2026'."""
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    match = re.fullmatch(r"([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})", text)
    if not match:
        return None
    month = MONTHS.get(match.group(1).lower())
    if not month:
        return None
    return date(int(match.group(3)), month, int(match.group(2)))


# --------------------------------------------------------------------------
# merging


def clean_payee(name: str) -> str:
    name = re.sub(r"\s+", " ", name or "").strip(" .-")
    return re.sub(r"(?i)^(paid to|received from)\s+", "", name).strip()


def parse_upi(narration: str) -> tuple[str, str]:
    if not narration.startswith("UPI-"):
        return "", ""
    parts = narration.split("-")
    if len(parts) < 3:
        return "", ""
    return parts[1].strip(), parts[2].strip().lower()


def parse_neft(narration: str) -> str:
    """Payee out of a bank transfer narration.

    HDFC writes these as ``NEFT DR-<IFSC>-<NAME>-<channel>``; without this
    the IFSC and channel end up in the vendor's name.
    """
    match = re.match(r"(?:NEFT|IMPS|RTGS|MMT)\s*(?:DR|CR)?-[A-Z0-9]{6,}-(.+)",
                     narration.strip())
    if not match:
        return ""
    name = match.group(1).strip()
    # Trailing channel marker: "-NET", "-MOB", "-NETBANKING".
    name = re.sub(r"-(NET|MOB|NETBANKING|MOBILE|BRANCH)\w*$", "", name).strip()
    return name.split("-")[0].strip()


def usable_vpa(vpa: str) -> str | None:
    if not vpa or "@" not in vpa:
        return None
    local = vpa.split("@")[0]
    if SHARED_HANDLE.match(local) or len(local) < 4:
        return None
    return vpa


def merge(hdfc: list[dict], phonepe: list[dict], since: date,
          account: str) -> list[dict]:
    """One payment per row, with duplicates across the two sources removed."""
    by_utr: dict[str, list[dict]] = defaultdict(list)
    for row in phonepe:
        if row["utr"]:
            by_utr[row["utr"]].append(row)

    records: list[dict] = []
    seen_utrs: set[str] = set()

    for row in hdfc:
        if row["date"] < since or not row["withdrawal"]:
            continue
        payee, vpa = parse_upi(row["narration"])
        friendly = ""
        for candidate in by_utr.get(row["ref"], ()):
            if abs(candidate["amount"] - row["withdrawal"]) < 0.01:
                friendly = clean_payee(candidate["details"])
                seen_utrs.add(row["ref"])
                break
        records.append({
            "date": row["date"],
            "amount": round(row["withdrawal"], 2),
            "payee": (friendly or clean_payee(payee)
                      or parse_neft(row["narration"])
                      or row["narration"][:60]),
            "vpa": vpa,
            "narration": row["narration"],
            "source": "hdfc",
        })

    for row in phonepe:
        if (row["date"] < since or row["direction"] != "DEBIT"
                or row["account"] != account):
            continue
        if row["utr"] and row["utr"] in seen_utrs:
            continue
        records.append({
            "date": row["date"],
            "amount": round(row["amount"], 2),
            "payee": clean_payee(row["details"]),
            "vpa": "",
            "narration": row["details"],
            "source": "phonepe",
        })

    records.sort(key=lambda r: (r["date"], r["payee"]))
    return records


# --------------------------------------------------------------------------
# classification


def normalise(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def _mentions(text: str, needle: str) -> bool:
    """Whole-word containment.

    A plain substring test is wrong here: "aman" occurs inside "DINESH
    RAMAN", which would post an unrelated supplier's payment onto a member
    of staff's payroll record.
    """
    return re.search(rf"\b{re.escape(needle)}\b", text) is not None


def classify(payee: str) -> tuple[str, str, str, bool]:
    """Return (kind, display name, category, confident)."""
    low = " ".join((payee or "").lower().split())
    for needle, (kind, name, category) in KNOWN:
        if _mentions(low, needle):
            return kind, name, category, True
    if any(_mentions(low, word) for word in STAFF_WORDS):
        return "staff", payee, "Salary & Wages", True
    for needle, category in VENDOR_RULES:
        if needle in low:
            return "vendor", payee, category, True
    return "vendor", payee, "Misc", False


def _generic_payee(payee: str) -> bool:
    """Names HDFC substitutes for the actual PhonePe merchant."""
    low = " ".join((payee or "").lower().split())
    return any(value in low for value in (
        "xxxpgn", "kotak 811 otp", "payment from phone", "upi payment",
    ))


def group_parties(records: list[dict]) -> dict[str, list[dict]]:
    """Group payments by actual party, favouring UPI identity over bank text."""
    parent = list(range(len(records)))

    def root(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def join(left: int, right: int) -> None:
        left, right = root(left), root(right)
        if left != right:
            parent[right] = left

    by_vpa: dict[str, int] = {}
    by_name: dict[str, int] = {}
    for index, row in enumerate(records):
        vpa = usable_vpa(row["vpa"])
        if vpa:
            if vpa in by_vpa:
                join(index, by_vpa[vpa])
            else:
                by_vpa[vpa] = index

        # Repeated real names without a VPA are normally bank transfers.
        # HDFC's generic labels are not identities: joining them would merge
        # unrelated PhonePe merchants into one Misc vendor.
        name = normalise(row["payee"])
        if name and not _generic_payee(row["payee"]):
            if name in by_name:
                join(index, by_name[name])
            else:
                by_name[name] = index

    components: dict[int, list[dict]] = defaultdict(list)
    for index, row in enumerate(records):
        components[root(index)].append(row)

    groups: dict[str, list[dict]] = defaultdict(list)
    for rows in components.values():
        kind, name, _, confident = classify_group(rows)
        shown = display_name(rows)
        vpas = sorted({
            usable_vpa(row["vpa"]) for row in rows
        } - {None})
        # A generic HDFC label must never become a shared supplier identity.
        # Its VPA is the only safe grouping key until PhonePe supplies a name.
        identity = (f"upi:{vpas[0]}" if _generic_payee(shown) and vpas
                    else normalise(name if confident and name != shown else shown))
        groups[f"{kind}:{identity}"].extend(rows)
    return groups


def classify_group(rows: list[dict]) -> tuple[str, str, str, bool]:
    """Classify a party from all of its payments, not just the first one.

    Payees reach us spelled several ways: the bank truncates at 60
    characters and drops the role, PhonePe keeps it. Taking rows[0] alone
    would let a party's category disagree with the name shown against it.
    """
    ranked = sorted(
        ((classify(row["payee"]), row["payee"]) for row in rows),
        key=lambda item: (
            item[0][3],
            item[0][1] != item[1],
            not _generic_payee(item[1]),
            len(item[1]),
        ),
        reverse=True,
    )
    return ranked[0][0]


def display_name(rows: list[dict]) -> str:
    _, name, _, _ = classify_group(rows)
    if name not in {r["payee"] for r in rows}:
        return name
    # Prefer a recognisable merchant over an HDFC substitute such as XXXPGN.
    return max(
        (r["payee"] for r in rows),
        key=lambda value: (not _generic_payee(value), len(value)),
    )[:80]


# --------------------------------------------------------------------------
# writing


def build_database(records: list[dict], paytm_sales: dict[str, int],
                   target: Path, outlet_name: str, owner_password: str) -> dict:
    import os
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    os.environ["LEDGER_DATA_DIR"] = str(target.parent)
    os.environ["LEDGER_OWNER_PASSWORD"] = owner_password

    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from app import models  # noqa: F401  (registers every table)
    from app.costgroups import guess_group
    from app.db import Base
    from app.models import (Employee, Expense, ExpenseCategory, Outlet,
                            SalesDaily, User, Vendor)
    from app.seed import bootstrap

    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = target.with_name(f"{target.stem}-replaced-{stamp}.db")
        shutil.move(str(target), str(backup))
    else:
        backup = None

    engine = create_engine(f"sqlite:///{target}")
    Base.metadata.create_all(bind=engine)
    summary = {"backup": str(backup) if backup else "", "unsure": []}

    with Session(engine) as db:
        bootstrap(db)
        db.commit()

        outlet = db.query(Outlet).first()
        outlet.name = outlet_name
        for name, group in EXTRA_CATEGORIES:
            if not db.query(ExpenseCategory).filter_by(name=name).first():
                db.add(ExpenseCategory(name=name, cost_group=group, sort=900))
        db.commit()

        categories = {c.name: c for c in db.query(ExpenseCategory).all()}
        misc = categories["Misc"]
        owner = db.query(User).first()

        vendors: dict[str, Vendor] = {}
        employees: dict[str, Employee] = {}
        counts = {"expenses": 0, "vendors": 0, "employees": 0}

        for key, rows in sorted(group_parties(records).items()):
            kind = key.split(":", 1)[0]
            name = display_name(rows)
            _, _, category_name, confident = classify_group(rows)
            category = categories.get(category_name) or misc
            if category_name not in categories:
                confident = False

            vendor = employee = None
            vpas = sorted({usable_vpa(r["vpa"]) for r in rows} - {None})
            if kind == "staff":
                employee = employees.get(name)
                if not employee:
                    employee = Employee(name=name, is_active=True,
                                        outlet_id=outlet.id,
                                        upi_id=vpas[0] if vpas else "")
                    db.add(employee)
                    db.flush()
                    employees[name] = employee
                    counts["employees"] += 1
            else:
                vendor = vendors.get(name)
                if not vendor:
                    vendor = Vendor(name=name, is_active=True,
                                    notes=("UPI: " + ", ".join(vpas)) if vpas else "")
                    db.add(vendor)
                    db.flush()
                    vendors[name] = vendor
                    counts["vendors"] += 1

            if not confident:
                summary["unsure"].append({
                    "party": name,
                    "count": len(rows),
                    "total": round(sum(r["amount"] for r in rows), 2),
                })

            for row in rows:
                note = row["narration"][:200]
                if employee is not None:
                    note = f"Paid to {name}. {note}"
                db.add(Expense(
                    outlet_id=outlet.id,
                    business_date=row["date"].isoformat(),
                    category_id=category.id,
                    vendor_id=vendor.id if vendor else None,
                    amount_paise=int(round(row["amount"] * 100)),
                    mode="upi" if row["source"] == "phonepe"
                         or row["narration"].startswith("UPI-") else "bank",
                    description=note,
                    entered_by=owner.id if owner else None,
                ))
                counts["expenses"] += 1

        for business_date, amount_paise in paytm_sales.items():
            db.add(SalesDaily(
                outlet_id=outlet.id, business_date=business_date,
                channel_kind="aggregator", source="bank",
                amount_paise=amount_paise,
                note="Paytm settlement inferred from HDFC statement",
            ))

        db.commit()

    engine.dispose()
    summary.update(counts)
    summary["total"] = round(sum(r["amount"] for r in records), 2)
    summary["paytm_sales_days"] = len(paytm_sales)
    summary["paytm_sales_total"] = round(sum(paytm_sales.values()) / 100, 2)
    return summary


def rupees(amount: float) -> str:
    whole, fraction = divmod(round(abs(amount) * 100), 100)
    digits = str(whole)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        digits = ",".join(groups + [tail])
    sign = "-" if amount < 0 else ""
    return f"{sign}{digits}.{fraction:02d}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hdfc", required=True, type=Path)
    parser.add_argument("--phonepe", required=True, type=Path)
    parser.add_argument("--target", type=Path,
                        default=Path(__file__).resolve().parents[1] / "data" / "ledger.db")
    parser.add_argument("--from-date", default="2026-08-01")
    parser.add_argument("--account", default="1270",
                        help="last 4 digits of the business account")
    parser.add_argument("--outlet", default="Ootaa")
    parser.add_argument("--owner-password", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)

    since = date.fromisoformat(args.from_date)
    hdfc = read_hdfc(args.hdfc)
    phonepe = read_phonepe(args.phonepe)
    records = merge(hdfc, phonepe, since, args.account)
    paytm_sales = paytm_settlements(hdfc, since)

    print(f"HDFC rows    : {len(hdfc)}")
    print(f"PhonePe rows : {len(phonepe)}")
    print(f"Merged from {since}: {len(records)} payments, "
          f"Rs {rupees(sum(r['amount'] for r in records))}")
    print(f"Paytm settlement sales: {len(paytm_sales)} days, "
          f"Rs {rupees(sum(paytm_sales.values()) / 100)}")

    groups = group_parties(records)
    staff = {k: v for k, v in groups.items() if k.startswith("staff:")}
    vendors = {k: v for k, v in groups.items() if k.startswith("vendor:")}
    print(f"Parties: {len(vendors)} vendors, {len(staff)} staff")

    if not args.apply:
        by_category: dict[str, list[float]] = defaultdict(list)
        unsure = []
        for rows in groups.values():
            name = display_name(rows)
            _, _, category, confident = classify_group(rows)
            total = sum(r["amount"] for r in rows)
            by_category[category].append(total)
            if not confident:
                unsure.append((total, len(rows), name))

        print("\nBy category:")
        for category, amounts in sorted(by_category.items(),
                                        key=lambda i: -sum(i[1])):
            print(f"  {category:<24} {len(amounts):>3} parties  "
                  f"Rs {rupees(sum(amounts)):>12}")

        if unsure:
            print(f"\nWould be filed under Misc - please review these {len(unsure)}:")
            for total, count, name in sorted(unsure, reverse=True):
                print(f"  {name[:46]:<48} {count:>3}x  Rs {rupees(total):>12}")

        print("\nRehearsal only - no database written. Re-run with --apply.")
        return 0

    summary = build_database(records, paytm_sales, args.target, args.outlet,
                             args.owner_password)
    print(f"\nWritten to {args.target}")
    if summary["backup"]:
        print(f"Previous database kept at {summary['backup']}")
    print(f"  expenses  : {summary['expenses']}  "
          f"Rs {rupees(summary['total'])}")
    print(f"  vendors   : {summary['vendors']}")
    print(f"  employees : {summary['employees']}")
    print(f"  Paytm sales: {summary['paytm_sales_days']} days  "
          f"Rs {rupees(summary['paytm_sales_total'])}")
    if summary["unsure"]:
        print(f"\nFiled under Misc - please review these {len(summary['unsure'])}:")
        for item in sorted(summary["unsure"], key=lambda i: -i["total"]):
            print(f"  {item['party'][:46]:<48} {item['count']:>3}x  "
                  f"Rs {rupees(item['total']):>12}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
