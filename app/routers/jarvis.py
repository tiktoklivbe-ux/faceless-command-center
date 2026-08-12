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

import requests
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
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
    "You are Jarvis, the AI aide running inside a faceless-YouTube/TikTok automation app "
    "that generates and auto-publishes short and long-form videos across channels. "
    "You can check on and manage video jobs and channel automation, retry/cancel renders, "
    "start new videos, make a channel's uploads public, run pre-approved diagnostics, "
    "read/list/write files inside this project folder, save and read notes, fetch public "
    "web pages read-only, control the camera/HUD, and send a WhatsApp/ntfy notification -- "
    "all via your tools. You have NO capabilities beyond those tools.\n\n"
    "HOW TO BEHAVE -- this matters most:\n"
    "1. BE BRIEF. These are spoken aloud, so 1-2 short sentences is the target -- a long "
    "reply is painful to listen to. Give the answer, not a paragraph around it. Never "
    "restate the question or narrate what you're about to do at length.\n"
    "2. BE A HELPING HAND, NOT A GATEKEEPER. You're a proactive partner in running this "
    "operation, not a Q&A bot. When asked to do something, prefer DOING it with a tool "
    "over describing it. If you can reasonably infer intent, act -- don't interrogate.\n"
    "3. NEVER a blunt 'no'. If something's genuinely outside your tools, say so in one "
    "line AND immediately offer the closest thing you CAN do, or the exact step the user "
    "should take themselves. Always leave them with a next move.\n"
    "4. USE CONTEXT. You know this is a video-automation business. Read between the lines: "
    "'how are we doing' means check jobs/channels; 'post it' means publish; 'make one "
    "about X' means start a video. Infer the obvious.\n"
    "5. When you take an action, confirm it in a few words -- what happened, any number "
    "that matters. Skip the play-by-play.\n\n"
    "Personality: a composed, dry-witted, quietly-confident aide (think a real Jarvis). "
    "Address the user as 'sir' occasionally, not every line. Vary acknowledgments "
    "naturally ('On it.', 'Done.', 'Right away.') -- never force a catchphrase, and never "
    "let a flourish replace the actual answer."
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


def _anthropic_stream_call(db: Session, messages: list[dict]):
    """Same call as _anthropic_call, but streamed -- yields ("text_delta", str)
    as text arrives so the UI can show/speak the reply as it's written instead
    of waiting for the whole thing, then a final ("blocks", [...]) with the
    complete content blocks (text and/or tool_use) once the turn is done.

    This is what actually fixes "make him respond instantly on release" --
    the earlier fix (an instant caption update the moment the key comes up)
    covered the dead air before the network call even starts, but the reply
    itself still only appeared after the ENTIRE multi-second completion came
    back. Streaming means the first words show (and can start being spoken)
    well under a second in, not after the full 2-6s round trip.
    """
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
            "stream": True,
        },
        timeout=60,
        stream=True,
    )
    if resp.status_code != 200:
        # Anthropic error bodies aren't SSE -- read the plain response so the
        # real reason (bad key, rate limit, etc.) surfaces instead of a parse error.
        raise HTTPException(resp.status_code, f"Anthropic call failed: {resp.text[:300]}")

    blocks = []
    current = None
    text_buf = ""
    json_buf = ""
    thinking_buf = ""
    signature_buf = ""
    for raw_line in resp.iter_lines():
        if not raw_line:
            continue
        line = raw_line.decode("utf-8", "ignore")
        if not line.startswith("data: "):
            continue
        try:
            event = json.loads(line[len("data: "):])
        except json.JSONDecodeError:
            continue
        etype = event.get("type")
        if etype == "content_block_start":
            current = dict(event.get("content_block") or {})
            text_buf, json_buf, thinking_buf, signature_buf = "", "", "", ""
        elif etype == "content_block_delta":
            delta = event.get("delta") or {}
            dtype = delta.get("type")
            if dtype == "text_delta":
                piece = delta.get("text", "")
                text_buf += piece
                if piece:
                    yield ("text_delta", piece)
            elif dtype == "input_json_delta":
                json_buf += delta.get("partial_json", "")
            elif dtype == "thinking_delta":
                # Sonnet 5 interleaves extended-thinking blocks alongside
                # tool calls. Anthropic requires every thinking block sent
                # back in later turns to actually contain its thinking text
                # (and signature) -- silently dropping this (as an earlier
                # version of this parser did, only handling text/tool_use)
                # produced a malformed block that got rejected on the very
                # next round: "each thinking block must contain thinking".
                thinking_buf += delta.get("thinking", "")
            elif dtype == "signature_delta":
                signature_buf += delta.get("signature", "")
        elif etype == "content_block_stop":
            if current is not None:
                if current.get("type") == "text":
                    current["text"] = text_buf
                elif current.get("type") == "tool_use":
                    try:
                        current["input"] = json.loads(json_buf) if json_buf else {}
                    except json.JSONDecodeError:
                        current["input"] = {}
                elif current.get("type") == "thinking":
                    current["thinking"] = thinking_buf
                    if signature_buf:
                        current["signature"] = signature_buf
                blocks.append(current)
            current = None
        elif etype == "message_stop":
            break
    yield ("blocks", blocks)


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


def _kill_switch_refusal_results(tool_uses: list[dict]) -> list[dict]:
    return [
        {"type": "tool_result", "tool_use_id": tu["id"],
         "content": "Jarvis was switched off before this could run."}
        for tu in tool_uses
    ]


