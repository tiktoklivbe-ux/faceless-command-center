"""
Jarvis — voice assistant, now with real tool-use.

  POST /api/jarvis/chat -> takes recognized speech text (+ short history),
                           lets Claude call real tools against this app
                           (check job/channel status, kick off a new video),
                           returns a spoken-friendly reply.

Scope:
  - Can see and act on things INSIDE this app (jobs, channels, starting a
    video) because those are just existing internal functions -- safe,
    already-tested code paths, no new attack surface.
  - CAN also control the user's actual computer now, via the computer_action
    tool -- but only through the local Jarvis Agent (a separate script the
    user runs on their own machine, see app/routers/agent.py) polling a
    command queue, and only within a small fixed set of actions. This app
    itself still has zero direct connection to anyone's physical computer.

Reuses the same Anthropic key already configured in Settings.
"""
import json
import textwrap
import time

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

SYSTEM_PROMPT_BASE = textwrap.dedent("""
    You are Jarvis, a spoken voice assistant for Tom's Faceless Command
    Center. The person is talking out loud and your reply gets read aloud,
    so:
    - Keep replies short and conversational -- a few sentences, unless they
      clearly asked for a list or detailed explanation.
    - Plain spoken sentences only. No markdown, no bullets, no headers.
    - You have tools to check real channel/job status, check the weather,
      look at recent activity, adjust automation settings, start a new
      video, and control the user's actual computer (open an app, type
      text, click at a location, press a key combo, take a screenshot) via
      the local Jarvis Agent. Only use computer_action when the user
      clearly wants something done on their computer, not as a first resort
      -- and if the agent isn't connected, tell them plainly rather than
      pretending it worked.
    - If a tool result shows an error or nothing found, say so plainly
      rather than inventing details.
""").strip()

PERSONALITY_PRESETS = {
    "butler": "Personality: speak like a poised, formal butler -- polite, "
              "understated, occasional dry wit. Address the user as 'sir' "
              "when it feels natural, not every single line.",
    "casual": "Personality: speak like a laid-back, friendly buddy -- "
              "casual language, contractions, upbeat and warm.",
    "dry_wit": "Personality: speak with a dry, deadpan sense of humor -- "
               "understated jokes and light sarcasm, but still genuinely "
               "helpful underneath it.",
    "hype": "Personality: speak with high energy and enthusiasm, like a "
            "hype man cheering the user on -- still concise, just upbeat.",
    "unfiltered": "Personality: blunt and unfiltered. Talk like a real person, "
                  "not a corporate assistant -- casual profanity is fine and "
                  "natural (damn, hell, shit, that's fucked, etc). Be direct "
                  "and say what you actually think. Important: being blunt "
                  "means being HONEST, not agreeable -- if something's broken "
                  "or a bad idea, say so straight rather than hyping it up.",
}
DEFAULT_PERSONALITY = "butler"


def build_system_prompt(personality: str) -> str:
    tone = PERSONALITY_PRESETS.get(personality, PERSONALITY_PRESETS[DEFAULT_PERSONALITY])
    return f"{SYSTEM_PROMPT_BASE}\n\n{tone}"


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
    {
        "name": "check_weather",
        "description": "Get the current weather for a named city/location.",
        "input_schema": {
            "type": "object",
            "properties": {"location": {"type": "string", "description": "City or place name."}},
            "required": ["location"],
        },
    },
    {
        "name": "update_automation",
        "description": "Change a channel's Chronos automation settings -- how many videos per day, or turn automation on/off.",
        "input_schema": {
            "type": "object",
            "properties": {
                "channel_name": {"type": "string", "description": "Which channel. If omitted, uses the first/only channel."},
                "auto_per_day": {"type": "integer", "description": "New videos-per-day target, if changing it."},
                "auto_enabled": {"type": "boolean", "description": "Turn automation on (true) or off (false), if changing it."},
            },
        },
    },
    {
        "name": "get_activity_feed",
        "description": "Get a summary of recent agent activity across recent video jobs.",
        "input_schema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "description": "Max activity lines to return, default 10."}},
        },
    },
    {
        "name": "computer_action",
        "description": "Control the user's actual computer through the local Jarvis Agent: open an application, "
                       "type text at the current cursor focus, click at a screen coordinate, press a key combo, "
                       "or take a screenshot. Requires the local agent to be running and paired -- if it's not "
                       "connected, this will report that clearly instead of pretending to work.",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["open_app", "type_text", "click_at", "press_keys", "screenshot"]},
                "app_name": {"type": "string", "description": "For open_app: the application name."},
                "text": {"type": "string", "description": "For type_text: the text to type."},
                "x": {"type": "integer", "description": "For click_at: screen x coordinate."},
                "y": {"type": "integer", "description": "For click_at: screen y coordinate."},
                "keys": {"type": "string", "description": "For press_keys: a combo like 'cmd+space' or 'ctrl+c'."},
            },
            "required": ["action"],
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


