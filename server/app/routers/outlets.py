from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Outlet, User
from ..security import current_user, require_owner
from .helpers import user_outlet_ids

router = APIRouter(prefix="/outlets", tags=["outlets"])


class OutletIn(BaseModel):
    name: str
    address: str = ""
    phone: str = ""
    opening_float_rupees: float = 0


def _serialize(o: Outlet) -> dict:
    return {
        "id": o.id, "name": o.name, "address": o.address, "phone": o.phone,
        "opening_float_paise": o.opening_float_paise,
        "opening_float_rupees": round(o.opening_float_paise / 100, 2),
        "is_active": o.is_active,
    }


@router.get("")
def list_outlets(user: User = Depends(current_user),
                 db: Session = Depends(get_db)):
    ids = set(user_outlet_ids(db, user))
    rows = [o for o in db.query(Outlet).filter_by(is_active=True).order_by(Outlet.name).all()
            if o.id in ids]
    return [_serialize(o) for o in rows]


@router.post("", status_code=201)
def create_outlet(body: OutletIn, user: User = Depends(require_owner),
                  db: Session = Depends(get_db)):
    o = Outlet(name=body.name.strip(), address=body.address, phone=body.phone,
               opening_float_paise=int(round(body.opening_float_rupees * 100)))
    db.add(o)
    db.commit()
    db.refresh(o)
    return _serialize(o)


@router.patch("/{outlet_id}")
def update_outlet(outlet_id: int, body: OutletIn, user: User = Depends(require_owner),
                  db: Session = Depends(get_db)):
    o = db.get(Outlet, outlet_id)
    if o is None:
        raise HTTPException(404, "Outlet not found")
    o.name = body.name.strip()
    o.address = body.address
    o.phone = body.phone
    o.opening_float_paise = int(round(body.opening_float_rupees * 100))
    db.commit()
    return _serialize(o)
