"""
Jarvis — voice assistant, now with real tool-use.

  POST /api/jarvis/chat -> takes recognized speech text (+ short history),
                           lets Claude call real tools against this app
                           (check job/channel status, kick off a new video),
                           returns a spoken-friendly reply.

Scope, on purpose:
  - Can see and act on things INSIDE this app (jobs, channels, starting a
    video) because those are just existing internal functions -- safe,
    already-tested code paths, no new attack surface.
  - Cannot touch your actual computer (files, other apps, your OS) yet --
    that's a real separate project (Phase 2: a local companion app with its
    own OS-level permissions) and isn't quietly smuggled in here.

Reuses the same Anthropic key already configured in Settings.
"""
import json
import textwrap

import requests
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..settings_store import get_setting
from ..pipeline import orchestrator

router = APIRouter(prefix="/api/jarvis", tags=["jarvis"])

SYSTEM_PROMPT = textwrap.dedent("""
    You are Jarvis, a spoken voice assistant for Tom's Faceless Command
    Center. The person is talking out loud and your reply gets read aloud by
    their browser, so:
    - Keep replies short and conversational -- a few sentences, unless they
      clearly asked for a list or detailed explanation.
    - Plain spoken sentences only. No markdown, no bullets, no headers.
    - You have tools to check real channel/job status and to start a new
      video. Use them whenever the question is about the actual state of the
      system ("did my video finish", "what's my channel called", "make a
      video about X") instead of guessing.
    - You do not control anything on Tom's physical computer (files, other
      apps, OS-level actions) yet -- if asked, say that's a separate feature
      being built, not that you can't help at all.
    - If a tool result shows an error or nothing found, say so plainly
      rather than inventing details.
""").strip()

TOOLS = [
    {
        "name": "list_channels",
        "description": "List all configured channels with their names and automation settings.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_recent_jobs",
        "description": "List recent video jobs (any channel, or a specific one) with their status.",
        "input_schema": {
            "type": "object",
            "properties": {
                "channel_name": {"type": "string", "description": "Optional channel name to filter by."},
                "limit": {"type": "integer", "description": "Max jobs to return, default 5."},
            },
        },
    },
    {
        "name": "start_video",
        "description": "Kick off a new video job for a channel, optionally with a specific topic.",
        "input_schema": {
            "type": "object",
            "properties": {
                "channel_name": {"type": "string", "description": "Which channel. If omitted, uses the first/only channel."},
                "topic": {"type": "string", "description": "Optional topic; if omitted the agent picks one."},
            },
        },
    },
]


def _tool_list_channels(db: Session) -> dict:
    channels = db.query(models.Channel).all()
    return {
        "channels": [
            {"name": c.name, "auto_enabled": c.auto_enabled, "auto_per_day": c.auto_per_day}
            for c in channels
        ]
    }


def _tool_list_recent_jobs(db: Session, channel_name: str | None, limit: int | None) -> dict:
    q = db.query(models.VideoJob)
    if channel_name:
        channel = db.query(models.Channel).filter(
            models.Channel.name.ilike(f"%{channel_name}%")
        ).first()
        if not channel:
            return {"error": f"No channel matching '{channel_name}'."}
        q = q.filter(models.VideoJob.channel_id == channel.id)
    jobs = q.order_by(models.VideoJob.created_at.desc()).limit(limit or 5).all()
    return {
        "jobs": [
            {
                "title": j.title or "(untitled)",
                "status": j.status.value if hasattr(j.status, "value") else str(j.status),
                "error": j.error_message or None,
                "created_at": j.created_at.isoformat() if j.created_at else None,
            }
            for j in jobs
        ]
    }


def _tool_start_video(db: Session, background_tasks: BackgroundTasks, channel_name: str | None, topic: str | None) -> dict:
    channel = None
    if channel_name:
        channel = db.query(models.Channel).filter(
            models.Channel.name.ilike(f"%{channel_name}%")
        ).first()
        if not channel:
            return {"error": f"No channel matching '{channel_name}'."}
    else:
        channel = db.query(models.Channel).order_by(models.Channel.created_at.asc()).first()
    if not channel:
        return {"error": "No channels configured yet."}

    job = models.VideoJob(channel_id=channel.id, topic=topic or "", auto_publish=False)
    db.add(job)
    db.commit()
    db.refresh(job)
    # Dispatched as a background task, same as /api/command does -- run_job
    # is a long-running synchronous pipeline (script, voice, visuals,
    # assembly), so calling it inline here would hang this HTTP request and
    # the worker thread for however long the whole video takes.
    background_tasks.add_task(orchestrator.run_job, job.id)
    return {"started": True, "channel": channel.name, "job_id": job.id, "topic": topic or "(agent's choice)"}


