"""
Central paths and constants for the Faceless Control Center.
Everything runtime (db, encryption key, generated media) lives under DATA_DIR / STORAGE_DIR
so the whole app is portable -- copy the folder, keep those two dirs out of git, done.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
DATA_DIR = BASE_DIR / "data"
STORAGE_DIR = BASE_DIR / "storage"
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
