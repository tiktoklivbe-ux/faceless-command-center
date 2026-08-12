"""
Runs a VideoJob through every stage, persisting status/log/agent-status
updates to the database as it goes so the dashboard can show live progress
for each "agent" (Script, Voice, Visuals, Assembly, Publish) independently.
Designed to be called from a FastAPI BackgroundTask -- one job at a time,
which is the right amount of concurrency for a single-person operation
running on a small box (individual stages still parallelize internally --
see assemble_stage's Voice/Visual concurrency).
"""
import json
import os
import re
import time
import traceback
import logging
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from .. import models
from ..config import JOBS_DIR
from ..database import SessionLocal
from ..settings_store import get_setting

log = logging.getLogger("orchestrator")
from .. import render_gate
from ..agents_registry import agent_name
from . import script_stage, assemble_stage, ffmpeg_utils, publish_youtube, publish_tiktok

AGENT_NAMES = ["script", "voice", "visuals", "assembly", "publish"]


def _log(db: Session, job: models.VideoJob, message: str):
    # Each line gets an ISO-8601 UTC timestamp prefix in brackets so Mission
    # Control's Live Activity Stream can show real relative times.
    #
    # DEADLOCK HAZARD, and the reason this is written so carefully:
    # the caller's session stays open across the whole multi-minute render.
    # If it holds an open transaction (which SQLAlchemy starts implicitly on
    # the first query and keeps until commit/rollback), and this function
    # opens a SECOND connection to write, SQLite blocks -- the writer waits
    # for the reader's transaction to end, and the reader is the thing that
    # called the writer. Neither yields. The job then hangs forever with no
    # error, no timeout, and the log frozen mid-render.
    #
    # Releasing the caller's connection first is what makes the second write
    # able to acquire the lock.
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"[{ts}] {message}\n"
    job_id = job.id

    # End any transaction the caller is holding and hand its connection back
    # to the pool. Cheap, and the caller re-acquires transparently on next use.
    try:
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass

    own = SessionLocal()
    try:
        fresh = own.get(models.VideoJob, job_id)
        if fresh is not None:
            fresh.stage_log = (fresh.stage_log or "") + line
            own.commit()
    except Exception:
        try:
            own.rollback()
        except Exception:
            pass
    finally:
        own.close()

    # Don't assign job.stage_log on the caller's session -- that marks it
    # dirty and its next commit would write the stale in-memory value back,
    # clobbering lines written here. Expiring forces a fresh read instead.
    try:
        db.expire(job, ["stage_log"])
    except Exception:
        pass


def _agents(job: models.VideoJob) -> dict:
    try:
        return json.loads(job.agent_status or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}


def _make_set_agent(db: Session, job: models.VideoJob):
    def set_agent(name: str, status: str):
        agents = _agents(job)
        agents[name] = status
        job.agent_status = json.dumps(agents)
        db.commit()
    return set_agent


