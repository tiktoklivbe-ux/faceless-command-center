import asyncio
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse

from .database import init_db
from .routers import channels, settings, jobs, oauth, rundown, command, missioncontrol, jarvis, agent
from .scheduler import automation_loop

STATIC_DIR = Path(__file__).resolve().parent / "static"

# Bumps once per process start (i.e. once per deploy, since the host
# restarts the process). Appended as a query string to every asset URL in
# index.html so browsers can't keep serving a stale cached JS/CSS file after
# a new deploy goes out -- previously they could, since FileResponse didn't
# set any cache headers and browsers are free to reuse a cached copy
# indefinitely in that case. This was the actual cause of "I pushed new code
# but nothing changed in my browser."
_ASSET_VERSION = str(int(time.time()))

app = FastAPI(title="Faceless Control Center")

init_db()

app.include_router(channels.router)
app.include_router(settings.router)
app.include_router(jobs.router)
app.include_router(oauth.router)
app.include_router(rundown.router)
app.include_router(command.router)
app.include_router(missioncontrol.router)
app.include_router(jarvis.router)
app.include_router(agent.router)

app.mount("/assets", StaticFiles(directory=STATIC_DIR), name="assets")

_INDEX_HTML_RAW = (STATIC_DIR / "index.html").read_text()
_INDEX_HTML_VERSIONED = (
    _INDEX_HTML_RAW
    .replace('.js"', f'.js?v={_ASSET_VERSION}"')
    .replace('.css"', f'.css?v={_ASSET_VERSION}"')
)


@app.on_event("startup")
async def _start_chronos():
    # Runs Chronos (the auto-video scheduler) in the background for as long as
    # this process stays alive. See app/scheduler.py for the hosting caveat --
    # this does nothing useful on a host that sleeps the process when idle.
    asyncio.create_task(automation_loop())


@app.get("/{full_path:path}")
def spa(full_path: str):
    """Single-page app: every non-API route just serves index.html and the
    frontend JS figures out what to show based on the URL hash.

    Asset URLs (.js/.css) get a ?v=<deploy-time> query string baked in at
    startup so a new deploy is always fetched fresh instead of a browser
    reusing an old cached copy of the JS. The HTML response itself also gets
    no-cache headers so the browser always re-checks for this too.
    """
    return HTMLResponse(
        content=_INDEX_HTML_VERSIONED,
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )
