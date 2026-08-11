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

/** Escapes text that's about to be interpolated into an innerHTML template.
 *  Without this, dynamic text containing angle brackets -- which Python
 *  tracebacks and error reprs do constantly (`<module>`, `<listcomp>`,
 *  `<Channel at 0x...>`) -- gets parsed as real HTML tags instead of shown
 *  as text, silently mangling whatever panel it lands in. Found this by
 *  actually clicking through a real failed job's error message, not by
 *  inspection -- it broke exactly that way. */
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);

/** A small "⧉ Copy" button that copies the text content of whatever element
 *  `targetSel` points to. Wired once, globally, via delegation below --
 *  drop this next to any log/output box and it just works, no per-panel
 *  event handling needed. Built for the exact moment a video fails and you
 *  need to hand the real error text over rather than a screenshot. */
const copyBtn = (targetSel, label = "Copy") =>
  `<button class="copy-btn" data-copy-target="${targetSel}" title="Copy to clipboard">⧉ ${label}</button>`;

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  const target = btn.dataset.copyTarget && document.querySelector(btn.dataset.copyTarget);
  const text = target ? (target.innerText || target.textContent || "").trim() : "";
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "✓ Copied";
    btn.classList.add("copied");
  } catch (err) {
    btn.textContent = "Couldn't copy — select manually";
  }
  setTimeout(() => { btn.textContent = original; btn.classList.remove("copied"); }, 1400);
});

// ---------------------------------------------------------------- world state
// Panel poll handles. Declared at the top because several functions clear
// them, and with `let` a reference before the declaration line is a
// temporal-dead-zone crash -- which silently blanked whichever panel hit it.
let jobPoll = null;
let mcPoll = null;
let villagePoll = null;
let bannerPoll = null;

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


// ============================================================ CONSTELLATION




// ============================================================ CAMERA / PARALLAX




/**
 * Plain-English status for a job -- big readable summary instead of making
 * anyone parse timestamped log lines. Everything shown here is derived from
 * the log the pipeline already writes, so it can't drift out of sync with
 * what's actually happening.
 */
/** Parses a server timestamp as UTC. The API returns naive datetimes with no
 * timezone suffix, so plain `new Date(...)` reads them as LOCAL time -- which
 * produced negative elapsed durations for anyone west of UTC. */
function asUTC(ts) {
  if (!ts) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(ts);
  const d = new Date(hasZone ? ts : ts + "Z");
  return isNaN(d.getTime()) ? null : d;
}

function renderJobStatusCard(j) {
  const lines = (j.stage_log || "").trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1] || "";
  // Timestamps come back as naive UTC (no timezone suffix), so `new Date(...)`
  // would interpret them as LOCAL time and produce a negative elapsed for
  // anyone west of UTC. Appending Z forces correct UTC parsing. This also
  // broke the stall warning below, since `elapsed > 900` can never be true
  // when elapsed is negative.
  const started = asUTC(j.created_at);
  // Clamp at 0: a small clock skew between server and browser shouldn't
  // render as a negative duration.
  const elapsed = started ? Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000)) : 0;
  const mmss = (s) => `${Math.floor(s / 60)}m ${s % 60}s`;

  // How many segments are done, and how many there are in total.
  const totalMatch = /Segment \d+\/(\d+)/.exec(j.stage_log || "");
  const total = totalMatch ? parseInt(totalMatch[1], 10) : null;
  const doneCount = ((j.stage_log || "").match(/clip rendered in/g) || []).length;

  let headline, detail, pct = 0;
  const status = String(j.status || "");

  if (status === "published")            { headline = "✅ Published";        detail = "This one's live."; pct = 100; }
  else if (status === "ready_for_review"){ headline = "✅ Done";             detail = "Ready to watch or publish."; pct = 100; }
  else if (status === "failed")          { headline = "❌ Failed";           detail = j.error_message || "No error recorded."; pct = 0; }
  else if (status === "queued")          { headline = "⏳ Waiting in line";  detail = "Another video is rendering. Videos run one at a time on purpose."; }
  else if (/Script Agent/.test(last))    { headline = "✍️ Writing the script"; detail = "Usually 10-20 seconds."; pct = 5; }
  else if (/Voice Agent|Visual Agent/.test(last) || /clip rendered|Assembly Agent rendering/.test(last)) {
    pct = total ? Math.round(5 + (doneCount / total) * 80) : 30;
    headline = total ? `🎬 Building clip ${Math.min(doneCount + 1, total)} of ${total}` : "🎬 Building clips";
    detail = "Making narration, generating an image, and rendering each clip.";
  }
  else if (/stitching|captions/i.test(last)) { headline = "🔗 Final touches"; detail = "Joining clips and burning in captions."; pct = 92; }
  else                                       { headline = "⏳ Starting up";   detail = "Getting going."; }

  // Flag a genuinely stuck job rather than letting it silently spin.
  const stalled = !["published","ready_for_review","failed","queued"].includes(status) && elapsed > 900;
  const warn = stalled
    ? `<div class="job-warn">⚠️ Running ${mmss(elapsed)} — much longer than expected. It'll be auto-retried, or you can retry it yourself.</div>`
    : "";

  return `<div class="card job-status-card">
    <div class="job-headline">${headline}</div>
    <div class="job-detail" id="job-detail-text">${escapeHtml(detail)}</div>
    ${status === "failed" ? `<div style="margin-top:6px">${copyBtn("#job-detail-text", "Copy error")}</div>` : ""}
    <div class="job-bar"><div class="job-bar-fill" style="width:${pct}%"></div></div>
    <div class="job-meta">${pct}% · running ${mmss(elapsed)}</div>
    ${warn}
  </div>`;
}

/**
 * Wrapper around setInterval that skips work while the tab is hidden and
 * backs off after repeated failures.
 *
 * The app was making ~65 background requests a minute forever, every one
 * hitting the same SQLite database a render needs -- which both made the UI
 * laggy and competed with the pipeline. Most of those requests were for a
 * tab nobody was looking at.
 */
function pollInterval(fn, ms) {
  let failures = 0;
  return setInterval(async () => {
    if (document.hidden) return;           // nobody's looking; don't ask the server
    if (failures > 3 && Math.random() > 0.25) return;  // back off when the server is struggling
    try {
      await fn();
      failures = 0;
    } catch (e) {
      failures++;
    }
  }, ms);
}

// ============================================================ VILLAGE



// ============================================================ MAIN LOOP


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
      // Show the banner immediately rather than waiting up to 5s for the
      // next poll -- the whole point is that starting a video is obvious.
      renderJobBanner({ title: res.topic, status: "queued", stage_log: "" });
      toast("Video started — watch the village.");
      pollActiveJob();
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
/** Activity is surfaced by the village itself (working buildings, villagers
 *  out on the paths), so there's no separate ticker to write to. Kept as a
 *  no-op so callers don't need to know that. */
function addActivity() {}

