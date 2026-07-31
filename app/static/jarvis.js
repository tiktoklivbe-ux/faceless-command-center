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
  let lastInterimLength = 0; // tracks whether an utterance is still growing, so a pause mid-sentence isn't mistaken for the end
  let lastSentText = "";
  let lastSentAt = 0;
  let jarvisSpeaking = false; // true while Jarvis's own audio is playing, so the mic doesn't feed his voice back in as a command
  let lastSpokenText = "";    // what Jarvis last said, to recognize his own voice echoing back through the mic
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

  /** Immediately silences Jarvis, whether he's mid-ElevenLabs-playback or
   * mid-browser-TTS. Used for barge-in: the moment the user starts talking,
   * he stops -- talking over someone who's trying to interrupt you is the
   * single most annoying thing an assistant can do. */
  function stopSpeaking() {
    if (currentAudioEl) {
      try { currentAudioEl.pause(); currentAudioEl.currentTime = 0; } catch (_) {}
    }
    if ("speechSynthesis" in window) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
    jarvisSpeaking = false;
    if (currentOrb) currentOrb.setSpeaking(false, null);
  }

  async function speak(text) {
    if (jarvisSettings && jarvisSettings.jarvis_read_aloud === false) return;
    lastSpokenText = text.toLowerCase();

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

      // Route through an AudioContext so the orb can react to real amplitude.
      // Critical caveat: browsers create AudioContexts SUSPENDED until a user
      // gesture, and audio routed through a suspended context is completely
      // SILENT while play() still resolves successfully -- no error, no
      // fallback, just nothing audible. So resume it first, and if it won't
      // resume, skip the analyser entirely and play the element directly
      // rather than routing into a dead context.
      let analyserWired = false;
      try {
        if (!speechAudioCtx) speechAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (speechAudioCtx.state === "suspended") {
          await speechAudioCtx.resume().catch(() => {});
        }
        if (speechAudioCtx.state === "running") {
          const source = speechAudioCtx.createMediaElementSource(audio);
          speechAnalyser = speechAudioCtx.createAnalyser();
          speechAnalyser.fftSize = 64;
          source.connect(speechAnalyser);
          speechAnalyser.connect(speechAudioCtx.destination);
          analyserWired = true;
        }
      } catch (_) {
        analyserWired = false;
      }
      if (!analyserWired) {
        // No visualizer data, but audible -- which is the right trade.
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
    let eqFrameCounter = 0;

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

    let cachedEqBars = null;
    let lastEqHeights = null;

    function updateEqBars() {
      if (!cachedEqBars) {
        const eqEl = document.getElementById("jarvis-eq");
        if (!eqEl) return;
        cachedEqBars = Array.from(eqEl.children);
        lastEqHeights = new Array(cachedEqBars.length).fill(-1);
      }
      const bars = cachedEqBars;
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
        const pct = Math.round(v * 100);
        // Skip the write entirely if the value hasn't changed -- assigning
        // an identical style value still costs a style recalc.
        if (pct !== lastEqHeights[i]) {
          bars[i].style.height = `${pct}%`;
          lastEqHeights[i] = pct;
        }
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

      // Points are bucketed by depth into a few alpha bands rather than
      // setting globalAlpha per point. Changing globalAlpha forces a canvas
      // state flush, so doing it 900x/frame at 60fps was ~54k state changes
      // a second -- by far the most expensive thing here. Batching into
      // bands gets the same visual falloff for ~6 state changes instead.
      const BANDS = 6;
      for (let b = 0; b < BANDS; b++) {
        const bandDepthLo = b / BANDS;
        const bandDepthHi = (b + 1) / BANDS;
        const midDepth = (bandDepthLo + bandDepthHi) / 2;
        ctx.globalAlpha = 0.12 + midDepth * 0.75;
        ctx.fillStyle = color;
        ctx.beginPath();
        for (let i = 0; i < SPHERE_POINTS.length; i++) {
          const p = SPHERE_POINTS[i];
          const px = p[0], py = p[1], pz = p[2];
          const x1 = px * cosY - pz * sinY;
          const z1 = px * sinY + pz * cosY;
          const y2 = py * cosX - z1 * sinX;
          const z2 = py * sinX + z1 * cosX;
          const depth = (z2 + 1) / 2;
          if (depth < bandDepthLo || depth >= bandDepthHi) continue;
          const scale = 0.55 + depth * 0.45;
          const size = 0.7 + depth * 1.5;
          ctx.rect(cx + x1 * R * scale - size / 2, cy + y2 * R * scale - size / 2, size, size);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // faint containing ring
      ctx.save();
      ctx.strokeStyle = `${color}33`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.28, 0, Math.PI * 2);
      ctx.stroke();

      // Tick dial: batched into two paths (major/minor) instead of a
      // beginPath+stroke per tick, which was 60 separate draw calls a frame.
      const dialR = R * 1.42;
      const ticks = 60;
      for (const major of [false, true]) {
        ctx.strokeStyle = major ? `${color}77` : `${color}2a`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < ticks; i++) {
          if ((i % 5 === 0) !== major) continue;
          const a = (i / ticks) * Math.PI * 2 + t * 0.1;
          const len = major ? 8 : 3;
          const ca = Math.cos(a), sa = Math.sin(a);
          ctx.moveTo(cx + ca * dialR, cy + sa * dialR);
          ctx.lineTo(cx + ca * (dialR + len), cy + sa * (dialR + len));
        }
        ctx.stroke();
      }
      ctx.restore();

      // The EQ bars write 32 DOM style properties per call. At 60fps that's
      // ~1900 style writes a second, which is far more expensive than the
      // canvas work and was the main source of general page lag. 20fps is
      // visually indistinguishable for an audio meter.
      eqFrameCounter++;
      if (eqFrameCounter % 3 === 0) updateEqBars();

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
    ["unhinged", "Unhinged — chaotic, loud, maximum energy"],
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

    const savedVoice = val("jarvis_voice_id");
    // Mark the saved voice selected during render rather than assigning
    // .value afterwards. Assigning a value that isn't among the options
    // fails silently and leaves the first option showing, which looks
    // exactly like "my choice got reset".
    const voiceOptionsHtml = voicesResp.voices.length
      ? voicesResp.voices
          .map((v) => `<option value="${v.voice_id}" ${v.voice_id === savedVoice ? "selected" : ""}>${v.name}</option>`)
          .join("")
      : `<option value="">— add an ElevenLabs key below to pick a voice —</option>`;
    // If a voice was saved but is no longer in the account's list, say so
    // instead of quietly showing something else.
    const savedVoiceMissing =
      savedVoice && voicesResp.voices.length && !voicesResp.voices.some((v) => v.voice_id === savedVoice);

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

        <label>On open</label>
        <select id="js-greetmode">
          <option value="walkthrough" ${val("jarvis_greeting_mode", "walkthrough") === "walkthrough" ? "selected" : ""}>Full walkthrough — talk me through the numbers</option>
          <option value="brief" ${val("jarvis_greeting_mode") === "brief" ? "selected" : ""}>Brief — just flag problems</option>
          <option value="silent" ${val("jarvis_greeting_mode") === "silent" ? "selected" : ""}>Silent — say nothing</option>
        </select>

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
      <button class="btn secondary" id="js-testvoice" style="margin-left:8px">🔊 Test Voice</button>
      <div class="bp-sub" id="js-save-status" style="margin-top:8px">${
        savedVoiceMissing
          ? "⚠ The previously saved voice isn't in your ElevenLabs library anymore — pick another one and save."
          : ""
      }</div>
    `;

    $("#js-testvoice").addEventListener("click", async () => {
      const status = $("#js-save-status");
      // Create the Audio element and start it playing SYNCHRONOUSLY, while
      // we're still inside the user's click. Browsers only allow audio to
      // start from a genuine user gesture, and every `await` below hands
      // control back to the event loop -- which ends that gesture context
      // and gets a later .play() silently blocked. So we start a silent
      // element now to unlock it, then swap in the real audio once it
      // arrives.
      const audio = new Audio();
      audio.play().catch(() => {}); // unlocks playback; nothing to hear yet

      status.textContent = "Saving voice, then testing…";
      try {
        await fetch("/api/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jarvis_voice_id: $("#js-voice").value }),
        });
        const resp = await fetch("/api/jarvis/speak", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Voice test. This is how I'll sound." }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          status.textContent = `Couldn't play: ${err.detail || resp.status}`;
          return;
        }
        const blob = await resp.blob();
        audio.src = URL.createObjectURL(blob);
        const picked = $("#js-voice").options[$("#js-voice").selectedIndex]?.text || "that voice";
        try {
          await audio.play();
          status.textContent = `Saved and playing: ${picked}`;
        } catch (playErr) {
          // Autoplay still blocked, or no audio output. Say so rather than
          // leaving the user wondering why nothing happened.
          status.textContent = `Saved ${picked}, but the browser blocked playback. Click anywhere on the page first, then try again.`;
        }
      } catch (e) {
        status.textContent = "Test failed — check the ElevenLabs key.";
      }
    });

    $("#js-save").addEventListener("click", async () => {
      const payload = {
        jarvis_personality: $("#js-personality").value,
        jarvis_voice_id: $("#js-voice").value,
        jarvis_model: $("#js-model").value,
        jarvis_wake_word: $("#js-wakeword").value.trim(),
        jarvis_greeting: $("#js-greeting").value.trim(),
        jarvis_greeting_mode: $("#js-greetmode").value,
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
        const picked = $("#js-voice").options[$("#js-voice").selectedIndex]?.text;
        $("#js-save-status").textContent = picked ? `Saved. Voice set to ${picked}.` : "Saved.";
        await applySettings();
        if (payload.jarvis_notifications === "true" && "Notification" in window && Notification.permission === "default") {
          Notification.requestPermission();
        }
        toast("Jarvis settings saved.");
        // Only re-render when a NEW ElevenLabs key was just added, since the
        // voice list can't populate until then. Re-rendering otherwise wipes
        // the user's visible selections and reads as "it reset itself".
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
        jarvis_greeting_mode: val("jarvis_greeting_mode", "walkthrough"),
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
            <button class="icon-btn" id="jarvis-shush" title="Stop Jarvis talking">◼ STOP</button>
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
              <b>Sentry Mode <span id="sentry-state" style="font-weight:400; opacity:0.7;">(off)</span></b>
              <p>Watches your webcam and alerts when it detects movement. Runs entirely on your device — no video leaves this browser.</p>
              <div style="display:flex; gap:8px; align-items:center; margin:10px 0">
                <button class="btn" id="sentry-toggle">Arm Sentry</button>
                <label class="jarvis-sms-note" style="display:flex; align-items:center; gap:6px">
                  Sensitivity
                  <input type="range" id="sentry-sens" min="1" max="10" value="2" style="width:90px"/>
                </label>
              </div>
              <div class="jarvis-sms-note" id="sentry-log"></div>
              <p class="jarvis-sms-note">⚠️ This detects <b>motion</b>, not people. It can't tell you from anyone else — if you walk past the camera while armed, it will alert on you. It's a movement alarm, not facial recognition.</p>
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
      const personalityLabel = { butler: "BUTLER", casual: "CASUAL", dry_wit: "DRY WIT", hype: "HYPE", unfiltered: "UNFILTERED", unhinged: "UNHINGED" }[jarvisSettings.jarvis_personality] || "BUTLER";
      const modelLabel = jarvisSettings.jarvis_model.includes("haiku") ? "HAIKU (FAST)" : jarvisSettings.jarvis_model.includes("opus") ? "OPUS" : "SONNET";
      readout.innerHTML = `
        <div>MODE <span>${personalityLabel}</span></div>
        <div>MODEL <span>${modelLabel}</span></div>
        <div>VOICE <span>${jarvisSettings.has_elevenlabs ? "ELEVENLABS" : "BROWSER (fallback)"}</span></div>
      `;
    }

    const log = $("#jarvis-log");
    const wakeBtn = $("#jarvis-wake");
    const shushBtn = $("#jarvis-shush");
    if (shushBtn) shushBtn.addEventListener("click", () => stopSpeaking());
    const status = $("#jarvis-status");
    const orbCanvas = $("#jarvis-orb");
    const input = $("#jarvis-text");
    const sendBtn = $("#jarvis-send");

    const orb = createOrbVisualizer(orbCanvas);
    currentOrb = orb;
    orb.setAccent(jarvisSettings.jarvis_accent_color);
    orb.start();
    startNotifyPoll({ log });
    // The mouse FX overlay is a second full-screen canvas running
    // continuously -- pointless behind this opaque full-page panel, and two
    // of them at once is a real cause of page lag.
    if (window.MouseFX) MouseFX.pause();
    window.stopJarvisSession = () => {
      orb.stop();
      currentOrb = null;
      stopNotifyPoll();
      if (window.MouseFX) MouseFX.resume();
      // Never leave the webcam running once this panel is gone -- an
      // invisible active camera is exactly the kind of thing that should
      // not outlive the UI that turned it on.
      if (window.SentryMode && SentryMode.isArmed()) SentryMode.stop();
    };

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

    // Greet on open using the real briefing endpoint. Mode is user-controlled:
    //   walkthrough - full spoken briefing + a metrics strip
    //   brief       - one short spoken line, no metrics panel
    //   silent      - nothing spoken, nothing shown
    (async () => {
      const mode = (jarvisSettings && jarvisSettings.jarvis_greeting_mode) || "walkthrough";
      if (mode === "silent") return;

      try {
        const b = await fetch("/api/jarvis/briefing").then((r) => r.json());
        const custom = greetingText ? `${greetingText} ` : "";

        if (mode === "brief") {
          const short = b.issues.length
            ? `${custom}${b.issues.length} thing${b.issues.length === 1 ? "" : "s"} need your attention.`
            : `${custom}All clear.`;
          log.appendChild(bubble("assistant", short));
          log.scrollTop = log.scrollHeight;
          speak(short);
          return;
        }

        // walkthrough: show the numbers alongside the narration
        const m = b.metrics;
        const card = document.createElement("div");
        card.className = "jarvis-brief-card";
        const rows = [
          ["SUBSCRIBERS", m.subscribers === null ? "—" : m.subscribers.toLocaleString()],
          ["VIEWS", m.views === null ? "—" : m.views.toLocaleString()],
          ["RENDERING", String(m.in_progress)],
          ["READY", String(m.ready_for_review)],
          ["PUBLISHED", String(m.published)],
          ["FAILED", String(m.failed)],
        ];
        card.innerHTML = rows
          .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`)
          .join("");
        log.appendChild(card);

        const spoken = custom + b.spoken;
        log.appendChild(bubble("assistant", spoken));
        log.scrollTop = log.scrollHeight;
        speak(spoken);
      } catch (_) {
        const fallback = greetingText || "Ready when you are.";
        log.appendChild(bubble("assistant", fallback));
        speak(fallback);
      }
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

    const sentryToggle = $("#sentry-toggle");    const sentryState = $("#sentry-state");
    const sentrySens = $("#sentry-sens");
    const sentryLog = $("#sentry-log");
    if (sentryToggle && window.SentryMode) {
      sentrySens.addEventListener("input", () => {
        SentryMode.setSensitivity(Number(sentrySens.value) / 100);
      });
      sentryToggle.addEventListener("click", async () => {
        if (SentryMode.isArmed()) {
          SentryMode.stop();
          sentryToggle.textContent = "Arm Sentry";
          sentryState.textContent = "(off)";
          return;
        }
        sentryToggle.disabled = true;
        sentryState.textContent = "(starting camera…)";
        const res = await SentryMode.start({
          sensitivity: Number(sentrySens.value) / 100,
          onMotion: (info) => {
            const line = `Motion detected at ${new Date(info.at).toLocaleTimeString()} (${info.percent}% of frame changed).`;
            if (sentryLog) {
              const el = document.createElement("div");
              el.textContent = line;
              sentryLog.prepend(el);
              while (sentryLog.children.length > 8) sentryLog.lastChild.remove();
            }
            const spoken = "Motion detected on camera.";
            log.appendChild(bubble("assistant", spoken));
            log.scrollTop = log.scrollHeight;
            speak(spoken);
            if ("Notification" in window && Notification.permission === "granted") {
              new Notification("Sentry Mode", { body: line });
            }
          },
        });
        sentryToggle.disabled = false;
        if (!res.ok) {
          sentryState.textContent = "(camera unavailable)";
          if (sentryLog) sentryLog.textContent = res.error || "Couldn't start the camera.";
          return;
        }
        sentryToggle.textContent = "Disarm Sentry";
        sentryState.textContent = "(armed — calibrating)";
        setTimeout(() => {
          if (SentryMode.isArmed()) sentryState.textContent = "(armed)";
        }, 3200);
      });
    } else if (sentryToggle) {
      sentryToggle.disabled = true;
      if (sentryState) sentryState.textContent = "(module didn't load)";
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
      lastInterimLength = 0;
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
      if (window.MouseFX) MouseFX.resume();
      // Never leave the webcam running once this panel is gone -- an
      // invisible active camera is exactly the kind of thing that should
      // not outlive the UI that turned it on.
      if (window.SentryMode && SentryMode.isArmed()) SentryMode.stop();
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

      // Echo protection that doesn't block real interruptions. The old
      // approach dropped everything while Jarvis was speaking, which also
      // killed barge-in. Instead, check whether what came through the mic is
      // actually a chunk of what Jarvis just said -- that's an echo. Anything
      // else is a genuine interruption and goes through.
      const lower = cleaned.toLowerCase();
      if (lastSpokenText && lower.length > 8 && lastSpokenText.includes(lower)) return;

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
          // Barge-in: the first interim result means the user has started
          // talking, so cut Jarvis off immediately rather than letting him
          // finish over the top of them.
          if (jarvisSpeaking && text.trim().length > 1) stopSpeaking();

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
          // How long to wait after speech stops before deciding you're done.
          //
          // Previous logic shortened this for LONG phrases, which was exactly
          // backwards: length is not evidence that someone has finished. A
          // long sentence means they're mid-flow and more likely to pause for
          // breath, so cutting them off fastest right then was the worst
          // possible behaviour.
          //
          // Now: an obviously unfinished ending (trailing conjunction/article)
          // or a still-growing utterance both buy MORE time. Only a short,
          // complete-sounding phrase that has stopped growing gets the quick
          // turnaround.
          const trimmed = text.trim();
          const words = trimmed.split(/\s+/).length;
          const endsIncomplete = /\b(and|but|or|so|to|the|a|an|of|for|with|is|it|that|my|i|can|you|then|if|because|about|like|was|were|when|how|what|why|there|this|they|we|he|she|at|in|on|be|do|have|its|their|our)$/i.test(trimmed);
          const stillGrowing = trimmed.length > lastInterimLength;
          lastInterimLength = trimmed.length;

          let waitMs = 1200;
          if (endsIncomplete) waitMs = 2400;        // clearly mid-sentence
          else if (words >= 8 && stillGrowing) waitMs = 2000;  // long and still going -- give room
          else if (words >= 8) waitMs = 1500;       // long but paused
          else if (words <= 2) waitMs = 2000;       // too short to be a real command yet

          silenceTimer = setTimeout(() => {
            if (myToken !== sessionToken) return;
            const toSend = pendingText;
            pendingText = "";
            lastInterimLength = 0;
            if (caption) caption.textContent = "";
            if (toSend && toSend.trim()) handleResult(toSend);
          }, waitMs);
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

      // Unlock audio while we're inside a real user gesture. Browsers keep
      // AudioContexts suspended until one happens, and a suspended context
      // makes Jarvis's replies silently inaudible later -- play() succeeds,
      // but no sound comes out. Doing it here means his first reply is
      // actually audible.
      try {
        if (!speechAudioCtx) speechAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (speechAudioCtx.state === "suspended") await speechAudioCtx.resume().catch(() => {});
      } catch (_) {}

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
