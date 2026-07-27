/**
 * jarvis.js — voice assistant panel.
 *
 * Two listening modes, both using the browser's built-in Web Speech API
 * (no extra libraries, works wherever Chrome/Edge/Chromium-based browsers
 * run -- Safari and Firefox don't support SpeechRecognition yet, so those
 * fall back to typing only, clearly labeled rather than silently broken):
 *
 *   - Push-to-talk: tap the mic, speak, it sends automatically on pause.
 *   - "Hey Jarvis" wake mode: toggle it on, it listens continuously in the
 *     background (auto-restarting itself, since the browser API times out
 *     on its own every so often) and only sends what you say AFTER it
 *     hears the wake phrase.
 *
 * Talks to /api/jarvis/chat, which has real tool-use against this app
 * (channel/job status, starting videos) -- so answers here can reflect the
 * actual state of your Command Center, not just chit-chat.
 */
(function () {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const WAKE_PHRASES = ["hey jarvis", "hey, jarvis", "ok jarvis", "okay jarvis"];

  let recognizer = null;
  let mode = "off"; // "off" | "ptt" | "wake"
  let awake = false; // in wake mode: have we heard the wake phrase and are capturing a command?
  let history = [];
  let restartTimer = null;
  let sessionToken = 0; // bumped every time we start/stop, so stale onend/onerror callbacks from a previous session can be ignored
  let currentOrb = null;
  let sessionGreeted = false; // whether we've already given the Tom/guest greeting for the current mic session

  function bubble(role, text) {
    const div = document.createElement("div");
    div.className = `jarvis-msg jarvis-${role}`;
    div.textContent = text;
    return div;
  }

  function speak(text) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    u.pitch = 0.95;
    u.onstart = () => { if (currentOrb) currentOrb.setSpeaking(true); };
    u.onend = () => { if (currentOrb) currentOrb.setSpeaking(false); };
    u.onerror = () => { if (currentOrb) currentOrb.setSpeaking(false); };
    window.speechSynthesis.speak(u);
  }

  function stripWakePhrase(text) {
    const low = text.toLowerCase();
    for (const w of WAKE_PHRASES) {
      const idx = low.indexOf(w);
      if (idx !== -1) return text.slice(idx + w.length).replace(/^[,.\s]+/, "");
    }
    return text;
  }

  function containsWakePhrase(text) {
    const low = text.toLowerCase();
    return WAKE_PHRASES.some((w) => low.includes(w));
  }

  async function send(log, text) {
    if (!text.trim()) return;
    log.appendChild(bubble("user", text));
    log.scrollTop = log.scrollHeight;
    history.push({ role: "user", content: text });

    const thinking = bubble("assistant", "…");
    thinking.classList.add("jarvis-thinking");
    log.appendChild(thinking);
    log.scrollTop = log.scrollHeight;

    try {
      const resp = await fetch("/api/jarvis/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, history: history.slice(-10) }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `Request failed (${resp.status})`);
      }
      const data = await resp.json();
      thinking.remove();
      log.appendChild(bubble("assistant", data.reply));
      log.scrollTop = log.scrollHeight;
      history.push({ role: "assistant", content: data.reply });
      speak(data.reply);
    } catch (e) {
      thinking.remove();
      log.appendChild(bubble("assistant", `Error: ${e.message}`));
      log.scrollTop = log.scrollHeight;
    }
  }

  /**
   * A canvas orb that idles with a gentle pulse, glows brighter and reacts
   * to real mic input while listening, and does a lively synthetic wobble
   * while Jarvis is speaking (browser TTS doesn't expose real amplitude, so
   * this fakes a plausible one rather than sitting static).
   * Fails gracefully: if getUserMedia is denied/unavailable, listening mode
   * just falls back to a faster idle pulse instead of throwing or hanging.
   */
  function createOrbVisualizer(canvas) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf = null;
    let t = 0;
    let listening = false;
    let speaking = false;
    let audioCtx = null, analyser = null, freqData = null, micStream = null;
    let micLevel = 0; // 0..1, smoothed

    async function ensureMic() {
      if (audioCtx || !navigator.mediaDevices?.getUserMedia) return;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(micStream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        source.connect(analyser);
      } catch (_) {
        // Denied, no mic, or insecure context -- listening mode just uses
        // the synthetic idle pulse instead. Not fatal.
        audioCtx = null;
      }
    }

    function currentLevel() {
      if (analyser && freqData) {
        analyser.getByteFrequencyData(freqData);
        let sum = 0;
        for (let i = 0; i < freqData.length; i++) sum += freqData[i];
        const avg = sum / freqData.length / 255; // 0..1
        micLevel += (avg - micLevel) * 0.3;
        return micLevel;
      }
      // synthetic fallback when no real mic data is available
      return listening ? 0.35 + Math.sin(t * 6) * 0.15 : 0;
    }

    function draw() {
      t += reducedMotion ? 0 : 0.02;
      ctx.clearRect(0, 0, W, H);

      let radius = 34;
      let glow = 24;
      let color = "#00e8ff";

      if (speaking) {
        const wobble = reducedMotion ? 6 : Math.sin(t * 9) * 6 + Math.sin(t * 5.3) * 4;
        radius = 40 + wobble;
        glow = 46 + Math.abs(wobble) * 2;
        color = "#b26bff";
      } else if (listening) {
        const level = currentLevel();
        radius = 34 + level * 26;
        glow = 26 + level * 60;
        color = "#ff2f9e";
      } else {
        // idle: a static glow when reduced motion is on, gentle breathing otherwise
        radius = reducedMotion ? 34 : 34 + Math.sin(t * 1.4) * 3;
        glow = reducedMotion ? 22 : 22 + Math.sin(t * 1.4) * 6;
      }

      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = glow;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      g.addColorStop(0, "#eafcff");
      g.addColorStop(0.45, color);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // thin orbiting ring for a HUD feel
      ctx.save();
      ctx.strokeStyle = `${color}55`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 18, t * 0.5, t * 0.5 + Math.PI * 1.4);
      ctx.stroke();
      ctx.restore();

      raf = requestAnimationFrame(draw);
    }

    return {
      start() { if (!raf) draw(); },
      stop() {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        if (micStream) micStream.getTracks().forEach((tr) => tr.stop());
        if (audioCtx) audioCtx.close().catch(() => {});
        audioCtx = null; analyser = null; micStream = null;
      },
      setListening(on) {
        listening = on;
        if (on) ensureMic();
      },
      setSpeaking(on) { speaking = on; },
    };
  }

  window.renderJarvisPanel = function (body) {
    body.innerHTML = `
      <div class="jarvis-wrap">
        <h1 style="margin-bottom:2px">🎙️ Jarvis</h1>
        <div class="bp-sub">Talks back, and can check real channel/job status or start a video. Doesn't control your computer yet — that's a separate future build.</div>
        <div class="jarvis-orb-wrap">
          <canvas id="jarvis-orb" width="160" height="160"></canvas>
        </div>
        <div class="jarvis-log" id="jarvis-log"></div>
        <div class="jarvis-input-row">
          <button class="icon-btn" id="jarvis-mic" title="Hold to talk">🎤</button>
          <button class="icon-btn" id="jarvis-wake" title="Toggle 'Hey Jarvis' always-listening mode">👂</button>
          <input id="jarvis-text" placeholder="Type, or use the mic…" autocomplete="off"/>
          <button class="icon-btn" id="jarvis-send" title="Send">▸</button>
        </div>
        <div class="bp-sub" id="jarvis-status" style="margin-top:6px"></div>
        <div class="jarvis-sms-box">
          <b>Text Jarvis from your phone</b>
          <p>Get a Twilio phone number, then set its "A message comes in" webhook to:</p>
          <code id="jarvis-sms-url">/api/jarvis/sms</code>
          <p class="jarvis-sms-note">Same Jarvis, same tools — texting or talking in-app both reach the same brain. Keep that URL private; anyone who has it can trigger it.</p>
        </div>

        <div class="jarvis-sms-box">
          <b>Voice ID <span style="font-weight:400; opacity:0.7;">(approximate — not real security)</span></b>
          <p id="jarvis-voiceid-status">Checking enrollment…</p>
          <button class="btn" id="jarvis-enroll-btn" style="margin-top:6px">🎙️ Enroll My Voice</button>
          <p class="jarvis-sms-note">Estimates pitch from a few seconds of speech and compares it later. Easily fooled by a similar-pitched voice — it's a fun gate, not identity verification. It slowly adapts to your voice over time as it's used.</p>
        </div>
      </div>
    `;

    const log = $("#jarvis-log");
    const input = $("#jarvis-text");
    const micBtn = $("#jarvis-mic");
    const wakeBtn = $("#jarvis-wake");
    const sendBtn = $("#jarvis-send");
    const status = $("#jarvis-status");
    const orbCanvas = $("#jarvis-orb");

    const orb = createOrbVisualizer(orbCanvas);
    currentOrb = orb;
    orb.start(); // ambient idle animation always runs; ramps up when listening/speaking
    window.stopJarvisSession = () => { orb.stop(); currentOrb = null; };

    log.appendChild(bubble("assistant",
      "Hey, I'm here. Type, hold the mic to talk once, or turn on 'Hey Jarvis' mode to leave the mic open."));

    const smsUrlEl = $("#jarvis-sms-url");
    if (smsUrlEl) smsUrlEl.textContent = `${window.location.origin}/api/jarvis/sms`;

    const voiceStatus = $("#jarvis-voiceid-status");
    const enrollBtn = $("#jarvis-enroll-btn");
    if (window.VoiceID) {
      VoiceID.fetchProfile().then((p) => {
        if (voiceStatus) {
          voiceStatus.textContent = p.enrolled
            ? `Enrolled — ${Math.round(p.avg_pitch)}Hz average, refined over ${p.sample_count} sample${p.sample_count === 1 ? "" : "s"}.`
            : "Not enrolled yet — Jarvis can't tell you apart from a guest until you enroll.";
        }
      });
      if (enrollBtn) {
        enrollBtn.addEventListener("click", async () => {
          const ok = await VoiceID.ensureMic();
          if (!ok) { toast("Couldn't access the mic to enroll."); return; }
          enrollBtn.disabled = true;
          enrollBtn.textContent = "Listening… speak naturally for a few seconds";
          VoiceID.startSampling();
          setTimeout(async () => {
            const sample = VoiceID.stopSamplingAndGet();
            enrollBtn.disabled = false;
            enrollBtn.textContent = "🎙️ Enroll My Voice";
            if (!sample) { toast("Didn't catch enough voice — try again somewhere quieter."); return; }
            await VoiceID.reportMatch(sample);
            const p = VoiceID.getProfile();
            if (voiceStatus && p) {
              voiceStatus.textContent = `Enrolled — ${Math.round(p.avg_pitch)}Hz average, refined over ${p.sample_count} sample${p.sample_count === 1 ? "" : "s"}.`;
            }
            toast("Voice enrolled.");
          }, 3500);
        });
      }
    } else if (enrollBtn) {
      enrollBtn.disabled = true;
      if (voiceStatus) voiceStatus.textContent = "Voice ID module didn't load.";
    }

    sendBtn.addEventListener("click", () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      send(log, text);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendBtn.click(); });

    if (!SpeechRecognition) {
      micBtn.disabled = true;
      wakeBtn.disabled = true;
      status.textContent = "Voice isn't supported in this browser (try Chrome or Edge) — typing still works fully.";
      return;
    }

    // Orb requests mic access lazily the first time listening actually
    // starts (inside setListening(true)) rather than eagerly here, so the
    // permission prompt is tied to a clear user action (tapping the mic).

    function stopEverything() {
      mode = "off";
      awake = false;
      sessionGreeted = false;
      sessionToken++; // invalidate any in-flight recognizer's callbacks
      clearTimeout(restartTimer);
      micBtn.classList.remove("jarvis-mic-active");
      wakeBtn.classList.remove("jarvis-mic-active");
      status.textContent = "";
      orb.setListening(false);
      if (window.VoiceID) VoiceID.stopSamplingAndGet(); // discard, just stop the timer
      if (recognizer) {
        try { recognizer.abort(); } catch (_) {}
      }
    }

    window.stopJarvisSession = () => {
      stopEverything();
      orb.stop();
      currentOrb = null;
    };

    async function maybeGreet(log) {
      if (sessionGreeted || !window.VoiceID) return;
      sessionGreeted = true;
      const sample = VoiceID.stopSamplingAndGet();
      VoiceID.startSampling(); // immediately resume for the rest of this session
      if (!sample) return; // not enough signal to judge, skip silently

      const match = VoiceID.isLikelyMatch(sample);
      if (match === null) return; // nobody enrolled yet -- nothing to compare against
      if (match) {
        const greeting = "Hey sir.";
        log.appendChild(bubble("assistant", greeting));
        speak(greeting);
        VoiceID.reportMatch(sample); // slowly refine the profile toward the current voice
      } else {
        const guess = VoiceID.softGuess(sample.avg);
        const greeting = `Hey there — this doesn't sound like Tom to me. I'm his assistant, Jarvis.` +
          (guess ? ` Rough guess from pitch: ${guess}. Not a real ID, just a hint.` : "");
        log.appendChild(bubble("assistant", greeting));
        speak(greeting);
      }
      log.scrollTop = log.scrollHeight;
    }

    function handleResult(text) {
      if (mode === "ptt") {
        maybeGreet(log).then(() => send(log, text));
        return;
      }
      // wake mode
      if (!awake) {
        if (containsWakePhrase(text)) {
          awake = true;
          status.textContent = "Listening for your command…";
          const rest = stripWakePhrase(text);
          if (rest) {
            awake = false;
            maybeGreet(log).then(() => send(log, rest));
            status.textContent = "Say 'Hey Jarvis' any time.";
          }
        }
      } else {
        awake = false;
        status.textContent = "Say 'Hey Jarvis' any time.";
        maybeGreet(log).then(() => send(log, text));
      }
    }

    // Creates a brand-new SpeechRecognition instance for this session rather
    // than reusing one across mode switches. Browsers are inconsistent about
    // calling start() again before a previous session has fully wound down
    // (some throw InvalidStateError, some just silently misbehave) -- a
    // fresh instance per session, guarded by a token so stale events from an
    // old instance can't affect the new one, sidesteps that entirely.
    function startSession(continuous) {
      sessionToken++;
      const myToken = sessionToken;
      const r = new SpeechRecognition();
      r.continuous = continuous;
      r.interimResults = false;
      r.lang = "en-US";

      r.onresult = (e) => {
        if (myToken !== sessionToken) return;
        const text = e.results[e.results.length - 1][0].transcript;
        handleResult(text);
      };
      r.onerror = (e) => {
        if (myToken !== sessionToken) return;
        if (e.error === "no-speech" || e.error === "aborted") return; // expected, keep going
        status.textContent = `Mic error: ${e.error}`;
      };
      r.onend = () => {
        if (myToken !== sessionToken) return; // a newer session has already taken over
        if (mode === "wake") {
          restartTimer = setTimeout(() => {
            if (myToken !== sessionToken) return;
            startSession(true);
          }, 250);
        } else if (mode === "ptt") {
          mode = "off";
          micBtn.classList.remove("jarvis-mic-active");
          if (window.VoiceID) VoiceID.stopSamplingAndGet(); // discard -- ptt session is over, don't leave the sampler running
        }
      };

      recognizer = r;
      orb.setListening(true);
      if (window.VoiceID) {
        VoiceID.ensureMic().then((ok) => { if (ok) VoiceID.startSampling(); });
      }
      try {
        r.start();
      } catch (_) {
        // start() can throw if called too soon after a previous stop; a
        // short retry covers that race without user-visible impact.
        setTimeout(() => { if (myToken === sessionToken) { try { r.start(); } catch (__) {} } }, 200);
      }
    }

    micBtn.addEventListener("click", () => {
      if (mode === "ptt") { stopEverything(); return; }
      stopEverything();
      mode = "ptt";
      micBtn.classList.add("jarvis-mic-active");
      status.textContent = "Listening…";
      startSession(false);
    });

    wakeBtn.addEventListener("click", () => {
      if (mode === "wake") { stopEverything(); return; }
      stopEverything();
      mode = "wake";
      awake = false;
      wakeBtn.classList.add("jarvis-mic-active");
      status.textContent = "Say 'Hey Jarvis' any time.";
      startSession(true);
    });
  };
})();
