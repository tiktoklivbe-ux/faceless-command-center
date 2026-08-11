/**
 * interior.js — the inside of an agent's building.
 *
 * Clicking a house doesn't just zoom the exterior any more: the view
 * transitions into an actual room, drawn full-screen. Each agent gets an
 * office with a desk, a monitor showing what they're working on, a window
 * looking out at the same dusk sky, a TV, a beanbag, shelves, plants.
 *
 * The room is drawn in the same 3/4 projection as the village so entering
 * doesn't feel like switching to a different game. Details vary per agent so
 * the rooms aren't identical -- the assembly agent's office has render gear,
 * the voice agent's has a mic booth, and so on.
 */
(function () {
  let canvas, ctx, raf;
  let W = 0, H = 0, DPR = 1;
  let agent = null;
  let t = 0;
  let enterProgress = 0;   // 0 = just arrived, 1 = fully settled
  let onExit = null;
  let shadeOpen = true;    // click the window to toggle
  let shadeProgress = 1;   // eased toward shadeOpen ? 1 : 0 each frame

  /** Where the window actually is, shared by drawing and click hit-testing
   *  so they can never drift apart. */
  function windowRect() {
    return { wx: W * 0.72, wy: H * 0.14, ww: W * 0.2, wh: H * 0.30 };
  }

  // A sleek dark/glass palette, matching the cyan-accented command-console
  // look used everywhere else in the app (Mission Control, Settings, the
  // HUD). The room used to be a warm wood-cabin palette that read as a
  // completely different, older-feeling app the moment you stepped inside.
  const C = {
    wallBack: "#141922",
    wallSide: "#0d1118",
    wallTrim: "#2a323d",
    floor: "#10141b",
    floorAlt: "#161b23",
    desk: "#1b212a",
    deskTop: "#242c37",
    deskDark: "#0c0f14",
    screenOn: "#7fd4e8",
    screenOff: "#171d24",
    metal: "#3c4753",
    plant: "#3f6f5c",
    plantDark: "#2b4d40",
    beanbag: "#2c3a4c",
    beanbagAlt: "#233042",
    accent: "#8fe3ff",                  // rim glow / trim / scanlines
    accentDim: "rgba(143,227,255,0.14)",
  };

  function ease(k) { return 1 - Math.pow(1 - k, 3); }

  // ---------------------------------------------------------------- room shell
  function drawRoom() {
    const cx = W / 2;
    const floorY = H * 0.62;

    // Back wall
    const wg = ctx.createLinearGradient(0, 0, 0, floorY);
    wg.addColorStop(0, C.wallSide);
    wg.addColorStop(1, C.wallBack);
    ctx.fillStyle = wg;
    ctx.fillRect(0, 0, W, floorY);

    // Floor, with perspective boards receding toward the back wall
    const fg = ctx.createLinearGradient(0, floorY, 0, H);
    fg.addColorStop(0, C.floorAlt);
    fg.addColorStop(1, C.floor);
    ctx.fillStyle = fg;
    ctx.fillRect(0, floorY, W, H - floorY);

    // Floor grid lines in a faint cool glow rather than plain shadow, so the
    // floor reads as a lit tech surface instead of worn wood boards.
    ctx.strokeStyle = "rgba(143,227,255,0.09)";
    ctx.lineWidth = 1.5;
    for (let i = -8; i <= 8; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * 40, floorY);
      ctx.lineTo(cx + i * 190, H);
      ctx.stroke();
    }
    for (let i = 1; i < 5; i++) {
      const y = floorY + (H - floorY) * (i / 5) * (i / 5);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Skirting board, with a thin glowing seam where wall meets floor --
    // the one recurring "modern console" cue reused throughout the room.
    ctx.fillStyle = C.wallTrim;
    ctx.fillRect(0, floorY - 12, W, 12);
    ctx.fillStyle = C.accent;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(0, floorY - 2, W, 2);
    ctx.globalAlpha = 1;
  }

  function drawWindow() {
    const { wx, wy, ww, wh } = windowRect();

    // Frame -- thin brushed metal instead of a thick wood surround, plus a
    // faint glow edge so it reads as a lit panel rather than a hole in a wall.
    ctx.fillStyle = C.metal;
    ctx.fillRect(wx - 6, wy - 6, ww + 12, wh + 12);
    ctx.strokeStyle = C.accentDim;
    ctx.lineWidth = 1;
    ctx.strokeRect(wx - 7, wy - 7, ww + 14, wh + 14);

    // The same dusk sky as outside, so the interior feels part of the world.
    const sky = ctx.createLinearGradient(0, wy, 0, wy + wh);
    sky.addColorStop(0, "#3a2650");
    sky.addColorStop(0.5, "#b5573f");
    sky.addColorStop(1, "#f0a353");
    ctx.fillStyle = sky;
    ctx.fillRect(wx, wy, ww, wh);

    // Sun and rooftops of the village beyond
    ctx.fillStyle = "#ffe0a8";
    ctx.beginPath(); ctx.arc(wx + ww * 0.68, wy + wh * 0.55, ww * 0.09, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(50,30,45,0.75)";
    for (let i = 0; i < 5; i++) {
      const bx = wx + i * (ww / 5) + 4;
      const bh = wh * (0.18 + ((i * 37) % 5) / 22);
      ctx.fillRect(bx, wy + wh - bh, ww / 6, bh);
    }

    // Mullions
    ctx.strokeStyle = C.metal;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(wx + ww / 2, wy); ctx.lineTo(wx + ww / 2, wy + wh);
    ctx.moveTo(wx, wy + wh / 2); ctx.lineTo(wx + ww, wy + wh / 2);
    ctx.stroke();

    // Light spilling onto the floor -- fades out as the shade closes, since
    // a covered window shouldn't still be throwing sunset light across the
    // room.
    if (shadeProgress > 0.02) {
      const spill = ctx.createLinearGradient(wx, wy + wh, wx - 60, H * 0.85);
      spill.addColorStop(0, `rgba(255,190,120,${0.16 * shadeProgress})`);
      spill.addColorStop(1, "rgba(255,190,120,0)");
      ctx.fillStyle = spill;
      ctx.beginPath();
      ctx.moveTo(wx - 20, H * 0.62);
      ctx.lineTo(wx + ww + 20, H * 0.62);
      ctx.lineTo(wx + ww + 90, H);
      ctx.lineTo(wx - 130, H);
      ctx.closePath(); ctx.fill();
    }
  }

  /** A shade that slides down over the window on click. Purely cosmetic --
   *  it doesn't affect anything else -- but it's the one prop in the room
   *  you can actually touch, which is worth having on its own. */
  function drawShade() {
    shadeProgress += ((shadeOpen ? 1 : 0) - shadeProgress) * 0.12;
    if (shadeProgress > 0.985) return;   // fully open -- nothing to draw

    const { wx, wy, ww, wh } = windowRect();
    const drop = wh * (1 - shadeProgress);

    ctx.save();
    ctx.beginPath(); ctx.rect(wx, wy, ww, wh); ctx.clip();

    const g = ctx.createLinearGradient(0, wy, 0, wy + drop);
    g.addColorStop(0, "#2f363f");
    g.addColorStop(1, "#232a31");
    ctx.fillStyle = g;
    ctx.fillRect(wx, wy, ww, drop);

    // Ribbed slats, so it reads as a rolled shade rather than a flat panel
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 1;
    for (let y = wy + 6; y < wy + drop; y += 7) {
      ctx.beginPath(); ctx.moveTo(wx, y); ctx.lineTo(wx + ww, y); ctx.stroke();
    }
    // Pull cord + tab at the shade's leading edge
    ctx.fillStyle = "#12161b";
    ctx.fillRect(wx + ww / 2 - 5, wy + drop - 3, 10, 5);

    ctx.restore();
  }

  function drawDesk() {
    const dx = W * 0.30, dy = H * 0.60, dw = W * 0.30, dh = 18;

    // Desktop surface, angled
    ctx.fillStyle = C.deskTop;
    ctx.beginPath();
    ctx.moveTo(dx, dy);
    ctx.lineTo(dx + dw, dy);
    ctx.lineTo(dx + dw + 34, dy + 26);
    ctx.lineTo(dx - 34, dy + 26);
    ctx.closePath(); ctx.fill();

    // Front edge
    ctx.fillStyle = C.desk;
    ctx.fillRect(dx - 34, dy + 26, dw + 68, dh);
    ctx.fillStyle = C.deskDark;
    ctx.fillRect(dx - 34, dy + 26 + dh, dw + 68, 5);

    // Legs
    ctx.fillStyle = C.deskDark;
    ctx.fillRect(dx - 26, dy + 44, 12, H * 0.16);
    ctx.fillRect(dx + dw + 16, dy + 44, 12, H * 0.16);

    // Monitor showing what the agent is doing right now
    const mw = W * 0.15, mh = H * 0.16;
    const mx2 = dx + dw / 2 - mw / 2, my2 = dy - mh - 6;
    ctx.fillStyle = "#1a1d22";
    ctx.fillRect(mx2 - 6, my2 - 6, mw + 12, mh + 12);

    const working = agent && agent.status === "running";
    ctx.fillStyle = working ? C.screenOn : C.screenOff;
    ctx.fillRect(mx2, my2, mw, mh);
    if (working) {
      ctx.strokeStyle = C.accentDim;
      ctx.lineWidth = 2;
      ctx.strokeRect(mx2 - 6, my2 - 6, mw + 12, mh + 12);
    }

    if (working) {
      // Scrolling "work" lines on the screen
      ctx.save();
      ctx.beginPath(); ctx.rect(mx2, my2, mw, mh); ctx.clip();
      for (let i = 0; i < 9; i++) {
        const ly = my2 + 10 + ((i * 15 + t * 0.5) % (mh - 6));
        ctx.fillStyle = "rgba(10,40,50,0.55)";
        ctx.fillRect(mx2 + 8, ly, mw * (0.3 + ((i * 17) % 6) / 10), 4);
      }
      ctx.restore();

      // Live task text under the monitor
      if (agent.task) {
        ctx.font = "500 13px Rajdhani, sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = C.accent;
        ctx.fillText(String(agent.task).slice(0, 46), dx + dw / 2, my2 + mh + 26);
      }
    } else {
      ctx.font = "500 12px 'Share Tech Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = "#5f6f78";
      ctx.fillText("IDLE", mx2 + mw / 2, my2 + mh / 2 + 4);
    }

    // Monitor stand
    ctx.fillStyle = "#2b2b30";
    ctx.fillRect(dx + dw / 2 - 8, my2 + mh + 6, 16, 10);
    ctx.fillRect(dx + dw / 2 - 26, my2 + mh + 16, 52, 5);

    // Keyboard and mug
    ctx.fillStyle = "#3a3a42";
    ctx.fillRect(dx + dw / 2 - 46, dy + 6, 92, 12);
    ctx.fillStyle = "#c9705a";
    ctx.fillRect(dx + dw - 24, dy + 2, 16, 18);
    ctx.fillRect(dx + dw - 10, dy + 6, 6, 8);
    // steam, only when working
    if (working) {
      for (let i = 0; i < 3; i++) {
        const life = (t * 0.8 + i * 20) % 60;
        ctx.fillStyle = `rgba(230,220,215,${0.25 - life / 260})`;
        ctx.fillRect(dx + dw - 20 + Math.sin(life * 0.15) * 4, dy - life * 0.5, 3, 3);
      }
    }
  }

  /** HQ's room: a wall of screens on a long console instead of one agent's
   *  desk -- it's a landmark everyone reports to, not a single person's
   *  office, so it needed to actually look different rather than just
   *  reusing the standard desk with a re-skinned label. */
  function drawHQConsole() {
    if (!agent) return;
    const baseY = H * 0.60;
    const screenW = W * 0.15, screenH = H * 0.19;
    const gap = W * 0.03;
    const startX = W * 0.10, screenY = H * 0.14;
    const totalW = screenW * 3 + gap * 2;

    // Long console desk beneath the screens
    const dx = startX - 20, dw = totalW + 40, dy = baseY;
    ctx.fillStyle = C.deskTop;
    ctx.beginPath();
    ctx.moveTo(dx, dy); ctx.lineTo(dx + dw, dy);
    ctx.lineTo(dx + dw + 30, dy + 24); ctx.lineTo(dx - 30, dy + 24);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = C.desk;
    ctx.fillRect(dx - 30, dy + 24, dw + 60, 16);
    ctx.fillStyle = C.deskDark;
    ctx.fillRect(dx - 30, dy + 40, dw + 60, 5);
    ctx.fillRect(dx - 22, dy + 44, 12, H * 0.14);
    ctx.fillRect(dx + dw + 6, dy + 44, 12, H * 0.14);

    const submitted = agent.submitted || 0;
    const total = agent.total || 5;

    for (let i = 0; i < 3; i++) {
      const sx = startX + i * (screenW + gap);
      ctx.fillStyle = "#1a1d22";
      ctx.fillRect(sx - 6, screenY - 6, screenW + 12, screenH + 12);
      ctx.fillStyle = C.screenOn;
      ctx.fillRect(sx, screenY, screenW, screenH);
      ctx.strokeStyle = C.accentDim;
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - 6, screenY - 6, screenW + 12, screenH + 12);

      ctx.save();
      ctx.beginPath(); ctx.rect(sx, screenY, screenW, screenH); ctx.clip();

      if (i === 0) {
        // Big honest counter -- X of 5 real stages, not an invented percent.
        ctx.textAlign = "center";
        ctx.font = "700 42px 'Share Tech Mono', monospace";
        ctx.fillStyle = "#0a1216";
        ctx.fillText(`${submitted}/${total}`, sx + screenW / 2, screenY + screenH * 0.52);
        ctx.font = "600 11px Rajdhani, sans-serif";
        ctx.fillText("PARTS RECEIVED", sx + screenW / 2, screenY + screenH * 0.74);
      } else if (i === 1) {
        // Real delivery log, not decoration -- whichever agents actually
        // reported in, most recent first.
        ctx.textAlign = "left";
        ctx.font = "600 10px 'Share Tech Mono', monospace";
        ctx.fillStyle = "#0a1216";
        ctx.fillText("RECENT SUBMISSIONS", sx + 8, screenY + 16);
        const log = agent.log || [];
        if (log.length === 0) {
          ctx.font = "500 11px Rajdhani, sans-serif";
          ctx.fillText("-- waiting for the first part --", sx + 8, screenY + 38);
        } else {
          log.forEach((entry, li) => {
            const secsAgo = Math.max(0, Math.round((Date.now() - entry.at) / 1000));
            const when = secsAgo < 60 ? `${secsAgo}s ago` : `${Math.round(secsAgo / 60)}m ago`;
            ctx.font = "500 11px Rajdhani, sans-serif";
            ctx.fillText(`${entry.name} — ${when}`, sx + 8, screenY + 38 + li * 16);
          });
        }
      } else {
        // Decorative signal bars -- the one purely ambient screen, so the
        // wall doesn't read as two readouts and one blank panel.
        ctx.fillStyle = "#0a1216";
        for (let bar = 0; bar < 14; bar++) {
          const bh = 6 + Math.abs(Math.sin(t * 0.05 + bar * 0.7)) * (screenH - 20);
          ctx.fillRect(sx + 6 + bar * (screenW - 12) / 14, screenY + screenH - bh - 6, (screenW - 12) / 14 - 2, bh);
        }
      }
      ctx.restore();
    }
    ctx.textAlign = "left";
  }

  /** For an agent that's honestly scaffolding -- no real logic behind it
   *  yet (see agents_registry.AGENT_STEPS). The room reflects that instead
   *  of pretending: bare, unfinished, no monitor content, no cozy touches.
   *  Consistent with the app's existing rule of never inventing a workflow
   *  for something that doesn't actually run. */
  function drawScaffoldRoom() {
    const dx = W * 0.32, dy = H * 0.60, dw = W * 0.24;
    ctx.fillStyle = C.desk;
    ctx.beginPath();
    ctx.moveTo(dx, dy); ctx.lineTo(dx + dw, dy);
    ctx.lineTo(dx + dw + 24, dy + 20); ctx.lineTo(dx - 24, dy + 20);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = C.deskDark;
    ctx.fillRect(dx - 24, dy + 20, dw + 48, 12);
    ctx.fillRect(dx - 18, dy + 32, 10, H * 0.14);
    ctx.fillRect(dx + dw + 8, dy + 32, 10, H * 0.14);

    // A dark, unpowered monitor -- there's no work to show
    const mw = W * 0.13, mh = H * 0.13;
    const mx2 = dx + dw / 2 - mw / 2, my2 = dy - mh - 4;
    ctx.fillStyle = "#15181c";
    ctx.fillRect(mx2 - 5, my2 - 5, mw + 10, mh + 10);
    ctx.fillStyle = "#0a0c0e";
    ctx.fillRect(mx2, my2, mw, mh);

    // A dust sheet over a stack of unused equipment in the corner
    const sx = W * 0.68, sy = H * 0.56;
    ctx.fillStyle = "rgba(60,68,78,0.5)";
    ctx.beginPath();
    ctx.moveTo(sx - 44, sy + 10); ctx.lineTo(sx - 10, sy - 50);
    ctx.lineTo(sx + 40, sy - 40); ctx.lineTo(sx + 46, sy + 14);
    ctx.closePath(); ctx.fill();

    // Hand-lettered sign, propped against the desk -- honest, not an error
    ctx.save();
    ctx.translate(dx + dw / 2, dy + 40);
    ctx.rotate(-0.05);
    ctx.fillStyle = "#caa46a";
    ctx.fillRect(-58, -16, 116, 32);
    ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 2;
    ctx.strokeRect(-58, -16, 116, 32);
    ctx.fillStyle = "#2a1f14";
    ctx.font = "700 12px Rajdhani, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("NOT WIRED UP YET", 0, 5);
    ctx.restore();
  }

  /** Orpheus's sound booth -- acoustic foam instead of a TV/shelf, and the
   *  mic is the centrepiece rather than a small desk prop. */
  function drawSoundBooth() {
    // Foam panel wall, in a grid, standing in for the usual TV/shelf
    const fx = W * 0.08, fy = H * 0.15, fw = W * 0.30, fh = H * 0.34;
    const cols = 4, rows = 3, pw = fw / cols, ph = fh / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const shade = (r + c) % 2 === 0 ? "#232a33" : "#1c222a";
        ctx.fillStyle = shade;
        ctx.beginPath();
        ctx.moveTo(fx + c * pw + 3, fy + r * ph + 3);
        ctx.lineTo(fx + (c + 1) * pw - 3, fy + r * ph + pw * 0.15);
        ctx.lineTo(fx + (c + 1) * pw - 3, fy + (r + 1) * ph - 3);
        ctx.lineTo(fx + c * pw + 3, fy + (r + 1) * ph - pw * 0.15);
        ctx.closePath(); ctx.fill();
      }
    }

    // Big mic on a boom, centre stage
    const px = W * 0.52, py = H * 0.62;
    ctx.strokeStyle = C.metal; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(px, py + 50); ctx.lineTo(px, py - 40); ctx.lineTo(px + 58, py - 60); ctx.stroke();
    ctx.fillStyle = "#3a3a42";
    ctx.beginPath(); ctx.ellipse(px + 66, py - 62, 15, 22, 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(200,210,220,0.5)"; ctx.lineWidth = 1;
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(px + 66 + Math.cos(0.3) * i * 3 - 10, py - 62 + Math.sin(0.3) * i * 3 - 15);
      ctx.lineTo(px + 66 + Math.cos(0.3) * i * 3 + 10, py - 62 + Math.sin(0.3) * i * 3 + 15);
      ctx.stroke();
    }

    // A small waveform readout, only when actually narrating
    const working = agent && agent.status === "running";
    const wfx = W * 0.44, wfy = H * 0.80, wfw = W * 0.16;
    ctx.fillStyle = "#12161b";
    ctx.fillRect(wfx - 8, wfy - 22, wfw + 16, 40);
    ctx.strokeStyle = working ? C.accent : "#3a4451";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const x = wfx + (i / 40) * wfw;
      const amp = working ? Math.sin(t * 0.3 + i * 0.6) * (8 + Math.sin(i) * 6) : Math.sin(i * 0.9) * 2;
      const y = wfy + amp;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /** Hephaestus's render farm -- a wall of rack towers instead of a desk,
   *  since assembly is compute work, not a person sitting at a monitor. */
  function drawRenderRack() {
    const rx = W * 0.16, ry = H * 0.16, rw = W * 0.5, rh = H * 0.42;
    const towers = 5, tw = rw / towers;
    for (let i = 0; i < towers; i++) {
      const tx = rx + i * tw;
      ctx.fillStyle = "#20242b";
      ctx.fillRect(tx + 4, ry, tw - 8, rh);
      const rows = 8;
      for (let r = 0; r < rows; r++) {
        const phase = Math.floor(t * 0.1) + i * 3 + r;
        const on = phase % 4 !== 0;
        ctx.fillStyle = on ? "#7fd4a0" : "#2a3a34";
        ctx.fillRect(tx + 10, ry + 8 + r * (rh - 16) / rows, tw - 20, 6);
      }
    }
    const working = agent && agent.status === "running";
    if (working) {
      ctx.font = "600 12px 'Share Tech Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = C.accent;
      ctx.fillText("RENDERING…", rx + rw / 2, ry + rh + 24);
    }
  }

  /** Iris's studio -- a big centred easel instead of a desk, since the work
   *  is a generated image, not typing at a monitor. */
  function drawArtStudio() {
    const px = W * 0.42, py = H * 0.66;
    ctx.strokeStyle = C.metal; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(px - 44, py + 70); ctx.lineTo(px, py - 66); ctx.lineTo(px + 44, py + 70); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px - 30, py + 20); ctx.lineTo(px + 30, py + 20); ctx.stroke();

    const canvasW = 116, canvasH = 92;
    ctx.fillStyle = "#dfe5ea";
    ctx.fillRect(px - canvasW / 2, py - 78, canvasW, canvasH);
    ctx.strokeStyle = C.accentDim; ctx.lineWidth = 2;
    ctx.strokeRect(px - canvasW / 2, py - 78, canvasW, canvasH);

    // A generic generated-scene sketch -- sky, a horizon, a shape --
    // suggesting "an image", not a specific piece of art.
    const working = agent && agent.status === "running";
    ctx.fillStyle = working ? "#5c8ac9" : "#aeb8c0";
    ctx.fillRect(px - canvasW / 2 + 6, py - 72, canvasW - 12, canvasH * 0.5);
    ctx.fillStyle = working ? "#c96a4e" : "#c3ccd2";
    ctx.fillRect(px - canvasW / 2 + 6, py - 72 + canvasH * 0.5, canvasW - 12, canvasH * 0.5 - 6);
    ctx.fillStyle = working ? "#ffe0a8" : "#9aa4ac";
    ctx.beginPath(); ctx.arc(px + canvasW / 2 - 26, py - 60, 10, 0, Math.PI * 2); ctx.fill();

    // Paint palette resting on the tray
    ctx.fillStyle = "#c9a06d";
    ctx.beginPath(); ctx.ellipse(px + 46, py + 30, 20, 12, -0.2, 0, Math.PI * 2); ctx.fill();
    ["#c94f4f", "#4f7fc9", "#c9a84f", "#6fae6f"].forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(px + 38 + i * 6, py + 25 + (i % 2) * 6, 3, 0, Math.PI * 2); ctx.fill();
    });
  }

  function drawBeanbag() {
    const bx = W * 0.16, by = H * 0.80;
    ctx.fillStyle = "rgba(20,12,10,0.3)";
    ctx.beginPath(); ctx.ellipse(bx, by + 32, 78, 14, 0, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = C.beanbag;
    ctx.beginPath();
    ctx.ellipse(bx, by, 72, 46, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.beanbagAlt;
    ctx.beginPath();
    ctx.ellipse(bx - 12, by - 14, 46, 26, -0.25, 0, Math.PI * 2);
    ctx.fill();
    // seam highlight
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(bx, by, 72, 46, 0, Math.PI * 0.9, Math.PI * 1.9); ctx.stroke();
  }

  function drawTV() {
    const tx = W * 0.10, ty = H * 0.30, tw = W * 0.15, th = H * 0.19;
    // wall mount
    ctx.fillStyle = "#2a2a2e";
    ctx.fillRect(tx - 8, ty - 8, tw + 16, th + 16);
    // screen with a slow colour drift so it reads as "on" -- kept to a cool
    // cyan/blue/violet range rather than cycling the full rainbow, so it
    // reads as a deliberate ambient display rather than a random hue wheel.
    const hue = 205 + Math.sin(t * 0.01) * 45;
    const g = ctx.createLinearGradient(tx, ty, tx + tw, ty + th);
    g.addColorStop(0, `hsl(${hue}, 40%, 26%)`);
    g.addColorStop(1, `hsl(${(hue + 60) % 360}, 45%, 18%)`);
    ctx.fillStyle = g;
    ctx.fillRect(tx, ty, tw, th);
    // scanline sheen
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    for (let y = ty; y < ty + th; y += 4) ctx.fillRect(tx, y, tw, 1);
    // glow on the wall
    const glow = ctx.createRadialGradient(tx + tw / 2, ty + th / 2, 10, tx + tw / 2, ty + th / 2, tw);
    glow.addColorStop(0, `hsla(${hue}, 50%, 40%, 0.18)`);
    glow.addColorStop(1, "transparent");
    ctx.fillStyle = glow;
    ctx.fillRect(tx - tw, ty - th, tw * 3, th * 3);
  }

  function drawShelf() {
    const sx = W * 0.44, sy = H * 0.22, sw = W * 0.16;
    ctx.fillStyle = C.desk;
    ctx.fillRect(sx, sy, sw, 9);
    ctx.fillRect(sx, sy + 62, sw, 9);
    // books / boxes -- a cool graphite/slate set instead of warm wood tones
    const cols = ["#3a4451", "#4a5c72", "#2f3944", "#586f85", "#374252"];
    for (let i = 0; i < 7; i++) {
      const bw = 12 + (i % 3) * 4, bh = 34 + (i % 4) * 8;
      ctx.fillStyle = cols[i % cols.length];
      ctx.fillRect(sx + 8 + i * 20, sy - bh + 9, bw, bh);
    }
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = cols[(i + 2) % cols.length];
      ctx.fillRect(sx + 14 + i * 26, sy + 62 - 30, 18, 30);
    }
  }

  function drawPlant() {
    const px = W * 0.87, py = H * 0.78;
    ctx.fillStyle = "rgba(20,12,10,0.28)";
    ctx.beginPath(); ctx.ellipse(px, py + 30, 34, 10, 0, 0, Math.PI * 2); ctx.fill();
    // pot -- matte graphite instead of warm terracotta
    ctx.fillStyle = "#333d47";
    ctx.beginPath();
    ctx.moveTo(px - 26, py); ctx.lineTo(px + 26, py);
    ctx.lineTo(px + 19, py + 32); ctx.lineTo(px - 19, py + 32);
    ctx.closePath(); ctx.fill();
    // fronds, swaying gently
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI / 2 + (i - 3) * 0.36 + Math.sin(t * 0.02 + i) * 0.04;
      const len = 54 + (i % 3) * 16;
      ctx.strokeStyle = i % 2 ? C.plant : C.plantDark;
      ctx.lineWidth = 7;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + Math.cos(a) * len * 0.6, py + Math.sin(a) * len * 0.9,
                           px + Math.cos(a) * len, py + Math.sin(a) * len * 0.7);
      ctx.stroke();
    }
  }

  /** A prop unique to each agent, so rooms aren't interchangeable. */
  function drawSignatureProp() {
    if (!agent) return;
    const id = agent.id;
    const px = W * 0.62, py = H * 0.70;

    if (id === "orpheus") {
      // mic on a boom arm
      ctx.strokeStyle = C.metal; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(px, py + 40); ctx.lineTo(px, py - 30); ctx.lineTo(px + 46, py - 46); ctx.stroke();
      ctx.fillStyle = "#3a3a42";
      ctx.beginPath(); ctx.ellipse(px + 52, py - 48, 11, 17, 0.3, 0, Math.PI * 2); ctx.fill();
    } else if (id === "iris") {
      // easel with a canvas
      ctx.strokeStyle = C.desk; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(px - 26, py + 50); ctx.lineTo(px, py - 44); ctx.lineTo(px + 26, py + 50); ctx.stroke();
      ctx.fillStyle = "#d9cbb8"; ctx.fillRect(px - 32, py - 40, 64, 52);
      ctx.fillStyle = "#c96a4e"; ctx.fillRect(px - 24, py - 20, 48, 24);
      ctx.fillStyle = "#5c8ac9"; ctx.fillRect(px - 24, py - 34, 48, 14);
    } else if (id === "hephaestus") {
      // render tower with blinking lights
      ctx.fillStyle = "#2e2e34"; ctx.fillRect(px - 24, py - 70, 48, 118);
      for (let i = 0; i < 7; i++) {
        const on = (Math.floor(t * 0.12) + i) % 3 !== 0;
        ctx.fillStyle = on ? "#7fd4a0" : "#33403a";
        ctx.fillRect(px - 14, py - 58 + i * 15, 28, 6);
      }
    } else if (id === "athena") {
      // stack of scripts
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = i % 2 ? "#dfe5ea" : "#c7d0d8";
        ctx.fillRect(px - 30 + i * 2, py + 30 - i * 9, 62, 9);
      }
    } else if (id === "hermes") {
      // outbox with a paper plane
      ctx.fillStyle = C.metal; ctx.fillRect(px - 34, py + 16, 68, 26);
      ctx.fillStyle = "#dde3e8";
      ctx.beginPath();
      const fy = py - 20 + Math.sin(t * 0.05) * 8;
      ctx.moveTo(px - 18, fy); ctx.lineTo(px + 26, fy - 10); ctx.lineTo(px - 6, fy + 14);
      ctx.closePath(); ctx.fill();
    } else {
      // filing cabinet as a generic office prop
      ctx.fillStyle = C.metal; ctx.fillRect(px - 28, py - 30, 56, 78);
      ctx.fillStyle = "#4a5561";
      for (let i = 0; i < 3; i++) ctx.fillRect(px - 22, py - 22 + i * 25, 44, 18);
    }
  }

  function drawNameplate() {
    if (!agent) return;
    ctx.font = "700 34px Rajdhani, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = C.accent;
    ctx.shadowColor = C.accent;
    ctx.shadowBlur = 14;
    ctx.fillText(agent.name, 44, 58);
    ctx.shadowBlur = 0;
    ctx.font = "400 15px Rajdhani, sans-serif";
    ctx.fillStyle = "rgba(210,224,235,0.8)";
    ctx.fillText(agent.title || "", 44, 80);
  }

  function frame() {
    t += 1;
    enterProgress = Math.min(1, enterProgress + 0.035);

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Entrance: the room scales down slightly into place, which reads as
    // stepping through a doorway rather than a hard cut.
    const e = ease(enterProgress);
    const scale = 1.14 - 0.14 * e;
    ctx.translate(W / 2, H / 2);
    ctx.scale(scale, scale);
    ctx.translate(-W / 2, -H / 2);
    ctx.globalAlpha = e;

    const isHQ = agent && agent.id === "ythq";
    const works = !!(agent && agent.workflow && agent.workflow.works);

    drawRoom();
    drawWindow();
    drawShade();

    if (isHQ) {
      drawHQConsole();
    } else if (!works) {
      // Honest about what's actually running: an agent with no real logic
      // behind it (see agents_registry.AGENT_STEPS) gets a room that looks
      // unfinished instead of a cozy office implying it does something.
      drawScaffoldRoom();
    } else if (agent.id === "orpheus") {
      drawSoundBooth();
    } else if (agent.id === "iris") {
      drawArtStudio();
    } else if (agent.id === "hephaestus") {
      drawRenderRack();
    } else {
      drawTV();
      drawShelf();
      drawSignatureProp();
      drawDesk();
    }

    // Scaffolding rooms skip the cozy touches too -- consistent with them
    // being genuinely bare, not just re-labelled.
    if (isHQ || works) {
      drawBeanbag();
      drawPlant();
    }
    drawNameplate();

    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }

  function resize() {
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = parent.clientWidth; H = parent.clientHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
  }

  function handleClick(e) {
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const { wx, wy, ww, wh } = windowRect();
    if (cx >= wx - 8 && cx <= wx + ww + 8 && cy >= wy - 8 && cy <= wy + wh + 8) {
      shadeOpen = !shadeOpen;
    }
  }

  window.InteriorView = {
    open(container, agentData, exitCallback) {
      agent = agentData;
      onExit = exitCallback;
      enterProgress = 0;
      shadeOpen = true;   // each visit starts with the shade open
      shadeProgress = 1;
      container.innerHTML = `<canvas id="interior-canvas"></canvas>`;
      canvas = document.getElementById("interior-canvas");
      ctx = canvas.getContext("2d");
      canvas.style.cursor = "default";
      canvas.addEventListener("click", handleClick);
      canvas.addEventListener("mousemove", (e) => {
        const r = canvas.getBoundingClientRect();
        const cx = e.clientX - r.left, cy = e.clientY - r.top;
        const { wx, wy, ww, wh } = windowRect();
        const overWindow = cx >= wx - 8 && cx <= wx + ww + 8 && cy >= wy - 8 && cy <= wy + wh + 8;
        canvas.style.cursor = overWindow ? "pointer" : "default";
      });
      resize();
      window.addEventListener("resize", resize);
      if (!raf) frame();
    },
    setAgent(a) { if (a) agent = a; },
    close() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      window.removeEventListener("resize", resize);
      agent = null;
      if (onExit) onExit();
    },
  };
})();
