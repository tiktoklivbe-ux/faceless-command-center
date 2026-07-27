/**
 * easter-eggs.js — pure vibe, zero functional risk.
 * Konami code (↑↑↓↓←→←→BA) triggers a one-off confetti burst and a toast.
 * Self-contained: doesn't touch app state, safe to delete this file and its
 * <script> tag in index.html any time with no side effects elsewhere.
 */
(function () {
  const SEQUENCE = [
    "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
    "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight",
    "b", "a",
  ];
  let progress = 0;

  function burstConfetti() {
    const canvas = document.createElement("canvas");
    canvas.style.cssText =
      "position:fixed;inset:0;z-index:10000;pointer-events:none;";
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    const colors = ["#00e8ff", "#b26bff", "#ff2f9e", "#39ffa0", "#ffd23d"];
    const pieces = Array.from({ length: 160 }, () => ({
      x: innerWidth / 2,
      y: innerHeight / 2,
      vx: (Math.random() - 0.5) * 14,
      vy: (Math.random() - 0.5) * 14 - 4,
      size: 3 + Math.random() * 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 1,
      spin: Math.random() * Math.PI * 2,
      spinSpeed: (Math.random() - 0.5) * 0.3,
    }));

    function frame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      for (const p of pieces) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.25; // gravity
        p.life -= 0.012;
        p.spin += p.spinSpeed;
        if (p.life <= 0) continue;
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(p.life, 0);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin);
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 6;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      }
      if (alive) requestAnimationFrame(frame);
      else canvas.remove();
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener("keydown", (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === SEQUENCE[progress]) {
      progress++;
      if (progress === SEQUENCE.length) {
        progress = 0;
        burstConfetti();
        if (window.toast) window.toast("AETHER MAX POWER ACTIVATED ✦");
      }
    } else {
      progress = key === SEQUENCE[0] ? 1 : 0;
    }
  });

  // ---------------------------------------------------------------- shortcuts overlay
  const SHORTCUTS = [
    ["/", "Focus the command bar"],
    ["Esc", "Close any open panel or agent detail"],
    ["WASD / drag", "Fly around the constellation"],
    ["Scroll", "Zoom in/out"],
    ["Click an agent", "Open its detail panel"],
    ["?", "Show this list"],
  ];

  function toggleShortcutsOverlay() {
    const existing = document.getElementById("shortcuts-overlay");
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement("div");
    overlay.id = "shortcuts-overlay";
    overlay.style.cssText = `
      position:fixed; inset:0; z-index:9998; display:flex; align-items:center; justify-content:center;
      background:rgba(1,3,10,0.72); backdrop-filter: blur(3px);
    `;
    overlay.innerHTML = `
      <div style="
        background:#070d1c; border:1px solid rgba(0,232,255,0.25); border-radius:12px;
        padding:24px 28px; min-width:280px; box-shadow:0 0 40px rgba(0,232,255,0.15);
        font-family:'Rajdhani',sans-serif; color:#d8e6ff;
      ">
        <div style="font-family:'Orbitron',sans-serif; font-size:15px; letter-spacing:1px; margin-bottom:14px; color:#00e8ff;">
          KEYBOARD SHORTCUTS
        </div>
        ${SHORTCUTS.map(([key, desc]) => `
          <div style="display:flex; justify-content:space-between; gap:24px; padding:6px 0; font-size:13px; border-bottom:1px solid rgba(120,150,220,0.1);">
            <span style="color:#7c8db5;">${desc}</span>
            <kbd style="background:rgba(0,232,255,0.1); border:1px solid rgba(0,232,255,0.3); border-radius:4px; padding:2px 8px; font-family:'Share Tech Mono',monospace; color:#00e8ff;">${key}</kbd>
          </div>`).join("")}
        <div style="margin-top:14px; font-size:11px; color:#7c8db5; text-align:center;">press ? or Esc to close</div>
      </div>
    `;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.key === "?") toggleShortcutsOverlay();
    if (e.key === "Escape") {
      const o = document.getElementById("shortcuts-overlay");
      if (o) o.remove();
    }
  });
})();
