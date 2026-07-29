"""
Thin helper around the Setting table so the rest of the app can do
get_setting("elevenlabs_api_key") instead of touching SQLAlchemy directly.
Values are transparently encrypted/decrypted with app.crypto.
"""
from sqlalchemy.orm import Session
from . import models, crypto

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
    # Jarvis customization
    "jarvis_model": False,          # separate from anthropic_model -- Jarvis favors speed by default
    "jarvis_voice_id": False,       # ElevenLabs voice ID; empty = fall back to browser speech synthesis
    "jarvis_personality": False,    # "butler" | "casual" | "dry_wit" | "hype"
    "jarvis_wake_word": False,      # default "hey jarvis", customizable
    "jarvis_read_aloud": False,     # "true" | "false"
    "jarvis_notifications": False,  # "true" | "false" -- desktop notification when a video job finishes
    "jarvis_accent_color": False,   # hex color for the Jarvis panel's accent/orb
    "jarvis_greeting": False,       # custom greeting shown when the panel opens
}


def get_setting(db: Session, key: str, default: str = "") -> str:
    row = db.get(models.Setting, key)
    if not row or row.value_enc is None:
        return default
    return crypto.decrypt(row.value_enc)


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
