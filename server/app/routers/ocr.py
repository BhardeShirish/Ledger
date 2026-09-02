"""Bill-photo OCR → structured expense draft.

Pluggable providers:
  • openai_compat — any OpenAI-compatible vision endpoint (OpenAI, Ollama
    with qwen2.5-vl, Groq, OpenRouter…). Best for handwriting.
  • tesseract    — free local OCR; printed bills only.

Extraction is ADVISORY: results prefill the expense form for confirmation,
they never create records on their own."""
import base64
import asyncio
import ipaddress
import json
import re
import socket
from datetime import date
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..audit import get_setting_db
from ..db import get_db
from ..models import User
from ..security import current_user, require_owner
from ..util import today_iso

router = APIRouter(prefix="/ocr", tags=["ocr"])

ALLOWED_IMG = {".jpg", ".jpeg", ".png", ".webp"}

PROMPT = (
    "You are reading a photo of a shop purchase bill (may be handwritten, "
    "possibly Hindi/English mixed). Reply with ONLY this JSON object and "
    "nothing else — no markdown fences, no explanations:\n"
    '{"vendor_name": string|null, "date": "YYYY-MM-DD"|null, '
    '"total_rupees": number|null, "items": [{"name": string, "qty": number|null, '
    '"amount": number|null}], "confidence": "high|medium|low", '
    '"raw_summary": string}\n'
    "Rules: numbers are plain rupees without symbols; use null for anything "
    "unreadable; date must be ISO or null; do not invent values; keep items "
    "to at most 20 lines."
)


def _cfg(db: Session) -> dict:
    return {
        "enabled": bool(get_setting_db(db, "ocr_enabled", False)),
        "provider": get_setting_db(db, "ocr_provider", "openai_compat"),
        "base_url": (get_setting_db(db, "ocr_base_url", "") or "").rstrip("/"),
        "model": get_setting_db(db, "ocr_model", ""),
        "has_key": bool(get_setting_db(db, "ocr_api_key", "")),
        "key": get_setting_db(db, "ocr_api_key", "") or "",
    }


