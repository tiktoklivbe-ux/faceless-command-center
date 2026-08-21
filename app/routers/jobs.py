from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import models, schemas, crypto
from ..database import get_db
from ..pipeline import orchestrator, publish_youtube, publish_tiktok

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("/youtube-status-check")
def youtube_status_check(channel_id: str, limit: int = 10, db: Session = Depends(get_db)):
    """Diagnostic: what recently-published videos' privacy status ACTUALLY is
    on YouTube right now, straight from Google -- not just what this app
    requested at upload time. The upload call never verified the outcome, so
    a video silently forced to Private by an unverified OAuth app (the
    documented Google 'Testing' mode behavior) would look identical to a real
    success everywhere else in this app. Read-only; changes nothing."""
    channel = db.get(models.Channel, channel_id)
    if not channel or not channel.youtube_connected or not channel.youtube_refresh_token_enc:
        raise HTTPException(400, "That channel isn't connected to YouTube.")
    try:
        access_token = publish_youtube.refresh_access_token(db, crypto.decrypt(channel.youtube_refresh_token_enc))
    except Exception as e:
        return {"error": f"Couldn't refresh the access token: {e}. If this fails, the OAuth "
                          f"connection itself may have expired (common in Google's 'Testing' "
                          f"mode, where tokens expire after ~7 days) -- reconnect the channel."}

    jobs = (
        db.query(models.VideoJob)
        .filter(models.VideoJob.channel_id == channel_id)
        .filter(models.VideoJob.youtube_video_id.isnot(None))
        .filter(models.VideoJob.youtube_video_id != "")
        .order_by(models.VideoJob.created_at.desc())
        .limit(limit)
        .all()
    )
    results = []
    for j in jobs:
        status = publish_youtube.check_video_status(access_token, j.youtube_video_id)
        results.append({
            "job_id": j.id, "video_id": j.youtube_video_id,
            "title": (j.title or "")[:60], "created_at": str(j.created_at),
            "actual_privacy_status": status.get("privacyStatus", status.get("error", "unknown")),
        })
    return {"channel": channel.name, "checked": len(results), "results": results}


@router.get("", response_model=list[schemas.JobOut])
def list_jobs(channel_id: str | None = None, limit: int = 50, db: Session = Depends(get_db)):
    # Capped deliberately. This returned EVERY job ever created, each carrying
    # its full script text and progress log -- a payload that grows without
    # bound while the dashboard polls this endpoint continuously. The library
    # only ever displays recent jobs anyway.
    q = db.query(models.VideoJob)
    if channel_id:
        q = q.filter(models.VideoJob.channel_id == channel_id)
    return q.order_by(models.VideoJob.created_at.desc()).limit(min(limit, 200)).all()


@router.post("", response_model=schemas.JobOut)
def create_job(payload: schemas.JobCreate, background_tasks: BackgroundTasks,
                db: Session = Depends(get_db)):
    channel = db.get(models.Channel, payload.channel_id)
    if not channel:
        raise HTTPException(404, "Channel not found")
    job = models.VideoJob(
        channel_id=channel.id,
        topic=payload.topic,
        kind=payload.kind if payload.kind in ("short", "longform") else "short",
        auto_publish=payload.auto_publish,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    # Dispatched to a separate process -- running a render inside the web
    # worker starved HTTP handling and made the host return 502.
    orchestrator.dispatch_job(job.id)
    return job


@router.get("/benchmark")
def benchmark():
    """Measures how fast THIS machine actually renders video.

    The point of this is to settle a question the logs can't: when a render
    takes hours, is it a bug, or is the instance just too slow? Everything in
    the pipeline is bounded by timeouts now, so a job that runs for hours
    without erroring means ffmpeg is genuinely working the whole time -- and
    that's a hardware answer, not a code one. This renders a single known
    clip and reports the real numbers.
    """
    import os
    import subprocess
    import tempfile
    import time as _time

    from ..pipeline import ffmpeg_utils

    cpus = os.cpu_count() or 1
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        img, aud, out = td / "b.png", td / "b.mp3", td / "b.mp4"
        subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc2=s=1024x1536",
                        "-frames:v", "1", str(img)], capture_output=True, stdin=subprocess.DEVNULL)
        subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
                        "-t", "7", "-q:a", "9", "-acodec", "libmp3lame", str(aud)],
                       capture_output=True, stdin=subprocess.DEVNULL)

        t0 = _time.time()
        try:
            ffmpeg_utils.ken_burns_clip(img, aud, 7.0, out)
            clip_seconds = _time.time() - t0
            ok = True
            err = None
        except Exception as e:
            clip_seconds = _time.time() - t0
            ok = False
            err = str(e)[:400]

    # A typical video is 8-9 segments, and the final caption encode costs
    # roughly another 1.5 clips' worth of work.
    projected = clip_seconds * 9 * 1.2 if ok else None

    verdict = "unknown"
    advice = ""
    if ok:
        if clip_seconds < 8:
            verdict = "healthy"
            advice = ("This machine renders a clip quickly. A full video should finish in a couple of "
                      "minutes. If real jobs are taking far longer than the projection below, the "
                      "problem is something other than raw CPU speed.")
        elif clip_seconds < 25:
            verdict = "slow"
            advice = ("Rendering works but this instance is underpowered for video encoding. More CPU "
                      "would cut render time roughly proportionally.")
        else:
            verdict = "very slow"
            advice = ("This instance is far too slow for video encoding -- that alone explains multi-hour "
                      "renders. No further code tuning will meaningfully fix this; it needs more CPU.")

    return {
        "cpu_count": cpus,
        "single_clip_seconds": round(clip_seconds, 1),
        "projected_full_video_seconds": round(projected) if projected else None,
        "projected_full_video_human": f"{round(projected//60)}m {round(projected%60)}s" if projected else None,
        "verdict": verdict,
        "advice": advice,
        "render_succeeded": ok,
        "error": err,
    }


