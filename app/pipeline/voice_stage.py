"""
Stage 2: narrate each script segment with ElevenLabs. Each segment gets its
own mp3 so downstream stages know exactly how long that segment's visual
needs to be on screen (no guessing/alignment needed).

Without an ElevenLabs key configured, falls back to generating silence of an
estimated duration (based on words-per-minute) so the pipeline still runs
end-to-end for testing.
"""
from pathlib import Path
import requests

from ..settings_store import get_setting
from ..config import WORDS_PER_MINUTE
from .ffmpeg_utils import make_silence, probe_duration

DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"  # ElevenLabs' public "Rachel" voice, used if a channel has none set


def _estimate_duration(text: str) -> float:
    words = max(len(text.split()), 1)
    return max((words / WORDS_PER_MINUTE) * 60.0, 1.2)


def narrate_segment(db, text: str, voice_id: str, out_path: Path) -> float:
    api_key = get_setting(db, "elevenlabs_api_key")
    if not api_key:
        make_silence(out_path, _estimate_duration(text))
        return probe_duration(out_path)

    voice = voice_id or DEFAULT_VOICE_ID
    resp = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice}",
        headers={"xi-api-key": api_key, "content-type": "application/json", "accept": "audio/mpeg"},
        json={
            "text": text,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {"stability": 0.45, "similarity_boost": 0.8},
        },
        timeout=60,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"ElevenLabs TTS failed ({resp.status_code}): {resp.text[:500]}")
    out_path.write_bytes(resp.content)
    return probe_duration(out_path)


def list_voices(db) -> list[dict]:
    """Used by the Settings/Channels UI to let you pick a voice by name instead of raw ID."""
    api_key = get_setting(db, "elevenlabs_api_key")
    if not api_key:
        return []
    resp = requests.get(
        "https://api.elevenlabs.io/v1/voices",
        headers={"xi-api-key": api_key},
        timeout=30,
    )
    resp.raise_for_status()
    return [{"voice_id": v["voice_id"], "name": v["name"]} for v in resp.json().get("voices", [])]
