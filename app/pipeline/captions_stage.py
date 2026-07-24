"""
Stage 4: build an .srt caption file from the real per-segment audio durations
computed in voice_stage. Because each segment's duration comes from an actual
rendered audio file (not an estimate), captions land in sync automatically.
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
    for i, seg in enumerate(segments, start=1):
        start, end = t, t + seg["duration"]
        lines.append(str(i))
        lines.append(f"{_fmt(start)} --> {_fmt(end)}")
        lines.append(seg["narration"])
        lines.append("")
        t = end
    out_path.write_text("\n".join(lines), encoding="utf-8")
