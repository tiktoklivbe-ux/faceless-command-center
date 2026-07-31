"""
Per-agent diagnostic knowledge.

Each pipeline stage knows three things about itself:
  - how long it should normally take (so "stuck" is measurable, not a guess)
  - what actually goes wrong with it, matched against real error text
  - what to DO about each failure, specifically

This is what lets Jarvis answer "why did that fail and how do I fix it"
with something real instead of a generic apology. The fixes are written as
concrete next actions, and each one is tagged with who can perform it:

  "auto"    -- Jarvis can do it himself right now (e.g. retry the job)
  "user"    -- only you can do it (e.g. generate an API key on a website)
  "inspect" -- needs a look at logs/data before anything can be decided

That tagging matters: telling someone "I'll fix it" and then not being able
to is worse than saying up front which half of the problem is yours.
"""

# Expected wall-clock duration per stage for a typical ~60s video, in seconds.
# Used to decide whether something is slow, stalled, or normal. These are
# deliberately generous -- flagging healthy jobs as stuck is its own problem.
STAGE_TIMING = {
    "script":   {"typical": 15,  "slow": 45,   "stalled": 120},
    "voice":    {"typical": 30,  "slow": 90,   "stalled": 300},
    "visuals":  {"typical": 60,  "slow": 180,  "stalled": 420},
    "assembly": {"typical": 90,  "slow": 240,  "stalled": 600},
    "publish":  {"typical": 45,  "slow": 120,  "stalled": 300},
}

# error-text fragment -> diagnosis. Matched case-insensitively as substrings
# against the job's error_message and recent log lines.
FAILURE_PATTERNS = {
    "script": [
        {"match": ["unterminated string", "expecting ',' delimiter", "expecting value", "unexpected end"],
         "cause": ("The script response was cut off mid-way, so the JSON couldn't be parsed. This is a "
                   "response-length ceiling being hit, NOT the model returning garbage -- the script was "
                   "fine, it just ran out of room before finishing."),
         "fix": "Already addressed by raising the limit and adding salvage for partial responses. Retry the job.",
         "who": "auto"},
        {"match": ["401", "invalid x-api-key", "authentication"],
         "cause": "The Anthropic API key is missing, wrong, or was revoked.",
         "fix": "Add a valid Claude key in Settings. Get one at console.anthropic.com under API Keys.",
         "who": "user"},
        {"match": ["429", "rate limit"],
         "cause": "Hit Anthropic's rate limit -- too many requests too quickly.",
         "fix": "Wait a couple of minutes and retry. If it keeps happening, lower videos-per-day or switch to Haiku.",
         "who": "auto"},
        {"match": ["credit", "quota", "billing"],
         "cause": "The Anthropic account is out of credit.",
         "fix": "Top up billing at console.anthropic.com. Nothing in the pipeline can run without this.",
         "who": "user"},
        {"match": ["json", "parse", "decode"],
         "cause": "The model returned something that wasn't valid JSON, so the script couldn't be read.",
         "fix": "Usually transient -- retry. If it repeats, the prompt may need tightening.",
         "who": "auto"},
    ],
    "voice": [
        {"match": ["401", "unauthorized", "invalid api key"],
         "cause": "The ElevenLabs key is missing or invalid.",
         "fix": "Add a valid ElevenLabs key in Settings. Get one at elevenlabs.io under Profile -> API Keys.",
         "who": "user"},
        {"match": ["quota", "credit", "character limit", "exceeded"],
         "cause": "Out of ElevenLabs character quota for this billing period.",
         "fix": "Either wait for the quota to reset, upgrade the ElevenLabs plan, or make shorter videos.",
         "who": "user"},
        {"match": ["voice_not_found", "voice not found", "404"],
         "cause": "The selected voice no longer exists in the ElevenLabs account.",
         "fix": "Pick a different voice in Settings -- the saved one was removed or was never added to your library.",
         "who": "user"},
    ],
    "visuals": [
        {"match": ["401", "unauthorized", "api key"],
         "cause": "The image provider's API key is missing or invalid.",
         "fix": "Check the image provider key in Settings, or switch image_provider to 'placeholder' to keep producing videos meanwhile.",
         "who": "user"},
        {"match": ["quota", "billing", "credit"],
         "cause": "Out of credit with the image provider.",
         "fix": "Top up that provider, or switch to a different one in Settings. Placeholder mode works with no key at all.",
         "who": "user"},
        {"match": ["safety", "content policy", "rejected"],
         "cause": "The image provider refused a prompt on content-policy grounds.",
         "fix": "Usually one specific segment's imagery. Retrying often produces a different prompt that passes.",
         "who": "auto"},
    ],
    "assembly": [
        {"match": ["ffmpeg", "returned non-zero", "invalid data"],
         "cause": "ffmpeg failed on one of the segment clips -- often a truncated image or audio file from an earlier stage.",
         "fix": "Retry the job; the upstream file usually re-downloads cleanly. If it repeats on the same segment, that segment's source asset is bad.",
         "who": "auto"},
        {"match": ["no space", "disk", "quota exceeded"],
         "cause": "The disk is full. Intermediate render files can accumulate if cleanup failed.",
         "fix": "Free space on the persistent disk, or increase its size. Old job folders under storage/jobs are the usual culprit.",
         "who": "user"},
        {"match": ["killed", "memory", "oom"],
         "cause": "The render process was killed mid-way -- typically the container running out of memory, or a redeploy landing during the render.",
         "fix": "Retry it. If it happens repeatedly, the instance needs more RAM.",
         "who": "auto"},
    ],
    "publish": [
        {"match": ["401", "invalid_grant", "unauthorized"],
         "cause": "The YouTube connection expired or was revoked.",
         "fix": "Reconnect the channel to YouTube in the Channels panel -- the refresh token is no longer valid.",
         "who": "user"},
        {"match": ["quota", "exceeded"],
         "cause": "Hit YouTube's daily upload/API quota.",
         "fix": "Wait for the quota to reset (it rolls over daily) and retry. Publishing fewer videos per day avoids this.",
         "who": "auto"},
        {"match": ["duplicate", "already uploaded"],
         "cause": "YouTube rejected this as a duplicate of an existing upload.",
         "fix": "Nothing to fix -- the video is already up. Safe to mark this job done.",
         "who": "user"},
    ],
}

