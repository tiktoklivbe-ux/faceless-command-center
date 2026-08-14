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

from sqlalchemy import or_
from sqlalchemy.orm import Session

from . import models, ntfy_utils, render_gate, twilio_utils
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
# Hard cap on how long a SINGLE render may actually run. Unlike the stalled
# check (which only fires once a job stops updating), this cancels a job that's
# still making steady progress but has simply taken too long -- a lone video is
# never worth this much compute/API usage.
MAX_JOB_RUNTIME_MINUTES = 100
_ACTIVE_STATUSES = [
    models.JobStatus.QUEUED,
    models.JobStatus.SCRIPT,
    models.JobStatus.VOICE,
    models.JobStatus.VISUALS,
    models.JobStatus.CAPTIONS,
    models.JobStatus.ASSEMBLING,
    models.JobStatus.PUBLISHING,
]
# Statuses where a job is actively burning compute (everything active except
# QUEUED, which is just waiting for the render slot and costs nothing). The
# runtime cap only applies to these, so a job patiently queued behind a long
# render isn't punished for someone else's runtime.
_RENDERING_STATUSES = [s for s in _ACTIVE_STATUSES if s != models.JobStatus.QUEUED]


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
    # --- absolute runtime cap ------------------------------------------------
    # Cancel any job that's been actively rendering longer than the cap, EVEN IF
    # it's still making steady progress -- the stalled check below only catches
    # jobs that stop updating, so a long video grinding forward segment by
    # segment would otherwise sail past every limit and burn 100+ minutes of
    # usage. Uses the same PID kill as a manual cancel: just flipping the DB row
    # to FAILED wouldn't stop the live worker, which would carry on rendering
    # and overwrite the status right back.
    from .pipeline import ffmpeg_utils
    runtime_cutoff = datetime.utcnow() - timedelta(minutes=MAX_JOB_RUNTIME_MINUTES)
    overrun = (
        db.query(models.VideoJob)
        .filter(models.VideoJob.status.in_(_RENDERING_STATUSES))
        .filter(models.VideoJob.created_at < runtime_cutoff)
        .all()
    )
    for job in overrun:
        log.warning("Chronos watchdog: job %s passed the %d-min runtime cap; cancelling to save usage.",
                    job.id, MAX_JOB_RUNTIME_MINUTES)
        try:
            ffmpeg_utils.kill_worker_by_pid(job.worker_pid)
            ffmpeg_utils.kill_orphaned_ffmpeg(max_age_seconds=0)
        except Exception:
            log.exception("Chronos watchdog: couldn't kill worker for overrun job %s", job.id)
        try:
            render_gate.release(job.id)
        except Exception:
            pass
        try:
            agents = json.loads(job.agent_status or "{}")
            job.agent_status = json.dumps({k: ("idle" if v == "running" else v) for k, v in agents.items()})
        except (json.JSONDecodeError, TypeError):
            pass
        job.status = models.JobStatus.FAILED
        job.error_message = (
            f"Cancelled automatically after {MAX_JOB_RUNTIME_MINUTES} minutes of rendering -- a single "
            "video taking this long isn't worth the compute, so the render was stopped and the slot freed."
        )
        job.stage_log = (job.stage_log or "") + (
            f"\n[watchdog] Runtime cap hit ({MAX_JOB_RUNTIME_MINUTES} min). Killed the render and freed the slot.\n"
        )
    if overrun:
        db.commit()

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
    """Tries every configured channel -- WhatsApp (Twilio) and ntfy.sh -- not
    just one, so setting up either one is enough to actually get alerted.
    Returns True if AT LEAST ONE channel actually delivered the message; the
    caller uses this to decide whether it's safe to mark the underlying
    failure/block as "alerted". If everything configured is temporarily down
    or misconfigured, returning False means the same failure gets retried
    next tick instead of being silently and permanently lost."""
    sent_any = False

    account_sid = get_setting(db, "twilio_account_sid")
    auth_token = get_setting(db, "twilio_auth_token")
    from_number = get_setting(db, "twilio_whatsapp_number")
    for to_number in _proactive_alert_recipients(db):
        if twilio_utils.send_whatsapp_message(account_sid, auth_token, from_number, to_number, body):
            sent_any = True

    ntfy_topic = get_setting(db, "ntfy_topic")
    if ntfy_topic and ntfy_utils.send_ntfy_message(ntfy_topic, body):
        sent_any = True

    return sent_any


