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
    auto_publish_scheduled = Column(Boolean, default=True)

    youtube_connected = Column(Boolean, default=False)
    youtube_channel_title = Column(String, default="")
    youtube_refresh_token_enc = Column(Text, nullable=True)
    # "public" | "unlisted" | "private" -- what privacyStatus new uploads get.
    # Default public because that's what auto-posting a finished video is for.
    # NOTE (real limitation, not a code bug): while the Google OAuth app is in
    # "Testing"/unverified state for the youtube.upload restricted scope,
    # Google FORCES every upload to private regardless of what we request
    # here. Getting genuinely-public auto-uploads requires passing Google's
    # app verification. This setting is still honored the moment that's done.
    youtube_privacy = Column(String, default="public")

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
    extended = Column(Boolean, default=False)   # longform only: True = the extended 6-10 min variant
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


class ComputerTask(Base):
    """One command Jarvis wants run on the user's own computer, via the local
    companion agent (see local_agent.py, run on that machine). The cloud app
    has no direct access to the user's desktop -- this table is the queue the
    companion polls, so a command created here (by Jarvis's tool call) can be
    picked up, executed, and its result reported back, all over plain HTTPS
    with no inbound port ever opened on the user's machine.

    'awaiting_confirmation' is the safety gate for anything judged risky --
    it never reaches 'queued' (and so is never seen by the companion) until
    the user explicitly confirms in chat."""
    __tablename__ = "computer_tasks"

    id = Column(String, primary_key=True, default=gen_id)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    command = Column(Text, nullable=False)
    reason = Column(Text, default="")             # why Jarvis wants to run it, shown to the user
    risky = Column(Boolean, default=False)
    status = Column(String, default="awaiting_confirmation")
    # "awaiting_confirmation" | "queued" | "running" | "done" | "error" | "cancelled"
    stdout = Column(Text, default="")
    stderr = Column(Text, default="")
    exit_code = Column(Integer, nullable=True)


class DeployTask(Base):
    """One website code change Jarvis wants to ship -- ALWAYS confirm-gated
    (unlike ComputerTask, there's no 'safe, run it now' branch: pushing to the
    live, revenue-generating site is never treated as routine). Jarvis writes
    the file(s) via its existing write_project_file tool first, then proposes
    a deploy here; nothing reaches git or the live site until the user
    confirms in chat."""
    __tablename__ = "deploy_tasks"

    id = Column(String, primary_key=True, default=gen_id)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    summary = Column(Text, default="")            # what changed / why, shown to the user
    status = Column(String, default="awaiting_confirmation")
    # "awaiting_confirmation" | "done" | "error" | "cancelled"
    output = Column(Text, default="")             # git/deploy output, or the error


class Prospect(Base):
    """One business the user is trying to sell AI automation services to.
    The 'auto contactor' business-development pipeline: add a prospect, get
    an AI-drafted outreach email personalized with the user's own pitch
    (settings_store's 'business_pitch'), open it ready-to-send in the user's
    own email client (a mailto: link -- the actual send is always their
    click, same reasoning as everywhere else this app touches messaging),
    then when they reply, paste that reply in and get an AI-drafted response
    the same way. Nothing here ever sends anything itself."""
    __tablename__ = "prospects"

    id = Column(String, primary_key=True, default=gen_id)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    business_name = Column(String, nullable=False)
    contact_name = Column(String, default="")
    contact_email = Column(String, default="")
    phone = Column(String, default="")
    website = Column(String, default="")
    notes = Column(Text, default="")
    status = Column(String, default="new")
    # "new" | "drafted" | "contacted" | "replied" | "won" | "lost"
    draft_subject = Column(Text, default="")      # most recent AI-drafted outreach email
    draft_body = Column(Text, default="")
    last_reply_text = Column(Text, default="")    # what the prospect wrote back (pasted in by the user)
    response_draft = Column(Text, default="")     # AI's suggested reply to that
    contacted_at = Column(DateTime, nullable=True)
