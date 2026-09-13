"""Merge a recovered Ledger database into the live one.

Written for the worst day: the installation folder was deleted and all that
survives is a salvaged ``ledger.db`` of unknown health. Two things follow
from that. The reader must not trust the file — a salvaged database can
fail ``integrity_check`` and still hold thousands of perfectly good rows on
the pages that survived, so rows are read one at a time and a corrupt page
costs that row rather than the whole table. And the writer must not trust
itself — every run happens inside one transaction that is rolled back
unless ``--apply`` is given, so the rehearsal and the real thing execute
the same code.

Rows are matched by what they mean, not by their old id: an outlet is its
name, an expense is its outlet, date, category, amount and description.
That is what makes the import idempotent, and it is the only way to merge
two databases whose autoincrement counters have long since diverged.

    python -m app.recovery_import --source "D:\\recovered\\ledger.db"
    python -m app.recovery_import --source "D:\\recovered\\ledger.db" --apply
"""
from __future__ import annotations

import argparse
import csv
import json
import shutil
import sqlite3
import sys
import zipfile
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

# Order matters: a table may only be imported once everything it points at
# has been mapped.
TABLES: list[str] = [
    "outlets",
    "expense_categories",
    "vendors",
    "employees",
    "expenses",
    "vendor_entries",
    "attendance",
    "advances",
    "day_closures",
    "sales_daily",
    "sales_bills",
]

# Users are deliberately not in TABLES: an account carries a password hash
# and a role, and re-creating one would be a privilege decision rather than
# a recovery. They are matched by username and otherwise left alone.

# column -> table it points at. None means "keep the row, drop the link":
# used where the reference is optional and unresolvable in isolation.
FOREIGN_KEYS: dict[str, dict[str, str | None]] = {
    "employees": {
        "outlet_id": "outlets",
        "default_shift_id": None,
        "backup_employee_id": None,
    },
    "expenses": {
        "outlet_id": "outlets",
        "category_id": "expense_categories",
        "vendor_id": "vendors",
        "entered_by": "users",
        "updated_by": "users",
    },
    "vendor_entries": {
        "vendor_id": "vendors",
        "outlet_id": "outlets",
        "expense_id": "expenses",
        "entered_by": "users",
    },
    "attendance": {
        "employee_id": "employees",
        "shift_id": None,
        "marked_by": "users",
    },
    "advances": {"employee_id": "employees", "created_by": "users"},
    "day_closures": {
        "outlet_id": "outlets",
        "closed_by": "users",
        "reopened_by": "users",
    },
    "sales_daily": {"outlet_id": "outlets"},
    "sales_bills": {"outlet_id": "outlets", "import_batch_id": None},
}

# What makes a row the same row in both databases. Columns are read after
# foreign keys have been remapped, so these compare like with like.
NATURAL_KEYS: dict[str, tuple[str, ...]] = {
    "outlets": ("name",),
    "expense_categories": ("name",),
    "vendors": ("name", "phone"),
    "employees": ("outlet_id", "name", "code"),
    "expenses": (
        "outlet_id",
        "business_date",
        "category_id",
        "amount_paise",
        "mode",
        "item_name",
        "description",
    ),
    "vendor_entries": (
        "vendor_id",
        "outlet_id",
        "date",
        "type",
        "amount_paise",
        "note",
    ),
    "attendance": ("employee_id", "business_date"),
    "advances": ("employee_id", "date", "amount_paise", "note"),
    "day_closures": ("outlet_id", "business_date"),
    "sales_daily": ("outlet_id", "business_date", "channel_kind", "source"),
    "sales_bills": ("outlet_id", "business_date", "invoice_no"),
}

# The live database is keyed by username; ids from a dead machine mean
# nothing here.
USER_KEY = ("username",)

# Columns whose date range is worth reporting, so the owner can see at a
# glance which days came back.
DATE_COLUMNS: dict[str, str] = {
    "expenses": "business_date",
    "vendor_entries": "date",
    "attendance": "business_date",
    "advances": "date",
    "day_closures": "business_date",
    "sales_daily": "business_date",
    "sales_bills": "business_date",
}