def _validate_remote_url(base_url: str, has_key: bool = False,
                         resolve: bool = True) -> str:
    parsed = urlsplit(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(422, "OCR URL must be an absolute HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise HTTPException(422, "OCR URL cannot contain credentials, query, or fragment")
    try:
        addresses = {ipaddress.ip_address(parsed.hostname)}
    except ValueError:
        if not resolve:
            addresses = set()
        else:
            try:
                addresses = {
                    ipaddress.ip_address(info[4][0])
                    for info in socket.getaddrinfo(parsed.hostname, parsed.port)
                }
            except socket.gaierror:
                raise HTTPException(422, "OCR host could not be resolved")
    unsafe = any(
        address.is_private or address.is_link_local or address.is_multicast
        or address.is_reserved or address.is_unspecified
        for address in addresses
    )
    is_loopback = addresses and all(address.is_loopback for address in addresses)
    if unsafe and not is_loopback:
        raise HTTPException(422, "OCR URL cannot target a private network address")
    if has_key and parsed.scheme != "https":
        raise HTTPException(422, "OCR API keys require an HTTPS endpoint")
    return base_url


@router.get("/status")
def status(user: User = Depends(current_user), db: Session = Depends(get_db)):
    c = _cfg(db)
    return {"configured": c["enabled"] and bool(c["base_url"]) and bool(c["model"]),
            "provider": c["provider"], "enabled": c["enabled"],
            "model": c["model"], "has_key": c["has_key"]}


class SaveIn(BaseModel):
    enabled: bool = False
    provider: str = "openai_compat"
    base_url: str = ""
    model: str = ""
    api_key: str | None = None      # empty → keep existing


@router.put("/config")
def save_config(body: SaveIn, user: User = Depends(require_owner),
                db: Session = Depends(get_db)):
    from ..audit import audit, set_setting_db

    if body.provider not in ("openai_compat", "tesseract"):
        raise HTTPException(422, "Unknown provider")
    base = body.base_url.strip().rstrip("/")
    # people paste the plain Gemini host — nudge it onto the OpenAI-compat path
    if "generativelanguage.googleapis.com" in base and not base.endswith("/openai"):
        base += "/openai"
    if body.provider == "openai_compat" and body.enabled:
        if not base:
            raise HTTPException(422, "OCR URL is required when enabled")
        _validate_remote_url(base, bool(body.api_key), resolve=False)
    old_base = (get_setting_db(db, "ocr_base_url", "") or "").rstrip("/")
    set_setting_db(db, "ocr_enabled", body.enabled, user.id)
    set_setting_db(db, "ocr_provider", body.provider, user.id)
    set_setting_db(db, "ocr_base_url", base, user.id)
    set_setting_db(db, "ocr_model", body.model.strip(), user.id)
    if body.api_key:                                   # write-only
        set_setting_db(db, "ocr_api_key",
                       body.api_key.strip().replace("\n", ""), user.id)
    elif base != old_base:
        # Never carry a secret over to a different host implicitly.
        set_setting_db(db, "ocr_api_key", "", user.id)
    audit(db, None, user.id, "ocr-config", "settings", "ocr",
          after={"enabled": body.enabled, "provider": body.provider})
    db.commit()
    return {"ok": True}


def _provider_headers(c: dict) -> dict:
    """Gemini accepts Bearer on its compat layer, but older paths want
    x-goog-api-key — sending both keeps every provider happy."""
    h = {}
    if c.get("key"):
        h["Authorization"] = f"Bearer {c['key']}"
        h["x-goog-api-key"] = c["key"]
    return h


# ── extraction ────────────────────────────────────────────────────────────

def _strip_fences(text: str) -> str:
    m = re.search(r"\{.*\}", text, re.S)
    return m.group(0) if m else text


def _repair_json(text: str):
    """Salvage JSON from chatty or TRUNCATED replies.

    Strategy: isolate from the first '{', then walk backwards cutting the
    tail at safe boundaries; at every step auto-close whatever brackets are
    still open (in the right order) and try to parse."""
    s = text.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"```\s*$", "", s).strip()
    start = s.find("{")
    if start == -1:
        return None
    s = s[start:]

    def closers_for(prefix: str) -> str:
        stack: list[str] = []
        pairs = {"}": "{", "]": "["}
        in_str = False
        esc = False
        for ch in prefix:
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch in "{[":
                stack.append(ch)
            elif ch in pairs and stack and stack[-1] == pairs[ch]:
                stack.pop()
        return "".join("]" if c == "[" else "}" for c in reversed(stack))

    attempts = [s]
    trimmed = s
    for _ in range(80):
        trimmed = trimmed.rstrip()
        if not trimmed.endswith("}") and not trimmed.endswith("]"):
            # drop a dangling partial token ("..., \"na" etc.)
            cut = max(trimmed.rfind(","), trimmed.rfind("{"), trimmed.rfind("["))
            if cut <= 0:
                break
            trimmed = trimmed[:cut]
        closed = trimmed + closers_for(trimmed)
        attempts.append(closed)
        cut = max(trimmed.rfind(","), trimmed.rfind("}"), trimmed.rfind("]"),
                  trimmed.rfind('"'))
        if cut <= 1:
            break
        trimmed = trimmed[:cut]
    for cand in attempts:
        try:
            return json.loads(cand)
        except Exception:
            continue
    return None


def _normalize(payload: dict) -> dict:
    """Coerce whatever came back into our safe shape. Pure function — tested."""
    def num(v):
        if v in (None, "", "null"):
            return None
        try:
            return round(float(re.sub(r"[₹,\s]", "", str(v))), 2)
        except ValueError:
            return None

    d = payload.get("date")
    d = str(d)[:10] if isinstance(d, str) and re.match(r"\d{4}-\d{2}-\d{2}", d[:10]) \
        else today_iso()
    total = num(payload.get("total_rupees"))
    items = []
    for it in (payload.get("items") or [])[:30]:
        if not isinstance(it, dict):
            continue
        name = str(it.get("name") or "").strip()
        if not name:
            continue
        items.append({"name": name[:120], "qty": num(it.get("qty")),
                      "amount": num(it.get("amount"))})
    conf = str(payload.get("confidence") or "low").lower()
    return {
        "vendor_name": (str(payload.get("vendor_name") or "").strip() or None),
        "date": d,
        "total_rupees": total,
        "items": items,
        "confidence": conf if conf in ("high", "medium", "low") else "low",
        "raw_summary": str(payload.get("raw_summary") or "")[:300],
    }


def _call_openai_compat(image_bytes: bytes, ext: str, mime: str, c: dict) -> dict:
    _validate_remote_url(c["base_url"], bool(c.get("key")))
    headers = _provider_headers(c)
    b64 = base64.b64encode(image_bytes).decode()
    url = f"{c['base_url']}/chat/completions"
    body = {
        "model": c["model"],
        "temperature": 0,
        "max_tokens": 2000,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url",
                 "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ],
        }],
    }
    if "gemini" in (c.get("model") or "").lower():
        body["response_format"] = {"type": "json_object"}   # supported on gemini compat
    try:
        r = httpx.post(url, json=body, headers=headers, timeout=120)
    except httpx.HTTPError as ex:
        raise HTTPException(502, f"Couldn't reach the vision endpoint: {ex}")
    if r.status_code != 200:
        raise HTTPException(502, f"Vision API said {r.status_code}: {r.text[:200]}")
    text = r.json()["choices"][0]["message"]["content"]
    if not isinstance(text, str):
        text = json.dumps(text) if text else ""
    payload = _repair_json(text)
    if payload is None:
        raise HTTPException(
            502,
            "Model reply wasn't valid JSON even after repair. "
            f"Reply started with: {text[:150]!r} - try again or switch model.")
    return payload


