#!/bin/bash
# launchd entry point for the overnight autofix watcher. Kept deliberately
# thin: set up PATH/env (launchd gives almost none of the interactive
# shell's PATH), hold a simple lock so overlapping runs can't collide on
# git, then hand off to check_and_fix.py for the actual logic.
set -euo pipefail

# launchd's default PATH doesn't include Homebrew, so `claude`, `git`,
# `python3` would all be "command not found" without this.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRETS_FILE="$HOME/.config/faceless-autofix/secrets.env"
LOCK_DIR="$HOME/.config/faceless-autofix/run.lock"
LOG_DIR="$HOME/Library/Logs/faceless-autofix"

mkdir -p "$LOG_DIR"

# A run can legitimately take longer than the 15-minute check interval (up
# to MAX_PER_CYCLE * ~20 min investigations). If a previous run is still
# going, skip this tick rather than run two autofix cycles concurrently
# against the same working tree.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "[$(date -u +%FT%TZ)] previous run still in progress (lock held) -- skipping this tick" >> "$LOG_DIR/run.log"
    exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if [ -f "$SECRETS_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$SECRETS_FILE"
    set +a
else
    echo "[$(date -u +%FT%TZ)] WARNING: $SECRETS_FILE not found -- Render polling and APP_BASE_URL will use defaults" >> "$LOG_DIR/run.log"
fi

# Deliberately NOT `exec` here: exec replaces the shell process image
# outright, which means it never returns to run the EXIT trap above -- the
# lock directory would never be released after a successful run, and every
# future tick would see it still held and skip itself forever. Plain call +
# explicit exit keeps the trap intact while still propagating check_and_fix's
# real exit code.
python3 "$REPO_DIR/scripts/autofix/check_and_fix.py"
exit $?