REPORT_COLUMNS = (
    "business_date",
    "outlet",
    "category",
    "vendor",
    "amount_paise",
    "mode",
    "item_name",
    "quantity",
    "unit",
    "description",
    "receipt_path",
)


class ImportError_(Exception):
    """A problem the owner must see, not a traceback."""


# ── reading a database that may be damaged ────────────────────────────────

def open_source(path: Path) -> sqlite3.Connection:
    """Open the recovered file strictly read-only.

    ``immutable=1`` is the fallback because a salvaged file often arrives
    without its -wal sidecar, and SQLite refuses a normal read-only open of
    a database whose journal it cannot replay.
    """
    uri = path.resolve().as_uri()
    for suffix in ("?mode=ro", "?immutable=1"):
        try:
            conn = sqlite3.connect(uri + suffix, uri=True)
            conn.row_factory = sqlite3.Row
            conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
            return conn
        except sqlite3.Error:
            continue
    raise ImportError_(
        f"{path} could not be opened as a SQLite database. "
        "Check the file header before going further."
    )


def integrity(conn: sqlite3.Connection) -> str:
    try:
        row = conn.execute("PRAGMA integrity_check").fetchone()
        return str(row[0]) if row else "unknown"
    except sqlite3.Error as exc:
        return f"unreadable ({exc})"


def table_columns(conn: sqlite3.Connection, table: str) -> dict[str, sqlite3.Row]:
    try:
        rows = conn.execute(f'PRAGMA table_info("{table}")').fetchall()
    except sqlite3.Error:
        return {}
    return {r["name"]: r for r in rows}


def read_rows(conn: sqlite3.Connection, table: str) -> Iterator[tuple[dict, str]]:
    """Yield every row that can still be read, plus a note for damaged ones.

    A single ``SELECT *`` is tried first because it is fast and is what will
    happen on a healthy file. When that raises — the signature of a corrupt
    page — the table is re-read one rowid at a time so the damage costs only
    the rows actually sitting on the bad pages.
    """
    try:
        for row in conn.execute(f'SELECT * FROM "{table}"'):
            yield dict(row), ""
        return
    except sqlite3.DatabaseError:
        pass

    try:
        ids = [r[0] for r in conn.execute(f'SELECT rowid FROM "{table}"')]
    except sqlite3.DatabaseError:
        # Even the rowid index is gone; walk the whole plausible range.
        try:
            top = conn.execute(f'SELECT MAX(rowid) FROM "{table}"').fetchone()[0]
        except sqlite3.DatabaseError:
            return
        ids = list(range(1, int(top or 0) + 1))

    for rowid in ids:
        try:
            row = conn.execute(
                f'SELECT * FROM "{table}" WHERE rowid = ?', (rowid,)
            ).fetchone()
        except sqlite3.DatabaseError as exc:
            yield {}, f"{table} rowid {rowid} unreadable: {exc}"
            continue
        if row is not None:
            yield dict(row), ""


# ── matching rows across the two databases ────────────────────────────────

def normalise(value: object) -> object:
    if isinstance(value, str):
        return " ".join(value.split()).casefold()
    if isinstance(value, bytes):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def natural_key(row: dict, columns: tuple[str, ...]) -> tuple:
    return tuple(normalise(row.get(c)) for c in columns)


def index_target(
    conn: sqlite3.Connection, table: str, columns: tuple[str, ...]
) -> dict[tuple, int]:
    present = table_columns(conn, table)
    if not present:
        return {}
    usable = tuple(c for c in columns if c in present)
    if not usable:
        return {}
    selected = ", ".join(f'"{c}"' for c in ("id",) + usable)
    index: dict[tuple, int] = {}
    for row in conn.execute(f'SELECT {selected} FROM "{table}"'):
        index.setdefault(natural_key(dict(row), usable), int(row["id"]))
    return index


