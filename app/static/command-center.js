/* ============================================================================
   AETHER Command Center — immersive orbital control room for the
   Faceless Control Center pipeline. Vanilla JS, no build step.
   ============================================================================ */

const API = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? r.json() : r;
};
const el = (h) => { const t = document.createElement("template"); t.innerHTML = h.trim(); return t.content.firstChild; };
const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- world state
const state = {
  pan: { x: 0, y: 0 },      // user pan (WASD / drag)
  target: { x: 0, y: 0 },   // eased pan target
  zoom: 1, zoomTarget: 1,
  mouse: { x: 0, y: 0 },    // -1..1 normalized offset from center (parallax)
  keys: {},
  dragging: false,
  dragStart: null,
  agents: [], core: null,
  t0: performance.now(),
};

// ============================================================ STARFIELD
function initStarfield() {
  const cv = $("#starfield");
  const ctx = cv.getContext("2d");
  let stars = [], shooting = [];
  function resize() {
    cv.width = window.innerWidth; cv.height = window.innerHeight;
    const n = Math.floor((cv.width * cv.height) / 1600);
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * cv.width, y: Math.random() * cv.height,
      z: Math.random(),                      // depth for parallax + size
      tw: Math.random() * Math.PI * 2,        // twinkle phase
      tws: 0.5 + Math.random() * 2,
    }));
  }
  resize();
  window.addEventListener("resize", resize);

  function maybeShoot() {
    if (Math.random() < 0.008 && shooting.length < 3) {
      const edge = Math.random() * cv.width;
      shooting.push({ x: edge, y: -20, vx: (Math.random() - 0.5) * 6 - 2, vy: 5 + Math.random() * 5, life: 1 });
    }
  }

  function frame(now) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    const px = state.mouse.x, py = state.mouse.y;
    for (const s of stars) {
      const depth = 0.3 + s.z * 1.4;
      const ox = px * depth * 26, oy = py * depth * 26;
      const size = s.z * 1.8 + 0.3;
      const tw = 0.5 + 0.5 * Math.sin(s.tw + now * 0.001 * s.tws);
      ctx.globalAlpha = 0.25 + tw * 0.75 * s.z;
      ctx.fillStyle = s.z > 0.85 ? "#bfefff" : "#ffffff";
      ctx.beginPath();
      ctx.arc(s.x + ox, s.y + oy, size, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    maybeShoot();
    for (const sh of shooting) {
      sh.x += sh.vx; sh.y += sh.vy; sh.life -= 0.012;
      const grad = ctx.createLinearGradient(sh.x, sh.y, sh.x - sh.vx * 8, sh.y - sh.vy * 8);
      grad.addColorStop(0, `rgba(0,232,255,${Math.max(sh.life, 0)})`);
      grad.addColorStop(1, "rgba(0,232,255,0)");
      ctx.strokeStyle = grad; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(sh.x - sh.vx * 8, sh.y - sh.vy * 8); ctx.stroke();
    }
    shooting = shooting.filter((s) => s.life > 0 && s.y < cv.height + 40);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ============================================================ CONSTELLATION
function layoutConstellation() {
  const world = $("#world");
  world.querySelectorAll(".node").forEach((n) => n.remove());
  const linkLayer = $("#linkLayer");
  linkLayer.innerHTML = "";

  const R1 = 250, R2 = 430;
  const ring1 = state.agents.filter((a) => a.ring === 1);
  const ring2 = state.agents.filter((a) => a.ring === 2);

  const place = (list, radius, phase) => {
    list.forEach((a, i) => {
      a._r = radius;
      a._angle = phase + (i / list.length) * Math.PI * 2;
      // link line
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      line.setAttribute("class", "link-line");
      line.dataset.agent = a.id;
      linkLayer.appendChild(line);
      // pulse dot (hidden until active)
      const pulse = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      pulse.setAttribute("class", "link-pulse");
      pulse.setAttribute("r", "2.6");
      pulse.dataset.agent = a.id;
      pulse.style.opacity = "0";
      linkLayer.appendChild(pulse);

      const node = el(`
        <div class="node ${a.status === "running" ? "running" : ""}" data-agent="${a.id}" style="--nodeColor:${a.color}">
          <div class="hex" style="--nodeColor:${a.color}">${a.icon}</div>
          <div class="node-name">${a.name}</div>
          <div class="node-status"><span class="blip"></span>${a.status || "idle"}</div>
        </div>`);
      node.addEventListener("click", (e) => { e.stopPropagation(); openAgent(a.id); });
      world.appendChild(node);
      a._node = node;
    });
  };
  place(ring1, R1, -Math.PI / 2);
  place(ring2, R2, -Math.PI / 2 + Math.PI / ring2.length);
}

function updateConstellation(dt, now) {
  // slow orbital drift
  const spin1 = 0.018, spin2 = 0.011;
  const linkLayer = $("#linkLayer");
  for (const a of state.agents) {
    if (!a._node) continue;
    a._angle += (a.ring === 1 ? spin1 : spin2) * dt;
    const x = Math.cos(a._angle) * a._r;
    const y = Math.sin(a._angle) * a._r;
    // gentle bob
    const bob = Math.sin(now * 0.001 + a._angle * 3) * 5;
    a._node.style.transform = `translate(${x}px, ${y + bob}px)`;
    // link line
    const line = linkLayer.querySelector(`path.link-line[data-agent="${a.id}"]`);
    if (line) line.setAttribute("d", `M0,0 L${x},${y + bob}`);
    // pulse travels outward when running
    const pulse = linkLayer.querySelector(`circle.link-pulse[data-agent="${a.id}"]`);
    if (pulse) {
      if (a.status === "running") {
        const p = ((now * 0.0006) % 1);
        pulse.setAttribute("cx", (x * p).toFixed(1));
        pulse.setAttribute("cy", ((y + bob) * p).toFixed(1));
        pulse.style.opacity = "1";
        line.setAttribute("stroke", a.color);
        line.setAttribute("stroke-opacity", "0.5");
      } else {
        pulse.style.opacity = "0";
        line.setAttribute("stroke", "rgba(0,232,255,0.16)");
      }
    }
  }
}

// ============================================================ CAMERA / PARALLAX
function initCamera() {
  const universe = $("#universe");
  window.addEventListener("mousemove", (e) => {
    state.mouse.x = (e.clientX / window.innerWidth - 0.5) * 2;
    state.mouse.y = (e.clientY / window.innerHeight - 0.5) * 2;
  });
  // drag to pan
  universe.addEventListener("mousedown", (e) => {
    if (e.target.closest(".node, #core, .holo, #console, .hud, #agent-detail, #bigpanel")) return;
    state.dragging = true; universe.classList.add("grabbing");
    state.dragStart = { x: e.clientX, y: e.clientY, px: state.target.x, py: state.target.y };
  });
  window.addEventListener("mousemove", (e) => {
    if (!state.dragging) return;
    state.target.x = state.dragStart.px + (e.clientX - state.dragStart.x);
    state.target.y = state.dragStart.py + (e.clientY - state.dragStart.y);
  });
  window.addEventListener("mouseup", () => { state.dragging = false; universe.classList.remove("grabbing"); });
  // scroll zoom
  universe.addEventListener("wheel", (e) => {
    if (e.target.closest(".holo, #agent-detail, #bigpanel, #console")) return;
    e.preventDefault();
    state.zoomTarget = Math.min(1.8, Math.max(0.5, state.zoomTarget - e.deltaY * 0.0011));
  }, { passive: false });
  // WASD
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    state.keys[e.key.toLowerCase()] = true;
    if (e.key === "Escape") { closeAgent(); closeBigPanel(); }
  });
  window.addEventListener("keyup", (e) => { state.keys[e.key.toLowerCase()] = false; });
  // focus command bar on "/"
  window.addEventListener("keydown", (e) => {
    if (e.key === "/" && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
      e.preventDefault(); $("#cmd").focus();
    }
  });
}

