"""Read a bank statement into expense candidates.

Every bank prints the same information differently, and all of them put
account details, addresses and disclaimers above the real table. So nothing
here trusts a fixed row or column position:

  * the file type is decided by its content, not its extension - banks label
    CSV and HTML downloads ".xls" all the time;
  * the header row is found by looking for the columns we actually need, and
    everything above it is ignored;
  * columns are matched by meaning ("Withdrawal Amt." / "Debit" / "Dr").

Only money leaving the account becomes an expense candidate. Credits are
returned separately so the caller can show them and ignore them.
"""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from html.parser import HTMLParser

MAX_BYTES = 25 * 1024 * 1024
MAX_ROWS = 50_000

# Column meanings, matched against squashed header text (see _squash).
COLUMNS: dict[str, tuple[str, ...]] = {
    "date": (
        "date", "txndate", "transactiondate", "trandate", "valuedate",
        "postingdate", "dateoftransaction", "bookingdate", "valuedt",
    ),
    "narration": (
        "narration", "description", "particulars", "remarks", "details",
        "transactionremarks", "transactiondetails", "transactiondescription",
        "narrationdescription",
    ),
    "debit": (
        "withdrawalamt", "withdrawalamount", "withdrawal", "withdrawals",
        "debit", "debitamount", "debitamt", "dr", "dramount", "paidout",
        "amountdebited", "withdrawalinr",
    ),
    "credit": (
        "depositamt", "depositamount", "deposit", "deposits", "credit",
        "creditamount", "creditamt", "cr", "cramount", "paidin",
        "amountcredited", "depositinr",
    ),
    "amount": ("amount", "txnamount", "transactionamount", "amountinr"),
    "drcr": ("drcr", "type", "transactiontype", "debitcredit", "crdr"),
    "ref": (
        "chqrefno", "refno", "referenceno", "reference", "chequeno", "chqno",
        "chequerefno", "transactionid", "utr", "utrno", "refchqno",
        "chequereferenceno",
    ),
    "balance": ("closingbalance", "balance", "runningbalance", "balanceinr"),
}

DATE_FORMATS = (
    "%d/%m/%y", "%d/%m/%Y", "%d-%m-%y", "%d-%m-%Y", "%d.%m.%y", "%d.%m.%Y",
    "%Y-%m-%d", "%d %b %Y", "%d-%b-%Y", "%d-%b-%y", "%d %B %Y", "%d/%b/%Y",
    "%m/%d/%Y", "%b %d, %Y",
)


@dataclass
class Txn:
    """One line of the statement."""
    date: str                     # ISO yyyy-mm-dd
    narration: str
    amount_paise: int             # always positive
    direction: str                # "debit" or "credit"
    ref: str = ""
    row_number: int = 0


@dataclass
class Statement:
    debits: list[Txn] = field(default_factory=list)
    credits: list[Txn] = field(default_factory=list)
    header_row: int = 0
    skipped_rows: int = 0
    columns: dict[str, int] = field(default_factory=dict)


def _squash(value: object) -> str:
    """Header text reduced to letters only, so 'Withdrawal Amt.' == 'withdrawalamt'."""
    return re.sub(r"[^a-z]", "", str(value or "").lower())


