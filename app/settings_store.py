"""
Thin helper around the Setting table so the rest of the app can do
get_setting("elevenlabs_api_key") instead of touching SQLAlchemy directly.
Values are transparently encrypted/decrypted with app.crypto.
"""
import os

from sqlalchemy.orm import Session
from . import models, crypto

# Settings that can also be supplied as environment variables. An env var
# ALWAYS wins over the stored value.
#
# Why this exists: storing secrets encrypted in the database has two failure
# modes that both present as "my keys randomly stopped working" -- if the
# encryption key file is lost, every stored secret becomes undecryptable; and
# if PERSIST_DIR is missing on a deploy, the app quietly points at a different
# folder with a different database. Neither announces itself; the app just
# behaves as though no key was ever entered.
#
# An environment variable has neither problem. It's re-supplied by the host on
# every start, so it cannot be lost to disk or encryption issues.
ENV_OVERRIDES = {
    "anthropic_api_key": "ANTHROPIC_API_KEY",
    "openai_api_key": "OPENAI_API_KEY",
    "gemini_api_key": "GEMINI_API_KEY",
    "elevenlabs_api_key": "ELEVENLABS_API_KEY",
    "stability_api_key": "STABILITY_API_KEY",
    "youtube_client_id": "YOUTUBE_CLIENT_ID",
    "youtube_client_secret": "YOUTUBE_CLIENT_SECRET",
    "tiktok_client_key": "TIKTOK_CLIENT_KEY",
    "tiktok_client_secret": "TIKTOK_CLIENT_SECRET",
    "twilio_account_sid": "TWILIO_ACCOUNT_SID",
    "twilio_auth_token": "TWILIO_AUTH_TOKEN",
}

# Every key the app knows how to store, and whether it should be masked in the UI.
KNOWN_KEYS = {
    "llm_provider": False,          # "anthropic" | "openai"
    "anthropic_api_key": True,
    "anthropic_model": False,       # "claude-sonnet-5" | "claude-haiku-4-5-20251001" | "claude-opus-4-8" etc
    "openai_api_key": True,
    "gemini_api_key": True,
    "elevenlabs_api_key": True,
    "image_provider": False,       # "openai" | "stability" | "gemini" | "placeholder"
    "stability_api_key": True,
    "youtube_client_id": True,
    "youtube_client_secret": True,
    "tiktok_client_key": True,
    "tiktok_client_secret": True,
    "fast_render": False,
    "burn_captions": False,   # "true" burns subtitles in (slow re-encode); off by default
    "lock_enabled": False,          # "true" turns the password gate on
    "lock_password_hash": True,     # PBKDF2 hash -- never the password itself
    "lock_salt": True,
    "lock_session_secret": True,
    "lock_idle_minutes": False,     # auto-lock after this many idle minutes          # "true" skips the Ken Burns pan/zoom -- much cheaper on slow instances

    # Jarvis / WhatsApp
    "twilio_account_sid": True,
    "twilio_auth_token": True,      # also used to verify incoming webhook requests are genuinely from Twilio
    "twilio_whatsapp_number": False,  # e.g. "whatsapp:+14155238886"
    "jarvis_phone_allowlist": False,  # comma-separated E.164 numbers, e.g. "+15551234567"
    # Jarvis / ntfy.sh -- free forever, no account, no card. The topic name
    # is secret-like: on the public server, anyone who knows it can both
    # push to it and read what's sent, so it's the "password" here, not
    # just a label.
    "ntfy_topic": True,
    "jarvis_llm_provider": False,   # "anthropic" | "gemini" -- which LLM answers for Jarvis specifically
    "jarvis_gemini_model": False,   # defaults to gemini-3.5-flash if unset
    "jarvis_voice_id": False,       # ElevenLabs voice id for Jarvis's spoken replies; defaults to DEFAULT_VOICE_ID if unset
    "jarvis_proactive_alerts": False,  # "false" turns off proactive WhatsApp alerts; on by default once Twilio's configured
    "jarvis_alerted_job_ids": False,   # internal: comma-separated job ids already alerted on, so failures aren't re-sent every tick
    "jarvis_alerted_log_ids": False,   # internal: same, for blocked/unauthorized JarvisLog rows
    "jarvis_alerted_published_ids": False,  # internal: same, for successfully-published video jobs

    # Posting schedule (fixed wall-clock slots) -- all non-secret so they're
    # readable/verifiable in the settings view.
    "schedule_mode": False,                 # "slots" enables the fixed-time schedule; "" = old per-channel spacing
    "post_timezone": False,                 # IANA tz for the slot times, e.g. "America/Denver"
    "post_schedule_times": False,           # comma-separated HH:MM local times
    "schedule_shorts_channel_id": False,    # channel that gets the shorts slots
    "schedule_longform_channel_id": False,  # channel that gets the one daily long-form slot
    "min_hours_between_videos": False,       # floor on spacing for the old per-channel mode
    "schedule_shorts_only": False,          # "true" = every slot is a short; long-form never runs (also disables the old per-channel long-form quota)
}


def get_setting(db: Session, key: str, default: str = "") -> str:
    # Environment variable wins -- it can't be lost to a disk or
    # encryption-key problem, unlike the stored copy.
    env_name = ENV_OVERRIDES.get(key)
    if env_name:
        env_val = os.environ.get(env_name, "").strip()
        if env_val:
            return env_val

    row = db.get(models.Setting, key)
    if not row or row.value_enc is None:
        return default
    # decrypt() returns None when the encryption key has changed since this
    # value was saved. Treat that as "not set" so the app degrades to its
    # normal no-key behaviour (e.g. fall back to the browser voice) instead
    # of handing None to code that expects a string.
    value = crypto.decrypt(row.value_enc)
    return default if value is None else value


def set_setting(db: Session, key: str, value: str, is_secret: bool = None):
    if is_secret is None:
        is_secret = KNOWN_KEYS.get(key, True)
    row = db.get(models.Setting, key)
    enc = crypto.encrypt(value) if value else None
    if row:
        row.value_enc = enc
        row.is_secret = is_secret
    else:
        row = models.Setting(key=key, value_enc=enc, is_secret=is_secret)
        db.add(row)
    db.commit()


def storage_health(db: Session) -> dict:
    """Whether stored secrets are actually readable, and which keys are coming
    from environment variables. Surfaced in the UI so a broken store is
    obvious instead of silently behaving like nothing was ever entered."""
    from .config import DATA_DIR

    unreadable = []
    for key, is_secret in KNOWN_KEYS.items():
        if not is_secret:
            continue
        row = db.get(models.Setting, key)
        if row and row.value_enc and crypto.decrypt(row.value_enc) is None:
            unreadable.append(key)

    from_env = [k for k, envname in ENV_OVERRIDES.items() if os.environ.get(envname, "").strip()]
    return {
        "unreadable_keys": unreadable,
        "keys_from_env": from_env,
        "persist_dir_set": bool(os.environ.get("PERSIST_DIR")),
        "secret_key_set": bool(os.environ.get("SECRET_KEY")),
        "data_dir": str(DATA_DIR),
    }


def all_settings_masked(db: Session) -> dict:
    """Return every known setting, with secret values masked for display in the UI."""
    out = {}
    for key, is_secret in KNOWN_KEYS.items():
        val = get_setting(db, key)
        if not val:
            out[key] = {"set": False, "value": ""}
        elif is_secret:
            out[key] = {"set": True, "value": "•" * 8 + val[-4:] if len(val) > 4 else "••••"}
        else:
            out[key] = {"set": True, "value": val}
    return out
