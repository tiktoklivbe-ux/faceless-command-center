"""
Jarvis's tool whitelist -- app management (Phase 1), plus a bounded terminal
command whitelist and a read-only web fetch (Phase 4).

This is the actual safety mechanism, not a suggestion Jarvis is asked to
follow. Jarvis talks to Claude with tool-use enabled, and Claude is ONLY
ever given the tool definitions listed in `TOOLS` below -- there is no
other way for it to affect anything. It cannot browse the filesystem, run
an arbitrary shell command, touch a file, or do anything at all outside of
literally calling one of these named Python functions with the exact
arguments they accept. Expanding what Jarvis can do means adding a new
function here, deliberately, not something that emerges from a clever
prompt.

Every call (allowed or refused) is written to JarvisLog by the caller
(see routers/jarvis.py) -- this module only implements what each tool
actually does once permitted.
"""
import ipaddress
import json
import os
import re
import socket
import subprocess
from datetime import datetime, timedelta
from urllib.parse import urlparse

import requests

from . import config, models, render_gate
from .pipeline import ffmpeg_utils, orchestrator

# ---------------------------------------------------------------- tool schemas
# Anthropic tool-use format. Keep descriptions honest and specific -- a vague
# description invites the model to reach for a tool in the wrong situation.
TOOLS = [
    {
        "name": "list_jobs",
        "description": "List recent video jobs with their status. Use this to answer "
                        "'how's it going', 'what's running', 'any failures', etc.",
        "input_schema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "description": "Optional filter: queued, "
                           "generating_script, generating_voice, generating_visuals, "
                           "assembling, publishing, ready_for_review, published, failed"},
                "limit": {"type": "integer", "description": "Max jobs to return, default 10"},
            },
        },
    },
    {
        "name": "get_job_status",
        "description": "Get full detail on one specific video job, including its error "
                        "message if it failed and the tail of its progress log.",
        "input_schema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
        },
    },
    {
        "name": "retry_job",
        "description": "Re-queue a FAILED job so it renders again. Only works on jobs "
                        "that are actually in the failed state.",
        "input_schema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
        },
    },
    {
        "name": "cancel_job",
        "description": "Stop a job that's currently running (kills the real render "
                        "process, not just a status flag) and frees the render slot.",
        "input_schema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
        },
    },
    {
        "name": "make_video",
        "description": "Start generating a new video right now for a channel.",
        "input_schema": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "topic": {"type": "string", "description": "Optional specific topic; "
                          "leave blank to let the script agent pick one for the niche"},
            },
            "required": ["channel_id"],
        },
    },
    {
        "name": "list_channels",
        "description": "List all channels with their niche, automation settings, and "
                        "whether YouTube/TikTok are connected.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "set_channel_automation",
        "description": "Turn Chronos auto-generation on/off for a channel, change how "
                        "many videos per day, or toggle auto-publish.",
        "input_schema": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "auto_enabled": {"type": "boolean"},
                "auto_per_day": {"type": "integer"},
                "auto_publish_scheduled": {"type": "boolean"},
            },
            "required": ["channel_id"],
        },
    },
    {
        "name": "list_available_commands",
        "description": "List the pre-approved terminal commands Jarvis is allowed to run "
                        "(a fixed, named whitelist -- Jarvis cannot construct or run any "
                        "other command line).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "run_whitelisted_command",
        "description": "Run one of the pre-approved commands from list_available_commands, "
                        "by its label. This is the ONLY way Jarvis can execute anything on "
                        "the server -- it cannot run arbitrary shell input.",
        "input_schema": {
            "type": "object",
            "properties": {"label": {"type": "string"}},
            "required": ["label"],
        },
    },
    {
        "name": "fetch_url",
        "description": "Read-only fetch of a public web page's text content, for research/"
                        "lookups. Cannot submit forms, log in, or take any action on the "
                        "page -- read-only, and blocked from reaching internal/private "
                        "network addresses.",
        "input_schema": {
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"],
        },
    },
    {
        "name": "list_project_files",
        "description": "List files and folders at a path inside this app's own project "
                        "folder (e.g. '', 'app', 'storage/jobs'). Cannot see or list "
                        "anything outside this project.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Relative to the project root; leave blank for the root."}},
        },
    },
    {
        "name": "read_project_file",
        "description": "Read a text file's contents from inside this app's project folder. "
                        "Refuses binary files and anything outside the project.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "write_project_file",
        "description": "Create or overwrite a text file inside this app's project folder "
                        "(e.g. dropping a note, a small script, a config tweak). Cannot "
                        "write outside the project, and refuses to touch .env or anything "
                        "under storage/ (job data) or the database file.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
]

