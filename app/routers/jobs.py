from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import models, schemas, crypto
from ..database import get_db
from ..pipeline import orchestrator, publish_youtube, publish_tiktok

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("", response_model=list[schemas.JobOut])
def list_jobs(channel_id: str | None = None, db: Session = Depends(get_db)):
    q = db.query(models.VideoJob)
    if channel_id:
        q = q.filter(models.VideoJob.channel_id == channel_id)
    return q.order_by(models.VideoJob.created_at.desc()).all()


@router.post("", response_model=schemas.JobOut)
def create_job(payload: schemas.JobCreate, background_tasks: BackgroundTasks,
                db: Session = Depends(get_db)):
    channel = db.get(models.Channel, payload.channel_id)
    if not channel:
        raise HTTPException(404, "Channel not found")
    job = models.VideoJob(
        channel_id=channel.id,
        topic=payload.topic,
        auto_publish=payload.auto_publish,
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    background_tasks.add_task(orchestrator.run_job, job.id)
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
