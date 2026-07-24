from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from .. import models, crypto
from ..database import get_db
from ..pipeline import publish_youtube, publish_tiktok

router = APIRouter(prefix="/auth", tags=["oauth"])


@router.get("/youtube/start")
def youtube_start(channel_id: str, db: Session = Depends(get_db)):
    channel = db.get(models.Channel, channel_id)
    if not channel:
        raise HTTPException(404, "Channel not found")
    return RedirectResponse(publish_youtube.build_auth_url(db, channel_id))


@router.get("/youtube/callback")
def youtube_callback(code: str, state: str, db: Session = Depends(get_db)):
    channel = db.get(models.Channel, state)
    if not channel:
        raise HTTPException(404, "Channel not found")
    tokens = publish_youtube.exchange_code_for_tokens(db, code)
    refresh_token = tokens.get("refresh_token")
    if refresh_token:
        channel.youtube_refresh_token_enc = crypto.encrypt(refresh_token)
    channel.youtube_channel_title = publish_youtube.fetch_channel_title(tokens["access_token"])
    channel.youtube_connected = True
    db.commit()
    return RedirectResponse("/#/channels?connected=youtube")


@router.get("/tiktok/start")
def tiktok_start(channel_id: str, db: Session = Depends(get_db)):
    channel = db.get(models.Channel, channel_id)
    if not channel:
        raise HTTPException(404, "Channel not found")
    return RedirectResponse(publish_tiktok.build_auth_url(db, channel_id))


@router.get("/tiktok/callback")
def tiktok_callback(code: str, state: str, db: Session = Depends(get_db)):
    channel = db.get(models.Channel, state)
    if not channel:
        raise HTTPException(404, "Channel not found")
    tokens = publish_tiktok.exchange_code_for_tokens(db, code)
    refresh_token = tokens.get("refresh_token")
    if refresh_token:
        channel.tiktok_refresh_token_enc = crypto.encrypt(refresh_token)
    channel.tiktok_display_name = "Connected TikTok account"
    channel.tiktok_connected = True
    db.commit()
    return RedirectResponse("/#/channels?connected=tiktok")
