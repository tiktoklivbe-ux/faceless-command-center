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
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from .. import models
from ..config import JOBS_DIR
from ..database import SessionLocal
from . import script_stage, assemble_stage, publish_youtube, publish_tiktok

AGENT_NAMES = ["script", "voice", "visuals", "assembly", "publish"]


def _log(db: Session, job: models.VideoJob, message: str):
    # Each line gets an ISO-8601 UTC timestamp prefix in brackets so Mission
    # Control's Live Activity Stream can show real relative times instead of
    # guessing from job.created_at. The Jobs panel's plain progress-log view
    # still reads fine with the prefix showing -- it's just a timestamp.
    #
    # This uses its OWN short-lived session rather than the caller's. The
    # caller's session stays open for the whole multi-minute render, and
    # committing progress lines through it kept a write transaction churning
    # on that long-lived connection -- which is what made unrelated requests
    # (Jarvis especially, since one turn makes several queries) stall behind
    # it. A tiny open-write-close session here releases the lock immediately.
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"[{ts}] {message}\n"
    job_id = job.id
    own = SessionLocal()
    try:
        fresh = own.get(models.VideoJob, job_id)
        if fresh is not None:
            fresh.stage_log = (fresh.stage_log or "") + line
            own.commit()
    except Exception:
        own.rollback()
    finally:
        own.close()
    # Do NOT assign job.stage_log here. Doing so would mark the attribute
    # dirty on the caller's long-lived session, and its next commit would
    # write that stale in-memory value back -- clobbering every line this
    # function wrote through its own session. Expiring the attribute instead
    # makes the caller re-read the real current value from the DB next time
    # it's touched.
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


def run_job(job_id: str):
    """Entry point invoked in the background. Opens its own DB session so it
    doesn't share one with the request that triggered it."""
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
            # --- Stage 1: script ---
            job.status = models.JobStatus.SCRIPT
            set_agent("script", "running")
            _log(db, job, "Script Agent: writing script…")
            script = script_stage.generate_script(db, channel.niche, job.topic, channel.style_notes)
            job.title = script.get("title", "")[:200]
            job.description = script.get("description", "")
            segments = script.get("segments", [])
            job.script_text = "\n".join(s["narration"] for s in segments)
            db.commit()
            set_agent("script", "done")
            _log(db, job, f"Script Agent: done — '{job.title}' ({len(segments)} segments)")

            # --- Stages 2-5: voice, visuals, ken-burns, captions, assembly ---
            job.status = models.JobStatus.ASSEMBLING
            db.commit()
            final_path, srt_path = assemble_stage.assemble_video(
                db, channel, segments, job_dir, lambda msg: _log(db, job, msg), set_agent
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
            job.status = models.JobStatus.FAILED
            job.error_message = str(e)
            for name in AGENT_NAMES:
                if _agents(job).get(name) == "running":
                    set_agent(name, "error")
            _log(db, job, f"FAILED: {e}")
            db.commit()
    finally:
        db.close()


def _publish(db: Session, job: models.VideoJob, channel: models.Channel, video_path: Path, set_agent=None):
    job.status = models.JobStatus.PUBLISHING
    if set_agent is None:
        set_agent = _make_set_agent(db, job)
    set_agent("publish", "running")
    db.commit()

    if channel.youtube_connected:
        try:
            _log(db, job, "Publish Agent: uploading to YouTube…")
            from .. import crypto
            access_token = publish_youtube.refresh_access_token(
                db, crypto.decrypt(channel.youtube_refresh_token_enc)
            )
            video_id = publish_youtube.upload_video(
                access_token, video_path, job.title, job.description
            )
            job.youtube_video_id = video_id
            _log(db, job, f"Publish Agent: YouTube upload complete: video ID {video_id} (uploaded as private -- "
                          f"review and publish it from YouTube Studio).")
        except Exception as e:
            _log(db, job, f"Publish Agent: YouTube publish failed: {e}")

    if channel.tiktok_connected:
        try:
            _log(db, job, "Publish Agent: uploading to TikTok…")
            from .. import crypto
            access_token = publish_tiktok.refresh_access_token(
                db, crypto.decrypt(channel.tiktok_refresh_token_enc)
            )
            publish_id = publish_tiktok.publish_video(access_token, video_path, job.title)
            job.tiktok_publish_id = publish_id
            _log(db, job, f"Publish Agent: TikTok upload complete: publish ID {publish_id} "
                          f"(posted as private/self-only unless your app has passed TikTok review).")
        except Exception as e:
            _log(db, job, f"Publish Agent: TikTok publish failed: {e}")

    job.status = models.JobStatus.PUBLISHED
    set_agent("publish", "done")
    db.commit()