def _run_tool(db: Session, background_tasks: BackgroundTasks, name: str, tool_input: dict) -> dict:
    if name == "list_channels":
        return _tool_list_channels(db)
    if name == "list_recent_jobs":
        return _tool_list_recent_jobs(db, tool_input.get("channel_name"), tool_input.get("limit"))
    if name == "start_video":
        return _tool_start_video(db, background_tasks, tool_input.get("channel_name"), tool_input.get("topic"))
    return {"error": f"Unknown tool '{name}'"}


class ChatTurn(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    message: str
    history: list[ChatTurn] = []


class ChatOut(BaseModel):
    reply: str


def _call_claude(api_key: str, model: str, messages: list[dict]) -> dict:
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": 500,
            "system": SYSTEM_PROMPT,
            "messages": messages,
            "tools": TOOLS,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def run_jarvis_turn(db: Session, background_tasks: BackgroundTasks, messages: list[dict]) -> str:
    """Runs the tool-use loop against Claude for one turn and returns the
    final plain-text reply. Shared by the in-app chat endpoint and the SMS
    webhook so both go through identical logic and tools."""
    api_key = get_setting(db, "anthropic_api_key")
    if not api_key:
        return "No Anthropic API key is configured yet -- add one in Settings."
    model = get_setting(db, "anthropic_model", "claude-sonnet-5")

    for _ in range(4):
        try:
            data = _call_claude(api_key, model, messages)
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else "?"
            if status == 401:
                return "That Anthropic API key looks invalid -- check it in Settings."
            if status == 429:
                return "Anthropic's rate limit was hit -- try again in a moment."
            return f"Anthropic API error ({status})."
        except requests.RequestException:
            return "Couldn't reach Anthropic's API -- check the connection and try again."

        content = data.get("content", [])
        stop_reason = data.get("stop_reason")

        if stop_reason != "tool_use":
            reply = "".join(b.get("text", "") for b in content if b.get("type") == "text")
            return reply.strip() or "…"

        messages.append({"role": "assistant", "content": content})
        tool_results = []
        for block in content:
            if block.get("type") != "tool_use":
                continue
            result = _run_tool(db, background_tasks, block["name"], block.get("input", {}))
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block["id"],
                "content": json.dumps(result),
            })
        messages.append({"role": "user", "content": tool_results})

    return "Sorry, I got stuck trying to look that up. Try asking again."


