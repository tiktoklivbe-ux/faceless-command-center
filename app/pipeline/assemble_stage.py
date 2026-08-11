"""
Stage 5: wires stages 2-4 together per segment and produces the final MP4.

For each segment, the Voice Agent (ElevenLabs narration) and the Visual Agent
(AI image generation) run CONCURRENTLY in separate threads -- they're
independent API calls, so there's no reason to make one wait on the other.
Once both finish, the Assembly Agent turns that pair into a Ken Burns clip.
After every segment is done, all clips are concatenated and captions burned
in.
"""
import shutil
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

from ..database import SessionLocal
from ..settings_store import get_setting
from . import voice_stage, visuals_stage, captions_stage, ffmpeg_utils


def assemble_video(db, channel, segments: list[dict], job_dir: Path, log, set_agent) -> tuple[Path, Path]:
    """
    segments: [{"narration": str, "visual_prompt": str}, ...]
    set_agent(name, status): reports "voice" | "visuals" | "assembly" -> "running" | "done" | "error"
    Returns (final_video_path, srt_path).
    """
    clips_dir = job_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    clip_paths = []
    timed_segments = []
    # Real measured timings, so the log shows where the time actually goes
    # rather than leaving you guessing which agent is the slow one.
    seg_times: list[float] = []
    total_voice = total_visual = total_render = 0.0
    job_started = time.time()
    # Skipping the pan/zoom is the single biggest render saving available, so
    # it's exposed as a setting for instances that can't keep up.
    fast_render = get_setting(db, "fast_render", "false") == "true"
    if fast_render:
        log("Fast render mode is ON — skipping the Ken Burns pan/zoom to save CPU.")

    set_agent("voice", "running")
    set_agent("visuals", "running")

    n = len(segments)
    # NOT a `with` block, deliberately. On exit ThreadPoolExecutor calls
    # shutdown(wait=True), which blocks until every worker thread finishes --
    # so if a thread is genuinely stuck, the timeout below fires and then the
    # block hangs FOREVER on cleanup. The job freezes with no error, no log
    # movement, and no timeout escape. Managing the executor manually lets a
    # stuck thread be abandoned instead of waited on.
    # Read these ONCE, up front, as plain values -- not left as attribute
    # access on `channel` inside the worker threads below. `channel` is a
    # SQLAlchemy object bound to the caller's session; every _log() call
    # elsewhere in the pipeline commits that session, and by default a
    # commit expires every object attached to it (channel included), so
    # the next attribute read has to silently re-fetch from the DB. Two
    # threads (voice + visual) doing that re-fetch on the SAME shared
    # session at the same moment is a real, actually-hit race -- it doesn't
    # always throw "not thread-safe", it can just as easily surface as
    # SQLAlchemy reporting the row itself as deleted/gone, which is exactly
    # what crashed a real render. Plain local variables have no session to
    # corrupt, so the threads below are now genuinely independent.
    voice_id = channel.voice_id
    visual_style = channel.visual_style

    pool = ThreadPoolExecutor(max_workers=2)
    try:
        for i, seg in enumerate(segments):
            seg_start = time.time()
            audio_path = clips_dir / f"seg_{i:02d}.mp3"
            image_path = clips_dir / f"seg_{i:02d}.png"

            # Once a couple of segments are done, the average is a far better
            # ETA than any hardcoded guess -- it reflects this job's actual
            # API latency and this machine's actual speed.
            eta_note = ""
            if seg_times:
                avg = sum(seg_times) / len(seg_times)
                remaining = avg * (n - i)
                eta_note = f" (~{int(remaining)}s left at {avg:.0f}s/segment)"
            log(f"Segment {i+1}/{n}: Voice Agent narrating + Visual Agent generating image, in parallel…{eta_note}")

            par_start = time.time()
            # Each thread gets its OWN session. SQLAlchemy sessions are not
            # thread-safe: two threads using one concurrently can corrupt its
            # internal state or deadlock on the underlying connection, with no
            # exception raised -- the threads simply never return, and the job
            # freezes here with no error. Both of these only read settings, so
            # separate short-lived sessions cost nothing.
            def _voice_task():
                s = SessionLocal()
                try:
                    return voice_stage.narrate_segment(s, seg["narration"], voice_id, audio_path)
                finally:
                    s.close()

            def _visual_task():
                s = SessionLocal()
                try:
                    return visuals_stage.generate_image(s, seg["visual_prompt"], visual_style, image_path)
                finally:
                    s.close()

            voice_future = pool.submit(_voice_task)
            visual_future = pool.submit(_visual_task)

            # Timeouts here matter: without them a worker that never returns
            # (a hung HTTP call that slipped past its own timeout, or a stuck
            # subprocess) blocks this thread forever, and the job sits with no
            # error and no log movement. The underlying API calls have 60-120s
            # timeouts, so 180s is a generous outer bound that still fails
            # rather than hanging.
            try:
                duration = voice_future.result(timeout=180)   # raises if the Voice Agent failed
                visual_future.result(timeout=180)             # raises if the Visual Agent failed
            except FuturesTimeout:
                voice_future.cancel()
                visual_future.cancel()
                raise RuntimeError(
                    f"Segment {i+1}/{n} timed out after 180s waiting for the Voice or Visual agent. "
                    "The API call didn't return. Abandoning this render rather than hanging."
                )
            par_elapsed = time.time() - par_start
            total_voice += par_elapsed  # voice+visuals run together, so this is their shared wall time
            log(f"Segment {i+1}/{n}: Voice + Visual done in {par_elapsed:.1f}s (narration is {duration:.1f}s long)")

            set_agent("assembly", "running")
            render_start = time.time()
            log(f"Segment {i+1}/{n}: Assembly Agent rendering the {duration:.1f}s clip…")
            clip_path = clips_dir / f"seg_{i:02d}.mp4"
            ffmpeg_utils.ken_burns_clip(image_path, audio_path, duration, clip_path,
                                         zoom_in=(i % 2 == 0), fast_mode=fast_render)
            render_elapsed = time.time() - render_start
            total_render += render_elapsed
            log(f"Segment {i+1}/{n}: clip rendered in {render_elapsed:.1f}s")

            clip_paths.append(clip_path)
            timed_segments.append({"narration": seg["narration"], "duration": duration})
            seg_times.append(time.time() - seg_start)

    finally:
        # wait=False so a stuck thread can't hold the whole render hostage.
        # cancel_futures drops anything not yet started.
        pool.shutdown(wait=False, cancel_futures=True)

    set_agent("voice", "done")
    set_agent("visuals", "done")

    t = time.time()
    log("Assembly Agent: stitching all clips together…")
    joined_path = job_dir / "joined.mp4"
    ffmpeg_utils.concat_clips(clip_paths, joined_path)
    concat_elapsed = time.time() - t

    t = time.time()
    log("Assembly Agent: building caption timings…")
    srt_path = job_dir / "captions.srt"
    captions_stage.build_srt(timed_segments, srt_path)

    log("Assembly Agent: burning captions into the video (final encode — the slowest single step)…")
    final_path = job_dir / "final.mp4"
    ffmpeg_utils.burn_subtitles(joined_path, srt_path, final_path)
    finalize_elapsed = time.time() - t

    # A breakdown of where the time actually went. This is what makes "it's
    # taking too long" answerable -- you can see whether the API calls or the
    # rendering are the bottleneck instead of guessing.
    total = time.time() - job_started
    size_mb = final_path.stat().st_size / 1024 / 1024 if final_path.exists() else 0
    log(
        f"Assembly complete in {total:.0f}s total — "
        f"voice+images {total_voice:.0f}s, clip rendering {total_render:.0f}s, "
        f"stitching {concat_elapsed:.0f}s, final encode {finalize_elapsed:.0f}s. "
        f"Output {size_mb:.1f}MB across {n} segments."
    )

    # Clean up intermediates now that final.mp4 exists. Without this every
    # job permanently leaves behind a PNG + MP3 + MP4 per segment plus the
    # pre-caption joined.mp4 -- at a few videos a day that fills the disk
    # within weeks, and a full disk fails jobs in a confusing, unrelated-
    # looking way. Only the final video and the SRT are actually needed.
    try:
        shutil.rmtree(clips_dir, ignore_errors=True)
        joined_path.unlink(missing_ok=True)
        joined_path.with_suffix(".txt").unlink(missing_ok=True)  # concat list file
    except OSError as e:
        log(f"Assembly Agent: cleanup skipped ({e}) -- video is still fine.")

    set_agent("assembly", "done")

    return final_path, srt_path
