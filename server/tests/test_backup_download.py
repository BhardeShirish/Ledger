"""The downloadable backup must contain everything committed up to the click.

It used to zip ledger.db straight off disk. In WAL mode that file alone is not
a database: with a reader holding a lock the checkpoint quietly reports busy
(it raises nothing), and the copied file opens as "database disk image is
malformed" - a backup the owner cannot restore from.
"""
import io
import sqlite3
import zipfile

from app.config import DB_PATH


def test_download_contains_data_committed_moments_earlier(client, tmp_path):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})

    outlet_id = client.get("/api/outlets").json()[0]["id"]
    category_id = client.get("/api/lists/categories").json()[0]["id"]
    marker = "BACKUP-MARKER-EXPENSE"

    # The reader must start BEFORE the expense is saved: its snapshot then
    # predates those pages, so the checkpoint cannot flush them into the main
    # file and a plain copy of that file loses them. A manager with a list
    # open while the owner clicks Download Backup is exactly this situation.
    reader = sqlite3.connect(str(DB_PATH))
    reader.execute("BEGIN")
    reader.execute("SELECT * FROM expenses").fetchall()
    try:
        created = client.post("/api/expenses/bulk", json={
            "outlet_id": outlet_id,
            "business_date": "2026-01-15",
            "category_id": category_id,
            "mode": "cash",
            "note": marker,
            "lines": [{"item_name": marker, "amount_rupees": 12.34}],
        })
        assert created.status_code == 201, created.text
        downloaded = client.get("/api/admin/backup/download")
    finally:
        reader.close()
    assert downloaded.status_code == 200, downloaded.text

    archive = zipfile.ZipFile(io.BytesIO(downloaded.content))
    assert "ledger.db" in archive.namelist()

    restored = tmp_path / "restored.db"
    restored.write_bytes(archive.read("ledger.db"))

    conn = sqlite3.connect(f"file:{restored}?mode=ro", uri=True)
    try:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        rows = conn.execute(
            "SELECT amount_paise FROM expenses WHERE item_name = ?", (marker,)
        ).fetchall()
    finally:
        conn.close()

    assert rows == [(1234,)], "the backup is missing an expense saved before it"