function tickCamera(dt) {
  const sp = 6 * dt * 60;
  if (state.keys["w"] || state.keys["arrowup"]) state.target.y += sp;
  if (state.keys["s"] || state.keys["arrowdown"]) state.target.y -= sp;
  if (state.keys["a"] || state.keys["arrowleft"]) state.target.x += sp;
  if (state.keys["d"] || state.keys["arrowright"]) state.target.x -= sp;
  // ease
  state.pan.x += (state.target.x - state.pan.x) * 0.12;
  state.pan.y += (state.target.y - state.pan.y) * 0.12;
  state.zoom += (state.zoomTarget - state.zoom) * 0.1;

  const parX = -state.mouse.x * 42, parY = -state.mouse.y * 42;
  const tiltX = state.mouse.y * 4, tiltY = -state.mouse.x * 4;
  $("#world").style.transform =
    `translate(-50%, -50%) translate(${state.pan.x + parX}px, ${state.pan.y + parY}px) scale(${state.zoom}) rotateX(${tiltX}deg) rotateY(${tiltY}deg)`;
  $("#gridwash").style.transform = `translate(${state.mouse.x * -16}px, ${state.mouse.y * -16}px)`;
}

// ============================================================ MAIN LOOP
function mainLoop(now) {
  const dt = Math.min((now - (mainLoop._last || now)) / 1000, 0.05);
  mainLoop._last = now;
  tickCamera(dt);
  updateConstellation(dt, now);
  requestAnimationFrame(mainLoop);
}

// ============================================================ AGENT DETAIL
function openAgent(id) {
  const a = id === "aether" ? state.core : state.agents.find((x) => x.id === id);
  if (!a) return;
  const d = $("#agent-detail");
  const running = a.status === "running";
  d.style.setProperty("--nodeColor", a.color);
  d.innerHTML = `
    <button class="icon-btn ad-close" onclick="closeAgent()">✕</button>
    <div class="ad-hex" style="--nodeColor:${a.color}">${a.icon}</div>
    <h2>${a.name}</h2>
    <div class="ad-title" style="color:${a.color}">${a.title || a.blurb ? (a.title || "") : ""}</div>
    <div class="ad-status ${running ? "running" : ""}"><span class="blip"></span>${running ? "Active" : "Standing by"}</div>
    <div class="ad-blurb">${a.blurb || ""}</div>
    ${(a.actions && a.actions.length) ? `<div class="ad-section-label">Quick Actions</div>${
      a.actions.map((act) => `<button class="ad-action" data-cmd="${act}">${act}</button>`).join("")
    }` : ""}
  `;
  d.querySelectorAll(".ad-action").forEach((b) =>
    b.addEventListener("click", () => { runCommand(b.dataset.cmd); }));
  d.classList.add("open");
}
window.closeAgent = () => $("#agent-detail").classList.remove("open");

// ============================================================ COMMAND CONSOLE
async function runCommand(text) {
  if (!text || !text.trim()) return;
  $("#cmd").value = "";
  addActivity(`<b>you</b> ▸ ${text}`);
  try {
    const res = await API("/api/command", { method: "POST", body: JSON.stringify({ text }) });
    if (res.message) toast(res.message);
    if (res.action === "open_panel") openBigPanel(res.panel);
    if (res.action === "job_created") {
      addActivity(`<b>AETHER</b> ▸ job dispatched · ${res.topic}`);
      refreshAll();
    }
    if (res.action === "need_channel") openBigPanel("channels");
    if (res.action === "help") { /* toast already shown */ }
  } catch (e) { toast("Command failed: " + e.message); }
}
function initConsole() {
  $("#cmd").addEventListener("keydown", (e) => { if (e.key === "Enter") runCommand(e.target.value); });
  $("#cmd-send").addEventListener("click", () => runCommand($("#cmd").value));
}

// ============================================================ TOASTS + ACTIVITY
function toast(msg) {
  const t = el(`<div class="toast">${msg}</div>`);
  $("#toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .4s"; }, 4200);
  setTimeout(() => t.remove(), 4700);
}
function addActivity(html) {
  const list = $("#activity-list");
  const line = el(`<div class="act-line">${html}</div>`);
  list.prepend(line);
  while (list.children.length > 7) list.lastChild.remove();
}