TOOL_NAMES = {t["name"] for t in TOOLS}

# ---------------------------------------------------------------- terminal whitelist
# A fixed, named set of commands -- Jarvis can only ever pick one of these
# BY LABEL. It never sees or constructs the actual command line, so there's
# no prompt-injection path that turns "check disk space" into something
# else. All read-only/diagnostic, scoped to this project's own folder.
SAFE_COMMANDS: dict[str, dict] = {
    "disk_usage": {
        "description": "How much space the video storage folder is using.",
        "cmd": [
            "python", "-c",
            "import shutil; from pathlib import Path; "
            "u = shutil.disk_usage('.'); "
            "print(f'Disk: {u.used/1e9:.1f}GB used / {u.total/1e9:.1f}GB total, {u.free/1e9:.1f}GB free')",
        ],
    },
    "job_folder_count": {
        "description": "How many per-job render folders exist in storage/jobs.",
        "cmd": [
            "python", "-c",
            "from pathlib import Path; p = Path('storage/jobs'); "
            "print(f'{len(list(p.iterdir())) if p.exists() else 0} job folders')",
        ],
    },
    "python_processes": {
        "description": "List running Python processes (to spot a stuck/duplicate render worker).",
        "cmd": (["ps", "-eo", "pid,etimes,comm"] if os.name == "posix"
                else ["tasklist", "/v", "/fi", "imagename eq python.exe"]),
    },
}


def list_available_commands(db):
    return {"commands": [{"label": k, "description": v["description"]} for k, v in SAFE_COMMANDS.items()]}


def run_whitelisted_command(db, label):
    entry = SAFE_COMMANDS.get(label)
    if not entry:
        return {"error": f"'{label}' isn't a pre-approved command. Call list_available_commands to see valid labels."}
    try:
        result = subprocess.run(
            entry["cmd"], cwd=str(config.BASE_DIR), timeout=20,
            capture_output=True, text=True,
        )
        return {
            "ok": result.returncode == 0,
            "output": (result.stdout or result.stderr or "(no output)")[-2000:],
        }
    except subprocess.TimeoutExpired:
        return {"error": "That command took too long and was stopped."}
    except Exception as e:
        return {"error": f"Couldn't run it: {e}"}


# ---------------------------------------------------------------- read-only web fetch
_BLOCKED_HOSTS = {"localhost", "metadata.google.internal"}


def _is_safe_public_host(hostname: str) -> bool:
    """Refuses to fetch anything that resolves to a private/internal/link-local
    address. Without this, a "read-only web research" tool driven by an LLM
    is a textbook SSRF path -- it could just as easily be asked to fetch
    http://169.254.169.254/ (the cloud metadata endpoint most hosts expose)
    or http://localhost:8000/api/settings as "research a URL"."""
    if not hostname or hostname.lower() in _BLOCKED_HOSTS:
        return False
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


def fetch_url(db, url):
    parsed = urlparse(url if "://" in url else f"https://{url}")
    if parsed.scheme not in ("http", "https"):
        return {"error": "Only http/https URLs are allowed."}
    if not _is_safe_public_host(parsed.hostname):
        return {"error": "That address isn't reachable -- internal/private/local addresses are blocked."}
    try:
        resp = requests.get(
            url, timeout=10, headers={"User-Agent": "Mozilla/5.0 (Jarvis research fetch)"},
            allow_redirects=True,
        )
    except requests.RequestException as e:
        return {"error": f"Couldn't fetch that: {e}"}
    # Re-check the FINAL address after redirects -- a safe URL can redirect
    # to an unsafe one, and the check above only saw the original.
    final_host = urlparse(resp.url).hostname
    if not _is_safe_public_host(final_host):
        return {"error": "That URL redirected to a blocked internal/private address."}

    text = re.sub(r"<[^>]+>", " ", resp.text)
    text = re.sub(r"\s+", " ", text).strip()
    return {"url": resp.url, "text": text[:4000]}


