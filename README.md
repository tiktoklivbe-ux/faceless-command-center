# Faceless Control Center — AETHER

An immersive, cinematic command center for running a faceless YouTube/TikTok
channel end to end. When you open it, you fly into a starfield with the
**AETHER** core pulsing at the center of a constellation of ~13 named agents
orbiting on two rings. You steer with your mouse (parallax), **WASD** or drag
to fly, and scroll to zoom. At the bottom is a command line — type
*"make a video about black holes"* and watch Athena, Orpheus, Iris and
Hephaestus light up in sequence as the pipeline runs.

## The constellation

Every node is a real function in the pipeline (or a growth capability):

| Agent | Role | Maps to |
|-------|------|---------|
| **AETHER** (core) | Orchestrator | routes commands, sequences the pipeline |
| **Apollo** 🔭 | Ideation & Trends | topic/idea generation |
| **Athena** 🦉 | Script & Strategy | the Script stage (Claude/Gemini/OpenAI) |
| **Orpheus** 🎙️ | Voice & Narration | the Voice stage (ElevenLabs) |
| **Iris** 🎨 | Visuals & Imagery | the Visuals stage (Gemini/OpenAI/Stability) |
| **Hephaestus** 🔨 | Assembly & Forge | the ffmpeg Assembly stage |
| **Hermes** 📡 | Publishing | the Publish stage (YouTube + TikTok) |
| **Daedalus** 🏛️ | Titles & Thumbnails | packaging (scaffold) |
| **Argus** 🛡️ | Guardian & Safety | policy / monetization checks (scaffold) |
| **Atlas** 🌐 | Analytics & Telemetry | cross-platform stats (scaffold) |
| **Blitz** 🎮 | Virality Engine | trend detection (scaffold) |
| **Echo** 💬 | Community & Replies | comment handling (scaffold) |
| **Chronos** ⏳ | Scheduling & Cadence | posting schedule (scaffold) |
| **Midas** 💰 | Monetization | revenue tracking (scaffold) |

The six pipeline agents (Athena → Orpheus → Iris → Hephaestus → Hermes, with
Apollo up front) are **fully wired** — their nodes pulse live as a real job
runs. The rest are "scaffold" personas: they exist as nodes with quick-action
buttons so the room feels complete and there's an obvious home for the next
features to plug into.

## What's on screen

