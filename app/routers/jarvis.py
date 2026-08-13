"""
Jarvis -- a Claude-powered assistant with tool access strictly limited to
app/jarvis_tools.py's whitelist. See that file's docstring for why this is
the actual safety mechanism (Claude literally cannot call anything that
isn't defined there), not just a prompt asking it to behave.

Every tool call -- allowed or refused -- is written to JarvisLog, and the
kill switch (settings key "jarvis_enabled") is checked before anything
else runs, so disabling Jarvis is always one flag away regardless of what
else is happening.
"""
import json
import logging
from xml.sax.saxutils import escape as xml_escape

import base64
import requests
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import jarvis_tools, models
from ..database import get_db
from ..settings_store import get_setting, set_setting
from ..twilio_utils import verify_twilio_signature

log = logging.getLogger("jarvis")
router = APIRouter(prefix="/api/jarvis", tags=["jarvis"])

# Phone number -> conversation history. In-memory only (not persisted across
# restarts) -- a texted conversation losing context after a redeploy is a
# minor inconvenience; it's not worth a DB table for what's meant to be a
# quick back-and-forth, not a long-running thread.
_whatsapp_history: dict[str, list[dict]] = {}
_WHATSAPP_HISTORY_CAP = 20  # messages, not full exchanges -- keeps the Claude call cheap

MAX_TOOL_ROUNDS = 5  # a runaway tool-call loop stops here rather than looping forever

SYSTEM_PROMPT = (
    "You are Jarvis, the assistant inside a faceless-YouTube-channel automation app. "
    "You can check on and manage video jobs and channel automation, run a small set of "
    "pre-approved diagnostic terminal commands, read/list/write files inside this app's "
    "own project folder, save and read back notes, fetch public web pages read-only, and "
    "open/close/reposition/resize/fullscreen the camera preview on your HUD, and send a "
    "WhatsApp/notification message on request -- all using your tools. "
    "You have NO capabilities beyond the tools you've been given -- if someone asks for "
    "something outside them (controlling other software, files outside this project, "
    "anything you don't have a tool for), say plainly that it's outside what you're "
    "allowed to do right now, rather than attempting to improvise around it. Be concise "
    "-- this is a quick spoken/texted exchange, not an essay. When you take an action, "
    "say what you did in plain terms. "
    "Personality: you're a composed, capable aide, not a generic chatbot -- a little dry "
    "wit, unflappable, quietly confident. Vary how you acknowledge a request instead of "
    "repeating one stock phrase -- 'Right away.' / 'Consider it done.' / 'On it.' / "
    "'Straight away, sir.' / 'As you wish.' -- but only where it fits naturally; never "
    "force a catchphrase into every single reply, and never let the flourish replace an "
    "actual, substantive answer. Address the user as 'sir' occasionally, not every line."
)


class ChatIn(BaseModel):
    message: str
    history: list[dict] = []


def _kill_switch_on(db: Session) -> bool:
    return get_setting(db, "jarvis_enabled", "true") == "true"


def _jarvis_provider(db: Session) -> str:
    """Which LLM answers for Jarvis. A dedicated setting rather than reusing
    the script-writer's llm_provider -- you might reasonably want scripts on
    one provider and Jarvis on another (e.g. Gemini for Jarvis specifically,
    as asked for). Falls back to whichever key is actually present if
    nothing's been explicitly chosen."""
    explicit = get_setting(db, "jarvis_llm_provider", "")
    if explicit in ("anthropic", "gemini"):
        return explicit
    if get_setting(db, "anthropic_api_key"):
        return "anthropic"
    if get_setting(db, "gemini_api_key"):
        return "gemini"
    return "anthropic"  # will fail with a clear "no key" error below, same as before


def _anthropic_call(db: Session, messages: list[dict]) -> dict:
    api_key = get_setting(db, "anthropic_api_key")
    if not api_key:
        raise HTTPException(400, "No Anthropic key set -- Jarvis needs one in Settings to think at all.")
    model = get_setting(db, "anthropic_model", "claude-sonnet-5")
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": 1024,
            "system": SYSTEM_PROMPT,
            "messages": messages,
            "tools": jarvis_tools.TOOLS,
        },
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------- Gemini
# Gemini's function-calling format is structurally different from
# Anthropic's tool-use (different schema shape, different message/turn
# format, different response shape) -- rather than maintain two separate
# tool definitions that could drift apart, the schemas are converted from
# the ONE canonical list in jarvis_tools.TOOLS every call. That list stays
# the single source of truth for what Jarvis can do, regardless of provider.
def _to_gemini_schema(schema: dict) -> dict:
    TYPE_MAP = {"object": "OBJECT", "string": "STRING", "integer": "INTEGER",
                "boolean": "BOOLEAN", "array": "ARRAY", "number": "NUMBER"}
    out = {"type": TYPE_MAP.get(schema.get("type", "object"), "STRING")}
    if "description" in schema:
        out["description"] = schema["description"]
    if "properties" in schema:
        out["properties"] = {k: _to_gemini_schema(v) for k, v in schema["properties"].items()}
    if "required" in schema:
        out["required"] = schema["required"]
    if "items" in schema:
        out["items"] = _to_gemini_schema(schema["items"])
    return out


