"""
The "Part 2" business-development module: AI-drafted outreach and reply
emails for the prospect pipeline (see Prospect in models.py). Deliberately
NEVER sends anything itself -- every draft is handed back to the browser as
a mailto: link, so the actual send is always the user's own click in their
own email client. That's not a technical limitation, it's the design: this
app doesn't send messages to third parties on the user's behalf without them
seeing and choosing to send the exact text.

Uses a plain-text LLM call rather than script_stage's helpers, which force
JSON-structured output built for the video-script use case -- email drafting
just needs prose back.
"""
import re

import requests
from sqlalchemy.orm import Session

from .settings_store import get_setting

SYSTEM_PROMPT = (
    "You write short, genuine-sounding B2B outreach emails for someone selling AI "
    "automation services to small businesses. Never generic, never salesy/hypey, no "
    "exclamation-point energy, no 'I hope this email finds you well'. Sound like a real "
    "person who looked at this specific business and had one concrete, relevant idea -- "
    "not a mail-merge template. This may be one of several emails going to similar "
    "businesses in the same category -- vary your actual phrasing, structure, and which "
    "detail you lead with each time, the way a real person naturally would, not the same "
    "sentence shape with the business name swapped in. Short: 3-5 sentences for a first "
    "outreach, shorter for a reply. Always end output in exactly this format, nothing else "
    "before or after:\n"
    "SUBJECT: <subject line>\nBODY:\n<email body>"
)


def _call_llm_text(db: Session, user_prompt: str, max_tokens: int = 500) -> str:
    """Provider-aware plain-text completion -- tries the configured provider,
    falls back to whichever key is actually present, same preference order
    the rest of the app uses elsewhere."""
    provider = get_setting(db, "llm_provider", "anthropic")
    anthropic_key = get_setting(db, "anthropic_api_key")
    gemini_key = get_setting(db, "gemini_api_key")

    def _anthropic():
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": anthropic_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={
                "model": get_setting(db, "anthropic_model", "claude-sonnet-5"),
                "max_tokens": max_tokens,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": user_prompt}],
            },
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        return "".join(b.get("text", "") for b in data.get("content", []))

    def _gemini():
        resp = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{get_setting(db, 'jarvis_gemini_model', 'gemini-3.5-flash')}:generateContent",
            headers={"x-goog-api-key": gemini_key, "content-type": "application/json"},
            json={
                "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
                "generationConfig": {"maxOutputTokens": max_tokens},
            },
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        return "".join(p.get("text", "") for p in parts)

    if provider == "anthropic" and anthropic_key:
        return _anthropic()
    if provider == "gemini" and gemini_key:
        return _gemini()
    if anthropic_key:
        return _anthropic()
    if gemini_key:
        return _gemini()
    raise RuntimeError("No script-writing key configured (Anthropic or Gemini) -- add one in Settings first.")


def _parse_subject_body(text: str) -> dict:
    m = re.search(r"SUBJECT:\s*(.+?)\s*\n+BODY:\s*\n?(.+)", text, re.DOTALL)
    if not m:
        # Model didn't follow the format -- still hand back something usable
        # rather than erroring out on a genuinely fine email.
        return {"subject": "Quick idea for your business", "body": text.strip()}
    return {"subject": m.group(1).strip(), "body": m.group(2).strip()}


def draft_outreach_email(db: Session, prospect) -> dict:
    pitch = get_setting(db, "business_pitch", "").strip()
    if not pitch:
        raise ValueError("No pitch configured yet -- add what you're selling in Settings (business_pitch) first, "
                          "so drafts are actually about your real offer.")
    sender = get_setting(db, "business_sender_name", "").strip()
    prompt = (
        f"What I'm selling / my pitch:\n{pitch}\n\n"
        f"The business I'm reaching out to: {prospect.business_name}"
        + (f", contact: {prospect.contact_name}" if prospect.contact_name else "")
        + (f"\nWebsite: {prospect.website}" if prospect.website else "")
        + (f"\nNotes about them: {prospect.notes}" if prospect.notes else "")
        + f"\n\nWrite a first outreach email to this business."
        + (f" Sign off as {sender}." if sender else "")
    )
    text = _call_llm_text(db, prompt)
    return _parse_subject_body(text)


def draft_reply_response(db: Session, prospect, reply_text: str) -> dict:
    pitch = get_setting(db, "business_pitch", "").strip()
    sender = get_setting(db, "business_sender_name", "").strip()
    prompt = (
        f"What I'm selling / my pitch:\n{pitch}\n\n"
        f"I emailed {prospect.business_name} and they replied:\n\"{reply_text}\"\n\n"
        f"Draft my response -- read what they actually said and respond to that specifically "
        f"(a question, an objection, interest, a brush-off), don't just repeat the pitch."
        + (f" Sign off as {sender}." if sender else "")
    )
    text = _call_llm_text(db, prompt, max_tokens=400)
    return _parse_subject_body(text)
