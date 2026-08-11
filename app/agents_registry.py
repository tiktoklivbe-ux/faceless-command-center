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
    "name": "HQ",
    "title": "Orchestrator",
    "blurb": "The conductor. Routes your intent to the right agents, sequences the "
             "pipeline, and keeps the whole constellation in sync.",
    "icon": "✦",
    "color": "#e8ecef",
}

# stage -> which pipeline JobStatus/agent_status key this node reflects.
# stage=None means it's a support agent not tied to the linear render pipeline.
AGENTS = [
    # ----- inner ring: the core production pipeline -----
    {"id": "apollo", "name": "Riley", "title": "Ideation & Trends", "stage": "ideation",
     "icon": "🔭", "color": "#cfd6dc", "ring": 1,
     "blurb": "Scouts topics and trends, then pitches the ideas most likely to land "
              "for your niche. The spark at the front of every video.",
     "actions": ["Pitch 5 new ideas", "Scan trending topics"]},
    {"id": "athena", "name": "Sarah", "title": "Script & Strategy", "stage": "script",
     "icon": "🦉", "color": "#a8b0b8", "ring": 1,
     "blurb": "Turns a topic into a tight, original narration script with a hook, a "
              "point of view, and a payoff — the part YouTube's rules actually reward.",
     "actions": ["Rewrite last script", "Draft a script"]},
    {"id": "orpheus", "name": "Marcus", "title": "Voice & Narration", "stage": "voice",
     "icon": "🎙️", "color": "#e8ecef", "ring": 1,
     "blurb": "Narrates every line through ElevenLabs in your chosen voice, one clean "
              "take per segment so captions land perfectly in sync.",
     "actions": ["Preview a voice", "Re-narrate last video"]},
    {"id": "iris", "name": "Devon", "title": "Visuals & Imagery", "stage": "visuals",
     "icon": "🎨", "color": "#b8c0c6", "ring": 1,
     "blurb": "Generates a cinematic image for every beat of the script (Gemini / "
              "OpenAI / Stability), matched to your channel's visual style.",
     "actions": ["Regenerate visuals", "Test image style"]},
    {"id": "hephaestus", "name": "Theo", "title": "Assembly & Forge", "stage": "assembly",
     "icon": "🔨", "color": "#9aa2a9", "ring": 1,
     "blurb": "The forge. Animates each still with a Ken Burns move, stitches the "
              "clips, burns in captions, and outputs the finished vertical video.",
     "actions": ["Rebuild last video"]},
    {"id": "hermes", "name": "Nina", "title": "Publishing", "stage": "publish",
     "icon": "📡", "color": "#e8ecef", "ring": 1,
     "blurb": "The messenger. Ships finished videos to YouTube and TikTok through "
              "your connected accounts — or holds them private for your review.",
     "actions": ["Publish ready videos", "Connect a platform"]},

    # ----- outer ring: support & growth agents -----
    {"id": "daedalus", "name": "Jules", "title": "Titles & Thumbnails", "stage": None,
     "icon": "🏛️", "color": "#9aa2a9", "ring": 2,
     "blurb": "The craftsman. Packages each video with click-worthy titles and "
              "thumbnail concepts so the work actually gets seen.",
     "actions": ["Generate title options", "Draft thumbnail ideas"]},
    {"id": "argus", "name": "Priya", "title": "Guardian & Safety", "stage": None,
     "icon": "🛡️", "color": "#b8c0c6", "ring": 2,
     "blurb": "The hundred-eyed watchman. Screens scripts and content against "
              "monetization and community rules before anything ships.",
     "actions": ["Audit last video", "Check policy risk"]},
    {"id": "atlas", "name": "Omar", "title": "Analytics & Telemetry", "stage": None,
     "icon": "🌐", "color": "#e8ecef", "ring": 2,
     "blurb": "Carries the numbers. Pulls views, watch-time and growth across every "
              "platform into one place so you know what's working.",
     "actions": ["Show performance", "Compare channels"]},
    {"id": "blitz", "name": "Kai", "title": "Virality Engine", "stage": None,
     "icon": "🎮", "color": "#949ba2", "ring": 2,
     "blurb": "Chases momentum. Flags formats and sounds that are spiking so you can "
              "ride a trend while it's still hot.",
     "actions": ["Find viral formats"]},
    {"id": "iris_comm", "name": "Maya", "title": "Community & Replies", "stage": None,
     "icon": "💬", "color": "#d16a6a", "ring": 2,
     "blurb": "The voice back to your audience. Drafts replies to comments and surfaces "
              "the questions worth turning into your next video.",
     "actions": ["Draft comment replies"]},
    {"id": "chronos", "name": "Ellis", "title": "Scheduling & Cadence", "stage": None,
     "icon": "⏳", "color": "#a8b0b8", "ring": 2,
     "blurb": "Keeper of the calendar. Fully wired: turn on automation for a channel "
              "in the Channels panel and Chronos will spin up new videos on its own, "
              "spaced evenly across each day, catching up gracefully if the app was "
              "asleep. Requires an always-on host to run unattended.",
     "actions": ["Open channels to automate"]},
    {"id": "midas", "name": "Cole", "title": "Monetization", "stage": None,
     "icon": "💰", "color": "#8d959c", "ring": 2,
     "blurb": "Tracks the money. Watches monetization eligibility and estimated "
              "revenue so growth turns into income.",
     "actions": ["Show revenue estimate", "Check eligibility"]},
    {"id": "plutus", "name": "Rosa", "title": "Sponsorships & Deals", "stage": None,
     "icon": "🤝", "color": "#8d959c", "ring": 2,
     "blurb": "Drafts brand-deal outreach messages once your numbers are worth "
              "pitching, using real stats pulled straight from Mission Control.",
     "actions": ["Draft a sponsor pitch"]},
    {"id": "mnemosyne", "name": "Ivan", "title": "Research & Fact-Check", "stage": None,
     "icon": "📚", "color": "#b8c0c6", "ring": 2,
     "blurb": "Keeper of sources. Digs up the real fact or study behind a shower "
              "thought before Athena scripts it, so nothing shipped is just made up.",
     "actions": ["Fact-check last script", "Find a source"]},
    {"id": "morpheus", "name": "Wren", "title": "Idea Incubator", "stage": None,
     "icon": "🌙", "color": "#a8b0b8", "ring": 2,
     "blurb": "Works the night shift. Lets half-formed ideas sit and mature between "
              "sessions instead of forcing a topic before it's ready.",
     "actions": ["Show incubating ideas"]},
    {"id": "janus", "name": "Dana", "title": "A/B Testing", "stage": None,
     "icon": "🎭", "color": "#949ba2", "ring": 2,
     "blurb": "Two-faced on purpose. Runs two hooks, thumbnails, or titles against "
              "each other and reports which one actually wins.",
     "actions": ["Start an A/B test"]},
    {"id": "calliope", "name": "Leo", "title": "Sound & Music", "stage": None,
     "icon": "🎼", "color": "#e8ecef", "ring": 2,
     "blurb": "Picks the background bed and sound design for a video so narration "
              "never has to carry the whole mood alone.",
     "actions": ["Suggest a sound bed"]},
    {"id": "nike", "name": "Tess", "title": "Milestones", "stage": None,
     "icon": "🏆", "color": "#8d959c", "ring": 2,
     "blurb": "Marks the wins. Flags subscriber, view, and streak milestones the "
              "moment they're hit, so progress doesn't slip by unnoticed.",
     "actions": ["Show recent milestones"]},
    {"id": "hestia", "name": "Bea", "title": "Channel Health", "stage": None,
     "icon": "🔥", "color": "#d16a6a", "ring": 2,
     "blurb": "Keeper of the hearth. Watches upload consistency and posting cadence "
              "so a channel's momentum doesn't quietly go cold.",
     "actions": ["Check posting streak"]},
]

