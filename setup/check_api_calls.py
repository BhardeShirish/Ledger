"""Cross-check every API call the UI makes against the routes the server has.

A call to a path the server does not serve is a button that dies with a 404
the moment someone presses it - invisible until a customer finds it.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB, APP = ROOT / "web" / "src", ROOT / "server" / "app"

# ---- what the server serves -------------------------------------------------
routes = set()
for path in APP.rglob("*.py"):
    text = path.read_text(encoding="utf-8")
    prefix = ""
    m = re.search(r"APIRouter\([^)]*prefix\s*=\s*[\"']([^\"']+)", text, re.S)
    if m:
        prefix = m.group(1)
    for verb, route in re.findall(
            r"@router\.(get|post|patch|put|delete)\(\s*[\"']([^\"']*)", text):
        routes.add((verb.upper(), (prefix + route) or "/"))

# ---- what the UI calls ------------------------------------------------------
VERB = {"get": "GET", "post": "POST", "patch": "PATCH", "put": "PUT", "del": "DELETE"}
calls = set()
for path in list(WEB.rglob("*.tsx")) + list(WEB.rglob("*.ts")):
    if ".test." in path.name:
        continue
    text = path.read_text(encoding="utf-8")
    for verb, url in re.findall(r"api\.(get|post|patch|put|del)\(\s*[`\"']([^`\"'?]+)", text):
        calls.add((VERB[verb], url.rstrip("/") or "/", path.name))


def matches(verb, url):
    """A call matches a route when the literal parts line up, ${id} vs {id}."""
    for rverb, route in routes:
        if rverb != verb:
            continue
        pattern = re.sub(r"\{[^}]+\}", r"[^/]+", re.escape(route)
                         .replace(r"\{", "{").replace(r"\}", "}"))
        probe = re.sub(r"\$\{[^}]+\}", "X", url)
        if re.fullmatch(pattern, probe):
            return True
    return False


bad = sorted({(v, u, f) for v, u, f in calls if not matches(v, u)})
for verb, url, where in bad:
    print(f"NO ROUTE  {verb:6} /api{url}   (called from {where})")
print(f"\n{len(calls)} distinct UI calls, {len(routes)} server routes, {len(bad)} unmatched")
sys.exit(1 if bad else 0)
