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
import json
import logging
import threading
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from . import models, render_gate, twilio_utils
from .database import SessionLocal
from .pipeline import orchestrator
from .settings_store import get_setting, set_setting

log = logging.getLogger("chronos")

CHECK_INTERVAL_SECONDS = 300  # 5 minutes

# If a job sits in one of these active states longer than this, its worker
# almost certainly died (e.g. killed mid-run by a redeploy/restart) and
# nothing will ever pick it back up. See clear_stuck_jobs below for how
# those are retried and eventually failed.
STUCK_JOB_TIMEOUT_MINUTES = 30
MAX_AUTO_RETRIES = 2
MAX_JOB_AGE_HOURS = 2  # absolute ceiling; past this a job is failed regardless of retries
_ACTIVE_STATUSES = [
    models.JobStatus.QUEUED,
    models.JobStatus.SCRIPT,
    models.JobStatus.VOICE,
    models.JobStatus.VISUALS,
    models.JobStatus.CAPTIONS,
    models.JobStatus.ASSEMBLING,
    models.JobStatus.PUBLISHING,
]


def clear_stuck_jobs(db: Session) -> int:
    """Find jobs stalled in an active state past the timeout and deal with them.

    The common cause is the process being killed mid-run (a redeploy or host
    restart landing mid-job) rather than the code actually erroring -- that
    kills the worker with no chance to write a failure, which is why these
    jobs previously just sat in 'assembling' forever with an empty error.

    Since that cause is transient, the right response is to RETRY rather
    than give up: the job is put back to QUEUED and re-dispatched, up to
    MAX_AUTO_RETRIES times. Only after that does it get marked FAILED, so a
    genuinely broken job can't loop forever.
    """
    cutoff = datetime.utcnow() - timedelta(minutes=STUCK_JOB_TIMEOUT_MINUTES)
    stuck_jobs = (
        db.query(models.VideoJob)
        .filter(models.VideoJob.status.in_(_ACTIVE_STATUSES))
        .filter(models.VideoJob.updated_at < cutoff)
        .all()
    )
    # Hard ceiling on total job age. Retrying assumes the cause is transient,
    # but if a job keeps hanging in the same place, retries just re-enter the
    # same hang and it cycles indefinitely -- which is how a job ends up
    # "running" overnight. Past this age it's failed outright and the render
    # slot released, whatever the retry count says.
    hard_cutoff = datetime.utcnow() - timedelta(hours=MAX_JOB_AGE_HOURS)

    for job in stuck_jobs:
        created = job.created_at or datetime.utcnow()
        if created < hard_cutoff:
            log.warning("Chronos watchdog: job %s exceeded the %sh ceiling; failing it outright.",
                        job.id, MAX_JOB_AGE_HOURS)
            job.status = models.JobStatus.FAILED
            job.error_message = (
                f"Gave up after {MAX_JOB_AGE_HOURS}h. The render kept hanging at the same stage, "
                "so retrying wasn't helping. See the progress log for the last stage reached."
            )
            try:
                render_gate.release(job.id)
            except Exception:
                pass
            try:
                agents = json.loads(job.agent_status or "{}")
                job.agent_status = json.dumps({k: ("idle" if v == "running" else v) for k, v in agents.items()})
            except (json.JSONDecodeError, TypeError):
                pass
            continue

        # Clear any agents left marked "running". They're stuck-looking because
        # the job died mid-segment, not because those agents are at fault --
        # but leaving them lit makes it look like Voice/Visual/Assembly are
        # permanently busy and hides which agents are genuinely active.
        try:
            agents = json.loads(job.agent_status or "{}")
            if any(v == "running" for v in agents.values()):
                job.agent_status = json.dumps(
                    {k: ("idle" if v == "running" else v) for k, v in agents.items()}
                )
        except (json.JSONDecodeError, TypeError):
            pass

        attempts = (job.stage_log or "").count("[watchdog] retrying")
        if attempts < MAX_AUTO_RETRIES:
            # Don't dispatch a retry while another render is in flight. Doing
            # so was actively counterproductive: stalled jobs were usually
            # killed by memory pressure in the first place, so adding another
            # concurrent render made the next kill more likely -- retries
            # feeding the exact problem they were meant to recover from.
            if render_gate.is_busy():
                log.info("Chronos watchdog: %s needs a retry but a render is already active; leaving it queued.", job.id)
                job.status = models.JobStatus.QUEUED
                job.error_message = ""
                continue
            log.warning("Chronos watchdog: retrying stalled job %s (attempt %d)", job.id, attempts + 1)
            job.stage_log = (job.stage_log or "") + (
                f"\n[watchdog] retrying — job stalled with no error, which usually means the "
                f"process was restarted mid-render. Attempt {attempts + 1} of {MAX_AUTO_RETRIES}.\n"
            )
            job.status = models.JobStatus.QUEUED
            job.error_message = ""
            db.commit()
            # Deliberately NOT dispatching here. The backlog drain later in
            # this same tick picks up QUEUED jobs -- doing both launched TWO
            # workers for the same job simultaneously, which then fought over
            # the same files and render slot. The worker log showed exactly
            # that: "Worker starting" twice, every 30 minutes.
        else:
            log.warning("Chronos watchdog: giving up on job %s after %d retries", job.id, attempts)
            job.status = models.JobStatus.FAILED
            job.error_message = (
                "Job stalled repeatedly with no error logged, and automatic retries were "
                "exhausted. This usually means the process is being killed mid-render "
                "(a restart landing mid-job, or the container running out of resources)."
            )
    if stuck_jobs:
        db.commit()
    return len(stuck_jobs)


