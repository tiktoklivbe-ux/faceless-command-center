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
  let mode = "off"; // "off" | "ptt" | "wake"
  let awake = false;
  let history = [];
  let restartTimer = null;
  let sessionToken = 0;
  let currentOrb = null;
  let sessionGreeted = false;
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
    u.onstart = () => { if (currentOrb) currentOrb.setSpeaking(true, null); };
    u.onend = () => { if (currentOrb) currentOrb.setSpeaking(false, null); };
    u.onerror = () => { if (currentOrb) currentOrb.setSpeaking(false, null); };
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

      audio.onplay = () => { if (currentOrb) currentOrb.setSpeaking(true, getSpeechAmplitude, getSpeechBars); };
      audio.onended = () => { if (currentOrb) currentOrb.setSpeaking(false, null); URL.revokeObjectURL(url); };
      audio.onerror = () => { if (currentOrb) currentOrb.setSpeaking(false, null); };
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

    function draw() {
      t += reducedMotion ? 0 : 0.02;
      ctx.clearRect(0, 0, W, H);

      let radius = 70;
      let glow = 46;
      let color = accent;

      if (speaking) {
        let level;
        if (getSpeakAmp) {
          const a = getSpeakAmp();
          level = a === null || a === undefined ? 0.3 : a;
        } else {
          level = reducedMotion ? 0.4 : 0.35 + Math.sin(t * 9) * 0.15 + Math.sin(t * 5.3) * 0.1;
        }
        radius = 74 + level * 46;
        glow = 50 + level * 90;
        color = "#b26bff";
      } else if (listening) {
        const level = currentLevel();
        radius = 70 + level * 50;
        glow = 46 + level * 100;
        color = "#ff2f9e";
      } else {
        radius = reducedMotion ? 70 : 70 + Math.sin(t * 1.4) * 6;
        glow = reducedMotion ? 40 : 40 + Math.sin(t * 1.4) * 10;
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

      // crisp core edge -- a sharp thin ring right at the glow's boundary,
      // contrasting with the soft gradient fill for a more defined, "precision
      // instrument" look instead of just a fuzzy ball of light
      ctx.save();
      ctx.strokeStyle = `${color}cc`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // faint crosshair through center -- reads as a targeting/scanning HUD
      ctx.save();
      ctx.strokeStyle = `${color}22`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - radius - 30, cy); ctx.lineTo(cx + radius + 30, cy);
      ctx.moveTo(cx, cy - radius - 30); ctx.lineTo(cx, cy + radius + 30);
      ctx.stroke();
      ctx.restore();

      // two dashed orbiting arcs (slower, more technical feeling than a
      // continuous line)
      [1, -0.6].forEach((dir, i) => {
        ctx.save();
        ctx.strokeStyle = `${color}55`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 6]);
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 26 + i * 16, t * 0.5 * dir, t * 0.5 * dir + Math.PI * 1.3);
        ctx.stroke();
        ctx.restore();
      });

      // outer tick-mark dial -- short radial lines at regular angle
      // intervals around a ring, like a measurement instrument, slowly
      // rotating
      const dialRadius = radius + 56;
      const tickCount = 48;
      ctx.save();
      for (let i = 0; i < tickCount; i++) {
        const angle = (i / tickCount) * Math.PI * 2 + t * 0.15;
        const major = i % 6 === 0;
        const len = major ? 10 : 4;
        const x1 = cx + Math.cos(angle) * dialRadius;
        const y1 = cy + Math.sin(angle) * dialRadius;
        const x2 = cx + Math.cos(angle) * (dialRadius + len);
        const y2 = cy + Math.sin(angle) * (dialRadius + len);
        ctx.strokeStyle = major ? `${color}88` : `${color}33`;
        ctx.lineWidth = major ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.restore();

      // small satellite dots orbiting at two different radii/speeds for
      // depth -- brighter and faster when actively listening or speaking
      const satSpeed = (speaking || listening) ? 1.4 : 0.4;
      [
        { r: radius + 40, speed: satSpeed, size: 2.5, dir: 1 },
        { r: radius + 40, speed: satSpeed, size: 2.5, dir: 1, offset: Math.PI },
        { r: dialRadius + 14, speed: satSpeed * 0.6, size: 2, dir: -1 },
      ].forEach((sat) => {
        const angle = t * sat.speed * sat.dir + (sat.offset || 0);
        const x = cx + Math.cos(angle) * sat.r;
        const y = cy + Math.sin(angle) * sat.r;
        ctx.save();
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(x, y, sat.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });

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

  // ---------------------------------------------------------------- job-finish notifications
  // Real, working, but scoped: only checks while this panel is open (every
  // 20s), and only for jobs transitioning INTO a finished state (published,
  // ready_for_review, failed) that weren't already in that state last time
  // we checked. Not a background service -- closing the panel stops it,
  // same as everything else here.
  const _FINISHED_STATUSES = new Set(["published", "ready_for_review", "failed"]);
  let notifyPoll = null;
  let knownJobStatuses = new Map(); // job id -> last-seen status

  async function notifyTick() {
    try {
      const s = await fetch("/api/settings").then((r) => r.json());
      if (!s.jarvis_notifications || s.jarvis_notifications.value !== "true") return;
      if (!("Notification" in window) || Notification.permission !== "granted") return;

      const jobs = await fetch("/api/jobs").then((r) => r.json());
      for (const j of jobs) {
        const prev = knownJobStatuses.get(j.id);
        knownJobStatuses.set(j.id, j.status);
        if (prev === undefined) continue; // first time seeing this job -- don't notify retroactively
        if (prev !== j.status && _FINISHED_STATUSES.has(j.status)) {
          const label = j.status === "failed" ? "failed" : "is ready";
          new Notification("Faceless Command Center", {
            body: `"${j.title || j.topic || "A video"}" ${label}.`,
          });
        }
      }
    } catch (_) { /* silent -- this is a nice-to-have, not core functionality */ }
  }

  function startNotifyPoll() {
    if (notifyPoll) return;
    notifyTick(); // seed knownJobStatuses immediately rather than waiting 20s
    notifyPoll = setInterval(notifyTick, 20000);
  }
  function stopNotifyPoll() {
    if (notifyPoll) { clearInterval(notifyPoll); notifyPoll = null; }
    knownJobStatuses = new Map();
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
          <canvas id="jarvis-orb" width="420" height="420"></canvas>
          <div class="jarvis-eq" id="jarvis-eq">${Array.from({ length: 24 }).map(() => '<div class="jarvis-eq-bar"></div>').join("")}</div>
          <div class="jarvis-caption" id="jarvis-caption"></div>
          <div class="bp-sub" id="jarvis-status" style="text-align:center; margin-top:10px"></div>
          <div class="jarvis-controls-row">
            <button class="icon-btn" id="jarvis-mic" title="Hold to talk">🎤 Talk</button>
            <button class="icon-btn" id="jarvis-wake" title="Toggle wake mode">👂 Hey Jarvis</button>
          </div>
          <button class="btn secondary" id="jarvis-reset" style="margin-top:14px">Clear Conversation</button>
          <div class="jarvis-readout" id="jarvis-readout"></div>
        </div>
        <div class="jarvis-right">
          <div class="jarvis-tabs">
            <button class="jarvis-tab active" data-tab="chat">Chat</button>
            <button class="jarvis-tab" data-tab="settings">Settings</button>
            <button class="jarvis-tab" data-tab="more">More</button>
          </div>
          <div class="jarvis-tabpanel" data-tabpanel="chat">
            <div class="jarvis-log" id="jarvis-log"></div>
            <div class="jarvis-input-row">
              <input id="jarvis-text" placeholder="Type, or use the mic…" autocomplete="off"/>
              <button class="icon-btn" id="jarvis-send" title="Send">▸</button>
            </div>
          </div>
          <div class="jarvis-tabpanel" data-tabpanel="settings" style="display:none"></div>
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
    startNotifyPoll();

    const readout = $("#jarvis-readout");
    if (readout) {
      const personalityLabel = { butler: "BUTLER", casual: "CASUAL", dry_wit: "DRY WIT", hype: "HYPE" }[jarvisSettings.jarvis_personality] || "BUTLER";
      const modelLabel = jarvisSettings.jarvis_model.includes("haiku") ? "HAIKU (FAST)" : jarvisSettings.jarvis_model.includes("opus") ? "OPUS" : "SONNET";
      readout.innerHTML = `
        <div>MODE <span>${personalityLabel}</span></div>
        <div>MODEL <span>${modelLabel}</span></div>
        <div>VOICE <span>${jarvisSettings.has_elevenlabs ? "ELEVENLABS" : "BROWSER (fallback)"}</span></div>
      `;
    }

    const log = $("#jarvis-log");
    const input = $("#jarvis-text");
    const micBtn = $("#jarvis-mic");
    const wakeBtn = $("#jarvis-wake");
    const sendBtn = $("#jarvis-send");
    const status = $("#jarvis-status");
    const orbCanvas = $("#jarvis-orb");
    const resetBtn = $("#jarvis-reset");

    const orb = createOrbVisualizer(orbCanvas);
    currentOrb = orb;
    orb.setAccent(jarvisSettings.jarvis_accent_color);
    orb.start();
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

    log.appendChild(bubble("assistant", greetingText || "Hey, I'm here. Type, hold the mic to talk once, or turn on 'Hey Jarvis' mode to leave the mic open."));

    resetBtn.addEventListener("click", () => {
      history = [];
      log.innerHTML = "";
      log.appendChild(bubble("assistant", "Conversation cleared."));
    });

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
      micBtn.disabled = true;
      wakeBtn.disabled = true;
      status.textContent = "Voice input isn't supported in this browser (try Chrome or Edge) — typing still works fully, and replies are still spoken aloud.";
      return;
    }

    function stopEverything() {
      mode = "off";
      awake = false;
      sessionGreeted = false;
      sessionToken++;
      clearTimeout(restartTimer);
      micBtn.classList.remove("jarvis-mic-active");
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

    async function maybeGreet(logEl) {
      if (sessionGreeted || !window.VoiceID) return;
      sessionGreeted = true;
      const sample = VoiceID.stopSamplingAndGet();
      VoiceID.startSampling();
      if (!sample) return;

      const match = VoiceID.isLikelyMatch(sample);
      if (match === null) return;
      if (match) {
        const greeting = "Hey sir.";
        logEl.appendChild(bubble("assistant", greeting));
        speak(greeting);
        VoiceID.reportMatch(sample);
      } else {
        const guess = VoiceID.softGuess(sample.avg);
        const greeting = `Hey there — this doesn't sound like Tom to me. I'm his assistant, Jarvis.` +
          (guess ? ` Rough guess from pitch: ${guess}. Not a real ID, just a hint.` : "");
        logEl.appendChild(bubble("assistant", greeting));
        speak(greeting);
      }
      logEl.scrollTop = logEl.scrollHeight;
    }

    function handleResult(text) {
      if (mode === "ptt") {
        maybeGreet(log).then(() => send(log, text));
        return;
      }
      if (!awake) {
        if (containsWakePhrase(text)) {
          awake = true;
          status.textContent = "Listening for your command…";
          const rest = stripWakePhrase(text);
          if (rest) {
            awake = false;
            maybeGreet(log).then(() => send(log, rest));
            status.textContent = "Say the wake word any time.";
          }
        }
      } else {
        awake = false;
        status.textContent = "Say the wake word any time.";
        maybeGreet(log).then(() => send(log, text));
      }
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
        if (!result.isFinal) {
          // live caption -- shows what it's hearing in real time, not just
          // after you finish talking
          const caption = $("#jarvis-caption");
          if (caption) caption.textContent = text;
          return;
        }
        const caption = $("#jarvis-caption");
        if (caption) caption.textContent = "";
        handleResult(text);
      };
      r.onerror = (e) => {
        if (myToken !== sessionToken) return;
        if (e.error === "no-speech" || e.error === "aborted") return;
        status.textContent = `Mic error: ${e.error}`;
      };
      r.onend = () => {
        if (myToken !== sessionToken) return;
        if (mode === "wake") {
          restartTimer = setTimeout(() => {
            if (myToken !== sessionToken) return;
            startSession(true);
          }, 250);
        } else if (mode === "ptt") {
          mode = "off";
          micBtn.classList.remove("jarvis-mic-active");
          if (window.VoiceID) VoiceID.stopSamplingAndGet();
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
      status.textContent = "Say the wake word any time.";
      startSession(true);
    });
  };
})();