// ============================================================ HUD / STATS / CLOCK
function initClock() {
  const upd = () => {
    const now = new Date();
    $("#clock").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  upd(); setInterval(upd, 1000);
}



// ============================================================ AGENTS (live)
/** Look up an agent's current display name from the live roster, so a rename
 *  in agents_registry.py propagates everywhere instead of leaving stale
 *  hardcoded codenames scattered across the UI. Falls back to the given
 *  default if the roster hasn't loaded yet. */
function agentName(id, fallback) {
  const a = state.agents.find((x) => x.id === id);
  return (a && a.name) || fallback;
}

async function refreshAgents() {
  try {
    const data = await API("/api/agents");
    // Note when an agent starts working so the activity feed still reflects
    // it -- the village shows current state, not history.
    for (const a of data.agents) {
      const prev = state.agents.find((x) => x.id === a.id);
      if (prev && prev.status !== a.status && a.status === "running") {
        addActivity(`<b>${a.name}</b> ▸ started work`);
      }
    }
    state.core = data.core;
    state.agents = data.agents;
    updateVillage(data.agents);
  } catch (e) { /* ignore */ }
}

// ============================================================ RITUALS / COUNTDOWN
let ritualsCache = [];




// ============================================================ TELEMETRY SPARKS
const sparkData = {};



// ============================================================ BIG PANELS (reuse API)
function stopAllPanelPolls() {
  if (villagePoll) { clearInterval(villagePoll); villagePoll = null; }
  if (window.VillageView) VillageView.unmount();
  if (jobPoll) { clearInterval(jobPoll); jobPoll = null; }
  if (mcPoll) { clearInterval(mcPoll); mcPoll = null; }
}
// Each panel enters from a different side, so switching tabs doesn't feel
// like one interchangeable cut repeated five times -- Mission Control drops
// in like a HUD, Videos rises like a reel, Channels swings in from the left,
// Settings slides in from the right (the original direction, kept because it
// already reads as "a control drawer").
const PANEL_DIR = { missioncontrol: "top", jobs: "bottom", channels: "left", settings: "right" };

async function openBigPanel(which) {
  // If the village is on screen, let its camera pull back and dim first --
  // otherwise a panel opening while the world instantly vanishes underneath
  // it feels like a hard cut instead of a single continuous camera move.
  const stage = document.getElementById("village-stage");
  const villageVisible = stage && stage.offsetParent !== null && window.VillageView;
  if (villageVisible) {
    await new Promise((resolve) => VillageView.pullBack(resolve));
  }

  stopAllPanelPolls();
  const bp = $("#bigpanel"), inner = $("#bigpanel-inner");
  inner.innerHTML = `<button class="icon-btn bp-close" onclick="closeBigPanel()">✕</button><div id="bp-body"></div>`;
  inner.classList.toggle("wide", which === "missioncontrol");
  inner.classList.toggle("fullpage", which === "jarvis");
  inner.classList.remove("dir-top", "dir-bottom", "dir-left", "dir-right");
  inner.classList.add(`dir-${PANEL_DIR[which] || "right"}`);
  bp.classList.add("open");
  const body = $("#bp-body");
  if (which === "settings") return renderSettingsPanel(body);
  if (which === "channels") return renderChannelsPanel(body);
  if (which === "jobs") return renderJobsPanel(body);
  if (which === "missioncontrol") return renderMissionControlPanel(body);
  if (which === "jarvis") return renderJarvisPanel(body);
}
const SIDE_MAP = {
  "side-missioncontrol": "missioncontrol",
  "side-jobs": "jobs",
  "side-channels": "channels",
  "side-settings": "settings",
  "side-jarvis": "jarvis",
};
function setActiveSideItem(panelName) {
  document.querySelectorAll("#sidebar .side-item").forEach((el) => el.classList.remove("active"));
  if (panelName === null) {
    const orbitBtn = $("#side-orbit");
    if (orbitBtn) orbitBtn.classList.add("active");
    return;
  }
  const id = Object.keys(SIDE_MAP).find((k) => SIDE_MAP[k] === panelName);
  if (id) { const el = document.getElementById(id); if (el) el.classList.add("active"); }
}
window.closeBigPanel = () => {
  stopAllPanelPolls();
  $("#bigpanel").classList.remove("open");
  setActiveSideItem(null);
  // stopAllPanelPolls() -> VillageView.unmount() cancels the village's own
  // render loop and NOTHING used to restart it -- mountVillageHome() only
  // ever ran once, at page load. That's why the village went permanently
  // blank and unclickable the moment you visited any panel and came back:
  // the canvas just sat there frozen on its last frame forever. Remounting
  // here is what actually brings it back to life.
  mountVillageHome();
};

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
  // Kill any detail-view poll still running. Without this the old poll keeps
  // firing and overwrites the library with the previous job's detail view --
  // which looks like the tab going blank when you reopen it.
  if (jobPoll) { clearInterval(jobPoll); jobPoll = null; }
  body.innerHTML = `<h1>Video Library</h1><div class="bp-sub">Every video the constellation has produced.</div><div id="jb-list"></div>`;
  const [jobs, channels] = await Promise.all([API("/api/jobs"), API("/api/channels")]);
  const list = $("#jb-list");
  if (!jobs.length) list.innerHTML = `<div class="card">No videos yet. Ask AETHER to "make a video about…"</div>`;
  jobs.forEach((j) => {
    const ch = channels.find((c) => c.id === j.channel_id);
    const row = el(`<div class="job-row"><div>
      <div class="job-title">${j.title || "(generating…)"}</div>
      <div class="job-meta">${ch ? ch.name : "?"} · ${(asUTC(j.created_at) || new Date()).toLocaleString()}</div></div>
      <span class="badge ${j.status}">${j.status.replace(/_/g, " ")}</span></div>`);
    row.addEventListener("click", () => renderJobDetail(body, j.id));
    list.appendChild(row);
  });
}

