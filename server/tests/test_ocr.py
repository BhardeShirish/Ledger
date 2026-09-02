"""OCR: config security, normalization robustness, extraction flow."""

from app.routers.ocr import _normalize, _strip_fences

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def test_normalize_handles_messy_model_output():
    raw = {
        "vendor_name": "  Sharma Kirana  ",
        "date": None,
        "total_rupees": "₹1,250.50",
        "items": [
            {"name": "Rice 5kg", "qty": "5", "amount": "450"},
            {"name": "", "qty": None, "amount": None},       # dropped
            "garbage",                                        # dropped
        ],
        "confidence": "HIGH",
        "raw_summary": "x" * 500,
    }
    n = _normalize(raw)
    assert n["vendor_name"] == "Sharma Kirana"
    assert n["date"] == n["date"]            # today fallback, ISO
    assert len(n["date"]) == 10
    assert n["total_rupees"] == 1250.5
    assert len(n["items"]) == 1 and n["items"][0]["qty"] == 5.0
    assert n["confidence"] == "high"
    assert len(n["raw_summary"]) <= 300


def test_strip_fences_pulls_json_from_chatty_reply():
    txt = 'Sure! Here you go:\n```json\n{"total_rupees": 42}\n```\nThanks!'
    assert '{"total_rupees": 42}' in _strip_fences(txt)


def test_extract_gating(client, manager):
    # off by default → 409 for anyone
    r = client.post("/api/ocr/extract", files={"file": ("b.png", PNG, "image/png")})
    assert r.status_code == 409


def test_config_owner_only_and_status(client, manager):
    r = manager.put("/api/ocr/config", json={
        "enabled": True, "provider": "openai_compat",
        "base_url": "https://x/v1", "model": "m", "api_key": "k"})
    assert r.status_code == 403                      # managers can't touch it

    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    r = client.put("/api/ocr/config", json={
        "enabled": True, "provider": "openai_compat",
        "base_url": "https://example.test/v1", "model": "vision-1",
        "api_key": "sk-test"})
    assert r.status_code == 200

    st = client.get("/api/ocr/status").json()
    assert st["configured"] is True and st["has_key"] is True
    assert "sk-test" not in r.text and "key" not in st   # key never leaks

    # now extract hits the provider path; unconfigured base is fake → 502
    r2 = client.post("/api/ocr/extract",
                     files={"file": ("b.png", PNG, "image/png")})
    assert r2.status_code in (422, 502)  # unsafe/unresolvable hosts fail before secrets leave


def test_config_blocks_private_key_forwarding(client):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    response = client.put("/api/ocr/config", json={
        "enabled": True, "provider": "openai_compat",
        "base_url": "http://127.0.0.1:11434/v1", "model": "vision",
        "api_key": "secret",
    })
    assert response.status_code == 422