@router.post("/chat", response_model=ChatOut)
def chat(body: ChatIn, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    if not get_setting(db, "anthropic_api_key"):
        raise HTTPException(
            status_code=400,
            detail="No Anthropic API key configured yet -- add one in Settings.",
        )
    messages = [{"role": t.role, "content": t.content} for t in body.history]
    messages.append({"role": "user", "content": body.message})
    reply = run_jarvis_turn(db, background_tasks, messages)
    return ChatOut(reply=reply)


# ---------------------------------------------------------------- texting Jarvis (SMS)
# Works with any provider that speaks Twilio's "incoming message webhook"
# convention (form-encoded POST with From/Body, expects TwiML XML back) --
# Twilio itself is the easiest way to get a real phone number for this.
#
# SETUP (once you have a Twilio account + phone number):
#   1. In the Twilio console, open your phone number's configuration.
#   2. Under "A message comes in", set the webhook to:
#        https://<your-render-app>.onrender.com/api/jarvis/sms
#      Method: HTTP POST.
#   3. Text that number. Twilio POSTs it here, this runs the same Jarvis
#      logic (including tools), and replies via TwiML -- Twilio sends the
#      reply back as a text automatically.
#
# SECURITY NOTE: this endpoint doesn't verify Twilio's request signature, so
# anyone who discovers the URL could POST to it and trigger a real tool call
# (e.g. start a video). Keep the URL private for now. If this matters more
# once it's really in use, Twilio signature validation (using your Twilio
# Auth Token) is the standard fix -- ask and I can add it.
_MAX_SMS_HISTORY = 10


def _load_sms_history(db: Session, phone: str) -> list[dict]:
    thread = db.get(models.SmsThread, phone)
    if not thread:
        return []
    try:
        return json.loads(thread.history_json or "[]")
    except (json.JSONDecodeError, TypeError):
        return []


def _save_sms_history(db: Session, phone: str, history: list[dict]) -> None:
    history = history[-_MAX_SMS_HISTORY:]
    thread = db.get(models.SmsThread, phone)
    if not thread:
        thread = models.SmsThread(phone=phone)
        db.add(thread)
    thread.history_json = json.dumps(history)
    db.commit()


def _twiml(message: str) -> Response:
    # Minimal manual XML escaping -- avoids pulling in an XML library for
    # four characters.
    escaped = (
        message.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )
    xml = f'<?xml version="1.0" encoding="UTF-8"?><Response><Message>{escaped}</Message></Response>'
    return Response(content=xml, media_type="application/xml")


@router.post("/sms")
async def sms_webhook(request: Request, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    form = await request.form()
    from_number = form.get("From", "unknown")
    body = (form.get("Body") or "").strip()
    if not body:
        return _twiml("Didn't catch a message there -- try texting again.")

    if not get_setting(db, "anthropic_api_key"):
        return _twiml("Jarvis isn't set up yet -- add an Anthropic API key in Settings first.")

    history = _load_sms_history(db, from_number)
    messages = list(history)
    messages.append({"role": "user", "content": body})

    reply = run_jarvis_turn(db, background_tasks, messages)

    history.append({"role": "user", "content": body})
    history.append({"role": "assistant", "content": reply})
    _save_sms_history(db, from_number, history)

    return _twiml(reply)


# ---------------------------------------------------------------- voice ID (approximate, not real biometrics)
# A rough "is this probably Tom or a guest" gate based on pitch statistics
# only -- NOT a real speaker-verification model. Genuinely useful caveats:
#   - Two people with similar vocal pitch can be confused for each other.
#   - A congested nose, tiredness, or a noisy room can shift your own
#     reading enough to miss a match.
#   - This should never be used for anything that actually needs security.
# "Learning": every time the live sample is accepted as a match, it's fed
# back into update_voiceprint below, which blends it into the stored average
# with a fixed small weight -- so the profile drifts slowly toward your
# current voice over time instead of ever being overwritten wholesale or
# staying frozen at the first enrollment.
class VoicePrintIn(BaseModel):
    avg_pitch: float
    min_pitch: float
    max_pitch: float


class VoicePrintOut(BaseModel):
    enrolled: bool
    avg_pitch: float | None = None
    min_pitch: float | None = None
    max_pitch: float | None = None
    sample_count: int = 0


@router.get("/voiceprint", response_model=VoicePrintOut)
def get_voiceprint(db: Session = Depends(get_db)):
    vp = db.get(models.VoicePrint, "owner")
    if not vp or not vp.sample_count:
        return VoicePrintOut(enrolled=False)
    return VoicePrintOut(
        enrolled=True, avg_pitch=vp.avg_pitch, min_pitch=vp.min_pitch,
        max_pitch=vp.max_pitch, sample_count=vp.sample_count,
    )


@router.post("/voiceprint", response_model=VoicePrintOut)
def update_voiceprint(body: VoicePrintIn, db: Session = Depends(get_db)):
    vp = db.get(models.VoicePrint, "owner")
    if not vp or not vp.sample_count:
        vp = db.get(models.VoicePrint, "owner") or models.VoicePrint(id="owner")
        vp.avg_pitch = body.avg_pitch
        vp.min_pitch = body.min_pitch
        vp.max_pitch = body.max_pitch
        vp.sample_count = 1
        db.add(vp)
    else:
        # slow exponential moving average -- new samples nudge the profile
        # rather than replacing it, so one bad/noisy sample can't wreck it
        weight_new = 0.25
        vp.avg_pitch = vp.avg_pitch * (1 - weight_new) + body.avg_pitch * weight_new
        vp.min_pitch = min(vp.min_pitch, body.min_pitch)
        vp.max_pitch = max(vp.max_pitch, body.max_pitch)
        vp.sample_count += 1
    db.commit()
    db.refresh(vp)
    return VoicePrintOut(
        enrolled=True, avg_pitch=vp.avg_pitch, min_pitch=vp.min_pitch,
        max_pitch=vp.max_pitch, sample_count=vp.sample_count,
    )
