import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..config import UPLOAD_DIR
from ..security import current_user
from ..models import User

router = APIRouter(tags=["files"])

ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".pdf"}


@router.post("/uploads")
async def upload(file: UploadFile, user: User = Depends(current_user)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(422, f"File type {ext} not allowed")
    name = f"{uuid.uuid4().hex}{ext}"
    dest = UPLOAD_DIR / name
    size = 0
    with dest.open("wb") as out:
        while chunk := await file.read(1024 * 512):
            size += len(chunk)
            if size > 8 * 1024 * 1024:
                dest.unlink(missing_ok=True)
                raise HTTPException(413, "Receipt larger than 8 MB")
            out.write(chunk)
    return {"path": f"/api/files/{name}", "name": file.filename}


@router.get("/files/{name}")
def get_file(name: str, user: User = Depends(current_user)):
    safe = Path(name).name  # no traversal
    p = UPLOAD_DIR / safe
    if not p.is_file():     # is_file, not exists: a directory would 500
        raise HTTPException(404, "Not found")
    media = "application/pdf" if p.suffix == ".pdf" else f"image/{p.suffix.lstrip('.')}"
    return FileResponse(p, media_type=media)
