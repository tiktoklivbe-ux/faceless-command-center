"""
Stage 4: build an .srt caption file from the real per-segment audio durations
computed in voice_stage. Because each segment's duration comes from an actual
rendered audio file (not an estimate), captions land in sync automatically.

Captions are word-by-word (one word on screen at a time, TikTok/Reels-style)
rather than a full sentence held on screen for the whole segment. ElevenLabs'
standard narration call doesn't return per-word timestamps, so each word's
slice of the segment's real, measured duration is estimated by its length --
a longer word holds the screen a bit longer than "a" or "the" does, which
reads much closer to natural speech pacing than a flat equal split would.
"""
from pathlib import Path


def _fmt(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def build_srt(segments: list[dict], out_path: Path):
    """segments: list of {"narration": str, "duration": float}"""
    lines = []
    t = 0.0
    idx = 1
    for seg in segments:
        duration = seg["duration"]
        words = seg["narration"].split()
        if not words:
            t += duration
            continue

        # +1 so even a one-letter word still gets a fair minimum share of
        # the segment's time, rather than nearly zero.
        weights = [len(w) + 1 for w in words]
        total_weight = sum(weights)

        cursor = t
        for word, weight in zip(words, weights):
            word_dur = duration * (weight / total_weight)
            start, end = cursor, cursor + word_dur
            lines.append(str(idx))
            idx += 1
            lines.append(f"{_fmt(start)} --> {_fmt(end)}")
            lines.append(word)
            lines.append("")
            cursor = end
        t += duration
    out_path.write_text("\n".join(lines), encoding="utf-8")