def test_ping_parses_models_both_shapes(client, monkeypatch):
    import app.routers.ocr as ocr_mod
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    client.put("/api/ocr/config", json={
        "enabled": True, "provider": "openai_compat",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": "", "api_key": "AIzaFAKE"})

    class FakeResp:
        def __init__(self, payload, status=200):
            self._p, self.status_code, self.text = payload, status, str(payload)

        def json(self):
            return self._p

    # OpenAI-compat shape
    monkeypatch.setattr(ocr_mod.httpx, "get", lambda *a, **k: FakeResp(
        {"data": [{"id": "models/gemini-2.0-flash"},
                  {"id": "models/text-embedding-004"}]}))
    r = client.get("/api/ocr/ping").json()
    assert r["ok"] is True
    assert "gemini-2.0-flash" in r["models"]
    assert all("embedding" not in m for m in r["models"]) is False  # raw list kept; UI filters

    # native shape
    monkeypatch.setattr(ocr_mod.httpx, "get", lambda *a, **k: FakeResp(
        {"models": [{"name": "models/gemini-1.5-pro"}]}))
    r2 = client.get("/api/ocr/ping").json()
    assert "gemini-1.5-pro" in r2["models"]

    # bad key → not ok, but no crash
    monkeypatch.setattr(ocr_mod.httpx, "get", lambda *a, **k: FakeResp(
        {"error": {"code": 400, "message": "Please pass a valid API key"}}, 400))
    r3 = client.get("/api/ocr/ping").json()
    assert r3["ok"] is False and r3["models"] == []


def test_gemini_base_url_normalized(client):
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    client.put("/api/ocr/config", json={
        "enabled": True, "provider": "openai_compat",
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "model": "m"})
    st = None
    from app.db import SessionLocal
    db = SessionLocal()
    from app.models import Setting
    row = db.get(Setting, "ocr_base_url")
    val = row.value["v"]
    db.close()
    assert val.endswith("/v1beta/openai"), val


def test_extract_happy_path_monkeypatched(client, outlet_id, monkeypatch):
    """Full flow with a stubbed vision reply → normalized draft."""
    from app.routers import ocr as ocr_mod
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    client.put("/api/ocr/config", json={
        "enabled": True, "provider": "openai_compat",
        "base_url": "https://example.test/v1", "model": "v1", "api_key": "k"})

    def fake_call(image_bytes, ext, mime, cfg):
        return {"vendor_name": "Handwritten Bhaiya",
                "date": "2026-08-24",
                "total_rupees": 375,
                "items": [{"name": "Onion 5kg", "qty": 5, "amount": 250},
                          {"name": "Tomato", "qty": 3, "amount": 125}],
                "confidence": "medium",
                "raw_summary": "sabzi bill"}

    orig = ocr_mod._call_openai_compat
    ocr_mod._call_openai_compat = fake_call
    try:
        r = client.post("/api/ocr/extract",
                        files={"file": ("b.png", PNG, "image/png")})
    finally:
        ocr_mod._call_openai_compat = orig
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["vendor_name"] == "Handwritten Bhaiya"
    assert d["total_rupees"] == 375.0
    assert d["bill_date"] == "2026-08-24"
    assert d["confidence"] == "medium"
    assert len(d["items"]) == 2


def test_repair_salvages_truncated_items():
    from app.routers.ocr import _repair_json
    broken = '{"vendor_name": "Bhaiya", "total_rupees": 375, "items": [{"name": "Onion", "amount": 250}, {"name": "Tomato", "amou'
    out = _repair_json(broken)
    assert out is not None
    assert out["vendor_name"] == "Bhaiya"
    assert out["items"][0]["name"] == "Onion"


def test_repair_handles_prose_wrapped_fences():
    from app.routers.ocr import _repair_json
    txt = 'Here you go:\n```json\n{"vendor_name": "X", "items": []}\n```\nDone!'
    assert _repair_json(txt)["vendor_name"] == "X"


def test_repair_returns_none_for_refusal_text():
    from app.routers.ocr import _repair_json
    assert _repair_json("I cannot read this image, sorry.") is None


def test_extract_surfaces_reply_snippet_on_bad_json(client, monkeypatch):
    import app.routers.ocr as ocr_mod
    client.post("/api/auth/stepup", json={"password": "change-me-please"})
    client.put("/api/ocr/config", json={
        "enabled": True, "provider": "openai_compat",
        "base_url": "https://example.test/v1", "model": "v1", "api_key": "k"})

    def fake_call(image_bytes, ext, mime, cfg):
        raise ocr_mod.HTTPException(502, "Model reply wasn't valid JSON even after repair. Reply started with: 'Sorry'")

    orig = ocr_mod._call_openai_compat
    ocr_mod._call_openai_compat = fake_call
    try:
        r = client.post("/api/ocr/extract", files={"file": ("b.png", PNG, "image/png")})
    finally:
        ocr_mod._call_openai_compat = orig
    assert r.status_code == 502 and "Sorry" in r.json()["detail"]
