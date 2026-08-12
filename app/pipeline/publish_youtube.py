"""
YouTube Data API v3 integration: OAuth2 connect flow + resumable video upload.

IMPORTANT — read this before expecting auto-publish to "just work":

Google's OAuth consent screen has two publishing states:
  - "Testing": works immediately, no review needed, BUT tokens issued to test
    users expire after 7 days. Fine for you personally testing the app, bad
    for unattended daily auto-uploads (you'd have to reconnect every week).
  - "In production": tokens last long-term, but since this app requests the
    youtube.upload scope (a "restricted" scope), Google requires your OAuth
    app to pass their verification review before it can go into production.
    That means: a privacy policy URL, verified domain ownership, and a demo
    video of the app for Google's reviewers. Budget days-to-weeks for this,
    not minutes -- this is almost certainly what "kept getting declined"
    on your old Replit build.

Practical path: keep the consent screen in Testing while you build/tune this,
add your own Google account as a test user (Google Cloud Console -> APIs &
Services -> OAuth consent screen -> Test users), reconnect the channel here
every ~7 days until you're ready to submit for verification.
"""
from pathlib import Path
import time

import requests

from ..settings_store import get_setting
from ..config import APP_BASE_URL

AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly"


def build_auth_url(db, channel_id: str) -> str:
    client_id = get_setting(db, "youtube_client_id")
    redirect_uri = f"{APP_BASE_URL}/auth/youtube/callback"
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "state": channel_id,
    }
    query = "&".join(f"{k}={requests.utils.quote(str(v))}" for k, v in params.items())
    return f"{AUTH_BASE}?{query}"


def exchange_code_for_tokens(db, code: str) -> dict:
    client_id = get_setting(db, "youtube_client_id")
    client_secret = get_setting(db, "youtube_client_secret")
    redirect_uri = f"{APP_BASE_URL}/auth/youtube/callback"
    resp = requests.post(TOKEN_URL, data={
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }, timeout=30)
    resp.raise_for_status()
    return resp.json()  # contains access_token, refresh_token, expires_in


def refresh_access_token(db, refresh_token: str) -> str:
    client_id = get_setting(db, "youtube_client_id")
    client_secret = get_setting(db, "youtube_client_secret")
    resp = requests.post(TOKEN_URL, data={
        "refresh_token": refresh_token,
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "refresh_token",
    }, timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(
            f"YouTube token refresh failed ({resp.status_code}): {resp.text[:300]} "
            f"-- if this channel hasn't published in >7 days and your OAuth app is still "
            f"in 'Testing' publishing status, you'll need to reconnect it (see publish_youtube.py notes)."
        )
    return resp.json()["access_token"]


def fetch_channel_title(access_token: str) -> str:
    resp = requests.get(
        "https://www.googleapis.com/youtube/v3/channels",
        params={"part": "snippet", "mine": "true"},
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    resp.raise_for_status()
    items = resp.json().get("items", [])
    return items[0]["snippet"]["title"] if items else "Connected channel"


def fetch_channel_stats(access_token: str) -> dict:
    """Real subscriber/view counts for the connected channel -- powers Mission
    Control's stat tiles. Returns zeros if the API call fails for any reason
    (expired token, channel has hidden its subscriber count, etc.) rather than
    raising, since this is a nice-to-have display, not a pipeline-critical call."""
    try:
        resp = requests.get(
            "https://www.googleapis.com/youtube/v3/channels",
            params={"part": "snippet,statistics", "mine": "true"},
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=15,
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])
        if not items:
            return {"subscribers": 0, "views": 0, "video_count": 0}
        stats = items[0].get("statistics", {})
        return {
            "subscribers": int(stats.get("subscriberCount", 0)),
            "views": int(stats.get("viewCount", 0)),
            "video_count": int(stats.get("videoCount", 0)),
            "hidden_subs": stats.get("hiddenSubscriberCount", False),
        }
    except Exception:
        return {"subscribers": 0, "views": 0, "video_count": 0, "hidden_subs": False}


def update_video_privacy(access_token: str, video_id: str, privacy_status: str = "public") -> str:
    """Flip an already-uploaded video's privacy (e.g. a batch of shorts that
    went up private). Same Google caveat as upload: while the OAuth app is
    unverified for the youtube.upload scope, Google may reject making a video
    public via the API -- in that case the only path is the YouTube Studio UI
    or passing app verification. Returns the resulting privacyStatus so the
    caller can tell whether it actually took."""
    resp = requests.put(
        "https://www.googleapis.com/youtube/v3/videos",
        params={"part": "status"},
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
        },
        json={"id": video_id, "status": {"privacyStatus": privacy_status}},
        timeout=30,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"YouTube privacy update failed ({resp.status_code}): {resp.text[:400]}")
    return resp.json().get("status", {}).get("privacyStatus", privacy_status)


def upload_video(access_token: str, video_path: Path, title: str, description: str,
                  privacy_status: str = "public", tags: list[str] | None = None) -> str:
    """Resumable upload: reserve an upload URL, then PUT the file bytes."""
    snippet = {
        "title": title[:100],
        "description": description[:5000],
        "categoryId": "24",  # Entertainment
    }
    if tags:
        # YouTube caps the combined tags string around 500 chars -- keep
        # adding tags until that budget runs out rather than an arbitrary
        # count, so a handful of longer niche tags don't get silently cut.
        budget, kept = 480, []
        for t in tags:
            if budget - len(t) - 1 < 0:
                break
            kept.append(t)
            budget -= len(t) + 1
        if kept:
            snippet["tags"] = kept
    metadata = {
        "snippet": snippet,
        "status": {"privacyStatus": privacy_status, "selfDeclaredMadeForKids": False},
    }
    init = requests.post(
        "https://www.googleapis.com/upload/youtube/v3/videos",
        params={"uploadType": "resumable", "part": "snippet,status"},
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": "video/mp4",
        },
        json=metadata,
        timeout=30,
    )
    if init.status_code != 200:
        raise RuntimeError(f"YouTube upload init failed ({init.status_code}): {init.text[:500]}")
    upload_url = init.headers["Location"]

    with open(video_path, "rb") as f:
        video_bytes = f.read()
    put_resp = requests.put(
        upload_url,
        headers={"Content-Type": "video/mp4"},
        data=video_bytes,
        timeout=600,
    )
    if put_resp.status_code not in (200, 201):
        raise RuntimeError(f"YouTube upload failed ({put_resp.status_code}): {put_resp.text[:500]}")
    return put_resp.json()["id"]
