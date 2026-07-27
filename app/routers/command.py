"""
Endpoints that power the immersive Command Center:
  GET  /api/agents      -> the constellation roster + each agent's live status
  POST /api/command     -> natural-language routing ("make a video about black holes")
  GET  /api/briefings   -> scheduled "rituals" with a live next-run countdown
"""
import json
import re
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..agents_registry import roster, AGENTS, CORE, STAGE_TO_AGENT
from ..pipeline import orchestrator

router = APIRouter(prefix="/api", tags=["command"])


# ---------------------------------------------------------------- agents
def _live_agent_status(db: Session) -> dict:
    """Aggregate per-agent live status from every in-flight job."""
    status = {a["id"]: "idle" for a in AGENTS}
    active_jobs = db.query(models.VideoJob).filter(
        models.VideoJob.status.notin_([
            models.JobStatus.PUBLISHED, models.JobStatus.FAILED, models.JobStatus.READY,
        ])
    ).all()
    for job in active_jobs:
        try:
            agents = json.loads(job.agent_status or "{}")
        except (json.JSONDecodeError, TypeError):
            agents = {}
        for stage, st in agents.items():
            agent_id = STAGE_TO_AGENT.get(stage)
            if agent_id and st == "running":
                status[agent_id] = "running"
    return status


@router.get("/agents")
def get_agents(db: Session = Depends(get_db)):
    data = roster()
    live = _live_agent_status(db)
    core_busy = any(v == "running" for v in live.values())
    for a in data["agents"]:
        a["status"] = live.get(a["id"], "idle")
    data["core"]["status"] = "running" if core_busy else "idle"
    return data


# ---------------------------------------------------------------- command
class CommandIn(BaseModel):
    text: str
    channel_id: str | None = None


MAKE_PATTERNS = [
    r"make (?:me )?(?:a )?video (?:about|on|for) (.+)",
    r"create (?:a )?video (?:about|on|for) (.+)",
    r"video (?:about|on) (.+)",
    r"generate (?:a )?video (?:about|on|for) (.+)",
]


@router.post("/command")
def run_command(payload: CommandIn, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    text = (payload.text or "").strip()
    low = text.lower()

    # ---- navigation intents ----
    if re.search(r"\b(mission control|ops|control room|dashboard)\b", low):
        return {"action": "open_panel", "panel": "missioncontrol", "message": "Opening Mission Control."}
    if re.search(r"\b(settings|api key|keys|configure)\b", low):
        return {"action": "open_panel", "panel": "settings", "message": "Opening the control panel."}
    if re.search(r"\b(channel|channels)\b", low) and not MAKE_PATTERNS_MATCH(low):
        return {"action": "open_panel", "panel": "channels", "message": "Opening your channels."}
    if re.search(r"\b(jobs|library|videos|history)\b", low):
        return {"action": "open_panel", "panel": "jobs", "message": "Opening the video library."}
    if re.search(r"\b(texting|text jarvis|sms|set up texting)\b", low):
        return {"action": "info", "message":
                "To text Jarvis: get a Twilio phone number, then set its incoming-message "
                "webhook to this app's URL plus /api/jarvis/sms. Once that's set, texting "
                "that number reaches the same Jarvis that's in the app -- same tools, same "
                "channel/job access. Full steps are in the Jarvis panel."}
    if re.search(r"\bjarvis\b", low):
        return {"action": "open_panel", "panel": "jarvis", "message": "Opening Jarvis."}
    if re.search(r"\b(help|what can you do|commands)\b", low):
        return {"action": "help", "message":
                "Try: 'make a video about black holes', 'open mission control', 'open settings', "
                "'show my channels', 'open the video library', or click any agent in the constellation."}

    # ---- make-a-video intent ----
    topic = None
    for pat in MAKE_PATTERNS:
        m = re.search(pat, low)
        if m:
            # pull the topic from the *original* casing
            topic = text[m.start(1):].strip().rstrip(".!")
            break

    if topic is not None or re.search(r"\b(make|create|generate|produce)\b.*\bvideo\b", low):
        channel = None
        if payload.channel_id:
            channel = db.get(models.Channel, payload.channel_id)
        if not channel:
            channel = db.query(models.Channel).order_by(models.Channel.created_at.asc()).first()
        if not channel:
            return {"action": "need_channel",
                    "message": "You'll need a channel first — open Channels and create one, then ask me again."}
        job = models.VideoJob(channel_id=channel.id, topic=topic or "", auto_publish=False)
        db.add(job)
        db.commit()
        db.refresh(job)
        background_tasks.add_task(orchestrator.run_job, job.id)
        return {
            "action": "job_created",
            "job_id": job.id,
            "channel": channel.name,
            "topic": topic or "(agent's choice)",
            "message": f"On it. Athena is drafting a script{' about ' + topic if topic else ''} "
                       f"for {channel.name}. Watch the constellation light up.",
        }

    # ---- fallback ----
    return {"action": "unknown",
            "message": "I didn't catch a command in that. Try 'make a video about …', "
                       "'open settings', or 'show my channels'."}


def MAKE_PATTERNS_MATCH(low: str) -> bool:
    return any(re.search(p, low) for p in MAKE_PATTERNS)


# ---------------------------------------------------------------- briefings / rituals
# Recurring "rituals" the constellation performs. Times are UTC hours; the UI
# shows a live countdown to the next occurrence. These are display/scaffolding
# for now — wire them to real scheduled tasks when you deploy.
RITUALS = [
    {"id": "briefing", "agent": "Athena", "icon": "🦉", "name": "Daily Production Briefing",
     "desc": "Athena drafts the day's scripts and Apollo fact-checks the topic slate.",
     "utc_hours": [13]},
    {"id": "council", "agent": "Apollo", "icon": "🔭", "name": "Backlog Council",
     "desc": "Apollo proposes new topics; the council ranks them for the queue.",
     "utc_hours": [9, 21]},
    {"id": "telemetry", "agent": "Atlas", "icon": "🌐", "name": "Telemetry Sync",
     "desc": "Atlas pulls fresh view & watch-time analytics from every platform.",
     "utc_hours": [6, 12, 18, 0]},
    {"id": "community", "agent": "Echo", "icon": "💬", "name": "Community Hour",
     "desc": "Echo drafts replies to new comments and flags questions worth a video.",
     "utc_hours": [16]},
    {"id": "guardian", "agent": "Argus", "icon": "🛡️", "name": "Guardian Sweep",
     "desc": "Argus audits queued videos against monetization & community rules.",
     "utc_hours": [11, 23]},
]


def _next_run(utc_hours: list[int]) -> datetime:
    now = datetime.now(timezone.utc)
    candidates = []
    for day_offset in (0, 1):
        for h in utc_hours:
            cand = (now + timedelta(days=day_offset)).replace(
                hour=h, minute=0, second=0, microsecond=0)
            if cand > now:
                candidates.append(cand)
    return min(candidates)


@router.get("/briefings")
def get_briefings():
    out = []
    for r in RITUALS:
        nxt = _next_run(r["utc_hours"])
        out.append({
            "id": r["id"], "agent": r["agent"], "icon": r["icon"],
            "name": r["name"], "desc": r["desc"],
            "next_run_iso": nxt.isoformat(),
        })
    out.sort(key=lambda x: x["next_run_iso"])
    return {"rituals": out}