// ============================================================ HUD / STATS / CLOCK
function initClock() {
  const upd = () => {
    const now = new Date();
    $("#clock").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  upd(); setInterval(upd, 1000);
}

async function refreshStats() {
  try {
    const [rundown, jobs] = await Promise.all([API("/api/rundown"), API("/api/jobs")]);
    $("#stat-videos").textContent = jobs.length;
    $("#stat-progress").textContent = rundown.videos_in_progress;
    $("#stat-published").textContent = jobs.filter((j) => j.status === "published").length;
    $("#stat-today").textContent = rundown.videos_started_today;
    // telemetry sparklines (real-ish blended with synthetic motion)
    updateSpark("spark-views", jobs.length * 1240 + Math.floor(Math.random() * 400));
    updateSpark("spark-watch", (jobs.length * 3.2).toFixed(1));
  } catch (e) { /* backend may be starting */ }
}

// ============================================================ AGENTS (live)
async function refreshAgents() {
  try {
    const data = await API("/api/agents");
    const first = state.agents.length === 0;
    if (first) {
      state.core = data.core;
      state.agents = data.agents;
      layoutConstellation();
    } else {
      // merge live status
      for (const a of data.agents) {
        const cur = state.agents.find((x) => x.id === a.id);
        if (cur && cur.status !== a.status) {
          cur.status = a.status;
          if (cur._node) {
            cur._node.classList.toggle("running", a.status === "running");
            cur._node.querySelector(".node-status").innerHTML =
              `<span class="blip"></span>${a.status}`;
            if (a.status === "running") addActivity(`<b>${cur.name}</b> ▸ engaged`);
          }
        }
      }
      state.core.status = data.core.status;
    }
    const coreEl = $("#core");
    if (coreEl && data.core) coreEl.classList.toggle("busy", data.core.status === "running");
  } catch (e) { /* ignore */ }
}

// ============================================================ RITUALS / COUNTDOWN
let ritualsCache = [];
async function refreshRituals() {
  try {
    const data = await API("/api/briefings");
    ritualsCache = data.rituals;
    renderRituals();
  } catch (e) { /* ignore */ }
}
function renderRituals() {
  const box = $("#ritual-list");
  box.innerHTML = ritualsCache.slice(0, 4).map((r) => `
    <div class="ritual" data-next="${r.next_run_iso}">
      <div class="ritual-top">
        <div class="ritual-name">${r.icon} ${r.name}</div>
        <div class="ritual-count">--:--</div>
      </div>
      <div class="ritual-desc">${r.desc}</div>
    </div>`).join("");
}
function tickRituals() {
  document.querySelectorAll("#ritual-list .ritual").forEach((row) => {
    const next = new Date(row.dataset.next).getTime();
    let diff = Math.max(0, Math.floor((next - Date.now()) / 1000));
    const h = String(Math.floor(diff / 3600)).padStart(2, "0");
    const m = String(Math.floor((diff % 3600) / 60)).padStart(2, "0");
    const s = String(diff % 60).padStart(2, "0");
    row.querySelector(".ritual-count").textContent = `${h}:${m}:${s}`;
  });
}

// ============================================================ TELEMETRY SPARKS
const sparkData = {};
function updateSpark(id, value) {
  if (!sparkData[id]) sparkData[id] = Array(24).fill(0).map(() => Math.random());
  sparkData[id].push(Math.random() * 0.4 + 0.4);
  if (sparkData[id].length > 24) sparkData[id].shift();
  const svg = document.getElementById(id);
  if (!svg) return;
  const W = 90, H = 28, d = sparkData[id];
  const pts = d.map((v, i) => `${(i / (d.length - 1)) * W},${H - v * H}`).join(" ");
  svg.innerHTML = `<polyline fill="none" stroke="var(--green)" stroke-width="1.5" points="${pts}"/>`;
  const valEl = document.getElementById(id + "-val");
  if (valEl) valEl.textContent = typeof value === "number" ? value.toLocaleString() : value;
}
function initSparks() {
  updateSpark("spark-views", 0); updateSpark("spark-watch", 0);
  updateSpark("spark-agents", 0);
  setInterval(() => {
    const running = state.agents.filter((a) => a.status === "running").length;
    updateSpark("spark-agents", running);
  }, 2500);
}

// ============================================================ BIG PANELS (reuse API)
function stopAllPanelPolls() {
  if (jobPoll) { clearInterval(jobPoll); jobPoll = null; }
  if (mcPoll) { clearInterval(mcPoll); mcPoll = null; }
}
async function openBigPanel(which) {
  stopAllPanelPolls();
  const bp = $("#bigpanel"), inner = $("#bigpanel-inner");
  inner.innerHTML = `<button class="icon-btn bp-close" onclick="closeBigPanel()">✕</button><div id="bp-body"></div>`;
  inner.classList.toggle("wide", which === "missioncontrol");
  bp.classList.add("open");
  const body = $("#bp-body");
  if (which === "settings") return renderSettingsPanel(body);
  if (which === "channels") return renderChannelsPanel(body);
  if (which === "jobs") return renderJobsPanel(body);
  if (which === "missioncontrol") return renderMissionControlPanel(body);
}
window.closeBigPanel = () => { stopAllPanelPolls(); $("#bigpanel").classList.remove("open"); };

async function renderChannelsPanel(body) {
  body.innerHTML = `<h1>Channels</h1><div class="bp-sub">Each channel is its own faceless brand — niche, voice, and platform links.</div><div id="ch-list"></div>`;
  const channels = await API("/api/channels");
  const list = $("#ch-list");
  channels.forEach((c) => {
    const card = el(`<div class="card">
      <h2>${c.name}</h2>
      <div class="job-meta" style="margin-bottom:10px">${c.niche || "No niche set"}</div>
      <div class="conn-status"><span class="dot ${c.youtube_connected ? "on" : ""}"></span> YouTube ${c.youtube_connected ? "connected" : "not connected"}</div>
      <div class="conn-status"><span class="dot ${c.tiktok_connected ? "on" : ""}"></span> TikTok ${c.tiktok_connected ? "connected" : "not connected"}</div>
      <div class="pill-row" style="margin-top:12px">
        ${c.youtube_connected ? "" : `<a class="btn secondary" href="/auth/youtube/start?channel_id=${c.id}">Connect YouTube</a>`}
        ${c.tiktok_connected ? "" : `<a class="btn secondary" href="/auth/tiktok/start?channel_id=${c.id}">Connect TikTok</a>`}
      </div>
      <div style="border-top:1px solid var(--border-soft); margin:14px 0 12px; padding-top:12px">
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <input type="checkbox" id="auto-${c.id}" ${c.auto_enabled ? "checked" : ""} style="width:auto;margin:0"/>
          <span style="color:var(--ink);text-transform:none;font-size:13px;letter-spacing:0">⏳ Chronos automation — auto-generate videos</span>
        </label>
        <div class="form-row">
          <div><label>Videos per day</label><input type="number" min="1" max="24" id="perday-${c.id}" value="${c.auto_per_day || 3}"/></div>
          <div><label style="display:flex;align-items:center;gap:6px;margin-top:8px">
            <input type="checkbox" id="autopub-${c.id}" ${c.auto_publish_scheduled ? "checked" : ""} style="width:auto;margin:0"/>
            <span style="text-transform:none;font-size:12px;color:var(--muted)">Auto-publish when ready</span>
          </label></div>
        </div>
        <button class="btn secondary" data-autosave="${c.id}">Save Automation</button>
        ${c.auto_enabled ? `<div class="hint" style="margin-top:10px">🤖 Auto-generating ~${c.auto_per_day}/day. Needs the app running continuously to fire on schedule — see the README hosting note if it's on a host that sleeps when idle.</div>` : ""}
      </div>
      <div class="pill-row" style="margin-top:4px"><button class="btn danger" data-del="${c.id}">Delete Channel</button></div>
      </div>`);
    card.querySelector("[data-del]").addEventListener("click", async () => {
      if (!confirm(`Delete "${c.name}"?`)) return;
      await API(`/api/channels/${c.id}`, { method: "DELETE" }); renderChannelsPanel(body);
    });
    card.querySelector(`[data-autosave="${c.id}"]`).addEventListener("click", async () => {
      // PUT replaces the whole channel record, so we send every existing field
      // back untouched plus the updated automation fields -- never just the diff.
      const payload = {
        name: c.name, niche: c.niche, style_notes: c.style_notes,
        voice_id: c.voice_id, visual_style: c.visual_style,
        auto_enabled: $(`#auto-${c.id}`).checked,
        auto_per_day: parseInt($(`#perday-${c.id}`).value, 10) || 1,
        auto_publish_scheduled: $(`#autopub-${c.id}`).checked,
      };
      await API(`/api/channels/${c.id}`, { method: "PUT", body: JSON.stringify(payload) });
      toast(`Automation saved for ${c.name}.`);
      renderChannelsPanel(body);
    });
    list.appendChild(card);
  });
  const form = el(`<div class="card"><h2>New Channel</h2>
    <label>Name</label><input id="nc-name" placeholder="Late Night Facts"/>
    <label>Niche / content description</label><textarea id="nc-niche" placeholder="eerie true stories with a twist, 60s, dark tone"></textarea>
    <label>Style notes (optional)</label><textarea id="nc-style" placeholder="always end on a question"></textarea>
    <div class="form-row"><div><label>ElevenLabs voice ID</label><input id="nc-voice" placeholder="optional"/></div>
    <div><label>Visual style</label><input id="nc-visual" placeholder="moody, film grain"/></div></div>
    <button class="btn" id="nc-save">Create Channel</button></div>`);
  form.querySelector("#nc-save").addEventListener("click", async () => {
    const p = { name: $("#nc-name").value.trim(), niche: $("#nc-niche").value.trim(),
      style_notes: $("#nc-style").value.trim(), voice_id: $("#nc-voice").value.trim(), visual_style: $("#nc-visual").value.trim() };
    if (!p.name) return toast("Name the channel first.");
    await API("/api/channels", { method: "POST", body: JSON.stringify(p) });
    toast("Channel created."); renderChannelsPanel(body);
  });
  body.appendChild(form);
}

