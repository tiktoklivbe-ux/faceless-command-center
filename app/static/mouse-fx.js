/**
 * mouse-fx.js — ambient mouse-reactive layer for AETHER.
 * Self-contained: draws its own canvas on top of everything, doesn't touch
 * app state or command-center.js. Safe to remove by deleting the <script>
 * tag in index.html if it's ever unwanted.
 *
 * Effects:
 *  - A soft glowing orb that follows the cursor with slight lag
 *  - A trail of fading particles spawned as the mouse moves
 *  - A ripple burst on click
 */
(function () {
  const canvas = document.createElement("canvas");
  canvas.id = "mousefx";
  canvas.style.cssText =
    "position:fixed;inset:0;z-index:9999;pointer-events:none;mix-blend-mode:screen;";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  function resize() {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  const COLORS = ["#00e8ff", "#b26bff", "#ff2f9e", "#39ffa0"];
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  const cursor = { x: innerWidth / 2, y: innerHeight / 2 };
  const orb = { x: cursor.x, y: cursor.y };
  let particles = [];
  let ripples = [];
  let lastSpawn = 0;

  window.addEventListener("mousemove", (e) => {
    cursor.x = e.clientX;
    cursor.y = e.clientY;

    if (prefersReducedMotion) return;

    const now = performance.now();
    if (now - lastSpawn > 22) {
      lastSpawn = now;
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      for (let i = 0; i < 2; i++) {
        particles.push({
          x: cursor.x + (Math.random() - 0.5) * 8,
          y: cursor.y + (Math.random() - 0.5) * 8,
          vx: (Math.random() - 0.5) * 0.6,
          vy: (Math.random() - 0.5) * 0.6 - 0.3,
          life: 1,
          decay: 0.012 + Math.random() * 0.012,
          size: 1.5 + Math.random() * 2.5,
          color,
        });
      }
    }
    if (particles.length > 220) particles.splice(0, particles.length - 220);
  });

  window.addEventListener("mousedown", (e) => {
    ripples.push({ x: e.clientX, y: e.clientY, r: 4, alpha: 0.55 });
  });

  function frame() {
    ctx.clearRect(0, 0, innerWidth, innerHeight);

    // lagging glow orb
    orb.x += (cursor.x - orb.x) * 0.16;
    orb.y += (cursor.y - orb.y) * 0.16;
    const g = ctx.createRadialGradient(orb.x, orb.y, 0, orb.x, orb.y, 70);
    g.addColorStop(0, "rgba(0,232,255,0.16)");
    g.addColorStop(1, "rgba(0,232,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(orb.x, orb.y, 70, 0, Math.PI * 2);
    ctx.fill();

    // particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.max(p.life, 0);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    // click ripples
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.r += 3.5;
      r.alpha *= 0.94;
      if (r.alpha < 0.02) {
        ripples.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = `rgba(0,232,255,${r.alpha})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