def _proactive_alert_recipients(db: Session) -> list[str]:
    return [n.strip() for n in get_setting(db, "jarvis_phone_allowlist", "").split(",") if n.strip()]


def _send_proactive_alert(db: Session, body: str) -> bool:
    """Returns True only if at least one recipient actually got the message --
    the caller uses this to decide whether it's safe to mark the underlying
    failure/block as "alerted". If Twilio's temporarily down or misconfigured,
    returning False here means the same failure gets retried next tick
    instead of being silently and permanently lost the moment credentials
    happen to be broken."""
    account_sid = get_setting(db, "twilio_account_sid")
    auth_token = get_setting(db, "twilio_auth_token")
    from_number = get_setting(db, "twilio_whatsapp_number")
    sent_any = False
    for to_number in _proactive_alert_recipients(db):
        if twilio_utils.send_whatsapp_message(account_sid, auth_token, from_number, to_number, body):
            sent_any = True
    return sent_any


def check_and_send_alerts(db: Session) -> None:
    """Jarvis texting YOU without being asked first -- the other half of the
    WhatsApp integration, which until now only ever replied to messages you
    sent. Runs every tick alongside the render loop, not gated behind it, so
    a failure gets flagged even while nothing else is rendering.

    Two independent checks, each deduplicated against a settings-stored set
    of ids already alerted on so a restart or the next tick doesn't re-send
    the same failure -- this is what keeps it from turning into spam. Off by
    default requires nothing (it silently no-ops with no Twilio configured);
    can be explicitly disabled via jarvis_proactive_alerts="false" even with
    Twilio set up, if you want Jarvis reachable but not proactive.
    """
    if get_setting(db, "jarvis_proactive_alerts", "true") == "false":
        return
    if not _proactive_alert_recipients(db):
        return  # nothing configured to alert -- not worth querying the DB for nothing

    # -- newly failed video jobs --
    alerted_jobs = {x for x in get_setting(db, "jarvis_alerted_job_ids", "").split(",") if x}
    failed = (
        db.query(models.VideoJob)
        .filter(models.VideoJob.status == models.JobStatus.FAILED)
        .order_by(models.VideoJob.created_at.desc())
        .limit(50)
        .all()
    )
    new_failures = [j for j in failed if j.id not in alerted_jobs]
    if new_failures:
        lines = [
            f"- \"{j.title or j.topic or 'untitled'}\" ({j.channel.name if j.channel else '?'}): "
            f"{(j.error_message or 'no error message').strip()[:140]}"
            for j in new_failures[:5]
        ]
        extra = f"\n(+{len(new_failures) - 5} more)" if len(new_failures) > 5 else ""
        plural = "s" if len(new_failures) != 1 else ""
        sent = _send_proactive_alert(
            db, f"Jarvis: {len(new_failures)} video job{plural} failed:\n" + "\n".join(lines) + extra
        )
        if sent:
            alerted_jobs.update(j.id for j in new_failures)
            set_setting(db, "jarvis_alerted_job_ids", ",".join(list(alerted_jobs)[-500:]), is_secret=False)

    # -- newly blocked/unauthorized Jarvis actions -- a real security signal
    # (see JarvisLog's docstring), worth knowing about the moment it happens,
    # not just visible if you happen to open the Activity tab.
    alerted_logs = {x for x in get_setting(db, "jarvis_alerted_log_ids", "").split(",") if x}
    blocked = (
        db.query(models.JarvisLog)
        .filter(models.JarvisLog.allowed == False)  # noqa: E712
        .order_by(models.JarvisLog.created_at.desc())
        .limit(50)
        .all()
    )
    new_blocked = [r for r in blocked if r.id not in alerted_logs]
    if new_blocked:
        lines = [f"- [{r.source}] {r.action}: {(r.result or '')[:120]}" for r in new_blocked[:5]]
        extra = f"\n(+{len(new_blocked) - 5} more)" if len(new_blocked) > 5 else ""
        plural = "s" if len(new_blocked) != 1 else ""
        sent = _send_proactive_alert(
            db, f"Jarvis: {len(new_blocked)} blocked/unauthorized attempt{plural}:\n" + "\n".join(lines) + extra
        )
        if sent:
            alerted_logs.update(r.id for r in new_blocked)
            set_setting(db, "jarvis_alerted_log_ids", ",".join(list(alerted_logs)[-500:]), is_secret=False)