def dispatch_job(job_id: str):
    """Start a render in its own OS process, detached from the web server.

    Renders previously ran via FastAPI BackgroundTasks, i.e. inside the web
    worker -- minutes of heavy ffmpeg work in the process that also serves
    HTTP. That starved request handling and made the host return 502.

    Implemented with subprocess + an explicit module entry point rather than
    multiprocessing. multiprocessing's "spawn" start method makes the child
    re-import the parent's __main__ module, which under a real server is
    uvicorn's entry point -- the child either crashes on import or re-runs the
    whole application. Either way it dies instantly and silently, leaving the
    job sitting in QUEUED forever with an empty log. "fork" avoids that but
    inherits the parent's open SQLite handles and threads, which is its own
    source of deadlocks. A plain subprocess running `python -m app.worker`
    gets a clean interpreter with no inherited state and no __main__ games.
    """
    import subprocess
    import sys

    # Refuse to launch a second worker for a job that's already rendering.
    # This is the last line of defence: the watchdog and the backlog drain
    # both used to dispatch in the same tick, producing two workers for one
    # job that then fought over the same files. Even with that fixed, any
    # future caller gets stopped here.
    if job_id in render_gate.active_jobs():
        log.warning("Job %s is already being rendered; refusing to start a second worker.", job_id)
        return None

    repo_root = Path(__file__).resolve().parent.parent.parent
    worker_log = JOBS_DIR / job_id / "worker.log"
    try:
        worker_log.parent.mkdir(parents=True, exist_ok=True)
        log_handle = open(worker_log, "a", buffering=1, encoding="utf-8", errors="replace")
    except OSError:
        log_handle = subprocess.DEVNULL

    try:
        proc = subprocess.Popen(
            [sys.executable, "-m", "app.worker", job_id],
            cwd=str(repo_root),
            # Capture the worker's output to a file per job. Sending it to
            # DEVNULL threw away every traceback and log line the worker
            # produced -- which is why a hung render left no trace anywhere,
            # not in the job log and not in the server logs. This file is the
            # only place a crash before the first DB write can show up.
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=(os.name == "posix"),  # survives if the web worker restarts
        )
        log.info("Dispatched job %s to worker process pid=%s", job_id, proc.pid)

        # Persist the PID so cancel_job can actually terminate this specific
        # OS process later. Without this, a cancel had no way to reach the
        # real worker at all -- it could only flip the DB row and hope.
        db = SessionLocal()
        try:
            job = db.get(models.VideoJob, job_id)
            if job:
                job.worker_pid = proc.pid
                db.commit()
        finally:
            db.close()

        return proc.pid
    except Exception as e:
        # If the process can't be started at all, fall back to running inline
        # rather than silently doing nothing -- a slow render beats no render.
        # Recorded on the job too, so this degraded mode is visible instead of
        # looking like normal operation that mysteriously blocks the server.
        log.exception("Couldn't spawn a worker process for job %s; running inline instead", job_id)
        try:
            db = SessionLocal()
            try:
                job = db.get(models.VideoJob, job_id)
                if job:
                    _log(db, job, f"Note: couldn't start a separate render process ({e}); "
                                  f"running inline instead. The app may be slow to respond while this renders.")
            finally:
                db.close()
        except Exception:
            pass
        run_job(job_id)
        return None


def run_job(job_id: str):
    """Entry point invoked in the background. Opens its own DB session so it
    doesn't share one with the request that triggered it.

    Serialised by render_gate: only one video renders at a time. Concurrent
    renders were exhausting the container's memory, and an OOM kill leaves no
    exception to catch -- the job simply stopped with no error logged. If the
    slot is taken, this leaves the job QUEUED for Chronos to pick up later
    rather than forcing its way in.
    """
    if not render_gate.try_acquire(job_id):
        db = SessionLocal()
        try:
            job = db.get(models.VideoJob, job_id)
            if job:
                job.status = models.JobStatus.QUEUED
                _log(db, job, f"Waiting -- another video is rendering ({', '.join(render_gate.active_jobs())}). "
                              f"This one stays queued and will start when that finishes.")
                db.commit()
        finally:
            db.close()
        return

    try:
        _run_job_inner(job_id)
    finally:
        render_gate.release(job_id)


def _preflight(db: Session, channel) -> list[str]:
    """Check configuration BEFORE burning time on a render.

    Without this, a missing or undecryptable API key doesn't surface until the
    stage that needs it -- as a raw 401, minutes in, which reads like a
    mysterious failure rather than "you need to enter a key". An empty key
    string produces exactly the same 401 as a wrong one, so the distinction
    has to be made here.
    """
    problems = []

    ffmpeg_problem = ffmpeg_utils.available()
    if ffmpeg_problem:
        problems.append(ffmpeg_problem)

    provider = get_setting(db, "llm_provider", "anthropic")
    llm_keys = {
        "anthropic": get_setting(db, "anthropic_api_key"),
        "openai": get_setting(db, "openai_api_key"),
        "gemini": get_setting(db, "gemini_api_key"),
    }
    if not any(llm_keys.values()):
        problems.append(
            "No working script-writing key. Add an Anthropic, OpenAI, or Gemini key in Settings. "
            "(If you entered one already, it may have become unreadable after an encryption-key "
            "change -- re-enter it and it'll stick.)"
        )
    elif not llm_keys.get(provider):
        available = [k for k, v in llm_keys.items() if v]
        problems.append(
            f"Settings say to use '{provider}' for scripts, but that key isn't readable. "
            f"Working keys: {', '.join(available)}. Either re-enter the {provider} key or switch provider."
        )

    img_provider = get_setting(db, "image_provider", "placeholder")
    if img_provider != "placeholder":
        img_key = {
            "openai": "openai_api_key",
            "stability": "stability_api_key",
            "gemini": "gemini_api_key",
        }.get(img_provider)
        if img_key and not get_setting(db, img_key):
            problems.append(
                f"Image provider is '{img_provider}' but that key isn't readable. Re-enter it, "
                f"or set the image provider to 'placeholder' to keep producing videos meanwhile."
            )
    return problems


