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

  window.renderJarvisPanel = function (body) {
    body.innerHTML = `
      <div class="jarvis-wrap">
        <h1 style="margin-bottom:2px">🎙️ Jarvis</h1>
        <div class="bp-sub">Talks back, and can check real channel/job status or start a video. Doesn't control your computer yet — that's a separate future build.</div>
        <div class="jarvis-log" id="jarvis-log"></div>
        <div class="jarvis-input-row">
          <button class="icon-btn" id="jarvis-mic" title="Hold to talk">🎤</button>
          <button class="icon-btn" id="jarvis-wake" title="Toggle 'Hey Jarvis' always-listening mode">👂</button>
          <input id="jarvis-text" placeholder="Type, or use the mic…" autocomplete="off"/>
          <button class="icon-btn" id="jarvis-send" title="Send">▸</button>
        </div>
        <div class="bp-sub" id="jarvis-status" style="margin-top:6px"></div>
      </div>
    `;

    const log = $("#jarvis-log");
    const input = $("#jarvis-text");
    const micBtn = $("#jarvis-mic");
    const wakeBtn = $("#jarvis-wake");
    const sendBtn = $("#jarvis-send");
    const status = $("#jarvis-status");

    log.appendChild(bubble("assistant",
      "Hey, I'm here. Type, hold the mic to talk once, or turn on 'Hey Jarvis' mode to leave the mic open."));

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

    recognizer = new SpeechRecognition();
    recognizer.interimResults = false;
    recognizer.lang = "en-US";

    function stopEverything() {
      mode = "off";
      awake = false;
      clearTimeout(restartTimer);
      micBtn.classList.remove("jarvis-mic-active");
      wakeBtn.classList.remove("jarvis-mic-active");
      status.textContent = "";
      try { recognizer.stop(); } catch (_) {}
    }

    recognizer.onresult = (e) => {
      const text = e.results[e.results.length - 1][0].transcript;
      if (mode === "ptt") {
        send(log, text);
        return;
      }
      // wake mode
      if (!awake) {
        if (containsWakePhrase(text)) {
          awake = true;
          status.textContent = "Listening for your command…";
          const rest = stripWakePhrase(text);
          if (rest) { awake = false; send(log, rest); status.textContent = "Say 'Hey Jarvis' any time."; }
        }
      } else {
        awake = false;
        status.textContent = "Say 'Hey Jarvis' any time.";
        send(log, text);
      }
    };

    recognizer.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return; // expected, just keep going
      status.textContent = `Mic error: ${e.error}`;
    };

    recognizer.onend = () => {
      // The Web Speech API stops itself periodically even in "continuous"
      // mode on most browsers -- auto-restart if we're still meant to be
      // listening, so wake mode actually feels always-on.
      if (mode === "wake") {
        restartTimer = setTimeout(() => {
          try { recognizer.start(); } catch (_) {}
        }, 250);
      } else if (mode === "ptt") {
        mode = "off";
        micBtn.classList.remove("jarvis-mic-active");
      }
    };

    micBtn.addEventListener("click", () => {
      if (mode === "ptt") { stopEverything(); return; }
      stopEverything();
      mode = "ptt";
      micBtn.classList.add("jarvis-mic-active");
      status.textContent = "Listening…";
      recognizer.continuous = false;
      try { recognizer.start(); } catch (_) {}
    });

    wakeBtn.addEventListener("click", () => {
      if (mode === "wake") { stopEverything(); return; }
      stopEverything();
      mode = "wake";
      awake = false;
      wakeBtn.classList.add("jarvis-mic-active");
      status.textContent = "Say 'Hey Jarvis' any time.";
      recognizer.continuous = true;
      try { recognizer.start(); } catch (_) {}
    });
  };
})();