async function renderJobDetail(body, jobId) {
  if (jobPoll) { clearInterval(jobPoll); jobPoll = null; }
  const draw = async () => {
    const j = await API(`/api/jobs/${jobId}`);
    body.innerHTML = `<button class="btn secondary" onclick="reopenJobs()">← Library</button>
      <h1 style="margin-top:14px">${escapeHtml(j.title) || "Generating…"}</h1>
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
    body.appendChild(el(renderJobStatusCard(j)));
    // Cancel is only meaningful for a job that's actually still running.
    if (!["published","ready_for_review","failed"].includes(String(j.status))) {
      const cancelCard = el(`<div class="card">
        <h2>Stuck?</h2>
        <div class="hint">Stops this job and frees the render slot so queued videos can start. Renders run one at a time, so a wedged job blocks everything behind it.</div>
        <button class="btn danger" id="cancel-job" style="margin-top:10px">Cancel This Video</button>
        <div class="hint" id="cancel-out" style="margin-top:8px"></div>
      </div>`);
      body.appendChild(cancelCard);
      cancelCard.querySelector("#cancel-job").addEventListener("click", async () => {
        const btn = cancelCard.querySelector("#cancel-job");
        const out = cancelCard.querySelector("#cancel-out");
        btn.disabled = true; out.textContent = "Cancelling…";
        // Stop the redraw poll first. This whole panel is rebuilt on every
        // tick, so a redraw landing mid-request destroys this button and its
        // handler -- which is why cancelling appeared to do nothing.
        if (jobPoll) { clearInterval(jobPoll); jobPoll = null; }
        try {
          await API(`/api/jobs/${j.id}/cancel`, { method: "POST" });
          out.textContent = "Cancelled. The render slot is free.";
          await draw();  // redraw once, now showing the cancelled state
        } catch (e) {
          out.textContent = "Couldn't cancel — it may have already finished.";
          btn.disabled = false;
          jobPoll = pollInterval(draw, 8000);  // resume polling
        }
      });
    }
    body.appendChild(el(`<div class="card"><h2>Is it the machine or a bug?</h2>
      <div class="hint">Renders one test clip and reports how fast this server actually is. Use this when a video is taking far longer than expected.</div>
      <button class="btn secondary" id="run-bench" style="margin-top:10px">Run Speed Test</button>
      <div id="bench-out" class="hint" style="margin-top:10px"></div>
    </div>`));
    const bb = document.getElementById("run-bench");
    if (bb) bb.addEventListener("click", async () => {
      const out = document.getElementById("bench-out");
      bb.disabled = true; out.textContent = "Rendering a test clip…";
      try {
        const r = await API("/api/jobs/benchmark");
        out.innerHTML = r.render_succeeded
          ? `<b>${r.verdict.toUpperCase()}</b> — one clip took ${r.single_clip_seconds}s on ${r.cpu_count} CPU(s).
             A full video should take about ${r.projected_full_video_human}.<br><br>${r.advice}`
          : `Test render failed: ${r.error}`;
      } catch (e) { out.textContent = "Couldn't run the speed test."; }
      bb.disabled = false;
    });
    body.appendChild(el(`<div class="card"><h2>What Each Agent Does</h2>
      <div class="agent-legend">
        <div><b>Script (${agentName("athena", "Athena")})</b><span>Writes the script and picks the topic. One Claude call, ~10-20s.</span></div>
        <div><b>Voice (${agentName("orpheus", "Orpheus")})</b><span>Turns each line into narration via ElevenLabs. Runs alongside Visual.</span></div>
        <div><b>Visual (${agentName("iris", "Iris")})</b><span>Generates an image per segment. Usually the slowest API step.</span></div>
        <div><b>Assembly (${agentName("hephaestus", "Hephaestus")})</b><span>Ken Burns pan/zoom per clip, stitches them, burns in captions.</span></div>
        <div><b>Publish (${agentName("hermes", "Hermes")})</b><span>Uploads to YouTube/TikTok if auto-publish is on.</span></div>
      </div>
      <div class="hint">The log below shows real elapsed time per step, so you can see which stage is actually slow.</div>
    </div>`));
    body.appendChild(el(`<div class="card"><h2>Worker Output <span style="font-weight:400;font-size:11px;opacity:0.7">(raw — shows crashes the progress log can't)</span></h2>
      <div class="pill-row">
        <button class="btn secondary" id="load-worker-log">Load Worker Output</button>
        ${copyBtn("#worker-log-box", "Copy output")}
      </div>
      <div class="log-box" id="worker-log-box" style="margin-top:10px;display:none"></div></div>`));
    const wlBtn = document.getElementById("load-worker-log");
    if (wlBtn) wlBtn.addEventListener("click", async () => {
      const box = document.getElementById("worker-log-box");
      box.style.display = "block"; box.textContent = "Loading…";
      try {
        const r = await API(`/api/jobs/${j.id}/worker-log`);
        box.textContent = r.log || r.note || "(empty)";
      } catch (e) { box.textContent = "Couldn't load the worker output."; }
    });
    body.appendChild(el(`<div class="card"><h2>Progress Log</h2>
      <div class="pill-row" style="margin-bottom:10px">${copyBtn("#progress-log-box", "Copy log")}</div>
      <div class="log-box" id="progress-log-box">${escapeHtml((j.stage_log || "").trim()) || "Queued…"}</div></div>`));
    if (j.script_text) body.appendChild(el(`<div class="card"><h2>Script</h2>
      <div class="pill-row" style="margin-bottom:10px">${copyBtn("#script-text-box", "Copy script")}</div>
      <div id="script-text-box" style="white-space:pre-wrap;font-size:14px;line-height:1.6">${escapeHtml(j.script_text)}</div></div>`));
    if (["published", "failed", "ready_for_review"].includes(j.status) && jobPoll) { clearInterval(jobPoll); jobPoll = null; }
  };
  await draw();
  jobPoll = pollInterval(draw, 8000);
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


/**
 * Draws a shareable 1200x630 "media kit" card from real Mission Control
 * numbers and triggers a PNG download. Meant for Plutus-style sponsor
 * outreach -- a fast, honest snapshot rather than a polished design system;
 * good enough to attach to a cold email.
 */
function generateMediaKit(overview) {
  const canvas = document.createElement("canvas");
  canvas.width = 1200; canvas.height = 630;
  const ctx = canvas.getContext("2d");

  // background
  const bg = ctx.createLinearGradient(0, 0, 1200, 630);
  bg.addColorStop(0, "#01030a"); bg.addColorStop(1, "#0a0f22");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 1200, 630);

  // subtle border glow
  ctx.strokeStyle = "rgba(232,236,239,0.35)"; ctx.lineWidth = 2;
  ctx.strokeRect(20, 20, 1160, 590);

  ctx.fillStyle = "#e8ecef";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText("FACELESS COMMAND CENTER", 60, 90);
  ctx.fillStyle = "#7c8db5";
  ctx.font = "16px sans-serif";
  ctx.fillText("Channel Media Kit — generated " + new Date().toLocaleDateString(), 60, 120);

  const stats = [
    ["Total Subscribers", overview.totals.subscribers.toLocaleString()],
    ["Total Views", overview.totals.views.toLocaleString()],
    ["Videos Published", overview.totals.videos_total.toLocaleString()],
    ["Videos Today", String(overview.totals.videos_today)],
  ];
  stats.forEach(([label, val], i) => {
    const x = 60 + (i % 2) * 560;
    const y = 200 + Math.floor(i / 2) * 140;
    ctx.fillStyle = "#eafcff";
    ctx.font = "bold 48px sans-serif";
    ctx.fillText(val, x, y);
    ctx.fillStyle = "#7c8db5";
    ctx.font = "16px sans-serif";
    ctx.fillText(label.toUpperCase(), x, y + 28);
  });

  ctx.fillStyle = "#b8c0c6";
  ctx.font = "14px sans-serif";
  ctx.fillText("Numbers pulled live from connected YouTube/TikTok accounts.", 60, 590);

  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "media-kit.png";
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

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

        <div class="msc-links-row">
          <a class="msc-link-card" href="https://studio.youtube.com" target="_blank" rel="noopener">
            <span class="msc-link-icon">▶️</span><span>YouTube Studio</span>
          </a>
          <a class="msc-link-card" href="https://www.tiktok.com/tiktokstudio" target="_blank" rel="noopener">
            <span class="msc-link-icon">🎵</span><span>TikTok Studio</span>
          </a>
          <a class="msc-link-card" href="https://elevenlabs.io/app" target="_blank" rel="noopener">
            <span class="msc-link-icon">🗣️</span><span>ElevenLabs</span>
          </a>
          <a class="msc-link-card" href="https://dashboard.render.com" target="_blank" rel="noopener">
            <span class="msc-link-icon">🖥️</span><span>Render Dashboard</span>
          </a>
          <a class="msc-link-card" href="https://github.com/tiktoklivbe-ux/faceless-command-center" target="_blank" rel="noopener">
            <span class="msc-link-icon">🐙</span><span>GitHub Repo</span>
          </a>
          <button class="msc-link-card" id="msc-mediakit-btn" style="cursor:pointer">
            <span class="msc-link-icon">🤝</span><span>Download Media Kit</span>
          </button>
        </div>

        <div class="msc-cols">
          <div class="msc-channels" id="msc-channels"><h2>Channels</h2><div id="msc-ch-list"></div></div>
          <div class="msc-activity">
            <h2>Live Activity Stream</h2>
            <div id="msc-act-list" class="msc-act-list"></div>
          </div>
        </div>

        <div class="msc-tips">
          <h2>Growth &amp; Monetization Ideas</h2>
          <div class="msc-tips-grid">
            <div class="msc-tip"><b>Repurpose across platforms</b><span>Post the same video to YouTube Shorts, TikTok, and Instagram Reels — same asset, 3x the reach.</span></div>
            <div class="msc-tip"><b>Watch your retention graph</b><span>YouTube Studio shows exactly where viewers drop off — tighten the hook if it's in the first 3 seconds.</span></div>
            <div class="msc-tip"><b>Affiliate links in description</b><span>If a Shower Thought references a product/book, a relevant Amazon Associates link costs nothing to add.</span></div>
            <div class="msc-tip"><b>Series &amp; playlists</b><span>Numbered "Part 1/2/3" thoughts drive binge-watching and session time, which the algorithm rewards.</span></div>
            <div class="msc-tip"><b>Community tab polls</b><span>Ask viewers to vote on the next topic — free engagement signal, plus content ideas from your audience.</span></div>
            <div class="msc-tip"><b>TikTok Creator Rewards</b><span>Once eligible, longer-form TikToks (1min+) earn more per view than Shorts-length ones.</span></div>
            <div class="msc-tip"><b>Brand deal outreach</b><span>Once you have real numbers in Mission Control, a simple media kit (screenshot these stats) is enough to pitch small sponsors.</span></div>
            <div class="msc-tip"><b>YouTube Shorts Fund/ad revenue</b><span>Make sure watch-time monetization is actually turned on in YouTube Studio — it's off by default for new channels.</span></div>
          </div>
        </div>

        <div class="msc-uplink" id="msc-uplink"><span class="hdot"></span> <span id="msc-uplink-text">Connecting…</span></div>
      </div>
    </div>`;
  body.querySelectorAll(".msc-nav-item[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => openBigPanel(btn.dataset.nav));
  });
  $("#msc-nav-orbit").addEventListener("click", () => closeBigPanel());

  let lastOverview = null;
  $("#msc-mediakit-btn").addEventListener("click", () => {
    if (!lastOverview) { toast("Stats still loading — try again in a second."); return; }
    generateMediaKit(lastOverview);
  });

  const draw = async () => {
    let overview, act;
    try {
      [overview, act] = await Promise.all([
        API("/api/missioncontrol/overview"),
        API("/api/missioncontrol/activity?limit=30"),
      ]);
    } catch (e) { return; }
    lastOverview = overview;

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
  mcPoll = pollInterval(draw, 20000);
}

// ============================================================ JARVIS
// The CSS for this (.jarvis-*) was fully designed in an earlier pass but
// never had a real panel behind it. This is that panel: real chat with
// Claude, restricted to the tool whitelist in app/jarvis_tools.py, with a
// visible kill switch and a full activity log -- see that file's docstring
// for why the whitelist is an actual safety boundary, not a suggestion.
let jarvisHistory = [];
let jarvisRecognition = null;
let jarvisListening = false;

function jarvisSpeak(text) {
  try {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();  // don't stack replies if one's still talking
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    window.speechSynthesis.speak(u);
  } catch (e) { /* speech synthesis just isn't available -- fine, text still shows */ }
}

function jarvisSetOrbState(state) {
  // state: "idle" | "listening" | "thinking" | "speaking"
  const eq = document.getElementById("jarvis-eq");
  const dot = document.getElementById("jarvis-orb-ring");
  if (eq) eq.classList.toggle("jarvis-eq-active", state === "listening" || state === "speaking");
  if (dot) dot.setAttribute("stroke", state === "listening" ? "#ff6b6b" : state === "thinking" ? "#ffc46b" : "var(--cyan)");
}

function jarvisAppendMsg(role, text) {
  const log = document.getElementById("jarvis-log");
  if (!log) return;
  const div = el(`<div class="jarvis-msg jarvis-${role}"></div>`);
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function jarvisSend(message) {
  if (!message || !message.trim()) return;
  jarvisAppendMsg("user", message);
  const caption = document.getElementById("jarvis-caption");
  if (caption) caption.textContent = "…";
  jarvisSetOrbState("thinking");
  const thinking = el(`<div class="jarvis-msg jarvis-assistant jarvis-thinking">thinking…</div>`);
  const log = document.getElementById("jarvis-log");
  if (log) { log.appendChild(thinking); log.scrollTop = log.scrollHeight; }

  try {
    const r = await API("/api/jarvis/chat", {
      method: "POST",
      body: JSON.stringify({ message, history: jarvisHistory }),
    });
    thinking.remove();
    jarvisHistory = r.history || jarvisHistory;
    jarvisAppendMsg("assistant", r.reply);
    if (caption) caption.textContent = r.reply.slice(0, 90);
    if (r.actions && r.actions.length) {
      toast(`Jarvis: ${r.actions.map((a) => a.tool).join(", ")}`);
    }
    jarvisSetOrbState("speaking");
    jarvisSpeak(r.reply);
    setTimeout(() => jarvisSetOrbState("idle"), 1200);
  } catch (e) {
    thinking.remove();
    const msg = "Couldn't reach Jarvis: " + e.message;
    jarvisAppendMsg("assistant", msg);
    if (caption) caption.textContent = msg;
    jarvisSetOrbState("idle");
  }
}

function jarvisStartListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const caption = document.getElementById("jarvis-caption");
  if (!SR) {
    if (caption) caption.textContent = "Voice input isn't supported in this browser -- type instead.";
    return;
  }
  if (jarvisListening) return;
  jarvisListening = true;
  jarvisSetOrbState("listening");
  if (caption) caption.textContent = "Listening…";

  jarvisRecognition = new SR();
  jarvisRecognition.continuous = true;
  jarvisRecognition.interimResults = true;
  jarvisRecognition.lang = "en-US";
  let finalTranscript = "";
  jarvisRecognition.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) finalTranscript += t + " ";
      else interim += t;
    }
    if (caption) caption.textContent = (finalTranscript + interim) || "Listening…";
  };
  jarvisRecognition.onerror = () => {};
  jarvisRecognition.onend = () => {
    jarvisListening = false;
    jarvisSetOrbState("idle");
    const said = finalTranscript.trim();
    if (said) jarvisSend(said);
    else if (caption) caption.textContent = "Press and hold Enter to talk, or type below.";
  };
  jarvisRecognition.start();
}