def _gemini_tools() -> list[dict]:
    return [{"functionDeclarations": [
        {"name": t["name"], "description": t["description"], "parameters": _to_gemini_schema(t["input_schema"])}
        for t in jarvis_tools.TOOLS
    ]}]


def _gemini_call(db: Session, contents: list[dict]) -> dict:
    api_key = get_setting(db, "gemini_api_key")
    if not api_key:
        raise HTTPException(400, "No Gemini key set -- Jarvis needs one in Settings to think at all.")
    model = get_setting(db, "jarvis_gemini_model", "") or "gemini-3.5-flash"
    resp = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": api_key, "content-type": "application/json"},
        json={
            "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": contents,
            "tools": _gemini_tools(),
        },
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def _log_call(db: Session, source: str, action: str, params: dict, allowed: bool, result, user_message: str):
    try:
        db.add(models.JarvisLog(
            source=source, action=action, params=json.dumps(params)[:2000],
            allowed=allowed, result=json.dumps(result)[:2000], user_message=user_message[:500],
        ))
        db.commit()
    except Exception:
        log.exception("Couldn't write Jarvis activity log (continuing anyway)")


def _run_turn_anthropic(db: Session, user_message: str, history: list[dict], source: str) -> dict:
    messages = list(history) + [{"role": "user", "content": user_message}]
    actions = []

    for _ in range(MAX_TOOL_ROUNDS):
        data = _anthropic_call(db, messages)
        content = data.get("content", [])
        messages.append({"role": "assistant", "content": content})

        tool_uses = [b for b in content if b.get("type") == "tool_use"]
        if not tool_uses:
            text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
            return {"reply": text.strip() or "(no response)", "history": messages, "actions": actions}

        # Re-check the kill switch before EVERY tool round, not just at the
        # start -- someone could flip it off mid-conversation and that has
        # to stop the next action, not just future conversations.
        if not _kill_switch_on(db):
            tool_results = [
                {"type": "tool_result", "tool_use_id": tu["id"],
                 "content": "Jarvis was switched off before this could run."}
                for tu in tool_uses
            ]
            messages.append({"role": "user", "content": tool_results})
            for tu in tool_uses:
                _log_call(db, source, tu["name"], tu.get("input", {}), False,
                          {"error": "kill switch engaged mid-conversation"}, user_message)
            continue

        tool_results = []
        for tu in tool_uses:
            name, tool_input = tu["name"], tu.get("input", {})
            allowed = name in jarvis_tools.TOOL_NAMES
            result = jarvis_tools.call_tool(db, name, tool_input)
            _log_call(db, source, name, tool_input, allowed, result, user_message)
            if allowed and "error" not in result:
                actions.append({"tool": name, "input": tool_input, "result": result})
            tool_results.append({
                "type": "tool_result", "tool_use_id": tu["id"], "content": json.dumps(result),
            })
        messages.append({"role": "user", "content": tool_results})

    return {"reply": "That took more steps than I'm allowed to chain at once -- try breaking it into smaller asks.",
            "history": messages, "actions": actions}


def _run_turn_gemini(db: Session, user_message: str, history: list[dict], source: str) -> dict:
    contents = list(history) + [{"role": "user", "parts": [{"text": user_message}]}]
    actions = []

    for _ in range(MAX_TOOL_ROUNDS):
        data = _gemini_call(db, contents)
        candidates = data.get("candidates") or []
        parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
        contents.append({"role": "model", "parts": parts})

        calls = [p["functionCall"] for p in parts if "functionCall" in p]
        if not calls:
            text = "".join(p.get("text", "") for p in parts)
            return {"reply": text.strip() or "(no response)", "history": contents, "actions": actions}

        if not _kill_switch_on(db):
            responses = [
                {"functionResponse": {"name": c["name"], "response": {"error": "Jarvis was switched off before this could run."}}}
                for c in calls
            ]
            contents.append({"role": "user", "parts": responses})
            for c in calls:
                _log_call(db, source, c["name"], c.get("args", {}), False,
                          {"error": "kill switch engaged mid-conversation"}, user_message)
            continue

        responses = []
        for c in calls:
            name, tool_input = c["name"], c.get("args", {})
            allowed = name in jarvis_tools.TOOL_NAMES
            result = jarvis_tools.call_tool(db, name, tool_input)
            _log_call(db, source, name, tool_input, allowed, result, user_message)
            if allowed and "error" not in result:
                actions.append({"tool": name, "input": tool_input, "result": result})
            responses.append({"functionResponse": {"name": name, "response": result}})
        contents.append({"role": "user", "parts": responses})

    return {"reply": "That took more steps than I'm allowed to chain at once -- try breaking it into smaller asks.",
            "history": contents, "actions": actions}


