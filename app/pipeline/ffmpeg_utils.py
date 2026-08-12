import json
import logging
import os
import tempfile
import time
import signal
import subprocess
from pathlib import Path

log = logging.getLogger("ffmpeg_utils")

# No ffmpeg operation here should take anywhere near this long -- a full
# 9-segment assembly measures well under a minute. Without a timeout a hung
# ffmpeg (corrupt input, or one waiting on stdin) blocks the entire render
# thread indefinitely, which surfaces as a job stuck for hours with no error
# and nothing in the log. A ceiling turns that into a clean, diagnosable
# failure that the retry logic can act on.
FFMPEG_TIMEOUT_SECONDS = 600

# libx264 picks its default thread count from the number of CPUs it can see
# -- and inside a cgroup-limited container that's typically the HOST's full
# core count, not the slice actually allocated to the container. A real
# failing render on this app's Render "starter" plan (0.5 CPU, 512MB RAM)
# logged "threads=24" for a single-segment clip: 24 encoder threads fighting
# over half a CPU core and a 512MB memory ceiling, which is consistent with
# ffmpeg being silently OOM-killed (0 frames encoded, no ffmpeg-printed
# error, process just stops) rather than reporting a normal encoding error.
# Capping threads explicitly keeps the encoder's own resource use bounded to
# something that plan can actually support. Overridable via env var for a
# host with more headroom.
FFMPEG_THREADS = int(os.environ.get("FFMPEG_THREADS", "2"))


def run(cmd: list[str], timeout: int = FFMPEG_TIMEOUT_SECONDS, cwd: str | None = None):
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
    if cwd:
        popen_kwargs["cwd"] = str(cwd)

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
        # A negative returncode means the process died to a signal (POSIX),
        # not a normal ffmpeg-detected error -- e.g. -9 is SIGKILL, the
        # signature of the OOM killer. That distinction was previously
        # invisible: the message only ever showed ffmpeg's own stderr, which
        # is often empty or cut off mid-encode when something ELSE kills the
        # process out from under it, making "ffmpeg failed" and "ffmpeg got
        # OOM-killed" look identical. Surfacing it directly turns a guessing
        # game into an immediate diagnosis.
        signal_note = ""
        if proc.returncode < 0:
            signal_note = (f" (killed by signal {-proc.returncode}"
                            f"{' -- SIGKILL, consistent with an out-of-memory kill' if -proc.returncode == 9 else ''})")
        raise RuntimeError(
            f"Command failed (exit code {proc.returncode}{signal_note}): {' '.join(cmd)}\n"
            f"--- stderr ---\n{(stderr or '')[-4000:]}"
        )

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


def kill_worker_by_pid(pid: int) -> bool:
    """Terminate a specific worker process (and its tree) by OS PID.

    This is what a cancel actually needed and never had: the worker for a
    render runs in its own OS process (see orchestrator.dispatch_job), so
    cancelling only that job's DB row never stopped the real work -- the
    process kept running, oblivious, and overwrote the cancelled status once
    it finished a stage. Given only a bare PID (the caller is a web request,
    not the process itself, so there's no Popen handle to call .kill() on),
    this reaches the actual OS process directly.

    Returns True if a process was found and signalled, False if it was
    already gone (which is a normal, fine outcome -- the job had already
    finished or crashed on its own).
    """
    if pid is None:
        return False
    try:
        if os.name == "posix":
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
                return True
            except ProcessLookupError:
                return False
            except PermissionError:
                os.kill(pid, signal.SIGKILL)
                return True
        else:
            # No process groups on Windows; taskkill /T walks the tree so any
            # ffmpeg the worker spawned dies with it, not just the Python
            # process itself.
            result = subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True, text=True, timeout=10,
            )
            return result.returncode == 0
    except Exception:
        log.warning("Couldn't kill worker pid %s", pid, exc_info=True)
        return False


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


def available() -> str | None:
    """Whether ffmpeg AND ffprobe are actually runnable, checked up front.

    Without this, a missing install surfaces as a bare
    "FileNotFoundError: [WinError 2] The system cannot find the file
    specified" three stages into a render (first hit inside probe_duration,
    after the script and voice call already ran) -- which reads as a mystery
    crash rather than "install ffmpeg". Checking both here means the job
    fails in under a second, before burning any API calls, with an actual
    instruction attached.

    Returns None if both are usable, or an error string naming what's missing.
    """
    import shutil
    missing = [name for name in ("ffmpeg", "ffprobe") if shutil.which(name) is None]
    if not missing:
        return None
    plural = "s" if len(missing) > 1 else ""
    return (
        f"{' and '.join(missing)} {'are' if plural else 'is'} not installed, or not on PATH. "
        f"Every video needs both to narrate, render, and stitch clips. "
        f"On Windows: install via 'winget install ffmpeg' (or download from ffmpeg.org) and "
        f"make sure the install's bin folder is on PATH, then restart this app. "
        f"On the deployed server: this should already be handled by the Dockerfile "
        f"(apt-get install ffmpeg) -- if it's still missing there, the service likely isn't "
        f"actually building from that Dockerfile."
    )


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
        "-c:v", "libx264", "-preset", "ultrafast", "-threads", str(FFMPEG_THREADS), "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        "-shortest",
        str(out_path),
    ])


def concat_clips(clip_paths: list[Path], out_path: Path):
    list_file = out_path.with_suffix(".txt")
    list_file.write_text("\n".join(f"file '{p.resolve()}'" for p in clip_paths), encoding="utf-8")
    run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c", "copy", str(out_path),
    ])


def burn_subtitles(video_path: Path, srt_path: Path, out_path: Path):
    # force_style keeps captions readable on any background: bold white text, black outline.
    style = "FontName=Arial,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=120"

    # ffmpeg's filtergraph syntax uses ':' to separate a filter's own
    # arguments -- which collides with a Windows path's drive-letter colon.
    # Escaping it (C\:/path/...) is the commonly-documented fix, and it WAS
    # tried here first, but a real run against this exact ffmpeg build
    # (9.0-full_build) still misread the escaped path and failed with
    # "Unable to parse 'original_size' ... as image size" -- confirmed by
    # actually re-running it. Sidestepping the whole escaping question is
    # more robust than chasing this build's exact quoting rules: run ffmpeg
    # FROM the srt's own directory and hand the filter a bare filename, so
    # there's no drive letter or colon anywhere in the argument for it to
    # misparse. Verified working against the real files from a failed job.
    run([
        "ffmpeg", "-y", "-i", str(video_path),
        "-vf", f"subtitles={srt_path.name}:force_style='{style}'",
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
        "-c:v", "libx264", "-preset", "superfast", "-threads", str(FFMPEG_THREADS), "-crf", "23",
        "-c:a", "copy",
        str(out_path),
    ], cwd=srt_path.parent)
