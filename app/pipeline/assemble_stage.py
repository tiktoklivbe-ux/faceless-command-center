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
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

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

    set_agent("voice", "running")
    set_agent("visuals", "running")

    with ThreadPoolExecutor(max_workers=2) as pool:
        for i, seg in enumerate(segments):
            audio_path = clips_dir / f"seg_{i:02d}.mp3"
            image_path = clips_dir / f"seg_{i:02d}.png"

            log(f"Segment {i+1}/{len(segments)}: Voice Agent + Visual Agent working in parallel…")
            voice_future = pool.submit(voice_stage.narrate_segment, db, seg["narration"], channel.voice_id, audio_path)
            visual_future = pool.submit(visuals_stage.generate_image, db, seg["visual_prompt"], channel.visual_style, image_path)

            # Timeouts here matter: without them a worker that never returns
            # (a hung HTTP call that slipped past its own timeout, or a stuck
            # subprocess) blocks this thread forever, and the job sits with no
            # error and no log movement. The underlying API calls have 60-120s
            # timeouts, so 180s is a generous outer bound that still fails
            # rather than hanging.
            duration = voice_future.result(timeout=180)   # raises if the Voice Agent failed
            visual_future.result(timeout=180)             # raises if the Visual Agent failed

            set_agent("assembly", "running")
            log(f"Segment {i+1}/{len(segments)}: Assembly Agent rendering {duration:.1f}s clip…")
            clip_path = clips_dir / f"seg_{i:02d}.mp4"
            ffmpeg_utils.ken_burns_clip(image_path, audio_path, duration, clip_path,
                                         zoom_in=(i % 2 == 0))
            clip_paths.append(clip_path)
            timed_segments.append({"narration": seg["narration"], "duration": duration})

    set_agent("voice", "done")
    set_agent("visuals", "done")

    log("Assembly Agent: concatenating segments…")
    joined_path = job_dir / "joined.mp4"
    ffmpeg_utils.concat_clips(clip_paths, joined_path)

    log("Assembly Agent: building captions…")
    srt_path = job_dir / "captions.srt"
    captions_stage.build_srt(timed_segments, srt_path)

    log("Assembly Agent: burning in captions…")
    final_path = job_dir / "final.mp4"
    ffmpeg_utils.burn_subtitles(joined_path, srt_path, final_path)

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
