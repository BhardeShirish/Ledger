"""An unknown /api path must fail like an API, not return the web page.

Runs in a subprocess because the SPA catch-all is only registered when
LEDGER_WEB_DIST is set at import time, and reloading app.main would disturb
the app object the other test modules already hold.
"""
import subprocess
import sys
import textwrap

CHILD = textwrap.dedent(
    """
    import json, os, sys, tempfile
    from pathlib import Path

    dist = Path(tempfile.mkdtemp()) / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><html>app shell</html>")
    (dist / "favicon.ico").write_text("icon")

    os.environ["LEDGER_WEB_DIST"] = str(dist)
    os.environ["LEDGER_DATA_DIR"] = tempfile.mkdtemp()
    os.environ["LEDGER_TESTING"] = "1"

    from fastapi.testclient import TestClient
    from app.main import app

    c = TestClient(app)
    out = {}
    for name, path in [("unknown_api", "/api/nope"), ("bare_api", "/api"),
                       ("spa_route", "/sales"), ("root", "/"),
                       ("static_file", "/favicon.ico"), ("health", "/api/health")]:
        r = c.get(path)
        out[name] = [r.status_code, r.headers.get("content-type", "")]
    print(json.dumps(out))
    """
)


def test_unknown_api_path_returns_json_404_not_the_web_page():
    proc = subprocess.run([sys.executable, "-c", CHILD], capture_output=True,
                          text=True, timeout=180)
    assert proc.returncode == 0, proc.stderr
    r = __import__("json").loads(proc.stdout.strip().splitlines()[-1])

    # The bug: these used to return 200 text/html, so a typo or a renamed
    # endpoint looked like success and blew up later as a JSON parse error.
    for key in ("unknown_api", "bare_api"):
        status, ctype = r[key]
        assert status == 404, f"{key} returned {status}"
        assert "application/json" in ctype, f"{key} returned {ctype}"

    # Real pages must still be served by the SPA fallback.
    for key in ("spa_route", "root"):
        status, ctype = r[key]
        assert status == 200 and "text/html" in ctype, f"{key} -> {status} {ctype}"

    assert r["static_file"][0] == 200
    assert r["health"][0] == 200 and "application/json" in r["health"][1]