def check_and_send_alerts(db: Session) -> None:
    """Jarvis reaching out to YOU without being asked first, over WhatsApp
    and/or ntfy.sh (whichever's configured -- either is enough). Runs every
    tick alongside the render loop, not gated behind it, so a failure gets
    flagged even while nothing else is rendering.

    Three independent checks -- failures, blocked/unauthorized actions, and
    successful publishes -- each deduplicated against its own settings-stored
    set of ids already alerted on so a restart or the next tick doesn't
    re-send the same one. Off by default requires nothing (it silently
    no-ops with nothing configured); can be explicitly disabled via
    jarvis_proactive_alerts="false" even with a channel set up, if you want
    Jarvis reachable but not proactive.
    """
    if get_setting(db, "jarvis_proactive_alerts", "true") == "false":
        return
    if not _proactive_alert_recipients(db) and not get_setting(db, "ntfy_topic"):
        return  # nothing configured on either channel -- not worth querying the DB for nothing

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

    # -- newly published videos -- real posts, not just "job finished with
    # nothing connected to post to" (gated on an actual platform video id
    # existing, not just status=PUBLISHED, since a channel with nothing
    # connected also reaches PUBLISHED with nothing having actually posted).
    alerted_published = {x for x in get_setting(db, "jarvis_alerted_published_ids", "").split(",") if x}
    published = (
        db.query(models.VideoJob)
        .filter(models.VideoJob.status == models.JobStatus.PUBLISHED)
        .filter(or_(models.VideoJob.youtube_video_id.isnot(None), models.VideoJob.tiktok_publish_id.isnot(None)))
        .order_by(models.VideoJob.created_at.desc())
        .limit(50)
        .all()
    )
    new_published = [j for j in published if j.id not in alerted_published]
    if new_published:
        lines = []
        for j in new_published[:5]:
            platforms = []
            if j.youtube_video_id:
                platforms.append(f"YouTube ({j.youtube_video_id})")
            if j.tiktok_publish_id:
                platforms.append("TikTok")
            lines.append(f"- \"{j.title or j.topic or 'untitled'}\" ({j.channel.name if j.channel else '?'}): "
                         f"{', '.join(platforms)}")
        extra = f"\n(+{len(new_published) - 5} more)" if len(new_published) > 5 else ""
        plural = "s" if len(new_published) != 1 else ""
        sent = _send_proactive_alert(
            db, f"Jarvis: {len(new_published)} video{plural} posted:\n" + "\n".join(lines) + extra
        )
        if sent:
            alerted_published.update(j.id for j in new_published)
            set_setting(db, "jarvis_alerted_published_ids", ",".join(list(alerted_published)[-500:]), is_secret=False)


def _today_start() -> datetime:
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)