# ---------------------------------------------------------------- project file ops
# The category the user actually asked to be able to use ("file ops within
# the project folder") when Jarvis's boundaries were first scoped -- every
# path here is resolved and then checked to still be inside BASE_DIR, which
# is what actually stops ".." (or an absolute path) from escaping the
# project, not just string-prefix matching on the input.
_WRITE_BLOCKED_PARTS = {"storage", ".env", ".git"}
_DB_SUFFIXES = {".db", ".sqlite", ".sqlite3"}


def _resolve_in_project(rel_path: str):
    rel_path = (rel_path or "").strip().lstrip("/\\")
    target = (config.BASE_DIR / rel_path).resolve()
    try:
        target.relative_to(config.BASE_DIR.resolve())
    except ValueError:
        return None
    return target


def list_project_files(db, path=""):
    target = _resolve_in_project(path)
    if target is None:
        return {"error": "That path is outside the project folder."}
    if not target.exists():
        return {"error": "No such path in the project."}
    if target.is_file():
        return {"error": "That's a file, not a folder -- use read_project_file."}
    entries = []
    for p in sorted(target.iterdir()):
        entries.append({"name": p.name, "type": "dir" if p.is_dir() else "file",
                         "size": p.stat().st_size if p.is_file() else None})
    return {"path": str(target.relative_to(config.BASE_DIR.resolve())) or ".", "entries": entries[:200]}


def read_project_file(db, path):
    target = _resolve_in_project(path)
    if target is None:
        return {"error": "That path is outside the project folder."}
    if not target.is_file():
        return {"error": "No such file in the project."}
    if target.suffix.lower() in _DB_SUFFIXES:
        return {"error": "Refusing to read a database file."}
    try:
        text = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return {"error": "That looks like a binary file -- can't read it as text."}
    return {"path": str(target.relative_to(config.BASE_DIR.resolve())), "content": text[:8000]}


def write_project_file(db, path, content):
    target = _resolve_in_project(path)
    if target is None:
        return {"error": "That path is outside the project folder."}
    rel_parts = target.relative_to(config.BASE_DIR.resolve()).parts
    if not rel_parts or rel_parts[0] in _WRITE_BLOCKED_PARTS or target.suffix.lower() in _DB_SUFFIXES:
        return {"error": "Refusing to write there -- job data, secrets, and the database are off-limits."}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return {"ok": True, "path": str(target.relative_to(config.BASE_DIR.resolve())), "bytes_written": len(content.encode("utf-8"))}


def _job_summary(j: models.VideoJob) -> dict:
    return {
        "id": j.id, "status": j.status.value, "title": j.title or "(untitled)",
        "topic": j.topic or "", "channel": j.channel.name if j.channel else "?",
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "error": j.error_message or None,
    }


def list_jobs(db, status=None, limit=10):
    q = db.query(models.VideoJob).order_by(models.VideoJob.created_at.desc())
    if status:
        try:
            q = q.filter(models.VideoJob.status == models.JobStatus(status))
        except ValueError:
            return {"error": f"'{status}' isn't a real job status."}
    jobs = q.limit(min(int(limit or 10), 30)).all()
    return {"jobs": [_job_summary(j) for j in jobs]}


def get_job_status(db, job_id):
    j = db.get(models.VideoJob, job_id)
    if not j:
        return {"error": "No job with that ID."}
    out = _job_summary(j)
    out["log_tail"] = "\n".join((j.stage_log or "").strip().splitlines()[-10:])
    return out


