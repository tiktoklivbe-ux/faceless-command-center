/**
 * village.js — the settlement view.
 *
 * Rendering approach, and why it's split:
 *
 * The previous version drew everything at 640x400 and scaled the whole canvas
 * up, which made buildings blurry and soft. Now the canvas runs at the
 * display's real resolution (including devicePixelRatio), so buildings,
 * ground and sky are drawn crisply at full size with smooth gradients and
 * clean edges.
 *
 * The PEOPLE are the only deliberately pixelated element: each villager is
 * drawn from a small sprite grid where every "pixel" is a scaled-up square.
 * That gives the pixel-art character look against detailed surroundings,
 * rather than everything being uniformly soft.
 */
(function () {
  // Isometric grid. Tile size is in real display pixels now, not a scaled
  // internal resolution.
  const TW = 96;
  const TH = 48;

  // Each villager pixel is this many screen pixels. Bigger = chunkier sprite.
  const PIX = 3;

  let canvas, ctx, raf;
  let W = 0, H = 0, DPR = 1;
  let agents = [];
  let plots = [];
  let villagers = [];
  let t = 0;
  let hovered = -1;
  let mx = -1, my = -1;

  // Camera. Pan by dragging, zoom with the wheel. Both are smoothed toward a
  // target rather than applied directly, which is what makes movement feel
  // like a camera gliding rather than the world snapping around.
  const cam = { x: 0, y: 0, z: 1, tx: 0, ty: 0, tz: 1 };
  let dragging = false, dragStart = null;

  function applyCamera() {
    // Ease toward the target every frame. 0.12 is slow enough to read as
    // deliberate motion, fast enough not to feel laggy.
    cam.x += (cam.tx - cam.x) * 0.12;
    cam.y += (cam.ty - cam.y) * 0.12;
    cam.z += (cam.tz - cam.z) * 0.12;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.translate(W / 2, H / 2);
    ctx.scale(cam.z, cam.z);
    ctx.translate(-W / 2 + cam.x, -H / 2 + cam.y);
  }

  /** Screen coords -> world coords, so hit-testing still works when the
   *  camera is panned or zoomed. */
  function screenToWorld(sx, sy) {
    return {
      x: (sx - W / 2) / cam.z + W / 2 - cam.x,
      y: (sy - H / 2) / cam.z + H / 2 - cam.y,
    };
  }

  /** Glide the camera to centre on a world point. */
  function focusOn(wx, wy, zoom) {
    cam.tx = W / 2 - wx;
    cam.ty = H / 2 - wy;
    if (zoom) cam.tz = zoom;
  }

  // Dusk palette
  const C = {
    skyTop: "#241a3a",
    skyMid: "#6d3a55",
    skyLow: "#c4643f",
    skyHot: "#f0a353",
    hillFar: "#4a2f47",
    hillNear: "#3a2438",
    dirt: "#8a6642",
    dirtAlt: "#7d5c3b",
    dirtEdge: "#6b4d31",
    path: "#a8applies",
    grass: "#55603a",
    grassAlt: "#4a5432",
    wallLit: "#c9a06d",
    wallShade: "#8a6a47",
    wallDark: "#6b503a",
    roofLit: "#a8503f",
    roofShade: "#7d3a2e",
    windowOn: "#ffd487",
    windowOff: "#4a3a30",
    stone: "#9a9188",
  };
  C.path = "#b08d5e";

  function iso(gx, gy) {
    return {
      x: W / 2 + (gx - gy) * (TW / 2),
      y: H * 0.34 + (gx + gy) * (TH / 2),
    };
  }

  // ---------------------------------------------------------------- villager sprite
  // A tiny bitmap, drawn as scaled squares. '.' = transparent.
  // This is what keeps the PEOPLE pixel-art while everything else stays crisp.
  const SPRITE_A = [
    "..hh..",
    ".hhhh.",
    ".fsf..",
    ".bbb..",
    ".bbb..",
    ".b.b..",
    ".l.l..",
    ".s.s..",
  ];
  const SPRITE_B = [
    "..hh..",
    ".hhhh.",
    "..fsf.",
    ".bbb..",
    ".bbb..",
    ".b.b..",
    "..ll..",
    "..ss..",
  ];

  function drawVillagerSprite(v) {
    const rows = (Math.floor(v.bob) % 2 === 0) ? SPRITE_A : SPRITE_B;
    const px = Math.round(v.x / PIX) * PIX;   // snap to the pixel grid so the
    const py = Math.round(v.y / PIX) * PIX;   // sprite never renders half-pixels

    // soft contact shadow (not pixelated -- it sits on detailed ground)
    ctx.fillStyle = "rgba(30,18,14,0.30)";
    ctx.beginPath();
    ctx.ellipse(px + PIX * 3, py + PIX * 8, PIX * 3.2, PIX * 1.1, 0, 0, Math.PI * 2);
    ctx.fill();

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let c = 0; c < row.length; c++) {
        const ch = row[c];
        if (ch === ".") continue;
        let col;
        if (ch === "h") col = v.hair;
        else if (ch === "f") col = v.skin;
        else if (ch === "s" && r === 2) col = v.skin;
        else if (ch === "b") col = v.shirt;
        else if (ch === "l") col = v.pants;
        else col = "#2e2118";
        ctx.fillStyle = col;
        ctx.fillRect(px + c * PIX, py + r * PIX, PIX, PIX);
      }
    }
  }

  // ---------------------------------------------------------------- people data
  const HAIR = ["#3a2a1e", "#5c3a22", "#241a14", "#7a5230", "#8d6b3f", "#2b2b2b"];
  const SKIN = ["#f0c9a0", "#d9a877", "#b8825a", "#8c5f3d", "#f5d8b8", "#6d4630"];
  const SHIRT = ["#7d8a5a", "#8a5a4a", "#5a6a8a", "#8a7a4a", "#6a5a7a", "#9a6a5a", "#4a7a6a"];
  const PANTS = ["#3a3a4a", "#4a3a2a", "#2e3a3a", "#443344"];
  const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

  function spawnVillager(plot, wandering, seed) {
    const p = iso(plot.gx, plot.gy);
    villagers.push({
      agentId: plot.agent.id,
      x: p.x, y: p.y,
      tx: plot.gx, ty: plot.gy,
      hair: pick(HAIR, seed), skin: pick(SKIN, seed * 3),
      shirt: wandering ? pick(SHIRT, seed * 7) : (plot.agent.color || pick(SHIRT, seed)),
      pants: pick(PANTS, seed * 5),
      speed: 0.5 + Math.random() * 0.45,
      bob: Math.random() * 10,
      wandering,
      nextPick: 0,
    });
  }

  function syncVillagers() {
    const working = new Set(agents.filter((a) => a.status === "running").map((a) => a.id));
    villagers = villagers.filter((v) => v.wandering || working.has(v.agentId));
    working.forEach((id) => {
      if (!villagers.some((v) => v.agentId === id && !v.wandering)) {
        const p = plots.find((pp) => pp.agent.id === id);
        if (p) spawnVillager(p, false, id.length * 13);
      }
    });
    const ambientWanted = 48;
    let ambient = villagers.filter((v) => v.wandering).length;
    for (let i = ambient; i < ambientWanted && plots.length; i++) {
      const anchor = (homes.length && i % 2) ? homes[i % homes.length] : plots[i % plots.length];
      spawnVillager(anchor.agent ? anchor : { gx: anchor.gx, gy: anchor.gy, agent: { id: `home${i}`, color: null } }, true, i * 17 + 3);
    }
  }

  function updateVillagers() {
    villagers.forEach((v) => {
      const target = iso(v.tx, v.ty);
      const dx = target.x - v.x, dy = target.y - v.y;
      const d = Math.hypot(dx, dy);
      if (d < 3) {
        if (t > v.nextPick) {
          v.tx = Math.max(-14, Math.min(14, v.tx + (Math.random() * 6 - 3)));
          v.ty = Math.max(-14, Math.min(14, v.ty + (Math.random() * 6 - 3)));
          v.nextPick = t + 60 + Math.random() * 150;
        }
      } else {
        v.x += (dx / d) * v.speed;
        v.y += (dy / d) * v.speed;
        v.bob += 0.16;
      }
    });
  }

  // ---------------------------------------------------------------- layout
  const TIER = {
    athena: 3, orpheus: 3, iris: 3, hephaestus: 3, hermes: 3, apollo: 3,
    chronos: 2, argus: 2, atlas: 2, daedalus: 2, blitz: 2, midas: 2,
  };
  const tierOf = (id) => TIER[id] || 1;

  // Small family homes filling out the town. They aren't agents -- they exist
  // so the place reads as a settlement people live in rather than an office
  // park of five buildings.
  let homes = [];

  function layout() {
    plots = [];
    homes = [];
    const sorted = [...agents].sort((a, b) => tierOf(b.id) - tierOf(a.id));

    // Agent buildings spread over a much wider area than before.
    const slots = [
      [-2,-2],[2,-2],[3,0],[2,2],[-2,2],[-3,0],
      [-5,-4],[-2,-6],[2,-6],[5,-4],[7,0],[5,4],[2,6],[-2,6],[-5,4],[-7,0],
      [-9,-6],[-4,-10],[4,-10],[9,-6],[9,6],[4,10],[-4,10],[-9,6],
      [-12,-3],[-3,-13],[3,-13],[12,-3],[12,3],[3,13],[-3,13],[-12,3],
    ];
    sorted.forEach((a, i) => {
      const sl = slots[i % slots.length];
      const tier = tierOf(a.id);
      plots.push({
        agent: a, gx: sl[0], gy: sl[1], tier,
        w: tier === 3 ? 78 : tier === 2 ? 62 : 50,
        h: tier === 3 ? 108 : tier === 2 ? 72 : 50,
        seed: i * 41,
      });
    });
    plots.sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));

    // Family homes: deterministic scatter so they don't jump around on every
    // relayout, kept clear of the paths and of agent plots.
    const taken = new Set(plots.map((p) => `${p.gx},${p.gy}`));
    let n = 0;
    for (let gx = -15; gx <= 15; gx++) {
      for (let gy = -15; gy <= 15; gy++) {
        if (Math.abs(gx) + Math.abs(gy) > 17) continue;
        if (Math.abs(gx) <= 1 || Math.abs(gy) <= 1) continue;      // keep roads clear
        if (taken.has(`${gx},${gy}`)) continue;
        const h = ((gx * 73856093) ^ (gy * 19349663)) >>> 0;
        if (h % 7 !== 0) continue;                                  // ~1 in 7 tiles
        homes.push({ gx, gy, w: 30 + (h % 3) * 5, h: 26 + (h % 4) * 5, seed: h % 100 });
        n++;
      }
    }
  }

  function drawHome(hm) {
    const b = iso(hm.gx, hm.gy);
    const w = hm.w, hh = hm.h, hw = w / 2;

    ctx.fillStyle = "rgba(35,20,15,0.25)";
    ctx.beginPath();
    ctx.ellipse(b.x - 5, b.y + 4, hw * 0.95, TH * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();

    // walls
    ctx.fillStyle = "#a98a63";
    ctx.beginPath();
    ctx.moveTo(b.x - hw, b.y - TH * 0.2);
    ctx.lineTo(b.x, b.y + TH * 0.2);
    ctx.lineTo(b.x, b.y + TH * 0.2 - hh);
    ctx.lineTo(b.x - hw, b.y - TH * 0.2 - hh);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#7a5f42";
    ctx.beginPath();
    ctx.moveTo(b.x + hw, b.y - TH * 0.2);
    ctx.lineTo(b.x, b.y + TH * 0.2);
    ctx.lineTo(b.x, b.y + TH * 0.2 - hh);
    ctx.lineTo(b.x + hw, b.y - TH * 0.2 - hh);
    ctx.closePath(); ctx.fill();

    // roof
    const ry = b.y + TH * 0.2 - hh, rh = 14;
    ctx.fillStyle = "#8f5443";
    ctx.beginPath();
    ctx.moveTo(b.x - hw, ry - TH * 0.4); ctx.lineTo(b.x, ry);
    ctx.lineTo(b.x, ry - rh); ctx.lineTo(b.x - hw, ry - TH * 0.4 - rh * 0.6);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#6d3e33";
    ctx.beginPath();
    ctx.moveTo(b.x + hw, ry - TH * 0.4); ctx.lineTo(b.x, ry);
    ctx.lineTo(b.x, ry - rh); ctx.lineTo(b.x + hw, ry - TH * 0.4 - rh * 0.6);
    ctx.closePath(); ctx.fill();

    // a lit window in most homes at dusk
    if (hm.seed % 4 !== 0) {
      ctx.fillStyle = "#ffcf82";
      ctx.fillRect(b.x - hw * 0.5 - 4, b.y - hh + 12, 8, 9);
    }
  }

  // ---------------------------------------------------------------- scenery
  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, H * 0.62);
    g.addColorStop(0, C.skyTop);
    g.addColorStop(0.4, C.skyMid);
    g.addColorStop(0.75, C.skyLow);
    g.addColorStop(1, C.skyHot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Sun with a soft glow -- smooth, since only people are pixelated.
    const sx = W * 0.74, sy = H * 0.30, r = Math.max(38, W * 0.035);
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 4);
    glow.addColorStop(0, "rgba(255,220,160,0.55)");
    glow.addColorStop(1, "rgba(255,180,110,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(sx - r * 4, sy - r * 4, r * 8, r * 8);
    ctx.fillStyle = "#ffe0a8";
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();

    // Layered hills
    [[C.hillFar, 0.44, 70], [C.hillNear, 0.50, 46]].forEach(([col, yf, amp], li) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 12) {
        const y = H * yf - Math.sin(x * 0.004 + li * 2) * amp - Math.sin(x * 0.011 + li) * amp * 0.4;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    });

    // Clouds
    for (let i = 0; i < 5; i++) {
      const cx = ((t * 0.25 + i * 340) % (W + 300)) - 150;
      const cy = H * 0.10 + i * 26;
      ctx.fillStyle = `rgba(255,205,170,${0.13 + (i % 2) * 0.05})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 90, 12, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 46, cy - 8, 58, 10, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function tilePath(gx, gy) {
    const p = iso(gx, gy);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - TH / 2);
    ctx.lineTo(p.x + TW / 2, p.y);
    ctx.lineTo(p.x, p.y + TH / 2);
    ctx.lineTo(p.x - TW / 2, p.y);
    ctx.closePath();
  }

  function drawGround() {
    for (let gx = -18; gx <= 18; gx++) {
      for (let gy = -18; gy <= 18; gy++) {
        const man = Math.abs(gx) + Math.abs(gy);
        if (man > 20) continue;
        const p = iso(gx, gy);
        if (p.y < -TH || p.y > H + TH || p.x < -TW || p.x > W + TW) continue;

        const n = ((gx * 7 + gy * 13) % 4 + 4) % 4;
        let col;
        if (Math.abs(gx) <= 1 || Math.abs(gy) <= 1) col = C.path;
        else if (man > 16) col = n < 2 ? C.grass : C.grassAlt;
        else col = n === 0 ? C.dirtAlt : n === 1 ? C.dirtEdge : C.dirt;

        tilePath(gx, gy);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.10)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  function drawBuilding(p, idx) {
    const b = iso(p.gx, p.gy);
    const working = p.agent.status === "running";
    const err = p.agent.status === "error";
    const w = p.w, h = p.h;
    const hw = w / 2;

    // Ground shadow, stretched away from the sun
    ctx.fillStyle = "rgba(35,20,15,0.32)";
    ctx.beginPath();
    ctx.ellipse(b.x - 10, b.y + 6, hw * 1.05, TH * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();

    const lit = err ? "#b06a62" : C.wallLit;
    const shade = err ? "#7d4038" : C.wallShade;

    // Left face (sunlit) with a vertical gradient for depth
    const gl = ctx.createLinearGradient(0, b.y - h, 0, b.y);
    gl.addColorStop(0, lit);
    gl.addColorStop(1, shade);
    ctx.fillStyle = gl;
    ctx.beginPath();
    ctx.moveTo(b.x - hw, b.y - TH * 0.25);
    ctx.lineTo(b.x, b.y + TH * 0.25);
    ctx.lineTo(b.x, b.y + TH * 0.25 - h);
    ctx.lineTo(b.x - hw, b.y - TH * 0.25 - h);
    ctx.closePath(); ctx.fill();

    // Right face (shadowed)
    const gr = ctx.createLinearGradient(0, b.y - h, 0, b.y);
    gr.addColorStop(0, shade);
    gr.addColorStop(1, err ? "#5c2e28" : C.wallDark);
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.moveTo(b.x + hw, b.y - TH * 0.25);
    ctx.lineTo(b.x, b.y + TH * 0.25);
    ctx.lineTo(b.x, b.y + TH * 0.25 - h);
    ctx.lineTo(b.x + hw, b.y - TH * 0.25 - h);
    ctx.closePath(); ctx.fill();

    // Roof, two pitched faces
    const roofH = 26;
    const ry = b.y + TH * 0.25 - h;
    ctx.fillStyle = err ? "#8a3a34" : C.roofLit;
    ctx.beginPath();
    ctx.moveTo(b.x - hw, ry - TH * 0.5);
    ctx.lineTo(b.x, ry);
    ctx.lineTo(b.x, ry - roofH);
    ctx.lineTo(b.x - hw, ry - TH * 0.5 - roofH * 0.55);
    ctx.closePath(); ctx.fill();

    ctx.fillStyle = err ? "#6b2b26" : C.roofShade;
    ctx.beginPath();
    ctx.moveTo(b.x + hw, ry - TH * 0.5);
    ctx.lineTo(b.x, ry);
    ctx.lineTo(b.x, ry - roofH);
    ctx.lineTo(b.x + hw, ry - TH * 0.5 - roofH * 0.55);
    ctx.closePath(); ctx.fill();

    // Windows
    const rows = Math.max(1, Math.floor(h / 34));
    for (let r = 0; r < rows; r++) {
      const wy = b.y - h + 26 + r * 34;
      [-1, 1].forEach((side) => {
        const seed = (p.seed + r * 11 + (side + 2) * 5) % 100;
        const on = working ? seed < 82 : seed < 30;
        const flick = working && ((Math.floor(t * 0.09) + seed) % 23 === 0);
        ctx.fillStyle = on ? (flick ? "#fff3cf" : C.windowOn) : C.windowOff;
        ctx.fillRect(b.x + side * (hw * 0.45) - 7, wy, 14, 17);
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 2;
        ctx.strokeRect(b.x + side * (hw * 0.45) - 7, wy, 14, 17);
      });
    }

    // Door
    ctx.fillStyle = working ? "#e0b070" : "#3a2a1e";
    ctx.fillRect(b.x - 9, b.y + TH * 0.25 - 30, 18, 30);

    // Chimney smoke while working
    if (working) {
      for (let i = 0; i < 6; i++) {
        const life = (t * 0.8 + i * 16) % 96;
        const sy2 = ry - roofH - life * 1.1;
        ctx.fillStyle = `rgba(225,205,195,${Math.max(0, 0.32 - life / 320)})`;
        ctx.beginPath();
        ctx.arc(b.x + 14 + Math.sin(life * 0.09) * 7, sy2, 3 + life * 0.05, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Name plate
    ctx.font = "600 13px Rajdhani, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(20,12,10,0.55)";
    const nw = ctx.measureText(p.agent.name).width + 14;
    ctx.fillRect(b.x - nw / 2, b.y + TH * 0.3, nw, 17);
    ctx.fillStyle = idx === hovered ? "#fff3dd" : "rgba(255,240,220,0.85)";
    ctx.fillText(p.agent.name, b.x, b.y + TH * 0.3 + 13);

    if (working) drawProgress(p, b, h, roofH);
  }

  function drawProgress(p, b, h, roofH) {
    const barW = 96, bx = b.x - barW / 2;
    const by = b.y + TH * 0.25 - h - roofH - 34;

    ctx.fillStyle = "rgba(18,10,8,0.82)";
    ctx.fillRect(bx - 2, by - 2, barW + 4, 12);
    ctx.strokeStyle = "rgba(255,200,130,0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 1.5, by - 1.5, barW + 3, 11);

    // Indeterminate sweep, not a percentage -- nothing in the pipeline
    // measures per-agent completion, so a number would be invented.
    const sweep = 34;
    const pos = (t * 2.2 + p.seed * 3) % (barW + sweep);
    const x0 = bx + Math.max(0, pos - sweep);
    const x1 = bx + Math.min(barW, pos);
    if (x1 > x0) {
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, "rgba(255,196,107,0)");
      g.addColorStop(0.5, "#ffc46b");
      g.addColorStop(1, "rgba(255,196,107,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x0, by, x1 - x0, 8);
    }

    const task = p.agent.task || p.agent.title || "working";
    ctx.font = "500 11px Rajdhani, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffe9c8";
    ctx.fillText(String(task).slice(0, 40), b.x, by - 7);

    // Time remaining, when the pipeline gives us enough to estimate one.
    if (p.agent.eta) {
      ctx.font = "600 11px 'Share Tech Mono', monospace";
      ctx.fillStyle = "#ffc46b";
      ctx.fillText(p.agent.eta, b.x, by + 22);
    }
  }

  function hitTest() {
    hovered = -1;
    if (mx < 0 || dragging) {
      if (canvas) canvas.style.cursor = dragging ? "grabbing" : "default";
      return;
    }
    const wpt = screenToWorld(mx, my);
    for (let i = plots.length - 1; i >= 0; i--) {
      const p = plots[i], b = iso(p.gx, p.gy);
      if (wpt.x > b.x - p.w / 2 && wpt.x < b.x + p.w / 2 &&
          wpt.y > b.y - p.h - 40 && wpt.y < b.y + TH * 0.6) { hovered = i; break; }
    }
    if (canvas) canvas.style.cursor = hovered >= 0 ? "pointer" : "grab";
  }

  function drawTooltip() {
    if (hovered < 0) return;
    const p = plots[hovered], b = iso(p.gx, p.gy);
    const lines = [p.agent.name, p.agent.title || "", `Status: ${p.agent.status || "idle"}`];
    if (p.agent.task) lines.push(p.agent.task);
    if (p.agent.eta) lines.push(p.agent.eta);

    ctx.font = "13px Rajdhani, sans-serif";
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
    const hgt = lines.length * 17 + 14;
    let tx = Math.min(Math.max(b.x - w / 2, 8), W - w - 8);
    let ty = b.y - p.h - hgt - 52;
    if (ty < 8) ty = b.y + 34;

    ctx.fillStyle = "rgba(26,15,11,0.95)";
    ctx.beginPath();
    ctx.roundRect(tx, ty, w, hgt, 6);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,196,107,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = "left";
    lines.forEach((l, i) => {
      ctx.font = i === 0 ? "700 14px Rajdhani, sans-serif" : "13px Rajdhani, sans-serif";
      ctx.fillStyle = i === 0 ? "#ffc46b" : "#eadfd2";
      ctx.fillText(l, tx + 10, ty + 19 + i * 17);
    });
  }

  function frame() {
    t += 1;
    // Sky is drawn without the camera transform so it stays put while the
    // world moves underneath -- a sky that pans with the ground looks wrong.
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawSky();
    applyCamera();
    drawGround();
    updateVillagers();
    hitTest();

    // Depth sort buildings and people together so villagers correctly pass
    // in front of and behind houses.
    const items = [
      ...plots.map((p, i) => ({ k: "b", p, i, d: iso(p.gx, p.gy).y })),
      ...homes.map((hm) => ({ k: "h", hm, d: iso(hm.gx, hm.gy).y })),
      ...villagers.map((v) => ({ k: "v", v, d: v.y })),
    ].sort((a, b2) => a.d - b2.d);

    items.forEach((it) => {
      if (it.k === "b") drawBuilding(it.p, it.i);
      else if (it.k === "h") drawHome(it.hm);
      else drawVillagerSprite(it.v);
    });

    drawTooltip();
    raf = requestAnimationFrame(frame);
  }

  function resize() {
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = parent.clientWidth;
    H = parent.clientHeight;
    // Backing store at device resolution keeps everything sharp; the sprite
    // pixelation is done deliberately in code, not by scaling the canvas.
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.imageSmoothingEnabled = true;
    if (plots.length) layout();
  }

  window.VillageView = {
    mount(container) {
      container.innerHTML = `<div class="village-wrap"><canvas id="village-canvas"></canvas></div>`;
      canvas = document.getElementById("village-canvas");
      ctx = canvas.getContext("2d");
      resize();

      canvas.addEventListener("mousemove", (e) => {
        const r = canvas.getBoundingClientRect();
        mx = e.clientX - r.left;
        my = e.clientY - r.top;
        if (dragging && dragStart) {
          cam.tx = dragStart.camX + (mx - dragStart.mx);
          cam.ty = dragStart.camY + (my - dragStart.my);
        }
      });
      canvas.addEventListener("mouseleave", () => { mx = -1; my = -1; dragging = false; });

      canvas.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        dragging = true;
        dragStart = { mx, my, camX: cam.tx, camY: cam.ty, moved: false };
      });
      window.addEventListener("mouseup", () => { dragging = false; });

      canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        // Zoom toward the cursor rather than the screen centre, so you can
        // aim at a building and zoom into it.
        const before = screenToWorld(mx, my);
        cam.tz = Math.max(0.45, Math.min(2.4, cam.tz * (e.deltaY > 0 ? 0.88 : 1.14)));
        const after = screenToWorld(mx, my);
        cam.tx += (after.x - before.x) * cam.tz;
        cam.ty += (after.y - before.y) * cam.tz;
      }, { passive: false });

      canvas.addEventListener("click", () => {
        // A drag shouldn't count as a click on whatever ended up under the
        // cursor when the mouse came up.
        if (dragStart && Math.hypot(mx - dragStart.mx, my - dragStart.my) > 6) return;
        if (hovered >= 0) {
          const p = plots[hovered];
          const b = iso(p.gx, p.gy);
          focusOn(b.x, b.y - p.h / 2, 1.7);   // glide in before opening
          setTimeout(() => { if (window.openAgent) window.openAgent(p.agent.id); }, 380);
        }
      });

      // Double-click empty ground to pull back out to the whole village.
      canvas.addEventListener("dblclick", () => {
        if (hovered < 0) { cam.tx = 0; cam.ty = 0; cam.tz = 1; }
      });

      window.addEventListener("resize", resize);
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

    unmount() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      window.removeEventListener("resize", resize);
      villagers = []; plots = [];
    },
  };
})();
