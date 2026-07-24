from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import schemas
from ..database import get_db
from ..settings_store import set_setting, all_settings_masked

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
def get_settings(db: Session = Depends(get_db)):
    return all_settings_masked(db)


@router.post("")
def update_settings(payload: schemas.SettingsIn, db: Session = Depends(get_db)):
    for key, value in payload.model_dump(exclude_none=True).items():
        set_setting(db, key, value)
    return all_settings_masked(db)
