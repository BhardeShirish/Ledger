import asyncio
import os
import traceback
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

os.environ.setdefault("TZ", "Asia/Kolkata")

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402

from .config import DATA_DIR, ensure_dirs  # noqa: E402
from .backup import run_daily_backup  # noqa: E402
from .db import Base, SessionLocal, engine  # noqa: E402
from .models import migrate  # noqa: E402
from .routers import (advances, admin, advisor, attendance, auth, bank, dataio,
                      dayclose, expenses, imports, insights, inventory, lists,
                      losses, ocr, outlets, patterns, payroll, pnl, recurring, reports,
                      sales,
                      stats, staff, uploads, users, vendors)
from .seed import bootstrap, demo_seed  # noqa: E402

LOG_FILE = DATA_DIR / "server.log"


def log_exc(request: Request, exc: Exception) -> None:
    """Every unhandled 500 lands here with the full traceback — no more
    blind 'Request failed (500)'."""
    ensure_dirs()
    if LOG_FILE.exists() and LOG_FILE.stat().st_size > 5 * 1024 * 1024:
        rotated = LOG_FILE.with_suffix(".log.1")
        rotated.unlink(missing_ok=True)
        LOG_FILE.replace(rotated)
    with LOG_FILE.open("a", encoding="utf-8") as fh:
        request_id = getattr(request.state, "request_id", "unknown")
        fh.write(
            f"\n==== {request_id} {request.method} {request.url.path} ====\n"
        )
        fh.write(traceback.format_exc())


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    Base.metadata.create_all(bind=engine)
    migrate(engine)
    db = SessionLocal()
    try:
        info = bootstrap(db)
        if os.environ.get("LEDGER_DEMO_SEED") == "1":
            demo_seed(db)
        if info.get("user"):
            print(f"[ledger] first run: owner '{info['owner_username']}' created "
                  f"with env/default password — change it after first login.")
    finally:
        db.close()

    keeper = None
    if os.environ.get("LEDGER_TESTING") != "1":
        keeper = asyncio.create_task(_backup_keeper())
    try:
        yield
    finally:
        if keeper:
            keeper.cancel()


async def _backup_keeper():
    """Snapshot on every start, then keep checking so a laptop that stays on
    for weeks still gets a copy each day."""
    while True:
        made = await asyncio.to_thread(run_daily_backup)
        if made:
            print(f"[ledger] daily backup written: {made}")
        await asyncio.sleep(6 * 60 * 60)


app = FastAPI(title="Ootaa Ledger", lifespan=lifespan,
              docs_url="/api/docs", openapi_url="/api/openapi.json")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    request.state.request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    docs = request.url.path in {"/api/docs", "/api/openapi.json"}
    script_src = (
        "'self' 'unsafe-inline' https://cdn.jsdelivr.net"
        if docs else "'self'"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = (
        "camera=(self), microphone=(), geolocation=()"
    )
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        f"script-src {script_src}; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "font-src 'self'; img-src 'self' data: blob:; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; "
        "form-action 'self'"
    )
    if request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains"
        )
    if request.url.path.startswith("/api/auth"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(IntegrityError)
async def duplicate_write(request: Request, exc: IntegrityError):
    """Two saves of the same record landing together is a collision, not a crash.

    Several endpoints look a row up and insert it if it is missing. When two
    devices (or a Save click and the blur it causes) do that at the same
    moment, the second insert trips a unique index. That is the users'
    situation, so tell them what happened instead of showing a 500 that reads
    like their data was lost.
    """
    log_exc(request, exc)
    return JSONResponse(status_code=409, content={
        "detail": "Someone saved this at the same time. "
                  "Reload the page to see the latest values, then try again.",
    })


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    log_exc(request, exc)
    return JSONResponse(status_code=500,
                        content={"detail": "Internal server error. Check server.log."})

WEB_DIST = Path(os.environ.get("LEDGER_WEB_DIST", ""))  # set by the launcher


API_PREFIX = "/api"
for mod in (auth, users, outlets, staff, attendance, dayclose, expenses,
            vendors, advances, sales, imports, payroll, lists, stats,
            insights, inventory, reports, admin, uploads, dataio, ocr, bank,
            losses, advisor, patterns, pnl, recurring):
    app.include_router(mod.router, prefix=API_PREFIX)


@app.get("/api/health")
def health():
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return {"ok": True}


if WEB_DIST and (WEB_DIST / "index.html").exists():
    WEB_ROOT = WEB_DIST.resolve()

    if (WEB_DIST / "assets").exists():
        # Asset filenames carry a content hash, so a name never changes meaning
        # and may be cached hard. index.html below must NOT be, or the browser
        # keeps asking for chunk names that no longer exist after an update.
        app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    def _index() -> FileResponse:
        return FileResponse(
            WEB_ROOT / "index.html",
            headers={"Cache-Control": "no-store, must-revalidate"},
        )

    @app.get("/{path:path}")
    def spa(path: str):
        # An unknown /api path must fail like an API, not silently return the
        # web page with 200 - that turns a typo into a confusing parse error.
        if path == "api" or path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": "Not found"})
        # '..' in the request must not reach outside the built web bundle:
        # server/data sits two levels up and holds the database and the token
        # signing key. resolve() collapses the traversal so it can be rejected.
        candidate = (WEB_ROOT / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(WEB_ROOT):
            return FileResponse(candidate)
        return _index()