function jarvisStopListening() {
  if (jarvisRecognition && jarvisListening) jarvisRecognition.stop();
}

async function jarvisRefreshReadout() {
  try {
    const [jobs, channels] = await Promise.all([API("/api/jobs?limit=20"), API("/api/channels")]);
    const running = jobs.filter((j) => !["published", "ready_for_review", "failed", "queued"].includes(String(j.status))).length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    const autoOn = channels.filter((c) => c.auto_enabled).length;
    const readout = document.getElementById("jarvis-readout");
    if (readout) readout.innerHTML = `
      <div><span>Rendering now</span><span>${running}</span></div>
      <div><span>Failed recently</span><span>${failed}</span></div>
      <div><span>Channels automated</span><span>${autoOn}/${channels.length}</span></div>
    `;
  } catch (e) { /* readout is a nice-to-have, not worth erroring over */ }
}

async function jarvisLoadActivity() {
  const panel = document.getElementById("jarvis-tabpanel");
  if (!panel) return;
  panel.innerHTML = `<div class="hint">Loading…</div>`;
  try {
    const rows = await API("/api/jarvis/log?limit=50");
    panel.innerHTML = rows.length ? "" : `<div class="hint">Nothing logged yet.</div>`;
    rows.forEach((row) => {
      const ok = row.allowed;
      const div = el(`<div class="jarvis-msg" style="border-left-color:${ok ? "var(--green)" : "var(--red)"}">
        <div style="font-family:var(--font-mono);font-size:10px;color:var(--muted)">${timeAgo(row.created_at)} · ${escapeHtml(row.source)}</div>
        <div><b>${escapeHtml(row.action)}</b> ${ok ? "" : "— blocked"}</div>
      </div>`);
      panel.appendChild(div);
    });
  } catch (e) {
    panel.innerHTML = `<div class="hint">Couldn't load the activity log.</div>`;
  }
}