def _tool_check_weather(location: str) -> dict:
    if not location:
        return {"error": "No location given."}
    try:
        geo = requests.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": location, "count": 1}, timeout=10,
        ).json()
        results = geo.get("results")
        if not results:
            return {"error": f"Couldn't find a location matching '{location}'."}
        place = results[0]
        wx = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={"latitude": place["latitude"], "longitude": place["longitude"], "current_weather": "true"},
            timeout=10,
        ).json()
        cw = wx.get("current_weather", {})
        return {
            "location": place.get("name", location),
            "region": place.get("admin1"),
            "temperature_c": cw.get("temperature"),
            "windspeed_kmh": cw.get("windspeed"),
        }
    except requests.RequestException:
        return {"error": "Couldn't reach the weather service right now."}


def _tool_update_automation(db: Session, channel_name: str | None, auto_per_day: int | None, auto_enabled: bool | None) -> dict:
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

    if auto_per_day is not None:
        channel.auto_per_day = max(1, auto_per_day)
    if auto_enabled is not None:
        channel.auto_enabled = auto_enabled
    db.commit()
    return {
        "updated": True, "channel": channel.name,
        "auto_enabled": channel.auto_enabled, "auto_per_day": channel.auto_per_day,
    }


def _tool_get_activity_feed(db: Session, limit: int | None) -> dict:
    jobs = db.query(models.VideoJob).order_by(models.VideoJob.created_at.desc()).limit(5).all()
    lines: list[str] = []
    for j in jobs:
        for line in (j.stage_log or "").splitlines()[-3:]:
            if line.strip():
                lines.append(line.strip())
    return {"recent_activity": lines[: (limit or 10)] or ["Nothing logged yet."]}


def _tool_computer_action(db: Session, tool_input: dict) -> dict:
    if not get_setting(db, "jarvis_agent_token"):
        return {"error": "No local Jarvis Agent has been paired yet -- set one up in the Jarvis panel's More tab first."}

    action = tool_input.get("action")
    if action not in {"open_app", "type_text", "click_at", "press_keys", "screenshot"}:
        return {"error": f"Unknown action '{action}'."}

    params = {k: v for k, v in tool_input.items() if k != "action"}
    cmd = models.AgentCommand(action=action, params_json=json.dumps(params))
    db.add(cmd)
    db.commit()
    db.refresh(cmd)

    # The local agent polls roughly every 1-2s (see jarvis_agent.py), so
    # wait up to ~8s here for it to pick this up and report back, rather
    # than immediately telling Claude "queued" with no idea if it worked.
    # If the agent isn't actually running, this will time out honestly.
    deadline = time.time() + 8
    while time.time() < deadline:
        db.refresh(cmd)
        if cmd.status == "done":
            result = json.loads(cmd.result_json) if cmd.result_json else {}
            return {"executed": True, "action": action, "result": result}
        if cmd.status == "failed":
            return {"executed": False, "action": action, "error": cmd.error_message or "The local agent reported failure."}
        time.sleep(0.4)

    return {
        "executed": False, "action": action,
        "error": "No response from the local Jarvis Agent -- it may not be running right now.",
    }


