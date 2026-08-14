"""
Global render concurrency control.

Video rendering is by far the heaviest thing this app does. Running two at
once exhausts memory and CPU, and an OOM kill leaves no exception to catch --
the job just stops dead with no error logged.

IMPORTANT: renders now run in SEPARATE PROCESSES (see orchestrator.dispatch_job),
so an in-memory lock is useless -- each process would get its own copy and
every render would think the slot was free. The lock therefore lives on disk
as a file, which every process can see.
"""
import logging
import os
import time
from pathlib import Path

from .config import DATA_DIR

log = logging.getLogger("render_gate")

MAX_CONCURRENT_RENDERS = 1
_LOCK_FILE = DATA_DIR / "render.lock"
# A lock older than this is assumed stale -- the process holding it died
# without cleaning up. Without this a single crash would block renders forever.
_STALE_AFTER_SECONDS = 1800


def _read_lock() -> tuple[str, int, float] | None:
    try:
        raw = _LOCK_FILE.read_text(encoding="utf-8").strip()
        job_id, pid_s, ts_s = raw.split("|")
        return job_id, int(pid_s), float(ts_s)
    except (OSError, ValueError):
        return None


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False if isinstance(pid, int) else True
    except Exception:
        return True


def _clear_if_stale() -> None:
    info = _read_lock()
    if not info:
        # A lock FILE that exists but won't parse (empty or garbage -- e.g. a
        # worker killed by O_EXCL-create-then-die, leaving a 0-byte file) is the
        # worst case: _read_lock returns None so is_busy()/active_jobs() report
        # the gate as FREE, yet try_acquire's O_EXCL create still fails on the
        # existing file -- so every render is blocked forever while the gate
        # looks empty (exactly the "queued with lock_holder []" stall). Delete
        # it so the slot actually frees.
        if _LOCK_FILE.exists():
            log.warning("Removing an unparseable/empty render lock file.")
            force_clear()
        return
    job_id, pid, ts = info
    age = time.time() - ts
    # A blank holder is always an orphan (a crash left a "|pid|ts" lock with no
    # job id) -- it can never be released by name, so it would otherwise block
    # every render forever. Treat it as stale unconditionally.
    if not job_id or age > _STALE_AFTER_SECONDS or not _pid_alive(pid):
        log.warning("Clearing stale render lock for job %r (pid %s, age %.0fs)", job_id, pid, age)
        force_clear()


def force_clear() -> None:
    """Remove the lock unconditionally -- recovery path for an orphaned lock the
    staleness heuristics don't catch."""
    try:
        _LOCK_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def reconcile(active_job_ids) -> None:
    """Drop the lock unless a genuinely-active job still holds it. Called on
    boot: a lock whose holder is blank, or names a job that no longer exists or
    has finished, is an orphan from a crash and must not wedge the render slot
    shut for every future job."""
    info = _read_lock()
    if not info:
        return
    job_id = info[0]
    if not job_id or job_id not in set(active_job_ids):
        log.warning("Clearing orphaned render lock (holder=%r is not an active job).", job_id)
        force_clear()


def active_jobs() -> list[str]:
    _clear_if_stale()
    info = _read_lock()
    return [info[0]] if info else []


def is_busy() -> bool:
    _clear_if_stale()
    return _read_lock() is not None


def try_acquire(job_id: str, timeout: float = 0.0) -> bool:
    """Claim the render slot via an atomic file create. Returns False if
    another render already holds it."""
    # Never write a lock for a blank/falsy id. Such a lock names no one, so
    # release() (which only frees a matching holder) can never clear it, and it
    # wedges the render slot shut for every future job. Refusing it here kills
    # that failure at the source; a real job always has an id.
    if not job_id:
        log.error("try_acquire called with an empty job_id; refusing to write a nameless lock.")
        return False
    _clear_if_stale()
    _LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + max(timeout, 0)
    while True:
        try:
            # O_EXCL makes this atomic -- only one process can win, even if
            # several try at the same instant.
            fd = os.open(_LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(f"{job_id}|{os.getpid()}|{time.time()}")
            return True
        except FileExistsError:
            existing = _read_lock()
            if existing and existing[0] == job_id:
                return True  # this job already holds it
            if time.time() >= deadline:
                return False
            time.sleep(0.5)
            _clear_if_stale()


def release(job_id: str) -> None:
    info = _read_lock()
    if not info:
        return
    # Only the holder may release, so a late call from an old job can't free
    # the slot out from under a running one.
    if info[0] != job_id:
        return
    try:
        _LOCK_FILE.unlink(missing_ok=True)
    except OSError:
        pass