// ---------------------------------------------------------------- dragging
// Core drag primitives, deliberately separate from *how* a drag is
// initiated -- both a real mouse drag on the header and a pinch gesture
// from the webcam (further down) feed into these same three functions, so
// the panel doesn't care which one is moving it.
let jarvisDragPanel = null;
let jarvisDragOffset = { x: 0, y: 0 };

function jarvisDragStart(panelEl, clientX, clientY) {
  jarvisDragPanel = panelEl;
  const r = panelEl.getBoundingClientRect();
  // Switch from the centered transform:translate(-50%,-50%) starting
  // position to explicit top/left in pixels -- can't drag a centering
  // transform incrementally, but a fixed pixel position moves cleanly.
  panelEl.style.transform = "none";
  panelEl.style.top = r.top + "px";
  panelEl.style.left = r.left + "px";
  jarvisDragOffset = { x: clientX - r.left, y: clientY - r.top };
  panelEl.classList.add("jarvis-dragging");
}

function jarvisDragMove(clientX, clientY) {
  if (!jarvisDragPanel) return;
  const r = jarvisDragPanel.getBoundingClientRect();
  const margin = 8;
  let left = clientX - jarvisDragOffset.x;
  let top = clientY - jarvisDragOffset.y;
  left = Math.max(margin, Math.min(window.innerWidth - r.width - margin, left));
  top = Math.max(margin, Math.min(window.innerHeight - r.height - margin, top));
  jarvisDragPanel.style.left = left + "px";
  jarvisDragPanel.style.top = top + "px";
}

function jarvisDragEnd() {
  if (!jarvisDragPanel) return;
  jarvisDragPanel.classList.remove("jarvis-dragging");
  try {
    localStorage.setItem("jarvisPanelPos", JSON.stringify({
      top: jarvisDragPanel.style.top, left: jarvisDragPanel.style.left,
    }));
  } catch (e) { /* localStorage unavailable -- position just won't persist, fine */ }
  jarvisDragPanel = null;
}

/** Returns a cleanup function -- the panel is torn down and rebuilt fresh
 *  every time Jarvis reopens, so leaving these window-level listeners
 *  attached would stack a new set on every visit (the same class of bug
 *  the push-to-talk Enter-key listeners had earlier in this file). */
function jarvisMakeDraggable(panelEl, handleEl) {
  try {
    const saved = JSON.parse(localStorage.getItem("jarvisPanelPos") || "null");
    if (saved && saved.top && saved.left) {
      panelEl.style.transform = "none";
      panelEl.style.top = saved.top;
      panelEl.style.left = saved.left;
    }
  } catch (e) { /* ignore a corrupt/missing saved position */ }

  const onDown = (e) => {
    if (e.target.closest(".bp-close")) return;  // don't fight the close button
    jarvisDragStart(panelEl, e.clientX, e.clientY);
    e.preventDefault();
  };
  const onMove = (e) => { if (jarvisDragPanel) jarvisDragMove(e.clientX, e.clientY); };
  const onUp = () => { if (jarvisDragPanel) jarvisDragEnd(); };

  handleEl.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  return () => {
    handleEl.removeEventListener("mousedown", onDown);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
}

// ---------------------------------------------------------------- gesture control
// Pinch (thumb tip + index fingertip touching) over the panel's header to
// grab it, move your hand to drag, release the pinch to drop -- feeds the
// exact same jarvisDragStart/Move/End used by mouse dragging above, so
// there's exactly one place that owns "what dragging a panel means".
let jarvisHandLandmarker = null;   // MediaPipe model, loaded once and reused
let jarvisCameraStream = null;
let jarvisGestureRAF = null;
const PINCH_THRESHOLD = 0.055;     // normalized distance; tuned loose since a
                                    // false "no pinch" is just an ignored frame,
                                    // not a real cost, so err toward detecting it

/** Pure logic, deliberately separate from the camera/model: given one
 *  frame's hand landmarks (MediaPipe's 21-point hand format) and the panel
 *  being controlled, decides whether a pinch is happening and drives the
 *  shared drag primitives accordingly. Callable directly with synthetic
 *  landmarks for testing, with no camera or model involved at all. */
function jarvisProcessHandLandmarks(panelEl, landmarks, state) {
  if (!landmarks || !landmarks.length) {
    if (state.pinching) { jarvisDragEnd(); state.pinching = false; }
    return null;
  }
  const thumb = landmarks[4], index = landmarks[8];
  const dist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
  const pinching = dist < PINCH_THRESHOLD;

  // Mirrored horizontally -- a front-facing camera feels backwards
  // otherwise (move your hand right, panel goes left).
  const midX = (thumb.x + index.x) / 2, midY = (thumb.y + index.y) / 2;
  const screenX = (1 - midX) * window.innerWidth;
  const screenY = midY * window.innerHeight;

  if (pinching && !state.pinching) {
    const header = panelEl.querySelector(".jarvis-header");
    const hr = header.getBoundingClientRect();
    const overHeader = screenX >= hr.left && screenX <= hr.right && screenY >= hr.top && screenY <= hr.bottom;
    if (overHeader) { jarvisDragStart(panelEl, screenX, screenY); state.pinching = true; }
  } else if (pinching && state.pinching) {
    jarvisDragMove(screenX, screenY);
  } else if (!pinching && state.pinching) {
    jarvisDragEnd();
    state.pinching = false;
  }
  return { screenX, screenY, pinching };
}

async function jarvisLoadHandModel() {
  if (jarvisHandLandmarker) return jarvisHandLandmarker;
  const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs");
  const resolver = await vision.FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  jarvisHandLandmarker = await vision.HandLandmarker.createFromOptions(resolver, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    },
    runningMode: "VIDEO",
    numHands: 1,
  });
  return jarvisHandLandmarker;
}