class _TableParser(HTMLParser):
    """Banks often serve an HTML table but name the file .xls."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._row is not None and self._cell is not None:
            self._row.append(" ".join("".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def _decode(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace")


def _rows_from_text(text: str) -> list[list[str]]:
    # Binary files that get this far are full of NULs, which the csv module
    # refuses outright. Dropping them turns a crash into "no transactions".
    text = text.replace("\x00", "")
    sample = "\n".join(text.splitlines()[:40])
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        delimiter = dialect.delimiter
    except csv.Error:
        counts = {d: sample.count(d) for d in (",", "\t", ";", "|")}
        delimiter = max(counts, key=counts.get) if any(counts.values()) else ","
    try:
        reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
        return [[(c or "").strip() for c in row] for row in reader]
    except csv.Error as exc:
        raise ValueError(f"This file could not be read as a table ({exc}).")


def _rows_from_xlsx(raw: bytes) -> list[list[object]]:
    from openpyxl import load_workbook

    book = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    try:
        sheet = book.worksheets[0]
        rows: list[list[object]] = []
        for row in sheet.iter_rows(values_only=True):
            rows.append(list(row))
            if len(rows) > MAX_ROWS:
                break
        return rows
    finally:
        book.close()


def _rows_from_xls(raw: bytes) -> list[list[object]]:
    try:
        import xlrd
    except ImportError as exc:  # pragma: no cover - depends on install
        raise ValueError(
            "This is an older Excel (.xls) file and the reader for it is not "
            "installed. Re-download the statement as CSV or Excel (.xlsx)."
        ) from exc

    book = xlrd.open_workbook(file_contents=raw)
    sheet = book.sheet_by_index(0)
    rows: list[list[object]] = []
    for index in range(min(sheet.nrows, MAX_ROWS)):
        values: list[object] = []
        for cell in sheet.row(index):
            # xlrd type 3 is a date serial number.
            if cell.ctype == 3:
                try:
                    values.append(datetime(*xlrd.xldate_as_tuple(cell.value,
                                                                 book.datemode)))
                    continue
                except Exception:
                    pass
            values.append(cell.value)
        rows.append(values)
    return rows


def read_grid(raw: bytes, filename: str = "") -> list[list[object]]:
    """Turn any supported statement download into a grid of cells."""
    if not raw:
        raise ValueError("The file is empty.")
    if len(raw) > MAX_BYTES:
        raise ValueError("That file is too large to read.")

    if raw[:4] == b"PK\x03\x04":
        try:
            return _rows_from_xlsx(raw)
        except Exception as exc:
            raise ValueError(
                "This looks like an Excel file but it could not be opened - "
                "it may be damaged or password protected."
            ) from exc
    if raw[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        try:
            return _rows_from_xls(raw)
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError(
                "This looks like an older Excel file but it could not be "
                "opened - it may be damaged or password protected."
            ) from exc

    text = _decode(raw)
    head = text[:4000].lower()
    if "<table" in head or "<tr" in head or head.lstrip().startswith("<!doctype html"):
        parser = _TableParser()
        parser.feed(text)
        if parser.rows:
            return [list(r) for r in parser.rows]
    return [list(r) for r in _rows_from_text(text)]


def _find_header(rows: list[list[object]]) -> tuple[int, dict[str, int]]:
    """Locate the real table header and ignore the bank's preamble above it."""
    best: tuple[int, dict[str, int]] | None = None
    for index, row in enumerate(rows[:80]):
        found: dict[str, int] = {}
        for position, cell in enumerate(row):
            squashed = _squash(cell)
            if not squashed:
                continue
            for meaning, names in COLUMNS.items():
                if meaning in found:
                    continue
                if squashed in names:
                    found[meaning] = position
        has_money = ("debit" in found or "credit" in found or "amount" in found)
        if "date" in found and has_money:
            score = len(found)
            if best is None or score > len(best[1]):
                best = (index, found)
    if best is None:
        raise ValueError(
            "Could not find the transaction table in this file. It needs a "
            "header row with a date column and a withdrawal/debit or amount "
            "column."
        )
    return best


