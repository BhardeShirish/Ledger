"""Catch UI calls that omit a query param the server marks required.

This is the check that found the Analytics 422: the page called
/inventory/dish-profitability without outlet_id, and the handler demanded
it, so the chart area showed "field required" instead of a chart.

Nothing else catches this. sweep_live_copy.py fills each route's required
params from the spec itself, so it proves the handler works — and hides the
fact that the UI never sends them.

Run from the repo root:  python setup/check_required_params.py
Exits 1 if any UI call is missing a required param.
"""
from __future__ import annotations

import io
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web" / "src"

sys.path.insert(0, str(ROOT / "server"))


def openapi_required() -> dict[tuple[str, str], set[str]]:
    """{(method, path): {required query param names}} from the live app."""
    from app.main import app  # noqa: E402  (needs the sys.path line above)

    spec = app.openapi()
    out: dict[tuple[str, str], set[str]] = {}
    for path, ops in spec["paths"].items():
        for method, op in ops.items():
            need = {
                p["name"]
                for p in op.get("parameters", [])
                if p.get("in") == "query" and p.get("required")
            }
            out[(method.upper(), path)] = need
    return out


# api.get(`/foo?a=1` + (x ? `&b=2` : "")) — the call may span several lines and
# concatenate several template chunks, so grab everything up to the closing
# paren of the api.* call and pull every `...` chunk out of it.
CALL = re.compile(
    r"""api\.(get|post|patch|put|del|delete)\s*[(<]""", re.VERBOSE)


def ui_calls():
    """Yield (file, line, METHOD, url_text) for every api.* call."""
    for f in sorted(WEB.rglob("*.ts*")):
        text = f.read_text(encoding="utf-8")
        for m in CALL.finditer(text):
            method = m.group(1).upper()
            method = {"DEL": "DELETE"}.get(method, method)
            # walk forward balancing parens to find the end of the call
            i = text.find("(", m.end() - 1)
            if i < 0:
                continue
            depth, j = 0, i
            while j < len(text):
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            body = text[i:j]
            line = text.count("\n", 0, m.start()) + 1
            yield f, line, method, body


def path_of(url: str) -> str:
    """Strip the query string and turn ${...} into an OpenAPI {param}."""
    url = url.split("?", 1)[0]
    return re.sub(r"\$\{[^}]*\}", "{x}", url)


def normalise(p: str) -> str:
    return re.sub(r"\{[^}]*\}", "{x}", p)


def main() -> int:
    spec = openapi_required()
    by_path: dict[tuple[str, str], set[str]] = {
        (m, normalise(p)): need for (m, p), need in spec.items()
    }

    problems = []
    for f, line, method, body in ui_calls():
        chunks = [(m.start(1), m.group(1)) for m in re.finditer(r"`([^`]*)`", body)]
        if not chunks:
            continue
        url = "".join(c for _, c in chunks)   # whole URL, for path matching
        if not url.startswith("/"):
            continue
        key = (method, normalise("/api" + path_of(url)))
        need = by_path.get(key)
        if need is None:
            continue

        # A chunk glued on behind a ternary or && is only *sometimes* sent —
        # `...` + (outletId ? `&outlet_id=${outletId}` : "") means the param
        # is absent whenever outletId is null. Counting it as sent is what
        # let the real bug through, so only unconditional chunks count.
        sent: set[str] = set()
        prev_end = 0
        for idx, (pos, chunk) in enumerate(chunks):
            gap = body[prev_end:pos]
            conditional = idx > 0 and re.search(r"[?]|&&|\|\|", gap)
            if not conditional:
                sent |= set(re.findall(r"[?&]([A-Za-z_][A-Za-z0-9_]*)=", chunk))
            prev_end = pos + len(chunk)

        missing = need - sent
        if missing:
            problems.append(
                (f.relative_to(ROOT), line, method, path_of(url), sorted(missing)))

    if not problems:
        print("OK — every UI call sends the params its endpoint requires.")
        return 0
    print(f"{len(problems)} call(s) missing a required query param:\n")
    for f, line, method, path, missing in problems:
        print(f"  {f}:{line}  {method} {path}  missing: {', '.join(missing)}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