def _call_tesseract(image_bytes: bytes, ext: str) -> dict:
    try:
        import pytesseract
        from PIL import Image
        import io as _io
    except ImportError:
        raise HTTPException(501, "Tesseract not installed on the server. "
                                 "pip install pytesseract pillow + the "
                                 "Tesseract binary, or use a vision API.")
    img = Image.open(_io.BytesIO(image_bytes))
    if img.width * img.height > 40_000_000:
        raise HTTPException(413, "Image dimensions are too large")
    text = pytesseract.image_to_string(img)
    # best-effort total/vendor scrape from plain text
    total = None
    m = re.search(r"(?:total|amount|net)\D{0,10}([\d,]+(?:\.\d{1,2})?)",
                  text, re.I)
    if m:
        try:
            total = float(m.group(1).replace(",", ""))
        except ValueError:
            pass
    vendor = text.strip().splitlines()[0][:80] if text.strip() else None
    return {"vendor_name": vendor, "date": None, "total_rupees": total,
            "items": [], "confidence": "low",
            "raw_summary": text[:300]}


@router.get("/ping")
def ping(user: User = Depends(require_owner), db: Session = Depends(get_db)):
    """Save + one cheap call: verifies the key AND lists vision models."""
    c = _cfg(db)
    if c["provider"] != "openai_compat":
        raise HTTPException(409, "Ping applies to vision-API providers")
    if not c["base_url"]:
        raise HTTPException(409, "Base URL needed first")
    _validate_remote_url(c["base_url"], bool(c.get("key")))
    headers = _provider_headers(c)
    try:
        r = httpx.get(f"{c['base_url']}/models", headers=headers, timeout=25)
    except httpx.HTTPError as ex:
        return {"ok": False, "error": str(ex)[:250], "models": []}
    models: list[str] = []
    if r.status_code == 200:
        try:
            body = r.json()
            raw = body.get("data") or body.get("models") or []
            for m in raw:
                mid = (m.get("id") or m.get("name") or "") if isinstance(m, dict) else str(m)
                mid = mid.removeprefix("models/")
                if mid:
                    models.append(mid)
            models = sorted(set(models))
        except Exception:
            pass
    return {"ok": r.status_code == 200, "http_status": r.status_code,
            "body": "" if r.status_code == 200 else r.text[:300],
            "models": models}


@router.post("/extract")
async def extract(file: UploadFile, user: User = Depends(current_user),
                  db: Session = Depends(get_db)):
    c = _cfg(db)
    if not c["enabled"]:
        raise HTTPException(409, "OCR is off — enable it in Settings.")
    ext = "." + (file.filename or "").rsplit(".", 1)[-1].lower()
    ctype = (file.content_type or "").lower()
    if ext not in ALLOWED_IMG and not ctype.startswith("image/"):
        raise HTTPException(422, "Only image files (jpg/png/webp) can be read")
    raw = await file.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise HTTPException(413, "Image larger than 8 MB")
    mime = f"image/{ext.lstrip('.')}" if ext in ALLOWED_IMG \
        else (ctype or "image/jpeg")

    if c["provider"] == "tesseract":
        payload = _call_tesseract(raw, ext)
    else:
        if not c["base_url"] or not c["model"]:
            raise HTTPException(409, "Vision API not configured yet.")
        payload = await asyncio.to_thread(
            _call_openai_compat, raw, ext, mime, c,
        )

    result = _normalize(payload)
    result["bill_date"] = result["date"]
    result["date_is_today_default"] = (payload.get("date") in (None, "", "null"))
    return result
