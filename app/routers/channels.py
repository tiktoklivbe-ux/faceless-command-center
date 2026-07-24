from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..pipeline import voice_stage

router = APIRouter(prefix="/api/channels", tags=["channels"])


@router.get("", response_model=list[schemas.ChannelOut])
def list_channels(db: Session = Depends(get_db)):
    return db.query(models.Channel).order_by(models.Channel.created_at.desc()).all()


@router.post("", response_model=schemas.ChannelOut)
def create_channel(payload: schemas.ChannelIn, db: Session = Depends(get_db)):
    channel = models.Channel(**payload.model_dump())
    db.add(channel)
    db.commit()
    db.refresh(channel)
    return channel


@router.get("/{channel_id}", response_model=schemas.ChannelOut)
def get_channel(channel_id: str, db: Session = Depends(get_db)):
    channel = db.get(models.Channel, channel_id)
    if not channel:
        raise HTTPException(404, "Channel not found")
    return channel


@router.put("/{channel_id}", response_model=schemas.ChannelOut)
def update_channel(channel_id: str, payload: schemas.ChannelIn, db: Session = Depends(get_db)):
    channel = db.get(models.Channel, channel_id)
    if not channel:
        raise HTTPException(404, "Channel not found")
    for k, v in payload.model_dump().items():
        setattr(channel, k, v)
    db.commit()
    db.refresh(channel)
    return channel


@router.delete("/{channel_id}")
def delete_channel(channel_id: str, db: Session = Depends(get_db)):
    channel = db.get(models.Channel, channel_id)
    if not channel:
        raise HTTPException(404, "Channel not found")
    db.delete(channel)
    db.commit()
    return {"ok": True}


@router.get("/voices/list")
def list_voices(db: Session = Depends(get_db)):
    """Proxy to ElevenLabs so the UI can show a friendly voice picker."""
    return {"voices": voice_stage.list_voices(db)}