def _quota_due(db: Session, channel: models.Channel, kind: str, per_day: int) -> bool:
    """Same due-or-not logic for either video kind, just scoped to that
    kind's own quota/spacing/last-job-of-that-kind -- shorts and long-form
    are genuinely separate schedules on the same channel, not one shared
    counter, so a channel can be "done with today's shorts" while still
    due for its one long-form video."""
    if not per_day or per_day <= 0:
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
        .filter(models.VideoJob.kind == kind)
        .filter(models.VideoJob.created_at >= today_start)
        .filter(models.VideoJob.status != models.JobStatus.FAILED)
        .count()
    )
    if todays_jobs >= per_day:
        return False

    last_job = (
        db.query(models.VideoJob)
        .filter(models.VideoJob.channel_id == channel.id)
        .filter(models.VideoJob.kind == kind)
        .filter(models.VideoJob.status != models.JobStatus.FAILED)
        .order_by(models.VideoJob.created_at.desc())
        .first()
    )
    if not last_job or not last_job.created_at:
        return True  # never made one of this kind yet -- due immediately

    # Minimum spacing between videos so they don't burst out back-to-back.
    # Enforced as a FLOOR on the per-day interval: even a high per_day won't
    # produce videos closer together than this. Defaults to 5 hours per the
    # "spread each video out ~5 hours" request; settable via the
    # min_hours_between_videos setting if you ever want it tighter/looser.
    try:
        min_gap_hours = float(get_setting(db, "min_hours_between_videos", "5") or 5)
    except (TypeError, ValueError):
        min_gap_hours = 5.0
    interval = max(86400 / per_day, min_gap_hours * 3600)
    elapsed = (datetime.utcnow() - last_job.created_at).total_seconds()
    return elapsed >= interval


def _channel_due_kind(db: Session, channel: models.Channel) -> str | None:
    """Which kind of video (if any) this channel is due for right now --
    checks shorts first, then long-form, so a channel due for both only
    gets one job created per tick (same "one render at a time" pacing the
    rest of Chronos already relies on)."""
    if not channel.auto_enabled:
        return None
    if _quota_due(db, channel, "short", channel.auto_per_day):
        return "short"
    # Shorts-only mode (user request: long-form burns 15-25x a short's
    # ElevenLabs credits per video) -- never auto-create a long-form job here,
    # regardless of the channel's own auto_longform_per_day setting.
    if get_setting(db, "schedule_shorts_only", "") == "true":
        return None
    if _quota_due(db, channel, "longform", channel.auto_longform_per_day):
        return "longform"
    return None


