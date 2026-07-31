"""
Global render concurrency control.

Video rendering is by far the heaviest thing this app does: ffmpeg holding
decoded frames in memory, concurrent voice/image API calls, and large
intermediate files on disk. Running two of them at once on a small instance
is what pushes it over its memory limit -- and when the container gets
OOM-killed there's no exception to catch, so the job just stops dead with no
error logged. That's the "stalled with no logged error" signature.

Four different code paths could each start a render (the API, the NL command
bar, Chronos, and the stalled-job watchdog) and none of them knew about the
others, so nothing stopped three or four piling up simultaneously. The
watchdog made it actively worse: it retried stalled jobs, adding *more*
concurrent renders to an already-overloaded box, which killed them again --
a feedback loop.

This module is the single gate all of them now go through.
"""
import logging
import threading

log = logging.getLogger("render_gate")

# One render at a time, deliberately. Throughput isn't the constraint here --
# a video takes a couple of minutes and the target is a few per day. Reliability
# is the constraint, and serialising renders is what makes memory use
# predictable.
MAX_CONCURRENT_RENDERS = 1

_semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_RENDERS)
_active_lock = threading.Lock()
_active_job_ids: set[str] = set()


def active_jobs() -> list[str]:
    with _active_lock:
        return sorted(_active_job_ids)


def is_busy() -> bool:
    with _active_lock:
        return len(_active_job_ids) >= MAX_CONCURRENT_RENDERS


def try_acquire(job_id: str, timeout: float = 0.0) -> bool:
    """Claim the render slot. Returns False immediately (by default) if
    another render holds it, so callers can queue the job rather than piling
    on. Also guards against the same job being started twice."""
    with _active_lock:
        if job_id in _active_job_ids:
            log.warning("Job %s is already rendering -- refusing to start it twice.", job_id)
            return False

    acquired = _semaphore.acquire(blocking=timeout > 0, timeout=timeout if timeout > 0 else None)
    if not acquired:
        return False

    with _active_lock:
        _active_job_ids.add(job_id)
    return True


def release(job_id: str) -> None:
    with _active_lock:
        if job_id not in _active_job_ids:
            return  # never held it; releasing would corrupt the semaphore count
        _active_job_ids.discard(job_id)
    try:
        _semaphore.release()
    except ValueError:
        log.warning("Semaphore released more times than acquired for job %s.", job_id)
