/**
 * lock.js — password gate and idle auto-lock.
 *
 * Two things:
 *  1. On load, ask the server whether the app is locked. If it is, cover
 *     everything with a lock screen until the right password is entered.
 *  2. While unlocked, watch for inactivity and lock again after the
 *     configured idle period.
 *
 * The idle timer is deliberately reset by real interaction only (mouse,
 * keyboard, touch, scroll) -- not by the app's own background polling, which
 * would keep it "active" forever and make auto-lock never fire.
 */
(function () {
  let idleTimer = null;
  let idleMinutes = 15;
  let armed = false;

  function overlay(html) {
    let el = document.getElementById("lock-screen");
    if (!el) {
      el = document.createElement("div");
      el.id = "lock-screen";
      document.body.appendChild(el);
    }
    el.innerHTML = html;
    el.style.display = "flex";
    return el;
  }

  function hideOverlay() {
    const el = document.getElementById("lock-screen");
    if (el) el.style.display = "none";
  }

  function showLock(message) {
    const el = overlay(`
      <div class="lock-card">
        <div class="lock-title">Locked</div>
        <div class="lock-sub">${message || "Enter your password to continue."}</div>
        <input type="password" id="lock-pass" placeholder="Password" autocomplete="current-password"/>
        <button class="btn" id="lock-go">Unlock</button>
        <div class="lock-err" id="lock-err"></div>
      </div>`);

    const input = el.querySelector("#lock-pass");
    const err = el.querySelector("#lock-err");
    input.focus();

    const attempt = async () => {
      err.textContent = "";
      try {
        const r = await fetch("/api/lock/unlock", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: input.value }),
        });
        if (!r.ok) {
          err.textContent = "Wrong password.";
          input.value = "";
          input.focus();
          return;
        }
        hideOverlay();
        startIdleWatch();
      } catch (e) {
        err.textContent = "Couldn't reach the server.";
      }
    };

    el.querySelector("#lock-go").addEventListener("click", attempt);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
  }

  async function lockNow() {
    try { await fetch("/api/lock/lock", { method: "POST" }); } catch (e) {}
    stopIdleWatch();
    showLock("Locked after inactivity.");
  }

  function resetIdle() {
    if (!armed) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(lockNow, idleMinutes * 60 * 1000);
  }

  const EVENTS = ["mousedown", "mousemove", "keydown", "wheel", "touchstart", "scroll"];

  function startIdleWatch() {
    armed = true;
    EVENTS.forEach((e) => window.addEventListener(e, resetIdle, { passive: true }));
    resetIdle();
  }

  function stopIdleWatch() {
    armed = false;
    clearTimeout(idleTimer);
    EVENTS.forEach((e) => window.removeEventListener(e, resetIdle));
  }

  window.AppLock = {
    async init() {
      try {
        const s = await fetch("/api/lock/status").then((r) => r.json());
        idleMinutes = s.idle_minutes || 15;
        if (s.locked) showLock();
        else if (s.enabled) startIdleWatch();
      } catch (e) {
        // If the status check fails, don't lock the user out of their own app.
      }
    },
    lockNow,
    setIdleMinutes(m) { idleMinutes = Math.max(1, m); resetIdle(); },
  };

  document.addEventListener("DOMContentLoaded", () => window.AppLock.init());
})();