async function renderJobsPanel(body) {
  body.innerHTML = `<h1>Video Library</h1><div class="bp-sub">Every video the constellation has produced.</div><div id="jb-list"></div>`;
  const [jobs, channels] = await Promise.all([API("/api/jobs"), API("/api/channels")]);
  const list = $("#jb-list");
  if (!jobs.length) list.innerHTML = `<div class="card">No videos yet. Ask AETHER to "make a video about…"</div>`;
  jobs.forEach((j) => {
    const ch = channels.find((c) => c.id === j.channel_id);
    const row = el(`<div class="job-row"><div>
      <div class="job-title">${j.title || "(generating…)"}</div>
      <div class="job-meta">${ch ? ch.name : "?"} · ${new Date(j.created_at).toLocaleString()}</div></div>
      <span class="badge ${j.status}">${j.status.replace(/_/g, " ")}</span></div>`);
    row.addEventListener("click", () => renderJobDetail(body, j.id));
    list.appendChild(row);
  });
}

let jobPoll = null;
async function renderJobDetail(body, jobId) {
  if (jobPoll) clearInterval(jobPoll);
  const draw = async () => {
    const j = await API(`/api/jobs/${jobId}`);
    body.innerHTML = `<button class="btn secondary" onclick="reopenJobs()">← Library</button>
      <h1 style="margin-top:14px">${j.title || "Generating…"}</h1>
      <div class="bp-sub">Job ${j.id} · <span class="badge ${j.status}">${j.status.replace(/_/g, " ")}</span></div>`;
    if (j.video_path && ["ready_for_review", "publishing", "published"].includes(j.status)) {
      body.appendChild(el(`<div class="card"><video controls src="/api/jobs/${j.id}/video"></video>
        <div class="pill-row" style="margin-top:12px">
          <a class="btn secondary" href="/api/jobs/${j.id}/video" download>Download MP4</a>
          ${j.status === "ready_for_review" ? `<button class="btn" id="pub-now">Publish now</button>` : ""}
        </div></div>`));
      const pn = $("#pub-now");
      if (pn) pn.addEventListener("click", async () => { pn.disabled = true; pn.textContent = "Publishing…"; try { await API(`/api/jobs/${j.id}/publish`, { method: "POST" }); draw(); } catch (e) { toast(e.message); } });
    }
    body.appendChild(el(`<div class="card"><h2>Progress Log</h2><div class="log-box">${(j.stage_log || "").trim() || "Queued…"}</div></div>`));
    if (j.script_text) body.appendChild(el(`<div class="card"><h2>Script</h2><div style="white-space:pre-wrap;font-size:14px;line-height:1.6">${j.script_text}</div></div>`));
    if (["published", "failed", "ready_for_review"].includes(j.status) && jobPoll) { clearInterval(jobPoll); jobPoll = null; }
  };
  await draw();
  jobPoll = setInterval(draw, 3000);
  window.reopenJobs = () => { if (jobPoll) clearInterval(jobPoll); renderJobsPanel(body); };
}

