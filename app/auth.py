"""
App lock: a password gate plus idle auto-lock.

Design notes worth stating plainly:

- The password is stored as a **salted hash**, never in plaintext and never in
  source. Putting it in the code would mean publishing it to GitHub in clear
  text, which is worse than no password at all.
- Sessions are signed tokens with an expiry, held in an HttpOnly cookie so
  page scripts can't read them.
- This protects the app from someone walking up to your machine. It is not
  protection against someone with real access to the computer -- they could
  read the database directly. For that you want full-disk encryption and a
  Windows account password, which are the right tools for that job.
"""
import hashlib
import hmac
import os
import secrets
import time

from sqlalchemy.orm import Session

from .settings_store import get_setting, set_setting

# Cost factor for password hashing. 200k iterations is deliberately slow --
# that's the point: it makes brute-forcing the hash expensive while costing
# you only a few milliseconds at login.
_ITERATIONS = 200_000
_SESSION_HOURS = 12


def _hash_password(password: str, salt: bytes) -> str:
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITERATIONS)
    return dk.hex()


def is_configured(db: Session) -> bool:
    return bool(get_setting(db, "lock_password_hash"))


def set_password(db: Session, password: str) -> None:
    if not password or len(password) < 4:
        raise ValueError("Password must be at least 4 characters.")
    salt = secrets.token_bytes(16)
    set_setting(db, "lock_salt", salt.hex())
    set_setting(db, "lock_password_hash", _hash_password(password, salt))


def verify_password(db: Session, password: str) -> bool:
    stored = get_setting(db, "lock_password_hash")
    salt_hex = get_setting(db, "lock_salt")
    if not stored or not salt_hex:
        return False
    candidate = _hash_password(password, bytes.fromhex(salt_hex))
    # compare_digest rather than == so the comparison time doesn't leak
    # information about how much of the hash matched.
    return hmac.compare_digest(candidate, stored)


def _session_secret(db: Session) -> bytes:
    """Key used to sign session tokens. Kept separate from the password so
    changing one doesn't require changing the other."""
    val = get_setting(db, "lock_session_secret")
    if not val:
        val = secrets.token_hex(32)
        set_setting(db, "lock_session_secret", val)
    return val.encode("utf-8")


def issue_token(db: Session) -> str:
    expires = int(time.time()) + _SESSION_HOURS * 3600
    payload = str(expires)
    sig = hmac.new(_session_secret(db), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def token_valid(db: Session, token: str | None) -> bool:
    if not token or "." not in token:
        return False
    payload, _, sig = token.partition(".")
    expected = hmac.new(_session_secret(db), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return False
    try:
        return int(payload) > time.time()
    except ValueError:
        return False


def lock_enabled(db: Session) -> bool:
    """Whether the lock is switched on. Off by default -- an app that
    suddenly demands a password nobody set would just lock the user out."""
    return get_setting(db, "lock_enabled", "false") == "true" and is_configured(db)


def idle_minutes(db: Session) -> int:
    try:
        return max(1, int(get_setting(db, "lock_idle_minutes", "15")))
    except ValueError:
        return 15
