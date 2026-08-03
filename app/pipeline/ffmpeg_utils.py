import json
import subprocess
from pathlib import Path

# No ffmpeg operation here should take anywhere near this long -- a full
# 9-segment assembly measures well under a minute. Without a timeout a hung
# ffmpeg (corrupt input, or one waiting on stdin) blocks the entire render
# thread indefinitely, which surfaces as a job stuck for hours with no error
# and nothing in the log. A ceiling turns that into a clean, diagnosable
# failure that the retry logic can act on.
FFMPEG_TIMEOUT_SECONDS = 600


def run(cmd: list[str], timeout: int = FFMPEG_TIMEOUT_SECONDS):
    """Run an ffmpeg/ffprobe command, raising with full stderr on failure."""
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            # Explicitly close stdin. ffmpeg will silently wait forever for
            # input in some situations if it inherits an open stdin, which is
            # a classic cause of "it just hangs and never finishes".
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"ffmpeg timed out after {timeout}s and was killed: {' '.join(cmd[:6])}... "
            "This usually means a corrupt or truncated input file from an earlier stage."
        )
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
                    width: int = 1080, height: int = 1920, zoom_in: bool = True,
                    fast_mode: bool = False):
    """
    Turn a single still image + its narration audio into a short vertical video clip
    with a slow pan/zoom (the classic 'faceless channel' motion effect), synced to the
    exact duration of that segment's audio.

    fast_mode skips the pan/zoom entirely and just renders the still. zoompan is by
    far the most CPU-expensive filter in the pipeline -- it re-renders every frame at
    a scaled-up size. On an underpowered instance that's the difference between a
    video finishing and a job appearing to hang, so it's worth having a mode that
    trades the motion effect for actually completing.
    """
    fps = 24
    frames = max(int(duration * fps), 1)

    if fast_mode:
        vf = (f"scale={width}:{height}:force_original_aspect_ratio=increase,"
              f"crop={width}:{height},format=yuv420p")
    else:
        # zoompan needs headroom above the output size so panning has room to move,
        # but only as much as the zoom actually uses (max 1.3x here).
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
        "-r", str(fps),
        "-t", str(duration),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
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
