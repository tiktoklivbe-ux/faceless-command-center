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
    # videos for this channel, spaced evenly across each 24h day.
    auto_enabled = Column(Boolean, default=False)
    auto_per_day = Column(Integer, default=3)
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

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    channel = relationship("Channel", back_populates="jobs")


class Setting(Base):
    """Generic encrypted key/value store for API keys and app-wide config."""
    __tablename__ = "settings"

    key = Column(String, primary_key=True)
    value_enc = Column(Text, nullable=True)
    is_secret = Column(Boolean, default=True)


class SmsThread(Base):
    """Short rolling conversation history per phone number, for the texting
    version of Jarvis (see app/routers/jarvis.py's /sms webhook). Kept
    separate from the in-app chat's history (which lives client-side) since
    a phone number has no browser session to hold it in."""
    __tablename__ = "sms_threads"

    phone = Column(String, primary_key=True)
    history_json = Column(Text, default="[]")  # list of {"role","content"}, trimmed to last ~10
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class AgentCommand(Base):
    """A queued action for the local Jarvis Agent (a separate script that
    runs on the user's own computer, outside this web app -- see
    app/routers/agent.py and the jarvis_agent.py file given to the user).
    This app has zero direct connection to anyone's physical computer, so
    'computer control' works as a command queue: Jarvis (this server)
    writes a row here, the local agent polls for pending rows and executes
    them, then reports the result back.

    Deliberately a small, fixed action vocabulary (see ALLOWED_ACTIONS in
    app/routers/agent.py) rather than arbitrary code execution -- that's a
    real safety boundary, not an oversight.
    """
    __tablename__ = "agent_commands"

    id = Column(String, primary_key=True, default=gen_id)
    action = Column(String, nullable=False)       # "open_app" | "type_text" | "click_at" | "press_keys"
    params_json = Column(Text, default="{}")
    status = Column(String, default="pending")     # "pending" | "sent" | "done" | "failed"
    result_json = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class VoicePrint(Base):
    """A rough, approximate voice fingerprint for the app's one owner
    (single row, id='owner' -- this app has one primary user, not a
    multi-user auth system). Built from pitch statistics only (average,
    min, max fundamental frequency), NOT a real biometric speaker-embedding
    model. Good enough for a fun 'is this probably Tom or a guest' gate,
    not real security. Updates via a slow exponential moving average each
    time a confirmed-match sample comes in, so it adapts gradually to
    natural voice variation (tired, sick, etc.) instead of overwriting
    outright or staying frozen at the first enrollment."""
    __tablename__ = "voiceprints"

    id = Column(String, primary_key=True, default="owner")
    avg_pitch = Column(Float, nullable=True)
    min_pitch = Column(Float, nullable=True)
    max_pitch = Column(Float, nullable=True)
    sample_count = Column(Integer, default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
