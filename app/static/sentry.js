/**
 * sentry.js — Sentry Mode: webcam motion detection.
 *
 * WHAT THIS ACTUALLY DOES: watches the webcam and raises an alert when it
 * sees significant movement in the frame. It works by frame differencing --
 * comparing each frame to the previous one and measuring how many pixels
 * changed. That's the same basic technique most simple motion-alert systems
 * use, and it's genuinely reliable at detecting "something moved."
 *
 * WHAT IT DOES NOT DO: it cannot tell WHO moved. It doesn't do face
 * recognition and it doesn't know you from anyone else. "Motion detected
 * while armed" is the entire claim -- if you walk into frame yourself, it
 * will alert on you. Treat it as a motion alarm, not a security system that
 * recognizes intruders.
 *
 * Everything runs locally in the browser. No video frames are uploaded
 * anywhere -- the pixel comparison happens on-device and only the fact that
 * motion occurred is ever reported.
 */
(function () {
  let stream = null;
  let video = null;
  let canvas = null;
  let ctx = null;
  let prevFrame = null;
  let rafId = null;
  let armed = false;
  let armedAt = 0;
  let lastAlertAt = 0;
  let onMotion = null;
  let calibrating = false;

  // Tuning. sensitivity = fraction of pixels that must change to count as
  // motion. 0.02 (2%) ignores lighting flicker and sensor noise but catches
  // a person entering frame.
  let sensitivity = 0.02;
  const PIXEL_DELTA_THRESHOLD = 30;   // per-pixel brightness change that counts as "changed"
  const ALERT_COOLDOWN_MS = 10000;    // don't re-alert more than once per 10s
  const WARMUP_MS = 3000;             // ignore the first few seconds so arming itself doesn't trigger it
  const SAMPLE_W = 160, SAMPLE_H = 120; // downscale for speed -- full res is pointless for motion

  async function start(opts) {
    if (armed) return { ok: true, already: true };
    onMotion = opts && opts.onMotion;
    if (opts && typeof opts.sensitivity === "number") sensitivity = opts.sensitivity;

    if (!navigator.mediaDevices?.getUserMedia) {
      return { ok: false, error: "This browser can't access a camera." };
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    } catch (e) {
      return { ok: false, error: "Camera access denied or unavailable." };
    }

    video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    await video.play().catch(() => {});

    canvas = document.createElement("canvas");
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    ctx = canvas.getContext("2d", { willReadFrequently: true });

    prevFrame = null;
    armed = true;
    armedAt = Date.now();
    lastAlertAt = 0;
    calibrating = true;
    loop();
    return { ok: true };
  }

  function stop() {
    armed = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) { video.srcObject = null; video = null; }
    prevFrame = null;
  }

  function loop() {
    if (!armed) return;
    try {
      ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
      const frame = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);

      if (prevFrame) {
        const cur = frame.data, prev = prevFrame.data;
        let changed = 0;
        const total = SAMPLE_W * SAMPLE_H;
        // Compare luminance only -- cheaper than per-channel and less prone
        // to false positives from colour-balance shifts.
        for (let i = 0; i < cur.length; i += 4) {
          const lumCur = (cur[i] * 299 + cur[i + 1] * 587 + cur[i + 2] * 114) / 1000;
          const lumPrev = (prev[i] * 299 + prev[i + 1] * 587 + prev[i + 2] * 114) / 1000;
          if (Math.abs(lumCur - lumPrev) > PIXEL_DELTA_THRESHOLD) changed++;
        }
        const ratio = changed / total;
        const now = Date.now();
        const warmedUp = now - armedAt > WARMUP_MS;
        if (warmedUp) calibrating = false;

        if (warmedUp && ratio > sensitivity && now - lastAlertAt > ALERT_COOLDOWN_MS) {
          lastAlertAt = now;
          if (onMotion) {
            onMotion({
              ratio,
              percent: Math.round(ratio * 100),
              at: new Date().toISOString(),
            });
          }
        }
        if (window.SentryMode._onLevel) window.SentryMode._onLevel(ratio);
      }
      prevFrame = frame;
    } catch (_) { /* a dropped frame is not worth tearing the loop down over */ }

    // ~10fps is plenty for motion detection and leaves the CPU alone --
    // running this at 60fps would be pure waste.
    setTimeout(() => { rafId = requestAnimationFrame(loop); }, 100);
  }

  window.SentryMode = {
    start,
    stop,
    isArmed: () => armed,
    isCalibrating: () => calibrating,
    setSensitivity: (v) => { sensitivity = v; },
    getSensitivity: () => sensitivity,
    _onLevel: null,
    onLevel(fn) { window.SentryMode._onLevel = fn; },
  };
})();
