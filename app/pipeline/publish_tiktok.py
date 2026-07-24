"""
TikTok Content Posting API integration: OAuth2 connect flow + video publish.

IMPORTANT — read this before expecting auto-publish to "just work":

TikTok's Content Posting API gates production access behind an app review:
  - Personal developer accounts are generally NOT eligible for full Content
    Posting API access -- TikTok expects a registered business/developer
    entity, a demo video of your posting flow, a privacy policy URL, and a
    written use-case description, reviewed manually (~5-10 business days
    once submitted).
  - Until your app passes that review, TikTok only allows "unaudited client"
    posting, which publishes as a PRIVATE / self-only draft to your own
    account rather than a public post -- useful for testing this integration
    end-to-end, not for actually publishing to the world.

Practical path: build and test with an unaudited app (private posts land
fine), and submit for TikTok's app review once you're happy with the output
and ready to publish publicly and/or at volume.
"""
from pathlib import Path
import os

import requests

from ..settings_store import get_setting
from ..config import APP_BASE_URL

AUTH_BASE = "https://www.tiktok.com/v2/auth/authorize/"
TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/"
INIT_URL = "https://open.tiktokapis.com/v2/post/publish/video/init/"
STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/"
SCOPE = "user.info.basic,video.publish"


def build_auth_url(db, channel_id: str) -> str:
    client_key = get_setting(db, "tiktok_client_key")
    redirect_uri = f"{APP_BASE_URL}/auth/tiktok/callback"
    params = {
        "client_key": client_key,
        "response_type": "code",
        "scope": SCOPE,
        "redirect_uri": redirect_uri,
        "state": channel_id,
    }
    query = "&".join(f"{k}={requests.utils.quote(str(v))}" for k, v in params.items())
    return f"{AUTH_BASE}?{query}"


def exchange_code_for_tokens(db, code: str) -> dict:
    client_key = get_setting(db, "tiktok_client_key")
    client_secret = get_setting(db, "tiktok_client_secret")
    redirect_uri = f"{APP_BASE_URL}/auth/tiktok/callback"
    resp = requests.post(TOKEN_URL, data={
        "client_key": client_key,
        "client_secret": client_secret,
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
    }, headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=30)
    resp.raise_for_status()
    return resp.json()  # access_token, refresh_token, open_id


def refresh_access_token(db, refresh_token: str) -> str:
    client_key = get_setting(db, "tiktok_client_key")
    client_secret = get_setting(db, "tiktok_client_secret")
    resp = requests.post(TOKEN_URL, data={
        "client_key": client_key,
        "client_secret": client_secret,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }, headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(f"TikTok token refresh failed ({resp.status_code}): {resp.text[:300]}")
    return resp.json()["access_token"]


def publish_video(access_token: str, video_path: Path, title: str,
                   privacy_level: str = "SELF_ONLY") -> str:
    """
    Direct-post flow via FILE_UPLOAD source. privacy_level defaults to
    SELF_ONLY because unaudited apps are restricted to that anyway -- change
    it once TikTok has approved your app for public posting.
    """
    size = os.path.getsize(video_path)
    chunk_size = size  # single-chunk upload; fine for short-form videos
    init_resp = requests.post(
        INIT_URL,
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={
            "post_info": {
                "title": title[:150],
                "privacy_level": privacy_level,
                "disable_duet": False,
                "disable_comment": False,
                "disable_stitch": False,
            },
            "source_info": {
                "source": "FILE_UPLOAD",
                "video_size": size,
                "chunk_size": chunk_size,
                "total_chunk_count": 1,
            },
        },
        timeout=30,
    )
    if init_resp.status_code != 200:
        raise RuntimeError(f"TikTok publish init failed ({init_resp.status_code}): {init_resp.text[:500]}")
    payload = init_resp.json()["data"]
    upload_url = payload["upload_url"]
    publish_id = payload["publish_id"]

    with open(video_path, "rb") as f:
        video_bytes = f.read()
    put_resp = requests.put(
        upload_url,
        headers={
            "Content-Type": "video/mp4",
            "Content-Range": f"bytes 0-{size - 1}/{size}",
        },
        data=video_bytes,
        timeout=600,
    )
    if put_resp.status_code not in (200, 201):
        raise RuntimeError(f"TikTok video upload failed ({put_resp.status_code}): {put_resp.text[:500]}")

    return publish_id


def check_status(access_token: str, publish_id: str) -> dict:
    resp = requests.post(
        STATUS_URL,
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"publish_id": publish_id},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["data"]
