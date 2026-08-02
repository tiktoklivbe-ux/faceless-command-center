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
    # zoompan needs headroom above the output size so panning has room to move,
    # but only as much as the zoom actually uses (max 1.3x here).
    #
    # This is the single most expensive step in the whole pipeline: zoompan
    # processes EVERY frame at the scaled-up size before downscaling to the
    # output. Working at 1.4x output (1512x2688) meant ~4M pixels per frame
    # when the result is only 1080x1920. Dropping to 1.1x gives the 1.3x zoom
    # all the room it needs while cutting the per-frame pixel work by ~40%.
    scale_w, scale_h = int(width * 1.1), int(height * 1.1)
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
        # ultrafast over veryfast: for a 1080x1920 clip built from a still
        # image there's very little visible quality difference, and it's
        # roughly 2.5x faster. File size grows somewhat, which doesn't matter
        # for an intermediate that gets re-encoded at concat anyway.
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        # NOTE: no -threads cap. That was added while chasing an OOM theory
        # that later proved wrong, and it forced ffmpeg onto a single core --
        # a straight multiple-times slowdown on any multi-core host.
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
        # This step re-encodes the ENTIRE video, and with no preset specified
        # ffmpeg defaults to "medium" -- measured ~4x slower here for no
        # visible benefit on flat-background caption burn-in. This was a large
        # share of total assembly time.
        #
        # superfast rather than ultrafast for THIS step specifically: it's the
        # final artifact that gets uploaded, and ultrafast produced a ~2.5x
        # larger file (89MB vs 35MB on a 64s test video) which just moves the
        # cost to upload time instead. The per-segment clips above stay on
        # ultrafast since they're intermediates that get re-encoded here anyway.
        "-c:v", "libx264", "-preset", "superfast", "-crf", "23",
        "-c:a", "copy",
        str(out_path),
    ])
