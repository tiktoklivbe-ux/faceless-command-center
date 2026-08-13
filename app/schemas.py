from typing import Optional
from datetime import datetime
from pydantic import BaseModel


class ChannelIn(BaseModel):
    name: str
    niche: str = ""
    style_notes: str = ""
    voice_id: str = ""
    visual_style: str = ""
    auto_enabled: bool = False
    auto_per_day: int = 3
    auto_longform_per_day: int = 0
    auto_publish_scheduled: bool = True
    youtube_privacy: str = "public"


class ChannelOut(ChannelIn):
    id: str
    youtube_connected: bool = False
    youtube_channel_title: str = ""
    tiktok_connected: bool = False
    tiktok_display_name: str = ""

    class Config:
        from_attributes = True


class JobCreate(BaseModel):
    channel_id: str
    topic: str = ""
    kind: str = "short"  # "short" | "longform"
    auto_publish: bool = False


class JobOut(BaseModel):
    id: str
    channel_id: str
    topic: str
    kind: str = "short"
    status: str
    stage_log: str
    agent_status: str = "{}"
    error_message: str
    title: str
    description: str
    script_text: str
    audio_path: Optional[str] = None
    video_path: Optional[str] = None
    captions_path: Optional[str] = None
    auto_publish: bool
    youtube_video_id: Optional[str] = None
    tiktok_publish_id: Optional[str] = None
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class SettingsIn(BaseModel):
    llm_provider: Optional[str] = None
    anthropic_api_key: Optional[str] = None
    anthropic_model: Optional[str] = None
    openai_api_key: Optional[str] = None
    gemini_api_key: Optional[str] = None
    elevenlabs_api_key: Optional[str] = None
    image_provider: Optional[str] = None
    stability_api_key: Optional[str] = None
    youtube_client_id: Optional[str] = None
    youtube_client_secret: Optional[str] = None
    tiktok_client_key: Optional[str] = None
    tiktok_client_secret: Optional[str] = None
    fast_render: Optional[str] = None
    # Jarvis / WhatsApp -- these were missing entirely, which meant every
    # field under Settings > Jarvis silently failed to save: Pydantic drops
    # unknown fields from a request body by default instead of erroring, so
    # POSTing them here was a no-op with no visible failure anywhere.
    twilio_account_sid: Optional[str] = None
    twilio_auth_token: Optional[str] = None
    twilio_whatsapp_number: Optional[str] = None
    jarvis_phone_allowlist: Optional[str] = None
    jarvis_llm_provider: Optional[str] = None
    jarvis_gemini_model: Optional[str] = None
    jarvis_voice_id: Optional[str] = None
    jarvis_proactive_alerts: Optional[str] = None
    ntfy_topic: Optional[str] = None
    # Posting schedule (fixed wall-clock slots). See scheduler._slot_schedule_due.
    schedule_mode: Optional[str] = None                 # "slots" to enable, "" for the old per-channel spacing
    post_timezone: Optional[str] = None                 # IANA tz, e.g. "America/Denver"
    post_schedule_times: Optional[str] = None           # comma-separated HH:MM, e.g. "03:00,08:00,12:00,17:00,22:00"
    schedule_shorts_channel_id: Optional[str] = None
    schedule_longform_channel_id: Optional[str] = None
    min_hours_between_videos: Optional[str] = None