// ============================================================ MISSION CONTROL
// A dense ops-console view of the same data the orbital constellation shows,
// for when you want a scan-it-fast list instead of flying through a starfield.
function timeAgo(iso) {
  if (!iso) return "";
  const t = new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

let mcPoll = null;
async function renderMissionControlPanel(body) {
  if (mcPoll) clearInterval(mcPoll);
  body.innerHTML = `
    <div class="msc-wrap">
      <nav class="msc-nav">
        <div class="msc-nav-brand">🛰️ MISSION<br/>CONTROL</div>
        <button class="msc-nav-item active" data-nav="missioncontrol">Overview</button>
        <button class="msc-nav-item" data-nav="channels">Channels</button>
        <button class="msc-nav-item" data-nav="jobs">Video Library</button>
        <button class="msc-nav-item" data-nav="settings">Control Panel</button>
        <button class="msc-nav-item" id="msc-nav-orbit">← Back to Orbit</button>
      </nav>
      <div class="msc-main">
        <h1 style="margin-bottom:2px">Mission Control</h1>
        <div class="bp-sub">Real numbers, real agent activity — no theatrics.</div>
        <div class="msc-stats" id="msc-stats"></div>
        <div class="msc-cols">
          <div class="msc-channels" id="msc-channels"><h2>Channels</h2><div id="msc-ch-list"></div></div>
          <div class="msc-activity">
            <h2>Live Activity Stream</h2>
            <div id="msc-act-list" class="msc-act-list"></div>
          </div>
        </div>
        <div class="msc-uplink" id="msc-uplink"><span class="hdot"></span> <span id="msc-uplink-text">Connecting…</span></div>
      </div>
    </div>`;
  body.querySelectorAll(".msc-nav-item[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => openBigPanel(btn.dataset.nav));
  });
  $("#msc-nav-orbit").addEventListener("click", () => closeBigPanel());

  const draw = async () => {
    let overview, act;
    try {
      [overview, act] = await Promise.all([
        API("/api/missioncontrol/overview"),
        API("/api/missioncontrol/activity?limit=30"),
      ]);
    } catch (e) { return; }

    const stats = $("#msc-stats");
    if (stats) stats.innerHTML = `
      <div class="msc-tile"><div class="mt-val">${overview.totals.subscribers.toLocaleString()}</div><div class="mt-label">Total Subscribers</div></div>
      <div class="msc-tile"><div class="mt-val">${overview.totals.views.toLocaleString()}</div><div class="mt-label">Total Views</div></div>
      <div class="msc-tile"><div class="mt-val">${overview.totals.videos_today}</div><div class="mt-label">Videos Today</div></div>
      <div class="msc-tile"><div class="mt-val">${overview.totals.videos_total}</div><div class="mt-label">Videos All-Time</div></div>
      <div class="msc-tile ${overview.totals.agents_live ? "hot" : ""}"><div class="mt-val">${overview.totals.agents_live}</div><div class="mt-label">Agents Live Now</div></div>`;

    const chList = $("#msc-ch-list");
    if (chList) {
      chList.innerHTML = "";
      if (!overview.channels.length) chList.innerHTML = `<div class="msc-empty">No channels yet.</div>`;
      overview.channels.forEach((c) => {
        chList.appendChild(el(`<div class="msc-ch-card">
          <div class="msc-ch-name">${c.name}</div>
          <div class="msc-ch-meta">
            <span class="dot ${c.youtube_connected ? "on" : ""}"></span>
            ${c.youtube_connected ? (c.youtube_channel_title || "YouTube connected") : "YouTube not connected"}
          </div>
          ${c.youtube_connected ? `<div class="msc-ch-nums">
            <span>${c.hidden_subs ? "hidden" : (c.subscribers ?? 0).toLocaleString()} subs</span>
            <span>${(c.views ?? 0).toLocaleString()} views</span>
          </div>` : ""}
        </div>`));
      });
    }

    const actList = $("#msc-act-list");
    if (actList) {
      actList.innerHTML = "";
      if (!act.length) actList.innerHTML = `<div class="msc-empty">No agent activity yet. Ask AETHER to make a video and watch this fill up.</div>`;
      act.forEach((ev) => {
        actList.appendChild(el(`<div class="msc-act-row" style="--ac:${ev.agent_color}">
          <span class="msc-act-tag">${ev.agent_icon}</span>
          <div class="msc-act-body">
            <div class="msc-act-top"><b>${ev.agent_name}</b><span class="msc-act-chan">${ev.channel}</span><span class="msc-act-time">${timeAgo(ev.ts)}</span></div>
            <div class="msc-act-text">${ev.text}</div>
          </div>
        </div>`));
      });
    }

    const uplinkText = $("#msc-uplink-text");
    if (uplinkText) uplinkText.textContent = `AETHER CORE — ${overview.uplink}`;
  };
  await draw();
  mcPoll = setInterval(draw, 6000);
}

