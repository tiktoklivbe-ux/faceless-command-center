import json
import subprocess
from pathlib import Path


def run(cmd: list[str]):
    """Run an ffmpeg/ffprobe command, raising with full stderr on failure."""
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n--- stderr ---\n{proc.stderr[-4000:]}")
    return proc


def probe_duration(path: Path) -> float:
    proc = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "json", str(path),
    ])
    data = json.loads(proc.stdout)
    return float(data["format"]["duration"])


def make_silence(out_path: Path, duration: float):
    run([
        "ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=mono",
        "-t", str(max(duration, 0.3)), "-q:a", "9", "-acodec", "libmp3lame", str(out_path),
    ])


def ken_burns_clip(image_path: Path, audio_path: Path, duration: float, out_path: Path,
                    width: int = 1080, height: int = 1920, zoom_in: bool = True):
    """
    Turn a single still image + its narration audio into a short vertical video clip
    with a slow pan/zoom (the classic 'faceless channel' motion effect), synced to the
    exact duration of that segment's audio.
    """
    fps = 30
    frames = max(int(duration * fps), 1)
    # zoompan needs the input scaled up so panning has room to move -- but only
    # as much headroom as the zoom actually uses (max zoom here is ~1.3x).
    # This used to scale to 2x (2160x3840), which meant zoompan buffering
    # ~25MB uncompressed frames; on a 512MB instance that gets the whole
    # container OOM-killed mid-render, which looks like a job silently
    # freezing with no error rather than a clean failure. 1.4x gives the pan
    # all the room it needs at a fraction of the memory.
    scale_w, scale_h = int(width * 1.4), int(height * 1.4)
    if zoom_in:
        zoom_expr = f"min(zoom+0.0007,1.3)"
    else:
        zoom_expr = f"if(lte(zoom,1.0),1.3,max(zoom-0.0007,1.0))"
    vf = (
        f"scale={scale_w}:{scale_h},"
        f"zoompan=z='{zoom_expr}':d={frames}:s={width}x{height}:fps={fps},"
        f"format=yuv420p"
    )
    run([
        "ffmpeg", "-y",
        "-loop", "1", "-i", str(image_path),
        "-i", str(audio_path),
        "-vf", vf,
        "-t", str(duration),
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-threads", "1",  # limit ffmpeg's own memory footprint on a small instance
        "-c:a", "aac", "-b:a", "160k",
        "-shortest",
        str(out_path),
    ])


def concat_clips(clip_paths: list[Path], out_path: Path):
    list_file = out_path.with_suffix(".txt")
    list_file.write_text("\n".join(f"file '{p.resolve()}'" for p in clip_paths))
    run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c", "copy", str(out_path),
    ])


def burn_subtitles(video_path: Path, srt_path: Path, out_path: Path):
    # force_style keeps captions readable on any background: bold white text, black outline.
    style = "FontName=Arial,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=120"
    run([
        "ffmpeg", "-y", "-i", str(video_path),
        "-vf", f"subtitles={srt_path}:force_style='{style}'",
        "-c:a", "copy",
        str(out_path),
    ])
