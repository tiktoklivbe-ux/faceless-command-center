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
  // Tile size is computed on resize to fit the whole village on screen. Fixed
  // sizes meant the outer rings rendered hundreds of pixels below the
  // viewport -- buildings you couldn't see and couldn't click, and villagers
  // that appeared to walk off the map.
  let TW = 96;
  let TH = 48;
  const VILLAGE_RADIUS = 24;   // max |gx| or |gy| used by layout
  const FIT_RADIUS = 15;       // how much of that gets fit into view by default (see fitTiles)
  const RING_ROAD = 11;        // a loop road partway out, besides the centre cross

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

  // agentId -> { seconds, at } -- the ETA text above a working building used
  // to just display whatever the last poll said, verbatim. The API is only
  // polled every 15s, so that number sat frozen the whole time and then
  // jumped once a new segment started -- it never actually counted down.
  // This ticks it down locally every frame using real elapsed time.
  //
  // syncEta() re-anchors to the server's estimate on every poll, full stop --
  // an earlier version tried to be clever and only re-anchor when the fresh
  // value seemed to genuinely diverge from the locally-ticked prediction,
  // to avoid jumping the display around. That backfired: the poll interval
  // (15s) is close to or longer than the per-segment estimate itself
  // (~14s), so almost every real poll DOES look like a new segment must
  // have started, whether or not one actually did -- the "smart" version
  // reset just as often as this one while being harder to reason about.
  // This ticks down smoothly for the 15s between polls and then corrects
  // to the server's fresher number -- an honest, minor correction rather
  // than a bug to hide.
  let etaTrack = {};

  function syncEta(agentId, freshSeconds) {
    if (typeof freshSeconds !== "number") { delete etaTrack[agentId]; return; }
    etaTrack[agentId] = { seconds: freshSeconds, at: performance.now() };
  }

  function tickEtaText(agentId) {
    const tr = etaTrack[agentId];
    if (!tr) return "";
    const remaining = Math.max(0, Math.round(tr.seconds - (performance.now() - tr.at) / 1000));
    if (remaining <= 0) return "finishing";
    return remaining >= 60 ? `~${Math.floor(remaining / 60)}m ${remaining % 60}s left` : `~${remaining}s left`;
  }

  // ---------------------------------------------------------------- YouTube HQ
  // A landmark building, not tied to any one agent, that the pipeline's real
  // stages report to as they finish. Gives the village an actual answer to
  // "where does the work go" rather than agents just working in place.
  let hq = null;
  const PIPELINE_STAGES = ["athena", "orpheus", "iris", "hephaestus", "hermes"];
  let submittedStages = new Set();  // which of PIPELINE_STAGES have delivered this job
  let hqBursts = [];                // brief particle bursts when a delivery lands
  let hqLog = [];                   // recent deliveries, for the control room's screens

  // ---------------------------------------------------------------- traffic
  let cars = [];
  const CAR_COLORS = ["#c94f4f", "#4f7fc9", "#c9a84f", "#6fae6f", "#8a6fc9", "#c9c9c9"];

  function spawnCars() {
    cars = [];
    const count = 16;
    for (let i = 0; i < count; i++) {
      // Two lanes per road, one each direction -- like real opposing traffic,
      // rather than everyone drifting the same way down the middle.
      const lane = (i % 2 === 0) ? 0.3 : -0.3;
      cars.push({
        horizontal: i % 4 < 2,
        pos: -VILLAGE_RADIUS + Math.random() * (VILLAGE_RADIUS * 2),
        lane,
        dir: lane > 0 ? 1 : -1,
        speed: 0.05 + Math.random() * 0.05,
        color: CAR_COLORS[i % CAR_COLORS.length],
      });
    }
  }

  function updateCars() {
    const edge = VILLAGE_RADIUS + 2;
    cars.forEach((c) => {
      c.pos += c.dir * c.speed;
      if (c.pos > edge) c.pos = -edge;
      if (c.pos < -edge) c.pos = edge;
    });
  }

  function drawCar(c) {
    const gx = c.horizontal ? c.pos : c.lane;
    const gy = c.horizontal ? c.lane : c.pos;
    const b = iso(gx, gy);
    const len = TW * 0.5, wid = TH * 0.55;

    ctx.fillStyle = "rgba(15,10,8,0.30)";
    ctx.beginPath();
    ctx.ellipse(b.x, b.y + wid * 0.35, len * 0.55, wid * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(b.x, b.y);
    if (!c.horizontal) ctx.rotate(Math.PI / 2);   // reuse one body shape for both roads
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.roundRect(-len / 2, -wid / 2, len, wid, 3);
    ctx.fill();

    // Windshield band on the leading half, in the direction of travel
    ctx.fillStyle = "rgba(25,30,38,0.65)";
    const wsW = len * 0.32;
    ctx.fillRect(c.dir > 0 ? len * 0.06 : -len * 0.06 - wsW, -wid * 0.32, wsW, wid * 0.64);

    // A single headlight glow at the front
    ctx.fillStyle = "#ffe9b0";
    ctx.beginPath();
    ctx.arc(c.dir > 0 ? len / 2 - 2 : -len / 2 + 2, 0, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Builds HQ's stand-in "agent" record so it can reuse the same click,
   *  camera-fly, and interior-open machinery every other building uses,
   *  rather than a parallel system just for this one landmark. */
  function hqAgent() {
    const inProgress = submittedStages.size > 0 && submittedStages.size < PIPELINE_STAGES.length;
    return {
      id: "ythq",
      name: "HQ",
      title: "Publishing Deck",
      status: inProgress ? "running" : "idle",
      task: submittedStages.size ? `${submittedStages.size}/${PIPELINE_STAGES.length} parts received` : "",
      blurb: "Where every finished part of a video gets handed off before it ships. Each "
             + "agent walks their part over the moment their stage is done.",
      submitted: submittedStages.size,
      total: PIPELINE_STAGES.length,
      log: hqLog.slice(0, 5),
      workflow: {
        works: true,
        runtime: "as each stage finishes",
        steps: [
          "Receives the finished part from whichever agent just completed a stage",
          "Tracks how many of the 5 real stages have reported in for the current job",
          "Lights another floor of the tower per part received",
          "Once script, voice, visuals, assembly, and publish have all reported in, that video is fully assembled",
        ],
      },
    };
  }
  let dim = 0;
  let leaving = false;   // true while the camera is pulling back for a side panel

  // Camera. Pan by dragging, zoom with the wheel. Both are smoothed toward a
  // target rather than applied directly, which is what makes movement feel
  // like a camera gliding rather than the world snapping around.
  const cam = { x: 0, y: 0, z: 1, tx: 0, ty: 0, tz: 1 };
  let dragging = false, dragStart = null;

  // Cubic ease-out: fast at the start, gently settling at the end. Plain
  // linear interpolation (which is what a fixed 0.12 step gives) reads as
  // mechanical -- the motion never accelerates and never truly arrives.
  function easeOutCubic(k) { return 1 - Math.pow(1 - k, 3); }

  // A scripted camera move, used when clicking a building. Free panning still
  // uses the cheap follow below; this is for deliberate transitions.
  let flight = null;

  function flyTo(x, y, z, ms) {
    flight = {
      fromX: cam.tx, fromY: cam.ty, fromZ: cam.tz,
      toX: x, toY: y, toZ: z,
      start: performance.now(), dur: ms || 900,
    };
  }

  function applyCamera() {
    if (flight) {
      const k = Math.min(1, (performance.now() - flight.start) / flight.dur);
      const e = easeOutCubic(k);
      cam.tx = flight.fromX + (flight.toX - flight.fromX) * e;
      cam.ty = flight.fromY + (flight.toY - flight.fromY) * e;
      cam.tz = flight.fromZ + (flight.toZ - flight.fromZ) * e;
      // Snap the live camera to the scripted path so the follow below doesn't
      // add a second layer of lag on top of the animation.
      cam.x = cam.tx; cam.y = cam.ty; cam.z = cam.tz;
      if (k >= 1) flight = null;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.translate(W / 2, H / 2);
      ctx.scale(cam.z, cam.z);
      ctx.translate(-W / 2 + cam.x, -H / 2 + cam.y);
      return;
    }
    // Free movement: a smooth follow, but frame-rate independent so it feels
    // the same on a 60Hz and a 144Hz display.
    const lerp = 1 - Math.pow(0.001, 1 / 60);
    cam.x += (cam.tx - cam.x) * lerp;
    cam.y += (cam.ty - cam.y) * lerp;
    cam.z += (cam.tz - cam.z) * lerp;
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
    path: "#b08d5e",
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
    accent: "#8fe3ff",   // HQ's cool glass-tower accent, matching the interior redesign
  };

  function iso(gx, gy) {
    return {
      x: W / 2 + (gx - gy) * (TW / 2),
      // Centred vertically rather than pinned near the top, so the village
      // sits in the middle of the view with equal room front and back.
      y: H / 2 + (gx + gy) * (TH / 2),
    };
  }

  /** Pick a tile size that fits the whole village in the viewport. */
  function fitTiles() {
    // Deliberately NOT the true VILLAGE_RADIUS. Buildings are a fixed pixel
    // size regardless of tile size, so cramming a much bigger radius (HQ,
    // the ring road, the wider home scatter) into view by default would
    // shrink tiles enough that neighbouring buildings start overlapping
    // each other. Fitting a smaller "core" keeps the agent cluster properly
    // proportioned at the default view; the rest of the settlement is still
    // there and reachable by panning/zooming out, same as any real map.
    const spanX = FIT_RADIUS * 2;
    const spanY = FIT_RADIUS * 2;
    // Leave a margin so buildings (which extend upward) aren't clipped.
    TW = Math.max(28, Math.min(110, (W * 0.92) / spanX));
    TH = TW / 2;
    // If the depth extent would still overflow vertically, shrink further.
    const neededH = spanY * (TH / 2) * 2 + 160;
    if (neededH > H) {
      const k = (H - 160) / (spanY * TH);
      TH = Math.max(14, TH * k);
      TW = TH * 2;
    }
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
    // Someone actually on the job -- heading to their building, or carrying
    // a finished part to HQ -- needed to read as obviously different from
    // the ambient crowd at a glance, not just a color change easy to miss.
    // Bigger, plus a glowing ring underneath, does that even at a glance
    // while zoomed out.
    const active = v.mode === "work" || v.mode === "deliver";
    const scale = active ? PIX * 1.6 : PIX;
    const px = Math.round(v.x / scale) * scale;
    const py = Math.round(v.y / scale) * scale;

    if (active) {
      const pulse = 0.5 + Math.sin(t * 0.12) * 0.5;
      ctx.fillStyle = `rgba(255,196,107,${0.22 + pulse * 0.12})`;
      ctx.beginPath();
      ctx.ellipse(px + scale * 3, py + scale * 8.4, scale * 4.2, scale * 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // soft contact shadow (not pixelated -- it sits on detailed ground)
    ctx.fillStyle = "rgba(30,18,14,0.30)";
    ctx.beginPath();
    ctx.ellipse(px + scale * 3, py + scale * 8, scale * 3.2, scale * 1.1, 0, 0, Math.PI * 2);
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
        ctx.fillRect(px + c * scale, py + r * scale, scale, scale);
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
    // Assembly is the critical-path stage -- the whole render waits on it --
    // so Theo (hephaestus) hustles to his building noticeably faster than
    // everyone else heading to theirs.
    const hustle = !wandering && plot.agent.id === "hephaestus" ? 1.35 : 1;
    villagers.push({
      agentId: plot.agent.id,
      x: p.x, y: p.y,
      tx: plot.gx, ty: plot.gy,
      hair: pick(HAIR, seed), skin: pick(SKIN, seed * 3),
      shirt: wandering ? pick(SHIRT, seed * 7) : (plot.agent.color || pick(SHIRT, seed)),
      pants: pick(PANTS, seed * 5),
      speed: (0.5 + Math.random() * 0.45) * hustle,
      bob: Math.random() * 10,
      wandering,
      mode: wandering ? null : "work",   // "work" (at own building) or "deliver" (walking to HQ)
      nextPick: 0,
      holdUntil: 0,
    });
  }

  /** A pipeline stage just finished -- send its villager to HQ to hand off
   *  that part of the video instead of just despawning it. */
  function sendToHQ(agentId) {
    if (!hq) return;
    const person = agents.find((a) => a.id === agentId);
    hqLog.unshift({ name: (person && person.name) || agentId, at: Date.now() });
    if (hqLog.length > 5) hqLog.length = 5;

    let v = villagers.find((vv) => vv.agentId === agentId && vv.mode === "work");
    if (!v) {
      const p = plots.find((pp) => pp.agent.id === agentId);
      if (!p) return;
      spawnVillager(p, false, agentId.length * 13);
      v = villagers[villagers.length - 1];
    }
    v.mode = "deliver";
    v.wandering = false;
    v.holdUntil = 0;
    // Small spread so several deliveries in flight at once don't stack
    // exactly on top of each other at HQ's door.
    v.tx = hq.gx + (Math.random() * 1.6 - 0.8);
    v.ty = hq.gy + 1.1;
  }

  function syncVillagers() {
    const working = new Set(agents.filter((a) => a.status === "running").map((a) => a.id));
    // A villager mid-delivery to HQ must survive this filter even though its
    // agent has already stopped running -- that's exactly why it's walking.
    villagers = villagers.filter((v) => v.wandering || working.has(v.agentId) || v.mode === "deliver");
    working.forEach((id) => {
      if (!villagers.some((v) => v.agentId === id && v.mode === "work")) {
        const p = plots.find((pp) => pp.agent.id === id);
        if (p) spawnVillager(p, false, id.length * 13);
      }
    });
    const ambientWanted = 110;   // a much bigger settlement needed more life in it
    let ambient = villagers.filter((v) => v.wandering).length;
    for (let i = ambient; i < ambientWanted && plots.length; i++) {
      const anchor = (homes.length && i % 2) ? homes[i % homes.length] : plots[i % plots.length];
      spawnVillager(anchor.agent ? anchor : { gx: anchor.gx, gy: anchor.gy, agent: { id: `home${i}`, color: null } }, true, i * 17 + 3);
    }
  }

  function updateVillagers() {
    villagers.forEach((v) => {
      if (v.mode === "deliver") {
        const target = iso(v.tx, v.ty);
        const dx = target.x - v.x, dy = target.y - v.y;
        const d = Math.hypot(dx, dy);
        if (d < 4) {
          if (!v.holdUntil) {
            v.holdUntil = t + 70;   // a brief pause at the door, "handing it off"
            const hqPos = iso(hq.gx, hq.gy);
            hqBursts.push({ x: hqPos.x, y: hqPos.y, life: 1 });
          }
          if (t > v.holdUntil) {
            // Done delivering -- blends back into the ambient crowd rather
            // than just vanishing.
            v.mode = null; v.wandering = true;
            v.tx = hq.gx + (Math.random() * 6 - 3);
            v.ty = hq.gy + 2 + Math.random() * 3;
          }
        } else {
          v.x += (dx / d) * v.speed;
          v.y += (dy / d) * v.speed;
          v.bob += 0.16;
        }
        return;
      }

      // A working agent's villager heads to and stays at their own building
      // rather than wandering, so it's visible at a glance who's busy.
      if (!v.wandering) {
        const home = plots.find((p) => p.agent.id === v.agentId);
        if (home) { v.tx = home.gx; v.ty = home.gy + 0.6; }
      }
      const target = iso(v.tx, v.ty);
      const dx = target.x - v.x, dy = target.y - v.y;
      const d = Math.hypot(dx, dy);
      if (d < 3) {
        if (t > v.nextPick) {
          // Clamped to the settlement, and to a diamond rather than a square, so
          // nobody wanders out past the edge of the ground tiles.
          let nx = v.tx + (Math.random() * 6 - 3);
          let ny = v.ty + (Math.random() * 6 - 3);
          nx = Math.max(-VILLAGE_RADIUS, Math.min(VILLAGE_RADIUS, nx));
          ny = Math.max(-VILLAGE_RADIUS, Math.min(VILLAGE_RADIUS, ny));
          if (Math.abs(nx) + Math.abs(ny) > VILLAGE_RADIUS + 2) { nx *= 0.6; ny *= 0.6; }
          v.tx = nx; v.ty = ny;
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

    // YouTube HQ: a fixed landmark, not an agent building, sitting prominently
    // at the north edge of the settlement. Every finished pipeline stage
    // walks here to hand off its part.
    hq = { gx: 0, gy: -(VILLAGE_RADIUS - 3), w: 112, h: 172 };

    // Family homes: deterministic scatter so they don't jump around on every
    // relayout, kept clear of the paths, the agent plots, and HQ's tile.
    const taken = new Set(plots.map((p) => `${p.gx},${p.gy}`));
    taken.add(`${hq.gx},${hq.gy}`);
    let n = 0;
    for (let gx = -VILLAGE_RADIUS; gx <= VILLAGE_RADIUS; gx++) {
      for (let gy = -VILLAGE_RADIUS; gy <= VILLAGE_RADIUS; gy++) {
        if (Math.abs(gx) + Math.abs(gy) > VILLAGE_RADIUS + 2) continue;
        if (Math.abs(gx) <= 1 || Math.abs(gy) <= 1) continue;      // keep roads clear
        if (Math.max(Math.abs(gx), Math.abs(gy)) === RING_ROAD) continue;  // keep the ring road clear
        if (taken.has(`${gx},${gy}`)) continue;
        const h = ((gx * 73856093) ^ (gy * 19349663)) >>> 0;
        if (h % 7 !== 0) continue;                                  // ~1 in 7 tiles
        homes.push({ gx, gy, w: 30 + (h % 3) * 5, h: 26 + (h % 4) * 5, seed: h % 100 });
        n++;
      }
    }

    // Only seed traffic once -- relayout runs whenever the agent list
    // changes shape, and respawning cars on every one of those would snap
    // every car back to a random position mid-drive.
    if (!cars.length) spawnCars();
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
    const reach = VILLAGE_RADIUS + 3;
    for (let gx = -reach; gx <= reach; gx++) {
      for (let gy = -reach; gy <= reach; gy++) {
        const man = Math.abs(gx) + Math.abs(gy);
        if (man > VILLAGE_RADIUS + 5) continue;
        const p = iso(gx, gy);
        if (p.y < -TH || p.y > H + TH || p.x < -TW || p.x > W + TW) continue;

        const n = ((gx * 7 + gy * 13) % 4 + 4) % 4;
        let col;
        // The two roads through the centre, plus a ring road partway out --
        // a bigger settlement needed more than one straight cross to not
        // feel like an empty field with houses scattered in it.
        const onRing = Math.max(Math.abs(gx), Math.abs(gy)) === RING_ROAD;
        if (Math.abs(gx) <= 1 || Math.abs(gy) <= 1 || onRing) col = C.path;
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
    // Ticks down live between polls -- see tickEtaText.
    const etaText = tickEtaText(p.agent.id);
    if (etaText) {
      ctx.font = "600 11px 'Share Tech Mono', monospace";
      ctx.fillStyle = "#ffc46b";
      ctx.fillText(etaText, b.x, by + 22);
    }
  }

  // ---------------------------------------------------------------- YT HQ
  function drawHQ() {
    if (!hq) return;
    const b = iso(hq.gx, hq.gy);
    const w = hq.w, hgt = hq.h, hw = w / 2;

    ctx.fillStyle = "rgba(15,10,10,0.38)";
    ctx.beginPath();
    ctx.ellipse(b.x - 12, b.y + 8, hw * 1.08, TH * 0.46, 0, 0, Math.PI * 2);
    ctx.fill();

    // Tower faces -- a cool glass tower, taller and narrower than any agent
    // building, so it reads as a landmark rather than one more house.
    const gl = ctx.createLinearGradient(0, b.y - hgt, 0, b.y);
    gl.addColorStop(0, "#2a3542"); gl.addColorStop(1, "#141a22");
    ctx.fillStyle = gl;
    ctx.beginPath();
    ctx.moveTo(b.x - hw, b.y - TH * 0.25); ctx.lineTo(b.x, b.y + TH * 0.25);
    ctx.lineTo(b.x, b.y + TH * 0.25 - hgt); ctx.lineTo(b.x - hw, b.y - TH * 0.25 - hgt);
    ctx.closePath(); ctx.fill();

    const gr = ctx.createLinearGradient(0, b.y - hgt, 0, b.y);
    gr.addColorStop(0, "#1a222c"); gr.addColorStop(1, "#0b0e12");
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.moveTo(b.x + hw, b.y - TH * 0.25); ctx.lineTo(b.x, b.y + TH * 0.25);
    ctx.lineTo(b.x, b.y + TH * 0.25 - hgt); ctx.lineTo(b.x + hw, b.y - TH * 0.25 - hgt);
    ctx.closePath(); ctx.fill();

    // One glowing floor band per pipeline stage that's actually submitted
    // this job -- the tower itself visibly fills up as parts arrive, not
    // just the progress bar above it.
    const bands = PIPELINE_STAGES.length;
    for (let r = 0; r < bands; r++) {
      const wy = b.y - hgt + 22 + r * ((hgt - 56) / bands);
      const lit = r >= bands - submittedStages.size;
      [-1, 1].forEach((side) => {
        ctx.fillStyle = lit ? "#ff5c5c" : "rgba(143,227,255,0.10)";
        ctx.fillRect(b.x + side * (hw * 0.42) - 8, wy, 16, 11);
      });
    }

    // Antenna + a generic red "upload" badge (a play-triangle in a circle --
    // deliberately generic, not a reproduction of any specific brand mark).
    const roofY = b.y + TH * 0.25 - hgt;
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(b.x, roofY); ctx.lineTo(b.x, roofY - 24); ctx.stroke();
    const badgeY = roofY - 38;
    ctx.fillStyle = "#ff3b3b";
    ctx.beginPath(); ctx.arc(b.x, badgeY, 15, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(b.x - 5, badgeY - 8); ctx.lineTo(b.x - 5, badgeY + 8); ctx.lineTo(b.x + 9, badgeY);
    ctx.closePath(); ctx.fill();

    // Door + nameplate
    ctx.fillStyle = "#c8dbe6";
    ctx.fillRect(b.x - 10, b.y + TH * 0.25 - 32, 20, 32);
    ctx.font = "700 13px Rajdhani, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(10,14,18,0.6)";
    const label = "HQ";
    const nw = ctx.measureText(label).width + 16;
    ctx.fillRect(b.x - nw / 2, b.y + TH * 0.3, nw, 18);
    ctx.fillStyle = "#c8ecff";
    ctx.fillText(label, b.x, b.y + TH * 0.3 + 13.5);

    // Submission bursts -- a brief expanding ring where a delivery just landed.
    for (let i = hqBursts.length - 1; i >= 0; i--) {
      const burst = hqBursts[i];
      burst.life -= 0.03;
      if (burst.life <= 0) { hqBursts.splice(i, 1); continue; }
      ctx.strokeStyle = `rgba(255,92,92,${burst.life * 0.8})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(burst.x, burst.y, (1 - burst.life) * 46, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (submittedStages.size > 0 && submittedStages.size < PIPELINE_STAGES.length) {
      drawHQProgress(b, hgt);
    }
  }

  function drawHQProgress(b, hgt) {
    const barW = 116, bx = b.x - barW / 2;
    const by = b.y + TH * 0.25 - hgt - 60;
    const frac = submittedStages.size / PIPELINE_STAGES.length;

    ctx.fillStyle = "rgba(10,14,18,0.85)";
    ctx.fillRect(bx - 2, by - 2, barW + 4, 12);
    ctx.strokeStyle = "rgba(143,227,255,0.55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 1.5, by - 1.5, barW + 3, 11);

    ctx.fillStyle = C.accent;
    ctx.fillRect(bx, by, barW * frac, 8);

    ctx.font = "600 11px 'Share Tech Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "#cdeeff";
    ctx.fillText(`${submittedStages.size}/${PIPELINE_STAGES.length} parts submitted`, b.x, by - 8);
  }

  function hitTest() {
    hovered = -1;
    // Only bail on a genuinely absent cursor. This used to also bail
    // whenever `dragging` was true -- but `dragging` goes true the instant
    // ANY mousedown fires, including the one at the start of a plain click,
    // before it's known whether it'll turn into a real drag. A click held
    // for even ~100ms (well within normal human click speed) meant several
    // animation frames ticked with `dragging` true, each one wiping
    // `hovered` back to -1 and skipping recalculation -- so by the time
    // mouseup/click fired, hovered was stuck at -1 and the click silently
    // did nothing. Hit-testing now always runs off the live cursor
    // position; only the cursor icon (grabbing vs pointer) reflects drag
    // state. A real drag still can't be mistaken for a click -- that's
    // handled separately, by the distance check in the click handler.
    if (mx < 0) {
      if (canvas) canvas.style.cursor = "default";
      return;
    }
    const wpt = screenToWorld(mx, my);
    for (let i = plots.length - 1; i >= 0; i--) {
      const p = plots[i], b = iso(p.gx, p.gy);
      if (wpt.x > b.x - p.w / 2 && wpt.x < b.x + p.w / 2 &&
          wpt.y > b.y - p.h - 40 && wpt.y < b.y + TH * 0.6) { hovered = i; break; }
    }
    // HQ isn't in `plots` (it's not an agent), so it gets its own check.
    // `hovered` becomes the string "hq" rather than an index -- that still
    // reads correctly everywhere `hovered < 0` is checked (a string against
    // 0 coerces to NaN, which every comparison operator treats as false),
    // so double-click-to-reset still leaves it alone without extra changes.
    if (hovered === -1 && hq) {
      const b = iso(hq.gx, hq.gy);
      if (wpt.x > b.x - hq.w / 2 && wpt.x < b.x + hq.w / 2 &&
          wpt.y > b.y - hq.h - 40 && wpt.y < b.y + TH * 0.6) { hovered = "hq"; }
    }
    const isHovering = hovered !== -1;
    if (canvas) canvas.style.cursor = dragging ? "grabbing" : (isHovering ? "pointer" : "grab");
  }

  function drawTooltip() {
    if (hovered === -1) return;
    // HQ isn't in `plots` (it's the "hq" sentinel, not an index), so it
    // needs its own agent-shaped record and dimensions here.
    const p = hovered === "hq" ? { agent: hqAgent(), h: hq.h, gx: hq.gx, gy: hq.gy } : plots[hovered];
    if (!p) return;
    const b = iso(p.gx, p.gy);
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
    updateCars();
    hitTest();

    // Depth sort buildings and people together so villagers correctly pass
    // in front of and behind houses.
    const items = [
      ...plots.map((p, i) => ({ k: "b", p, i, d: iso(p.gx, p.gy).y })),
      ...homes.map((hm) => ({ k: "h", hm, d: iso(hm.gx, hm.gy).y })),
      ...villagers.map((v) => ({ k: "v", v, d: v.y })),
      ...cars.map((c) => ({ k: "car", c, d: iso(c.horizontal ? c.pos : c.lane, c.horizontal ? c.lane : c.pos).y })),
      ...(hq ? [{ k: "hq", d: iso(hq.gx, hq.gy).y }] : []),
    ].sort((a, b2) => a.d - b2.d);

    items.forEach((it) => {
      if (it.k === "b") drawBuilding(it.p, it.i);
      else if (it.k === "h") drawHome(it.hm);
      else if (it.k === "hq") drawHQ();
      else if (it.k === "car") drawCar(it.c);
      else drawVillagerSprite(it.v);
    });

    // When focused on one house, or pulling back to open a side panel, dim
    // everything so the eye goes to whatever's taking over. Faded in
    // gradually rather than snapped, so it reads as part of the same camera
    // move rather than a hard cut.
    if (focused || leaving) {
      dim = Math.min(0.55, dim + 0.03);
    } else {
      dim = Math.max(0, dim - 0.04);
    }
    if (dim > 0.001) {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.fillStyle = `rgba(12,7,10,${dim})`;
      ctx.fillRect(0, 0, W, H);
      // Re-draw the focused building on top of the dim so it stays bright.
      if (focused) {
        applyCamera();
        if (focused === hq) drawHQ();
        else drawBuilding(focused, plots.indexOf(focused));
      }
    }

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
    fitTiles();
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

  // ---------------------------------------------------------------- house view
  let focused = null;

  /** Glide the camera into a building, then reveal its breakdown panel.
   *  The panel waits for the flight so the two don't compete for attention. */
  function enterHouse(p) {
    focused = p;
    const b = iso(p.gx, p.gy);

    // Fly hard into the building's door until it fills the frame, then hand
    // off to the interior view. Zooming to a modest level and stopping felt
    // like looking AT the house rather than going into it.
    const zoom = 7.5;
    flyTo(
      W / 2 - b.x * zoom,
      H / 2 - (b.y - p.h * 0.35) * zoom,
      zoom,
      760
    );

    setTimeout(() => {
      const host = document.getElementById("interior-host");
      if (!host || !window.InteriorView) { showHousePanel(p); return; }
      host.style.display = "block";
      requestAnimationFrame(() => host.classList.add("open"));
      InteriorView.open(host, p.agent, () => {
        host.classList.remove("open");
        setTimeout(() => { host.style.display = "none"; }, 380);
        focused = null;
        flyTo(0, 0, 1, 800);
      });
      showHousePanel(p, host);
    }, 700);
  }

  /** HQ isn't an agent's building, but it reuses enterHouse's camera-fly and
   *  interior-open flow exactly -- that flow only ever needed gx/gy/h/agent,
   *  all of which HQ already has (agent is synthesized fresh each visit so
   *  its stats are current). */
  function enterHQ() {
    if (!hq) return;
    hq.agent = hqAgent();
    enterHouse(hq);
  }

  function exitHouse() {
    const panel = document.getElementById("house-panel");
    if (panel) panel.classList.remove("open");
    if (window.InteriorView) InteriorView.close();   // also flies the camera back out
    else { focused = null; flyTo(0, 0, 1, 800); }
  }

  function showHousePanel(p, host) {
    const a = p.agent;
    const wf = a.workflow || { works: false, steps: [] };
    let panel = document.getElementById("house-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "house-panel";
      (host || canvas.parentElement).appendChild(panel);
    }

    const stepsHtml = (wf.steps || [])
      .map((st, i) => `<li style="animation-delay:${80 + i * 55}ms">${st}</li>`)
      .join("");

    panel.innerHTML = `
      <button class="house-close" title="Back to the village">✕</button>
      <div class="house-name">${a.name}</div>
      <div class="house-role">${a.title || ""}</div>
      <div class="house-status ${a.status === "running" ? "on" : ""}">
        ${a.status === "running" ? "● Working now" : wf.works ? "○ Idle" : "○ Not functional yet"}
      </div>
      ${a.task ? `<div class="house-task">${a.task}${a.eta ? ` · ${a.eta}` : ""}</div>` : ""}
      ${a.blurb ? `<p class="house-blurb">${a.blurb}</p>` : ""}
      ${wf.runtime ? `<div class="house-runtime">Typically takes ${wf.runtime}</div>` : ""}
      <div class="house-steps-title">${wf.works ? "What it does, step by step" : "Status"}</div>
      <ol class="house-steps">${stepsHtml}</ol>
    `;
    panel.querySelector(".house-close").addEventListener("click", exitHouse);
    // Next frame, so the transition actually animates rather than applying
    // instantly along with the content change.
    requestAnimationFrame(() => panel.classList.add("open"));
  }

  window.VillageView = {
    mount(container) {
      leaving = false;   // always clear -- otherwise a remount after a panel
                          // closes would render permanently dimmed forever.
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
      window.addEventListener("mouseup", () => {
        dragging = false;
        // Record how far this gesture actually moved, then clear it. Leaving
        // stale coordinates here meant a later click was measured against an
        // OLD drag's start point and got swallowed as "that was a drag" --
        // which is why clicking a building sometimes did nothing.
        if (dragStart) {
          dragStart.dist = Math.hypot(mx - dragStart.mx, my - dragStart.my);
        }
      });

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
        const wasDrag = dragStart && (dragStart.dist || 0) > 6;
        dragStart = null;            // consumed -- never reused by a later click
        if (wasDrag) return;
        // Already entering/inside a building -- ignore. Without this, the
        // second click of a double-click (every dblclick fires two click
        // events first) re-triggers enterHouse mid-flight and restarts its
        // animation and timers on top of the one already running.
        if (focused) return;
        if (hovered === "hq") enterHQ();
        else if (hovered >= 0) enterHouse(plots[hovered]);
      });

      // Double-click empty ground to pull back out to the whole village.
      canvas.addEventListener("dblclick", () => {
        // Guard against the camera mid-flight into a building: a double-
        // click's second click can land after the camera has already
        // zoomed in 7x, which shifts what's under an unmoved cursor enough
        // that hitTest reads it as "empty ground" -- and this handler would
        // then snap the camera straight back to the default view, killing
        // the flight that was already 90% of the way to opening the house.
        // 50/50-feeling "it just resets" was exactly this race.
        if (focused) return;
        if (hovered < 0) { cam.tx = 0; cam.ty = 0; cam.tz = 1; }
      });

      window.addEventListener("resize", resize);
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && focused) exitHouse();
      });
      if (!raf) frame();
    },

    update(list) {
      const prevStatus = {};
      agents.forEach((a) => { prevStatus[a.id] = a.status; });

      const changed = list.length !== agents.length;
      agents = list;
      if (changed || !plots.length) layout();
      else plots.forEach((p) => {
        const fresh = agents.find((a) => a.id === p.agent.id);
        if (fresh) p.agent = fresh;
      });

      // A new job always starts with the script agent -- that's the signal
      // to reset HQ's delivery tracking, since there's no other reliable
      // "a fresh job just began" event exposed by the API.
      const athenaNow = agents.find((a) => a.id === "athena");
      if (athenaNow && athenaNow.status === "running" && prevStatus.athena !== "running") {
        submittedStages.clear();
      }

      // Any real pipeline stage finishing (running -> not running) means
      // that part of the video is done -- walk it over to HQ.
      PIPELINE_STAGES.forEach((id) => {
        const fresh = agents.find((a) => a.id === id);
        if (fresh && prevStatus[id] === "running" && fresh.status !== "running") {
          submittedStages.add(id);
          sendToHQ(id);
        }
      });

      // Sync the ETA countdown's anchor point from this poll -- see syncEta.
      agents.forEach((a) => {
        if (a.status === "running") syncEta(a.id, a.eta_seconds);
        else delete etaTrack[a.id];
      });

      syncVillagers();
      // Refresh the open house panel so its status and ETA stay live. HQ
      // isn't a real agent -- agents.find() would never find it -- so it
      // gets its stats rebuilt directly instead of looked up.
      if (focused === hq) {
        focused.agent = hqAgent();
        if (window.InteriorView) InteriorView.setAgent(focused.agent);
        const panel = document.getElementById("house-panel");
        if (panel && panel.classList.contains("open")) {
          showHousePanel(focused, panel.parentElement);
        }
      } else if (focused) {
        const fresh = agents.find((a) => a.id === focused.agent.id);
        if (fresh) {
          focused.agent = fresh;
          if (window.InteriorView) InteriorView.setAgent(fresh);
          const panel = document.getElementById("house-panel");
          if (panel && panel.classList.contains("open")) {
            showHousePanel(focused, panel.parentElement);
          }
        }
      }
    },

    unmount() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      window.removeEventListener("resize", resize);
      villagers = []; plots = [];
    },

    /** Glide the camera back and dim the world, then hand off to a side
     *  panel opening -- called before Mission Control/Videos/Channels/
     *  Settings slides in, so leaving the village reads as a deliberate
     *  camera move rather than an instant cut to a flat page. */
    pullBack(cb) {
      leaving = true;
      flyTo(0, 0, 0.6, 420);
      setTimeout(() => { if (cb) cb(); }, 420);
    },

    /** Called once a panel closes and the village is about to remount, so
     *  the dim clears and the camera glides back in rather than snapping. */
    resetLeave() {
      leaving = false;
    },
  };
})();
