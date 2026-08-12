#!/usr/bin/env python3
"""
Overnight autofix watcher for faceless-command-center.

Runs on a schedule (see the launchd plist, every 15 min) on the machine
that owns this repo's git push credentials. Each run:

  1. Polls three sources of trouble:
       - failed VideoJobs on the live app        (GET {APP_BASE_URL}/api/jobs)
       - blocked/unauthorized JarvisLog rows      (GET {APP_BASE_URL}/api/jarvis/log)
       - failed Render deploys for this service   (Render platform API)
  2. Dedupes against a local state file so nothing is investigated twice.
  3. For a video-job failure, immediately requeues it via Jarvis's own
     retry_job tool (through /api/jarvis/chat) for fast recovery -- once
     per distinct failure, not every cycle.
  4. Hands up to MAX_PER_CYCLE new items to Claude Code (`claude -p`,
     non-interactively) to investigate, fix, verify, commit, and push to
     main. Claude's tool access is deliberately bounded (Edit/Write plus
     only git/python/pip via Bash) -- the same "explicit whitelist, not a
     prompt asking nicely" philosophy this app already uses for Jarvis
     itself (see app/jarvis_tools.py).
  5. As a safety net, pushes any local commits left un-pushed after a
     Claude run (in case it forgot the last step).

Deliberately stdlib-only (urllib, not requests) so it has zero dependency
on this repo's venv -- it has to keep working even if the app's own
environment is broken, which is exactly the situation it may be invoked
to fix.

State, logs, and secrets all live OUTSIDE this repo (~/.config and
~/Library/Logs) so an autonomous `git add -A` run by Claude can never
accidentally commit them.
"""
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parents[2]
STATE_DIR = Path.home() / ".config" / "faceless-autofix"
LOG_DIR = Path.home() / "Library" / "Logs" / "faceless-autofix"
STATE_FILE = STATE_DIR / "state.json"
RUN_LOG = LOG_DIR / "run.log"
HISTORY_LOG = LOG_DIR / "history.jsonl"

APP_BASE_URL = os.environ.get("APP_BASE_URL", "https://faceless-command-center.onrender.com").rstrip("/")
RENDER_API_KEY = os.environ.get("RENDER_API_KEY", "")
RENDER_SERVICE_ID = os.environ.get("RENDER_SERVICE_ID", "")
MAX_PER_CYCLE = int(os.environ.get("AUTOFIX_MAX_PER_CYCLE", "3"))
CLAUDE_TIMEOUT_S = int(os.environ.get("AUTOFIX_CLAUDE_TIMEOUT_S", "1200"))  # 20 min

RENDER_FAILURE_STATUSES = {"build_failed", "update_failed", "canceled", "pre_deploy_failed"}

