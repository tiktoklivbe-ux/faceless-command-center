"""
The "Daily Rundown" -- a rolled-up briefing of what your agents have been
doing today, plus which agents are live right now across all jobs (not just
one). Powers the Command Center dashboard tab.
"""
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..pipeline.orchestrator import AGENT_NAMES

router = APIRouter(prefix="/api/rundown", tags=["rundown"])


@router.get("")
def get_rundown(db: Session = Depends(get_db)):
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
    all_jobs = db.query(models.VideoJob).all()
    todays_jobs = [j for j in all_jobs if j.created_at and j.created_at >= today_start]

    published = [j for j in todays_jobs if j.status == models.JobStatus.PUBLISHED]
    failed = [j for j in todays_jobs if j.status == models.JobStatus.FAILED]
    in_progress = [j for j in all_jobs if j.status not in (
        models.JobStatus.PUBLISHED, models.JobStatus.FAILED, models.JobStatus.READY
    )]

    # Which agents are live *right now*, across every in-flight job.
    live_agents = {name: False for name in AGENT_NAMES}
    for j in in_progress:
        try:
            statuses = json.loads(j.agent_status or "{}")
        except (json.JSONDecodeError, TypeError):
            statuses = {}
        for name, status in statuses.items():
            if status == "running":
                live_agents[name] = True

    segments_today = sum(len((j.script_text or "").splitlines()) for j in todays_jobs)

    if not todays_jobs:
        briefing = "No runs kicked off yet today. Head to New Video to put your agents to work."
    else:
        parts = [f"{len(todays_jobs)} video{'s' if len(todays_jobs) != 1 else ''} started today"]
        if published:
            parts.append(f"{len(published)} published")
        if in_progress:
            parts.append(f"{len(in_progress)} currently in the pipeline")
        if failed:
            parts.append(f"{len(failed)} failed -- check the Jobs tab")
        briefing = ", ".join(parts) + "."

    return {
        "date": today_start.date().isoformat(),
        "videos_started_today": len(todays_jobs),
        "videos_published_today": len(published),
        "videos_failed_today": len(failed),
        "videos_in_progress": len(in_progress),
        "segments_generated_today": segments_today,
        "live_agents": live_agents,
        "briefing": briefing,
    }
