"""Lock screen endpoints."""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import auth
from ..database import get_db
from ..settings_store import set_setting

router = APIRouter(prefix="/api/lock", tags=["lock"])

COOKIE = "fcc_session"


class PasswordIn(BaseModel):
    password: str


class SetupIn(BaseModel):
    password: str
    idle_minutes: int = 15


@router.get("/status")
def status(request: Request, db: Session = Depends(get_db)):
    """Whether the app is locked right now, and how it's configured."""
    enabled = auth.lock_enabled(db)
    unlocked = auth.token_valid(db, request.cookies.get(COOKIE))
    return {
        "enabled": enabled,
        "configured": auth.is_configured(db),
        "locked": enabled and not unlocked,
        "idle_minutes": auth.idle_minutes(db),
    }


@router.post("/setup")
def setup(body: SetupIn, response: Response, db: Session = Depends(get_db)):
    """Set the password and turn the lock on. Also issues a session so the
    person setting it up isn't immediately locked out of their own app."""
    try:
        auth.set_password(db, body.password)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    set_setting(db, "lock_idle_minutes", str(max(1, body.idle_minutes)))
    set_setting(db, "lock_enabled", "true")
    response.set_cookie(
        COOKIE, auth.issue_token(db),
        httponly=True,      # not readable by page scripts
        samesite="lax",
        max_age=12 * 3600,
    )
    return {"ok": True}


@router.post("/unlock")
def unlock(body: PasswordIn, response: Response, db: Session = Depends(get_db)):
    if not auth.verify_password(db, body.password):
        raise HTTPException(status_code=401, detail="Wrong password.")
    response.set_cookie(
        COOKIE, auth.issue_token(db),
        httponly=True, samesite="lax", max_age=12 * 3600,
    )
    return {"ok": True}


@router.post("/lock")
def lock_now(response: Response):
    """Lock immediately -- used by the idle timer and the manual lock button."""
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.post("/disable")
def disable(body: PasswordIn, db: Session = Depends(get_db)):
    """Turning the lock off requires the current password, so someone who
    walks up to an unlocked screen can't simply switch it off."""
    if not auth.verify_password(db, body.password):
        raise HTTPException(status_code=401, detail="Wrong password.")
    set_setting(db, "lock_enabled", "false")
    return {"ok": True}
