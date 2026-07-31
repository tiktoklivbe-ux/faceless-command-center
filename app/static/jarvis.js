/**
 * jarvis.js — voice assistant, full-page experience.
 *
 * What changed from v1:
 *  - Real human-sounding voice via ElevenLabs (reusing the key already in
 *    Settings) instead of the robotic browser speech synthesis. Falls back
 *    to browser speech automatically if no ElevenLabs key is set, or if
 *    that request fails for any reason.
 *  - The orb reacts to the ACTUAL amplitude of Jarvis's real voice while
 *    speaking (via a Web Audio analyser on the playing audio), not a fake
 *    wobble -- only falls back to a synthetic pulse when browser TTS is
 *    what's actually playing, since that engine exposes no usable waveform.
 *  - Full-page split layout: big orb + controls on the left, a tabbed
 *    Chat / Settings / More area on the right, instead of a small modal.
 *  - Settings tab: personality, wake word, ElevenLabs voice picker, model
 *    speed, read-aloud toggle, accent color, custom greeting -- all real,
 *    saved through the same /api/settings endpoint as everything else.
 *  - Faster by default: Jarvis now uses Haiku unless you pick otherwise in
 *    Settings, specifically because the tool-use loop can mean a few
 *    sequential API calls in one turn and a slower model compounds that.
 *
 * Listening still works the same two ways as before:
 *   - Push-to-talk: tap the mic, speak, sends automatically on pause.
 *   - "Hey Jarvis" wake mode: continuous listening, only acts after the
 *     wake phrase (or your custom one, if you set one in Settings).
 */
