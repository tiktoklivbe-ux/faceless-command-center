"""
Stage 1: turn a channel's niche (+ optional topic) into a structured script:
a title, a description, and a list of narration "segments" -- each with the
line to be narrated and a short prompt describing the visual that should
accompany it. Segments are what everything downstream (voice, images,
captions) syncs to.

Uses Anthropic's Claude API by default (this app is built by Claude, after
all) or OpenAI if you set llm_provider=openai in Settings. If no key is
configured yet, falls back to a local template generator so you can test the
rest of the pipeline before wiring up billing.
"""
import json
import re
import textwrap
from sqlalchemy.orm import Session

import requests

from ..settings_store import get_setting

SYSTEM_PROMPT = textwrap.dedent("""
    You write short-form narration scripts for a faceless YouTube/TikTok channel.
    Given a channel niche and (optionally) a specific topic, produce a punchy,
    original 45-90 second script split into narration segments.

    Rules:
    - The content must be YOUR/the channel's original narration and framing, not a
      copy of someone else's article or a plain list of facts with zero commentary --
      YouTube's monetization policy demotes low-effort/templated/reused content, so
      always add a clear point of view, a hook, and a wrap-up thought.
    - 6 to 12 segments. Each segment is one or two sentences of narration.
    - Each segment also gets a short "visual_prompt": a plain description of an image
      that would accompany that line (for an AI image generator) -- concrete, visual,
      no text-in-image requests.
    - Return ONLY valid JSON, no markdown fences, matching this shape:
    {
      "title": "...",
      "description": "...",
      "segments": [ {"narration": "...", "visual_prompt": "..."}, ... ]
    }
""").strip()


def _user_prompt(niche: str, topic: str, style_notes: str) -> str:
    parts = [f"Channel niche: {niche or 'general faceless shorts channel'}"]
    if topic:
        parts.append(f"Topic for this specific video: {topic}")
    else:
        parts.append("No specific topic given -- pick a fresh, engaging one that fits the niche.")
    if style_notes:
        parts.append(f"Extra style notes: {style_notes}")
    return "\n".join(parts)


def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    return json.loads(text)


def _call_anthropic(db: Session, prompt: str) -> dict:
    api_key = get_setting(db, "anthropic_api_key")
    model = get_setting(db, "anthropic_model", "claude-sonnet-4-5")
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": model,
            "max_tokens": 1500,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    text = "".join(block.get("text", "") for block in data.get("content", []))
    return _extract_json(text)


def _call_gemini(db: Session, prompt: str) -> dict:
    api_key = get_setting(db, "gemini_api_key")
    model = get_setting(db, "gemini_model", "gemini-3.5-flash")
    resp = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": api_key, "content-type": "application/json"},
        json={
            "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"responseMimeType": "application/json"},
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    text = "".join(
        part.get("text", "")
        for part in data["candidates"][0]["content"]["parts"]
    )
    return _extract_json(text)


def _call_openai(db: Session, prompt: str) -> dict:
    api_key = get_setting(db, "openai_api_key")
    model = get_setting(db, "openai_model", "gpt-4o-mini")
    resp = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "content-type": "application/json"},
        json={
            "model": model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            "response_format": {"type": "json_object"},
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    text = data["choices"][0]["message"]["content"]
    return _extract_json(text)


def _template_fallback(niche: str, topic: str) -> dict:
    """No LLM key configured yet -- produce a placeholder script so the rest of the
    pipeline (voice/visuals/assembly) can still be tested end-to-end."""
    subject = topic or (niche or "a strange but true story")
    return {
        "title": f"[DRAFT] {subject[:80]}",
        "description": f"An automatically generated placeholder video about {subject}. "
                        f"Add an Anthropic or OpenAI API key in Settings to generate real scripts.",
        "segments": [
            {"narration": f"Here's something most people don't know about {subject}.",
             "visual_prompt": f"a moody establishing shot related to {subject}"},
            {"narration": "It starts with a detail that seems small, until it doesn't.",
             "visual_prompt": "a close-up detail shot, cinematic lighting"},
            {"narration": "Because once you look closer, the whole picture changes.",
             "visual_prompt": "a wide shot revealing new context, dramatic"},
            {"narration": "And that's the part almost nobody talks about.",
             "visual_prompt": "a symbolic image representing a hidden truth"},
            {"narration": "So next time you hear about this, you'll know the real story.",
             "visual_prompt": "a hopeful, resolving final shot"},
        ],
    }


def generate_script(db: Session, niche: str, topic: str, style_notes: str) -> dict:
    provider = get_setting(db, "llm_provider", "anthropic")
    prompt = _user_prompt(niche, topic, style_notes)

    has_anthropic = bool(get_setting(db, "anthropic_api_key"))
    has_openai = bool(get_setting(db, "openai_api_key"))
    has_gemini = bool(get_setting(db, "gemini_api_key"))

    callers = {"anthropic": _call_anthropic, "openai": _call_openai, "gemini": _call_gemini}
    have = {"anthropic": has_anthropic, "openai": has_openai, "gemini": has_gemini}

    try:
        if provider in callers and have.get(provider):
            return callers[provider](db, prompt)
        # provider preference not configured with a key -- try whichever key exists
        for name, fn in callers.items():
            if have[name]:
                return fn(db, prompt)
    except Exception as e:
        raise RuntimeError(f"Script generation via {provider} failed: {e}")

    return _template_fallback(niche, topic)