@router.get("/{job_id}", response_model=schemas.JobOut)
def get_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(models.VideoJob, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@router.delete("/{job_id}")
def delete_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(models.VideoJob, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    db.delete(job)
    db.commit()
    return {"ok": True}


@router.post("/{job_id}/cancel", response_model=schemas.JobOut)
def cancel_job(job_id: str, db: Session = Depends(get_db)):
    """Actually stop a running job, not just mark it FAILED.

    This used to only flip the DB row to FAILED and kill orphaned ffmpeg
    processes -- the real worker process (a separate OS process; see
    orchestrator.dispatch_job) was never touched. It kept running completely
    unaware it had been "cancelled", and once it finished whatever stage it
    was on, it unconditionally overwrote the status back to SCRIPT/ASSEMBLING/
    READY as normal -- so cancel looked like it worked for a moment and then
    the video kept rendering anyway. Now the actual process gets killed by
    PID before the slot is freed, so nothing is left running to stomp on the
    cancellation, and a second job can't start rendering alongside a
    "cancelled" one that's still secretly alive burning CPU/API calls.
    """
    from ..pipeline import ffmpeg_utils
    from .. import render_gate

    job = db.get(models.VideoJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    already_finished = job.status in (
        models.JobStatus.PUBLISHED, models.JobStatus.READY, models.JobStatus.FAILED,
    )
    if already_finished:
        raise HTTPException(status_code=400, detail=f"That job isn't running (status: {job.status.value}).")

    worker_killed = ffmpeg_utils.kill_worker_by_pid(job.worker_pid)
    reaped = ffmpeg_utils.kill_orphaned_ffmpeg(max_age_seconds=0)  # any ffmpeg it had already spawned
    render_gate.release(job_id)  # only free the slot AFTER the real process is confirmed dead/gone

    # Clear "running" agents -- otherwise Voice/Visual/Assembly stay lit
    # forever and look permanently busy.
    try:
        import json as _json
        agents = _json.loads(job.agent_status or "{}")
        job.agent_status = _json.dumps({k: ("idle" if v == "running" else v) for k, v in agents.items()})
    except Exception:
        pass

    job.status = models.JobStatus.FAILED
    job.error_message = "Cancelled manually."
    job.stage_log = (job.stage_log or "") + (
        f"\n[cancelled] Stopped by hand. "
        f"{'Killed the render process. ' if worker_killed else 'Render process had already stopped on its own. '}"
        f"{f'Also killed {reaped} running ffmpeg process(es). ' if reaped else ''}"
        f"The render slot is now free for the next video.\n"
    )
    db.commit()
    db.refresh(job)
    return job


@router.get("/{job_id}/worker-log")
def worker_log(job_id: str, db: Session = Depends(get_db)):
    """The render worker's raw stdout/stderr.

    This is the only place a crash BEFORE the first database write can show
    up -- the job's own progress log can't record something that killed the
    worker before it got that far.
    """
    from ..config import JOBS_DIR

    path = JOBS_DIR / job_id / "worker.log"
    if not path.exists():
        return {"exists": False, "log": "", "note": "No worker log yet -- the render may not have started."}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return {"exists": True, "log": "", "note": f"Couldn't read it: {e}"}
    return {"exists": True, "log": text[-20000:], "size": len(text)}


@router.get("/{job_id}/video")
def get_job_video(job_id: str, db: Session = Depends(get_db)):
    job = db.get(models.VideoJob, job_id)
    if not job or not job.video_path:
        raise HTTPException(404, "Video not ready")
    return FileResponse(job.video_path, media_type="video/mp4", filename=f"{job.id}.mp4")


@router.post("/{job_id}/publish", response_model=schemas.JobOut)
def publish_job(job_id: str, db: Session = Depends(get_db)):
    """Manually trigger publish for a job that's sitting in READY status
    (i.e. you reviewed the video and decided to post it)."""
    job = db.get(models.VideoJob, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status != models.JobStatus.READY:
        raise HTTPException(400, f"Job is '{job.status}', not ready to publish")
    channel = job.channel
    from pathlib import Path
    orchestrator._publish(db, job, channel, Path(job.video_path))
    db.refresh(job)
    return job
