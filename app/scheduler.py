"""
Chronos — the automation loop. Runs inside the same process as the web app
(no external cron needed) and, every CHECK_INTERVAL seconds, checks every
channel with auto_enabled and creates a new video job whenever that channel
is "due" for its next one.

Spacing model: a channel that wants `auto_per_day` videos gets one roughly
every (24h / auto_per_day). We don't use wall-clock cron slots (like "9am,
1pm, 5pm") on purpose -- if the process was asleep (Render free tier sleeps
after 15 min idle) or restarted, cron-slot scheduling would either double-fire
or skip a slot. Spacing off "time since this channel's last job" instead
means it always just picks back up and catches up gracefully, one video at a
time, without ever bursting out a pile of backlogged videos at once.

IMPORTANT HOSTING CAVEAT: this loop only runs while the process is alive. On
a host that sleeps when idle (e.g. Render's free tier), it stops ticking
while asleep and only resumes checking once something wakes the app back up
(an incoming request). For genuinely unattended "3 shorts a day while I'm not
touching it" automation, this needs to run on a host that stays on
continuously (Render's paid Starter tier, Railway, Fly.io, etc.), or you need
an external uptime pinger hitting the site every ~10 minutes to keep the free
tier awake.
"""
import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from . import models
from .database import SessionLocal
from .pipeline import orchestrator

log = logging.getLogger("chronos")

CHECK_INTERVAL_SECONDS = 300  # 5 minutes


def _today_start() -> datetime:
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)


def _channel_due(db: Session, channel: models.Channel) -> bool:
    if not channel.auto_enabled or not channel.auto_per_day or channel.auto_per_day <= 0:
        return False

    today_start = _today_start()
    todays_jobs = (
        db.query(models.VideoJob)
        .filter(models.VideoJob.channel_id == channel.id)
        .filter(models.VideoJob.created_at >= today_start)
        .count()
    )
    if todays_jobs >= channel.auto_per_day:
        return False

    last_job = (
        db.query(models.VideoJob)
        .filter(models.VideoJob.channel_id == channel.id)
        .order_by(models.VideoJob.created_at.desc())
        .first()
    )
    if not last_job or not last_job.created_at:
        return True  # never made one yet -- due immediately

    interval = 86400 / channel.auto_per_day
    elapsed = (datetime.utcnow() - last_job.created_at).total_seconds()
    return elapsed >= interval


def _tick():
    db = SessionLocal()
    try:
        channels = db.query(models.Channel).filter(models.Channel.auto_enabled == True).all()  # noqa: E712
        for channel in channels:
            try:
                if _channel_due(db, channel):
                    job = models.VideoJob(
                        channel_id=channel.id,
                        topic="",  # let Apollo/Athena choose
                        auto_publish=channel.auto_publish_scheduled,
                    )
                    db.add(job)
                    db.commit()
                    db.refresh(job)
                    log.info("Chronos: auto-created job %s for channel %s", job.id, channel.name)
                    orchestrator.run_job(job.id)
            except Exception:
                log.exception("Chronos: failed to process channel %s", channel.id)
    finally:
        db.close()


async def automation_loop():
    log.info("Chronos automation loop started (checking every %ss)", CHECK_INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.get_event_loop().run_in_executor(None, _tick)
        except Exception:
            log.exception("Chronos: tick failed")
        await asyncio.sleep(CHECK_INTERVAL_SECONDS)