def run_turn(db: Session, user_message: str, history: list[dict], source: str = "app") -> dict:
    """Runs one full conversational turn, including any tool-use rounds.
    Shared by the in-app chat endpoint and the SMS/WhatsApp webhook -- the
    whitelist and logging apply identically regardless of who's asking or
    which provider is answering.
    """
    if not _kill_switch_on(db):
        return {"reply": "Jarvis is currently switched off. Turn it back on in the Jarvis panel to talk to me.",
                "history": history, "actions": []}

    provider = _jarvis_provider(db)
    if provider == "gemini":
        return _run_turn_gemini(db, user_message, history, source)
    return _run_turn_anthropic(db, user_message, history, source)


@router.post("/chat")
def chat(payload: ChatIn, db: Session = Depends(get_db)):
    return run_turn(db, payload.message, payload.history, source="app")


@router.get("/notes")
def get_notes(limit: int = 10, db: Session = Depends(get_db)):
    """Read-only, for the HUD's Quick Access panel -- reuses the same
    add_note/list_notes tool logic Jarvis itself uses, so there's exactly
    one place notes are actually read from, not a second parallel
    implementation that could drift from it."""
    return jarvis_tools.list_notes(db, limit)


class SpeakIn(BaseModel):
    text: str


@router.post("/speak")
def speak(payload: SpeakIn, db: Session = Depends(get_db)):
    """Jarvis's spoken replies, via the same ElevenLabs account/key already
    used for video narration -- not the browser's built-in TTS voice. 404s
    (rather than a synthetic fallback) when no key is set, so the frontend
    can fall back to speechSynthesis instead of silently playing nothing."""
    from ..pipeline.voice_stage import DEFAULT_VOICE_ID

    api_key = get_setting(db, "elevenlabs_api_key")
    if not api_key:
        raise HTTPException(404, "No ElevenLabs API key configured.")
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(400, "No text to speak.")
    voice_id = get_setting(db, "jarvis_voice_id") or DEFAULT_VOICE_ID
    resp = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        headers={"xi-api-key": api_key, "content-type": "application/json", "accept": "audio/mpeg"},
        # optimize_streaming_latency=4 is the max latency optimization -- gets
        # the audio back fastest, which is what "he takes a while to speak
        # even though the reply's ready" was about.
        params={"optimize_streaming_latency": 4},
        json={
            "text": text[:2000],  # a runaway reply shouldn't turn into a multi-minute TTS call
            # eleven_flash_v2_5 is ElevenLabs' lowest-latency model (~75ms
            # generation) -- far faster to start than multilingual_v2 the
            # revert had restored. speed 1.15 delivers the line noticeably
            # quicker without sounding rushed (1.2 is the ceiling before it
            # starts clipping).
            "model_id": "eleven_flash_v2_5",
            "voice_settings": {"stability": 0.4, "similarity_boost": 0.8, "speed": 1.15},
        },
        timeout=60,
    )
    if resp.status_code != 200:
        raise HTTPException(502, f"ElevenLabs TTS failed ({resp.status_code}): {resp.text[:300]}")
    return Response(content=resp.content, media_type="audio/mpeg")