function jarvisSetupGestureControl(panelEl) {
  const state = { pinching: false, running: false };
  let videoEl = null;

  const toggle = document.getElementById("jarvis-gesture-toggle");
  const previewWrap = document.getElementById("jarvis-cam-preview");

  const stop = () => {
    state.running = false;
    if (jarvisGestureRAF) cancelAnimationFrame(jarvisGestureRAF);
    jarvisGestureRAF = null;
    if (jarvisCameraStream) { jarvisCameraStream.getTracks().forEach((t) => t.stop()); jarvisCameraStream = null; }
    if (previewWrap) previewWrap.style.display = "none";
    if (toggle) { toggle.textContent = "📷 Gesture Control: Off"; toggle.classList.remove("copied"); }
  };

  const start = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("This browser doesn't support camera access.");
      return;
    }
    try {
      jarvisCameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 240, height: 180 } });
    } catch (e) {
      toast("Camera permission denied or unavailable.");
      return;
    }
    videoEl = document.getElementById("jarvis-cam-video");
    if (!videoEl) return;
    videoEl.srcObject = jarvisCameraStream;
    await videoEl.play();
    if (previewWrap) previewWrap.style.display = "block";
    if (toggle) { toggle.textContent = "📷 Gesture Control: On"; toggle.classList.add("copied"); }

    let model;
    try {
      model = await jarvisLoadHandModel();
    } catch (e) {
      toast("Couldn't load hand-tracking -- check your connection.");
      stop();
      return;
    }

    state.running = true;
    const loop = () => {
      if (!state.running) return;
      try {
        const result = model.detectForVideo(videoEl, performance.now());
        const landmarks = result.landmarks && result.landmarks[0];
        jarvisProcessHandLandmarks(panelEl, landmarks, state);
      } catch (e) { /* a single bad frame isn't worth stopping the whole feature over */ }
      jarvisGestureRAF = requestAnimationFrame(loop);
    };
    loop();
  };

  if (toggle) {
    toggle.addEventListener("click", () => { state.running ? stop() : start(); });
  }

  return stop;
}

async function renderJarvisPanel(body) {
  jarvisHistory = [];
  body.innerHTML = `<div class="jarvis-page">
    <div class="jarvis-header">
      <div class="jarvis-header-title">JARVIS <span style="opacity:.5;font-size:12px;text-transform:none;letter-spacing:0">— AETHER's assistant</span></div>
      <div class="jarvis-header-status" id="jarvis-kill-toggle" title="Click to switch Jarvis on/off" style="cursor:pointer">
        <span class="jarvis-status-dot" id="jarvis-status-dot"></span>
        <span id="jarvis-status-text">checking…</span>
      </div>
    </div>
    <div class="jarvis-body">
      <div class="jarvis-left">
        <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:1.5px;color:var(--muted);margin-bottom:10px;text-transform:uppercase">Status</div>
        <div class="jarvis-readout" id="jarvis-readout"><div><span>Loading…</span><span></span></div></div>
        <div class="hint" style="margin-top:20px">Jarvis can only manage jobs, channels, and automation in this app -- nothing else. Every action it takes is logged in the Activity tab.</div>
        <button class="copy-btn" id="jarvis-gesture-toggle" style="margin-top:16px;width:100%">📷 Gesture Control: Off</button>
        <div class="hint" style="margin-top:6px">Pinch (thumb + index finger) over this header, then move your hand to drag the panel. Camera feed never leaves your browser.</div>
        <div id="jarvis-cam-preview" style="display:none;margin-top:12px;border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <video id="jarvis-cam-video" width="240" height="180" muted playsinline style="display:block;width:100%;transform:scaleX(-1)"></video>
        </div>
      </div>
      <div class="jarvis-center">
        <svg id="jarvis-orb" width="120" height="120" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r="46" fill="rgba(232,236,239,0.05)" id="jarvis-orb-ring" stroke="var(--cyan)" stroke-width="2"/>
          <circle cx="60" cy="60" r="30" fill="rgba(232,236,239,0.10)"/>
          <circle cx="60" cy="60" r="6" fill="var(--cyan)"/>
        </svg>
        <div class="jarvis-eq" id="jarvis-eq">${Array.from({ length: 7 }).map(() => `<div class="jarvis-eq-bar"></div>`).join("")}</div>
        <div class="jarvis-sysline" id="jarvis-caption">Press and hold Enter to talk, or type below.</div>
        <div class="jarvis-controls-row">
          <input type="text" id="jarvis-text-input" placeholder="Type a command…" style="flex:1"/>
          <button class="icon-btn" id="jarvis-send" title="Send">➤</button>
        </div>
      </div>
      <div class="jarvis-right">
        <div class="jarvis-tabs">
          <button class="jarvis-tab active" data-tab="chat">Transcript</button>
          <button class="jarvis-tab" data-tab="activity">Activity Log</button>
        </div>
        <div class="jarvis-tabpanel" id="jarvis-tabpanel">
          <div class="jarvis-log" id="jarvis-log"></div>
        </div>
      </div>
    </div>
  </div>`;

  // Kill switch
  const refreshKillState = async () => {
    const { enabled } = await API("/api/jarvis/enabled");
    const dot = document.getElementById("jarvis-status-dot");
    const text = document.getElementById("jarvis-status-text");
    if (dot) dot.style.background = enabled ? "var(--green)" : "var(--red)";
    if (dot) dot.style.boxShadow = enabled ? "0 0 10px var(--green)" : "0 0 10px var(--red)";
    if (text) text.textContent = enabled ? "Online" : "Disabled";
    return enabled;
  };
  await refreshKillState();
  document.getElementById("jarvis-kill-toggle").addEventListener("click", async () => {
    const { enabled } = await API("/api/jarvis/enabled");
    await API("/api/jarvis/enabled", { method: "POST", body: JSON.stringify({ enabled: !enabled }) });
    await refreshKillState();
    toast(enabled ? "Jarvis switched off." : "Jarvis switched back on.");
  });

  jarvisRefreshReadout();

  // Tabs
  document.querySelectorAll(".jarvis-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".jarvis-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const panel = document.getElementById("jarvis-tabpanel");
      if (tab.dataset.tab === "chat") {
        panel.innerHTML = "";
        const logDiv = el(`<div class="jarvis-log" id="jarvis-log"></div>`);
        panel.appendChild(logDiv);
      } else {
        jarvisLoadActivity();
      }
    });
  });

  // Typed input
  const input = document.getElementById("jarvis-text-input");
  document.getElementById("jarvis-send").addEventListener("click", () => {
    if (input.value.trim()) { jarvisSend(input.value.trim()); input.value = ""; }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (input.value.trim()) { jarvisSend(input.value.trim()); input.value = ""; }
    }
  });

  // Push-to-talk: hold Enter anywhere in the panel EXCEPT while typing in the
  // text box (where Enter already means "send what I typed").
  const onKeyDown = (e) => {
    if (e.key !== "Enter" || e.repeat) return;
    if (document.activeElement === input) return;
    e.preventDefault();
    jarvisStartListening();
  };
  const onKeyUp = (e) => {
    if (e.key !== "Enter") return;
    jarvisStopListening();
  };
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);

  const cleanupDrag = jarvisMakeDraggable(document.getElementById("bigpanel-inner"), document.querySelector(".jarvis-header"));
  const cleanupGestures = jarvisSetupGestureControl(document.getElementById("bigpanel-inner"));

  // Cleaned up whenever the panel closes/changes -- stopAllPanelPolls runs on
  // every panel switch, so hooking removal there keeps this from piling up
  // as a second, third, fourth global listener (or camera stream!) every
  // time Jarvis reopens.
  const _origStop = stopAllPanelPolls;
  window.stopAllPanelPolls = function () {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("keyup", onKeyUp);
    window.speechSynthesis && window.speechSynthesis.cancel();
    cleanupDrag();
    cleanupGestures();
    window.stopAllPanelPolls = _origStop;
    _origStop();
  };

  jarvisAppendMsg("assistant", "Online. Ask me how a channel's doing, or tell me to retry something.");
}

