import json
import os
import tempfile
import time
import signal
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
    """Run an ffmpeg/ffprobe command, raising with full stderr on failure.

    Uses Popen + explicit kill rather than subprocess.run(timeout=...). That
    matters more than it looks: subprocess.run raising TimeoutExpired does NOT
    terminate the child -- it abandons it. A hung ffmpeg therefore keeps
    running forever, still consuming CPU, and every retry spawns another one.
    They accumulate until the machine is saturated and NOTHING completes,
    including operations that would normally take seconds. That failure mode
    looks exactly like "the server got mysteriously slow".

    The process is started in its own process group so the whole tree can be
    killed -- ffmpeg can spawn helpers that would otherwise survive.
    """
    popen_kwargs = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "stdin": subprocess.DEVNULL,  # inherited stdin is a classic silent-hang cause
        "text": True,
    }
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True  # own process group, so killpg gets children too

    # Write ffmpeg's output to files rather than pipes. With PIPE, ffmpeg
    # blocks once the OS pipe buffer fills (~64KB) and nobody is draining it
    # -- and communicate() only starts draining after the call, so a chatty
    # ffmpeg can deadlock before producing any result. That deadlock looks
    # exactly like "rendering the clip..." and then silence forever.
    # Files have no such limit, and they also survive a kill, so the output
    # is still readable afterwards to see where it stopped.
    out_f = tempfile.TemporaryFile(mode="w+")
    err_f = tempfile.TemporaryFile(mode="w+")
    popen_kwargs["stdout"] = out_f
    popen_kwargs["stderr"] = err_f

    proc = subprocess.Popen(cmd, **popen_kwargs)
    # Heartbeat while waiting. Printing progress to the worker log makes the
    # difference between "ffmpeg is working slowly" and "ffmpeg is wedged"
    # visible -- previously both looked identical from outside: silence.
    _t0 = time.time()
    try:
        while True:
            try:
                proc.wait(timeout=15)
                break
            except subprocess.TimeoutExpired:
                elapsed = time.time() - _t0
                if elapsed >= timeout:
                    raise
                try:
                    err_f.seek(0, 2)
                    size = err_f.tell()
                except Exception:
                    size = -1
                print(f"[ffmpeg] still running {elapsed:.0f}s/{timeout}s "
                      f"(output {size} bytes) :: {' '.join(cmd[:4])}", flush=True)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        # Surface what ffmpeg actually managed to say before hanging -- this
        # is the only visibility into where it got stuck.
        try:
            err_f.seek(0)
            tail = err_f.read()[-1500:]
        except Exception:
            tail = "(couldn't read ffmpeg output)"
        finally:
            out_f.close(); err_f.close()
        raise RuntimeError(
            f"ffmpeg exceeded {timeout}s and was killed.\n"
            f"Command: {' '.join(cmd)}\n"
            f"--- ffmpeg output before it hung ---\n{tail}"
        )

    try:
        out_f.seek(0); err_f.seek(0)
        stdout, stderr = out_f.read(), err_f.read()
    finally:
        out_f.close(); err_f.close()

    if proc.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n--- stderr ---\n{(stderr or '')[-4000:]}")

    class _Result:
        pass
    result = _Result()
    result.stdout = stdout
    result.stderr = stderr
    result.returncode = proc.returncode
    return result


def _kill_tree(proc: subprocess.Popen):
    """Terminate a process and any children it spawned."""
    try:
        if os.name == "posix":
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                return
            except (ProcessLookupError, PermissionError):
                pass
        proc.kill()
    except Exception:
        pass


def kill_orphaned_ffmpeg(max_age_seconds: int = 900) -> int:
    """Kill ffmpeg processes that have been running far too long.

    Necessary cleanup for orphans left behind by the previous timeout bug,
    where a hung ffmpeg was abandoned rather than killed. Those accumulate,
    each holding CPU, until the machine is saturated and even trivial renders
    never finish. Called before each render so a fresh job isn't competing
    with the corpses of old ones.

    Deliberately conservative: only ffmpeg/ffprobe, only processes older than
    the cutoff (well beyond any legitimate render), never the current process.
    """
    if os.name != "posix":
        return 0
    killed = 0
    try:
        out = subprocess.run(
            ["ps", "-eo", "pid,etimes,comm"], capture_output=True, text=True, timeout=10
        ).stdout
    except Exception:
        return 0

    for line in out.splitlines()[1:]:
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        pid_s, etimes_s, comm = parts
        if comm.strip() not in ("ffmpeg", "ffprobe"):
            continue
        try:
            pid, etimes = int(pid_s), int(etimes_s)
        except ValueError:
            continue
        if pid == os.getpid() or etimes < max_age_seconds:
            continue
        try:
            os.kill(pid, signal.SIGKILL)
            killed += 1
        except (ProcessLookupError, PermissionError):
            pass
    return killed


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
