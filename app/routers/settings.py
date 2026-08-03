import os

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import schemas, models
from ..database import get_db
from ..settings_store import set_setting, all_settings_masked, KNOWN_KEYS

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
def get_settings(db: Session = Depends(get_db)):
    from ..settings_store import storage_health
    data = all_settings_masked(db)
    data["_health"] = storage_health(db)
    return data


@router.get("/diagnostics")
def diagnostics(db: Session = Depends(get_db)):
    """Reports whether saved secrets are actually safe across redeploys.

    The failure this catches: if the encryption key lives on a disk that
    isn't truly persistent, it regenerates on redeploy and every stored API
    key silently becomes unreadable -- which looks like "my key stopped
    working" with no obvious cause.
    """
    from .. import crypto
    from ..config import PERSIST_DIR, DATA_DIR

    info = crypto.key_info()
    unreadable = []
    for key in KNOWN_KEYS:
        row = db.get(models.Setting, key)
        if row and row.value_enc and crypto.decrypt(row.value_enc) is None:
            unreadable.append(key)

    return {
        "encryption_key_source": info["source"],
        "survives_redeploys": info["persistent"],
        "advice": info["advice"],
        "persist_dir": str(PERSIST_DIR),
        "persist_dir_configured": bool(os.environ.get("PERSIST_DIR")),
        "data_dir": str(DATA_DIR),
        "unreadable_settings": unreadable,
        "backup_key": crypto.current_key_for_backup(),
        "backup_key_note": (
            "Copy this into a SECRET_KEY environment variable on your host, then redeploy. "
            "After that the encryption key no longer depends on disk state and your saved "
            "API keys stop getting lost."
        ),
    }


@router.post("")
def update_settings(payload: schemas.SettingsIn, db: Session = Depends(get_db)):
    for key, value in payload.model_dump(exclude_none=True).items():
        set_setting(db, key, value)
    return all_settings_masked(db)