- **Cinematic boot sequence** — AETHER comes online, agents wake, telemetry locks.
- **Mouse-parallax starfield** with drifting grid, twinkle, and shooting stars.
- **Fly-through camera** — WASD / arrows / click-drag to pan, scroll to zoom, mouse tilt.
- **The AETHER core** — pulses faster when any agent is working; click it for its dossier.
- **Agent nodes** — hover to lift, click for a slide-in dossier with role, live status, and quick actions.
- **Energy links** — a light pulse travels out along a link while that agent is running.
- **Command console** — natural language: *"make a video about …"*, *"open settings"*, *"show my channels"*, *"open the library"*. Press **/** to focus it.
- **Scheduled Rituals** panel — live countdown timers to recurring events (Daily Briefing, Backlog Council, Telemetry Sync, Community Hour, Guardian Sweep).
- **Live Activity** ticker — agents announce themselves as they engage.
- **Telemetry** panel — sparklines for estimated views, watch-hours, and agents-live.
- **Slide-in panels** for the real Control Panel (API keys), Channels (with YouTube/TikTok connect), and the Video Library (with live job progress + in-browser video preview + publish).

Everything runs from one FastAPI app with a no-build-step frontend, so it
hosts anywhere that runs Python + ffmpeg (Replit, Railway, Render, a VPS).

## How it's built

```
app/
  main.py            FastAPI app, mounts routers + the static dashboard
  models.py           Channel / VideoJob / Setting (SQLite via SQLAlchemy)
  crypto.py            Encrypts every API key / OAuth token at rest
  pipeline/
    script_stage.py     Claude/OpenAI -> structured script (segments)
    voice_stage.py       ElevenLabs TTS, one clip per segment
    visuals_stage.py     AI image per segment (or placeholder mode)
    ffmpeg_utils.py      Ken Burns pan/zoom, concat, subtitle burn-in
    captions_stage.py    Builds the .srt from real per-segment audio durations
    assemble_stage.py    Wires the above into one final.mp4
    publish_youtube.py   OAuth2 + resumable upload via YouTube Data API v3
    publish_tiktok.py    OAuth2 + Content Posting API
    orchestrator.py       Runs a job through every stage, stage by stage
  static/              The dashboard itself (plain HTML/CSS/JS, no build step)
storage/jobs/<id>/     Every job's generated audio/images/clips/final.mp4
data/                  SQLite DB + the encryption key (back this up!)
```

Every stage has a **no-key fallback** (silent audio, a labeled placeholder
image, a template script) so you can run the whole pipeline today, watch a
real video come out the other end, and only start spending money on
ElevenLabs/image-gen credits once you like what you see.

## Quick start (local)

```bash
cd faceless-control-center
pip install -r requirements.txt      # needs ffmpeg installed on the system too
python run.py
```

Open `http://localhost:8000`. Create a channel, hit **+ New Video**, watch it
generate. That's the whole loop before you've entered a single API key.

## Getting your API keys

All of these are entered in the app's **Settings** page, not in a `.env`
file — they're encrypted before they touch the database.

**Anthropic (Claude) and Gemini — you said you already have both, so start
here.** Anthropic: console.anthropic.com → API Keys. Gemini: aistudio.google.com
→ Get API key. Set either as the Script writer provider in Settings; whichever
key you fill in is what gets used if the selected provider's key is missing.
Gemini also doubles as an image-gen option (`gemini-2.5-flash-image`) using
the same key — no second signup needed if you want Gemini end-to-end.
**OpenAI** and **Stability** are there as additional options if you want them
later.

**ElevenLabs (voice)** — elevenlabs.io → Profile → API Keys. Use the
Channels page's voice picker (or `/api/channels/voices/list`) to find a
voice ID once your key is set.

**Image generation** — pick `openai` (gpt-image-1, reuses your OpenAI key)
or `stability` (a separate Stability AI key) in Settings → Visuals. Leave it
on `placeholder` for free end-to-end testing.

### YouTube

1. Google Cloud Console → create a project → enable the **YouTube Data API
   v3**.
2. APIs & Services → OAuth consent screen → External → fill in the basics.
   **Leave publishing status as "Testing"** for now and add your own Google
   account under **Test users**.
3. APIs & Services → Credentials → **Create OAuth client ID** → type
   "Web application" → Authorized redirect URI:
   `<your APP_BASE_URL>/auth/youtube/callback` (e.g.
   `http://localhost:8000/auth/youtube/callback` while testing locally).
4. Paste the Client ID and Client Secret into Settings here, then hit
   **Connect YouTube** on a channel.

**Why your old Replit build kept "getting declined": ** almost certainly one
of two things. Either the *monetization* application was rejected (YouTube
requires you to be 18 to run AdSense for YouTube — worth double-checking
since you mentioned two different ages earlier), or the OAuth connection
itself was the problem: apps that request upload access and haven't
completed Google's verification process get blocked/warned, **and** even
when they're not blocked, tokens issued while the app is in "Testing" mode
expire every 7 days. For a personal tool that's fine — just reconnect the
channel here whenever it stops working — but if you eventually want this to
run unattended for weeks at a time, you'll need to submit the OAuth consent
screen for Google's verification (needs a privacy policy URL + domain
ownership verification + a demo video; budget weeks, not minutes).

### TikTok

1. developers.tiktok.com → create an app → request the **Content Posting
   API** product and the `user.info.basic` + `video.publish` scopes.
2. Register the redirect URI: `<your APP_BASE_URL>/auth/tiktok/callback`.
3. Paste the Client Key and Client Secret into Settings, then **Connect
   TikTok** on a channel.

**Heads up:** TikTok treats personal/unaudited apps as restricted to
posting **privately (self-only)** to your own account — full public,
automated posting needs their manual app review (business entity, demo
video, privacy policy, ~5-10 business days once submitted). Build and test
with private posts first; submit for review when you're ready to go public.
TikTok's Creator Rewards Program (their payout program) also requires being
18+, 10,000+ followers, and 100,000+ views in the last 30 days.

## Deploying somewhere it stays online

Pick anywhere that (a) runs Python 3.11+, (b) has `ffmpeg` installed, and
(c) gives you a stable public URL:

- **Replit**: add a Nix/System dependency for `ffmpeg`, set `APP_BASE_URL`
  in Replit's Secrets to your `.repl.co` URL, run `python run.py`.
- **Railway / Render**: both support a Dockerfile or a Python buildpack with
  an `apt` package list for `ffmpeg`; set `APP_BASE_URL` to the URL they
  assign you, set the start command to `python run.py`.
- **Your own VPS**: `apt install ffmpeg`, run behind `systemd` + nginx (or
  just `pm2`/`tmux` for something quick and dirty), point `APP_BASE_URL` at
  your domain.

Whichever you pick, **update the redirect URIs in Google Cloud Console and
the TikTok Developer Portal** to match the new `APP_BASE_URL` — OAuth will
reject the callback otherwise.

## A content-policy note worth keeping in mind

YouTube's mid-2025 "inauthentic content" policy specifically targets
mass-produced, templated videos with no clear original input — the exact
failure mode a 100%-automated pipeline can fall into. The script stage's
prompt already pushes for a hook/POV/wrap-up rather than a flat list of
facts, but the single highest-leverage thing you can do is actually read
each script before publishing (or auto-publish as **private** and skim
before making it public) rather than trusting it blind — both for quality
and to stay clearly on the right side of that policy.

## The "agents" and how they actually run

The UI shows five agents (Script, Voice, Visual, Assembly, Publish) as live
status cards on each job. Under the hood, the Voice Agent and Visual Agent
genuinely run concurrently per segment (two threads calling ElevenLabs and
your image-gen provider at the same time), not just as a UI illusion — see
`app/pipeline/assemble_stage.py`. The Assembly Agent picks up each pair as
soon as both finish and renders that segment's Ken Burns clip while the next
segment's Voice/Visual Agents are already starting. The Command Center's
Daily Rundown polls `/api/rundown`, which reports which agents are `running`
across every in-flight job right now, plus a same-day summary.

## Backing this up

`data/secret.key` encrypts every API key and OAuth token in `data/app.db`.
If you lose it, every stored secret becomes unreadable and you'll need to
re-enter all your API keys and reconnect YouTube/TikTok. Back up the whole
`data/` folder if you move the app to a new host.