def fallback_value(column: sqlite3.Row) -> object:
    """A value for a NOT NULL column the recovered database never had.

    Newer Ledger versions add columns; a database from an older build simply
    lacks them. Refusing the row over a column the owner never filled in
    would lose real money data over a schema detail.
    """
    declared = (column["type"] or "").upper()
    if "INT" in declared:
        return 0
    if any(t in declared for t in ("CHAR", "CLOB", "TEXT")):
        return ""
    if any(t in declared for t in ("REAL", "FLOA", "DOUB", "NUMERIC", "DEC")):
        return 0
    if "DATETIME" in declared or "TIMESTAMP" in declared:
        return datetime.now(timezone.utc).isoformat(sep=" ", timespec="seconds")
    if "BOOL" in declared:
        return 0
    return ""


# ── the import itself ─────────────────────────────────────────────────────

class Importer:
    def __init__(
        self,
        source: sqlite3.Connection,
        target: sqlite3.Connection,
        tables: list[str],
    ) -> None:
        self.source = source
        self.target = target
        self.tables = tables
        self.id_maps: dict[str, dict[int, int]] = {}
        self.stats: dict[str, dict[str, int]] = {}
        self.problems: list[str] = []
        self.dates: dict[str, list[str]] = {}
        self.expense_rows: list[dict] = []
        self._map_users()

    def _map_users(self) -> None:
        by_name = index_target(self.target, "users", USER_KEY)
        mapping: dict[int, int] = {}
        for row, problem in read_rows(self.source, "users"):
            if problem:
                self.problems.append(problem)
                continue
            found = by_name.get(natural_key(row, USER_KEY))
            if found is not None and row.get("id") is not None:
                mapping[int(row["id"])] = found
        self.id_maps["users"] = mapping

    def _label(self, table: str, target_id: int | None) -> str:
        if target_id is None:
            return ""
        try:
            row = self.target.execute(
                f'SELECT name FROM "{table}" WHERE id = ?', (target_id,)
            ).fetchone()
        except sqlite3.Error:
            return ""
        return str(row["name"]) if row else ""

    def run(self) -> None:
        for table in self.tables:
            self._import_table(table)

    def _import_table(self, table: str) -> None:
        stats = {
            "read": 0,
            "inserted": 0,
            "matched": 0,
            "skipped": 0,
            "unreadable": 0,
        }
        self.stats[table] = stats
        self.id_maps.setdefault(table, {})

        src_cols = table_columns(self.source, table)
        dst_cols = table_columns(self.target, table)
        if not src_cols:
            self.problems.append(f"{table}: not present in the recovered file")
            return
        if not dst_cols:
            self.problems.append(f"{table}: not present in the live database")
            return

        # Without a natural key there is no honest way to tell a row already
        # in the live database from a new one, so every row is treated as
        # new rather than silently matched on a meaningless id.
        key_cols = tuple(c for c in NATURAL_KEYS[table] if c in dst_cols)
        index = index_target(self.target, table, key_cols) if key_cols else {}
        shared = [c for c in src_cols if c in dst_cols and c != "id"]
        missing_required = [
            c
            for c, info in dst_cols.items()
            if c != "id"
            and info["notnull"]
            and info["dflt_value"] is None
            and c not in src_cols
        ]
        links = FOREIGN_KEYS.get(table, {})
        date_col = DATE_COLUMNS.get(table)
        seen_dates: list[str] = []

        for row, problem in read_rows(self.source, table):
            if problem:
                stats["unreadable"] += 1
                self.problems.append(problem)
                continue
            stats["read"] += 1

            resolved, reason = self._resolve_links(row, links, dst_cols)
            if reason:
                stats["skipped"] += 1
                self.problems.append(f"{table} row {row.get('id')}: {reason}")
                continue

            payload = {c: resolved.get(c, row.get(c)) for c in shared}
            payload.update({c: resolved[c] for c in resolved if c in dst_cols})
            for column in missing_required:
                payload.setdefault(column, fallback_value(dst_cols[column]))
            for column, info in dst_cols.items():
                if (
                    column in payload
                    and payload[column] is None
                    and info["notnull"]
                    and info["dflt_value"] is None
                ):
                    payload[column] = fallback_value(info)

            key = natural_key(payload, key_cols) if key_cols else None
            existing = index.get(key) if key_cols else None
            if existing is not None:
                stats["matched"] += 1
                if row.get("id") is not None:
                    self.id_maps[table][int(row["id"])] = existing
                continue

            try:
                new_id = self._insert(table, payload)
            except sqlite3.Error as exc:
                # One unsalvageable row must not cost the other thousands.
                stats["skipped"] += 1
                self.problems.append(f"{table} row {row.get('id')}: {exc}")
                continue

            if key_cols:
                index[key] = new_id
            stats["inserted"] += 1
            if row.get("id") is not None:
                self.id_maps[table][int(row["id"])] = new_id
            if date_col and payload.get(date_col):
                seen_dates.append(str(payload[date_col]))
            if table == "expenses":
                self._record_expense(payload)

        if seen_dates:
            self.dates[table] = [min(seen_dates), max(seen_dates)]

    def _resolve_links(
        self,
        row: dict,
        links: dict[str, str | None],
        dst_cols: dict[str, sqlite3.Row],
    ) -> tuple[dict, str]:
        resolved: dict[str, object] = {}
        for column, points_at in links.items():
            if column not in dst_cols:
                continue
            raw = row.get(column)
            if raw is None:
                resolved[column] = None
                continue
            if points_at is None:
                resolved[column] = None
                continue
            mapped = self.id_maps.get(points_at, {}).get(int(raw))
            if mapped is None:
                if dst_cols[column]["notnull"]:
                    return {}, (
                        f"{column} pointed at {points_at} id {raw}, "
                        "which could not be recovered"
                    )
                resolved[column] = None
                continue
            resolved[column] = mapped
        return resolved, ""

    def _insert(self, table: str, payload: dict) -> int:
        columns = list(payload)
        placeholders = ", ".join("?" for _ in columns)
        names = ", ".join(f'"{c}"' for c in columns)
        cursor = self.target.execute(
            f'INSERT INTO "{table}" ({names}) VALUES ({placeholders})',
            [payload[c] for c in columns],
        )
        return int(cursor.lastrowid)

    def _record_expense(self, payload: dict) -> None:
        self.expense_rows.append(
            {
                "business_date": payload.get("business_date", ""),
                "outlet": self._label("outlets", payload.get("outlet_id")),
                "category": self._label(
                    "expense_categories", payload.get("category_id")
                ),
                "vendor": self._label("vendors", payload.get("vendor_id")),
                "amount_paise": payload.get("amount_paise", 0),
                "mode": payload.get("mode", ""),
                "item_name": payload.get("item_name", ""),
                "quantity": payload.get("quantity", ""),
                "unit": payload.get("unit", ""),
                "description": payload.get("description", ""),
                "receipt_path": payload.get("receipt_path") or "",
            }
        )


# ── plumbing ──────────────────────────────────────────────────────────────

def snapshot(target: Path, destination: Path) -> Path:
    """Copy the live database with SQLite's own backup API.

    A file copy of a WAL database can land on disk mid-checkpoint and be
    unopenable, which is precisely the failure this whole script exists to
    undo.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(target)
    try:
        copy = sqlite3.connect(destination)
        try:
            source.backup(copy)
        finally:
            copy.close()
    finally:
        source.close()
    return destination


def write_report(directory: Path, summary: dict, expenses: list[dict]) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    (directory / f"import-summary-{stamp}.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    csv_path = directory / f"imported-expenses-{stamp}.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(REPORT_COLUMNS))
        writer.writeheader()
        for row in expenses:
            writer.writerow({c: row.get(c, "") for c in REPORT_COLUMNS})
    return directory / f"import-summary-{stamp}.json"


SQLITE_MAGIC = b"SQLite format 3\x00"


LEDGER_TABLES = ("expenses", "expense_categories", "outlets")


def is_ledger_database(path: Path) -> bool:
    """Is this one of *our* databases?

    A deep scan of a Windows disk returns every SQLite file on it — search
    indexes, credential stores, USN journals. They are not damaged Ledgers,
    they are somebody else's data, and the only honest test is whether the
    schema is ours.
    """
    try:
        conn = open_source(path)
    except ImportError_:
        return False
    try:
        names = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
    except sqlite3.Error:
        return False
    finally:
        conn.close()
    return all(table in names for table in LEDGER_TABLES)


def find_databases(folder: Path) -> tuple[list[Path], int]:
    """Every Ledger database under a folder, biggest first.

    Recovery leaves a pile of fragments with arbitrary names and extensions,
    so the header is the only trustworthy way to tell a database from a log.
    Biggest first because the largest surviving copy is the likeliest to be
    the most complete, and later fragments then only add what it missed.
    """
    found: list[tuple[int, Path]] = []
    strangers = 0
    for path in sorted(folder.rglob("*")):
        if not path.is_file():
            continue
        try:
            size = path.stat().st_size
            if size < 512:
                continue
            with path.open("rb") as handle:
                if handle.read(16) != SQLITE_MAGIC:
                    continue
        except OSError:
            continue
        if not is_ledger_database(path):
            strangers += 1
            continue
        found.append((size, path))
    return [p for _, p in sorted(found, key=lambda item: -item[0])], strangers


UNPACK_DIRNAME = "_unpacked"


def unpack_archives(folder: Path) -> list[Path]:
    """Pull database-looking entries out of any zip lying in the folder.

    Forensic tools hand back evidence as archives, and the surviving copy of
    the ledger is usually a single entry inside a very large zip. Only
    plausible database entries are extracted, so a 1 GB evidence bundle does
    not get unpacked in full to find a 2 MB file.
    """
    destination_root = folder / UNPACK_DIRNAME
    extracted: list[Path] = []
    for archive in sorted(folder.rglob("*.zip")):
        if UNPACK_DIRNAME in archive.parts:
            continue
        try:
            with zipfile.ZipFile(archive) as bundle:
                entries = [
                    info
                    for info in bundle.infolist()
                    if not info.is_dir()
                    and info.file_size >= 512
                    and Path(info.filename).suffix.lower()
                    in {".db", ".sqlite", ".sqlite3", ".db3"}
                ]
                for info in entries:
                    relative = Path(info.filename)
                    if relative.is_absolute() or ".." in relative.parts:
                        continue
                    out = destination_root / archive.stem / relative
                    if out.exists():
                        extracted.append(out)
                        continue
                    out.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.open(info) as src, out.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
                    extracted.append(out)
        except (zipfile.BadZipFile, OSError, RuntimeError):
            # A truncated evidence bundle is expected; the loose files and
            # the readable archives still have to be imported.
            continue
    return extracted


MONEY_OUT = (
    (
        "expenses",
        "SELECT substr(business_date, 1, 7), COUNT(*),"
        " COALESCE(SUM(amount_paise), 0) FROM expenses"
        " WHERE business_date IS NOT NULL AND business_date <> ''"
        " GROUP BY 1 ORDER BY 1",
    ),
    (
        "vendor credit",
        # Only purchases, never the payments that settle them, or the same
        # rupee is counted twice. Entries already linked to an expense row
        # are left out for the same reason.
        "SELECT substr(date, 1, 7), COUNT(*),"
        " COALESCE(SUM(amount_paise), 0) FROM vendor_entries"
        " WHERE type = 'purchase_credit' AND expense_id IS NULL"
        " AND date IS NOT NULL AND date <> ''"
        " GROUP BY 1 ORDER BY 1",
    ),
    (
        "staff advances",
        "SELECT substr(date, 1, 7), COUNT(*),"
        " COALESCE(SUM(amount_paise), 0) FROM advances"
        " WHERE date IS NOT NULL AND date <> ''"
        " GROUP BY 1 ORDER BY 1",
    ),
)


def money_out_totals(conn: sqlite3.Connection) -> dict[str, dict[str, tuple[int, int]]]:
    """Money that left the till, by source and month: how many, how much.

    The owner remembers a total, not a row count, so the only honest way to
    show what came back is money. Reported before and after the merge so the
    difference is visible rather than asserted.

    Three sources, not one: a restaurant's spending sits partly in expenses,
    partly in unpaid vendor purchases, partly in advances handed to staff.
    Reporting expenses alone would make a complete database look short.
    """
    totals: dict[str, dict[str, tuple[int, int]]] = {}
    for label, sql in MONEY_OUT:
        try:
            rows = conn.execute(sql).fetchall()
        except sqlite3.Error:
            continue  # An older fragment may not have this table at all.
        found = {str(r[0]): (int(r[1]), int(r[2])) for r in rows}
        if found:
            totals[label] = found
    return totals


def rupees(paise: int) -> str:
    """Indian digit grouping, because 9,00,000 is the number he remembers."""
    whole, fraction = divmod(abs(int(paise)), 100)
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
    sign = "-" if paise < 0 else ""
    return f"{sign}{digits}.{fraction:02d}"


def import_database(
    source_path: Path,
    target_path: Path,
    *,
    apply: bool = False,
    tables: list[str] | None = None,
) -> dict:
    return import_databases([source_path], target_path, apply=apply, tables=tables)


def import_databases(
    sources: list[Path],
    target_path: Path,
    *,
    apply: bool = False,
    tables: list[str] | None = None,
) -> dict:
    """Merge every recovered fragment into the live database in one go.

    All fragments share a single transaction and each one re-reads the
    target before it starts, so a row present in two fragments is written
    once and the result is the union of everything that survived rather
    than whichever copy happened to be opened last.
    """
    if not sources:
        raise ImportError_("No recovered database found to import.")
    if not target_path.is_file():
        raise ImportError_(f"Live database not found: {target_path}")

    wanted = tables or TABLES
    totals: dict[str, dict[str, int]] = {}
    spans: dict[str, list[str]] = {}
    problems: list[str] = []
    expense_rows: list[dict] = []
    health: dict[str, str] = {}

    target = sqlite3.connect(target_path)
    target.row_factory = sqlite3.Row
    try:
        target.execute("PRAGMA foreign_keys = ON")
        before_totals = money_out_totals(target)
        target.execute("BEGIN IMMEDIATE")
        for source_path in sources:
            if not source_path.is_file():
                raise ImportError_(f"Recovered database not found: {source_path}")
            if source_path.resolve() == target_path.resolve():
                raise ImportError_("Source and target are the same file.")
            source = open_source(source_path)
            try:
                health[str(source_path)] = integrity(source)
                importer = Importer(source, target, wanted)
                importer.run()
            finally:
                source.close()

            for table, stats in importer.stats.items():
                bucket = totals.setdefault(
                    table,
                    {"read": 0, "inserted": 0, "matched": 0,
                     "skipped": 0, "unreadable": 0},
                )
                for name, value in stats.items():
                    bucket[name] += value
            for table, (low, high) in importer.dates.items():
                span = spans.setdefault(table, [low, high])
                span[0] = min(span[0], low)
                span[1] = max(span[1], high)
            problems.extend(
                f"{source_path.name}: {p}" for p in importer.problems
            )
            expense_rows.extend(importer.expense_rows)

        # Read inside the transaction, so a rehearsal still shows the total
        # the owner would end up with.
        after_totals = money_out_totals(target)
        if apply:
            target.commit()
        else:
            target.rollback()
    except Exception:
        target.rollback()
        raise
    finally:
        target.close()

    return {
        "sources": [str(p) for p in sources],
        "target": str(target_path),
        "applied": apply,
        "source_integrity": health,
        "tables": totals,
        "date_ranges": spans,
        "problems": problems,
        "money_out_before": before_totals,
        "money_out_after": after_totals,
        "expenses": expense_rows,
    }


def default_target() -> Path:
    from .config import DB_PATH

    return Path(DB_PATH)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Merge a recovered Ledger database into the live one."
    )
    parser.add_argument("--source", type=Path, default=None)
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=None,
        help="Folder of recovered fragments. Every SQLite file inside is "
             "merged, largest first.",
    )
    parser.add_argument("--target", type=Path, default=None)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write the changes. Without it nothing is saved.",
    )
    parser.add_argument("--report-dir", type=Path, default=None)
    parser.add_argument(
        "--only",
        default="",
        help="Comma-separated table names, e.g. expenses.",
    )
    args = parser.parse_args(argv)

    target = args.target or default_target()
    if not args.source and not args.source_dir:
        print("Give --source <file> or --source-dir <folder>.", file=sys.stderr)
        return 2

    tables = None
    if args.only:
        wanted = {t.strip() for t in args.only.split(",") if t.strip()}
        unknown = wanted - set(TABLES)
        if unknown:
            print(f"Unknown table(s): {', '.join(sorted(unknown))}", file=sys.stderr)
            return 2
        tables = [t for t in TABLES if t in wanted]

    try:
        sources: list[Path] = []
        if args.source_dir:
            if not args.source_dir.is_dir():
                raise ImportError_(f"Folder not found: {args.source_dir}")
            staged = unpack_archives(args.source_dir)
            if staged:
                print(f"Pulled {len(staged)} database(s) out of zip archives.")
            sources, strangers = find_databases(args.source_dir)
            if strangers:
                print(
                    f"Ignored {strangers} SQLite file(s) that are not Ledger "
                    "databases."
                )
            if not sources:
                raise ImportError_(
                    f"No Ledger database found under {args.source_dir}."
                )
            print(f"Found {len(sources)} recovered Ledger database(s):")
            for path in sources:
                print(f"  {path.stat().st_size:>12,} bytes  {path}")
        if args.source:
            sources.insert(0, args.source)

        if args.apply:
            kept = snapshot(
                target,
                target.parent
                / "backups"
                / f"pre-import-{datetime.now():%Y%m%d-%H%M%S}.db",
            )
            print(f"Live database copied to {kept} before writing.")
        result = import_databases(
            sources, target, apply=args.apply, tables=tables
        )
    except ImportError_ as exc:
        print(str(exc), file=sys.stderr)
        return 1

    report_dir = args.report_dir or (target.parent / "import-reports")
    summary = {k: v for k, v in result.items() if k != "expenses"}
    summary["problems"] = result["problems"][:500]
    summary["problem_count"] = len(result["problems"])
    report = write_report(report_dir, summary, result["expenses"])

    print("Recovered file integrity:")
    for name, verdict in result["source_integrity"].items():
        print(f"  {verdict:<12} {name}")
    for table, stats in result["tables"].items():
        span = result["date_ranges"].get(table)
        window = f"  {span[0]} to {span[1]}" if span else ""
        print(
            f"{table:<20} read {stats['read']:>6}  "
            f"new {stats['inserted']:>6}  already there {stats['matched']:>6}  "
            f"skipped {stats['skipped']:>4}  unreadable {stats['unreadable']:>4}"
            f"{window}"
        )
    if result["problems"]:
        print(f"{len(result['problems'])} row-level problems listed in the report.")

    before = result["money_out_before"]
    after = result["money_out_after"]
    if after:
        print("\nMoney out by month (rupees):")
        grand_before = grand_after = 0
        for label in [k for k, _ in MONEY_OUT if k in before or k in after]:
            was_all = before.get(label, {})
            now_all = after.get(label, {})
            print(f"\n  {label}")
            print(f"    {'month':<9}{'in Ledger now':>18}{'after this merge':>20}")
            for month in sorted(set(was_all) | set(now_all)):
                was = was_all.get(month, (0, 0))
                now = now_all.get(month, (0, 0))
                marker = "  <-- recovered" if now[1] != was[1] else ""
                print(
                    f"    {month:<9}{rupees(was[1]):>18}{rupees(now[1]):>20}{marker}"
                )
            sub_before = sum(v[1] for v in was_all.values())
            sub_after = sum(v[1] for v in now_all.values())
            rows_before = sum(v[0] for v in was_all.values())
            rows_after = sum(v[0] for v in now_all.values())
            print(
                f"    {'all':<9}{rupees(sub_before):>18}{rupees(sub_after):>20}"
                f"   ({rows_before} -> {rows_after} entries)"
            )
            grand_before += sub_before
            grand_after += sub_after
        print(
            f"\n  TOTAL money out{rupees(grand_before):>21}{rupees(grand_after):>20}"
        )
        print("  (expenses + unpaid vendor purchases + staff advances)")

    print(f"\nReport written to {report.parent}")
    if not result["applied"]:
        print("\nRehearsal only - nothing was saved. Re-run with --apply to keep it.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
