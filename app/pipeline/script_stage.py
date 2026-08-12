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
import logging
import re
import textwrap
from sqlalchemy.orm import Session

import requests

from ..settings_store import get_setting

log = logging.getLogger("script_stage")

SYSTEM_PROMPT = textwrap.dedent("""
    You write short-form narration scripts for a faceless YouTube/TikTok channel.
    Given a channel niche and (optionally) a specific topic, produce a punchy,
    original script split into narration segments, targeting 45-55 seconds of
    spoken narration in total -- both ends matter: under a minute so it stays
    short-form, but NOT so short it feels like it cuts off early. A finished
    video under ~30 seconds is a failure here, not just "extra brevity."

    Rules:
    - The content must be YOUR/the channel's original narration and framing, not a
      copy of someone else's article or a plain list of facts with zero commentary --
      YouTube's monetization policy demotes low-effort/templated/reused content, so
      always add a clear point of view, a hook, and a wrap-up thought.
    - 6 to 8 segments. Each segment is exactly ONE sentence of narration, roughly
      10-18 words long (not "as short as possible" -- a segment averaging
      under 8 words is why past scripts ended up half the intended length).
      Vary segment length naturally rather than making every line clipped to
      the same terse size, and don't over-invest in the opening line at the
      expense of the rest -- a hook that's disproportionately longer/heavier
      than everything after it makes the video feel front-loaded.
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
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        # The usual cause is a response cut off mid-string, which produces an
        # "Unterminated string" error and previously killed the whole video.
        # A truncated script is still mostly usable: salvage every complete
        # segment and drop the partial one, rather than throwing away good
        # work over the last few words.
        salvaged = _salvage_truncated(text)
        if salvaged and salvaged.get("segments"):
            return salvaged
        raise ValueError(
            f"The script came back malformed and couldn't be repaired ({e}). "
            "Retrying usually fixes this."
        ) from e


def _salvage_truncated(text: str) -> dict | None:
    """Recover what we can from a JSON object that was cut off mid-way.

    Pulls out the title/description if present, then every fully-formed
    {"narration": ..., "visual_prompt": ...} object, ignoring a trailing
    partial one. Returns None if there's nothing usable.
    """
    try:
        title_m = re.search(r'"title"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
        desc_m = re.search(r'"description"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
        seg_pattern = re.compile(
            r'\{\s*"narration"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"visual_prompt"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}'
        )
        segments = [
            {"narration": _unescape(n), "visual_prompt": _unescape(v)}
            for n, v in seg_pattern.findall(text)
        ]
        if not segments:
            return None
        return {
            "title": _unescape(title_m.group(1)) if title_m else "",
            "description": _unescape(desc_m.group(1)) if desc_m else "",
            "segments": segments,
        }
    except re.error:
        return None


def _unescape(s: str) -> str:
    return s.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")


def _call_anthropic(db: Session, prompt: str) -> dict:
    api_key = get_setting(db, "anthropic_api_key")
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
            # A 9-10 segment script carries narration + a visual prompt for
            # every segment plus a title and description. At 1500 the response
            # ran out of room mid-string, and the only symptom was a cryptic
            # "Unterminated string at line 34" from the JSON parser -- the
            # script was fine, it just got cut off. 4000 leaves real headroom.
            "max_tokens": 4000,
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=90,
    )
    resp.raise_for_status()
    data = resp.json()

    # If the model stopped because it hit the ceiling, say THAT rather than
    # letting it surface as an inscrutable JSON syntax error downstream.
    if data.get("stop_reason") == "max_tokens":
        raise ValueError(
            "The script was cut off before it finished (hit the response length limit). "
            "Try a shorter video or fewer segments."
        )

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

    def _pick():
        if provider in callers and have.get(provider):
            return provider, callers[provider]
        for name, fn in callers.items():
            if have[name]:
                return name, fn
        return None, None

    name, fn = _pick()
    if fn is None:
        return _template_fallback(niche, topic)

    # A malformed/truncated response is transient -- the same prompt usually
    # comes back clean on a second attempt. Retrying here, inside the stage,
    # means a hiccup costs a few seconds instead of failing the whole video
    # and needing a manual retry later.
    last_error = None
    for attempt in range(3):
        try:
            return fn(db, prompt)
        except ValueError as e:
            # Raised by _extract_json / the max_tokens check -- specifically
            # the recoverable "response came back unusable" class.
            last_error = e
            log.warning("Script attempt %d/3 via %s returned an unusable response: %s",
                        attempt + 1, name, e)
            continue
        except Exception as e:
            raise RuntimeError(f"Script generation via {name} failed: {e}")

    raise RuntimeError(
        f"Script generation via {name} failed after 3 attempts -- the response kept coming back "
        f"unusable. Last error: {last_error}"
    )
