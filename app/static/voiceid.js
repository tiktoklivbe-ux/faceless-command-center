/**
 * voiceid.js — approximate "is this probably Tom or a guest" voice gate.
 *
 * How it works: estimates fundamental frequency (pitch) from live mic audio
 * using autocorrelation (a standard, well-established DSP technique — not
 * anything exotic). Compares a live reading against a stored average/range
 * for the app's one owner. That's the entire method.
 *
 * What this is NOT: a real speaker-verification / voice-biometrics system.
 * Two people with similar-pitched voices can be confused for each other,
 * and your own reading can shift with a cold, tiredness, or a noisy room.
 * Treat it as a fun gate for a greeting, never as anything security-related.
 *
 * "Learning": every time a live sample is accepted as a match, it's POSTed
 * back to /api/jarvis/voiceprint, which blends it into the stored profile
 * with a small fixed weight — so the profile drifts slowly to track your
 * voice over time instead of staying frozen at first enrollment.
 */
(function () {
  let audioCtx = null, analyser = null, micStream = null;
  let profile = null; // {enrolled, avg_pitch, min_pitch, max_pitch}
  let sampling = false;
  let sampleBuffer = [];
  let sampleTimer = null;

  async function ensureMic() {
    if (audioCtx) return true;
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      return true;
    } catch (_) {
      audioCtx = null;
      return false;
    }
  }

  /**
   * Autocorrelation pitch detector. Returns estimated frequency in Hz, or
   * -1 if the signal is too quiet / no clear pitch found. Standard
   * technique: find the lag that best matches the waveform against a
   * shifted copy of itself; that lag is the fundamental period.
   */
  function detectPitch(buf, sampleRate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return -1; // too quiet / silence

    // trim leading/trailing near-silence so autocorrelation isn't thrown
    // off by dead air at the edges of the buffer
    let start = 0, end = SIZE - 1;
    const thresh = 0.2;
    for (let i = 0; i < SIZE / 2; i++) { if (Math.abs(buf[i]) >= thresh) { start = i; break; } }
    for (let i = 1; i < SIZE / 2; i++) { if (Math.abs(buf[SIZE - i]) >= thresh) { end = SIZE - i; break; } }
    const trimmed = buf.slice(start, end);
    const n = trimmed.length;
    if (n < 8) return -1;

    const c = new Float32Array(n);
    for (let lag = 0; lag < n; lag++) {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) sum += trimmed[i] * trimmed[i + lag];
      c[lag] = sum;
    }

    // skip the initial downward slope from lag 0 (always the strongest,
    // trivially "matches itself") to find the first real peak after it
    let d = 0;
    while (d < n - 1 && c[d] > c[d + 1]) d++;
    let maxVal = -1, maxPos = -1;
    for (let i = d; i < n; i++) {
      if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
    }
    if (maxPos <= 0) return -1;

    // parabolic interpolation around the peak for a sub-sample-accurate lag
    let T0 = maxPos;
    const x1 = c[T0 - 1] ?? c[T0];
    const x2 = c[T0];
    const x3 = c[T0 + 1] ?? c[T0];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a !== 0) T0 = T0 - b / (2 * a);
    if (T0 <= 0) return -1;

    const freq = sampleRate / T0;
    if (freq < 60 || freq > 500) return -1; // outside plausible human speech range
    return freq;
  }

  function readPitchOnce() {
    if (!analyser) return -1;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    return detectPitch(buf, audioCtx.sampleRate);
  }

  function startSampling() {
    if (sampling) return;
    sampling = true;
    sampleBuffer = [];
    sampleTimer = setInterval(() => {
      const p = readPitchOnce();
      if (p > 0) sampleBuffer.push(p);
    }, 80);
  }

  /** Stops collecting and returns {avg, min, max} over whatever was
   * gathered since the last call, or null if nothing usable was captured. */
  function stopSamplingAndGet() {
    sampling = false;
    if (sampleTimer) clearInterval(sampleTimer);
    sampleTimer = null;
    if (!sampleBuffer.length) return null;
    const avg = sampleBuffer.reduce((a, b) => a + b, 0) / sampleBuffer.length;
    const min = Math.min(...sampleBuffer);
    const max = Math.max(...sampleBuffer);
    sampleBuffer = [];
    return { avg, min, max };
  }

  async function fetchProfile() {
    try {
      const r = await fetch("/api/jarvis/voiceprint");
      profile = await r.json();
    } catch (_) {
      profile = { enrolled: false };
    }
    return profile;
  }

  async function reportMatch(sample) {
    try {
      const r = await fetch("/api/jarvis/voiceprint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ avg_pitch: sample.avg, min_pitch: sample.min, max_pitch: sample.max }),
      });
      profile = await r.json();
    } catch (_) { /* non-fatal, next comparison just uses the stale profile */ }
  }

  /**
   * Compares a live sample against the stored profile. Tolerance is
   * intentionally generous (±18%) since this is pitch-only and natural
   * voice variation (energy, congestion, mood) easily moves it that much --
   * a tight tolerance would just mean it doesn't recognize you half the
   * time, which defeats the point of a friendly gate.
   */
  function isLikelyMatch(sample) {
    if (!profile || !profile.enrolled) return null; // no profile yet -- can't judge
    const tolerance = 0.18;
    const diff = Math.abs(sample.avg - profile.avg_pitch) / profile.avg_pitch;
    return diff <= tolerance;
  }

  /**
   * A soft, hedged guess bucket from pitch alone -- deliberately NOT phrased
   * as "male/female" or a confident age claim, since pitch alone genuinely
   * can't tell those apart reliably (a higher adult voice and a child's
   * voice overlap a lot in range). This is presented as a rough hint, not a
   * fact about anyone.
   */
  function softGuess(avgHz) {
    if (!avgHz || avgHz <= 0) return null;
    if (avgHz > 260) return "a higher-pitched voice — could be a kid, could just be a naturally higher voice, hard to say from pitch alone";
    if (avgHz > 165) return "a voice in a typically higher vocal range";
    return "a voice in a typically lower vocal range";
  }

  window.VoiceID = {
    ensureMic,
    startSampling,
    stopSamplingAndGet,
    fetchProfile,
    reportMatch,
    isLikelyMatch,
    softGuess,
    getProfile: () => profile,
  };
})();
