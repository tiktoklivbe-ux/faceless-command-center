"""
Local Jarvis Agent communication endpoints.

This app has no direct connection to anyone's physical computer -- "computer
control" works as a simple command queue instead: Jarvis (the chat tool-use
in app/routers/jarvis.py) writes a row to AgentCommand, the user's own
locally-running jarvis_agent.py script polls this endpoint for pending
commands, executes them on their machine, and reports the result back here.

SECURITY: every endpoint here requires the pairing token generated via
/generate-token. Without that, anyone who found this app's URL could queue
commands that execute on the user's computer -- the token is what limits
"who can make my computer do things" to just the person who ran the local
agent with that token. Treat it like a password.
"""
import json
import secrets

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..settings_store import get_setting, set_setting

router = APIRouter(prefix="/api/jarvis/agent", tags=["jarvis-agent"])

# The only actions the local agent will ever execute. Deliberately not
# "run arbitrary code" -- a fixed, small, auditable vocabulary is the real
# safety boundary for a feature that controls someone's actual computer.
ALLOWED_ACTIONS = {"open_app", "focus_window", "type_text", "click_at", "press_keys", "screenshot"}


def _check_token(db: Session, token: str):
    real = get_setting(db, "jarvis_agent_token")
    if not real or not token or not secrets.compare_digest(token, real):
        raise HTTPException(status_code=401, detail="Invalid or missing agent pairing token.")


@router.post("/generate-token")
def generate_token(db: Session = Depends(get_db)):
    """Creates (or replaces) the pairing token. Returns it in plaintext --
    this is the ONE time it's ever shown; after this it's stored encrypted
    like any other secret setting and only returned masked via /api/settings.
    Regenerating invalidates any agent already running with the old token."""
    token = secrets.token_urlsafe(32)
    set_setting(db, "jarvis_agent_token", token)
    return {"token": token}


@router.get("/status")
def agent_status(db: Session = Depends(get_db)):
    """Whether a token has ever been generated (not whether an agent is
    currently running/connected -- this app has no way to know that without
    the agent actively polling, which /poll-log below approximates)."""
    return {"paired": bool(get_setting(db, "jarvis_agent_token"))}


@router.get("/poll")
def poll(token: str = Query(...), db: Session = Depends(get_db)):
    """Called repeatedly by the local agent script. Returns the oldest
    pending command, if any, and marks it 'sent' so it isn't handed out
    twice. Returns {"command": null} when there's nothing to do -- that's
    the normal, common case, not an error."""
    _check_token(db, token)
    cmd = (
        db.query(models.AgentCommand)
        .filter(models.AgentCommand.status == "pending")
        .order_by(models.AgentCommand.created_at.asc())
        .first()
    )
    if not cmd:
        return {"command": None}
    cmd.status = "sent"
    db.commit()
    return {
        "command": {
            "id": cmd.id,
            "action": cmd.action,
            "params": json.loads(cmd.params_json or "{}"),
        }
    }


class ReportIn(BaseModel):
    command_id: str
    status: str  # "done" | "failed"
    result: dict | None = None
    error: str | None = None


@router.post("/report")
def report(body: ReportIn, token: str = Query(...), db: Session = Depends(get_db)):
    _check_token(db, token)
    cmd = db.get(models.AgentCommand, body.command_id)
    if not cmd:
        raise HTTPException(status_code=404, detail="Unknown command id.")
    cmd.status = "done" if body.status == "done" else "failed"
    cmd.result_json = json.dumps(body.result) if body.result is not None else None
    cmd.error_message = body.error
    db.commit()
    return {"ok": True}
