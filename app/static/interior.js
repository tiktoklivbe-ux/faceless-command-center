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

  const C = {
    wallBack: "#4a3a34",
    wallSide: "#3b2e29",
    wallTrim: "#5c4840",
    floor: "#6b4f3c",
    floorAlt: "#5e4534",
    rug: "#7a4a4a",
    rugAlt: "#8d5a52",
    desk: "#8a6244",
    deskTop: "#a3764f",
    deskDark: "#6b4a33",
    screenOn: "#7fd4e8",
    screenOff: "#22303a",
    metal: "#8d8378",
    plant: "#4e7a46",
    plantDark: "#3c5f36",
    beanbag: "#7a5a8a",
    beanbagAlt: "#6a4a78",
    tv: "#22262b",
    warmLight: "#ffc46b",
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

    ctx.strokeStyle = "rgba(0,0,0,0.16)";
    ctx.lineWidth = 2;
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

    // Skirting board
    ctx.fillStyle = C.wallTrim;
    ctx.fillRect(0, floorY - 12, W, 12);
  }

  function drawWindow() {
    const wx = W * 0.72, wy = H * 0.14, ww = W * 0.2, wh = H * 0.30;

    // Frame
    ctx.fillStyle = C.wallTrim;
    ctx.fillRect(wx - 10, wy - 10, ww + 20, wh + 20);

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
    ctx.strokeStyle = C.wallTrim;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(wx + ww / 2, wy); ctx.lineTo(wx + ww / 2, wy + wh);
    ctx.moveTo(wx, wy + wh / 2); ctx.lineTo(wx + ww, wy + wh / 2);
    ctx.stroke();

    // Light spilling onto the floor
    const spill = ctx.createLinearGradient(wx, wy + wh, wx - 60, H * 0.85);
    spill.addColorStop(0, "rgba(255,190,120,0.16)");
    spill.addColorStop(1, "rgba(255,190,120,0)");
    ctx.fillStyle = spill;
    ctx.beginPath();
    ctx.moveTo(wx - 20, H * 0.62);
    ctx.lineTo(wx + ww + 20, H * 0.62);
    ctx.lineTo(wx + ww + 90, H);
    ctx.lineTo(wx - 130, H);
    ctx.closePath(); ctx.fill();
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
    ctx.fillStyle = "#2b2b30";
    ctx.fillRect(mx2 - 6, my2 - 6, mw + 12, mh + 12);

    const working = agent && agent.status === "running";
    ctx.fillStyle = working ? C.screenOn : C.screenOff;
    ctx.fillRect(mx2, my2, mw, mh);

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
        ctx.fillStyle = "#ffe9c8";
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
    // screen with a slow colour drift so it reads as "on"
    const hue = (t * 0.3) % 360;
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
    // books / boxes
    const cols = ["#8a5a4a", "#5a6a8a", "#7d8a5a", "#8a7a4a", "#6a5a7a"];
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
    // pot
    ctx.fillStyle = "#9c6a4a";
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
        ctx.fillStyle = i % 2 ? "#e6dbc9" : "#d6c9b4";
        ctx.fillRect(px - 30 + i * 2, py + 30 - i * 9, 62, 9);
      }
    } else if (id === "hermes") {
      // outbox with a paper plane
      ctx.fillStyle = C.metal; ctx.fillRect(px - 34, py + 16, 68, 26);
      ctx.fillStyle = "#e8e0d2";
      ctx.beginPath();
      const fy = py - 20 + Math.sin(t * 0.05) * 8;
      ctx.moveTo(px - 18, fy); ctx.lineTo(px + 26, fy - 10); ctx.lineTo(px - 6, fy + 14);
      ctx.closePath(); ctx.fill();
    } else {
      // filing cabinet as a generic office prop
      ctx.fillStyle = C.metal; ctx.fillRect(px - 28, py - 30, 56, 78);
      ctx.fillStyle = "#6f675e";
      for (let i = 0; i < 3; i++) ctx.fillRect(px - 22, py - 22 + i * 25, 44, 18);
    }
  }

  function drawNameplate() {
    if (!agent) return;
    ctx.font = "700 34px Rajdhani, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffc46b";
    ctx.fillText(agent.name, 44, 58);
    ctx.font = "400 15px Rajdhani, sans-serif";
    ctx.fillStyle = "rgba(235,220,205,0.8)";
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

    drawRoom();
    drawWindow();
    drawTV();
    drawShelf();
    drawSignatureProp();
    drawDesk();
    drawBeanbag();
    drawPlant();
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

  window.InteriorView = {
    open(container, agentData, exitCallback) {
      agent = agentData;
      onExit = exitCallback;
      enterProgress = 0;
      container.innerHTML = `<canvas id="interior-canvas"></canvas>`;
      canvas = document.getElementById("interior-canvas");
      ctx = canvas.getContext("2d");
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