def _slot_schedule_due(db: Session):
    """Fixed wall-clock posting schedule (schedule_mode='slots').

    Returns (channel, kind, extended) for a slot whose local time has passed
    today and hasn't been fulfilled yet, else (None, None, False). Slots come
    from `post_schedule_times` interpreted in `post_timezone`. One slot per day
    -- rotating by day-of-year so it isn't always the same clock time -- is the
    long-form on the long-form channel; the other slots are shorts on the
    shorts channel. Every other day that long-form is the extended 6-10 min
    variant. Independent of a channel's auto_enabled flag: the schedule itself
    is the switch."""
    if get_setting(db, "schedule_mode", "") != "slots":
        return None, None, False

    from zoneinfo import ZoneInfo
    tz_name = get_setting(db, "post_timezone", "") or "America/Denver"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("America/Denver")

    slots = []
    for part in (get_setting(db, "post_schedule_times", "03:00,08:00,12:00,17:00,22:00") or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            hh, mm = part.split(":")
            slots.append((int(hh), int(mm)))
        except (ValueError, AttributeError):
            continue
    if not slots:
        return None, None, False
    slots.sort()
    n = len(slots)

    shorts_id = get_setting(db, "schedule_shorts_channel_id", "")
    longform_id = get_setting(db, "schedule_longform_channel_id", "")
    shorts_ch = db.get(models.Channel, shorts_id) if shorts_id else None
    longform_ch = db.get(models.Channel, longform_id) if longform_id else None

    # Shorts-only mode (user request 2026-08-14: long-form burns 15-25x a
    # short's ElevenLabs credits per video). Setting longform_slot_index to -1
    # means no slot index can ever match it, so every slot below falls through
    # to the shorts branch -- durable across restarts/deploys since it's a
    # setting, not a one-off skip.
    shorts_only = get_setting(db, "schedule_shorts_only", "") == "true"

    now_local = datetime.now(tz)
    doy = now_local.timetuple().tm_yday
    longform_slot_index = -1 if shorts_only else (doy % n)  # which slot is the long-form today (rotates daily)
    extended_today = (doy % 2 == 0)     # every other day the long-form is the extended variant

    # If the process was asleep for hours, skip stale slots rather than dumping
    # a pile of catch-up videos the moment it wakes.
    GRACE_SECONDS = 3 * 3600

    for idx, (hh, mm) in enumerate(slots):
        slot_local = now_local.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if now_local < slot_local:
            continue  # this slot's time hasn't arrived yet today
        if (now_local - slot_local).total_seconds() > GRACE_SECONDS:
            continue  # missed it by too long -- skip

        is_longform = (idx == longform_slot_index)
        channel = longform_ch if is_longform else shorts_ch
        kind = "longform" if is_longform else "short"
        if not channel:
            continue
        # Don't burn a render on a long-form the target channel can't even post
        # yet (e.g. finance channel not connected) -- it'll start once connected.
        if is_longform and not channel.youtube_connected:
            continue

        slot_utc = slot_local.astimezone(timezone.utc).replace(tzinfo=None)
        already = (
            db.query(models.VideoJob)
            .filter(models.VideoJob.channel_id == channel.id)
            .filter(models.VideoJob.kind == kind)
            .filter(models.VideoJob.status != models.JobStatus.FAILED)
            .filter(models.VideoJob.created_at >= slot_utc)
            .count()
        )
        if already == 0:
            return channel, kind, (is_longform and extended_today)
    return None, None, False


def _tick():
    db = SessionLocal()
    try:
        cleared = clear_stuck_jobs(db)
        if cleared:
            log.warning("Chronos watchdog: cleared %d stuck job(s) this tick", cleared)

        # Keep the jobs folder bounded every tick, so leftover render files can
        # never silently fill the disk (a full disk is what corrupted the DB on
        # 2026-08-13). Cheap: a no-op until there are more than the cap.
        try:
            orchestrator.prune_old_job_dirs()
        except Exception:
            log.exception("Chronos: job-dir prune failed")

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

        # Fixed wall-clock schedule takes priority when enabled. Runs
        # independently of channels' auto_enabled flags -- the schedule is the
        # switch. One job per tick, same one-render-at-a-time pacing as below.
        try:
            sched_ch, sched_kind, sched_extended = _slot_schedule_due(db)
        except Exception:
            log.exception("Chronos: slot-schedule check failed")
            sched_ch = None
        if sched_ch:
            job = models.VideoJob(
                channel_id=sched_ch.id,
                topic="",
                kind=sched_kind,
                extended=sched_extended,
                auto_publish=True,  # a posting schedule is meant to post
            )
            db.add(job)
            db.commit()
            db.refresh(job)
            log.info("Chronos: schedule created %s%s job %s for %s",
                     sched_kind, " (extended)" if sched_extended else "", job.id, sched_ch.name)
            orchestrator.dispatch_job(job.id)
            return

        channels = db.query(models.Channel).filter(models.Channel.auto_enabled == True).all()  # noqa: E712
        for channel in channels:
            try:
                due_kind = _channel_due_kind(db, channel)
                if due_kind:
                    job = models.VideoJob(
                        channel_id=channel.id,
                        topic="",  # let Apollo/Athena choose
                        kind=due_kind,
                        auto_publish=channel.auto_publish_scheduled,
                    )
                    db.add(job)
                    db.commit()
                    db.refresh(job)
                    log.info("Chronos: auto-created %s job %s for channel %s", due_kind, job.id, channel.name)
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
            # Drop any orphaned render lock left by a crash (e.g. a blank-holder
            # lock, or one naming a job that no longer exists). Without this the
            # render slot stays wedged shut and the scheduler skips every tick
            # thinking a render is forever in progress -- exactly what stalled
            # posting after the 2026-08-13 corruption/restart.
            active_ids = [
                r[0] for r in db.query(models.VideoJob.id)
                .filter(models.VideoJob.status.in_(_RENDERING_STATUSES)).all()
            ]
            render_gate.reconcile(active_ids)
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
