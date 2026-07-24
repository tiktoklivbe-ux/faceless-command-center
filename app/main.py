from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .database import init_db
from .routers import channels, settings, jobs, oauth, rundown, command

STATIC_DIR = Path(__file__).resolve().parent / "static"

app = FastAPI(title="Faceless Control Center")

init_db()

app.include_router(channels.router)
app.include_router(settings.router)
app.include_router(jobs.router)
app.include_router(oauth.router)
app.include_router(rundown.router)
app.include_router(command.router)

app.mount("/assets", StaticFiles(directory=STATIC_DIR), name="assets")


@app.get("/{full_path:path}")
def spa(full_path: str):
    """Single-page app: every non-API route just serves index.html and the
    frontend JS figures out what to show based on the URL hash."""
    return FileResponse(STATIC_DIR / "index.html")
