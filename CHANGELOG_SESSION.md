# Faceless Command Center — Session Changelog

All of this is committed locally (11 commits) and ready to push in one shot
once you send a GitHub token. Nothing described here is live yet.

---

## 1. Chronos watchdog (reliability fix)
**Problem:** a video job stuck in "assembling" for 4 days because its worker
died mid-run during a server redeploy, and nothing ever reset it.
**Fix:** `app/scheduler.py` now checks — on every 5-minute tick, and once
immediately on startup — for any job stuck in an active state (queued,
scripting, voicing, visuals, captions, assembling, publishing) for more than
30 minutes. It auto-marks those as failed with a clear error message, so
Chronos stops treating that channel as blocked.

## 2. Mouse-reactive FX layer (AETHER front-end)
**File:** `app/static/mouse-fx.js`
A glowing cursor orb with lag, a fading particle trail as you move the
mouse, and a ripple burst on click. Fully self-contained canvas overlay —
doesn't touch any existing app logic. Respects `prefers-reduced-motion`.

## 3. Jarvis v1 — voice assistant
**Files:** `app/routers/jarvis.py`, `app/static/jarvis.js`
- New panel (🎙️ icon in the toolbar) with a chat log, mic button, and text
  input.
- Push-to-talk and "Hey Jarvis" continuous wake-word mode, both using the
  browser's built-in Web Speech API (Chrome/Edge; Safari/Firefox fall back
  to typing, clearly labeled).
- Backend calls Claude with **real tool-use** — it's not just chit-chat:
  - `list_channels` — real channel names + automation settings
  - `list_recent_jobs` — real job statuses, optionally filtered by channel
  - `start_video` — actually kicks off a new video job
- Replies are spoken aloud via the browser's speech synthesis.

## 4. Jarvis hardening pass (bugs found and fixed before you ever touched it)
- **Blocking bug:** starting a video from Jarvis was calling the full video
  pipeline inline in the HTTP request — would have hung the request for
  minutes. Fixed to dispatch as a background task, matching how the rest of
  the app already handles this.
- **Speech recognition race:** reusing one mic session object across
  push-to-talk/wake-mode switches could throw or misbehave in real browsers.
  Rebuilt to create a fresh session each time, guarded by a token so stale
  events from an old session can't interfere.
- **Mic leak on panel close:** closing the Jarvis panel didn't actually stop
  an active "Hey Jarvis" session — it kept listening in the background
  against detached DOM elements. Now cleans up properly.
- **Silent 500s:** a bad API key or Anthropic rate limit used to produce a
  generic server error. Now returns a specific, readable message.

## 5. Jarvis orb visualizer
A canvas orb replacing the static mic icon:
- **Idle** — gentle ambient breathing glow
- **Listening** — reacts to your *actual* microphone volume in real time
  (falls back to a synthetic pulse if mic access fails, so it never looks
  broken)
- **Speaking** — energetic synthetic wobble while Jarvis talks (browser TTS
  doesn't expose real amplitude, so this fakes a plausible one)
- Respects `prefers-reduced-motion` (idle/speaking go static; listening
  still reflects real input since that's functional feedback, not ambient
  decoration)

## 6. Mission Control v2 — quick links + monetization ideas
**File:** `app/static/command-center.js` (renderMissionControlPanel)
- One-tap dock: YouTube Studio, TikTok Studio, ElevenLabs, Render dashboard,
  GitHub repo
- A permanent "Growth & Monetization Ideas" panel with 8 concrete tactics
  (cross-posting, retention graphs, affiliate links, series/playlists,
  community polls, TikTok Creator Rewards, sponsor outreach, ad revenue
  settings)

## 7. Accuracy + accessibility fix
- Boot sequence said "12 agents" when the registry actually had 13 at the
  time (now 21, see #9) — fixed to reflect the real count.
- Jarvis orb visualizer didn't respect reduced-motion; now it does.

## 8. Texting Jarvis (SMS) + 3 new agents
**Files:** `app/routers/jarvis.py` (`/sms` endpoint), `app/models.py`
(`SmsThread` table), `app/agents_registry.py`
- A real SMS webhook, compatible with Twilio's standard "incoming message"
  convention (form-encoded POST, TwiML XML reply). Shares the exact same
  tool-use logic as the in-app chat — same brain, different door in.
- Per-phone-number conversation history stored in a new `sms_threads` table
  (rolling last 10 messages).
- **Setup required on your end:** a Twilio phone number, with its webhook
  pointed at `https://<your-app>.onrender.com/api/jarvis/sms`. Instructions
  and a copy-ready URL are now in the Jarvis panel itself.
- **Known limitation, flagged honestly:** this endpoint doesn't verify
  Twilio's request signature yet, so anyone who found the URL could trigger
  it (including starting a video). Fine while private; ask if you want
  signature verification added once it's actually in use.
- New agents: **Jarvis** (opens the panel / explains texting),
  **Plutus** (sponsorship outreach drafting), **Mnemosyne** (fact-checking
  scripts before they ship).

## 9. More agents + pure-fun additions
- 6 more agents (21 total): Morpheus (idea incubation), Janus (A/B testing),
  Calliope (sound/music), Nike (milestones), Hestia (channel health), on top
  of the earlier additions.
- Konami code (↑↑↓↓←→←→BA) → one-off confetti burst
- `?` key → keyboard shortcuts cheat-sheet overlay
- Typing "matrix" → a few seconds of Matrix-style code rain
- Live tab title — shows a spinner icon while any agent is actively working,
  so you can tell from another browser tab without switching back

## 10. Downloadable media kit
**Function:** `generateMediaKit()` in `command-center.js`
A button in Mission Control that draws your *real* current stats
(subscribers, views, videos published, videos today) onto a 1200×630 canvas
and downloads it as a PNG — something to actually attach to a sponsor
outreach email, tied to the Plutus agent's role.

## 11. Real Claude model picker (a backlog item from the original build, now
actually done)
**Files:** `app/schemas.py`, `app/settings_store.py`,
`app/pipeline/script_stage.py`, `app/routers/jarvis.py`,
`app/static/command-center.js`
- Turns out `anthropic_model` was never in the settings schema, so even if
  you'd tried to set one, it silently wouldn't have saved. Fixed.
- Also found the hardcoded default model string across the app
  (`claude-sonnet-4-5`) was outdated — updated to the current lineup.
- New dropdown in Settings: **Sonnet 5** (recommended default),
  **Haiku 4.5** (fastest/cheapest), **Opus 4.8** (most capable). Affects
  both Athena's script generation and Jarvis.

---

## What's still NOT done (real backlog, not being oversold as finished)
- Jarvis Phase 2 (controlling your actual computer — files, other apps,
  OS-level actions) — not started, separate project
- SMS webhook signature verification — not done, flagged as a known gap
- Plutus/Mnemosyne/Janus/Calliope/Nike/Hestia/Morpheus/Hestia agent "Quick
  Actions" buttons aren't wired to real backend logic yet — clicking them
  currently falls through to the command router's "I didn't catch that"
  fallback, same as several of the original outer-ring agents already were
- YouTube/TikTok publish paths still untested against live credentials
  (carried over from before this session)
