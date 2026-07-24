"""
Symmetric encryption for anything sensitive that sits in the database:
API keys, OAuth refresh tokens, client secrets. None of it is ever stored in
plaintext. The key itself lives in data/secret.key, generated once on first
run -- back that file up if you move the app, or every stored secret becomes
unreadable and you'll need to re-enter your API keys.
"""
from cryptography.fernet import Fernet
from .config import SECRET_KEY_FILE


def _load_or_create_key() -> bytes:
    if SECRET_KEY_FILE.exists():
        return SECRET_KEY_FILE.read_bytes()
    key = Fernet.generate_key()
    SECRET_KEY_FILE.write_bytes(key)
    SECRET_KEY_FILE.chmod(0o600)
    return key


_fernet = Fernet(_load_or_create_key())


def encrypt(value: str) -> str:
    if value is None:
        return None
    return _fernet.encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt(token: str) -> str:
    if token is None:
        return None
    return _fernet.decrypt(token.encode("utf-8")).decode("utf-8")
