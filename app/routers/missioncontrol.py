"""
Mission Control -- a dense, data-first ops view of the whole operation:
real per-channel YouTube stats, a merged live activity stream pulled from
every job's real agent log lines, and headline totals. This sits alongside
the cinematic AETHER constellation view (same data, same agents, different
lens) -- open it from the toolbar, or say "open mission control".
"""
import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models, crypto
from ..database import get_db
from ..pipeline import publish_youtube
from ..agents_registry import AGENTS

router = APIRouter(prefix="/api/missioncontrol", tags=["missioncontrol"])

# Map a stage_log line's "X Agent:" prefix to the named agent + its accent
# color, so the activity stream can tag each line the same way the
# constellation does -- one source of truth (agents_registry), two views.
_PREFIX_TO_STAGE = {
    "Script Agent": "script", "Voice Agent": "voice", "Visual Agent": "visuals",
    "Assembly Agent": "assembly", "Publish Agent": "publish",
}
_STAGE_TO_AGENT_META = {a["stage"]: a for a in AGENTS if a["stage"]}
_LINE_RE = re.compile(r"^\[(?P<ts>[\d\-T:Z]+)\]\s*(?P<rest>.*)$")


def _agent_for_line(text: str):
    # Match wherever the phrase appears (not just a leading prefix) -- lines
    # like "Segment 2/5: Voice Agent + Visual Agent working in parallel…"
    # mention the agent mid-sentence, not at the start. Pick whichever named
    # agent appears earliest in the line.
    best_pos, best_meta = None, None
    for phrase, stage in _PREFIX_TO_STAGE.items():
        pos = text.find(phrase)
        if pos != -1 and (best_pos is None or pos < best_pos):
            meta = _STAGE_TO_AGENT_META.get(stage)
            if meta:
                best_pos, best_meta = pos, meta
    return best_meta or {"id": "aether", "name": "AETHER", "icon": "✦", "color": "#00e8ff"}


@router.get("/overview")
def overview(db: Session = Depends(get_db)):
    channels = db.query(models.Channel).all()
    channel_cards = []
    total_subs = 0
    total_views = 0
    for ch in channels:
        card = {
            "id": ch.id, "name": ch.name,
            "youtube_connected": ch.youtube_connected,
            "youtube_channel_title": ch.youtube_channel_title,
            "subscribers": None, "views": None,
        }
        if ch.youtube_connected and ch.youtube_refresh_token_enc:
            try:
                access_token = publish_youtube.refresh_access_token(
                    db, crypto.decrypt(ch.youtube_refresh_token_enc)
                )
                stats = publish_youtube.fetch_channel_stats(access_token)
                card["subscribers"] = stats["subscribers"]
                card["views"] = stats["views"]
                card["hidden_subs"] = stats.get("hidden_subs", False)
                total_subs += stats["subscribers"]
                total_views += stats["views"]
            except Exception as e:
                card["error"] = str(e)[:120]
        channel_cards.append(card)

    all_jobs = db.query(models.VideoJob).all()
    today_start = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0, tzinfo=None
    )
    todays_jobs = [j for j in all_jobs if j.created_at and j.created_at >= today_start]
    live_now = sum(
        1 for j in all_jobs
        if j.status not in (models.JobStatus.PUBLISHED, models.JobStatus.FAILED, models.JobStatus.READY)
    )

    return {
        "channels": channel_cards,
        "totals": {
            "subscribers": total_subs,
            "views": total_views,
            "videos_total": len(all_jobs),
            "videos_today": len(todays_jobs),
            "agents_live": live_now,
        },
        "uplink": "STABLE" if any(c["youtube_connected"] for c in channel_cards) or all_jobs else "AWAITING FIRST RUN",
    }


@router.get("/activity")
def activity(db: Session = Depends(get_db), limit: int = 40):
    channels = {c.id: c.name for c in db.query(models.Channel).all()}
    jobs = db.query(models.VideoJob).order_by(models.VideoJob.created_at.desc()).limit(200).all()
    events = []
    for j in jobs:
        for line in (j.stage_log or "").splitlines():
            m = _LINE_RE.match(line.strip())
            if not m:
                continue
            ts, rest = m.group("ts"), m.group("rest")
            if not rest:
                continue
            agent = _agent_for_line(rest)
            events.append({
                "ts": ts,
                "agent_id": agent["id"], "agent_name": agent["name"],
                "agent_icon": agent["icon"], "agent_color": agent["color"],
                "channel": channels.get(j.channel_id, "?"),
                "job_id": j.id,
                "text": rest,
            })
    events.sort(key=lambda e: e["ts"], reverse=True)
    return events[:limit]