(function () {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const DEFAULT_WAKE_PHRASES = ["hey jarvis", "hey, jarvis", "ok jarvis", "okay jarvis"];

  let recognizer = null;
  let mode = "off"; // "off" | "wake" (always-on listening)
  let awake = false;
  let history = [];
  let restartTimer = null;
  let silenceTimer = null;
  let pendingText = "";
  let lastSentText = "";
  let lastSentAt = 0;
  let jarvisSpeaking = false; // true while Jarvis's own audio is playing, so the mic doesn't feed his voice back in as a command
  let sessionToken = 0;
  let currentOrb = null;
  let wakePhrases = DEFAULT_WAKE_PHRASES.slice();
  let jarvisSettings = null; // cached copy of the jarvis_* settings, refreshed on panel open and after saving

  function bubble(role, text) {
    const div = document.createElement("div");
    div.className = `jarvis-msg jarvis-${role}`;
    div.textContent = text;
    return div;
  }

  // ---------------------------------------------------------------- speech output
  let currentAudioEl = null;
  let currentAudioUrl = null;
  let speechAnalyser = null;
  let speechAudioCtx = null;

  function speakViaBrowser(text) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    u.pitch = 0.95;
    u.onstart = () => { jarvisSpeaking = true; if (currentOrb) currentOrb.setSpeaking(true, null); };
    u.onend = () => { jarvisSpeaking = false; if (currentOrb) currentOrb.setSpeaking(false, null); };
    u.onerror = () => { jarvisSpeaking = false; if (currentOrb) currentOrb.setSpeaking(false, null); };
    window.speechSynthesis.speak(u);
  }

  function getSpeechAmplitude() {
    if (!speechAnalyser) return null;
    const data = new Uint8Array(speechAnalyser.frequencyBinCount);
    speechAnalyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum / data.length / 255;
  }

  function getSpeechBars() {
    if (!speechAnalyser) return null;
    const data = new Uint8Array(speechAnalyser.frequencyBinCount);
    speechAnalyser.getByteFrequencyData(data);
    return data;
  }

  async function speak(text) {
    if (jarvisSettings && jarvisSettings.jarvis_read_aloud === false) return;

    try {
      const resp = await fetch("/api/jarvis/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) throw new Error("no elevenlabs");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);

      if (currentAudioEl) {
        currentAudioEl.pause();
        currentAudioEl.remove();
        if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
      }
      const audio = new Audio(url);
      currentAudioEl = audio;
      currentAudioUrl = url;

      try {
        if (!speechAudioCtx) speechAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = speechAudioCtx.createMediaElementSource(audio);
        speechAnalyser = speechAudioCtx.createAnalyser();
        speechAnalyser.fftSize = 64;
        source.connect(speechAnalyser);
        speechAnalyser.connect(speechAudioCtx.destination);
      } catch (_) {
        speechAnalyser = null;
      }

      audio.onplay = () => { jarvisSpeaking = true; if (currentOrb) currentOrb.setSpeaking(true, getSpeechAmplitude, getSpeechBars); };
      audio.onended = () => { jarvisSpeaking = false; if (currentOrb) currentOrb.setSpeaking(false, null); URL.revokeObjectURL(url); };
      audio.onerror = () => { jarvisSpeaking = false; if (currentOrb) currentOrb.setSpeaking(false, null); };
      await audio.play();
    } catch (_) {
      speakViaBrowser(text);
    }
  }

  // ---------------------------------------------------------------- wake phrase handling
  function stripWakePhrase(text) {
    const low = text.toLowerCase();
    for (const w of wakePhrases) {
      const idx = low.indexOf(w);
      if (idx !== -1) return text.slice(idx + w.length).replace(/^[,.\s]+/, "");
    }
    return text;
  }

  function containsWakePhrase(text) {
    const low = text.toLowerCase();
    return wakePhrases.some((w) => low.includes(w));
  }

  // ---------------------------------------------------------------- chat
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

  // ---------------------------------------------------------------- orb visualizer
  function createOrbVisualizer(canvas) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf = null;
    let t = 0;
    let listening = false;
    let speaking = false;
    let getSpeakAmp = null;
    let getSpeakBars = null;
    let audioCtx = null, analyser = null, freqData = null, micStream = null;
    let micLevel = 0;
    let accent = "#00e8ff";

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
        audioCtx = null;
      }
    }

    function currentLevel() {
      if (analyser && freqData) {
        analyser.getByteFrequencyData(freqData);
        let sum = 0;
        for (let i = 0; i < freqData.length; i++) sum += freqData[i];
        const avg = sum / freqData.length / 255;
        micLevel += (avg - micLevel) * 0.3;
        return micLevel;
      }
      return listening ? 0.35 + Math.sin(t * 6) * 0.15 : 0;
    }

    function updateEqBars() {
      const eqEl = document.getElementById("jarvis-eq");
      if (!eqEl) return;
      const bars = eqEl.children;
      let data = null;
      if (speaking && getSpeakBars) {
        data = getSpeakBars();
      } else if (listening && analyser && freqData) {
        analyser.getByteFrequencyData(freqData);
        data = freqData;
      }
      const n = bars.length;
      for (let i = 0; i < n; i++) {
        let v = 0.08;
        if (data && data.length) {
          const idx = Math.floor((i / n) * data.length);
          v = Math.max(0.08, data[idx] / 255);
        } else if (!reducedMotion) {
          v = 0.08 + Math.abs(Math.sin(t * 2 + i * 0.7)) * 0.05;
        }
        bars[i].style.height = `${Math.round(v * 100)}%`;
      }
    }

    // Precomputed sphere points, distributed evenly using the Fibonacci
    // sphere method (golden-angle spiral) -- gives a much more uniform dot
    // distribution than naive lat/long stepping, which bunches points at
    // the poles.
    const SPHERE_POINTS = (() => {
      const pts = [];
      const N = 900;
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / (N - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const theta = golden * i;
        pts.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
      }
      return pts;
    })();

    function draw() {
      t += reducedMotion ? 0 : 0.02;
      ctx.clearRect(0, 0, W, H);

      let level = 0;
      let color = accent;
      if (speaking) {
        if (getSpeakAmp) {
          const a = getSpeakAmp();
          level = a === null || a === undefined ? 0.3 : a;
        } else {
          level = reducedMotion ? 0.4 : 0.35 + Math.sin(t * 9) * 0.15;
        }
        color = "#b26bff";
      } else if (listening) {
        level = currentLevel();
        color = "#ff2f9e";
      }

      const baseR = Math.min(W, H) * 0.30;
      // sphere swells with audio level -- real amplitude when available
      const R = baseR * (1 + level * 0.16);
      const rotY = t * 0.35;
      const rotX = 0.42; // fixed slight tilt so it reads as a 3D globe, not a flat disc

      const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX), sinX = Math.sin(rotX);

      for (let i = 0; i < SPHERE_POINTS.length; i++) {
        const [px, py, pz] = SPHERE_POINTS[i];
        // rotate around Y, then X
        const x1 = px * cosY - pz * sinY;
        const z1 = px * sinY + pz * cosY;
        const y2 = py * cosX - z1 * sinX;
        const z2 = py * sinX + z1 * cosX;

        // perspective: points further back render smaller and dimmer,
        // which is what actually sells the 3D read
        const depth = (z2 + 1) / 2; // 0 (back) .. 1 (front)
        const scale = 0.55 + depth * 0.45;
        const sx = cx + x1 * R * scale;
        const sy = cy + y2 * R * scale;

        const alpha = 0.12 + depth * 0.75;
        const size = 0.7 + depth * 1.5;

        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
      }
      ctx.globalAlpha = 1;

      // faint containing ring + tick dial around the sphere
      ctx.save();
      ctx.strokeStyle = `${color}33`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.28, 0, Math.PI * 2);
      ctx.stroke();

      const dialR = R * 1.42;
      const ticks = 60;
      for (let i = 0; i < ticks; i++) {
        const a = (i / ticks) * Math.PI * 2 + t * 0.1;
        const major = i % 5 === 0;
        const len = major ? 8 : 3;
        ctx.strokeStyle = major ? `${color}77` : `${color}2a`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * dialR, cy + Math.sin(a) * dialR);
        ctx.lineTo(cx + Math.cos(a) * (dialR + len), cy + Math.sin(a) * (dialR + len));
        ctx.stroke();
      }
      ctx.restore();

      updateEqBars();
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
      setListening(on) { listening = on; if (on) ensureMic(); },
      setSpeaking(on, ampFn, barsFn) { speaking = on; getSpeakAmp = ampFn || null; getSpeakBars = barsFn || null; },
      setAccent(hex) { if (hex) accent = hex; },
    };
  }

  // ---------------------------------------------------------------- settings tab
  const PERSONALITY_OPTIONS = [
    ["butler", "Butler — formal, poised, dry wit"],
    ["casual", "Casual — laid-back friend"],
    ["dry_wit", "Dry Wit — deadpan, sarcastic"],
    ["hype", "Hype — high energy, enthusiastic"],
    ["unfiltered", "Unfiltered — blunt, swears, no filter"],
  ];
  const MODEL_OPTIONS = [
    ["claude-haiku-4-5-20251001", "Haiku 4.5 — fastest (recommended for voice)"],
    ["claude-sonnet-5", "Sonnet 5 — smarter, a bit slower"],
    ["claude-opus-4-8", "Opus 4.8 — most capable, slowest"],
  ];

  async function loadSettingsIntoTab(container) {
    const [settingsResp, voicesResp] = await Promise.all([
      fetch("/api/settings").then((r) => r.json()).catch(() => ({})),
      fetch("/api/jarvis/voices").then((r) => r.json()).catch(() => ({ voices: [] })),
    ]);
    const val = (k, d = "") => (settingsResp[k] && settingsResp[k].value) || d;

    const voiceOptionsHtml = voicesResp.voices.length
      ? voicesResp.voices.map((v) => `<option value="${v.voice_id}">${v.name}</option>`).join("")
      : `<option value="">— add an ElevenLabs key in Settings to pick a voice —</option>`;

    container.innerHTML = `
      <div class="jarvis-settings-grid">
        <label>ElevenLabs API key</label>
        <input id="js-elevenlabs" type="password" placeholder="${settingsResp.elevenlabs_api_key && settingsResp.elevenlabs_api_key.set ? "•••••• (saved — type to replace)" : "paste key to get a real voice"}"/>

        <label>Personality</label>
        <select id="js-personality">
          ${PERSONALITY_OPTIONS.map(([v, l]) => `<option value="${v}" ${val("jarvis_personality", "butler") === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>

        <label>Voice (ElevenLabs)</label>
        <select id="js-voice">${voiceOptionsHtml}</select>

        <label>Speed / model</label>
        <select id="js-model">
          ${MODEL_OPTIONS.map(([v, l]) => `<option value="${v}" ${val("jarvis_model", "claude-haiku-4-5-20251001") === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>

        <label>Wake word</label>
        <input id="js-wakeword" placeholder="hey jarvis" value="${val("jarvis_wake_word")}"/>

        <label>Custom greeting</label>
        <input id="js-greeting" placeholder="Hey, I'm here." value="${val("jarvis_greeting")}"/>

        <label>Accent color</label>
        <input id="js-accent" type="color" value="${val("jarvis_accent_color", "#00e8ff")}"/>

        <label>Read replies aloud</label>
        <input id="js-readaloud" type="checkbox" ${val("jarvis_read_aloud", "true") !== "false" ? "checked" : ""}/>

        <label>Desktop notifications</label>
        <input id="js-notify" type="checkbox" ${val("jarvis_notifications") === "true" ? "checked" : ""}/>
      </div>
      <div class="bp-sub" style="margin:10px 0">Notifications only fire while this panel is open, and only for jobs finishing/failing — not a background service yet.</div>
      <button class="btn" id="js-save">Save Jarvis Settings</button>
      <div class="bp-sub" id="js-save-status" style="margin-top:8px"></div>
    `;

    if (voicesResp.voices.length) {
      const sel = $("#js-voice");
      const current = val("jarvis_voice_id");
      if (current) sel.value = current;
    }

    $("#js-save").addEventListener("click", async () => {
      const payload = {
        jarvis_personality: $("#js-personality").value,
        jarvis_voice_id: $("#js-voice").value,
        jarvis_model: $("#js-model").value,
        jarvis_wake_word: $("#js-wakeword").value.trim(),
        jarvis_greeting: $("#js-greeting").value.trim(),
        jarvis_accent_color: $("#js-accent").value,
        jarvis_read_aloud: $("#js-readaloud").checked ? "true" : "false",
        jarvis_notifications: $("#js-notify").checked ? "true" : "false",
      };
      // Only send the key if something was actually typed -- an empty field
      // means "leave whatever's saved alone", not "clear it".
      const elKey = $("#js-elevenlabs").value.trim();
      if (elKey) payload.elevenlabs_api_key = elKey;
      try {
        await fetch("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        $("#js-save-status").textContent = "Saved.";
        await applySettings();
        if (payload.jarvis_notifications === "true" && "Notification" in window && Notification.permission === "default") {
          Notification.requestPermission();
        }
        toast("Jarvis settings saved.");
        // If a key was just added, reload this tab so the voice picker can
        // actually populate from ElevenLabs instead of staying empty.
        if (elKey) loadSettingsIntoTab(container);
      } catch (_) {
        $("#js-save-status").textContent = "Couldn't save — try again.";
      }
    });
  }

  async function applySettings() {
    try {
      const s = await fetch("/api/settings").then((r) => r.json());
      const val = (k, d = "") => (s[k] && s[k].value) || d;
      jarvisSettings = {
        jarvis_read_aloud: val("jarvis_read_aloud", "true") !== "false",
        jarvis_accent_color: val("jarvis_accent_color", "#00e8ff"),
        jarvis_personality: val("jarvis_personality", "butler"),
        jarvis_model: val("jarvis_model", "claude-haiku-4-5-20251001"),
        has_elevenlabs: !!val("elevenlabs_api_key"),
      };
      const custom = val("jarvis_wake_word", "").trim().toLowerCase();
      wakePhrases = custom ? [custom, ...DEFAULT_WAKE_PHRASES] : DEFAULT_WAKE_PHRASES.slice();
      if (currentOrb) currentOrb.setAccent(jarvisSettings.jarvis_accent_color);
      return val("jarvis_greeting", "");
    } catch (_) {
      jarvisSettings = { jarvis_read_aloud: true, jarvis_accent_color: "#00e8ff", jarvis_personality: "butler", jarvis_model: "claude-haiku-4-5-20251001", has_elevenlabs: false };
      return "";
    }
  }

  // ---------------------------------------------------------------- proactive job updates
  // Polls while the panel is open and announces real status changes in the
  // transcript + out loud. Closing the panel stops it -- not a background
  // service.
  let notifyPoll = null;
  let knownJobStatuses = new Map(); // job id -> last-seen status

  /**
   * Watches your jobs and speaks up when something actually changes --
   * a video finishing, failing, or starting. This is the "keep me updated"
   * behavior: it announces in the transcript AND out loud (if read-aloud
   * is on), rather than only firing a browser notification you might never
   * see. Desktop notifications are still sent as a bonus when enabled and
   * permitted, for when the tab isn't focused.
   *
   * Only announces genuine transitions -- the first poll just records
   * current state so you don't get a burst of stale announcements every
   * time you open the panel.
   */
  let announceTarget = null; // {log} -- set by the panel so this can write into the transcript

  function _describeJob(j) {
    const name = j.title || j.topic || "a video";
    if (j.status === "failed") return `Heads up — "${name}" failed. ${j.error_message ? "Reason: " + j.error_message : ""}`;
    if (j.status === "published") return `"${name}" is published.`;
    if (j.status === "ready_for_review") return `"${name}" is finished and ready for review.`;
    if (j.status === "publishing") return `Publishing "${name}" now.`;
    return null;
  }

  async function notifyTick() {
    try {
      const jobs = await fetch("/api/jobs").then((r) => r.json());
      const announcements = [];

      for (const j of jobs) {
        const prev = knownJobStatuses.get(j.id);
        knownJobStatuses.set(j.id, j.status);
        if (prev === undefined) continue;      // first sighting -- don't announce retroactively
        if (prev === j.status) continue;       // nothing changed
        const msg = _describeJob(j);
        if (msg) announcements.push(msg);
      }

      if (!announcements.length) return;

      for (const msg of announcements) {
        if (announceTarget && announceTarget.log) {
          announceTarget.log.appendChild(bubble("assistant", msg));
          announceTarget.log.scrollTop = announceTarget.log.scrollHeight;
        }
        speak(msg);
      }

      // desktop notification as a bonus when enabled + permitted
      try {
        const s = await fetch("/api/settings").then((r) => r.json());
        if (s.jarvis_notifications && s.jarvis_notifications.value === "true" &&
            "Notification" in window && Notification.permission === "granted") {
          new Notification("Faceless Command Center", { body: announcements.join(" ") });
        }
      } catch (_) { /* notification is optional, never block the in-app announcement on it */ }
    } catch (_) { /* silent -- polling failures shouldn't spam the transcript */ }
  }

  function startNotifyPoll(target) {
    announceTarget = target || null;
    if (notifyPoll) return;
    notifyTick(); // seed knownJobStatuses immediately rather than waiting
    notifyPoll = setInterval(notifyTick, 15000);
  }
  function stopNotifyPoll() {
    if (notifyPoll) { clearInterval(notifyPoll); notifyPoll = null; }
    knownJobStatuses = new Map();
    announceTarget = null;
  }

  // ---------------------------------------------------------------- main panel
  window.renderJarvisPanel = async function (body) {
    body.innerHTML = `
      <div class="jarvis-page">
        <div class="jarvis-header">
          <div class="jarvis-header-title">JARVIS</div>
          <div class="jarvis-header-status"><span class="jarvis-status-dot"></span> ONLINE</div>
        </div>
        <div class="jarvis-body">
        <div class="jarvis-left">
          <div class="jarvis-sysline">SYSTEM STATUS</div>
          <div class="jarvis-readout" id="jarvis-readout"></div>
          <div class="jarvis-sysline" style="margin-top:20px">TRANSCRIPT</div>
          <div class="jarvis-log" id="jarvis-log"></div>
        </div>
        <div class="jarvis-center">
          <canvas id="jarvis-orb" width="460" height="460"></canvas>
          <div class="jarvis-caption" id="jarvis-caption"></div>
          <div class="bp-sub" id="jarvis-status" style="text-align:center; margin-top:6px"></div>
          <div class="jarvis-controls-row">
            <button class="icon-btn" id="jarvis-wake" title="Toggle always-listening">◉ ENGAGE</button>
          </div>
          <div class="jarvis-eq" id="jarvis-eq">${Array.from({ length: 32 }).map(() => '<div class="jarvis-eq-bar"></div>').join("")}</div>
          <div class="jarvis-input-row" style="margin-top:16px; width:100%; max-width:420px">
            <input id="jarvis-text" placeholder="…or type here" autocomplete="off"/>
            <button class="icon-btn" id="jarvis-send" title="Send">▸</button>
          </div>
        </div>
        <div class="jarvis-right">
          <div class="jarvis-tabs">
            <button class="jarvis-tab active" data-tab="settings">Settings</button>
            <button class="jarvis-tab" data-tab="more">More</button>
          </div>
          <div class="jarvis-tabpanel" data-tabpanel="settings"></div>
          <div class="jarvis-tabpanel" data-tabpanel="more" style="display:none">
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
              <p class="jarvis-sms-note">Estimates pitch from a few seconds of speech and compares it later. Not identity verification — a fun gate. Adapts to your voice slowly over time.</p>
            </div>
            <div class="jarvis-sms-box">
              <b>Computer Control <span id="jarvis-agent-status" style="font-weight:400; opacity:0.7;">(checking…)</span></b>
              <p>Lets Jarvis actually control this computer — open apps, type, click, press keys — through a small script that runs locally on your machine (not this server).</p>
              <ol class="jarvis-sms-note" style="padding-left:18px; margin:8px 0">
                <li><a href="/assets/jarvis_agent.py" download style="color:var(--cyan)">Download jarvis_agent.py</a></li>
                <li><code>pip install requests pyautogui</code></li>
                <li>Generate a pairing token here, then run the script and paste it in when asked</li>
              </ol>
              <button class="btn" id="jarvis-gen-token-btn">Generate Pairing Token</button>
              <div class="jarvis-sms-note" id="jarvis-token-display" style="margin-top:8px"></div>
              <p class="jarvis-sms-note" style="margin-top:8px">⚠️ The token is a password for your computer — shown once, keep it private, regenerating invalidates the old one.</p>
            </div>
          </div>
        </div>
        </div>
      </div>
    `;

    const greetingText = await applySettings();

    const readout = $("#jarvis-readout");
    if (readout) {
      const personalityLabel = { butler: "BUTLER", casual: "CASUAL", dry_wit: "DRY WIT", hype: "HYPE", unfiltered: "UNFILTERED" }[jarvisSettings.jarvis_personality] || "BUTLER";
      const modelLabel = jarvisSettings.jarvis_model.includes("haiku") ? "HAIKU (FAST)" : jarvisSettings.jarvis_model.includes("opus") ? "OPUS" : "SONNET";
      readout.innerHTML = `
        <div>MODE <span>${personalityLabel}</span></div>
        <div>MODEL <span>${modelLabel}</span></div>
        <div>VOICE <span>${jarvisSettings.has_elevenlabs ? "ELEVENLABS" : "BROWSER (fallback)"}</span></div>
      `;
    }

    const log = $("#jarvis-log");
    const wakeBtn = $("#jarvis-wake");
    const status = $("#jarvis-status");
    const orbCanvas = $("#jarvis-orb");
    const input = $("#jarvis-text");
    const sendBtn = $("#jarvis-send");

    const orb = createOrbVisualizer(orbCanvas);
    currentOrb = orb;
    orb.setAccent(jarvisSettings.jarvis_accent_color);
    orb.start();
    startNotifyPoll({ log });
    window.stopJarvisSession = () => { orb.stop(); currentOrb = null; stopNotifyPoll(); };

    document.querySelectorAll(".jarvis-tab").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        document.querySelectorAll(".jarvis-tab").forEach((b) => b.classList.remove("active"));
        tabBtn.classList.add("active");
        const target = tabBtn.dataset.tab;
        document.querySelectorAll(".jarvis-tabpanel").forEach((p) => {
          p.style.display = p.dataset.tabpanel === target ? "" : "none";
        });
        if (target === "settings") {
          const panel = document.querySelector('.jarvis-tabpanel[data-tabpanel="settings"]');
          if (panel && !panel.dataset.loaded) {
            panel.dataset.loaded = "1";
            loadSettingsIntoTab(panel);
          }
        }
      });
    });

    const settingsPanel = document.querySelector('.jarvis-tabpanel[data-tabpanel="settings"]');
    if (settingsPanel) {
      settingsPanel.dataset.loaded = "1";
      loadSettingsIntoTab(settingsPanel);
    }

    // Greet immediately on open rather than waiting to be spoken to first --
    // and make it a real status update (what's running, what finished) rather
    // than a generic hello, since "tell me what's going on" is the main thing
    // you'd open this for anyway.
    (async () => {
      let greeting = greetingText || "Systems online.";
      try {
        const jobs = await fetch("/api/jobs").then((r) => r.json());
        const active = jobs.filter((j) => !["published", "ready_for_review", "failed"].includes(j.status));
        const failed = jobs.filter((j) => j.status === "failed").length;
        const ready = jobs.filter((j) => j.status === "ready_for_review").length;

        const bits = [];
        if (active.length) bits.push(`${active.length} video${active.length === 1 ? "" : "s"} in progress`);
        if (ready) bits.push(`${ready} ready for review`);
        if (failed) bits.push(`${failed} failed`);
        greeting = bits.length
          ? `${greetingText || "Systems online."} You've got ${bits.join(", ")}.`
          : `${greetingText || "Systems online."} Nothing running right now.`;
      } catch (_) { /* fall back to the plain greeting if the status check fails */ }

      log.appendChild(bubble("assistant", greeting));
      log.scrollTop = log.scrollHeight;
      speak(greeting);
    })();

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

    const agentStatusEl = $("#jarvis-agent-status");
    const genTokenBtn = $("#jarvis-gen-token-btn");
    const tokenDisplay = $("#jarvis-token-display");
    fetch("/api/jarvis/agent/status").then((r) => r.json()).then((d) => {
      if (agentStatusEl) agentStatusEl.textContent = d.paired ? "(token generated)" : "(not set up)";
    }).catch(() => {});
    if (genTokenBtn) {
      genTokenBtn.addEventListener("click", async () => {
        try {
          const r = await fetch("/api/jarvis/agent/generate-token", { method: "POST" });
          const d = await r.json();
          tokenDisplay.innerHTML = `Token (copy now, shown once): <code style="user-select:all">${d.token}</code>`;
          if (agentStatusEl) agentStatusEl.textContent = "(token generated)";
          toast("Pairing token generated — copy it now.");
        } catch (_) {
          toast("Couldn't generate a token — try again.");
        }
      });
    }

    sendBtn.addEventListener("click", () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      send(log, text);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendBtn.click(); });

    if (!SpeechRecognition) {
      wakeBtn.disabled = true;
      status.textContent = "Voice isn't supported in this browser — try Chrome or Edge. Typing still works.";
      return;
    }

    function stopEverything() {
      mode = "off";
      awake = false;

      sessionToken++;
      clearTimeout(restartTimer);
      clearTimeout(silenceTimer);
      pendingText = "";
      wakeBtn.classList.remove("jarvis-mic-active");
      status.textContent = "";
      orb.setListening(false);
      if (window.VoiceID) VoiceID.stopSamplingAndGet();
      if (recognizer) { try { recognizer.abort(); } catch (_) {} }
    }

    window.stopJarvisSession = () => {
      stopEverything();
      orb.stop();
      currentOrb = null;
      stopNotifyPoll();
    };

    function handleResult(text) {
      // Always-on: once ENGAGE is active, everything you say goes straight
      // to Jarvis. No wake word needed per command, no button to hold.
      // Note: this deliberately does NOT do a voice-ID greeting first --
      // that fired a "Hey sir." before every session and, worse, blocked the
      // real response behind an extra round-trip. Voice ID still exists for
      // enrollment, it just doesn't gate or precede normal replies.
      const cleaned = containsWakePhrase(text) ? stripWakePhrase(text) : text;
      if (!cleaned.trim()) return;

      // Ignore anything captured while Jarvis's own voice is playing --
      // otherwise the mic picks up his reply and sends it straight back as
      // your next "command", which makes him talk to himself in a loop.
      if (jarvisSpeaking) return;

      // Guard against the same utterance arriving twice -- once from the
      // silence timer firing early, then again when the browser finally
      // marks it final. Same text within a few seconds is a duplicate.
      const now = Date.now();
      if (cleaned === lastSentText && now - lastSentAt < 4000) return;
      lastSentText = cleaned;
      lastSentAt = now;

      send(log, cleaned);
    }

    function startSession(continuous) {
      sessionToken++;
      const myToken = sessionToken;
      const r = new SpeechRecognition();
      r.continuous = continuous;
      r.interimResults = true;
      r.lang = "en-US";

      r.onresult = (e) => {
        if (myToken !== sessionToken) return;
        const result = e.results[e.results.length - 1];
        const text = result[0].transcript;
        const caption = $("#jarvis-caption");

        if (!result.isFinal) {
          // Live caption -- shows what it's hearing in real time.
          if (caption) caption.textContent = text;

          // Silence endpointing: in continuous mode the browser can take
          // several seconds to mark a phrase "final", which felt like Jarvis
          // just sitting there ignoring you. Instead, every time new interim
          // text arrives we restart a short timer -- when it actually elapses
          // (i.e. you've stopped talking for ~900ms), send immediately rather
          // than waiting for the browser to catch up.
          pendingText = text;
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            if (myToken !== sessionToken) return;
            const toSend = pendingText;
            pendingText = "";
            if (caption) caption.textContent = "";
            if (toSend && toSend.trim()) handleResult(toSend);
          }, 900);
          return;
        }

        // Browser gave us a final result -- cancel any pending silence timer.
        // handleResult's duplicate guard handles the case where the silence
        // timer already sent this same utterance moments ago.
        clearTimeout(silenceTimer);
        pendingText = "";
        if (caption) caption.textContent = "";
        handleResult(text);
      };
      r.onerror = (e) => {
        if (myToken !== sessionToken) return;
        if (e.error === "no-speech" || e.error === "aborted") return;
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          status.textContent = "Microphone blocked — allow mic access in your browser's address bar, then hit ENGAGE again.";
          log.appendChild(bubble("assistant", "Mic access is blocked, so I can't hear anything. Allow it in the address bar, or type below."));
          stopEverything();
          wakeBtn.textContent = "◉ ENGAGE";
          return;
        }
        if (e.error === "network") {
          status.textContent = "Speech service unreachable — check your connection. Typing still works.";
          return;
        }
        status.textContent = `Mic error: ${e.error}`;
      };
      r.onend = () => {
        if (myToken !== sessionToken) return;
        if (mode === "wake") {
          restartTimer = setTimeout(() => {
            if (myToken !== sessionToken) return;
            startSession(true);
          }, 250);
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
        setTimeout(() => { if (myToken === sessionToken) { try { r.start(); } catch (__) {} } }, 200);
      }
    }

    wakeBtn.addEventListener("click", async () => {
      if (mode === "wake") {
        stopEverything();
        wakeBtn.textContent = "◉ ENGAGE";
        return;
      }
      stopEverything();

      // Explicitly ask for the mic first. SpeechRecognition on its own
      // doesn't always surface a permission prompt (and silently hears
      // nothing if permission was never granted), which looks exactly like
      // "I clicked engage, it says listening, but nothing happens."
      // Requesting getUserMedia directly forces the prompt and gives us a
      // real error to show if it's blocked.
      if (navigator.mediaDevices?.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((tr) => tr.stop()); // just needed the permission, not the stream
        } catch (err) {
          status.textContent = "Microphone blocked. Click the padlock/mic icon in your browser's address bar and allow mic access for this site, then try again.";
          log.appendChild(bubble("assistant", "I can't hear you — microphone access is blocked for this site. Allow it in your browser's address bar (padlock icon), or just type below."));
          return;
        }
      }

      mode = "wake";
      awake = false;
      wakeBtn.classList.add("jarvis-mic-active");
      wakeBtn.textContent = "◉ LISTENING";
      status.textContent = "Just talk — no wake word needed.";
      startSession(true);
    });
  };
})();