def _today_start() -> datetime:
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)


def _channel_due(db: Session, channel: models.Channel) -> bool:
    if not channel.auto_enabled or not channel.auto_per_day or channel.auto_per_day <= 0:
        return False

    today_start = _today_start()
    # Failed jobs must NOT count toward the daily quota. Counting them meant a
    # day where 3 renders failed looked "complete" to Chronos, so it created
    # nothing further -- you'd end the day with zero videos and no retries.
    # The quota should track videos actually produced (or still in progress),
    # not attempts made.
    todays_jobs = (
        db.query(models.VideoJob)
        .filter(models.VideoJob.channel_id == channel.id)
        .filter(models.VideoJob.created_at >= today_start)
        .filter(models.VideoJob.status != models.JobStatus.FAILED)
        .count()
    )
    if todays_jobs >= channel.auto_per_day:
        return False

    last_job = (
        db.query(models.VideoJob)
        .filter(models.VideoJob.channel_id == channel.id)
        .filter(models.VideoJob.status != models.JobStatus.FAILED)
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
        cleared = clear_stuck_jobs(db)
        if cleared:
            log.warning("Chronos watchdog: cleared %d stuck job(s) this tick", cleared)

        try:
            check_and_send_alerts(db)
        except Exception:
            log.exception("Chronos: proactive-alert check failed")

        # Nothing else to do while a render is in flight -- creating or
        # dispatching more work now is what caused the pile-up that kept
        # getting jobs OOM-killed.
        if render_gate.is_busy():
            log.info("Chronos: a render is active (%s); skipping this tick.", ", ".join(render_gate.active_jobs()))
            return

        # Drain the backlog before creating anything new. Jobs left QUEUED
        # (by the gate or the watchdog) previously had nothing to pick them
        # up, so they'd sit forever while Chronos happily made more.
        queued = (
            db.query(models.VideoJob)
            .filter(models.VideoJob.status == models.JobStatus.QUEUED)
            .order_by(models.VideoJob.created_at.asc())
            .first()
        )
        if queued:
            # Re-check the gate immediately before dispatching. Between the
            # is_busy() check at the top of this tick and here, the watchdog
            # may have requeued something -- and dispatching a job that's
            # already being rendered is how duplicate workers happen.
            if render_gate.is_busy():
                log.info("Chronos: %s is queued but a render is active; leaving it.", queued.id)
                return
            log.info("Chronos: picking up queued job %s", queued.id)
            orchestrator.dispatch_job(queued.id)
            return

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
                    # Dispatched on a thread -- calling run_job directly here
                    # blocked the entire scheduler loop for the whole render,
                    # so the watchdog couldn't run and nothing else ticked.
                    orchestrator.dispatch_job(job.id)
                    return  # one render at a time; the next tick handles the rest
            except Exception:
                log.exception("Chronos: failed to process channel %s", channel.id)
    finally:
        db.close()


async def automation_loop():
    log.info("Chronos automation loop started (checking every %ss)", CHECK_INTERVAL_SECONDS)
    # Clear any jobs stranded by the restart that's kicking off this very
    # process (e.g. a redeploy killed them mid-run) before the first tick.
    try:
        db = SessionLocal()
        try:
            cleared = clear_stuck_jobs(db)
            if cleared:
                log.warning("Chronos watchdog: cleared %d stuck job(s) on startup", cleared)
        finally:
            db.close()
    except Exception:
        log.exception("Chronos: startup stuck-job check failed")
    while True:
        try:
            await asyncio.get_event_loop().run_in_executor(None, _tick)
        except Exception:
            log.exception("Chronos: tick failed")
        await asyncio.sleep(CHECK_INTERVAL_SECONDS)