STAGE_TO_AGENT = {a["stage"]: a["id"] for a in AGENTS if a["stage"]}


def roster():
    return {"core": CORE, "agents": AGENTS}


def agent_name(agent_id: str) -> str:
    """Current display name for an agent, so a rename here is the only place
    it needs to happen -- callers that used to hardcode a codename (e.g. log
    messages) should pull it from here instead of drifting out of sync."""
    return next((a["name"] for a in AGENTS if a["id"] == agent_id), agent_id.title())


# Step-by-step breakdown of what each agent actually does, shown when you zoom
# into their building. Only the agents that genuinely run get real steps --
# the rest are honestly marked as not yet functional rather than given
# invented workflows that would imply they do something.
AGENT_STEPS = {
    "apollo": {
        "works": False,
        "steps": [
            "Would scan trends and pitch topics",
            "Not wired up — topics currently come from the script agent",
        ],
    },
    "athena": {
        "works": True,
        "runtime": "10–25 seconds",
        "steps": [
            "Reads the channel's niche and style notes",
            "Sends one request to Claude asking for a full video script",
            "Gets back a title, description, and 8–10 narration segments",
            "Each segment also carries a visual prompt for the image agent",
            "Retries up to 3 times if the response comes back malformed",
            "Saves the script to the job and hands off",
        ],
    },
    "orpheus": {
        "works": True,
        "runtime": "1–3 seconds per segment",
        "steps": [
            "Takes one segment's narration text",
            "Sends it to ElevenLabs with the channel's chosen voice",
            "Saves the returned MP3",
            "Measures its exact duration — this drives the clip length",
            "Falls back to timed silence if no ElevenLabs key is set",
        ],
    },
    "iris": {
        "works": True,
        "runtime": "1–5 seconds per segment",
        "steps": [
            "Takes the segment's visual prompt from the script",
            "Adds framing instructions (vertical 9:16, no text or watermarks)",
            "Sends it to the configured image provider",
            "Saves the returned PNG",
            "Falls back to a generated placeholder if no key is set",
            "Runs at the same time as the voice agent, not after it",
        ],
    },
    "hephaestus": {
        "works": True,
        "runtime": "3–8 seconds per clip",
        "steps": [
            "Pairs each image with its narration audio",
            "Renders a clip with a slow pan and zoom, synced to the audio length",
            "Repeats for every segment",
            "Stitches all the clips together in order",
            "Builds caption timings from each segment's real duration",
            "Burns the captions into the final video",
            "Deletes the intermediate files so the disk doesn't fill up",
        ],
    },
    "hermes": {
        "works": True,
        "runtime": "20–60 seconds",
        "steps": [
            "Only runs if auto-publish is switched on for the channel",
            "Uploads the finished MP4 to YouTube via the Data API",
            "Sets the title and description written by the script agent",
            "Also posts to TikTok if that account is connected",
            "Records the resulting video ID against the job",
        ],
    },
    "chronos": {
        "works": True,
        "runtime": "checks every 5 minutes",
        "steps": [
            "Wakes on a timer and looks at each channel",
            "Checks how many videos it's made today against the target",
            "Spaces them out rather than firing them all at once",
            "Won't start a new render while one is already running",
            "Picks up jobs left queued before creating anything new",
            "Retries jobs that stalled, and gives up after 2 hours",
        ],
    },
}


def steps_for(agent_id: str) -> dict:
    """Workflow breakdown for an agent, or an honest placeholder."""
    return AGENT_STEPS.get(agent_id, {
        "works": False,
        "steps": ["This agent is scaffolding — it appears in the village but has no logic behind it yet."],
    })
