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

from . import config, models, ntfy_utils, render_gate, twilio_utils
from .pipeline import ffmpeg_utils, orchestrator
from .settings_store import get_setting

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
        "description": "Start generating a new video right now for a channel -- a short "
                        "(vertical, under a minute, default) or a long-form video (horizontal, "
                        "5-7 minutes, YouTube only).",
        "input_schema": {
            "type": "object",
            "properties": {
                "channel_id": {"type": "string"},
                "topic": {"type": "string", "description": "Optional specific topic; "
                          "leave blank to let the script agent pick one for the niche"},
                "kind": {"type": "string", "enum": ["short", "longform"],
                         "description": "Defaults to short if not specified."},
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
        "name": "get_channel_stats",
        "description": "Get LIVE YouTube metrics (current subscriber count, total views, "
                        "video count) for a channel, fetched fresh from YouTube right now -- "
                        "use this whenever asked how a channel is doing, how many subs/views "
                        "we have, or to check real-time performance. Omit channel_id for all "
                        "channels.",
        "input_schema": {
            "type": "object",
            "properties": {"channel_id": {"type": "string", "description": "Optional -- omit for all channels."}},
        },
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
        "name": "send_notification",
        "description": "Send a message to the user right now, on request (e.g. 'text me when "
                        "you're done', 'let me know', 'notify me'). Goes out over WhatsApp "
                        "and/or ntfy (a free push notification service) if either is "
                        "configured, and always also shows as a desktop notification in the "
                        "app if the user has that browser tab open. This is for a message "
                        "YOU decide to send outside the normal reply -- not needed for a "
                        "normal conversational answer, which the user already sees.",
        "input_schema": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
        },
    },
    {
        "name": "control_camera_dock",
        "description": "Control the camera preview on Jarvis's own screen -- open or close "
                        "the camera feed, expand/shrink/fullscreen it, restore it back to a "
                        "normal-sized widget, or move it to the center or a corner of the "
                        "screen. 'fullscreen' fills the whole screen with the camera feed "
                        "(the cockpit HUD frame stays visible on top, and Jarvis's own "
                        "emblem moves to a small corner presence) -- use it when asked to "
                        "make the camera take up the whole screen. 'open' is ALSO what turns "
                        "on gesture/hand-tracking control -- the camera feed and gesture "
                        "control are the same thing, so 'turn on gesture control', 'turn on "
                        "the camera', and 'enable hand tracking' should all use action=open "
                        "(and 'turn off/close/stop' either of those should use action=close).",
        "input_schema": {
            "type": "object",
            "properties": {"action": {"type": "string", "enum": [
                "open", "close", "expand", "shrink", "fullscreen", "restore",
                "center", "top-left", "top-right", "bottom-left", "bottom-right",
            ]}},
            "required": ["action"],
        },
    },
    {
        "name": "add_note",
        "description": "Save a note for later -- a reminder, something to follow up on, "
                        "a thought worth keeping. Appends to a running notes log; doesn't "
                        "overwrite anything.",
        "input_schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "list_notes",
        "description": "Read back recent notes, most recent first.",
        "input_schema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "description": "Max notes to return, default 10"}},
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
    {
        "name": "run_on_my_computer",
        "description": "Run a command on the USER'S OWN computer (not this server) via their "
                        "local companion agent -- e.g. opening an app, checking a file, "
                        "browsing to something, or any general task they ask for on their "
                        "machine. Requires the companion to be running there right now; if it "
                        "isn't connected, this tells you so instead of hanging. Anything judged "
                        "risky (deleting/overwriting files, installing or uninstalling "
                        "software, changing system settings, anything touching money/"
                        "credentials, shutting down/restarting the machine, sending messages) "
                        "is NOT run immediately -- it comes back asking the user to confirm "
                        "first; relay that question to them verbatim and call "
                        "confirm_computer_action once they say yes.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The exact command line to run (PowerShell on this machine)."},
                "reason": {"type": "string", "description": "One short sentence on why, shown to the user for anything needing confirmation."},
            },
            "required": ["command", "reason"],
        },
    },
    {
        "name": "confirm_computer_action",
        "description": "The user just said yes/confirmed to a pending run_on_my_computer "
                        "action -- actually run it now. Use the task_id from that earlier call.",
        "input_schema": {
            "type": "object",
            "properties": {"task_id": {"type": "string"}},
            "required": ["task_id"],
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


def send_notification(db, message):
    """Sends over WhatsApp if Twilio is fully configured with at least one
    allowlisted number, and over ntfy.sh if a topic is set -- either, both,
    or neither can be configured. Always returns ok so the frontend also
    fires a desktop notification (see jarvisSend's actions handling in
    command-center.js), since that one needs no setup at all and works
    even before either real channel is wired up."""
    message = (message or "").strip()
    if not message:
        return {"error": "Nothing to send -- message was empty."}
    account_sid = get_setting(db, "twilio_account_sid")
    auth_token = get_setting(db, "twilio_auth_token")
    from_number = get_setting(db, "twilio_whatsapp_number")
    numbers = [n.strip() for n in get_setting(db, "jarvis_phone_allowlist", "").split(",") if n.strip()]
    sent_whatsapp = False
    if account_sid and auth_token and from_number and numbers:
        for to_number in numbers:
            if twilio_utils.send_whatsapp_message(account_sid, auth_token, from_number, to_number, message):
                sent_whatsapp = True

    ntfy_topic = get_setting(db, "ntfy_topic")
    sent_ntfy = bool(ntfy_topic) and ntfy_utils.send_ntfy_message(ntfy_topic, message)

    return {"ok": True, "sent_whatsapp": sent_whatsapp, "sent_ntfy": sent_ntfy, "message": message}


def control_camera_dock(db, action):
    """The actual DOM effect happens client-side (see jarvisCameraDockAction
    in command-center.js, driven off this call's entry in the chat
    response's `actions` list) -- this function is what lets Claude decide
    to do it at all via a real tool call, and validates the action is one
    of the ones the frontend actually knows how to perform. "center" was
    the only place it could be moved to -- added the four corners too, so
    "put it in the corner" has somewhere real to go instead of only ever
    landing in the middle."""
    valid = {"open", "close", "expand", "shrink", "center", "fullscreen", "restore",
              "top-left", "top-right", "bottom-left", "bottom-right"}
    if action not in valid:
        return {"error": f"'{action}' isn't a camera action Jarvis knows -- use one of: {', '.join(sorted(valid))}."}
    return {"ok": True, "action": action}


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


# ---------------------------------------------------------------- local computer agent
# Jarvis running here (the cloud server) has no access to the user's own
# machine -- run_on_my_computer/confirm_computer_action queue a command into
# ComputerTask for the local companion process (local_agent.py, run BY the
# user on their own PC) to pick up over its own outbound poll. Same
# risky-vs-safe split as the rest of this app's safety rules: destructive,
# financial, credential, or irreversible-looking actions stop and ask first;
# everything else just runs.
_RISKY_PATTERNS = [
    # Deletion -- ANY delete-like call, not just recursive/forced ones. A
    # single-file `Remove-Item path` slipped through the first version of
    # this list (it only matched -Recurse), which is exactly the "deleting
    # files" case the confirmation gate exists for -- caught in testing
    # tonight when it deleted a test file with no confirmation asked.
    r"\brm\b", r"\bremove-item\b", r"\bdel\b", r"\berase\b", r"\brd\b", r"\brmdir\b",
    r"\bclear-content\b", r"\bformat\b", r"\bdiskpart\b",
    r"\breg\s+delete\b", r"\bregedit\b",
    r"\bshutdown\b", r"\brestart-computer\b", r"\bstop-computer\b",
    r"\buninstall\b", r"\bmsiexec\b.*\/x", r"choco\s+uninstall", r"winget\s+uninstall",
    r"\bnew-localuser\b", r"\bnet\s+user\b", r"\bpassword\b", r"\bcredential\b",
    r"\bpurchase\b", r"\bcheckout\b", r"\bpay\b.*\$", r"send-mailmessage",
    r"git\s+push\s+.*--force", r"git\s+reset\s+--hard", r"drop\s+(table|database)",
    r"\bstart-process\b.*-verb\s+runas", r"\binvoke-webrequest\b.*-outfile",
    r"\bmove-item\b", r"\brename-item\b",  # moving/renaming can also destroy data (overwrite)
]


def _is_risky_command(command: str) -> bool:
    low = (command or "").lower()
    return any(re.search(p, low) for p in _RISKY_PATTERNS)


def run_on_my_computer(db, command, reason=""):
    command = (command or "").strip()
    if not command:
        return {"error": "No command given."}
    from .routers import local_agent
    if not local_agent.agent_connected(db):
        return {"error": "The local companion isn't connected right now -- it needs to be "
                          "running on the user's computer for this to work. Tell them to "
                          "start it."}

    risky = _is_risky_command(command)
    task = models.ComputerTask(
        command=command, reason=(reason or "").strip(),
        risky=risky, status="awaiting_confirmation" if risky else "queued",
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    if risky:
        return {
            "ok": True, "needs_confirmation": True, "task_id": task.id,
            "command": command, "reason": task.reason,
            "message": f"This needs your OK first: `{command}` -- {task.reason or 'no reason given'}. "
                       f"Say yes to run it.",
        }
    return _await_computer_task(db, task)


def confirm_computer_action(db, task_id):
    task = db.get(models.ComputerTask, task_id)
    if not task:
        return {"error": "Unknown task -- it may have already run or expired."}
    if task.status != "awaiting_confirmation":
        return {"error": f"That task is already '{task.status}', nothing to confirm."}
    from .routers import local_agent
    if not local_agent.agent_connected(db):
        return {"error": "The local companion isn't connected right now."}
    task.status = "queued"
    db.commit()
    return _await_computer_task(db, task)


def _await_computer_task(db, task, timeout_seconds: float = 18.0):
    """Poll the DB for the companion to pick up and finish this task. Bounded
    so a single Jarvis chat turn can't hang forever -- most commands finish
    in well under this since the companion polls every couple seconds."""
    import time
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        db.expire(task)
        db.refresh(task)
        if task.status in ("done", "error"):
            return {
                "ok": task.status == "done", "task_id": task.id, "exit_code": task.exit_code,
                "stdout": task.stdout, "stderr": task.stderr,
            }
        time.sleep(1)
    return {"ok": False, "task_id": task.id, "still_running": True,
            "message": "Still running on their machine -- ask again in a moment to check on it."}


# ---------------------------------------------------------------- notes
# "A plain notes folder Jarvis manages itself" -- not an OS app, just simple
# text files under the project's own notes/ folder, using the same
# sandboxed-write path as write_project_file above (notes/ isn't in
# _WRITE_BLOCKED_PARTS, so this is just that same guarantee applied to one
# specific, append-only file).
NOTES_PATH = config.BASE_DIR / "notes" / "jarvis-notes.md"


def add_note(db, text):
    text = (text or "").strip()
    if not text:
        return {"error": "Nothing to note -- text was empty."}
    NOTES_PATH.parent.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    existing = NOTES_PATH.read_text(encoding="utf-8") if NOTES_PATH.exists() else ""
    NOTES_PATH.write_text(existing + f"\n## {timestamp}\n{text}\n", encoding="utf-8")
    return {"ok": True, "saved": text}


def list_notes(db, limit=10):
    if not NOTES_PATH.exists():
        return {"notes": []}
    content = NOTES_PATH.read_text(encoding="utf-8")
    entries = [f"## {e}".strip() for e in content.split("## ") if e.strip()]
    entries = entries[-max(1, min(int(limit or 10), 50)):]
    entries.reverse()  # most recent first
    return {"notes": entries}


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


def make_video(db, channel_id, topic="", kind="short"):
    channel = db.get(models.Channel, channel_id)
    if not channel:
        return {"error": "No channel with that ID."}
    kind = kind if kind in ("short", "longform") else "short"
    # Was hardcoded to auto_publish=False -- a job queued through Jarvis chat
    # ALWAYS sat in review-only regardless of the channel's own auto-publish
    # setting or the user's stated preference (auto-publish should be on).
    # Now it follows the same rule the fixed-slot scheduler already uses.
    job = models.VideoJob(channel_id=channel.id, topic=topic or "", kind=kind,
                           auto_publish=bool(channel.auto_publish_scheduled))
    db.add(job)
    db.commit()
    db.refresh(job)
    orchestrator.dispatch_job(job.id)
    return {"ok": True, "job_id": job.id, "channel": channel.name, "kind": kind,
            "auto_publish": job.auto_publish}


def list_channels(db):
    channels = db.query(models.Channel).all()
    return {"channels": [{
        "id": c.id, "name": c.name, "niche": c.niche or "",
        "auto_enabled": bool(c.auto_enabled), "auto_per_day": c.auto_per_day,
        "auto_publish_scheduled": bool(c.auto_publish_scheduled),
        "youtube_connected": bool(c.youtube_connected),
        "tiktok_connected": bool(c.tiktok_connected),
    } for c in channels]}


def get_channel_stats(db, channel_id=None):
    """LIVE YouTube stats fetched fresh right now (no cache), so Jarvis can
    answer 'how many subs do we have' with the real current number."""
    from . import crypto
    from .pipeline import publish_youtube
    channels = [db.get(models.Channel, channel_id)] if channel_id else db.query(models.Channel).all()
    out = []
    for c in channels:
        if not c:
            continue
        if not c.youtube_connected or not c.youtube_refresh_token_enc:
            out.append({"channel": c.name, "connected": False,
                        "note": "YouTube isn't connected for this channel, so there are no stats to read."})
            continue
        try:
            token = publish_youtube.refresh_access_token(db, crypto.decrypt(c.youtube_refresh_token_enc))
            s = publish_youtube.fetch_channel_stats(token)
            out.append({
                "channel": c.name,
                "youtube_title": c.youtube_channel_title or "",
                "connected": True,
                "subscribers": s.get("subscribers"),
                "views": s.get("views"),
                "video_count": s.get("video_count"),
                "subscribers_hidden": s.get("hidden_subs", False),
            })
        except Exception as e:  # noqa: BLE001
            out.append({"channel": c.name, "connected": True, "error": str(e)[:150]})
    return {"ok": True, "stats": out}


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
    "get_channel_stats": get_channel_stats,
    "set_channel_automation": set_channel_automation,
    "list_available_commands": list_available_commands,
    "run_whitelisted_command": run_whitelisted_command,
    "fetch_url": fetch_url,
    "control_camera_dock": control_camera_dock,
    "send_notification": send_notification,
    "add_note": add_note,
    "list_notes": list_notes,
    "list_project_files": list_project_files,
    "read_project_file": read_project_file,
    "write_project_file": write_project_file,
    "run_on_my_computer": run_on_my_computer,
    "confirm_computer_action": confirm_computer_action,
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