ALLOWED_TOOLS = [
    "Edit", "Write",
    "Bash(git *)", "Bash(python3 *)", "Bash(python *)",
    "Bash(pip install *)", "Bash(pip3 install *)",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(msg: str) -> None:
    line = f"[{now_iso()}] {msg}"
    print(line, flush=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(RUN_LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def log_history(entry: dict) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    entry = {"timestamp": now_iso(), **entry}
    with open(HISTORY_LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            log(f"WARNING: state file unreadable ({e}), starting fresh")
    return {"failed_jobs": {}, "blocked_logs": {}, "render_deploys": {}, "retried_jobs": {}}


def save_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(STATE_FILE)


def http_get_json(url: str, headers: dict | None = None, timeout: int = 30):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_post_json(url: str, payload: dict, headers: dict | None = None, timeout: int = 60):
    body = json.dumps(payload).encode("utf-8")
    hdrs = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=body, headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def job_key(job: dict) -> str:
    err_hash = hashlib.sha1((job.get("error_message") or "").encode("utf-8")).hexdigest()[:12]
    return f"{job['id']}:{err_hash}"


# ---------------------------------------------------------------- fetchers

def fetch_failed_jobs() -> list[dict]:
    try:
        jobs = http_get_json(f"{APP_BASE_URL}/api/jobs?limit=200")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        log(f"WARNING: could not fetch /api/jobs ({e}) -- skipping this source this cycle")
        return []
    return [j for j in jobs if j.get("status") == "failed"]


def fetch_blocked_logs() -> list[dict]:
    try:
        rows = http_get_json(f"{APP_BASE_URL}/api/jarvis/log?limit=200")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        log(f"WARNING: could not fetch /api/jarvis/log ({e}) -- skipping this source this cycle")
        return []
    return [r for r in rows if r.get("allowed") is False]


def fetch_render_deploy_failures() -> list[dict]:
    if not (RENDER_API_KEY and RENDER_SERVICE_ID):
        return []
    try:
        rows = http_get_json(
            f"https://api.render.com/v1/services/{RENDER_SERVICE_ID}/deploys?limit=20",
            headers={"Authorization": f"Bearer {RENDER_API_KEY}", "Accept": "application/json"},
        )
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        log(f"WARNING: could not fetch Render deploys ({e}) -- skipping this source this cycle")
        return []
    deploys = [row["deploy"] for row in rows if "deploy" in row]
    return [d for d in deploys if d.get("status") in RENDER_FAILURE_STATUSES]


# ---------------------------------------------------------------- remediation

def attempt_retry(job: dict) -> bool:
    """Best-effort: ask Jarvis (server-side, same safety whitelist) to
    requeue this failed job right now, for fast recovery independent of
    whether Claude Code investigation finds/needs a code fix. Never
    raises -- a failure here just means no fast-path recovery happened."""
    try:
        resp = http_post_json(
            f"{APP_BASE_URL}/api/jarvis/chat",
            {"message": f"Retry job {job['id']}.", "history": []},
            timeout=30,
        )
        log(f"  retry via Jarvis for job {job['id']}: {json.dumps(resp)[:200]}")
        return True
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        log(f"  retry via Jarvis for job {job['id']} failed ({e}) -- Claude Code investigation still proceeds")
        return False


# ---------------------------------------------------------------- prompting

GROUND_RULES = f"""You are doing unattended, autonomous maintenance on this repository
(faceless-command-center), running non-interactively overnight on a scheduled
watcher. You have exactly one job right now: investigate ONE specific reported
problem below, and if it's a real code bug, fix it properly, verify the fix as
concretely as you can, and commit + push directly to origin/main. This repo is
deployed on Render from the main branch, so a push here goes live.

Ground rules, non-negotiable:
- Only read/write files inside this repository directory ({REPO_DIR}). Never
  touch anything outside it, never touch git config or credentials, never
  touch any other repository.
- Only use git and python/pip commands via Bash -- that is all you are
  permitted to run.
- Investigate the ACTUAL root cause before changing anything -- read the
  relevant code, don't guess. This codebase's own git history (`git log`)
  shows the standard here: every commit message explains the real bug and
  what was actually verified, not just what changed. Match that.
- If, after investigating, this is NOT a code bug in this repo (e.g. a
  missing/expired/invalid API key, an external provider outage, a one-off
  transient network error, a user configuration issue like a disconnected
  YouTube/TikTok account) -- do NOT make a speculative code change. Just
  explain your conclusion clearly in your final message and stop. A no-op is
  the correct outcome for a non-bug.
- If you do fix something, verify it concretely before committing -- re-read
  the code path, run it if you can (python3 -c "...", a small script,
  importing the module, etc.), don't just assume the diff is correct.
- Commit with a message in this repo's existing style: explain the real root
  cause and what you verified, not just a summary of the diff.
- After committing, run `git push origin main` yourself and confirm it
  succeeded before finishing.
- Keep the code change as small and targeted as the real fix requires --
  don't refactor unrelated things.
- Work only on the item below -- don't go looking for other unrelated
  failures this run.
"""


def prompt_for_job(job: dict, retried: bool) -> str:
    tail = "\n".join((job.get("stage_log") or "").splitlines()[-40:])
    return GROUND_RULES + f"""
--- The reported problem ---
Type: Video render/publish job failure
Job ID: {job['id']}
Channel ID: {job.get('channel_id')}
Topic: {job.get('topic') or '(none specified)'}
Status: failed
Error message: {job.get('error_message') or '(empty)'}

Tail of stage_log (most recent lines):
{tail or '(empty)'}

A retry of this exact job was {"attempted just now via Jarvis (requeued)" if retried else "NOT attempted (Jarvis retry call failed)"}
-- that's a separate fast-recovery path, not a substitute for you finding and
fixing the real bug if there is one.
"""


def prompt_for_blocked_log(row: dict) -> str:
    return GROUND_RULES + f"""
--- The reported problem ---
Type: Jarvis blocked/unauthorized action attempt
Log ID: {row['id']}
Source: {row.get('source')}
Action attempted: {row.get('action')}
Params: {row.get('params')}
Allowed: false
Result/reason given: {row.get('result')}
Original user request: {row.get('user_message')}

Note: a blocked action is often CORRECT behavior (the whitelist in
app/jarvis_tools.py doing its job against something out-of-scope or
malformed) rather than a bug. Only treat this as something to fix if reading
the code shows the whitelist/dispatch logic itself is behaving incorrectly
(e.g. rejecting a well-formed, in-scope request it should allow, or a real
bug in how the action was dispatched) -- not just because something got
refused.
"""


def prompt_for_render_deploy(deploy: dict) -> str:
    commit = deploy.get("commit") or {}
    return GROUND_RULES + f"""
--- The reported problem ---
Type: Render deploy failure
Deploy ID: {deploy['id']}
Status: {deploy.get('status')}
Commit: {commit.get('id')} -- {(commit.get('message') or '').splitlines()[0] if commit.get('message') else '(no message)'}
Created at: {deploy.get('createdAt')}
Finished at: {deploy.get('finishedAt')}

Render's deploy-list API does not expose the actual build log text, so you
cannot see the exact build error directly. Use your judgement: check the
commit above (and `git show` / `git log -p` around it) for anything that
would plausibly break a build or startup on Render -- a syntax error, a bad
import, a dependency missing from requirements.txt, a startup-time crash,
anything Windows/Mac-only that fails on Render's Linux containers. If you
can identify and fix a concrete cause, do so and verify it (e.g.
`python3 -c "import app.main"` to catch import-time failures, since that's
exactly what crashes a real deploy). If you cannot identify a concrete cause
from the code alone, say so plainly rather than guessing at a change.
"""


# ---------------------------------------------------------------- claude runner

def run_claude(prompt: str, label: str) -> dict:
    head_before = git_rev_parse("HEAD")
    cmd = [
        "claude", "-p", prompt,
        "--permission-mode", "acceptEdits",
        "--allowedTools", *ALLOWED_TOOLS,
        "--output-format", "json",
    ]
    start = time.time()
    try:
        proc = subprocess.run(
            cmd, cwd=REPO_DIR, capture_output=True, text=True, timeout=CLAUDE_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        duration = time.time() - start
        log(f"  claude TIMED OUT after {duration:.0f}s for {label}")
        return {"outcome": "timeout", "duration_s": duration, "summary": "Timed out."}

    duration = time.time() - start
    result_text = proc.stdout.strip()
    parsed = None
    try:
        parsed = json.loads(result_text)
    except json.JSONDecodeError:
        pass

    summary = (parsed or {}).get("result") if parsed else result_text[-2000:]
    is_error = bool((parsed or {}).get("is_error")) or proc.returncode != 0

    head_after = git_rev_parse("HEAD")
    committed = head_before != head_after
    pushed = False
    if committed:
        pushed = ensure_pushed()

    log(f"  claude finished in {duration:.0f}s for {label}: "
        f"returncode={proc.returncode} committed={committed} pushed={pushed} is_error={is_error}")
    if proc.returncode != 0 and proc.stderr:
        log(f"  claude stderr (tail): {proc.stderr[-500:]}")

    return {
        "outcome": "error" if is_error else ("fixed" if committed else "no_fix_needed"),
        "duration_s": duration,
        "committed": committed,
        "pushed": pushed,
        "returncode": proc.returncode,
        "summary": summary,
        "cost_usd": (parsed or {}).get("total_cost_usd"),
    }


def git_rev_parse(ref: str) -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", ref], cwd=REPO_DIR, capture_output=True, text=True, check=True,
        ).stdout.strip()
    except subprocess.CalledProcessError:
        return None


def ensure_pushed() -> bool:
    """Safety net: if Claude committed but, for whatever reason, didn't
    successfully push, push it ourselves using the same stored credential
    rather than leaving main behind local HEAD until the next cycle."""
    subprocess.run(["git", "fetch", "origin", "main", "-q"], cwd=REPO_DIR, capture_output=True)
    local = git_rev_parse("HEAD")
    remote = git_rev_parse("origin/main")
    if local == remote:
        return True
    log("  local HEAD ahead of origin/main after claude run -- pushing as a safety net")
    proc = subprocess.run(
        ["git", "push", "origin", "main"], cwd=REPO_DIR, capture_output=True, text=True,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    if proc.returncode != 0:
        log(f"  SAFETY-NET PUSH FAILED: {proc.stderr[-500:]}")
        return False
    return True


# ---------------------------------------------------------------- main

def main() -> int:
    state = load_state()
    log("=== autofix cycle start ===")

    failed_jobs = fetch_failed_jobs()
    blocked_logs = fetch_blocked_logs()
    render_failures = fetch_render_deploy_failures()

    new_jobs = [j for j in failed_jobs if job_key(j) not in state["failed_jobs"]]
    new_blocked = [r for r in blocked_logs if r["id"] not in state["blocked_logs"]]
    new_render = [d for d in render_failures if d["id"] not in state["render_deploys"]]

    log(f"found: {len(failed_jobs)} failed jobs ({len(new_jobs)} new), "
        f"{len(blocked_logs)} blocked actions ({len(new_blocked)} new), "
        f"{len(render_failures)} render deploy failures ({len(new_render)} new)")

    # Fast-path retry for every new failed job, once per distinct failure --
    # cheap, not subject to the investigate/push cap.
    for job in new_jobs:
        key = job_key(job)
        if key not in state["retried_jobs"]:
            attempt_retry(job)
            state["retried_jobs"][key] = now_iso()
            save_state(state)

    # Prioritized worklist for the expensive investigate-fix-commit-push
    # path, bounded by MAX_PER_CYCLE so a bad night can't fire off unlimited
    # autonomous pushes to main in one cycle.
    worklist = (
        [("render", d) for d in new_render]
        + [("job", j) for j in new_jobs]
        + [("blocked", r) for r in new_blocked]
    )
    to_process = worklist[:MAX_PER_CYCLE]
    deferred = worklist[MAX_PER_CYCLE:]
    if deferred:
        log(f"NOTE: {len(deferred)} new item(s) deferred to a later cycle (cap={MAX_PER_CYCLE}/cycle): "
            + ", ".join(f"{kind}:{item.get('id')}" for kind, item in deferred))

    for kind, item in to_process:
        if kind == "job":
            key = job_key(item)
            prompt = prompt_for_job(item, retried=key in state["retried_jobs"])
            label = f"job {item['id']}"
        elif kind == "blocked":
            key = item["id"]
            prompt = prompt_for_blocked_log(item)
            label = f"blocked-log {item['id']}"
        else:
            key = item["id"]
            prompt = prompt_for_render_deploy(item)
            label = f"render-deploy {item['id']}"

        log(f"investigating {label} ...")
        result = run_claude(prompt, label)
        log_history({"kind": kind, "id": item.get("id"), "key": key, **result})

        if kind == "job":
            state["failed_jobs"][key] = now_iso()
        elif kind == "blocked":
            state["blocked_logs"][key] = now_iso()
        else:
            state["render_deploys"][key] = now_iso()
        save_state(state)

    log(f"=== autofix cycle end: {len(to_process)} investigated, {len(deferred)} deferred ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
