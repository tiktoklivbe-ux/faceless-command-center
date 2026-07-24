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
    auto_publish_scheduled: bool = False


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
    auto_publish: bool = False


class JobOut(BaseModel):
    id: str
    channel_id: str
    topic: str
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
    openai_api_key: Optional[str] = None
    gemini_api_key: Optional[str] = None
    elevenlabs_api_key: Optional[str] = None
    image_provider: Optional[str] = None
    stability_api_key: Optional[str] = None
    youtube_client_id: Optional[str] = None
    youtube_client_secret: Optional[str] = None
    tiktok_client_key: Optional[str] = None
    tiktok_client_secret: Optional[str] = None