def retry_job(db, job_id):
    j = db.get(models.VideoJob, job_id)
    if not j:
        return {"error": "No job with that ID."}
    if j.status != models.JobStatus.FAILED:
        return {"error": f"That job is '{j.status.value}', not failed -- nothing to retry."}
    j.status = models.JobStatus.QUEUED
    j.error_message = ""
    j.stage_log = (j.stage_log or "") + "\n[jarvis] Re-queued on request.\n"
    db.commit()
    return {"ok": True, "job_id": job_id, "new_status": "queued"}


def cancel_job(db, job_id):
    j = db.get(models.VideoJob, job_id)
    if not j:
        return {"error": "No job with that ID."}
    if j.status in (models.JobStatus.PUBLISHED, models.JobStatus.READY, models.JobStatus.FAILED):
        return {"error": f"That job isn't running (status: {j.status.value})."}
    killed = ffmpeg_utils.kill_worker_by_pid(j.worker_pid)
    render_gate.release(job_id)
    try:
        agents = json.loads(j.agent_status or "{}")
        j.agent_status = json.dumps({k: ("idle" if v == "running" else v) for k, v in agents.items()})
    except Exception:
        pass
    j.status = models.JobStatus.FAILED
    j.error_message = "Cancelled by Jarvis."
    j.stage_log = (j.stage_log or "") + "\n[jarvis] Cancelled on request.\n"
    db.commit()
    return {"ok": True, "job_id": job_id, "worker_killed": killed}


def make_video(db, channel_id, topic=""):
    channel = db.get(models.Channel, channel_id)
    if not channel:
        return {"error": "No channel with that ID."}
    job = models.VideoJob(channel_id=channel.id, topic=topic or "", auto_publish=False)
    db.add(job)
    db.commit()
    db.refresh(job)
    orchestrator.dispatch_job(job.id)
    return {"ok": True, "job_id": job.id, "channel": channel.name}


def list_channels(db):
    channels = db.query(models.Channel).all()
    return {"channels": [{
        "id": c.id, "name": c.name, "niche": c.niche or "",
        "auto_enabled": bool(c.auto_enabled), "auto_per_day": c.auto_per_day,
        "auto_publish_scheduled": bool(c.auto_publish_scheduled),
        "youtube_connected": bool(c.youtube_connected),
        "tiktok_connected": bool(c.tiktok_connected),
    } for c in channels]}


def set_channel_automation(db, channel_id, auto_enabled=None, auto_per_day=None, auto_publish_scheduled=None):
    c = db.get(models.Channel, channel_id)
    if not c:
        return {"error": "No channel with that ID."}
    if auto_enabled is not None:
        c.auto_enabled = bool(auto_enabled)
    if auto_per_day is not None:
        c.auto_per_day = max(1, min(24, int(auto_per_day)))
    if auto_publish_scheduled is not None:
        c.auto_publish_scheduled = bool(auto_publish_scheduled)
    db.commit()
    return {
        "ok": True, "channel": c.name, "auto_enabled": c.auto_enabled,
        "auto_per_day": c.auto_per_day, "auto_publish_scheduled": c.auto_publish_scheduled,
    }


DISPATCH = {
    "list_jobs": list_jobs,
    "get_job_status": get_job_status,
    "retry_job": retry_job,
    "cancel_job": cancel_job,
    "make_video": make_video,
    "list_channels": list_channels,
    "set_channel_automation": set_channel_automation,
    "list_available_commands": list_available_commands,
    "run_whitelisted_command": run_whitelisted_command,
    "fetch_url": fetch_url,
    "list_project_files": list_project_files,
    "read_project_file": read_project_file,
    "write_project_file": write_project_file,
}


def call_tool(db, name: str, tool_input: dict) -> dict:
    """The ONLY entry point that actually runs a tool. Anything not in
    DISPATCH is refused outright -- this is the whitelist enforcement
    point, not just an implementation detail."""
    fn = DISPATCH.get(name)
    if not fn:
        return {"error": f"'{name}' isn't a tool Jarvis is allowed to use."}
    try:
        return fn(db, **tool_input)
    except TypeError as e:
        return {"error": f"Bad arguments for {name}: {e}"}
    except Exception as e:
        return {"error": f"{name} failed: {e}"}
