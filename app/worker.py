"""
Worker entry point: renders one video in its own process.

Run as:  python -m app.worker <job_id>

This exists so a render can be dispatched to a genuinely separate OS process
without the pitfalls of multiprocessing. multiprocessing's "spawn" makes the
child re-import the parent's __main__ -- which under uvicorn means either
crashing on import or re-running the entire application, so the child dies
instantly and silently and the job sits in QUEUED forever with an empty log.
"fork" avoids that but inherits open SQLite handles and threads, which
deadlocks. A module entry point sidesteps both: a clean interpreter, no
inherited state.

Failures are written to the job record before exiting, so a worker that dies
still leaves a diagnosable trail rather than a job frozen mid-render.
"""
import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [worker] %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("worker")


def main() -> int:
    if len(sys.argv) < 2:
        log.error("Usage: python -m app.worker <job_id>")
        return 2

    job_id = sys.argv[1]
    log.info("Worker starting for job %s", job_id)

    try:
        from .pipeline.orchestrator import run_job
        run_job(job_id)
        log.info("Worker finished job %s", job_id)
        return 0
    except Exception:
        log.exception("Worker crashed on job %s", job_id)
        # Record the crash on the job itself. Without this a worker that dies
        # early leaves the job stuck in its previous state with no explanation
        # -- exactly the silent freeze this whole design is meant to prevent.
        try:
            import traceback

            from . import models
            from .database import SessionLocal

            db = SessionLocal()
            try:
                job = db.get(models.VideoJob, job_id)
                if job and job.status not in (
                    models.JobStatus.PUBLISHED,
                    models.JobStatus.READY,
                    models.JobStatus.FAILED,
                ):
                    job.status = models.JobStatus.FAILED
                    job.error_message = "Render worker crashed before finishing."
                    tail = "\n".join(traceback.format_exc().strip().splitlines()[-6:])
                    job.stage_log = (job.stage_log or "") + f"\n[worker crashed]\n{tail}\n"
                    db.commit()
            finally:
                db.close()
        except Exception:
            log.exception("Also failed to record the crash for job %s", job_id)
        return 1


if __name__ == "__main__":
    sys.exit(main())