GENERIC_FALLBACK = {
    "cause": "No recognized error pattern in the logs.",
    "fix": "Look at the job's full progress log for the last line before it stopped -- that's usually where it broke.",
    "who": "inspect",
}


def diagnose(stage: str, error_text: str) -> dict:
    """Match an error against a stage's known failure modes."""
    haystack = (error_text or "").lower()
    for pattern in FAILURE_PATTERNS.get(stage, []):
        if any(frag in haystack for frag in pattern["match"]):
            return {"stage": stage, "cause": pattern["cause"], "fix": pattern["fix"], "who_can_fix": pattern["who"]}
    return {"stage": stage, **GENERIC_FALLBACK, "who_can_fix": GENERIC_FALLBACK["who"]}


def timing_verdict(stage: str, elapsed_seconds: float) -> dict:
    """Is this stage running normally, slowly, or is it stalled?"""
    t = STAGE_TIMING.get(stage)
    if not t:
        return {"stage": stage, "verdict": "unknown", "note": "No timing baseline for this stage."}
    if elapsed_seconds >= t["stalled"]:
        return {"stage": stage, "verdict": "stalled",
                "note": f"Been {int(elapsed_seconds)}s; anything past {t['stalled']}s means the worker probably died.",
                "expected_seconds": t["typical"]}
    if elapsed_seconds >= t["slow"]:
        return {"stage": stage, "verdict": "slow",
                "note": f"Been {int(elapsed_seconds)}s vs a typical {t['typical']}s. Still running, just slower than usual.",
                "expected_seconds": t["typical"]}
    return {"stage": stage, "verdict": "normal",
            "note": f"{int(elapsed_seconds)}s elapsed, typical is {t['typical']}s.",
            "expected_seconds": t["typical"]}


def estimate_remaining(current_stage: str) -> dict:
    """Rough ETA to finish, from whichever stage a job is currently in."""
    order = ["script", "voice", "visuals", "assembly", "publish"]
    if current_stage not in order:
        return {"eta_seconds": None, "note": "Can't estimate from this stage."}
    remaining = order[order.index(current_stage):]
    total = sum(STAGE_TIMING[s]["typical"] for s in remaining if s in STAGE_TIMING)
    return {
        "eta_seconds": total,
        "eta_human": f"about {max(1, round(total / 60))} minute{'s' if total >= 90 else ''}",
        "stages_left": remaining,
        "note": "Based on typical timings; real duration varies with segment count and API latency.",
    }
