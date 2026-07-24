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
