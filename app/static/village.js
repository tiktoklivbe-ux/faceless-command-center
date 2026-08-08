/**
 * village.js — the settlement view.
 *
 * A 3/4 angled view (isometric-ish) rather than a flat side-on one: you look
 * down at the village at an angle, so buildings have depth and the layout has
 * room to grow as more agents and districts get added. Dirt paths connect
 * everything, and villagers walk those paths between buildings.
 *
 * Everything is drawn with primitives at a fixed internal resolution and
 * scaled with smoothing off, so it stays crisp pixel art rather than blurring.
 * No image assets, no dependencies.
 */
(function () {
  const VW = 640;
  const VH = 400;

  // Isometric tile size. Buildings and paths are positioned on a grid in
  // "tile space" and projected to screen, which keeps placement simple and
  // makes the whole village easy to extend later.
  const TW = 44;   // tile width  (full diamond)
  const TH = 22;   // tile height (full diamond)
  const ORIGIN_X = VW / 2;
  const ORIGIN_Y = 92;

  // Warm dusk palette -- earthy, not the old cold sci-fi blues.
  const PAL = {
    skyTop: "#2f2144",
    skyMid: "#7a3f56",
    skyLow: "#c96a4e",
    skyHorizon: "#e9a05c",
    sun: "#ffd79a",
    dirt: "#7a5a3c",
    dirtDark: "#654a31",
    dirtLight: "#8d6a48",
    grass: "#4e5c3a",
    grassDark: "#3f4b30",
    path: "#9c7a52",
  };

  let canvas, ctx, raf;
  let agents = [];
  let plots = [];
  let villagers = [];
  let t = 0;
  let hovered = -1;
  let mx = -1, my = -1;
  let camShakeUntil = 0;

  // Tier drives building size. The five real pipeline stages plus ideation do
  // the actual work of making a video; the rest are support. The skyline
  // should reflect that honestly rather than making everything look equal.
  const TIER = {
    athena: 3, orpheus: 3, iris: 3, hephaestus: 3, hermes: 3, apollo: 3,
    chronos: 2, argus: 2, atlas: 2, daedalus: 2, blitz: 2, midas: 2,
  };
  const tierOf = (id) => TIER[id] || 1;

  function iso(gx, gy) {
    return {
      x: ORIGIN_X + (gx - gy) * (TW / 2),
      y: ORIGIN_Y + (gx + gy) * (TH / 2),
    };
  }

  // ---------------------------------------------------------------- layout
  function layout() {
    plots = [];
    const sorted = [...agents].sort((a, b) => tierOf(b.id) - tierOf(a.id));

    // Village square in the middle, buildings arranged in rings around it so
    // the important ones sit closest to the centre.
    const slots = [];
    // inner ring (6 slots) -- pipeline agents
    [[-1, -1], [0, -2], [1, -1], [1, 1], [0, 2], [-1, 1]].forEach((p) => slots.push(p));
    // middle ring
    [[-3, -2], [-2, -3], [0, -4], [2, -3], [3, -2], [3, 2], [2, 3], [0, 4], [-2, 3], [-3, 2]].forEach((p) => slots.push(p));
    // outer ring
    [[-5, -3], [-3, -5], [0, -6], [3, -5], [5, -3], [5, 3], [3, 5], [0, 6], [-3, 5], [-5, 3]].forEach((p) => slots.push(p));

    sorted.forEach((a, i) => {
      const slot = slots[i % slots.length];
      const tier = tierOf(a.id);
      plots.push({
        agent: a,
        gx: slot[0], gy: slot[1],
        tier,
        h: tier === 3 ? 46 : tier === 2 ? 30 : 20,
        w: tier === 3 ? 30 : tier === 2 ? 24 : 18,
        seed: (i * 37) % 100,
      });
    });
    // Draw order: far (small gx+gy) first so nearer buildings overlap.
    plots.sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));
  }

  // ---------------------------------------------------------------- villagers
  function spawnVillager(plot, wandering) {
    const start = iso(plot.gx, plot.gy);
    villagers.push({
      agentId: plot.agent.id,
      gx: plot.gx, gy: plot.gy,
      tx: plot.gx, ty: plot.gy,
      x: start.x, y: start.y,
      colour: plot.agent.color || "#e8d5b0",
      speed: 0.16 + Math.random() * 0.1,
      bob: Math.random() * 6,
      wandering,           // ambient townsfolk vs. an agent actively working
      pickNewTargetAt: 0,
    });
  }

  function syncVillagers() {
    const working = new Set(agents.filter((a) => a.status === "running").map((a) => a.id));

    // Working agents get a villager out on the paths.
    villagers = villagers.filter((v) => v.wandering || working.has(v.agentId));
    working.forEach((id) => {
      if (!villagers.some((v) => v.agentId === id && !v.wandering)) {
        const p = plots.find((pp) => pp.agent.id === id);
        if (p) spawnVillager(p, false);
      }
    });

    // Ambient townsfolk so the place feels inhabited even when idle.
    const ambientWanted = 14;
    const ambient = villagers.filter((v) => v.wandering).length;
    for (let i = ambient; i < ambientWanted && plots.length; i++) {
      const p = plots[Math.floor(Math.random() * plots.length)];
      spawnVillager(p, true);
    }
  }

  function updateVillagers() {
    villagers.forEach((v) => {
      const target = iso(v.tx, v.ty);
      const dx = target.x - v.x, dy = target.y - v.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1.5) {
        if (t > v.pickNewTargetAt) {
          // Wander to a nearby tile, biased to stay near the village.
          v.tx = Math.max(-7, Math.min(7, v.tx + (Math.random() * 4 - 2)));
          v.ty = Math.max(-7, Math.min(7, v.ty + (Math.random() * 4 - 2)));
          v.pickNewTargetAt = t + 40 + Math.random() * 120;
        }
      } else {
        v.x += (dx / dist) * v.speed * 2.2;
        v.y += (dy / dist) * v.speed * 2.2;
      }
      v.bob += 0.2;
    });
  }

  // ---------------------------------------------------------------- drawing
  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, VH * 0.55);
    g.addColorStop(0, PAL.skyTop);
    g.addColorStop(0.45, PAL.skyMid);
    g.addColorStop(0.78, PAL.skyLow);
    g.addColorStop(1, PAL.skyHorizon);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);

    // Sun low on the horizon
    const sx = VW * 0.72, sy = VH * 0.30, r = 26;
    for (let yy = -r; yy <= r; yy += 2) {
      const half = Math.floor(Math.sqrt(Math.max(r * r - yy * yy, 0)));
      ctx.fillStyle = yy < -6 ? "#fff0c8" : yy < 8 ? PAL.sun : "#ffb066";
      ctx.fillRect(sx - half, sy + yy, half * 2, 2);
    }

    // Drifting clouds
    ctx.fillStyle = "rgba(255,205,170,0.20)";
    for (let i = 0; i < 6; i++) {
      const cx = ((t * 0.12 + i * 150) % (VW + 120)) - 60;
      const cy = 24 + i * 15;
      ctx.fillRect(cx, cy, 46, 5);
      ctx.fillRect(cx + 12, cy - 4, 26, 4);
    }

    // Distant hills
    ctx.fillStyle = "#5a3a4a";
    for (let i = 0; i < 7; i++) {
      const hx = i * 105 - 30, hy = VH * 0.36;
      ctx.beginPath();
      ctx.moveTo(hx, hy + 30);
      ctx.lineTo(hx + 55, hy - 16);
      ctx.lineTo(hx + 110, hy + 30);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawGroundTile(gx, gy, colour) {
    const p = iso(gx, gy);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - TH / 2);
    ctx.lineTo(p.x + TW / 2, p.y);
    ctx.lineTo(p.x, p.y + TH / 2);
    ctx.lineTo(p.x - TW / 2, p.y);
    ctx.closePath();
    ctx.fill();
  }

  function drawGround() {
    // The dirt plateau the village sits on.
    for (let gx = -9; gx <= 9; gx++) {
      for (let gy = -9; gy <= 9; gy++) {
        if (Math.abs(gx) + Math.abs(gy) > 12) continue;
        const edge = Math.abs(gx) + Math.abs(gy) > 9;
        const n = ((gx * 7 + gy * 13) % 5 + 5) % 5;
        let c = edge ? (n < 2 ? PAL.grass : PAL.grassDark)
                     : (n === 0 ? PAL.dirtLight : n === 1 ? PAL.dirtDark : PAL.dirt);
        // Paths radiate from the centre square.
        if (Math.abs(gx) <= 1 || Math.abs(gy) <= 1) c = PAL.path;
        drawGroundTile(gx, gy, c);
      }
    }

    // Scattered pebbles and tufts for texture
    for (let i = 0; i < 60; i++) {
      const gx = ((i * 13) % 17) - 8;
      const gy = ((i * 29) % 17) - 8;
      if (Math.abs(gx) + Math.abs(gy) > 11) continue;
      const p = iso(gx, gy);
      ctx.fillStyle = i % 3 === 0 ? "rgba(60,45,30,0.5)" : "rgba(120,140,80,0.35)";
      ctx.fillRect(p.x + ((i * 7) % 20) - 10, p.y + ((i * 11) % 8) - 4, 2, 2);
    }
  }

  function drawBuilding(p, idx) {
    const base = iso(p.gx, p.gy);
    const working = p.agent.status === "running";
    const err = p.agent.status === "error";
    const w = p.w, h = p.h;

    const bodyL = err ? "#5c3038" : "#6b4a35";   // left face, lit by the sun
    const bodyR = err ? "#42222a" : "#4e3626";   // right face, in shadow
    const roof = err ? "#7a3a44" : "#8a5a3a";

    // Shadow on the ground
    ctx.fillStyle = "rgba(40,25,20,0.35)";
    ctx.beginPath();
    ctx.moveTo(base.x, base.y - TH / 3);
    ctx.lineTo(base.x + TW / 2.2, base.y);
    ctx.lineTo(base.x, base.y + TH / 3);
    ctx.lineTo(base.x - TW / 2.2, base.y);
    ctx.closePath();
    ctx.fill();

    // Two visible wall faces
    ctx.fillStyle = bodyL;
    ctx.beginPath();
    ctx.moveTo(base.x - w / 2, base.y);
    ctx.lineTo(base.x, base.y + TH / 3);
    ctx.lineTo(base.x, base.y + TH / 3 - h);
    ctx.lineTo(base.x - w / 2, base.y - h);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = bodyR;
    ctx.beginPath();
    ctx.moveTo(base.x + w / 2, base.y);
    ctx.lineTo(base.x, base.y + TH / 3);
    ctx.lineTo(base.x, base.y + TH / 3 - h);
    ctx.lineTo(base.x + w / 2, base.y - h);
    ctx.closePath();
    ctx.fill();

    // Roof
    ctx.fillStyle = roof;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y + TH / 3 - h);
    ctx.lineTo(base.x + w / 2, base.y - h);
    ctx.lineTo(base.x, base.y - h - TH / 3);
    ctx.lineTo(base.x - w / 2, base.y - h);
    ctx.closePath();
    ctx.fill();

    // Windows: more of them lit, and flickering, when the agent is working.
    const rows = Math.max(1, Math.floor(h / 14));
    for (let r = 0; r < rows; r++) {
      const wy = base.y - h + 10 + r * 14;
      [-1, 1].forEach((side) => {
        const seed = (p.seed + r * 11 + (side + 2) * 5) % 100;
        const on = working ? seed < 80 : seed < 28;
        if (!on) return;
        const flick = working && ((Math.floor(t * 0.09) + seed) % 19 === 0);
        ctx.fillStyle = err ? "#ff8a8a" : flick ? "#fff3cf" : working ? "#ffd489" : "#5f4a3c";
        ctx.fillRect(base.x + side * (w / 4) - 2, wy, 4, 5);
      });
    }

    // Chimney smoke when working -- readable from a distance without text.
    if (working) {
      for (let i = 0; i < 4; i++) {
        const life = (t * 0.6 + i * 14) % 56;
        const sy = base.y - h - TH / 3 - life * 0.8;
        ctx.fillStyle = `rgba(220,200,190,${0.28 - life / 200})`;
        ctx.fillRect(base.x + 4 + Math.sin(life * 0.12) * 4, sy, 3, 3);
      }
    }

    // Name
    ctx.font = "7px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = idx === hovered ? "#fff6e2" : "rgba(255,238,214,0.72)";
    ctx.fillText(p.agent.name.toUpperCase(), base.x, base.y + TH / 3 + 10);

    if (working) drawProgress(p, base, h);
  }

  function drawProgress(p, base, h) {
    const barW = 46;
    const bx = base.x - barW / 2;
    const by = base.y - h - TH / 3 - 18;

    ctx.fillStyle = "rgba(20,12,10,0.8)";
    ctx.fillRect(bx - 1, by - 1, barW + 2, 7);
    ctx.strokeStyle = "rgba(255,200,130,0.55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 0.5, by - 0.5, barW + 1, 6);

    // Indeterminate sweep, not a percentage: nothing in the pipeline measures
    // per-agent completion, so a number here would be invented.
    const sweep = 16;
    const pos = (t * 1.3 + p.seed * 3) % (barW + sweep);
    const x0 = bx + Math.max(0, pos - sweep);
    const x1 = bx + Math.min(barW, pos);
    if (x1 > x0) {
      ctx.fillStyle = "#ffc46b";
      ctx.fillRect(x0, by, x1 - x0, 5);
    }

    const task = p.agent.task || p.agent.title || "working";
    ctx.font = "5px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffe9c8";
    ctx.fillText(String(task).toUpperCase().slice(0, 30), base.x, by - 4);
  }

  function drawVillager(v) {
    const x = Math.round(v.x);
    const step = Math.sin(v.bob) > 0 ? 0 : 1;
    const y = Math.round(v.y) - step;

    ctx.fillStyle = "rgba(35,22,18,0.35)";
    ctx.fillRect(x - 3, y + 1, 7, 2);
    ctx.fillStyle = "#f0c9a2";           // head
    ctx.fillRect(x - 1, y - 9, 3, 3);
    ctx.fillStyle = v.wandering ? "#8a7256" : v.colour;  // body
    ctx.fillRect(x - 2, y - 6, 5, 5);
    ctx.fillStyle = "#33241c";           // legs
    ctx.fillRect(x - 2, y - 1, 2, 2 - step);
    ctx.fillRect(x + 1, y - 1, 2, 1 + step);
  }

  function hitTest() {
    hovered = -1;
    if (mx < 0) return;
    // Test nearest-first so a front building wins over one behind it.
    for (let i = plots.length - 1; i >= 0; i--) {
      const p = plots[i];
      const b = iso(p.gx, p.gy);
      if (mx > b.x - p.w / 2 - 3 && mx < b.x + p.w / 2 + 3 &&
          my > b.y - p.h - 18 && my < b.y + TH / 2 + 12) {
        hovered = i;
        break;
      }
    }
    if (canvas) canvas.style.cursor = hovered >= 0 ? "pointer" : "grab";
  }

  function drawTooltip() {
    if (hovered < 0) return;
    const p = plots[hovered];
    const b = iso(p.gx, p.gy);
    const lines = [
      p.agent.name.toUpperCase(),
      p.agent.title || "",
      `STATUS: ${(p.agent.status || "idle").toUpperCase()}`,
    ];
    if (p.agent.task) lines.push(String(p.agent.task).slice(0, 36));

    ctx.font = "6px monospace";
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10;
    const hgt = lines.length * 9 + 7;
    let tx = Math.min(Math.max(b.x - w / 2, 3), VW - w - 3);
    let ty = b.y - p.h - hgt - 26;
    if (ty < 3) ty = b.y + 18;

    ctx.fillStyle = "rgba(24,14,10,0.94)";
    ctx.fillRect(tx, ty, w, hgt);
    ctx.strokeStyle = "rgba(255,196,107,0.65)";
    ctx.strokeRect(tx + 0.5, ty + 0.5, w - 1, hgt - 1);
    ctx.textAlign = "left";
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? "#ffc46b" : "#efe0cf";
      ctx.fillText(l, tx + 5, ty + 11 + i * 9);
    });
  }

  function frame() {
    t += 1;
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    if (t < camShakeUntil) {
      ctx.translate((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3);
    }

    drawSky();
    drawGround();
    updateVillagers();
    hitTest();

    // Depth sort buildings and villagers together so people correctly pass in
    // front of and behind houses.
    const drawables = [
      ...plots.map((p, i) => ({ kind: "b", p, i, depth: iso(p.gx, p.gy).y })),
      ...villagers.map((v) => ({ kind: "v", v, depth: v.y })),
    ].sort((a, b) => a.depth - b.depth);

    drawables.forEach((d) => {
      if (d.kind === "b") drawBuilding(d.p, d.i);
      else drawVillager(d.v);
    });

    drawTooltip();
    ctx.restore();
    raf = requestAnimationFrame(frame);
  }

  function resize() {
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const scale = Math.max(1, Math.min(parent.clientWidth / VW, parent.clientHeight / VH));
    canvas.style.width = Math.floor(VW * scale) + "px";
    canvas.style.height = Math.floor(VH * scale) + "px";
  }

  window.VillageView = {
    mount(container) {
      container.innerHTML = `<div class="village-wrap"><canvas id="village-canvas" width="${VW}" height="${VH}"></canvas></div>`;
      canvas = document.getElementById("village-canvas");
      ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;

      canvas.addEventListener("mousemove", (e) => {
        const r = canvas.getBoundingClientRect();
        mx = ((e.clientX - r.left) / r.width) * VW;
        my = ((e.clientY - r.top) / r.height) * VH;
      });
      canvas.addEventListener("mouseleave", () => { mx = -1; my = -1; });
      canvas.addEventListener("click", () => {
        if (hovered >= 0 && window.openAgent) window.openAgent(plots[hovered].agent.id);
      });

      window.addEventListener("resize", resize);
      resize();
      if (!raf) frame();
    },

    update(list) {
      const changed = list.length !== agents.length;
      agents = list;
      if (changed || !plots.length) layout();
      else plots.forEach((p) => {
        const fresh = agents.find((a) => a.id === p.agent.id);
        if (fresh) p.agent = fresh;
      });
      syncVillagers();
    },

    shake() { camShakeUntil = t + 20; },

    unmount() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      window.removeEventListener("resize", resize);
      villagers = [];
      plots = [];
    },
  };
})();