@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), db: Session = Depends(get_db)):
    """Speech-to-text for the mic button. The browser records from whatever
    input device it captured -- INCLUDING a Bluetooth mic the user picked --
    and we transcribe it here, server-side. This deliberately does NOT use the
    browser's built-in SpeechRecognition, which can't target a specific device
    and has been unreliable on Edge/Windows; recording + server STT sidesteps
    that entire class of failure. ElevenLabs Scribe first (already the TTS
    provider, so a key is present), Gemini as a fallback."""
    data = await audio.read()
    if not data:
        raise HTTPException(400, "No audio received.")
    mime = audio.content_type or "audio/webm"
    errors = []

    el_key = get_setting(db, "elevenlabs_api_key")
    if el_key:
        try:
            resp = requests.post(
                "https://api.elevenlabs.io/v1/speech-to-text",
                headers={"xi-api-key": el_key},
                files={"file": ("audio.webm", data, mime)},
                data={"model_id": "scribe_v1"},
                timeout=60,
            )
            if resp.status_code == 200:
                return {"text": (resp.json().get("text") or "").strip(), "provider": "elevenlabs"}
            errors.append(f"ElevenLabs {resp.status_code}: {resp.text[:200]}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"ElevenLabs error: {e}")

    gem_key = get_setting(db, "gemini_api_key")
    if gem_key:
        try:
            model = get_setting(db, "gemini_model", "gemini-3.5-flash")
            b64 = base64.b64encode(data).decode()
            resp = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                headers={"x-goog-api-key": gem_key, "content-type": "application/json"},
                json={"contents": [{"parts": [
                    {"text": "Transcribe this audio to plain text. Return ONLY the exact words spoken, nothing else -- no preamble, no quotes."},
                    {"inline_data": {"mime_type": mime, "data": b64}},
                ]}]},
                timeout=60,
            )
            if resp.status_code == 200:
                cand = (resp.json().get("candidates") or [{}])[0]
                parts = cand.get("content", {}).get("parts", [])
                text = "".join(p.get("text", "") for p in parts).strip()
                return {"text": text, "provider": "gemini"}
            errors.append(f"Gemini {resp.status_code}: {resp.text[:200]}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"Gemini error: {e}")

    raise HTTPException(502, "Transcription failed. " + " | ".join(errors) if errors
                        else "No speech-to-text provider is configured (needs an ElevenLabs or Gemini key).")


@router.get("/log")
def get_log(limit: int = 50, db: Session = Depends(get_db)):
    rows = (
        db.query(models.JarvisLog)
        .order_by(models.JarvisLog.created_at.desc())
        .limit(min(limit, 200))
        .all()
    )
    return [{
        "id": r.id, "created_at": r.created_at.isoformat() if r.created_at else None,
        "source": r.source, "action": r.action, "params": r.params,
        "allowed": r.allowed, "result": r.result, "user_message": r.user_message,
    } for r in rows]


@router.get("/enabled")
def get_enabled(db: Session = Depends(get_db)):
    return {"enabled": _kill_switch_on(db)}


@router.post("/enabled")
def set_enabled(payload: dict, db: Session = Depends(get_db)):
    on = bool(payload.get("enabled", True))
    set_setting(db, "jarvis_enabled", "true" if on else "false", is_secret=False)
    return {"enabled": on}


def _twiml(message: str) -> Response:
    body = f'<?xml version="1.0" encoding="UTF-8"?><Response><Message>{xml_escape(message)}</Message></Response>'
    return Response(content=body, media_type="application/xml")


@router.post("/whatsapp")
async def whatsapp_webhook(request: Request, db: Session = Depends(get_db)):
    """Twilio's incoming-WhatsApp-message webhook.

    Two independent gates before anything Jarvis-related happens:
    1. The request's signature must actually be from Twilio (proves it's not
       someone who found this URL and is pretending to text as you).
    2. The FROM number must be on your allowlist (proves it's actually your
       phone, not just anyone who knows your Twilio number).
    Failing either one gets a silent, valid-but-empty response -- not an
    error that would confirm to a prober that this endpoint exists and does
    something.
    """
    form = dict((await request.form()))
    signature = request.headers.get("X-Twilio-Signature", "")

    auth_token = get_setting(db, "twilio_auth_token")
    if not verify_twilio_signature(auth_token, request.url.path, form, signature):
        log.warning("Jarvis WhatsApp webhook: signature check failed (bad token, or not really Twilio).")
        return _twiml("")

    from_number = form.get("From", "").replace("whatsapp:", "").strip()
    allowlist = [n.strip() for n in get_setting(db, "jarvis_phone_allowlist", "").split(",") if n.strip()]
    if not allowlist or from_number not in allowlist:
        log.warning("Jarvis WhatsApp webhook: message from %s, not on the allowlist.", from_number or "(unknown)")
        return _twiml("")

    body = form.get("Body", "").strip()
    if not body:
        return _twiml("")

    history = _whatsapp_history.get(from_number, [])
    result = run_turn(db, body, history, source="whatsapp")
    _whatsapp_history[from_number] = result["history"][-_WHATSAPP_HISTORY_CAP:]

    return _twiml(result["reply"][:1500])  # WhatsApp messages have a real length ceiling
