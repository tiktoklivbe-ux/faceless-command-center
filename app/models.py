import enum
import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text, Boolean, DateTime, ForeignKey, Enum, Integer, Float
from sqlalchemy.orm import relationship

from .database import Base


def gen_id() -> str:
    return uuid.uuid4().hex[:12]


class JobStatus(str, enum.Enum):
    QUEUED = "queued"
    SCRIPT = "generating_script"
    VOICE = "generating_voice"
    VISUALS = "generating_visuals"
    CAPTIONS = "generating_captions"
    ASSEMBLING = "assembling"
    READY = "ready_for_review"
    PUBLISHING = "publishing"
    PUBLISHED = "published"
    FAILED = "failed"


class Channel(Base):
    __tablename__ = "channels"

    id = Column(String, primary_key=True, default=gen_id)
    name = Column(String, nullable=False)
    niche = Column(Text, default="")           # e.g. "creepy true-crime style short stories"
    style_notes = Column(Text, default="")      # extra instructions for the script writer
    voice_id = Column(String, default="")       # ElevenLabs voice ID
    visual_style = Column(Text, default="")     # image-gen style prompt suffix

    # Chronos automation: when enabled, the scheduler creates ~auto_per_day
    # SHORT videos for this channel, spaced evenly across each 24h day, plus
    # up to auto_longform_per_day long-form (5-7 min, horizontal) videos --
    # a separate quota/cadence because they're a genuinely different kind of
    # video (see VideoJob.kind), not just a longer short. TikTok never gets
    # long-form uploads (see orchestrator._publish) -- a 5-7 minute video
    # doesn't fit that platform.
    auto_enabled = Column(Boolean, default=False)
    auto_per_day = Column(Integer, default=3)
    auto_longform_per_day = Column(Integer, default=0)
    auto_publish_scheduled = Column(Boolean, default=False)

    youtube_connected = Column(Boolean, default=False)
    youtube_channel_title = Column(String, default="")
    youtube_refresh_token_enc = Column(Text, nullable=True)

    tiktok_connected = Column(Boolean, default=False)
    tiktok_display_name = Column(String, default="")
    tiktok_refresh_token_enc = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    jobs = relationship("VideoJob", back_populates="channel", cascade="all, delete-orphan")


class VideoJob(Base):
    __tablename__ = "video_jobs"

    id = Column(String, primary_key=True, default=gen_id)
    channel_id = Column(String, ForeignKey("channels.id"), nullable=False)
    topic = Column(Text, default="")            # blank = let the model pick a topic for the niche
    kind = Column(String, default="short")      # "short" (vertical, <60s) | "longform" (horizontal, 5-7min)
    status = Column(Enum(JobStatus), default=JobStatus.QUEUED)
    stage_log = Column(Text, default="")        # newline-separated human-readable progress log
    agent_status = Column(Text, default="{}")   # JSON dict: {"script": "running", "voice": "done", ...}
    error_message = Column(Text, default="")

    title = Column(Text, default="")
    description = Column(Text, default="")
    script_text = Column(Text, default="")

    audio_path = Column(String, nullable=True)
    video_path = Column(String, nullable=True)
    captions_path = Column(String, nullable=True)

    auto_publish = Column(Boolean, default=False)
    youtube_video_id = Column(String, nullable=True)
    tiktok_publish_id = Column(String, nullable=True)

    # The OS process ID of the `python -m app.worker` process actually doing
    # the rendering (see orchestrator.dispatch_job). Cancel used to only flip
    # this row's status to FAILED and free the render slot -- it never
    # touched the real process, which kept running in the background,
    # completed its stages anyway, and overwrote the "cancelled" status back
    # to normal as it went. This is what cancel actually kills now.
    worker_pid = Column(Integer, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    channel = relationship("Channel", back_populates="jobs")


class Setting(Base):
    """Generic encrypted key/value store for API keys and app-wide config."""
    __tablename__ = "settings"

    key = Column(String, primary_key=True)
    value_enc = Column(Text, nullable=True)
    is_secret = Column(Boolean, default=True)


class JarvisLog(Base):
    """Full audit trail of every action Jarvis takes or attempts.

    This exists specifically so an unattended assistant is never a black
    box: every tool call it makes -- allowed or blocked -- gets a permanent,
    reviewable row. `allowed` distinguishes "Jarvis tried this and the
    whitelist let it through" from "Jarvis tried this and was refused" --
    both are worth keeping, since a pattern of blocked attempts (e.g. it
    keeps trying something outside its allowed categories) is itself a
    signal worth seeing.
    """
    __tablename__ = "jarvis_log"

    id = Column(String, primary_key=True, default=gen_id)
    created_at = Column(DateTime, default=datetime.utcnow)
    source = Column(String, default="app")       # "app" | "sms" | "whatsapp" | "imessage"
    action = Column(String, nullable=False)       # tool name, e.g. "retry_job"
    params = Column(Text, default="{}")           # JSON of what it was called with
    allowed = Column(Boolean, default=True)       # False = whitelist blocked it
    result = Column(Text, default="")             # what happened / why it was blocked
    user_message = Column(Text, default="")       # the request that triggered this, for context
