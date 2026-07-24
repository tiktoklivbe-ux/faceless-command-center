"""
Central paths and constants for the Faceless Control Center.
Everything runtime (db, encryption key, generated media) lives under DATA_DIR / STORAGE_DIR
so the whole app is portable -- copy the folder, keep those two dirs out of git, done.

On a host with an ephemeral filesystem (Render, Railway, etc.), set the
PERSIST_DIR env var to the mount path of a single attached persistent disk
(e.g. /var/data on Render) -- both the encrypted settings database and every
generated video will then live under that one disk instead of resetting on
every redeploy. Leave PERSIST_DIR unset for local/dev use; it defaults to
living inside the app folder itself.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

PERSIST_DIR = Path(os.environ.get("PERSIST_DIR", str(BASE_DIR)))
DATA_DIR = PERSIST_DIR / "data"
STORAGE_DIR = PERSIST_DIR / "storage"
JOBS_DIR = STORAGE_DIR / "jobs"

DATA_DIR.mkdir(parents=True, exist_ok=True)
JOBS_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = f"sqlite:///{DATA_DIR / 'app.db'}"
SECRET_KEY_FILE = DATA_DIR / "secret.key"

# Public base URL of this app -- needed for OAuth redirect URIs (YouTube/TikTok).
# Set this in a .env file once you know where the app is hosted, e.g.
# https://your-app.up.railway.app  or  http://localhost:8000 for local testing.
APP_BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:8000")

# Roughly how fast a narrator speaks -- used to time captions/visual segments
# when we don't have exact word-level timestamps from the TTS provider.
WORDS_PER_MINUTE = 150