def _execute_tool_uses(db: Session, tool_uses: list[dict], source: str, user_message: str):
    """Shared by the non-streaming and streaming chat paths so tool execution
    and audit logging only exist in one place. Returns (tool_results, actions)."""
    actions = []
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
    return tool_results, actions


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
            messages.append({"role": "user", "content": _kill_switch_refusal_results(tool_uses)})
            for tu in tool_uses:
                _log_call(db, source, tu["name"], tu.get("input", {}), False,
                          {"error": "kill switch engaged mid-conversation"}, user_message)
            continue

        tool_results, new_actions = _execute_tool_uses(db, tool_uses, source, user_message)
        actions.extend(new_actions)
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


@router.post("/chat/stream")
def chat_stream(payload: ChatIn, db: Session = Depends(get_db)):
    """Same conversation turn as /chat, but streamed as Server-Sent Events so
    the reply appears (and can start being spoken) as it's written instead of
    only after the full multi-second completion comes back -- this is the
    actual fix for "make him respond instantly", not just an instant UI
    acknowledgment of the request (which already existed).

    Each event is one line: `data: {"type": ..., ...}\\n\\n`.
      - {"type": "text", "text": "..."}   a chunk of the reply as it streams
      - {"type": "done", "history": [...], "actions": [...]}   turn complete
      - {"type": "error", "text": "..."}   something went wrong mid-stream
    """
    def gen():
        if not _kill_switch_on(db):
            msg = "Jarvis is currently switched off. Turn it back on in the Jarvis panel to talk to me."
            yield f"data: {json.dumps({'type': 'text', 'text': msg})}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'history': payload.history, 'actions': []})}\n\n"
            return

        # Streaming is Anthropic-only for now -- Gemini's stream format is
        # different enough to be its own follow-up. Falling back to the
        # existing non-streamed turn means switching providers never breaks
        # chat, it just temporarily loses the instant-typing effect.
        if _jarvis_provider(db) != "anthropic":
            result = _run_turn_gemini(db, payload.message, payload.history, "app")
            yield f"data: {json.dumps({'type': 'text', 'text': result['reply']})}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'history': result['history'], 'actions': result['actions']})}\n\n"
            return

        messages = list(payload.history) + [{"role": "user", "content": payload.message}]
        actions = []
        try:
            for _ in range(MAX_TOOL_ROUNDS):
                blocks = []
                for kind, data in _anthropic_stream_call(db, messages):
                    if kind == "text_delta":
                        yield f"data: {json.dumps({'type': 'text', 'text': data})}\n\n"
                    elif kind == "blocks":
                        blocks = data
                messages.append({"role": "assistant", "content": blocks})

                tool_uses = [b for b in blocks if b.get("type") == "tool_use"]
                if not tool_uses:
                    yield f"data: {json.dumps({'type': 'done', 'history': messages, 'actions': actions})}\n\n"
                    return

                if not _kill_switch_on(db):
                    messages.append({"role": "user", "content": _kill_switch_refusal_results(tool_uses)})
                    for tu in tool_uses:
                        _log_call(db, "app", tu["name"], tu.get("input", {}), False,
                                  {"error": "kill switch engaged mid-conversation"}, payload.message)
                    continue

                tool_results, new_actions = _execute_tool_uses(db, tool_uses, "app", payload.message)
                actions.extend(new_actions)
                messages.append({"role": "user", "content": tool_results})

            give_up = "That took more steps than I'm allowed to chain at once -- try breaking it into smaller asks."
            yield f"data: {json.dumps({'type': 'text', 'text': give_up})}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'history': messages, 'actions': actions})}\n\n"
        except HTTPException as e:
            yield f"data: {json.dumps({'type': 'error', 'text': str(e.detail)})}\n\n"
        except Exception as e:
            log.exception("Jarvis streamed chat failed")
            yield f"data: {json.dumps({'type': 'error', 'text': str(e)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",  # tell any proxy in front of this not to buffer -- chunks need to flush immediately to actually feel instant
    })


@router.get("/notes")
def get_notes(limit: int = 10, db: Session = Depends(get_db)):
    """Read-only, for the HUD's Quick Access panel -- reuses the same
    add_note/list_notes tool logic Jarvis itself uses, so there's exactly
    one place notes are actually read from, not a second parallel
    implementation that could drift from it."""
    return jarvis_tools.list_notes(db, limit)


@router.get("/dataset")
def get_dataset(which: str = "status", db: Session = Depends(get_db)):
    """Manual (non-Jarvis) access to the same dataset computation the
    show_dataset tool uses, so the HUD's own Data button renders identical
    numbers to what Jarvis pulls up."""
    return jarvis_tools.compute_dataset(db, which)


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
        json={
            # eleven_turbo_v2_5 is far lower-latency than multilingual_v2
            # (the audio comes back in a fraction of the time) while staying
            # high quality -- directly fixes "Jarvis takes forever to reply".
            # speed:1.12 delivers the line a touch quicker so a short answer
            # doesn't drag, without sounding rushed. Together with the now-
            # concise system prompt, replies are short AND fast to hear.
            "text": text[:2000],  # a runaway reply shouldn't turn into a multi-minute TTS call
            "model_id": "eleven_turbo_v2_5",
            "voice_settings": {"stability": 0.4, "similarity_boost": 0.8, "speed": 1.12},
        },
        timeout=60,
    )
    if resp.status_code != 200:
        raise HTTPException(502, f"ElevenLabs TTS failed ({resp.status_code}): {resp.text[:300]}")
    return Response(content=resp.content, media_type="audio/mpeg")


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