def _run_job_inner(job_id: str):
    db = SessionLocal()
    try:
        job = db.get(models.VideoJob, job_id)
        if not job:
            return
        channel = job.channel
        job_dir = JOBS_DIR / job.id
        job_dir.mkdir(parents=True, exist_ok=True)
        set_agent = _make_set_agent(db, job)
        for name in AGENT_NAMES:
            set_agent(name, "idle")

        try:
            # Fail fast on misconfiguration rather than minutes into a render.
            # Clear out any ffmpeg processes orphaned by earlier hung renders.
            # They hold CPU indefinitely and are why a machine can end up
            # unable to finish even a trivial render.
            reaped = ffmpeg_utils.kill_orphaned_ffmpeg()
            if reaped:
                _log(db, job, f"Cleaned up {reaped} stuck ffmpeg process(es) left over from earlier renders.")

            issues = _preflight(db, channel)
            if issues:
                raise RuntimeError("Can't start: " + " | ".join(issues))

            # --- Stage 1: script ---
            job.status = models.JobStatus.SCRIPT
            set_agent("script", "running")
            _log(db, job, f"Script Agent ({agent_name('athena')}): writing the script — one call to Claude, usually 10-20s.")
            _t = time.time()
            # Auto-created jobs run with topic="" every time, so without this
            # the model has no idea what the channel already covered and can
            # (and did -- three near-duplicate "owning a private island"
            # videos in one day) land on the same subject repeatedly.
            recent_titles = [
                t for (t,) in db.query(models.VideoJob.title)
                .filter(models.VideoJob.channel_id == channel.id)
                .filter(models.VideoJob.id != job.id)
                .filter(models.VideoJob.title.isnot(None))
                .filter(models.VideoJob.title != "")
                .order_by(models.VideoJob.created_at.desc())
                .limit(10)
                .all()
            ]
            script = script_stage.generate_script(
                db, channel.niche, job.topic, channel.style_notes, kind=job.kind, avoid_topics=recent_titles
            )
            job.title = script.get("title", "")[:200]
            description = script.get("description", "")
            # Hashtags stay tied to THIS channel's own niche (the prompt in
            # script_stage.py is instructed to never borrow another channel's
            # tags) -- appended to the description so they ride along to
            # both YouTube and TikTok without a schema change, and re-parsed
            # out in _publish for YouTube's separate `tags` field / TikTok's caption.
            hashtags = [h for h in script.get("hashtags", []) if h.startswith("#")]
            job.description = f"{description}\n\n{' '.join(hashtags)}".strip() if hashtags else description
            segments = script.get("segments", [])
            job.script_text = "\n".join(s["narration"] for s in segments)
            db.commit()
            set_agent("script", "done")
            _log(db, job, f"Script Agent: done in {time.time()-_t:.0f}s — '{job.title}' ({len(segments)} segments)")

            # A rough up-front expectation, so a slow run is recognisable as
            # slow rather than just unknown. Refined per-segment once real
            # timings come in.
            est = len(segments) * 12 + 30
            _log(db, job, f"Estimated total: about {est//60}m {est%60}s for {len(segments)} segments. "
                          f"Next: each segment gets narration (ElevenLabs) and an image generated in parallel, "
                          f"then rendered into a clip. Finally all clips are stitched and captions burned in.")

            # --- Stages 2-5: voice, visuals, ken-burns, captions, assembly ---
            job.status = models.JobStatus.ASSEMBLING
            db.commit()
            final_path, srt_path = assemble_stage.assemble_video(
                db, channel, segments, job_dir, lambda msg: _log(db, job, msg), set_agent, kind=job.kind
            )
            job.video_path = str(final_path)
            job.captions_path = str(srt_path)
            job.status = models.JobStatus.READY
            db.commit()
            _log(db, job, "All agents done. Video assembled and ready for review.")

            # --- Stage 6: optional publish ---
            if job.auto_publish:
                _publish(db, job, channel, final_path, set_agent)
            else:
                set_agent("publish", "idle")

        except Exception as e:
            # str(e) alone is frequently empty or useless -- plenty of
            # exceptions carry no message, which produced "failed" with no
            # explanation and made every failure a guessing game. Capture the
            # type, the message, and the traceback tail so the actual cause is
            # always visible in the UI without needing server log access.
            tb = traceback.format_exc()
            detail = str(e).strip() or "(no message)"
            job.status = models.JobStatus.FAILED
            job.error_message = f"{type(e).__name__}: {detail}"[:500]
            for name in AGENT_NAMES:
                if _agents(job).get(name) == "running":
                    set_agent(name, "error")
            _log(db, job, f"FAILED — {type(e).__name__}: {detail}")
            # Last few traceback frames: enough to pinpoint the failing line,
            # short enough not to bury the log.
            tb_tail = "\n".join(tb.strip().splitlines()[-6:])
            _log(db, job, f"Technical detail:\n{tb_tail}")
            log.exception("Job %s failed", job.id)
            db.commit()
    finally:
        db.close()