async function renderSettingsPanel(body) {
  const s = await API("/api/settings");
  const field = (k, label, ph, type = "password") =>
    `<label>${label}${s[k] && s[k].set ? ` — set (${s[k].value})` : ""}</label>
     <input type="${type}" id="st-${k}" placeholder="${s[k] && s[k].set ? "leave blank to keep" : ph}"/>`;
  // Storage health banners. These belong here, next to the key fields they
  // describe -- a key that's stored but unreadable behaves exactly like one
  // that was never entered, which is impossible to diagnose without being
  // told explicitly.
  const h = s._health || {};
  const healthBanner = (h.unreadable_keys && h.unreadable_keys.length)
    ? `<div class="card" style="border-color:rgba(209,106,106,0.4)">
         <h2 style="color:var(--red)">⚠ Saved keys can't be read</h2>
         <div class="hint">These are stored but unreadable, so the app behaves as if they were never entered:
         <b>${h.unreadable_keys.join(", ")}</b>. This happens when the encryption key changes.
         <br><br><b>Permanent fix:</b> set them as environment variables in Render
         (ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, etc). Env vars can't be lost this way and always win.</div>
       </div>`
    : "";
  const envBanner = (h.keys_from_env && h.keys_from_env.length)
    ? `<div class="card"><h2>✅ Keys from environment</h2>
         <div class="hint">Supplied by environment variables, so they can't be lost: <b>${h.keys_from_env.join(", ")}</b>.
         Editing them below has no effect while the env var is set.</div></div>`
    : "";
  const persistWarn = (h.persist_dir_set === false || h.secret_key_set === false)
    ? `<div class="card" style="border-color:rgba(209,106,106,0.3)"><h2>Storage isn't fully durable</h2>
         <div class="hint">${h.persist_dir_set === false ? "PERSIST_DIR isn't set — data may live on disposable storage. " : ""}
         ${h.secret_key_set === false ? "SECRET_KEY isn't set — saved keys become unreadable if the disk changes. " : ""}
         Set these in Render → Environment.</div></div>`
    : "";

  body.innerHTML = `<h1>Control Panel</h1><div class="bp-sub">API keys are encrypted at rest and never shown in full.</div>` + healthBanner + envBanner + persistWarn + `
    <div class="card"><h2>Script Writer</h2>
      <label>Provider</label>
      <select id="st-llm_provider">
        <option value="anthropic" ${s.llm_provider.value === "anthropic" ? "selected" : ""}>Anthropic (Claude)</option>
        <option value="gemini" ${s.llm_provider.value === "gemini" ? "selected" : ""}>Gemini</option>
        <option value="openai" ${s.llm_provider.value === "openai" ? "selected" : ""}>OpenAI</option>
      </select>
      ${field("anthropic_api_key", "Anthropic (Claude) key", "sk-ant-…")}
      <label>Claude model</label>
      <select id="st-anthropic_model">
        <option value="claude-sonnet-5" ${(!(s.anthropic_model?.value) || s.anthropic_model.value === "claude-sonnet-5") ? "selected" : ""}>Sonnet 5 — recommended balance of quality/cost</option>
        <option value="claude-haiku-4-5-20251001" ${s.anthropic_model?.value === "claude-haiku-4-5-20251001" ? "selected" : ""}>Haiku 4.5 — fastest, cheapest</option>
        <option value="claude-opus-4-8" ${s.anthropic_model?.value === "claude-opus-4-8" ? "selected" : ""}>Opus 4.8 — most capable, slower/pricier</option>
      </select>
      <div class="hint">Used by ${agentName("athena", "Athena")} for script generation. Haiku is cheapest; Sonnet gives better scripts.</div>
      ${field("gemini_api_key", "Gemini key", "AIza…")}
      ${field("openai_api_key", "OpenAI key", "sk-…")}
      <div class="hint">No key yet? ${agentName("athena", "Athena")} falls back to a placeholder script so the whole pipeline still runs.</div>
    </div>
    <div class="card"><h2>Voice — ElevenLabs</h2>${field("elevenlabs_api_key", "ElevenLabs key", "")}
      <div class="hint">No key? ${agentName("orpheus", "Orpheus")} renders timed silence so you can still test assembly + captions.</div></div>
    <div class="card"><h2>App Lock</h2>
      <div class="hint" id="lock-state">Checking…</div>
      <label>Password</label>
      <input type="password" id="st-lockpass" placeholder="set a password"/>
      <label>Auto-lock after (minutes idle)</label>
      <input type="number" id="st-lockidle" value="15" min="1" max="240"/>
      <div style="display:flex; gap:8px; margin-top:10px">
        <button class="btn" id="lock-enable">Enable Lock</button>
        <button class="btn secondary" id="lock-disable">Turn Off</button>
        <button class="btn secondary" id="lock-now">Lock Now</button>
      </div>
      <div class="hint" id="lock-msg" style="margin-top:8px"></div>
      <div class="hint" style="margin-top:8px">Stored as a salted hash, never in plain text. This keeps someone who walks up to your screen out — it isn't protection against someone with full access to the computer.</div>
    </div>
    <div class="card"><h2>Render Speed</h2>
      <label>Fast render mode</label>
      <select id="st-fast_render">
        <option value="false" ${(s.fast_render && s.fast_render.value) !== "true" ? "selected" : ""}>Off — Ken Burns pan/zoom (looks better)</option>
        <option value="true" ${(s.fast_render && s.fast_render.value) === "true" ? "selected" : ""}>On — static images, much faster</option>
      </select>
      <div class="hint">The pan/zoom effect is the most CPU-heavy part of rendering. Turn this on if videos are taking too long on your server.</div>
    </div>
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
    <div class="card"><h2>Jarvis — WhatsApp</h2>
      ${field("twilio_account_sid", "Twilio Account SID", "AC…", "text")}
      ${field("twilio_auth_token", "Twilio Auth Token", "")}
      ${field("twilio_whatsapp_number", "Twilio WhatsApp number", "whatsapp:+1415…", "text")}
      ${field("jarvis_phone_allowlist", "Your phone number(s)", "+15551234567", "text")}
      <div class="hint">Comma-separate multiple numbers. Only messages from these numbers, with a verified
      Twilio signature, ever reach Jarvis — everything else is silently ignored.
      Webhook URL for Twilio's WhatsApp sandbox/number: <code>${location.origin}/api/jarvis/whatsapp</code></div>
    </div>
    <button class="btn" id="st-save">Save Settings</button>`;

  // ---- app lock wiring ----
  (async () => {
    const st = document.getElementById("lock-state");
    const msg = document.getElementById("lock-msg");
    if (!st) return;
    const refresh = async () => {
      try {
        const d = await API("/api/lock/status");
        const idleEl = document.getElementById("st-lockidle");
        if (idleEl) idleEl.value = d.idle_minutes || 15;
        st.textContent = d.enabled
          ? `Lock is ON — auto-locks after ${d.idle_minutes} minutes idle.`
          : "Lock is OFF — anyone who opens this app can use it.";
      } catch (e) { st.textContent = "Couldn't check lock status."; }
    };
    await refresh();

    document.getElementById("lock-enable").addEventListener("click", async () => {
      const pw = document.getElementById("st-lockpass").value;
      const mins = parseInt(document.getElementById("st-lockidle").value, 10) || 15;
      if (!pw || pw.length < 4) { msg.textContent = "Password must be at least 4 characters."; return; }
      try {
        await API("/api/lock/setup", { method: "POST", body: JSON.stringify({ password: pw, idle_minutes: mins }) });
        document.getElementById("st-lockpass").value = "";
        msg.textContent = "Lock enabled.";
        if (window.AppLock) AppLock.setIdleMinutes(mins);
        await refresh();
      } catch (e) { msg.textContent = "Couldn't enable the lock."; }
    });

    document.getElementById("lock-disable").addEventListener("click", async () => {
      const pw = document.getElementById("st-lockpass").value;
      if (!pw) { msg.textContent = "Enter your current password to turn the lock off."; return; }
      try {
        await API("/api/lock/disable", { method: "POST", body: JSON.stringify({ password: pw }) });
        document.getElementById("st-lockpass").value = "";
        msg.textContent = "Lock turned off.";
        await refresh();
      } catch (e) { msg.textContent = "Wrong password."; }
    });

    document.getElementById("lock-now").addEventListener("click", () => {
      if (window.AppLock) AppLock.lockNow();
    });
  })();

  $("#st-save").addEventListener("click", async () => {
    const keys = ["llm_provider", "anthropic_api_key", "anthropic_model", "gemini_api_key", "openai_api_key", "elevenlabs_api_key",
      "fast_render", "fast_render", "image_provider", "stability_api_key", "youtube_client_id", "youtube_client_secret", "tiktok_client_key", "tiktok_client_secret",
      "twilio_account_sid", "twilio_auth_token", "twilio_whatsapp_number", "jarvis_phone_allowlist"];
    const payload = {};
    keys.forEach((k) => { const e = $("#st-" + k); if (e && e.value) payload[k] = e.value; });
    await API("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    toast("Settings saved."); renderSettingsPanel(body);
  });
}

// ============================================================ REFRESH ORCHESTRATION
function refreshAll() { refreshAgents(); }

// ============================================================ BOOT
function runBoot() {
  const lines = [
    "initializing AETHER core .............. <span class='ok'>online</span>",
    "waking agent constellation ............ <span class='ok'>21 agents</span>",
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

// ============================================================ ACTIVE JOB BANNER
/**
 * A persistent, unmissable banner across the top whenever a video is being
 * made. Previously starting a job only produced a toast that vanished in a
 * few seconds and an addActivity() call that goes nowhere now the old panel
 * is gone -- so it genuinely looked like nothing had happened.
 */
function renderJobBanner(job) {
  let el = document.getElementById("job-banner");
  if (!job) {
    if (el) el.classList.remove("show");
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "job-banner";
    document.body.appendChild(el);
  }

  const status = String(job.status || "");
  const log = (job.stage_log || "").trim().split("\n");
  let last = log[log.length - 1] || "";
  if (last.startsWith("[")) last = last.slice(last.indexOf("]") + 1).trim();

  const m = /Segment (\d+)\/(\d+)/.exec(job.stage_log || "");
  const pct = m ? Math.round((parseInt(m[1], 10) / parseInt(m[2], 10)) * 100) : 6;

  el.innerHTML = `
    <div class="jb-pulse"></div>
    <div class="jb-body">
      <div class="jb-title">Making a video · ${job.title || job.topic || "untitled"}</div>
      <div class="jb-step">${last || "starting up…"}</div>
      <div class="jb-bar"><div class="jb-fill" style="width:${pct}%"></div></div>
    </div>
    <button class="jb-open">Open</button>
  `;
  el.querySelector(".jb-open").addEventListener("click", () => {
    openBigPanel("jobs");
  });
  el.classList.add("show");
}

async function pollActiveJob() {
  try {
    const jobs = await API("/api/jobs?limit=10");
    const active = jobs.find((j) =>
      !["published", "ready_for_review", "failed"].includes(String(j.status)));
    renderJobBanner(active || null);
  } catch (e) { /* leave the banner as-is on a transient failure */ }
}

// ============================================================ VILLAGE HOME
function mountVillageHome() {
  const stage = document.getElementById("village-stage");
  if (!stage || !window.VillageView) return;
  VillageView.mount(stage);
}

/** Feed live agent state to the village. Called by the same poll that used to
 *  drive the constellation, so there's still exactly one source of truth. */
function updateVillage(agentList) {
  if (window.VillageView && agentList) VillageView.update(agentList);
}

// ============================================================ INIT
async function init() {
  // The village is the home view. The starfield, orbit camera and
  // constellation renderer are gone entirely -- keeping them would mean a
  // second full-screen animation loop running behind an opaque village for
  // no benefit, which is exactly what made the old app lag.
  initConsole();
  initClock();
  mountVillageHome();
  pollActiveJob();
  bannerPoll = pollInterval(pollActiveJob, 5000);
  const skip = $("#boot-skip");
  if (skip) skip.addEventListener("click", endBoot);

  // toolbar buttons
  // Navigation is the left sidebar only -- the duplicate right-hand toolbar
  // was removed since every button led to the same place as a sidebar item.

  // left sidebar -- same destinations as the toolbar icons, just labeled.
  // "Orbit" is the one that closes any open panel and returns to the
  // starfield/constellation view rather than opening a panel.
  Object.entries(SIDE_MAP).forEach(([id, panel]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", () => { openBigPanel(panel); setActiveSideItem(panel); });
  });
  $("#side-orbit").addEventListener("click", () => { closeBigPanel(); });
  setActiveSideItem(null);
  $("#bigpanel").addEventListener("click", (e) => { if (e.target.id === "bigpanel") closeBigPanel(); });

  // Deliberately NOT awaited. The boot animation used to wait for this
  // network round-trip to finish before it even started playing -- on
  // localhost that request is sub-millisecond so it was never noticed, but
  // over a real network (Render, or anyone not on localhost) it meant the
  // screen just sat there doing nothing for however long that request took,
  // which read exactly as "the app is laggy on load". The boot sequence now
  // always starts immediately; agent data fills in whenever it arrives,
  // same as any of the later 15s polls.
  refreshAgents();

  runBoot();

  // live loops
  pollInterval(refreshAgents, 15000);
}

window.runCommand = runCommand;
// Exposed so village.js can open an agent's detail when its building is clicked.
window.openAgent = openAgent;
document.addEventListener("DOMContentLoaded", init);
