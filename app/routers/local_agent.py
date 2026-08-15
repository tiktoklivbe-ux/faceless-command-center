"""
Bridge between Jarvis (running on this cloud server) and a small companion
process on the user's OWN computer. The server has no way to reach a machine
sitting behind a home router -- so instead the companion reaches OUT to the
server, polling for work over plain HTTPS. No inbound port is ever opened on
the user's machine.

Every endpoint here requires the shared secret in `local_agent_secret`
(Settings), generated once and given only to the companion's local config.
Without it, this would be an unauthenticated remote-command-execution
endpoint on the public internet -- about as bad as an API can get.
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..settings_store import get_setting, set_setting

router = APIRouter(prefix="/api/local-agent", tags=["local-agent"])

# If the companion hasn't polled in this long, treat it as disconnected --
# Jarvis tells the user to go start it rather than silently queuing a task
# that will never run.
STALE_AFTER_SECONDS = 20


def _check_secret(db: Session, authorization: str | None):
    secret = get_setting(db, "local_agent_secret")
    if not secret:
        raise HTTPException(503, "No local agent secret is configured yet.")
    given = (authorization or "").removeprefix("Bearer ").strip()
    if not given or given != secret:
        raise HTTPException(401, "Bad or missing agent secret.")


@router.get("/poll")
def poll(authorization: str | None = Header(None), db: Session = Depends(get_db)):
    """Called in a loop by the companion. Claims and returns the oldest
    queued task, or {"task": null} if there's nothing to do. Also stamps a
    liveness marker so the server can tell whether a companion is currently
    connected at all."""
    _check_secret(db, authorization)
    set_setting(db, "local_agent_last_seen", datetime.utcnow().isoformat(), is_secret=False)

    task = (
        db.query(models.ComputerTask)
        .filter(models.ComputerTask.status == "queued")
        .order_by(models.ComputerTask.created_at.asc())
        .first()
    )
    if not task:
        return {"task": None}
    task.status = "running"
    db.commit()
    return {"task": {"id": task.id, "command": task.command}}


class ResultIn(BaseModel):
    task_id: str
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0


@router.post("/result")
def result(payload: ResultIn, authorization: str | None = Header(None), db: Session = Depends(get_db)):
    _check_secret(db, authorization)
    task = db.get(models.ComputerTask, payload.task_id)
    if not task:
        raise HTTPException(404, "Unknown task id.")
    task.stdout = (payload.stdout or "")[-8000:]
    task.stderr = (payload.stderr or "")[-8000:]
    task.exit_code = payload.exit_code
    task.status = "done" if payload.exit_code == 0 else "error"
    db.commit()
    return {"ok": True}


def agent_connected(db: Session) -> bool:
    """Whether a companion has polled recently enough to be considered live."""
    last_seen = get_setting(db, "local_agent_last_seen", "")
    if not last_seen:
        return False
    try:
        ts = datetime.fromisoformat(last_seen)
    except ValueError:
        return False
    return (datetime.utcnow() - ts) < timedelta(seconds=STALE_AFTER_SECONDS)