async function renderSettingsPanel(body) {
  const s = await API("/api/settings");
  const field = (k, label, ph, type = "password") =>
    `<label>${label}${s[k] && s[k].set ? ` — set (${s[k].value})` : ""}</label>
     <input type="${type}" id="st-${k}" placeholder="${s[k] && s[k].set ? "leave blank to keep" : ph}"/>`;
  body.innerHTML = `<h1>Control Panel</h1><div class="bp-sub">API keys are encrypted at rest and never shown in full.</div>
    <div class="card"><h2>Script Writer</h2>
      <label>Provider</label>
      <select id="st-llm_provider">
        <option value="anthropic" ${s.llm_provider.value === "anthropic" ? "selected" : ""}>Anthropic (Claude)</option>
        <option value="gemini" ${s.llm_provider.value === "gemini" ? "selected" : ""}>Gemini</option>
        <option value="openai" ${s.llm_provider.value === "openai" ? "selected" : ""}>OpenAI</option>
      </select>
      ${field("anthropic_api_key", "Anthropic (Claude) key", "sk-ant-…")}
      ${field("gemini_api_key", "Gemini key", "AIza…")}
      ${field("openai_api_key", "OpenAI key", "sk-…")}
      <div class="hint">No key yet? Athena falls back to a placeholder script so the whole pipeline still runs.</div>
    </div>
    <div class="card"><h2>Voice — ElevenLabs</h2>${field("elevenlabs_api_key", "ElevenLabs key", "")}
      <div class="hint">No key? Orpheus renders timed silence so you can still test assembly + captions.</div></div>
    <div class="card"><h2>Visuals</h2>
      <label>Provider</label>
      <select id="st-image_provider">
        <option value="placeholder" ${(!s.image_provider.value || s.image_provider.value === "placeholder") ? "selected" : ""}>Placeholder (free, for testing)</option>
        <option value="gemini" ${s.image_provider.value === "gemini" ? "selected" : ""}>Gemini</option>
        <option value="openai" ${s.image_provider.value === "openai" ? "selected" : ""}>OpenAI</option>
        <option value="stability" ${s.image_provider.value === "stability" ? "selected" : ""}>Stability AI</option>
      </select>
      ${field("stability_api_key", "Stability key", "")}
      <div class="hint">Gemini &amp; OpenAI images reuse the keys above.</div></div>
    <div class="card"><h2>YouTube</h2>${field("youtube_client_id", "OAuth Client ID", "", "text")}${field("youtube_client_secret", "OAuth Client Secret", "")}
      <div class="hint">Redirect URI: <code>${location.origin}/auth/youtube/callback</code></div></div>
    <div class="card"><h2>TikTok</h2>${field("tiktok_client_key", "Client Key", "", "text")}${field("tiktok_client_secret", "Client Secret", "")}
      <div class="hint">Redirect URI: <code>${location.origin}/auth/tiktok/callback</code></div></div>
    <button class="btn" id="st-save">Save Settings</button>`;
  $("#st-save").addEventListener("click", async () => {
    const keys = ["llm_provider", "anthropic_api_key", "gemini_api_key", "openai_api_key", "elevenlabs_api_key",
      "image_provider", "stability_api_key", "youtube_client_id", "youtube_client_secret", "tiktok_client_key", "tiktok_client_secret"];
    const payload = {};
    keys.forEach((k) => { const e = $("#st-" + k); if (e && e.value) payload[k] = e.value; });
    await API("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    toast("Settings saved."); renderSettingsPanel(body);
  });
}

// ============================================================ REFRESH ORCHESTRATION
function refreshAll() { refreshAgents(); refreshStats(); }

// ============================================================ BOOT
function runBoot() {
  const lines = [
    "initializing AETHER core .............. <span class='ok'>online</span>",
    "waking agent constellation ............ <span class='ok'>12 agents</span>",
    "calibrating orbital telemetry ......... <span class='ok'>locked</span>",
    "linking production pipeline ........... <span class='ok'>ready</span>",
    "opening command channel ............... <span class='ok'>live</span>",
  ];
  const box = $("#boot-lines");
  let i = 0;
  const next = () => {
    if (i < lines.length) {
      box.innerHTML += lines[i] + "<br>";
      i++;
      setTimeout(next, 340);
    } else {
      setTimeout(endBoot, 620);
    }
  };
  next();
}
function endBoot() {
  const b = $("#boot");
  if (!b || b.classList.contains("done")) return;
  b.classList.add("done");
  setTimeout(() => b.remove(), 900);
  toast("AETHER online. Ask me to make a video, or explore the constellation.");
}

// ============================================================ INIT
async function init() {
  initStarfield();
  initCamera();
  initConsole();
  initClock();
  initSparks();
  $("#core").addEventListener("click", () => openAgent("aether"));
  $("#boot-skip").addEventListener("click", endBoot);

  // toolbar buttons
  $("#tb-settings").addEventListener("click", () => openBigPanel("settings"));
  $("#tb-channels").addEventListener("click", () => openBigPanel("channels"));
  $("#tb-jobs").addEventListener("click", () => openBigPanel("jobs"));
  $("#tb-missioncontrol").addEventListener("click", () => openBigPanel("missioncontrol"));
  $("#bigpanel").addEventListener("click", (e) => { if (e.target.id === "bigpanel") closeBigPanel(); });

  await refreshAgents();
  await refreshRituals();
  await refreshStats();

  requestAnimationFrame(mainLoop);
  runBoot();

  // live loops
  setInterval(refreshAgents, 2500);
  setInterval(refreshStats, 6000);
  setInterval(refreshRituals, 60000);
  setInterval(tickRituals, 1000);
}

window.runCommand = runCommand;
document.addEventListener("DOMContentLoaded", init);