def _run_tool(db: Session, background_tasks: BackgroundTasks, name: str, tool_input: dict) -> dict:
    if name == "list_channels":
        return _tool_list_channels(db)
    if name == "list_recent_jobs":
        return _tool_list_recent_jobs(db, tool_input.get("channel_name"), tool_input.get("limit"))
    if name == "start_video":
        return _tool_start_video(db, background_tasks, tool_input.get("channel_name"), tool_input.get("topic"))
    if name == "check_weather":
        return _tool_check_weather(tool_input.get("location", ""))
    if name == "update_automation":
        return _tool_update_automation(
            db, tool_input.get("channel_name"), tool_input.get("auto_per_day"), tool_input.get("auto_enabled"),
        )
    if name == "get_activity_feed":
        return _tool_get_activity_feed(db, tool_input.get("limit"))
    if name == "computer_action":
        return _tool_computer_action(db, tool_input)
    return {"error": f"Unknown tool '{name}'"}


class ChatTurn(BaseModel):
    role: str
    content: str


class ChatIn(BaseModel):
    message: str
    history: list[ChatTurn] = []


class ChatOut(BaseModel):
    reply: str


def _call_claude(api_key: str, model: str, system_prompt: str, messages: list[dict]) -> dict:
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": 300,
            "system": system_prompt,
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
    # Jarvis defaults to Haiku, not Sonnet -- a voice assistant needs to feel
    # snappy above all else, and the tool-use loop can mean several
    # sequential API round-trips in one turn, so a slower model compounds
    # fast. This is a separate setting from anthropic_model (which Athena's
    # script generation uses), so you can keep script quality on Sonnet/Opus
    # while keeping Jarvis fast, or override either independently in Settings.
    model = get_setting(db, "jarvis_model", "claude-haiku-4-5-20251001")
    personality = get_setting(db, "jarvis_personality", DEFAULT_PERSONALITY)
    system_prompt = build_system_prompt(personality)

    for _ in range(4):
        try:
            data = _call_claude(api_key, model, system_prompt, messages)
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


# ---------------------------------------------------------------- real voice output (ElevenLabs)
# The browser's built-in speech synthesis (used as a fallback) sounds
# robotic -- this app already has ElevenLabs wired in for video narration,
# so Jarvis reuses the same key to sound like an actual voice instead.
# Falls back to browser speech synthesis automatically on the frontend if no
# ElevenLabs key is configured, or if this endpoint errors.
DEFAULT_VOICE_ID = "pNInz6obpgDQGcFmaJgB"  # ElevenLabs premade "Adam" voice -- same family already used for video narration elsewhere in this app


class SpeakIn(BaseModel):
    text: str


@router.post("/speak")
def speak(body: SpeakIn, db: Session = Depends(get_db)):
    api_key = get_setting(db, "elevenlabs_api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="No ElevenLabs key configured.")
    voice_id = get_setting(db, "jarvis_voice_id") or DEFAULT_VOICE_ID
    try:
        resp = requests.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
            headers={"xi-api-key": api_key, "content-type": "application/json", "accept": "audio/mpeg"},
            json={
                "text": body.text,
                "model_id": "eleven_turbo_v2_5",  # low-latency model -- matters for a live voice assistant
                "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
            },
            timeout=30,
        )
        resp.raise_for_status()
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        raise HTTPException(status_code=502, detail=f"ElevenLabs error ({status}).")
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Couldn't reach ElevenLabs.")
    return Response(content=resp.content, media_type="audio/mpeg")


@router.get("/voices")
def list_voices(db: Session = Depends(get_db)):
    """For the Settings voice picker. Returns an empty list (not an error)
    if no key is configured yet, so the frontend can just show 'add a key
    to pick a voice' instead of a broken dropdown."""
    api_key = get_setting(db, "elevenlabs_api_key")
    if not api_key:
        return {"voices": []}
    try:
        resp = requests.get(
            "https://api.elevenlabs.io/v1/voices",
            headers={"xi-api-key": api_key}, timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        return {"voices": [{"voice_id": v["voice_id"], "name": v["name"]} for v in data.get("voices", [])]}
    except requests.RequestException:
        return {"voices": []}


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
