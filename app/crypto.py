"""
Symmetric encryption for anything sensitive that sits in the database:
API keys, OAuth refresh tokens, client secrets. None of it is ever stored in
plaintext.

KEY PERSISTENCE -- this is the part that used to silently break things:

The encryption key must survive restarts, or every stored secret becomes
permanently unreadable and you have to re-enter every API key. It's resolved
in this order:

  1. SECRET_KEY env var  -- most durable. Survives disk problems entirely,
     since it isn't stored on the filesystem at all. Recommended on hosts
     like Render: set it once and the keys never get lost again.
  2. data/secret.key on disk -- fine as long as DATA_DIR really is on a
     persistent volume. If PERSIST_DIR is unset or the disk fails to mount,
     this file lands on ephemeral storage and gets regenerated on the next
     deploy, which is exactly what makes saved keys "stop working."
  3. Freshly generated and written to disk -- first run only.

If a value can't be decrypted (almost always because the key changed), we now
return None instead of raising. Previously an InvalidToken exception
propagated up and took the whole settings request down with it, so instead of
"your key needs re-entering" you'd get an opaque server error.
"""
import logging
import os

from cryptography.fernet import Fernet, InvalidToken

from .config import SECRET_KEY_FILE

log = logging.getLogger("crypto")

_key_source = "unknown"


def _load_or_create_key() -> bytes:
    global _key_source

    env_key = os.environ.get("SECRET_KEY", "").strip()
    if env_key:
        _key_source = "env"
        return env_key.encode("utf-8")

    if SECRET_KEY_FILE.exists():
        _key_source = "disk"
        return SECRET_KEY_FILE.read_bytes()

    key = Fernet.generate_key()
    SECRET_KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    SECRET_KEY_FILE.write_bytes(key)
    try:
        SECRET_KEY_FILE.chmod(0o600)
    except OSError:
        pass
    _key_source = "generated"
    log.warning(
        "Generated a NEW encryption key at %s. Any secrets encrypted with a "
        "previous key can no longer be read and will need re-entering. To make "
        "this permanent, copy this key into a SECRET_KEY environment variable: %s",
        SECRET_KEY_FILE, key.decode("utf-8"),
    )
    return key


_raw_key = _load_or_create_key()
_fernet = Fernet(_raw_key)


def key_info() -> dict:
    """Where the current key came from, for diagnostics. Never returns the key."""
    return {
        "source": _key_source,
        "persistent": _key_source == "env",
        "path": str(SECRET_KEY_FILE),
        "advice": (
            "Key is held in the SECRET_KEY env var -- safe across redeploys and disk changes."
            if _key_source == "env" else
            "Key is a file on disk. If that disk is ever ephemeral or remounted, every saved "
            "secret becomes unreadable. Set SECRET_KEY as an environment variable to make it permanent."
        ),
    }


def current_key_for_backup() -> str:
    """The active key, so it can be copied into a SECRET_KEY env var. Only
    ever surfaced through an explicit local diagnostic endpoint."""
    return _raw_key.decode("utf-8")


def encrypt(value: str) -> str:
    if value is None:
        return None
    return _fernet.encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt(token: str):
    """Returns None rather than raising when a value can't be decrypted.
    That happens when the encryption key has changed since the value was
    saved -- a real situation that should surface as "this key needs
    re-entering", not as a 500 that breaks the entire settings page."""
    if token is None:
        return None
    try:
        return _fernet.decrypt(token.encode("utf-8")).decode("utf-8")
    except (InvalidToken, ValueError):
        log.warning("Could not decrypt a stored secret -- the encryption key has changed. "
                    "That value needs re-entering.")
        return None
