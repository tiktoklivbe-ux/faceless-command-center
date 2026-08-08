/**
 * village.js — the pixel village view.
 *
 * Each agent is a building. Building size reflects how central that agent is
 * to actually producing a video: the five real pipeline stages get the tall
 * structures, everything else gets a cottage. When an agent is working, a
 * villager walks out of its building and moves around the village, and a
 * progress bar appears above the roof showing what that agent is doing right
 * now.
 *
 * Rendered on a single canvas at a fixed internal resolution and scaled to
 * fit, so the pixel grid stays crisp rather than blurring at arbitrary window
 * sizes. Everything is drawn with rectangles -- no image assets to load, no
 * external dependencies.
 */
(function () {
  // Internal pixel resolution. Deliberately small: drawing at this size and
  // scaling up with smoothing disabled is what produces clean pixel art
  // rather than a blurry mess.
  const VW = 480;
  const VH = 270;

  // Sunset palette, warm to cool from horizon upward.
  const SKY = ["#2b1b47", "#5c2f5e", "#a04a5f", "#d97652", "#f0a45c"];
  const GROUND_NEAR = "#3a2a3f";
  const GROUND_FAR = "#4a3450";
  const ROAD = "#5a4658";

  let canvas, ctx, raf;
  let agents = [];
  let buildings = [];
  let villagers = [];
  let t = 0;
  let hoveredIdx = -1;
  let mouseVX = -1, mouseVY = -1;

  // How important each agent is to producing a video -- drives building size.
  // The five pipeline stages plus ideation genuinely do the work; the rest are
  // scaffolding, and the skyline should be honest about that.
  const TIER = {
    athena: 3, orpheus: 3, iris: 3, hephaestus: 3, hermes: 3,
    apollo: 2, chronos: 2, argus: 2, atlas: 2, daedalus: 2,
  };

  function tierOf(id) {
    return TIER[id] || 1;
  }

  function layout() {
    buildings = [];
    const sorted = [...agents].sort((a, b) => tierOf(b.id) - tierOf(a.id));
    // Two rows: tall buildings along the back, cottages along the front, so
    // nothing important is hidden behind something trivial.
    const back = sorted.filter((a) => tierOf(a.id) >= 2);
    const front = sorted.filter((a) => tierOf(a.id) < 2);

    const place = (list, baseY, rowIndex) => {
      const gap = VW / (list.length + 1);
      list.forEach((a, i) => {
        const tier = tierOf(a.id);
        const w = tier === 3 ? 34 : tier === 2 ? 26 : 20;
        const h = tier === 3 ? 62 : tier === 2 ? 40 : 24;
        const x = Math.round(gap * (i + 1) - w / 2);
        buildings.push({
          agent: a, x, y: baseY - h, w, h, tier, row: rowIndex,
          lit: Math.random() > 0.4,
          windowSeed: Math.floor(Math.random() * 1000),
        });
      });
    };
    place(back, 168, 0);
    place(front, 226, 1);
  }

  function spawnVillager(b) {
    // Walks out of the door and wanders along the street in front of its row.
    const streetY = b.row === 0 ? 176 : 234;
    villagers.push({
      agentId: b.agent.id,
      x: b.x + b.w / 2,
      y: streetY,
      homeX: b.x + b.w / 2,
      dir: Math.random() > 0.5 ? 1 : -1,
      speed: 0.14 + Math.random() * 0.12,
      bob: Math.random() * Math.PI * 2,
      colour: b.agent.color || "#e8ecef",
      life: 0,
    });
  }

  function syncVillagers() {
    const working = new Set(
      agents.filter((a) => a.status === "running").map((a) => a.id)
    );
    // Remove villagers whose agent stopped working -- they head home.
    villagers = villagers.filter((v) => working.has(v.agentId));
    // Add one for each newly-working agent.
    working.forEach((id) => {
      if (!villagers.some((v) => v.agentId === id)) {
        const b = buildings.find((bb) => bb.agent.id === id);
        if (b) spawnVillager(b);
      }
    });
  }

  function drawSky() {
    const bandH = VH / SKY.length;
    SKY.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(0, Math.floor(i * bandH), VW, Math.ceil(bandH) + 1);
    });

    // Sun sinking toward the horizon, drawn as stacked rects to stay pixelly.
    const sunX = 380, sunY = 150, r = 22;
    for (let yy = -r; yy <= r; yy += 2) {
      const half = Math.floor(Math.sqrt(Math.max(r * r - yy * yy, 0)));
      ctx.fillStyle = yy < -4 ? "#ffd9a0" : yy < 6 ? "#ffb877" : "#ff9558";
      ctx.fillRect(sunX - half, sunY + yy, half * 2, 2);
    }

    // A few slow clouds for depth.
    ctx.fillStyle = "rgba(255,200,170,0.25)";
    for (let i = 0; i < 5; i++) {
      const cx = ((t * 0.15 + i * 130) % (VW + 80)) - 40;
      const cy = 30 + i * 17;
      ctx.fillRect(cx, cy, 34, 4);
      ctx.fillRect(cx + 8, cy - 3, 20, 3);
    }
  }

  function drawGround() {
    ctx.fillStyle = GROUND_FAR;
    ctx.fillRect(0, 160, VW, VH - 160);
    ctx.fillStyle = ROAD;
    ctx.fillRect(0, 172, VW, 10);
    ctx.fillStyle = GROUND_NEAR;
    ctx.fillRect(0, 200, VW, VH - 200);
    ctx.fillStyle = ROAD;
    ctx.fillRect(0, 230, VW, 12);
    // Road markings
    ctx.fillStyle = "rgba(255,220,190,0.18)";
    for (let x = 4; x < VW; x += 18) {
      ctx.fillRect(x, 176, 8, 1);
      ctx.fillRect(x + 6, 235, 8, 1);
    }
  }

  function drawBuilding(b, idx) {
    const working = b.agent.status === "running";
    const err = b.agent.status === "error";

    // Silhouette against the sunset -- darker than the sky, lit windows.
    ctx.fillStyle = err ? "#4a2530" : "#241a2e";
    ctx.fillRect(b.x, b.y, b.w, b.h);

    // Roof
    ctx.fillStyle = err ? "#5c2c38" : "#191122";
    ctx.fillRect(b.x - 2, b.y - 3, b.w + 4, 3);

    // Windows. Working buildings light up more of them and flicker slightly,
    // so activity is readable at a glance without reading any text.
    const cols = Math.max(2, Math.floor(b.w / 8));
    const rows = Math.max(1, Math.floor(b.h / 10));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const seed = (b.windowSeed + r * 7 + c * 13) % 100;
        const on = working ? seed < 78 : seed < 30;
        if (!on) continue;
        const flicker = working && ((Math.floor(t * 0.08) + seed) % 17 === 0);
        ctx.fillStyle = err ? "#ff7a7a" : flicker ? "#fff0c0" : working ? "#ffd98a" : "#6a5570";
        ctx.fillRect(b.x + 3 + c * 8, b.y + 6 + r * 10, 3, 4);
      }
    }

    // Door
    ctx.fillStyle = working ? "#ffcf7a" : "#150e1c";
    ctx.fillRect(b.x + Math.floor(b.w / 2) - 2, b.y + b.h - 6, 4, 6);

    // Name plate under the building
    ctx.fillStyle = idx === hoveredIdx ? "#fff4e0" : "rgba(255,235,215,0.6)";
    ctx.font = "6px monospace";
    ctx.textAlign = "center";
    ctx.fillText(b.agent.name.toUpperCase(), b.x + b.w / 2, b.y + b.h + 9);

    if (working) drawProgressBar(b);
  }

  function drawProgressBar(b) {
    const barW = Math.max(b.w, 30);
    const bx = b.x + b.w / 2 - barW / 2;
    const by = b.y - 12;

    // Frame
    ctx.fillStyle = "rgba(10,6,16,0.75)";
    ctx.fillRect(bx - 1, by - 1, barW + 2, 6);
    ctx.strokeStyle = "rgba(255,214,170,0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 0.5, by - 0.5, barW + 1, 5);

    // The pipeline doesn't report a percentage per agent, so this is an
    // indeterminate "working" sweep rather than a fake completion figure --
    // a bar that claimed 60% when nothing measures 60% would be a lie.
    const sweepW = Math.floor(barW * 0.35);
    const pos = (t * 1.2 + b.x * 3) % (barW + sweepW);
    const x0 = bx + Math.max(0, pos - sweepW);
    const x1 = bx + Math.min(barW, pos);
    if (x1 > x0) {
      ctx.fillStyle = "#ffc46b";
      ctx.fillRect(x0, by, x1 - x0, 4);
    }

    // Current task text above the bar
    const task = b.agent.task || b.agent.title || "working";
    ctx.fillStyle = "#ffe7c2";
    ctx.font = "5px monospace";
    ctx.textAlign = "center";
    ctx.fillText(String(task).toUpperCase().slice(0, 26), b.x + b.w / 2, by - 3);
  }

  function drawVillager(v) {
    const bobY = Math.sin(v.bob + t * 0.25) > 0 ? 0 : 1;
    const x = Math.round(v.x), y = Math.round(v.y) + bobY;
    // head
    ctx.fillStyle = "#f2c9a0";
    ctx.fillRect(x, y - 6, 3, 3);
    // body in the agent's colour, so you can tell who's who
    ctx.fillStyle = v.colour;
    ctx.fillRect(x, y - 3, 3, 3);
    // legs, alternating for a walk cycle
    ctx.fillStyle = "#2a1f33";
    const step = Math.floor(t * 0.3 + v.bob) % 2;
    ctx.fillRect(x, y, 1, 2);
    ctx.fillRect(x + 2, y - (step ? 0 : 0), 1, 2 - step);
    // long sunset shadow
    ctx.fillStyle = "rgba(20,10,25,0.35)";
    ctx.fillRect(x - 2, y + 2, 7, 1);
  }

  function updateVillagers() {
    villagers.forEach((v) => {
      v.life++;
      v.x += v.dir * v.speed;
      // Wander within a range of home, then turn around.
      if (v.x > v.homeX + 46 || v.x < v.homeX - 46 || v.x < 4 || v.x > VW - 6) {
        v.dir *= -1;
      }
    });
  }

  function hitTest() {
    hoveredIdx = -1;
    if (mouseVX < 0) return;
    buildings.forEach((b, i) => {
      if (mouseVX >= b.x - 2 && mouseVX <= b.x + b.w + 2 &&
          mouseVY >= b.y - 14 && mouseVY <= b.y + b.h + 10) {
        hoveredIdx = i;
      }
    });
    canvas.style.cursor = hoveredIdx >= 0 ? "pointer" : "default";
  }

  function drawTooltip() {
    if (hoveredIdx < 0) return;
    const b = buildings[hoveredIdx];
    const lines = [
      b.agent.name.toUpperCase(),
      b.agent.title || "",
      `STATUS: ${(b.agent.status || "idle").toUpperCase()}`,
    ];
    if (b.agent.task) lines.push(String(b.agent.task).slice(0, 34));

    ctx.font = "6px monospace";
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 8;
    const h = lines.length * 8 + 6;
    let tx = Math.min(Math.max(b.x + b.w / 2 - w / 2, 2), VW - w - 2);
    let ty = b.y - h - 16;
    if (ty < 2) ty = b.y + b.h + 14;

    ctx.fillStyle = "rgba(12,7,18,0.92)";
    ctx.fillRect(tx, ty, w, h);
    ctx.strokeStyle = "rgba(255,196,107,0.6)";
    ctx.strokeRect(tx + 0.5, ty + 0.5, w - 1, h - 1);

    ctx.textAlign = "left";
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? "#ffc46b" : "#e8dcd0";
      ctx.fillText(l, tx + 4, ty + 10 + i * 8);
    });
  }

  function frame() {
    t += 1;
    ctx.imageSmoothingEnabled = false;
    drawSky();
    drawGround();

    updateVillagers();
    hitTest();

    // Back row first so front buildings overlap correctly.
    buildings.filter((b) => b.row === 0).forEach((b, i) => drawBuilding(b, buildings.indexOf(b)));
    villagers.filter((v) => {
      const b = buildings.find((bb) => bb.agent.id === v.agentId);
      return b && b.row === 0;
    }).forEach(drawVillager);

    buildings.filter((b) => b.row === 1).forEach((b) => drawBuilding(b, buildings.indexOf(b)));
    villagers.filter((v) => {
      const b = buildings.find((bb) => bb.agent.id === v.agentId);
      return b && b.row === 1;
    }).forEach(drawVillager);

    drawTooltip();
    raf = requestAnimationFrame(frame);
  }

  function resize() {
    if (!canvas) return;
    const parent = canvas.parentElement;
    const availW = parent.clientWidth;
    const availH = parent.clientHeight;
    // Integer scaling keeps pixels square; fractional scaling makes pixel art
    // look smeared.
    const scale = Math.max(1, Math.floor(Math.min(availW / VW, availH / VH)));
    canvas.style.width = VW * scale + "px";
    canvas.style.height = VH * scale + "px";
  }

  window.VillageView = {
    mount(container) {
      container.innerHTML = `<div class="village-wrap"><canvas id="village-canvas" width="${VW}" height="${VH}"></canvas></div>`;
      canvas = document.getElementById("village-canvas");
      ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;

      canvas.addEventListener("mousemove", (e) => {
        const r = canvas.getBoundingClientRect();
        mouseVX = ((e.clientX - r.left) / r.width) * VW;
        mouseVY = ((e.clientY - r.top) / r.height) * VH;
      });
      canvas.addEventListener("mouseleave", () => { mouseVX = -1; mouseVY = -1; });
      canvas.addEventListener("click", () => {
        if (hoveredIdx >= 0 && window.openAgent) {
          window.openAgent(buildings[hoveredIdx].agent.id);
        }
      });

      window.addEventListener("resize", resize);
      resize();
      if (!raf) frame();
    },

    update(agentList) {
      const changed = agentList.length !== agents.length;
      agents = agentList;
      if (changed || !buildings.length) layout();
      else {
        // Keep existing buildings, just refresh their agent data so status
        // and task text stay live without relaying out the whole village.
        buildings.forEach((b) => {
          const fresh = agents.find((a) => a.id === b.agent.id);
          if (fresh) b.agent = fresh;
        });
      }
      syncVillagers();
    },

    unmount() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      window.removeEventListener("resize", resize);
      villagers = [];
      buildings = [];
    },
  };
})();
