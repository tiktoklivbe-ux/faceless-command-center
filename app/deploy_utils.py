"""
Lets Jarvis ship a website code change it made -- commit, push, and trigger a
real deploy, from inside the running container itself.

Two things make this safe enough to exist at all:
  1. It's ALWAYS confirm-gated (see DeployTask in models.py / the
     propose_website_deploy + confirm_website_deploy tools in jarvis_tools.py)
     -- nothing here ever runs from a tool call alone, only after the user
     explicitly confirms in chat.
  2. It needs a GitHub Personal Access Token the user provides themselves,
     scoped to just this one repo's contents (read+write) -- see
     settings_store.py's comment on github_repo_token for the exact scope to
     grant. Without that token set, none of this can do anything.
"""
import subprocess

from .config import BASE_DIR
from .settings_store import get_setting


def _run(cmd: list[str], cwd=None, timeout: int = 60) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            cmd, cwd=cwd or str(BASE_DIR), timeout=timeout,
            capture_output=True, text=True,
        )
        out = (result.stdout or "") + (result.stderr or "")
        return result.returncode == 0, out[-3000:]
    except subprocess.TimeoutExpired:
        return False, f"Timed out running: {' '.join(cmd)}"
    except Exception as e:
        return False, f"Couldn't run {' '.join(cmd)}: {e}"


def commit_and_push(db, summary: str) -> tuple[bool, str]:
    """git add -A, commit, push (using the stored PAT), and trigger the Render
    deploy hook. Returns (ok, combined output/error) -- never raises, so a
    tool call can hand the result straight back to the model."""
    token = get_setting(db, "github_repo_token")
    repo_url = get_setting(db, "github_repo_url", "github.com/tiktoklivbe-ux/faceless-command-center")
    if not token:
        return False, ("No GitHub token configured -- add github_repo_token in Settings "
                        "(a fine-grained PAT scoped to just this repo, Contents: read+write) "
                        "before Jarvis can push a website change.")

    log = []

    ok, out = _run(["git", "status", "--porcelain"])
    if not ok:
        return False, "git status failed:\n" + out
    if not out.strip():
        return False, "Nothing to commit -- no files were actually changed."
    log.append("status:\n" + out)

    ok, out = _run(["git", "add", "-A"])
    log.append("add:\n" + out)
    if not ok:
        return False, "\n\n".join(log)

    ok, out = _run(["git", "commit", "-m", f"Jarvis: {summary}\n\nCo-Authored-By: Jarvis <noreply@anthropic.com>"])
    log.append("commit:\n" + out)
    if not ok:
        return False, "\n\n".join(log)

    # Push over HTTPS with the token embedded in the remote URL for just this
    # one push -- never written to disk/config, so it can't leak into a log
    # file or a later `git remote -v`.
    push_url = f"https://x-access-token:{token}@{repo_url}"
    ok, out = _run(["git", "push", push_url, "HEAD:main"], timeout=60)
    # Scrub the token out of any output before it's ever logged/returned --
    # git echoes the URL it pushed to on some errors.
    out = out.replace(token, "***")
    log.append("push:\n" + out)
    if not ok:
        return False, "\n\n".join(log)

    import requests
    hook_url = get_setting(db, "render_deploy_hook_url")
    if hook_url:
        try:
            resp = requests.get(hook_url, timeout=30)
            log.append(f"deploy triggered: HTTP {resp.status_code}")
        except Exception as e:
            log.append(f"push succeeded, but couldn't trigger the deploy hook: {e}. "
                       f"The commit is on GitHub -- deploy it manually if needed.")
    else:
        log.append("Pushed to GitHub. No render_deploy_hook_url configured, so no "
                   "automatic deploy was triggered -- do that manually.")

    return True, "\n\n".join(log)
