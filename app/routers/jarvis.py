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
from datetime import datetime

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
    - You have full control of this workspace: check channel/job status,
      create and edit channels, retry/delete/publish jobs, see what every
      agent is doing, check the weather, adjust automation, give real
      channel growth advice, audit the whole setup for problems, and
      control the user's actual computer (open an app, type, click, press
      keys, screenshot) via the local Jarvis Agent. Use tools rather than
      guessing whenever a question is about real state.
    - Never read out API key values, even if asked -- workspace_status tells
      you only whether a key is set, and that's all you should ever say.
    - Only use computer_action when the user clearly wants something done on
      their machine, and if the local agent isn't connected, say so plainly
      instead of pretending it worked. When you do act on their computer,
      say what you're doing in the same breath ("opening Notepad now") so
      they can follow along rather than wondering what just happened.
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
    "unfiltered": "Personality: completely unfiltered and blunt. Talk like a real "
                  "person who doesn't care about sounding professional -- swear "
                  "naturally and often (shit, fuck, damn, hell, bullshit), use slang, "
                  "be sarcastic, roast the user when they deserve it. No corporate "
                  "assistant energy whatsoever, no hedging, no 'I'd be happy to help'. "
                  "Be genuinely funny and irreverent. Crucially: unfiltered means "
                  "HONEST, not a yes-man. If something's broken, a bad idea, or won't "
                  "work, say so bluntly -- that's the whole point of this mode. Being "
                  "real with him is worth more than agreeing with him.",
    "unhinged": "Personality: chaotic, loud, maximum energy, zero filter. Swear freely, "
                "be dramatic and absurd, roast him relentlessly, treat everything like "
                "it's the most intense thing that's ever happened. Still actually answer "
                "the question and still tell him the truth -- you're unhinged in delivery, "
                "not in accuracy.",
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
        "description": "Control the user's actual computer through the local Jarvis Agent: open an application (brought to the front so it's visible), focus an already-open window, "
                       "type text at the current cursor focus, click at a screen coordinate, press a key combo, "
                       "or take a screenshot. Requires the local agent to be running and paired -- if it's not "
                       "connected, this will report that clearly instead of pretending to work.",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["open_app", "focus_window", "type_text", "click_at", "press_keys", "screenshot"]},
                "app_name": {"type": "string", "description": "For open_app: the application name."},
                "text": {"type": "string", "description": "For type_text: the text to type."},
                "x": {"type": "integer", "description": "For click_at: screen x coordinate."},
                "y": {"type": "integer", "description": "For click_at: screen y coordinate."},
                "keys": {"type": "string", "description": "For press_keys: a combo like 'cmd+space' or 'ctrl+c'."},
            },
            "required": ["action"],
        },
    },
    {
        "name": "channel_advice",
        "description": "Analyze the user's real channel stats and give concrete growth advice, plus math on "
                       "how long a subscriber or view goal would take at the current rate. Use this whenever "
                       "they ask what to do to grow, how they're doing, or when they'll hit a target.",
        "input_schema": {
            "type": "object",
            "properties": {
                "goal_subscribers": {"type": "integer", "description": "Optional target subscriber count to estimate a timeline for."},
                "goal_views": {"type": "integer", "description": "Optional target view count to estimate a timeline for."},
            },
        },
    },
    {
        "name": "agent_status",
        "description": "Report what every agent in the constellation is doing right now -- which are actively "
                       "working on a job, which are idle, and which are scaffolding not yet wired to real "
                       "logic. Use when asked about 'the agents' or what's running.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "manage_channel",
        "description": "Create a new channel, or update an existing channel's niche or style notes.",
        "input_schema": {
            "type": "object",
            "properties": {
                "operation": {"type": "string", "enum": ["create", "update"]},
                "channel_name": {"type": "string", "description": "Name to create, or to find when updating."},
                "niche": {"type": "string"},
                "style_notes": {"type": "string"},
            },
            "required": ["operation", "channel_name"],
        },
    },
    {
        "name": "manage_job",
        "description": "Act on an existing video job: retry a failed one, delete one, or publish one that's ready.",
        "input_schema": {
            "type": "object",
            "properties": {
                "operation": {"type": "string", "enum": ["retry", "delete", "publish"]},
                "job_title": {"type": "string", "description": "Title or topic of the job; matched loosely."},
            },
            "required": ["operation"],
        },
    },
    {
        "name": "workspace_status",
        "description": "Full workspace overview: which API keys are configured (never the values), automation "
                       "settings per channel, job counts, and what's missing or misconfigured. Use for "
                       "'is everything set up', 'what's broken', 'what am I missing'.",
        "input_schema": {"type": "object", "properties": {}},
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


def _tool_channel_advice(db: Session, goal_subs: int | None, goal_views: int | None) -> dict:
    from .. import crypto
    from ..pipeline import publish_youtube

    channels = db.query(models.Channel).all()
    if not channels:
        return {"error": "No channels configured yet."}

    jobs = db.query(models.VideoJob).all()
    published = [j for j in jobs if j.status == models.JobStatus.PUBLISHED]

    # Real stats come from a live YouTube API call (same path Mission Control
    # uses) -- there are no cached counts on the Channel row to read.
    total_subs = 0
    total_views = 0
    stats_available = False
    stats_error = None
    for ch in channels:
        if ch.youtube_connected and ch.youtube_refresh_token_enc:
            try:
                access_token = publish_youtube.refresh_access_token(
                    db, crypto.decrypt(ch.youtube_refresh_token_enc)
                )
                stats = publish_youtube.fetch_channel_stats(access_token)
                total_subs += stats["subscribers"]
                total_views += stats["views"]
                stats_available = True
            except Exception as e:
                stats_error = str(e)[:120]

    oldest = min((j.created_at for j in jobs if j.created_at), default=None)
    days_active = max((datetime.utcnow() - oldest).days, 1) if oldest else 1

    out: dict = {
        "channels": [c.name for c in channels],
        "videos_published": len(published),
        "days_active": days_active,
        "videos_per_day": round(len(published) / days_active, 2),
    }
    if stats_available:
        out["subscribers"] = total_subs
        out["views"] = total_views
    else:
        out["stats_note"] = (
            f"Live YouTube stats unavailable ({stats_error})." if stats_error
            else "No YouTube account connected yet, so there are no real subscriber/view numbers to work from."
        )

    if goal_subs or goal_views:
        if not stats_available:
            out["goal_estimate"] = "Can't estimate a timeline without real channel stats connected."
        elif days_active < 7 or (total_subs == 0 and total_views == 0):
            out["goal_estimate"] = (
                "Not enough history to project honestly yet -- needs about a week of real "
                "data and some actual growth to extrapolate from. Anything calculated now "
                "would be a guess dressed up as math."
            )
        else:
            subs_per_day = total_subs / days_active
            views_per_day = total_views / days_active
            est = {}
            if goal_subs:
                if subs_per_day <= 0:
                    est["subscribers"] = f"Not gaining subscribers currently, so {goal_subs:,} isn't reachable at this rate -- the rate has to change first."
                else:
                    days = max(int((goal_subs - total_subs) / subs_per_day), 0)
                    est["subscribers"] = (
                        f"Roughly {days:,} days to {goal_subs:,} subscribers at the current "
                        f"{subs_per_day:.1f}/day -- assumes a flat rate, which rarely holds."
                    )
            if goal_views:
                if views_per_day <= 0:
                    est["views"] = f"Not gaining views currently, so {goal_views:,} isn't reachable at this rate."
                else:
                    days = max(int((goal_views - total_views) / views_per_day), 0)
                    est["views"] = (
                        f"Roughly {days:,} days to {goal_views:,} views at the current "
                        f"{views_per_day:.0f}/day, same caveat."
                    )
            out["goal_estimate"] = est

    advice = []
    if len(published) < 10:
        advice.append("Volume is the main lever right now -- under 10 published videos is too small for the algorithm to learn who to show you to, or for you to tell what's working.")
    if stats_available and total_views > 0 and (total_subs / max(total_views, 1)) < 0.005:
        advice.append("Views are coming but few convert to subscribers -- usually means the hook lands and the payoff doesn't, or there's no reason given to subscribe. Ask explicitly at the strongest moment, not the end.")
    if out["videos_per_day"] < 1:
        advice.append("Under one video a day; Shorts and TikTok both reward consistent daily volume, so raising cadence likely beats polishing individual videos.")
    advice.append("Check retention in YouTube Studio -- where viewers drop off tells you far more than total views. First 3 seconds matter most for Shorts.")
    advice.append("Cross-post the same video to Shorts, TikTok, and Reels -- same asset, three audiences, no extra production cost.")
    out["advice"] = advice
    return out


def _tool_agent_status(db: Session) -> dict:
    from ..agents_registry import AGENTS, CORE
    from ..pipeline.orchestrator import AGENT_NAMES

    # Live per-stage status comes from whatever job is currently running.
    active_job = (
        db.query(models.VideoJob)
        .filter(models.VideoJob.status.notin_([
            models.JobStatus.PUBLISHED, models.JobStatus.FAILED, models.JobStatus.READY,
        ]))
        .order_by(models.VideoJob.created_at.desc())
        .first()
    )
    live = {}
    if active_job and active_job.agent_status:
        try:
            live = json.loads(active_job.agent_status)
        except (json.JSONDecodeError, TypeError):
            live = {}

    wired, scaffold = [], []
    for a in AGENTS:
        entry = {"name": a["name"], "role": a["title"]}
        if a.get("stage") in AGENT_NAMES:
            entry["status"] = live.get(a["stage"], "idle")
            wired.append(entry)
        else:
            scaffold.append(entry)

    return {
        "core": CORE["name"],
        "currently_working_on": (active_job.title or active_job.topic) if active_job else None,
        "pipeline_agents": wired,
        "scaffold_agents_not_yet_functional": [s["name"] for s in scaffold],
        "note": "Scaffold agents are visual placeholders in the constellation -- they have no real logic behind them yet.",
    }


def _tool_manage_channel(db: Session, operation: str, channel_name: str, niche: str | None, style_notes: str | None) -> dict:
    if operation == "create":
        existing = db.query(models.Channel).filter(models.Channel.name.ilike(channel_name)).first()
        if existing:
            return {"error": f"A channel named '{channel_name}' already exists."}
        ch = models.Channel(name=channel_name, niche=niche or "", style_notes=style_notes or "")
        db.add(ch)
        db.commit()
        db.refresh(ch)
        return {"created": True, "channel": ch.name, "niche": ch.niche}

    ch = db.query(models.Channel).filter(models.Channel.name.ilike(f"%{channel_name}%")).first()
    if not ch:
        return {"error": f"No channel matching '{channel_name}'."}
    changed = []
    if niche is not None:
        ch.niche = niche
        changed.append("niche")
    if style_notes is not None:
        ch.style_notes = style_notes
        changed.append("style_notes")
    if not changed:
        return {"error": "Nothing to update -- give a niche or style notes."}
    db.commit()
    return {"updated": True, "channel": ch.name, "fields_changed": changed}


def _tool_manage_job(db: Session, background_tasks: BackgroundTasks, operation: str, job_title: str | None) -> dict:
    q = db.query(models.VideoJob)
    if job_title:
        q = q.filter(
            models.VideoJob.title.ilike(f"%{job_title}%") | models.VideoJob.topic.ilike(f"%{job_title}%")
        )
    job = q.order_by(models.VideoJob.created_at.desc()).first()
    if not job:
        return {"error": f"No job matching '{job_title}'." if job_title else "No jobs found."}

    label = job.title or job.topic or job.id

    if operation == "retry":
        job.status = models.JobStatus.QUEUED
        job.error_message = ""
        db.commit()
        background_tasks.add_task(orchestrator.run_job, job.id)
        return {"retrying": True, "job": label}

    if operation == "delete":
        db.delete(job)
        db.commit()
        return {"deleted": True, "job": label}

    if operation == "publish":
        if job.status != models.JobStatus.READY:
            return {"error": f"'{label}' isn't ready to publish (status: {job.status.value if hasattr(job.status, 'value') else job.status})."}
        job.auto_publish = True
        db.commit()
        background_tasks.add_task(orchestrator.run_job, job.id)
        return {"publishing": True, "job": label}

    return {"error": f"Unknown operation '{operation}'."}


def _tool_workspace_status(db: Session) -> dict:
    # Report only whether keys are SET, never their values -- Jarvis's replies
    # get spoken aloud and stored in chat history, which is the last place a
    # secret should end up.
    key_names = [
        ("anthropic_api_key", "Claude (scripts + Jarvis)"),
        ("elevenlabs_api_key", "ElevenLabs (voice)"),
        ("gemini_api_key", "Gemini (images)"),
        ("openai_api_key", "OpenAI"),
        ("stability_api_key", "Stability (images)"),
        ("jarvis_agent_token", "Computer control pairing"),
    ]
    keys = {label: bool(get_setting(db, k)) for k, label in key_names}

    channels = db.query(models.Channel).all()
    jobs = db.query(models.VideoJob).all()
    by_status: dict[str, int] = {}
    for j in jobs:
        s = j.status.value if hasattr(j.status, "value") else str(j.status)
        by_status[s] = by_status.get(s, 0) + 1

    problems = []
    if not keys["Claude (scripts + Jarvis)"]:
        problems.append("No Claude key -- scripts and Jarvis itself can't run without it.")
    if not keys["ElevenLabs (voice)"]:
        problems.append("No ElevenLabs key -- narration and Jarvis's voice fall back to a robotic browser voice.")
    if not channels:
        problems.append("No channels configured yet.")
    for c in channels:
        if not c.youtube_connected:
            problems.append(f"'{c.name}' isn't connected to YouTube, so it can't publish or report real stats.")
        if not c.auto_enabled:
            problems.append(f"'{c.name}' has automation turned off -- no videos will be made on a schedule.")
    if by_status.get("failed", 0) > 2:
        problems.append(f"{by_status['failed']} failed jobs -- worth checking why before scaling volume.")

    return {
        "api_keys_configured": keys,
        "channels": [
            {"name": c.name, "niche": c.niche, "auto_enabled": c.auto_enabled,
             "videos_per_day": c.auto_per_day, "youtube_connected": c.youtube_connected}
            for c in channels
        ],
        "jobs_by_status": by_status,
        "problems": problems or ["Nothing obviously misconfigured."],
    }


def _tool_computer_action(db: Session, tool_input: dict) -> dict:
    if not get_setting(db, "jarvis_agent_token"):
        return {"error": "No local Jarvis Agent has been paired yet -- set one up in the Jarvis panel's More tab first."}

    action = tool_input.get("action")
    if action not in {"open_app", "focus_window", "type_text", "click_at", "press_keys", "screenshot"}:
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
    if name == "channel_advice":
        return _tool_channel_advice(db, tool_input.get("goal_subscribers"), tool_input.get("goal_views"))
    if name == "agent_status":
        return _tool_agent_status(db)
    if name == "manage_channel":
        return _tool_manage_channel(
            db, tool_input.get("operation", ""), tool_input.get("channel_name", ""),
            tool_input.get("niche"), tool_input.get("style_notes"),
        )
    if name == "manage_job":
        return _tool_manage_job(db, background_tasks, tool_input.get("operation", ""), tool_input.get("job_title"))
    if name == "workspace_status":
        return _tool_workspace_status(db)
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
# Jarvis defaults to a different voice than the video narration on purpose --
# "James" for the assistant, "Adam" for the channel's videos, so the two don't
# sound identical. Resolved BY NAME from the account's own voice list rather
# than a hardcoded ID, since premade voice IDs differ between accounts and a
# wrong hardcoded ID fails confusingly. Falls back to Adam's well-known public
# ID if nothing matching is found.
JARVIS_PREFERRED_VOICE_NAMES = ["James", "Brian", "Adam"]
FALLBACK_VOICE_ID = "pNInz6obpgDQGcFmaJgB"  # ElevenLabs public "Adam"

_voice_name_cache: dict[str, str] = {}


def _resolve_voice_by_name(api_key: str, names: list[str]) -> str | None:
    """Look up a voice ID by display name from the account's voice list.
    Cached per process since this rarely changes and it's on the hot path
    for every spoken reply."""
    cache_key = ",".join(names)
    if cache_key in _voice_name_cache:
        return _voice_name_cache[cache_key]
    try:
        resp = requests.get(
            "https://api.elevenlabs.io/v1/voices",
            headers={"xi-api-key": api_key}, timeout=10,
        )
        resp.raise_for_status()
        voices = resp.json().get("voices", [])
    except requests.RequestException:
        return None
    by_name = {v.get("name", "").strip().lower(): v.get("voice_id") for v in voices}
    for wanted in names:
        vid = by_name.get(wanted.strip().lower())
        if vid:
            _voice_name_cache[cache_key] = vid
            return vid
    return None


class SpeakIn(BaseModel):
    text: str


@router.post("/speak")
def speak(body: SpeakIn, db: Session = Depends(get_db)):
    api_key = get_setting(db, "elevenlabs_api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="No ElevenLabs key configured.")
    voice_id = (
        get_setting(db, "jarvis_voice_id")
        or _resolve_voice_by_name(api_key, JARVIS_PREFERRED_VOICE_NAMES)
        or FALLBACK_VOICE_ID
    )
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


@router.get("/briefing")
def briefing(db: Session = Depends(get_db)):
    """Everything Jarvis says (and shows) when the panel opens.

    Returns both a spoken line and structured metrics so the UI can display
    numbers alongside the narration. Deliberately reports only what's actually true:
    if YouTube isn't connected there are no real subscriber numbers, and it
    says so rather than showing zeros that would read as real data.
    """
    channels = db.query(models.Channel).all()
    jobs = db.query(models.VideoJob).all()

    active = [j for j in jobs if j.status not in (
        models.JobStatus.PUBLISHED, models.JobStatus.READY, models.JobStatus.FAILED)]
    ready = [j for j in jobs if j.status == models.JobStatus.READY]
    failed = [j for j in jobs if j.status == models.JobStatus.FAILED]
    published = [j for j in jobs if j.status == models.JobStatus.PUBLISHED]

    metrics = {
        "channels": len(channels),
        "in_progress": len(active),
        "ready_for_review": len(ready),
        "failed": len(failed),
        "published": len(published),
        "subscribers": None,
        "views": None,
    }

    for ch in channels:
        if ch.youtube_connected and ch.youtube_refresh_token_enc:
            try:
                from .. import crypto
                from ..pipeline import publish_youtube
                token = publish_youtube.refresh_access_token(db, crypto.decrypt(ch.youtube_refresh_token_enc))
                stats = publish_youtube.fetch_channel_stats(token)
                metrics["subscribers"] = (metrics["subscribers"] or 0) + stats["subscribers"]
                metrics["views"] = (metrics["views"] or 0) + stats["views"]
            except Exception:
                pass

    issues = []
    if failed:
        issues.append(f"{len(failed)} failed video{'s' if len(failed) != 1 else ''}")
    if not channels:
        issues.append("no channels set up yet")
    for ch in channels:
        if not ch.youtube_connected:
            issues.append(f"{ch.name} isn't connected to YouTube")
        elif not ch.auto_enabled:
            issues.append(f"automation is off for {ch.name}")

    parts = []
    if metrics["subscribers"] is not None:
        parts.append(f"{metrics['subscribers']:,} subscribers and {metrics['views']:,} views")
    if active:
        parts.append(f"{len(active)} video{'s' if len(active) != 1 else ''} rendering")
    if ready:
        parts.append(f"{len(ready)} ready for review")

    spoken = "Welcome back."
    if parts:
        spoken += " You've got " + ", ".join(parts) + "."
    if issues:
        spoken += " Worth knowing: " + ", ".join(issues) + "."
    if not parts and not issues:
        spoken += " Everything's quiet -- nothing running and nothing broken."

    return {"spoken": spoken, "metrics": metrics, "issues": issues}


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