def parse_date_cell(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    if not text:
        return None
    text = text.split()[0] if re.match(r"^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{2,4}\s", text) else text
    for fmt in DATE_FORMATS:
        try:
            parsed = datetime.strptime(text, fmt).date()
        except ValueError:
            continue
        # A two-digit year in a bank statement is this century.
        if parsed.year < 1970:
            return None
        return parsed.isoformat()
    return None


def parse_amount_cell(value: object) -> int | None:
    """Return paise, or None when the cell holds no usable number."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip()
        if not text or text in {"-", "--", "nil", "NIL"}:
            return None
        text = re.sub(r"(?i)\b(inr|rs\.?|dr|cr)\b", "", text)
        text = text.replace("\u20b9", "").replace(",", "").strip()
        text = text.replace("(", "-").replace(")", "")
        if not re.fullmatch(r"-?\d*\.?\d+", text):
            return None
        number = float(text)
    paise = int(round(abs(number) * 100))
    return paise or None


def _cell(row: list[object], index: int | None) -> object:
    if index is None or index >= len(row):
        return None
    return row[index]


def parse(raw: bytes, filename: str = "") -> Statement:
    """Parse a statement download into debits and credits."""
    rows = read_grid(raw, filename)
    header_index, columns = _find_header(rows)
    statement = Statement(header_row=header_index + 1, columns=columns)

    for offset, row in enumerate(rows[header_index + 1:], start=header_index + 2):
        if not any(str(c or "").strip() for c in row):
            continue
        iso = parse_date_cell(_cell(row, columns.get("date")))
        if not iso:
            # Footers, running totals and page breaks land here.
            statement.skipped_rows += 1
            continue

        narration = " ".join(str(_cell(row, columns.get("narration")) or "").split())
        ref = " ".join(str(_cell(row, columns.get("ref")) or "").split())
        if ref.endswith(".0"):
            ref = ref[:-2]

        debit = parse_amount_cell(_cell(row, columns.get("debit")))
        credit = parse_amount_cell(_cell(row, columns.get("credit")))

        if debit is None and credit is None and "amount" in columns:
            amount = parse_amount_cell(_cell(row, columns["amount"]))
            marker = str(_cell(row, columns.get("drcr")) or "").strip().lower()
            raw_amount = str(_cell(row, columns["amount"]) or "")
            negative = raw_amount.strip().startswith("-") or "(" in raw_amount
            if amount is not None:
                if marker.startswith(("d", "w")) or negative:
                    debit = amount
                elif marker.startswith(("c", "cr", "dep")):
                    credit = amount
                else:
                    debit = amount

        if debit is None and credit is None:
            statement.skipped_rows += 1
            continue

        if debit is not None:
            statement.debits.append(Txn(iso, narration, debit, "debit", ref, offset))
        if credit is not None:
            statement.credits.append(Txn(iso, narration, credit, "credit", ref, offset))

    if not statement.debits and not statement.credits:
        raise ValueError(
            "No transactions were found in this file. Please upload the "
            "account statement exactly as the bank produced it."
        )
    return statement


# --- Who was paid -----------------------------------------------------------
# A narration is a machine string with the payee buried inside it. Pulling that
# payee out is what lets the same shop be recognised across months and mapped
# once to a vendor and category.

VPA_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.\-_]{1,}@[A-Za-z]{2,}")
IFSC_RE = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
MASKED_RE = re.compile(r"^[0-9X*]+$", re.IGNORECASE)

# Words that describe the payment rail, not the payee. Kept deliberately
# narrow: anything that could plausibly be part of a shop's name (CASH, AND,
# INDIA...) must stay out, or "Metro Cash And Carry" becomes "Metro Carry".
NOISE = {
    "UPI", "NEFT", "RTGS", "IMPS", "ACH", "NACH", "POS", "ATW", "NWD", "TPT",
    "DR", "CR", "D", "C", "PAYMENT", "PAYMENTS", "PAY", "FROM", "PHONE",
    "TRANSFER", "TRF", "TO", "VIA", "REF", "MB", "IB", "INB",
    "BRN", "WDL", "EMI", "CHRG", "GST", "SI", "MMT",
    "COLLECT", "MANDATE", "AUTOPAY", "LTD", "PVT", "TXN", "TRANSACTION",
}

CHANNELS: tuple[tuple[str, str, str], ...] = (
    # (regex on upper-cased narration, channel, expense mode)
    (r"^\s*UPI[\s\-/]|\bUPI\b", "upi", "upi"),
    (r"^\s*(POS|ECOM|IPS)\b|\bPOS\s", "card", "card"),
    (r"\b(ATW|NWD|ATM|CASH\s*WDL|CWDR|EAW)\b", "atm", "cash"),
    (r"\b(NEFT|RTGS|IMPS|ACH|NACH|TPT|FT\s*-|MMT)\b", "bank", "bank"),
    (r"\b(CHRG|CHARGES?|FEE|AMB|SMS\s*CHG|GST)\b", "charge", "bank"),
)


def classify(narration: str) -> tuple[str, str]:
    """Return (channel, expense mode) for a narration."""
    text = (narration or "").upper()
    for pattern, channel, mode in CHANNELS:
        if re.search(pattern, text):
            return channel, mode
    return "other", "bank"


def _clean_name(text: str) -> str:
    # Single letters are kept: Indian firms are routinely named by initials
    # ("A R Kitchen Equipments"), and dropping them both mangles the name and
    # lets two different vendors collapse onto one key. The rail markers that
    # are single letters (D, C) are already listed in NOISE.
    words = [w for w in re.split(r"[^A-Za-z&.]+", text) if w]
    kept = [
        w for w in words
        if w.upper() not in NOISE and not re.fullmatch(r"[Xx]+", w)
    ]
    return " ".join(kept).strip(" .").title()


def counterparty(narration: str) -> tuple[str, str]:
    """Pull the payee out of a narration.

    Returns (match key, human label). The key is what rules are stored
    against, so it must stay identical for the same payee across statements -
    hence lower/upper-casing and dropping the transaction-specific digits.
    """
    text = (narration or "").strip()
    if not text:
        return "", ""

    channel, _ = classify(text)
    # These two are never a payee you'd map to a vendor, and their narrations
    # carry an ATM id or a month name that would otherwise fragment the key.
    if channel == "atm":
        return "ATM WITHDRAWAL", "Cash withdrawal (ATM)"
    if channel == "charge":
        return "BANK CHARGES", "Bank charges"

    parts = [p.strip() for p in re.split(r"[-|/]", text) if p.strip()]

    # A VPA identifies a payee exactly, so it beats any name guess. Look inside
    # each segment: searching the whole narration would swallow the hyphenated
    # segments before it.
    vpa = ""
    for part in parts:
        found = VPA_RE.search(part)
        if found and "@" in part:
            vpa = found.group(0).lower()
            break

    if not vpa:
        # A VPA can itself contain a hyphen (t.parvezansari-1@okhdfcbank), so it
        # gets torn across two segments above. Search the whole narration, then
        # drop any leading chunk dragged in from the field before it: a real VPA
        # field starts after a hyphen, never straight after a space.
        found = VPA_RE.search(text)
        if found:
            candidate, start = found.group(0), found.start()
            while start > 0 and text[start - 1] == " " and "-" in candidate:
                head, candidate = candidate.split("-", 1)
                start += len(head) + 1
            if "@" in candidate and not candidate.startswith("@"):
                vpa = candidate.lower()

    label = ""
    for part in parts:
        squashed = part.replace(" ", "")
        if "@" in part or IFSC_RE.match(squashed.upper()) or MASKED_RE.match(squashed):
            continue
        cleaned = _clean_name(part)
        if len(cleaned) >= 3:
            label = cleaned
            break

    if vpa:
        return vpa, label or vpa
    if label:
        return label.upper(), label

    fallback = " ".join(text.split())[:60]
    return fallback.upper(), fallback
