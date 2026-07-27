"""
The AETHER agent constellation.

Each agent is a named persona mapped to a real function in the pipeline (or a
support capability). The immersive Command Center front-end renders these as
glowing nodes orbiting the AETHER core; the `stage` field is how a running
VideoJob's per-stage `agent_status` gets mapped onto the right node so it
lights up live while that part of the pipeline is working.

Colors are hex accents used by the UI glow. `ring` places the node on the
inner (1) or outer (2) orbit. `icon` is an emoji used as a lightweight glyph
so there are no external image dependencies.
"""

CORE = {
    "id": "aether",
    "name": "AETHER",
    "title": "Orchestrator",
    "blurb": "The conductor. Routes your intent to the right agents, sequences the "
             "pipeline, and keeps the whole constellation in sync.",
    "icon": "✦",
    "color": "#00e8ff",
}

# stage -> which pipeline JobStatus/agent_status key this node reflects.
# stage=None means it's a support agent not tied to the linear render pipeline.
AGENTS = [
    # ----- inner ring: the core production pipeline -----
    {"id": "apollo", "name": "Apollo", "title": "Ideation & Trends", "stage": "ideation",
     "icon": "🔭", "color": "#ff2f9e", "ring": 1,
     "blurb": "Scouts topics and trends, then pitches the ideas most likely to land "
              "for your niche. The spark at the front of every video.",
     "actions": ["Pitch 5 new ideas", "Scan trending topics"]},
    {"id": "athena", "name": "Athena", "title": "Script & Strategy", "stage": "script",
     "icon": "🦉", "color": "#b26bff", "ring": 1,
     "blurb": "Turns a topic into a tight, original narration script with a hook, a "
              "point of view, and a payoff — the part YouTube's rules actually reward.",
     "actions": ["Rewrite last script", "Draft a script"]},
    {"id": "orpheus", "name": "Orpheus", "title": "Voice & Narration", "stage": "voice",
     "icon": "🎙️", "color": "#00e8ff", "ring": 1,
     "blurb": "Narrates every line through ElevenLabs in your chosen voice, one clean "
              "take per segment so captions land perfectly in sync.",
     "actions": ["Preview a voice", "Re-narrate last video"]},
    {"id": "iris", "name": "Iris", "title": "Visuals & Imagery", "stage": "visuals",
     "icon": "🎨", "color": "#39ffa0", "ring": 1,
     "blurb": "Generates a cinematic image for every beat of the script (Gemini / "
              "OpenAI / Stability), matched to your channel's visual style.",
     "actions": ["Regenerate visuals", "Test image style"]},
    {"id": "hephaestus", "name": "Hephaestus", "title": "Assembly & Forge", "stage": "assembly",
     "icon": "🔨", "color": "#ffb340", "ring": 1,
     "blurb": "The forge. Animates each still with a Ken Burns move, stitches the "
              "clips, burns in captions, and outputs the finished vertical video.",
     "actions": ["Rebuild last video"]},
    {"id": "hermes", "name": "Hermes", "title": "Publishing", "stage": "publish",
     "icon": "📡", "color": "#00e8ff", "ring": 1,
     "blurb": "The messenger. Ships finished videos to YouTube and TikTok through "
              "your connected accounts — or holds them private for your review.",
     "actions": ["Publish ready videos", "Connect a platform"]},

    # ----- outer ring: support & growth agents -----
    {"id": "daedalus", "name": "Daedalus", "title": "Titles & Thumbnails", "stage": None,
     "icon": "🏛️", "color": "#ffb340", "ring": 2,
     "blurb": "The craftsman. Packages each video with click-worthy titles and "
              "thumbnail concepts so the work actually gets seen.",
     "actions": ["Generate title options", "Draft thumbnail ideas"]},
    {"id": "argus", "name": "Argus", "title": "Guardian & Safety", "stage": None,
     "icon": "🛡️", "color": "#39ffa0", "ring": 2,
     "blurb": "The hundred-eyed watchman. Screens scripts and content against "
              "monetization and community rules before anything ships.",
     "actions": ["Audit last video", "Check policy risk"]},
    {"id": "atlas", "name": "Atlas", "title": "Analytics & Telemetry", "stage": None,
     "icon": "🌐", "color": "#00e8ff", "ring": 2,
     "blurb": "Carries the numbers. Pulls views, watch-time and growth across every "
              "platform into one place so you know what's working.",
     "actions": ["Show performance", "Compare channels"]},
    {"id": "blitz", "name": "Blitz", "title": "Virality Engine", "stage": None,
     "icon": "🎮", "color": "#ff8a3d", "ring": 2,
     "blurb": "Chases momentum. Flags formats and sounds that are spiking so you can "
              "ride a trend while it's still hot.",
     "actions": ["Find viral formats"]},
    {"id": "iris_comm", "name": "Echo", "title": "Community & Replies", "stage": None,
     "icon": "💬", "color": "#ff4f6a", "ring": 2,
     "blurb": "The voice back to your audience. Drafts replies to comments and surfaces "
              "the questions worth turning into your next video.",
     "actions": ["Draft comment replies"]},
    {"id": "chronos", "name": "Chronos", "title": "Scheduling & Cadence", "stage": None,
     "icon": "⏳", "color": "#b26bff", "ring": 2,
     "blurb": "Keeper of the calendar. Fully wired: turn on automation for a channel "
              "in the Channels panel and Chronos will spin up new videos on its own, "
              "spaced evenly across each day, catching up gracefully if the app was "
              "asleep. Requires an always-on host to run unattended.",
     "actions": ["Open channels to automate"]},
    {"id": "midas", "name": "Midas", "title": "Monetization", "stage": None,
     "icon": "💰", "color": "#ffd23d", "ring": 2,
     "blurb": "Tracks the money. Watches monetization eligibility and estimated "
              "revenue so growth turns into income.",
     "actions": ["Show revenue estimate", "Check eligibility"]},
    {"id": "jarvis", "name": "Jarvis", "title": "Personal Assistant", "stage": None,
     "icon": "🎙️", "color": "#ff2f9e", "ring": 2,
     "blurb": "Talk or text it directly. Checks real channel/job status and can start "
              "a video on command — by voice in the app, or by text message from "
              "anywhere once SMS is set up.",
     "actions": ["Open Jarvis", "Set up texting"]},
    {"id": "plutus", "name": "Plutus", "title": "Sponsorships & Deals", "stage": None,
     "icon": "🤝", "color": "#ffd23d", "ring": 2,
     "blurb": "Drafts brand-deal outreach messages once your numbers are worth "
              "pitching, using real stats pulled straight from Mission Control.",
     "actions": ["Draft a sponsor pitch"]},
    {"id": "mnemosyne", "name": "Mnemosyne", "title": "Research & Fact-Check", "stage": None,
     "icon": "📚", "color": "#39ffa0", "ring": 2,
     "blurb": "Keeper of sources. Digs up the real fact or study behind a shower "
              "thought before Athena scripts it, so nothing shipped is just made up.",
     "actions": ["Fact-check last script", "Find a source"]},
    {"id": "morpheus", "name": "Morpheus", "title": "Idea Incubator", "stage": None,
     "icon": "🌙", "color": "#b26bff", "ring": 2,
     "blurb": "Works the night shift. Lets half-formed ideas sit and mature between "
              "sessions instead of forcing a topic before it's ready.",
     "actions": ["Show incubating ideas"]},
    {"id": "janus", "name": "Janus", "title": "A/B Testing", "stage": None,
     "icon": "🎭", "color": "#ff8a3d", "ring": 2,
     "blurb": "Two-faced on purpose. Runs two hooks, thumbnails, or titles against "
              "each other and reports which one actually wins.",
     "actions": ["Start an A/B test"]},
    {"id": "calliope", "name": "Calliope", "title": "Sound & Music", "stage": None,
     "icon": "🎼", "color": "#00e8ff", "ring": 2,
     "blurb": "Picks the background bed and sound design for a video so narration "
              "never has to carry the whole mood alone.",
     "actions": ["Suggest a sound bed"]},
    {"id": "nike", "name": "Nike", "title": "Milestones", "stage": None,
     "icon": "🏆", "color": "#ffd23d", "ring": 2,
     "blurb": "Marks the wins. Flags subscriber, view, and streak milestones the "
              "moment they're hit, so progress doesn't slip by unnoticed.",
     "actions": ["Show recent milestones"]},
    {"id": "hestia", "name": "Hestia", "title": "Channel Health", "stage": None,
     "icon": "🔥", "color": "#ff4f6a", "ring": 2,
     "blurb": "Keeper of the hearth. Watches upload consistency and posting cadence "
              "so a channel's momentum doesn't quietly go cold.",
     "actions": ["Check posting streak"]},
]

STAGE_TO_AGENT = {a["stage"]: a["id"] for a in AGENTS if a["stage"]}


def roster():
    return {"core": CORE, "agents": AGENTS}