def _publish(db: Session, job: models.VideoJob, channel: models.Channel, video_path: Path, set_agent=None):
    job.status = models.JobStatus.PUBLISHING
    if set_agent is None:
        set_agent = _make_set_agent(db, job)
    set_agent("publish", "running")
    db.commit()

    # Every platform's failure used to just get logged to the stage log and
    # then the job was marked PUBLISHED regardless -- a job that failed on
    # EVERY connected platform (e.g. a dead/expired OAuth token) looked
    # identical to a real success everywhere except the fine print of the
    # log. That's also why a publish failure never triggered the proactive
    # WhatsApp alert: that only watches for status=FAILED, which this job
    # never actually reached. Now tracked properly below.
    attempted = []
    failures = []

    # Pulled back out of the description (see script_stage/orchestrator's
    # script-stage step) so each platform's own hashtag/tag field gets them
    # too, not just the description text.
    hashtags = re.findall(r"#\w+", job.description or "")

    if channel.youtube_connected:
        attempted.append("YouTube")
        try:
            _log(db, job, "Publish Agent: uploading to YouTube…")
            from .. import crypto
            access_token = publish_youtube.refresh_access_token(
                db, crypto.decrypt(channel.youtube_refresh_token_enc)
            )
            privacy = getattr(channel, "youtube_privacy", None) or "public"
            video_id = publish_youtube.upload_video(
                access_token, video_path, job.title, job.description, privacy_status=privacy,
                tags=[h.lstrip("#") for h in hashtags],
            )
            job.youtube_video_id = video_id
            _log(db, job, f"Publish Agent: YouTube upload complete: video ID {video_id} "
                          f"(requested privacy: {privacy}). NOTE: if your Google OAuth app is still "
                          f"in 'Testing'/unverified state, Google forces the video to PRIVATE regardless "
                          f"-- pass Google's app verification to get genuinely-public auto-uploads.")
        except Exception as e:
            failures.append(f"YouTube: {e}")
            _log(db, job, f"Publish Agent: YouTube publish failed: {e}")

    # TikTok never gets long-form uploads -- a 5-7 minute horizontal video
    # doesn't fit that platform's format, so there's nothing to attempt
    # (this deliberately isn't counted as a "failure": there was no real
    # attempt to fail).
    if channel.tiktok_connected and job.kind != "longform":
        attempted.append("TikTok")
        try:
            _log(db, job, "Publish Agent: uploading to TikTok…")
            from .. import crypto
            access_token = publish_tiktok.refresh_access_token(
                db, crypto.decrypt(channel.tiktok_refresh_token_enc)
            )
            # TikTok's "title" field is really the caption -- hashtags belong
            # in it directly (that's how TikTok's own discovery reads tags),
            # unlike YouTube where they're a separate structured field.
            tiktok_caption = f"{job.title} {' '.join(hashtags)}".strip()
            publish_id = publish_tiktok.publish_video(access_token, video_path, tiktok_caption)
            job.tiktok_publish_id = publish_id
            _log(db, job, f"Publish Agent: TikTok upload complete: publish ID {publish_id} "
                          f"(posted as private/self-only unless your app has passed TikTok review).")
        except Exception as e:
            failures.append(f"TikTok: {e}")
            _log(db, job, f"Publish Agent: TikTok publish failed: {e}")

    if attempted and len(failures) == len(attempted):
        # Attempted at least one platform and every single one failed --
        # this is a real failure, not a success, and needs to look like one.
        job.status = models.JobStatus.FAILED
        job.error_message = "Publish failed on every connected platform: " + "; ".join(failures)
        set_agent("publish", "error")
    else:
        job.status = models.JobStatus.PUBLISHED
        if failures:
            # Succeeded somewhere, failed elsewhere -- still worth surfacing,
            # just not as a hard failure since at least one upload landed.
            job.error_message = "Published, but failed on: " + "; ".join(failures)
        set_agent("publish", "done")
    db.commit()
