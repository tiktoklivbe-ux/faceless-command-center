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
// ============================================================ SCENE NAVIGATION
// The 3D village and the slide-in overlay panels are both gone -- replaced by
// one continuous scroll track of full-viewport "scenes" (see index.html),
// snapped with native CSS scroll-snap so the glide between them is smooth
// without any hand-rolled scroll physics. openBigPanel/closeBigPanel keep
// their EXACT original names and signature deliberately: every existing
// caller (Jarvis's nav tool, gesture actions, the teach-a-task recorder, the
// quick-access panel, the job banner's "Open" button) already calls these,
// so the whole rest of the app didn't need to change to get the new shell --
// only what happens INSIDE these two functions did.
let jarvisCurrentScene = "overview";
const SCENE_NAMES = ["overview", "missioncontrol", "jobs", "channels", "settings", "jarvis"];
const SCENE_RENDERERS = {
  overview: (body) => renderOverviewScene(body),
  missioncontrol: (body) => renderMissionControlPanel(body),
  jobs: (body) => renderJobsPanel(body),
  channels: (body) => renderChannelsPanel(body),
  settings: (body) => renderSettingsPanel(body),
  jarvis: (body) => renderJarvisPanel(body),
};
let _jarvisSceneObserver = null;
let _jarvisSceneNavGuard = false;  // true while a programmatic scroll is in flight, so the observer doesn't double-activate mid-glide

function stopAllPanelPolls() {
  if (jobPoll) { clearInterval(jobPoll); jobPoll = null; }
  if (mcPoll) { clearInterval(mcPoll); mcPoll = null; }
}

/** The one place a scene actually becomes "live": tears down whatever the
 *  previous scene had running, then (re)renders this one fresh into its own
 *  persistent body -- same full-refresh-on-visit behavior the old overlay
 *  panels had, so job statuses etc. are never stale when you arrive. Shared
 *  by both navigation paths (a real scroll gesture via the IntersectionObserver,
 *  and a programmatic jump via openBigPanel) so there's exactly one code path
 *  that owns "what does entering a scene actually do". */
function _jarvisActivateScene(which) {
  if (which === jarvisCurrentScene) return;
  jarvisCurrentScene = which;
  stopAllPanelPolls();
  setActiveSideItem(which === "overview" ? null : which);
  const body = document.getElementById(`scene-body-${which}`);
  const fn = SCENE_RENDERERS[which];
  if (body && fn) fn(body);
}

function _jarvisSetupSceneObserver() {
  const track = document.getElementById("scene-track");
  if (!track) return;
  _jarvisSceneObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const el = entry.target;
      el.classList.toggle("in-view", entry.isIntersecting);
      // The most-visible scene crossing the midpoint is "arrived" -- ignore
      // events while a programmatic jump's own smooth-scroll is still
      // settling, so a fast jump doesn't also fire for every scene it glides past.
      if (entry.isIntersecting && entry.intersectionRatio > 0.55 && !_jarvisSceneNavGuard) {
        _jarvisActivateScene(el.dataset.scene);
      }
    });
  }, { root: track, threshold: [0, 0.55, 1] });
  document.querySelectorAll(".scene").forEach((el) => _jarvisSceneObserver.observe(el));
}

async function openBigPanel(which) {
  // If a "teach a task" recording is in progress, capture the navigation as a
  // step -- whether it came from a nav button, the side menu, or a gesture,
  // it all funnels through here, so this is the one place that sees them all.
  jarvisRecordStep({ type: "nav", which });
  const el = document.getElementById(`scene-${which}`);
  if (!el) return;
  _jarvisSceneNavGuard = true;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  _jarvisActivateScene(which);
  // scrollIntoView's smooth glide takes a moment; release the guard once it's
  // reasonably settled so a normal scroll-wheel nudge right after still works.
  clearTimeout(window._jarvisSceneNavGuardTimer);
  window._jarvisSceneNavGuardTimer = setTimeout(() => { _jarvisSceneNavGuard = false; }, 700);
}

const SIDE_MAP = {
  "side-missioncontrol": "missioncontrol",
  "side-jobs": "jobs",
  "side-channels": "channels",
  "side-settings": "settings",
  "side-jarvis": "jarvis",
};
function setActiveSideItem(panelName) {
  document.querySelectorAll("#dot-nav .dot").forEach((el) => el.classList.remove("active"));
  const id = panelName || "overview";
  const el = document.querySelector(`#dot-nav .dot[data-jump="${id}"]`);
  if (el) el.classList.add("active");
}
window.closeBigPanel = () => {
  jarvisRecordStep({ type: "nav", which: "orbit" });  // "go home" is a task step too
  openBigPanel("overview");
};

// ============================================================ OVERVIEW SCENE
// The new home -- replaces the 3D village. A real summary (live totals, a
// quick-jump card per section, recent activity), not a decorative landing
// screen, so arriving here is actually useful rather than just pretty.
const OVERVIEW_CARDS = [
  { key: "missioncontrol", icon: "🛰️", title: "Mission Control", blurb: "Live agent status, channel health, the uplink." },
  { key: "jobs", icon: "🎬", title: "Videos", blurb: "Every render -- in progress, published, or failed." },
  { key: "channels", icon: "📺", title: "Channels", blurb: "Niches, automation, and platform connections." },
  { key: "settings", icon: "⚙️", title: "Settings", blurb: "API keys, schedule, and the control panel." },
  { key: "jarvis", icon: "🎙️", title: "Jarvis", blurb: "Talk to it, watch it work, hand it a task." },
];

async function renderOverviewScene(body) {
  body.innerHTML = `<div class="ov-wrap"><div class="ov-loading">Loading overview…</div></div>`;
  let data = { channels: [], totals: {}, uplink: "…" };
  let activity = [];
  try {
    [data, activity] = await Promise.all([
      API("/api/missioncontrol/overview"),
      API("/api/missioncontrol/activity?limit=8").catch(() => []),
    ]);
  } catch (e) { /* show whatever we got -- an empty overview beats a crash */ }

  const t = data.totals || {};
  // Feed the topbar's own stat cluster from the same call -- these elements
  // existed in the markup before this rewrite but nothing was ever wiring
  // them (a pre-existing gap, not something this change introduced).
  const setStat = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setStat("stat-videos", t.videos_total ?? 0);
  setStat("stat-published", t.videos_total ?? 0);
  setStat("stat-today", t.videos_today ?? 0);
  setStat("stat-progress", t.agents_live ?? 0);

  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Still up" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  body.innerHTML = `
    <div class="ov-wrap">
      <div class="ov-head">
        <div class="ov-greeting">${greeting}.</div>
        <div class="ov-uplink ${String(data.uplink).toLowerCase()}"><span class="ov-uplink-dot"></span>${escapeHtml(String(data.uplink || "—"))}</div>
      </div>

      <div class="ov-stats">
        <div class="ov-stat"><div class="ov-stat-val">${(t.subscribers ?? 0).toLocaleString()}</div><div class="ov-stat-label">Subscribers</div></div>
        <div class="ov-stat"><div class="ov-stat-val">${(t.views ?? 0).toLocaleString()}</div><div class="ov-stat-label">Views</div></div>
        <div class="ov-stat"><div class="ov-stat-val">${(t.videos_total ?? 0).toLocaleString()}</div><div class="ov-stat-label">Videos made</div></div>
        <div class="ov-stat"><div class="ov-stat-val">${t.videos_today ?? 0}</div><div class="ov-stat-label">Today</div></div>
      </div>

      <div class="ov-cards">
        ${OVERVIEW_CARDS.map((c) => `
          <button class="ov-card" data-jump="${c.key}">
            <div class="ov-card-icon">${c.icon}</div>
            <div class="ov-card-title">${c.title}</div>
            <div class="ov-card-blurb">${c.blurb}</div>
          </button>
        `).join("")}
      </div>

      ${activity.length ? `
        <div class="ov-activity">
          <div class="ov-section-label">Recent activity</div>
          ${activity.slice(0, 8).map((a) => `<div class="ov-activity-row">${escapeHtml(String(a.text || a))}</div>`).join("")}
        </div>
      ` : ""}
    </div>
  `;
  body.querySelectorAll(".ov-card").forEach((c) =>
    c.addEventListener("click", () => openBigPanel(c.dataset.jump)));
}

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
        <a class="btn secondary" href="/auth/youtube/start?channel_id=${c.id}">${c.youtube_connected ? "Reconnect" : "Connect"} YouTube</a>
        <a class="btn secondary" href="/auth/tiktok/start?channel_id=${c.id}">${c.tiktok_connected ? "Reconnect" : "Connect"} TikTok</a>
      </div>
      ${c.youtube_connected ? `<div class="hint" style="margin-top:6px">"Connected" just means a token was saved at some point -- if publishing
      keeps failing with an expired/revoked token error, click Reconnect YouTube above to get a fresh one.</div>` : ""}
      <div style="border-top:1px solid var(--border-soft); margin:14px 0 12px; padding-top:12px">
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <input type="checkbox" id="auto-${c.id}" ${c.auto_enabled ? "checked" : ""} style="width:auto;margin:0"/>
          <span style="color:var(--ink);text-transform:none;font-size:13px;letter-spacing:0">⏳ Chronos automation — auto-generate videos</span>
        </label>
        <div class="form-row">
          <div><label>Shorts per day</label><input type="number" min="0" max="24" id="perday-${c.id}" value="${c.auto_per_day || 3}"/></div>
          <div><label>Long-form (5-7 min) per day</label><input type="number" min="0" max="5" id="perdaylong-${c.id}" value="${c.auto_longform_per_day || 0}"/></div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;margin-top:4px">
          <input type="checkbox" id="autopub-${c.id}" ${c.auto_publish_scheduled ? "checked" : ""} style="width:auto;margin:0"/>
          <span style="text-transform:none;font-size:12px;color:var(--muted)">Auto-publish when ready</span>
        </label>
        <div class="hint" style="margin-top:6px">Shorts (vertical, under a minute) and long-form (horizontal, 5-7 min) run on
        separate schedules — set either to 0 to skip that kind entirely. Long-form only ever goes to YouTube, never TikTok.</div>
        <button class="btn secondary" data-autosave="${c.id}">Save Automation</button>
        ${c.auto_enabled ? `<div class="hint" style="margin-top:10px">🤖 Auto-generating ~${c.auto_per_day} short${c.auto_per_day === 1 ? "" : "s"}/day${c.auto_longform_per_day ? ` + ${c.auto_longform_per_day} long-form/day` : ""}. Needs the app running continuously to fire on schedule — see the README hosting note if it's on a host that sleeps when idle.</div>` : ""}
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
        auto_per_day: parseInt($(`#perday-${c.id}`).value, 10) || 0,
        auto_longform_per_day: parseInt($(`#perdaylong-${c.id}`).value, 10) || 0,
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
// Local, per-browser transcript so reopening Jarvis (or reloading the page
// entirely) picks up where the conversation left off instead of resetting
// to a fresh greeting every time -- jarvisHistory alone isn't enough since
// it's just an in-memory variable that a page reload wipes. Capped so this
// can't grow into a real localStorage problem over weeks of use.
// Bumped to _v2 on purpose. Builds shipped earlier today stored Jarvis
// conversation history in shapes the restored (yesterday's) backend can't
// parse -- raw Anthropic content-blocks (incl. thinking/tool_use) from the
// streaming build, AND {role,text} from the neutral-format build. Feeding
// EITHER back to the LLM 500s every single request (confirmed against
// production), which is the real "worked yesterday, not now" cause. Changing
// the key makes every one of those old saved conversations get ignored no
// matter its shape, and we delete the old key outright below so nothing can
// ever read that stale, format-incompatible data again.
const JARVIS_CONVO_KEY = "jarvisConversation_v2";
const JARVIS_CONVO_CAP = 40;
try { localStorage.removeItem("jarvisConversation"); } catch (e) { /* storage unavailable -- nothing to clean */ }

function jarvisSaveConversation(transcript) {
  try {
    localStorage.setItem(JARVIS_CONVO_KEY, JSON.stringify({
      history: jarvisHistory.slice(-JARVIS_CONVO_CAP),
      transcript: transcript.slice(-JARVIS_CONVO_CAP),
    }));
  } catch (e) { /* localStorage unavailable or full -- conversation just won't persist */ }
}

function jarvisLoadConversation() {
  try {
    const raw = localStorage.getItem(JARVIS_CONVO_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.history) || !Array.isArray(parsed.transcript)) return null;
    // Guard against a conversation saved by a DIFFERENT build of the app.
    // A version shipped today stored history entries as {role, text}; this
    // (restored) build sends history straight to the LLM, which expects
    // {role, content} (Anthropic) or {role, parts} (Gemini). Feeding back the
    // wrong shape makes the provider reject EVERY message -- which is exactly
    // "it worked yesterday but not now" the moment the stored format and the
    // running code fall out of sync. If the saved history isn't this build's
    // shape, drop it and start clean instead of poisoning every request.
    const incompatible = parsed.history.some(
      (m) => m && typeof m === "object" && !("content" in m) && !("parts" in m)
    );
    if (incompatible) {
      localStorage.removeItem(JARVIS_CONVO_KEY);
      return null;
    }
    return parsed;
  } catch (e) { return null; }
}

function _jarvisSpeakBrowser(text, onDone) {
  try {
    if (!window.speechSynthesis || !text) { if (onDone) onDone(); return; }
    window.speechSynthesis.cancel();  // don't stack replies if one's still talking
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    if (onDone) { u.onend = onDone; u.onerror = onDone; }
    window.speechSynthesis.speak(u);
  } catch (e) { if (onDone) onDone(); /* speech synthesis just isn't available -- fine, text still shows */ }
}

// Set once an ElevenLabs call actually fails (missing key, quota, etc) so
// repeated replies in one session don't each hit the API and wait on a
// failure before falling back -- one bad response is enough to know.
let jarvisElevenLabsUnavailable = false;
let jarvisSpeakAudio = null;

/** Jarvis's spoken replies -- ElevenLabs (the same account already used for
 *  video narration) when a key is configured, the browser's built-in voice
 *  otherwise. onDone fires once speech actually finishes, however it was
 *  produced, so the caller can drive the "speaking" orb state accurately
 *  instead of guessing a fixed duration. */
async function jarvisSpeak(text, onDone) {
  if (!text) { if (onDone) onDone(); return; }
  if (jarvisSpeakAudio) { jarvisSpeakAudio.pause(); jarvisSpeakAudio = null; }
  if (jarvisElevenLabsUnavailable) { _jarvisSpeakBrowser(text, onDone); return; }
  try {
    const r = await fetch("/api/jarvis/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      // 404 = no ElevenLabs key configured; anything else = a real API
      // failure. Either way, fall back rather than go silent, but only
      // stop retrying ElevenLabs (and keep using the browser voice) once
      // we've actually confirmed it doesn't work this session.
      jarvisElevenLabsUnavailable = true;
      _jarvisSpeakBrowser(text, onDone);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    jarvisSpeakAudio = audio;
    const cleanup = () => { URL.revokeObjectURL(url); if (onDone) onDone(); };
    audio.addEventListener("ended", cleanup);
    audio.addEventListener("error", cleanup);
    audio.play().catch((playErr) => {
      // This is a real ElevenLabs response failing to autoplay -- almost
      // always the browser's autoplay policy (the reply arrives seconds
      // after the click that triggered it, past the window browsers count
      // as "still a user gesture"), NOT a broken key or voice. That's a
      // one-off, not proof ElevenLabs itself is unavailable, so this
      // message falls back to the browser voice but the NEXT one still
      // tries ElevenLabs again -- jarvisUnlockAudio() (wired to the first
      // click in the panel) is what actually fixes it going forward.
      console.warn("Jarvis: ElevenLabs audio blocked from autoplaying:", playErr);
      _jarvisSpeakBrowser(text, onDone);
    });
  } catch (e) {
    _jarvisSpeakBrowser(text, onDone);
  }
}

/** Autoplay policies only allow audio.play() to work reliably once the page
 *  has "unlocked" audio with a real, synchronous user gesture. A chat
 *  reply's play() call happens seconds after the click that triggered it
 *  (a network round trip to Claude + ElevenLabs in between) -- often too
 *  late for the browser to still count it as gesture-driven. Playing (and
 *  instantly pausing) a near-silent clip synchronously inside a genuine
 *  click handler unlocks the audio element for the rest of the page's
 *  session, so the later async play() actually works. */
let jarvisAudioUnlocked = false;
function jarvisUnlockAudio() {
  if (jarvisAudioUnlocked) return;
  jarvisAudioUnlocked = true;
  try {
    const a = new Audio("data:audio/mpeg;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA");
    a.volume = 0;
    a.play().then(() => a.pause()).catch(() => {});
  } catch (e) { /* nothing to unlock without Audio support anyway */ }
  // Desktop-notification permission needs a genuine user gesture too, or
  // most browsers silently ignore the request -- this fires at exactly the
  // same moments (send, push-to-talk) so one real interaction covers both.
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") Notification.requestPermission().catch(() => {});
}

function jarvisNotify(title, body) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const n = new Notification(title, { body });
    // Clicking it should actually take you back to Jarvis, not just sit
    // there -- otherwise a notification you can't act on trains you to
    // ignore the next one.
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) { /* notifications are a nice-to-have, never worth erroring over */ }
}

// Lazily created so the browser's autoplay policy doesn't block it -- an
// AudioContext can only start from a real user gesture, and by the time
// Jarvis first "thinks" the user has already clicked/typed into the panel.
let jarvisAudioCtx = null;
function _jarvisAudioCtx() {
  if (!jarvisAudioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    jarvisAudioCtx = new AC();
  }
  if (jarvisAudioCtx.state === "suspended") jarvisAudioCtx.resume().catch(() => {});
  return jarvisAudioCtx;
}

/** Synthesized cues -- no audio files, just oscillators with a short gain
 *  envelope so nothing clicks or hangs on. */
function jarvisPlayTone(kind) {
  const ctx = _jarvisAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const beep = (freq, start, dur, type, peak) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now + start);
    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(peak, now + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + dur + 0.02);
  };
  if (kind === "thinking") {
    // a short rising sweep -- "processing", not an alarm
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(340, now);
    osc.frequency.exponentialRampToValueAtTime(620, now + 0.22);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.06, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  } else if (kind === "alert") {
    // two urgent square-wave beeps -- distinct from "thinking", meant to be noticed
    beep(880, 0, 0.14, "square", 0.09);
    beep(880, 0.18, 0.14, "square", 0.09);
  }
}

function jarvisSetOrbState(state) {
  // state: "idle" | "listening" | "thinking" | "speaking" | "alert" -- the
  // color/animation itself lives in CSS, keyed off this class on the
  // emblem wrapper (see .jarvis-center-emblem.jv-* rules), so the chip,
  // its traces, and its nodes all shift together.
  const eq = document.getElementById("jarvis-eq");
  const emblem = document.querySelector(".jarvis-center-emblem");
  if (eq) eq.classList.toggle("jarvis-eq-active", state === "listening" || state === "speaking");
  if (emblem) {
    emblem.classList.remove("jv-idle", "jv-listening", "jv-thinking", "jv-speaking", "jv-alert");
    emblem.classList.add("jv-" + state);
  }
  if (state === "thinking") jarvisPlayTone("thinking");
  if (state === "alert") jarvisPlayTone("alert");
}

let jarvisTranscript = [];

function jarvisAppendMsg(role, text, opts) {
  if (!opts || !opts.skipRecord) jarvisTranscript.push({ role, text });
  const log = document.getElementById("jarvis-log");
  if (!log) return;
  const div = el(`<div class="jarvis-msg jarvis-${role}"></div>`);
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// True from the moment a message is sent until Jarvis has finished
// thinking AND finished speaking the reply -- guards against a second
// conversation starting (a second push-to-talk press, a second typed
// send) while the first is still in flight, which is what produced "two
// of him" talking over each other and rapid state-flashing.
let jarvisBusy = false;
// Failsafe timer for jarvisBusy. If a reply ever gets stuck busy (e.g. its
// audio never fires "ended", so the onDone that clears the flag never runs),
// jarvisBusy would stay true forever and silently kill ALL future
// push-to-talk -- jarvisStartListening bails immediately while busy. This
// guarantees the flag always releases, so the mic can never get permanently
// wedged by one bad reply.
let jarvisBusyTimer = null;
function jarvisSetBusy(v) {
  jarvisBusy = v;
  clearTimeout(jarvisBusyTimer);
  if (v) jarvisBusyTimer = setTimeout(() => { jarvisBusy = false; }, 45000);
}

async function jarvisSend(message) {
  if (!message || !message.trim()) return;
  // "run <task name>" / "do <task>" spoken or typed replays a taught task
  // locally instead of going to the LLM -- so a demonstrated task is runnable
  // by voice, not just the ▶ button. Skipped while replaying so a task step's
  // own text can't recursively re-trigger a task.
  if (!jarvisTaskReplaying && jarvisMaybeRunTaskByName(message)) return;
  if (jarvisBusy) { toast("Jarvis is still answering -- one at a time."); return; }
  jarvisSetBusy(true);
  // Capture the command as a step while teaching a task (each thing you ask
  // Jarvis during a demonstration becomes part of the replayable sequence).
  jarvisRecordStep({ type: "say", text: message });
  jarvisAppendMsg("user", message);
  const caption = document.getElementById("jarvis-caption");
  if (caption) caption.textContent = "…";
  // Push-to-talk works from any panel now, not just while the Jarvis HUD is
  // open -- when it's not (no caption element to update in place), a toast
  // is the only way to confirm he actually heard you.
  if (!caption) toast(`You: ${message}`);
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
    jarvisSaveConversation(jarvisTranscript);
    if (caption) caption.textContent = r.reply.slice(0, 90);
    else toast(`Jarvis: ${r.reply.slice(0, 120)}`);
    // A reply that lands while you're on another tab is easy to miss
    // entirely otherwise -- audio keeps playing regardless, but a desktop
    // notification is what actually gets your attention if you've moved on.
    if (document.hidden) jarvisNotify("Jarvis", r.reply.slice(0, 180));
    if (r.actions && r.actions.length) {
      toast(`Jarvis: ${r.actions.map((a) => a.tool).join(", ")}`);
      // Some tool calls have a real effect on THIS page, not just the
      // backend -- the model decided to call them from the conversation,
      // this is just carrying that decision out client-side.
      r.actions.forEach((a) => {
        if (a.tool === "control_camera_dock" && a.result && a.result.ok) {
          jarvisCameraDockAction(a.result.action);
        }
        // send_notification always fires a desktop notification here
        // regardless of tab visibility -- this is Jarvis choosing to send
        // something on request, not the passive "you missed a reply" case
        // above, so it should show even if you're already looking at it.
        if (a.tool === "send_notification" && a.result && a.result.ok) {
          jarvisNotify("Jarvis", a.result.message);
        }
      });
    }
    jarvisSetOrbState("speaking");
    jarvisSpeak(r.reply, () => {
      jarvisSetOrbState("idle");
      jarvisSetBusy(false);
    });
  } catch (e) {
    thinking.remove();
    const msg = "Couldn't reach Jarvis: " + e.message;
    jarvisAppendMsg("assistant", msg);
    if (caption) caption.textContent = msg;
    else toast(msg);
    jarvisSetOrbState("idle");
    jarvisSetBusy(false);
  }
}

// Push-to-talk: hold Enter, recognition runs while it's held. Chrome/Edge
// stop SpeechRecognition on their own after a few seconds of silence even
// with continuous=true, though -- that's a browser quirk, not you
// releasing the key, and was cutting people off mid-sentence. genId
// invalidates a restart still in flight from a stale recognition session
// (mirrors the camera dock's start/stop race fix above), and the key-held
// state restarts recognition transparently instead of finalizing when it
// ends on its own while the key's still down, carrying the transcript so
// far across the restart so nothing already said gets lost.
let jarvisKeyHeld = false;
let jarvisTranscriptSoFar = "";
let jarvisRecognitionGen = 0;
// True only between a recognition session's real onstart and onend. Needed
// because jarvisKeyHeld alone was a one-way trap: if a keyup never arrived
// (you release Enter while the window isn't focused -- alt-tab, a permission
// prompt, clicking another app), jarvisKeyHeld stayed true forever, and
// jarvisStartListening's `if (jarvisKeyHeld) return` then silently refused
// EVERY later attempt. Voice would be dead until a page reload, showing
// nothing at all -- exactly the reported symptom. Comparing the two flags
// lets us detect that stale state and recover instead of wedging.
let jarvisRecognitionLive = false;

/** Hard-reset the voice pipeline from any state. Safe to call at any time. */
function jarvisForceResetVoice() {
  jarvisRecognitionGen++;            // invalidate callbacks from the old session
  jarvisRecognitionLive = false;
  jarvisKeyHeld = false;
  try {
    if (jarvisRecognition) {
      if (jarvisRecognition.abort) jarvisRecognition.abort();
      else jarvisRecognition.stop();
    }
  } catch (e) { /* already dead -- that's the point */ }
  jarvisRecognition = null;
  jarvisSetOrbState("idle");
}

function _jarvisStartRecognition() {
  const myGen = ++jarvisRecognitionGen;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  jarvisRecognition = new SR();
  jarvisRecognition.continuous = true;
  jarvisRecognition.interimResults = true;
  jarvisRecognition.lang = "en-US";
  jarvisRecognition.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) jarvisTranscriptSoFar += t + " ";
      else interim += t;
    }
    // Looked up fresh on every result rather than captured once -- if the
    // panel gets torn down and rebuilt mid-recording (which the general
    // button-focus fix below should now prevent, but this is what made it
    // silently look like "no response" when it still happened: the old
    // caption element was detached, so updates were landing nowhere
    // visible even though recognition itself was still running fine).
    const caption = document.getElementById("jarvis-caption");
    if (caption) caption.textContent = (jarvisTranscriptSoFar + interim) || "Listening…";
  };
  // CRITICAL: "no-speech" and "aborted" are ROUTINE, not failures. "no-speech"
  // fires on any natural pause while you're talking; "aborted" fires from our
  // own restart. A previous version set an error flag on EVERY error, so the
  // first pause in your sentence flagged the session as errored and onend
  // then refused to keep listening -- which is exactly why voice "did
  // nothing". These are ignored here so onend restarts recognition while the
  // key is still held, just like it worked before. Only a genuinely fatal
  // error (blocked mic, unreachable speech service) stops the session and
  // shows a message.
  let jarvisMicError = null;
  jarvisRecognition.onerror = (ev) => {
    if (myGen !== jarvisRecognitionGen) return;
    if (ev.error === "no-speech" || ev.error === "aborted") return;  // routine -- keep listening
    const caption = document.getElementById("jarvis-caption");
    const say = (m) => { if (caption) caption.textContent = m; else toast("Jarvis: " + m); };
    const MSG = {
      "not-allowed": "Microphone is blocked. Click the mic/lock icon in the address bar, allow it for this site, reload, and try again.",
      "service-not-allowed": "Microphone is blocked. Allow mic access for this site, reload, and try again.",
      "audio-capture": "No microphone detected -- check it's plugged in and not in use by another app.",
      "network": "Voice service unreachable. On Edge: open Windows Settings > Privacy & security > Speech and turn ON 'Online speech recognition', then reload and try again.",
    };
    jarvisMicError = ev.error;
    jarvisKeyHeld = false;  // real error -- stop the restart loop, it won't fix itself by retrying
    say(MSG[ev.error] || `Voice error: "${ev.error}". Reload and retry, or just type your message instead.`);
    jarvisSetOrbState("idle");
  };
  jarvisRecognition.onstart = () => {
    if (myGen !== jarvisRecognitionGen) return;
    jarvisRecognitionLive = true;  // proves the mic session really opened
  };
  jarvisRecognition.onend = () => {
    if (myGen !== jarvisRecognitionGen) return;  // a newer session already took over
    jarvisRecognitionLive = false;
    if (jarvisKeyHeld && !jarvisMicError) {
      // Ended on its own while the key's still down -- just the browser's
      // silence timeout (or our restart). Keep listening.
      try { _jarvisStartRecognition(); return; } catch (e) { jarvisKeyHeld = false; }
    }
    jarvisSetOrbState("idle");
    const said = jarvisTranscriptSoFar.trim();
    if (said) jarvisSend(said);
    else if (!jarvisMicError) {
      // Don't stomp a mic-error message already shown by onerror above.
      const caption = document.getElementById("jarvis-caption");
      if (caption) caption.textContent = "Press and hold Enter to talk, or type below.";
    }
  };
  jarvisRecognition.start();
}

// ============================================================ MIC RECORDING (device-selectable, server-transcribed)
// The reliable voice path: capture audio from a chosen input device (any mic,
// including Bluetooth) with getUserMedia + MediaRecorder, then transcribe it
// server-side (/api/jarvis/transcribe). This does NOT touch the browser's
// built-in SpeechRecognition -- which can't target a device and kept failing
// on Edge/Windows -- so a paired Bluetooth mic Just Works and none of the old
// silent-failure modes apply.
const JARVIS_MIC_DEVICE_KEY = "jarvisMicDeviceId";
let jarvisMediaStream = null;
let jarvisMediaRecorder = null;
let jarvisAudioChunks = [];
let jarvisRecording = false;
let jarvisLiveRecognition = null;
let jarvisLiveFinal = "";     // words the browser marked FINAL
let jarvisLiveShown = "";     // final + current interim = exactly what's on screen
let jarvisLiveHandled = false; // true once we've already sent the live transcript

// LIVE words on screen AS YOU SPEAK. When the browser's own recognition works
// (which is instant), we send exactly what's on screen the moment you release
// -- no waiting on a server round-trip. The server transcription is only the
// fallback for when the browser engine gives nothing.
function _jarvisStartLiveCaption() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  jarvisLiveFinal = ""; jarvisLiveShown = "";
  try {
    jarvisLiveRecognition = new SR();
    jarvisLiveRecognition.continuous = true;
    jarvisLiveRecognition.interimResults = true;
    jarvisLiveRecognition.lang = "en-US";
    jarvisLiveRecognition.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) jarvisLiveFinal += t + " ";
        else interim += t;
      }
      // Track final + interim so a QUICK release still captures words the
      // engine hasn't finalized yet -- that un-finalized text was being lost
      // before, which is exactly why letting go fast "cut you off".
      jarvisLiveShown = (jarvisLiveFinal + interim).trim();
      const caption = document.getElementById("jarvis-caption");
      if (caption && jarvisLiveShown && jarvisRecording) caption.textContent = jarvisLiveShown;
    };
    jarvisLiveRecognition.onerror = () => {};  // display-only -- never surface
    jarvisLiveRecognition.onend = () => {
      if (jarvisRecording && jarvisLiveRecognition) {
        try { jarvisLiveRecognition.start(); } catch (e) { /* fine */ }
      }
    };
    jarvisLiveRecognition.start();
  } catch (e) { /* live caption is optional */ }
}

function _jarvisStopLiveCaption() {
  const r = jarvisLiveRecognition;
  jarvisLiveRecognition = null;  // clearing first stops onend from restarting it
  if (r) { try { r.abort ? r.abort() : r.stop(); } catch (e) { /* already stopped */ } }
}

// Locked to the user's one real mic (the "ME6S" USB device) -- matched by
// name rather than deviceId, since Windows/the browser can reassign deviceId
// on reconnect but the device's own name stays the same. If it's ever
// unplugged and nothing matches, the filter is skipped so the picker falls
// back to showing everything rather than going empty and breaking the mic.
const ONLY_MIC_LABEL_MATCH = /ME6S/i;

async function jarvisPopulateMicDevices(requestPermission) {
  const sel = document.getElementById("jarvis-mic-device");
  if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    // Device LABELS (needed to recognize your Bluetooth mic by name) are only
    // exposed after mic permission is granted once. Ask on the refresh click.
    if (requestPermission) {
      try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); } catch (e) { /* denied -- list stays unlabeled */ }
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    let inputs = devices.filter((d) => d.kind === "audioinput");
    const onlyMic = inputs.filter((d) => ONLY_MIC_LABEL_MATCH.test(d.label || ""));
    if (onlyMic.length) inputs = onlyMic;  // lock to the ME6S mic when it's present
    const saved = localStorage.getItem(JARVIS_MIC_DEVICE_KEY) || "";
    sel.innerHTML = inputs.map((d, i) => {
        const label = d.label || `Microphone ${i + 1}`;
        const selAttr = d.deviceId === saved ? " selected" : "";
        return `<option value="${d.deviceId}"${selAttr}>${escapeHtml(label)}</option>`;
      }).join("") || '<option value="">Default microphone</option>';
  } catch (e) { /* enumeration failed -- default mic still works */ }
}

async function jarvisStartRecording() {
  const caption = document.getElementById("jarvis-caption");
  if (jarvisRecording) return;
  // Reset transcript state up front, unconditionally -- _jarvisStartLiveCaption
  // only clears it when speech recognition exists, so without this a recording
  // with no live recognition could reuse a PREVIOUS turn's words.
  jarvisLiveFinal = ""; jarvisLiveShown = ""; jarvisLiveHandled = false;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
    // Fall back to the browser speech path if recording isn't available.
    jarvisStartListening();
    return;
  }
  jarvisUnlockAudio();
  // Interrupt any reply that's still talking, and clear a possibly-stale busy.
  if (jarvisBusy) {
    try { if (jarvisSpeakAudio) jarvisSpeakAudio.pause(); } catch (e) { /* nothing */ }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* fine */ }
    jarvisSetBusy(false);
  }
  // Resolve the ME6S mic's CURRENT deviceId fresh, right now -- not a value
  // cached in localStorage from before the picker was locked down to it. A
  // stale saved id (from an earlier session, or before this lock existed)
  // would either fail outright or silently fall through to the OS's default
  // input device, which is exactly how "Jarvis can't hear me" happened: the
  // system default isn't necessarily the ME6S mic at all.
  let deviceId = "";
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const me6s = devices.find((d) => d.kind === "audioinput" && ONLY_MIC_LABEL_MATCH.test(d.label || ""));
    if (me6s) deviceId = me6s.deviceId;
  } catch (e) { /* enumeration failed -- constraints below fall back to default */ }
  if (!deviceId) deviceId = localStorage.getItem(JARVIS_MIC_DEVICE_KEY) || "";
  const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true };
  try {
    jarvisMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // exact-device failed (mic unplugged/changed) -- retry with the default
    // before giving up, so switching away from a Bluetooth mic doesn't brick it.
    try { jarvisMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (err2) {
      const m = (err2 && err2.name === "NotAllowedError")
        ? "Microphone access was blocked. Allow it for this site (mic icon in the address bar) and try again."
        : `Couldn't open the microphone (${err2 && err2.name ? err2.name : err2}).`;
      if (caption) caption.textContent = m; else toast("Jarvis: " + m);
      jarvisSetOrbState("idle");
      return;
    }
  }
  jarvisAudioChunks = [];
  try {
    jarvisMediaRecorder = new MediaRecorder(jarvisMediaStream);
  } catch (e) {
    jarvisMediaRecorder = new MediaRecorder(jarvisMediaStream, { mimeType: "audio/webm" });
  }
  jarvisMediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) jarvisAudioChunks.push(e.data); };
  jarvisMediaRecorder.onstop = () => { jarvisTranscribeRecording(); };
  jarvisMediaRecorder.start();
  jarvisRecording = true;
  jarvisSetOrbState("listening");
  if (caption) caption.textContent = "Listening…";
  _jarvisStartLiveCaption();  // show words on screen as they're spoken
}

function _jarvisReleaseMic() {
  try { if (jarvisMediaStream) jarvisMediaStream.getTracks().forEach((t) => t.stop()); } catch (e) { /* fine */ }
  jarvisMediaStream = null;
}

function jarvisStopRecording() {
  if (!jarvisRecording) return;
  jarvisRecording = false;
  _jarvisStopLiveCaption();
  const caption = document.getElementById("jarvis-caption");
  const live = jarvisLiveShown.trim();

  // INSTANT PATH: if the browser already showed your words on screen, send
  // them the moment you let go -- no server round-trip. THIS is the delay you
  // felt: your words were already captured but we were waiting on a server
  // transcription that wasn't needed. We still stop the recorder to free the
  // mic, but ignore its (slower) result.
  if (live) {
    jarvisLiveHandled = true;   // tells onstop -> jarvisTranscribeRecording not to send again
    if (caption) caption.textContent = live;
    if (jarvisMediaRecorder) jarvisMediaRecorder.onstop = () => { _jarvisReleaseMic(); jarvisAudioChunks = []; };
    try { if (jarvisMediaRecorder && jarvisMediaRecorder.state !== "inactive") jarvisMediaRecorder.stop(); } catch (e) { /* fine */ }
    jarvisSend(live);
    return;
  }

  // FALLBACK PATH: the browser engine gave nothing -> transcribe the recording
  // server-side (reliable even when the browser speech engine doesn't work).
  jarvisLiveHandled = false;
  if (caption) caption.textContent = "Transcribing…";
  try { if (jarvisMediaRecorder && jarvisMediaRecorder.state !== "inactive") jarvisMediaRecorder.stop(); } catch (e) { /* onstop handles it */ }
}

async function jarvisTranscribeRecording() {
  const caption = document.getElementById("jarvis-caption");
  _jarvisReleaseMic();  // free the mic / Bluetooth link
  if (jarvisLiveHandled) { jarvisAudioChunks = []; return; }  // live transcript already sent instantly
  const chunks = jarvisAudioChunks; jarvisAudioChunks = [];
  if (!chunks.length) {
    if (caption) caption.textContent = "Didn't catch any audio -- hold the mic a moment longer and speak.";
    jarvisSetOrbState("idle");
    return;
  }
  const blob = new Blob(chunks, { type: (jarvisMediaRecorder && jarvisMediaRecorder.mimeType) || "audio/webm" });
  try {
    const fd = new FormData();
    fd.append("audio", blob, "speech.webm");
    const r = await fetch("/api/jarvis/transcribe", { method: "POST", body: fd });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`${r.status} ${detail.slice(0, 140)}`);
    }
    const data = await r.json();
    // Fall back to the live-caption transcript if the server returns nothing.
    const text = (data.text || "").trim() || jarvisLiveShown.trim();
    if (text) {
      if (caption) caption.textContent = text;
      jarvisSend(text);
    } else {
      if (caption) caption.textContent = "Didn't catch that -- try again.";
      jarvisSetOrbState("idle");
    }
  } catch (e) {
    const m = "Transcription failed: " + (e && e.message ? e.message : e);
    if (caption) caption.textContent = m; else toast("Jarvis: " + m);
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
  // Recover from a wedged state instead of silently refusing forever. If we
  // still think a key is held but no recognition session is actually alive,
  // that's leftover garbage from a lost keyup -- clear it and carry on.
  if (jarvisKeyHeld && !jarvisRecognitionLive) jarvisForceResetVoice();
  if (jarvisKeyHeld && jarvisRecognitionLive) return;  // genuinely listening already
  // Jarvis talking shouldn't lock you out either -- interrupt him and listen.
  // (jarvisBusy could also be stale, which used to kill voice permanently.)
  if (jarvisBusy) {
    try { if (jarvisSpeakAudio) jarvisSpeakAudio.pause(); } catch (e) { /* nothing playing */ }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* fine */ }
    jarvisSetBusy(false);
  }
  jarvisUnlockAudio();
  jarvisKeyHeld = true;
  jarvisTranscriptSoFar = "";
  jarvisSetOrbState("listening");
  if (caption) caption.textContent = "Listening…";
  try {
    _jarvisStartRecognition();
  } catch (err) {
    // recognition.start() throws (e.g. InvalidStateError) if a previous
    // session hasn't fully released. Uncaught, that escaped the key handler
    // and left the UI pinned on "Listening…" with jarvisKeyHeld stuck true --
    // voice dead until reload, with no error surfaced anywhere.
    jarvisForceResetVoice();
    const msg = `Couldn't start the mic (${err && err.name ? err.name : err}). Press Enter again.`;
    if (caption) caption.textContent = msg; else toast("Jarvis: " + msg);
  }
}

/** Wired once at app boot, not per-panel-open -- push-to-talk used to only
 *  work while the Jarvis HUD screen itself was mounted (the keydown/keyup
 *  listeners were added in renderJarvisPanel and torn down the moment you
 *  navigated away), so Jarvis could only hear you from his own screen. Every
 *  function this calls already degrades gracefully with no Jarvis DOM
 *  present (checks `if (caption)` etc. throughout), so the only piece
 *  actually missing was wiring the listener up globally instead of
 *  scoping it to one panel's lifecycle. */
function jarvisSetupGlobalPushToTalk() {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.repeat) return;
    const ae = document.activeElement;
    // Don't hijack Enter while it means something else -- typing into any
    // text field, textarea, or contenteditable area anywhere in the app.
    // The Jarvis message box handles its own Enter (send if it has text,
    // push-to-talk if empty -- see renderJarvisPanel), so it's covered here
    // too rather than being special-cased at this level: doing the emptiness
    // check here is unreliable, because the box's own handler clears the
    // text BEFORE this runs, making a just-sent message look "empty".
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
    // Belt and suspenders against the real bug this was chasing: a focused
    // <button> (e.g. the sidebar icon you just clicked to open Jarvis)
    // reacts to Enter on its own -- the browser re-clicks it, which
    // re-opened the whole panel mid-recording. e.preventDefault() below
    // should already stop that, but explicitly dropping focus removes any
    // button from being a target at all, regardless of exact per-browser
    // timing of when that native activation fires.
    if (ae && typeof ae.blur === "function") ae.blur();
    e.preventDefault();
    // Was jarvisStartListening() -- the browser's OWN SpeechRecognition
    // engine, the exact thing already documented (see MIC RECORDING section
    // above) as unreliable/can't-target-a-device on Edge/Windows. That's why
    // Enter did nothing while the mic BUTTON (wired to jarvisStartRecording,
    // the getUserMedia+MediaRecorder+server-transcribe path) worked fine --
    // two different code paths, only one of them actually reliable. Enter
    // now drives the same reliable path the button uses.
    jarvisStartRecording();
  });
  document.addEventListener("keyup", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    jarvisStopRecording();
  });
  // THE wedge: a keyup that never arrives. Release Enter while the window
  // isn't focused (alt-tab, a permission prompt stealing focus, clicking
  // another app) and the browser delivers that keyup somewhere else -- so
  // jarvisKeyHeld stayed true and every later attempt was silently refused,
  // permanently, until a page reload. Finalizing here means losing focus
  // ends the recording cleanly instead of poisoning the state.
  window.addEventListener("blur", () => { if (jarvisRecording) jarvisStopRecording(); });
}

// ---------------------------------------------------------------- WAKE WORD ("Jarvis" / "Hey Jarvis")
// No more push-to-talk needed: unmuted, Jarvis listens continuously (the
// browser's free built-in engine -- same known Windows/Edge flakiness noted
// above, but here that only risks an occasionally-missed wake word, not a
// missed COMMAND, which is a much cheaper failure). The instant it hears its
// name, it hands off to the exact same reliable recording path the mic
// button already uses (getUserMedia + MediaRecorder + server transcription)
// for the actual command -- never the flaky engine for words that matter.
const JARVIS_MUTED_KEY = "jarvisMuted";
let jarvisWakeRecognition = null;
let jarvisWakeActive = false;      // true while the wake-word listener itself is running
let jarvisWakeTriggered = false;   // true while a triggered command is being captured/handled
const WAKE_WORD_PATTERN = /\bhey\s+jarvis\b|\bjarvis\b/i;
const SILENCE_STOP_MS = 1400;      // how long a pause has to last before auto-ending the command
const SILENCE_MAX_MS = 12000;      // hard cap so a stuck mic can't listen forever

function jarvisIsMuted() {
  try { return localStorage.getItem(JARVIS_MUTED_KEY) === "true"; } catch (e) { return false; }
}

function _jarvisSetWakeStatus(text) {
  const el = document.getElementById("jarvis-wake-status");
  if (el) el.textContent = text;
}

function jarvisStartWakeListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { _jarvisSetWakeStatus("Always-listening isn't supported in this browser -- use the mic button instead."); return; }
  if (jarvisIsMuted() || jarvisWakeActive || jarvisWakeTriggered) return;
  jarvisWakeActive = true;
  try {
    jarvisWakeRecognition = new SR();
    jarvisWakeRecognition.continuous = true;
    jarvisWakeRecognition.interimResults = true;
    jarvisWakeRecognition.lang = "en-US";
    jarvisWakeRecognition.onresult = (ev) => {
      if (jarvisWakeTriggered) return;
      let heard = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) heard += ev.results[i][0].transcript + " ";
      if (WAKE_WORD_PATTERN.test(heard)) {
        jarvisWakeTriggered = true;
        try { jarvisWakeRecognition.stop(); } catch (e) { /* onend will still fire */ }
        _jarvisHandleWakeTrigger();
      }
    };
    jarvisWakeRecognition.onerror = () => {};  // restarts via onend below regardless of the reason
    jarvisWakeRecognition.onend = () => {
      jarvisWakeActive = false;
      // Only auto-restart if still unmuted and not mid-command -- otherwise
      // this would immediately re-listen right through a command capture.
      if (!jarvisIsMuted() && !jarvisWakeTriggered) jarvisStartWakeListening();
    };
    jarvisWakeRecognition.start();
    _jarvisSetWakeStatus('Say "Jarvis" or "Hey Jarvis" any time — unmuted');
  } catch (e) { jarvisWakeActive = false; }
}

function jarvisStopWakeListening() {
  if (jarvisWakeRecognition) { try { jarvisWakeRecognition.stop(); } catch (e) { /* fine */ } }
  jarvisWakeRecognition = null;
  jarvisWakeActive = false;
}

/** Wake word heard -> capture the actual command through the RELIABLE path
 *  (same as the mic button), auto-ending on a pause instead of a button
 *  release, then hand it to jarvisSend and resume listening for the name. */
async function _jarvisHandleWakeTrigger() {
  jarvisPlayGestureChime();
  _jarvisSetWakeStatus("Listening for your command…");
  await jarvisStartRecording();

  // Silence detection on the SAME stream jarvisStartRecording just opened --
  // reading its volume rather than opening a second mic connection.
  let stopped = false;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    try { cleanup(); } catch (e) { /* fine */ }
    jarvisStopRecording();
  };
  let cleanup = () => {};
  let hardCap = setTimeout(finish, SILENCE_MAX_MS);
  try {
    if (jarvisMediaStream) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(jarvisMediaStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let silenceTimer = null;
      let heardSpeech = false;
      const tick = () => {
        if (stopped) return;
        analyser.getByteTimeDomainData(data);
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sumSq += v * v; }
        const rms = Math.sqrt(sumSq / data.length);
        if (rms > 0.02) {
          heardSpeech = true;
          if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        } else if (heardSpeech && !silenceTimer) {
          silenceTimer = setTimeout(finish, SILENCE_STOP_MS);
        }
        if (!stopped) requestAnimationFrame(tick);
      };
      tick();
      cleanup = () => { clearTimeout(silenceTimer); try { ctx.close(); } catch (e) {} };
    }
  } catch (e) { /* silence detection is best-effort; the hard cap still applies */ }

  // jarvisStopRecording() (called by finish()) drives the rest of the
  // existing pipeline (transcribe -> jarvisSend -> reply) exactly like the
  // mic button already does. Once Jarvis is done talking, resume listening.
  const waitForIdle = () => new Promise((resolve) => {
    const check = () => { if (!jarvisBusy && !jarvisRecording) resolve(); else setTimeout(check, 300); };
    setTimeout(check, 500);
  });
  await waitForIdle();
  clearTimeout(hardCap);
  jarvisWakeTriggered = false;
  if (!jarvisIsMuted()) jarvisStartWakeListening();
}

function jarvisSetMuted(muted) {
  try { localStorage.setItem(JARVIS_MUTED_KEY, muted ? "true" : "false"); } catch (e) { /* fine */ }
  const btn = document.getElementById("jarvis-wake-toggle");
  if (muted) {
    jarvisStopWakeListening();
    if (btn) { btn.textContent = "🔇"; btn.title = "Unmute (tap to start always-listening)"; }
    _jarvisSetWakeStatus("Muted — tap 🔇 to start listening again");
  } else {
    if (btn) { btn.textContent = "🔊"; btn.title = "Mute always-listening mode"; }
    jarvisStartWakeListening();
  }
}

function jarvisSetupWakeWord() {
  const btn = document.getElementById("jarvis-wake-toggle");
  if (btn) {
    btn.addEventListener("click", () => jarvisSetMuted(!jarvisIsMuted()));
  }
  // Opt-in, not opt-out: Enter / the mic button (push-to-talk) is the active
  // default again. The first version of this auto-started listening the
  // instant the panel opened, which also silently wrote "unmuted" into
  // localStorage for anyone who never touched the toggle -- so it kept
  // coming back even after closing the panel. Always starts muted now,
  // regardless of anything stored from before; tap 🔇 to turn wake-word on
  // if you want it.
  jarvisSetMuted(true);
}

function jarvisStopListening() {
  jarvisKeyHeld = false;  // lets a since-fired onend finalize instead of restarting
  // The actual "sometimes waits too long" gap is the browser's own speech
  // engine finalizing the last chunk before it fires onend -- that latency
  // is real and out of this app's control (Windows especially can take a
  // beat here), and varies run to run, which is why it felt inconsistent
  // rather than a fixed delay. What IS fixable is the dead air: nothing
  // updated on screen between releasing the key and onend eventually
  // firing, so it looked like nothing was happening rather than like it
  // was working. This gives immediate feedback the instant you let go.
  const caption = document.getElementById("jarvis-caption");
  if (caption && jarvisTranscriptSoFar.trim()) caption.textContent = "Got it, one sec…";
  if (jarvisRecognition) {
    try { jarvisRecognition.stop(); } catch (e) { /* already stopped/starting -- onend will still fire */ }
  }
}

function jarvisStatBar(label, value, max) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : (value > 0 ? 100 : 0);
  return `<div class="jarvis-stat-bar">
    <div class="jarvis-stat-bar-label"><span>${label}</span><span>${value}</span></div>
    <div class="jarvis-stat-bar-track"><div class="jarvis-stat-bar-fill" style="width:${pct}%"></div></div>
  </div>`;
}

// Real intruder/security-alert signal: JarvisLog already records every
// refused tool call (a request that fell outside the whitelist, a
// non-allowlisted WhatsApp sender, a bad Twilio signature, a kill-switch
// refusal). A newly-appeared allowed:false row IS an unauthorized attempt --
// this isn't decorative, it's the same audit trail the Activity tab reads.
// Log ids are opaque hex strings, not sequential ints, so "new" is tracked
// with a seen-set rather than a numeric high-water mark.
let jarvisSeenBlockedIds = null;
async function jarvisCheckSecurity() {
  try {
    const rows = await API("/api/jarvis/log?limit=20");
    const blocked = rows.filter((r) => r.allowed === false);
    if (jarvisSeenBlockedIds === null) {
      // First poll after opening the panel -- baseline against existing
      // history instead of alarming on old, already-seen refusals.
      jarvisSeenBlockedIds = new Set(blocked.map((r) => r.id));
      return;
    }
    const fresh = blocked.filter((r) => !jarvisSeenBlockedIds.has(r.id));
    if (fresh.length) {
      fresh.forEach((r) => jarvisSeenBlockedIds.add(r.id));
      jarvisSetOrbState("alert");
      toast("Jarvis blocked an unauthorized action -- check Activity.");
      jarvisNotify("Jarvis -- security alert", "Blocked an unauthorized action. Check the Activity tab.");
      setTimeout(() => jarvisSetOrbState("idle"), 5000);
    }
  } catch (e) { /* security polling is best-effort; never block the UI over it */ }
}

async function jarvisRefreshReadout() {
  try {
    const [jobs, channels, settings] = await Promise.all([
      API("/api/jobs?limit=30"), API("/api/channels"), API("/api/settings").catch(() => ({})),
    ]);
    const sval = (k) => { const v = settings[k]; return v && typeof v === "object" ? (v.value || "") : (v || ""); };
    const slotsMode = sval("schedule_mode") === "slots";
    const running = jobs.filter((j) => !["published", "ready_for_review", "failed", "queued"].includes(String(j.status))).length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    const autoOn = channels.filter((c) => c.auto_enabled).length;

    // "Today" by local calendar day, matching what a person means by "today".
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const doneToday = jobs.filter((j) => {
      if (!["published", "ready_for_review"].includes(String(j.status))) return false;
      const t = j.created_at ? new Date(j.created_at.endsWith("Z") ? j.created_at : j.created_at + "Z") : null;
      return t && t >= todayStart;
    }).length;
    const slotTimes = sval("post_schedule_times").split(",").map((s) => s.trim()).filter(Boolean);
    const targetToday = slotsMode
      ? slotTimes.length
      : channels.reduce((sum, c) => sum + (c.auto_enabled ? (c.auto_per_day || 0) : 0), 0);

    const readout = document.getElementById("jarvis-readout");
    if (readout) readout.innerHTML =
      jarvisStatBar("Rendering now", running, 1) +
      jarvisStatBar("Failed recently", failed, Math.max(failed, 5)) +
      jarvisStatBar("Channels automated", autoOn, channels.length || 1);

    const gaugeValue = document.getElementById("jarvis-gauge-value");
    if (gaugeValue) gaugeValue.textContent = `${doneToday}/${targetToday || "—"}`;
    const gaugeWrap = document.querySelector(".jarvis-gauge svg");
    if (gaugeWrap && targetToday > 0) gaugeWrap.outerHTML = jarvisArcGaugeSVG(doneToday / targetToday);

    const schedule = document.querySelector("#jarvis-schedule .jarvis-schedule-body");
    if (schedule) {
      if (slotsMode) {
        const tz = sval("post_timezone").replace("America/", "").replace("_", " ") || "local";
        const to12 = (hm) => { const [h, m] = hm.split(":").map(Number); const ap = h < 12 ? "am" : "pm"; const hh = ((h + 11) % 12) + 1; return m ? `${hh}:${String(m).padStart(2, "0")}${ap}` : `${hh}${ap}`; };
        const times = slotTimes.map(to12).join(" · ");
        const chName = (id) => (channels.find((c) => c.id === id) || {}).name || "?";
        const shortsName = chName(sval("schedule_shorts_channel_id"));
        const lfCh = channels.find((c) => c.id === sval("schedule_longform_channel_id"));
        const lfLine = lfCh
          ? `1 long/day → ${escapeHtml(lfCh.name)}${lfCh.youtube_connected ? "" : " <span style='opacity:.7'>(connect to enable)</span>"}`
          : "";
        schedule.innerHTML = `<b>Fixed schedule</b> · ${escapeHtml(tz)}<br>${escapeHtml(times)}<br>4 shorts → ${escapeHtml(shortsName)}<br>${lfLine}`;
      } else {
        const auto = channels.filter((c) => c.auto_enabled);
        schedule.innerHTML = auto.length
          ? auto.map((c) => `${escapeHtml(c.name)} — ${c.auto_per_day}/day${c.auto_publish_scheduled ? " · auto-publish" : ""}`).join("<br>")
          : "No channels on auto-schedule.";
      }
    }

    const agentRow = document.getElementById("jarvis-agent-row");
    if (agentRow) {
      agentRow.innerHTML = JARVIS_AGENT_IDS.map((id) => {
        const a = (state.agents || []).find((x) => x.id === id);
        const working = a && a.status === "running";
        const name = (a && a.name) || id;
        return `<div class="jarvis-agent-glyph ${working ? "on" : ""}">${jarvisAgentGlyphSVG(working)}<div class="jarvis-agent-glyph-label">${escapeHtml(name)}</div></div>`;
      }).join("");
    }
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
// initiated -- both a real mouse drag on a widget's handle and a pinch
// gesture from the webcam (further down) feed into these same three
// functions, so a widget doesn't care which one is moving it. Jarvis is a
// full-screen backdrop with independent floating widgets on top (see
// .jarvis-widget) rather than one draggable window, so each widget carries
// its own localStorage key (set by jarvisMakeDraggable) for its position.
let jarvisDragPanel = null;
let jarvisDragOffset = { x: 0, y: 0 };
// Resize state -- pinching a panel's corner grip scales it (fingers), same
// primitives reused for a mouse drag on the grip.
let jarvisResizePanel = null;
let jarvisResizeAnchor = { x: 0, y: 0 };
let jarvisResizeStartDist = 1;
let jarvisResizeStartScale = 1;

function jarvisResizeStart(panelEl, clientX, clientY) {
  jarvisResizePanel = panelEl;
  const r = panelEl.getBoundingClientRect();
  jarvisResizeAnchor = { x: r.left, y: r.top };  // scale from the top-left corner
  jarvisResizeStartDist = Math.hypot(clientX - r.left, clientY - r.top) || 1;
  jarvisResizeStartScale = Number(panelEl.dataset.scale || 1);
  panelEl.classList.add("jarvis-dragging");
}
function jarvisResizeMove(clientX, clientY) {
  if (!jarvisResizePanel) return;
  const d = Math.hypot(clientX - jarvisResizeAnchor.x, clientY - jarvisResizeAnchor.y);
  let scale = jarvisResizeStartScale * (d / jarvisResizeStartDist);
  scale = Math.max(0.6, Math.min(2.6, scale));
  jarvisResizePanel.dataset.scale = scale;
  jarvisResizePanel.style.transformOrigin = "top left";
  jarvisResizePanel.style.transform = `scale(${scale})`;
}
function jarvisResizeEnd() {
  if (!jarvisResizePanel) return;
  jarvisResizePanel.classList.remove("jarvis-dragging");
  try {
    const key = (jarvisResizePanel.dataset.dragKey || "jarvisPanelPos") + ":scale";
    localStorage.setItem(key, jarvisResizePanel.dataset.scale || "1");
  } catch (e) { /* fine */ }
  jarvisResizePanel = null;
}

function jarvisDragStart(panelEl, clientX, clientY) {
  jarvisDragPanel = panelEl;
  const r = panelEl.getBoundingClientRect();
  // Switch from CSS-positioned (top/left, or right for the right-side
  // widget) to explicit top/left in pixels -- can't drag a % or right-
  // anchored position incrementally, but a fixed pixel position moves cleanly.
  panelEl.style.right = "auto";
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
    const key = jarvisDragPanel.dataset.dragKey || "jarvisPanelPos";
    localStorage.setItem(key, JSON.stringify({
      top: jarvisDragPanel.style.top, left: jarvisDragPanel.style.left,
    }));
  } catch (e) { /* localStorage unavailable -- position just won't persist, fine */ }
  jarvisDragPanel = null;
}

/** Returns a cleanup function -- the panel is torn down and rebuilt fresh
 *  every time Jarvis reopens, so leaving these window-level listeners
 *  attached would stack a new set on every visit (the same class of bug
 *  the push-to-talk Enter-key listeners had earlier in this file). */
function jarvisMakeDraggable(panelEl, handleEl, storageKey) {
  panelEl.dataset.dragKey = storageKey;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (saved && saved.top && saved.left) {
      panelEl.style.right = "auto";
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
// Set by jarvisSetupGestureControl each time the panel mounts -- lets a
// tool call ("open/close the camera") drive the same real start/stop the
// toggle button uses, instead of a separate parallel path.
let jarvisCameraOpen = null;
let jarvisCameraClose = null;
// Pinch is measured RELATIVE to the hand's own size, not as a fixed
// normalized distance. A fixed threshold only works at one camera distance:
// hold your hand close and even an open hand reads as "pinched"; hold it far
// and a real pinch never gets under the threshold -- which is exactly why
// finger-dragging "didn't work". Dividing the thumb-tip/index-tip gap by the
// palm span (wrist -> middle-finger knuckle) makes it distance-invariant: a
// pinch is a pinch whether your hand fills the frame or is far away.
const PINCH_RATIO = 0.55;          // thumb-index gap as a fraction of palm span; below this = pinching

/** Pure logic, deliberately separate from the camera/model: given one
 *  frame's hand landmarks (MediaPipe's 21-point hand format) and the root
 *  element containing the draggable widgets, decides whether a pinch is
 *  happening -- and if it starts over any widget's drag handle, grabs THAT
 *  widget -- then drives the shared drag primitives accordingly. Callable
 *  directly with synthetic landmarks for testing, with no camera or model
 *  involved at all. */
let jarvisHandPrev = null;              // last pinch-point {x,y,t} for flick detection
let jarvisLastPinchTap = { el: null, t: 0 };  // for double-tap-to-expand
const FLICK_SPEED = 3.8;                // screen-widths/sec -- a real flick, not a drag
const DOUBLE_TAP_MS = 480;

function jarvisToggleExpandCard(el) {
  const expanded = el.dataset.expanded === "1";
  el.style.transformOrigin = "top left";
  if (expanded) {
    el.dataset.expanded = "0";
    const s = el.dataset.prevScale || "1";
    el.dataset.scale = s; el.style.transform = `scale(${s})`; el.style.zIndex = "45";
  } else {
    el.dataset.expanded = "1";
    el.dataset.prevScale = el.dataset.scale || "1";
    el.dataset.scale = "2.1"; el.style.transform = "scale(2.1)"; el.style.zIndex = "60";
  }
  try { jarvisPlayGestureChime(); } catch (e) { /* fine */ }
}

function jarvisProcessHandLandmarks(rootEl, landmarks, state) {
  if (!landmarks || !landmarks.length) {
    if (state.pinching) { jarvisDragEnd(); state.pinching = false; }
    if (state.resizing) { jarvisResizeEnd(); state.resizing = false; }
    jarvisHandPrev = null;
    return null;
  }
  const thumb = landmarks[4], index = landmarks[8];
  const wrist = landmarks[0], midKnuckle = landmarks[9];
  const dist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
  // Palm span = wrist to middle-finger knuckle. Stable across hand poses and
  // independent of how close the hand is to the camera, so it's a good "how
  // big is this hand in frame" yardstick to measure the pinch gap against.
  const palm = Math.hypot(wrist.x - midKnuckle.x, wrist.y - midKnuckle.y) || 0.0001;
  const pinching = (dist / palm) < PINCH_RATIO;

  // Mirrored horizontally -- a front-facing camera feels backwards
  // otherwise (move your hand right, the widget goes left).
  const midX = (thumb.x + index.x) / 2, midY = (thumb.y + index.y) / 2;
  const screenX = (1 - midX) * window.innerWidth;
  const screenY = midY * window.innerHeight;
  const now = performance.now();

  // --- FLICK: a fast hand motion drops everything and resets to idle ---
  if (jarvisHandPrev) {
    const dt = (now - jarvisHandPrev.t) / 1000;
    if (dt > 0.005) {
      const movedFrac = Math.hypot(screenX - jarvisHandPrev.x, screenY - jarvisHandPrev.y) / window.innerWidth;
      const speed = movedFrac / dt;
      // Both a real distance AND real speed -- so a tiny jitter over a tiny
      // frame gap can't divide out to a false "flick", and a normal drag
      // (slower) never trips it; only a deliberate fast flick does.
      if (movedFrac > 0.16 && speed > FLICK_SPEED) {
        if (state.pinching) jarvisDragEnd();
        if (state.resizing) jarvisResizeEnd();
        state.pinching = false; state.resizing = false;
        jarvisSetOrbState("idle");
        jarvisHandPrev = { x: screenX, y: screenY, t: now };
        return { screenX, screenY, pinching, flick: true };
      }
    }
  }
  jarvisHandPrev = { x: screenX, y: screenY, t: now };

  // Generous hit test so panels are VERY easy to grab -- pad the box out.
  const inside = (r, pad = 0) => screenX >= r.left - pad && screenX <= r.right + pad && screenY >= r.top - pad && screenY <= r.bottom + pad;

  if (pinching && !state.pinching && !state.resizing) {
    let handled = false;
    // 1. Corner resize grips first (scale).
    for (const grip of rootEl.querySelectorAll(".jf-resize")) {
      if (inside(grip.getBoundingClientRect(), 16)) { jarvisResizeStart(grip.closest(".jarvis-widget"), screenX, screenY); state.resizing = true; handled = true; break; }
    }
    // 2. Grab ANYWHERE on a data panel (much easier than the thin title bar),
    //    and double-tap (two quick pinches) on one to expand it.
    if (!handled) {
      for (const card of rootEl.querySelectorAll(".jf-datacard")) {
        if (inside(card.getBoundingClientRect(), 12)) {
          if (jarvisLastPinchTap.el === card && (now - jarvisLastPinchTap.t) < DOUBLE_TAP_MS) {
            jarvisToggleExpandCard(card);
            jarvisLastPinchTap = { el: null, t: 0 };  // consume the double-tap
          } else {
            jarvisLastPinchTap = { el: card, t: now };
            jarvisDragStart(card, screenX, screenY);
            state.pinching = true;
          }
          handled = true;
          break;
        }
      }
    }
    // 3. Any other draggable widget, grabbed by its title handle.
    if (!handled) {
      for (const handle of rootEl.querySelectorAll(".jarvis-widget-handle")) {
        if (inside(handle.getBoundingClientRect(), 6)) { jarvisDragStart(handle.closest(".jarvis-widget"), screenX, screenY); state.pinching = true; break; }
      }
    }
  } else if (pinching && state.resizing) {
    jarvisResizeMove(screenX, screenY);
  } else if (pinching && state.pinching) {
    jarvisDragMove(screenX, screenY);
  } else if (!pinching && (state.pinching || state.resizing)) {
    if (state.pinching) jarvisDragEnd();
    if (state.resizing) jarvisResizeEnd();
    state.pinching = false; state.resizing = false;
  }
  return { screenX, screenY, pinching };
}

// ---------------------------------------------------------------- trained gestures
// "Train Jarvis with my hand gestures and what to open" -- you hold a pose,
// name what it should do, and from then on holding that same pose again
// (with a confirmation chime) does that thing. A trained gesture is stored
// as a compact, scale/position-invariant feature vector: distances from the
// wrist to each fingertip and between adjacent fingertips, each divided by
// the palm size (wrist-to-middle-knuckle distance) so it doesn't matter how
// close to the camera your hand is or where in frame it's held -- only the
// POSE (which fingers are extended/together) matters, matching how a person
// actually thinks about "the gesture", not "the exact pixel position".
const JARVIS_GESTURES_KEY = "jarvisTrainedGestures";
const GESTURE_MATCH_THRESHOLD = 0.28;  // loose enough that re-performing the same gesture (never pixel-identical) still matches, tight enough to stay well clear of a genuinely different pose
const GESTURE_MATCH_COOLDOWN_MS = 2500;  // don't re-fire the same action every single frame you hold the pose

function jarvisGestureFeatureVector(landmarks) {
  const wrist = landmarks[0];
  const middleKnuckle = landmarks[9];
  const scale = Math.hypot(middleKnuckle.x - wrist.x, middleKnuckle.y - wrist.y) || 0.001;
  const tips = [4, 8, 12, 16, 20].map((i) => landmarks[i]);
  const vec = tips.map((t) => Math.hypot(t.x - wrist.x, t.y - wrist.y) / scale);
  for (let i = 0; i < tips.length - 1; i++) {
    vec.push(Math.hypot(tips[i].x - tips[i + 1].x, tips[i].y - tips[i + 1].y) / scale);
  }
  return vec;
}

function jarvisGestureDistance(a, b) {
  if (a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / a.length);
}

function jarvisLoadTrainedGestures() {
  try {
    const raw = localStorage.getItem(JARVIS_GESTURES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

function jarvisSaveTrainedGesture(name, action, vector) {
  const gestures = jarvisLoadTrainedGestures();
  gestures.push({ name, action, vector, trainedAt: new Date().toISOString() });
  try { localStorage.setItem(JARVIS_GESTURES_KEY, JSON.stringify(gestures)); } catch (e) { /* storage full/unavailable -- gesture just won't persist */ }
  return gestures;
}

function jarvisDeleteTrainedGesture(index) {
  const gestures = jarvisLoadTrainedGestures();
  gestures.splice(index, 1);
  try { localStorage.setItem(JARVIS_GESTURES_KEY, JSON.stringify(gestures)); } catch (e) {}
  return gestures;
}

/** Checks the current pose against every trained gesture and returns the
 *  closest one if it's a confident match, else null. Pure/testable --
 *  takes landmarks + the gesture list rather than reading global state. */
function jarvisMatchTrainedGesture(landmarks, gestures) {
  if (!landmarks || !landmarks.length || !gestures.length) return null;
  const vec = jarvisGestureFeatureVector(landmarks);
  let best = null, bestDist = Infinity;
  for (const g of gestures) {
    const d = jarvisGestureDistance(vec, g.vector);
    if (d < bestDist) { bestDist = d; best = g; }
  }
  return best && bestDist < GESTURE_MATCH_THRESHOLD ? best : null;
}

// Trainable actions -- deliberately the same real, already-built actions
// (panel navigation + camera dock control), not a separate parallel
// capability. "nav:" opens one of the app's real panels; everything else
// goes through the same jarvisCameraDockAction used by Jarvis's own tool.
const JARVIS_GESTURE_ACTIONS = [
  { value: "nav:orbit", label: "Open Village (home)" },
  { value: "nav:missioncontrol", label: "Open Mission Control" },
  { value: "nav:jobs", label: "Open Videos" },
  { value: "nav:channels", label: "Open Channels" },
  { value: "nav:settings", label: "Open Settings" },
  { value: "cam:fullscreen", label: "Camera: fullscreen" },
  { value: "cam:restore", label: "Camera: restore to normal size" },
  { value: "cam:center", label: "Camera: move to center" },
  { value: "cam:top-left", label: "Camera: move to top-left" },
  { value: "cam:top-right", label: "Camera: move to top-right" },
  { value: "cam:bottom-left", label: "Camera: move to bottom-left" },
  { value: "cam:bottom-right", label: "Camera: move to bottom-right" },
  // --- 12 more, added on request (bind any of these to a trained pose) ---
  { value: "stats:live", label: "Show live stats (subs/views)" },
  { value: "schedule:show", label: "Show today's posting schedule" },
  { value: "status:brief", label: "Show a quick status (jobs summary)" },
  { value: "link:youtube", label: "Open my YouTube channel" },
  { value: "link:studio", label: "Open YouTube Studio" },
  { value: "voice:talk", label: "Talk to Jarvis (start/stop mic)" },
  { value: "voice:stop", label: "Stop Jarvis talking" },
  { value: "scroll:down", label: "Scroll the current view down" },
  { value: "scroll:up", label: "Scroll the current view up" },
  { value: "refresh:data", label: "Refresh live data" },
  { value: "cam:toggle", label: "Turn the camera on/off" },
  { value: "help:guide", label: "Show the app guide (what everything does)" },
  { value: "data:cards", label: "Pop up draggable data panels" },
  { value: "data:hide", label: "Hide the data panels" },
];

function jarvisExecuteGestureAction(action) {
  if (!action) return;
  // Record non-nav actions as task steps (nav is captured in openBigPanel/
  // closeBigPanel instead, so a nav gesture isn't recorded twice).
  if (!action.startsWith("nav:")) jarvisRecordStep({ type: "action", action });
  if (action.startsWith("nav:")) {
    // Navigating leaves the Jarvis HUD, which is where the camera lives.
    // Stop the camera + gesture loop FIRST and explicitly, so it can't keep
    // running invisibly after you open something with a gesture ("Jarvis
    // thinks the camera is still on"). Idempotent with the panel teardown.
    if (jarvisCameraClose) { try { jarvisCameraClose(); } catch (e) { /* already stopped */ } }
    const which = action.slice(4);
    if (which === "orbit") closeBigPanel();
    else { openBigPanel(which); setActiveSideItem(which); }
    return;
  }
  if (action === "cam:toggle") {
    const btn = document.getElementById("jarvis-gesture-toggle");
    if (btn) btn.click();
    return;
  }
  if (action.startsWith("cam:")) { jarvisCameraDockAction(action.slice(4)); return; }

  switch (action) {
    case "stats:live": jarvisShowLiveStats(); break;
    case "schedule:show": jarvisShowScheduleToast(); break;
    case "status:brief": jarvisShowStatusToast(); break;
    case "link:youtube": jarvisOpenYouTubeChannel(); break;
    case "link:studio": window.open("https://studio.youtube.com", "_blank", "noopener"); break;
    case "voice:talk": (jarvisRecording ? jarvisStopRecording() : jarvisStartRecording()); break;
    case "voice:stop": jarvisStopSpeaking(); break;
    case "scroll:down": jarvisScrollActiveView(1); break;
    case "scroll:up": jarvisScrollActiveView(-1); break;
    case "refresh:data": jarvisRefreshReadout(); if (typeof pollActiveJob === "function") pollActiveJob(); toast("Refreshed."); break;
    case "help:guide": jarvisShowHelpGuide(); break;
    case "data:cards": jarvisShowDataCards(); break;
    case "data:hide": jarvisHideDataCards(); break;
    default: break;
  }
}

// ---------------------------------------------------------------- taught tasks
// "Teach Jarvis a task by demonstration": you hit Record, then DO the task --
// talk to Jarvis (each thing you ask), open panels, fire any gesture/quick
// action -- give it a name, and Jarvis can replay that exact sequence later on
// command. It records the ACTUAL actions (each one funnels through jarvisSend,
// openBigPanel/closeBigPanel or jarvisExecuteGestureAction), not pixels off a
// screen video, so replay is exact and reliable instead of a guess.
const JARVIS_TASKS_KEY = "jarvisTaughtTasks";
let jarvisTaskRecording = false;
let jarvisTaskReplaying = false;
let jarvisTaskSteps = [];

function jarvisLoadTasks() {
  try { return JSON.parse(localStorage.getItem(JARVIS_TASKS_KEY) || "[]"); } catch (e) { return []; }
}
function jarvisSaveTasks(tasks) {
  try { localStorage.setItem(JARVIS_TASKS_KEY, JSON.stringify(tasks)); } catch (e) { /* fine */ }
}

/** Append one step to the in-progress recording. No-op unless actively
 *  recording, and never while REPLAYING (or a replay would record itself into
 *  an ever-growing loop). Hoisted, so the choke-point functions defined
 *  earlier in the file can call it. */
function jarvisRecordStep(step) {
  if (!jarvisTaskRecording || jarvisTaskReplaying) return;
  // Drop an identical nav/action fired twice in a row (some paths both
  // navigate and fire an action) so the recorded task doesn't get noisy --
  // but never de-dupe "say" steps, since asking the same thing twice can be
  // intentional.
  const last = jarvisTaskSteps[jarvisTaskSteps.length - 1];
  if (step.type !== "say" && last && last.type === step.type &&
      last.action === step.action && last.which === step.which) return;
  jarvisTaskSteps.push(step);
  const badge = document.getElementById("jarvis-task-reccount");
  if (badge) badge.textContent = `● Recording — ${jarvisTaskSteps.length} step${jarvisTaskSteps.length === 1 ? "" : "s"}`;
}

function jarvisStartTaskRecording() {
  if (jarvisTaskReplaying) { toast("Can't record while a task is running."); return; }
  jarvisTaskRecording = true;
  jarvisTaskSteps = [];
  const btn = document.getElementById("jarvis-task-rec-btn");
  if (btn) { btn.textContent = "■ Stop & save"; btn.classList.add("copied"); }
  const badge = document.getElementById("jarvis-task-reccount");
  if (badge) { badge.style.display = "block"; badge.textContent = "● Recording — 0 steps"; }
  toast("Recording — now DO the task: talk to Jarvis, open panels, use gestures. Hit Stop when done.");
}

function jarvisStopTaskRecording() {
  jarvisTaskRecording = false;
  const btn = document.getElementById("jarvis-task-rec-btn");
  if (btn) { btn.textContent = "● Record a task"; btn.classList.remove("copied"); }
  const badge = document.getElementById("jarvis-task-reccount");
  if (badge) badge.style.display = "none";
  const steps = jarvisTaskSteps.slice();
  jarvisTaskSteps = [];
  if (!steps.length) { toast("Nothing recorded — task was empty."); return; }
  const name = (window.prompt(`Name this task (${steps.length} step${steps.length === 1 ? "" : "s"} recorded):`, "") || "").trim();
  if (!name) { toast("Task discarded (no name given)."); return; }
  const tasks = jarvisLoadTasks();
  const existing = tasks.findIndex((t) => t.name.toLowerCase() === name.toLowerCase());
  const rec = { id: "t" + Date.now().toString(36), name, steps, created_at: new Date().toISOString() };
  if (existing >= 0) tasks[existing] = { ...rec, id: tasks[existing].id }; else tasks.push(rec);
  jarvisSaveTasks(tasks);
  jarvisRenderTaskList();
  toast(`Taught Jarvis "${name}" (${steps.length} steps). Say "run ${name}" or hit ▶.`);
}

/** Replay a taught task step by step, with small pauses so each action lands
 *  before the next fires. */
async function jarvisRunTask(id) {
  const task = jarvisLoadTasks().find((t) => t.id === id);
  if (!task) { toast("Task not found."); return; }
  if (jarvisTaskRecording) { toast("Stop recording before running a task."); return; }
  if (jarvisTaskReplaying) { toast("A task is already running."); return; }
  jarvisTaskReplaying = true;
  toast(`Running "${task.name}"… (${task.steps.length} steps)`);
  try {
    for (const step of task.steps) {
      if (step.type === "nav") {
        if (step.which === "orbit") closeBigPanel(); else { openBigPanel(step.which); setActiveSideItem(step.which); }
        await new Promise((r) => setTimeout(r, 900));
      } else if (step.type === "action") {
        jarvisExecuteGestureAction(step.action);
        await new Promise((r) => setTimeout(r, 700));
      } else if (step.type === "say") {
        await jarvisSend(step.text);   // awaits Jarvis's full reply
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    toast(`Done: "${task.name}" ✓`);
  } catch (e) {
    toast(`Task "${task.name}" stopped: ${e && e.message ? e.message : e}`);
  } finally {
    jarvisTaskReplaying = false;
  }
}

function jarvisDeleteTask(id) {
  jarvisSaveTasks(jarvisLoadTasks().filter((t) => t.id !== id));
  jarvisRenderTaskList();
}

function jarvisRenderTaskList() {
  const list = document.getElementById("jarvis-task-list");
  if (!list) return;
  const tasks = jarvisLoadTasks();
  if (!tasks.length) {
    list.innerHTML = `<div class="hint">No taught tasks yet — hit “Record a task”, then demonstrate it (talk to Jarvis, open panels, use gestures) and name it.</div>`;
    return;
  }
  list.innerHTML = tasks.map((t) => `<div class="qa-row jarvis-gest-item">
      <b class="jarvis-gest-name">${escapeHtml(t.name)}</b>
      <span class="qa-status jarvis-gest-action">${t.steps.length} step${t.steps.length === 1 ? "" : "s"}</span>
      <button class="jarvis-task-run" data-id="${t.id}" title="Run this task">▶</button>
      <button class="jarvis-gesture-del" data-id="${t.id}" title="Delete this task">🗑</button>
    </div>`).join("");
  list.querySelectorAll(".jarvis-task-run").forEach((btn) =>
    btn.addEventListener("click", () => jarvisRunTask(btn.dataset.id)));
  list.querySelectorAll(".jarvis-gesture-del").forEach((btn) =>
    btn.addEventListener("click", () => {
      const t = jarvisLoadTasks().find((x) => x.id === btn.dataset.id);
      jarvisDeleteTask(btn.dataset.id);
      toast(`Deleted "${(t && t.name) || "task"}".`);
    }));
}

/** Match a typed/spoken message against a taught task's name so "run <name>",
 *  "do <name>", or just the bare name replays it. Returns true if it fired. */
function jarvisMaybeRunTaskByName(message) {
  const stripped = message.trim().toLowerCase()
    .replace(/^(hey |ok )?jarvis[,\s]+/, "").replace(/[.!?]+$/, "").trim();
  for (const t of jarvisLoadTasks()) {
    const n = t.name.toLowerCase();
    if ([n, "run " + n, "do " + n, "start " + n, "run the " + n,
         "run " + n + " task", "run task " + n].includes(stripped)) {
      jarvisRunTask(t.id);
      return true;
    }
  }
  return false;
}

/** Floating data panels around the camera view: many of them, laid out in
 *  columns going down. Each is a .jarvis-widget with a title handle (so the
 *  same hand-PINCH that moves the other widgets grabs these too) plus a corner
 *  RESIZE grip (pinch the corner and move your hand to scale it). Mouse users
 *  get drag + a scroll-to-scale on hover. Positions and scale are remembered. */
async function jarvisShowDataCards() {
  const root = document.querySelector(".jarvis-hud") || document.getElementById("bigpanel-inner");
  if (!root) { toast("Open Jarvis to summon the panels."); return; }
  jarvisHideDataCards();

  let stats = [], jobs = [], settings = {}, channels = [], notes = { notes: [] };
  try {
    [stats, jobs, settings, channels, notes] = await Promise.all([
      API("/api/jarvis/stats").then((d) => d.stats || []).catch(() => []),
      API("/api/jobs?limit=40").catch(() => []),
      API("/api/settings").catch(() => ({})),
      API("/api/channels").catch(() => []),
      API("/api/jarvis/notes?limit=5").catch(() => ({ notes: [] })),
    ]);
  } catch (e) { /* show whatever we got */ }

  const sval = (k) => { const v = settings[k]; return v && typeof v === "object" ? (v.value || "") : (v || ""); };
  const running = jobs.filter((j) => !["published", "ready_for_review", "failed", "queued"].includes(String(j.status))).length;
  const ready = jobs.filter((j) => j.status === "ready_for_review").length;
  const published = jobs.filter((j) => j.status === "published").length;
  const failed = jobs.filter((j) => j.status === "failed").length;
  const queued = jobs.filter((j) => j.status === "queued").length;
  const active = jobs.find((j) => !["published", "ready_for_review", "failed", "queued"].includes(String(j.status)));
  const conn = stats.find((s) => s.connected && !s.error) || null;
  const row = (label, val) => `<div class="jf-dc-stat"><span>${label}</span><b>${val}</b></div>`;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const madeToday = jobs.filter((j) => { const t = j.created_at ? new Date((j.created_at.endsWith("Z") ? j.created_at : j.created_at + "Z")) : null; return t && t >= todayStart && j.status !== "failed"; }).length;
  const recent = jobs.slice(0, 4);
  const lastFail = jobs.find((j) => j.status === "failed");
  const trained = (typeof jarvisLoadTrainedGestures === "function") ? jarvisLoadTrainedGestures() : [];

  // --- next scheduled post time (from the fixed slot schedule) ---
  let nextPost = "—";
  if (sval("schedule_mode") === "slots") {
    const times = sval("post_schedule_times").split(",").map((s) => s.trim()).filter(Boolean);
    const now = new Date(); const nowMin = now.getHours() * 60 + now.getMinutes();
    const upcoming = times.map((t) => { const [h, m] = t.split(":").map(Number); return { t, min: h * 60 + m }; })
      .filter((x) => x.min > nowMin).sort((a, b) => a.min - b.min)[0];
    const to12 = (hm) => { const [h, m] = hm.split(":").map(Number); const ap = h < 12 ? "am" : "pm"; const hh = ((h + 11) % 12) + 1; return m ? `${hh}:${String(m).padStart(2, "0")}${ap}` : `${hh}${ap}`; };
    nextPost = upcoming ? to12(upcoming.t) + " (today)" : (times.length ? to12(times.slice().sort()[0]) + " (tomorrow)" : "—");
  }

  const cards = [
    { key: "jfCardMetrics", title: "LIVE METRICS",
      body: conn ? row("Subscribers", (conn.subscribers || 0).toLocaleString()) + row("Views", (conn.views || 0).toLocaleString()) + row("Videos", (conn.video_count || 0).toLocaleString())
                 : `<div class="jf-dc-muted">No channel connected.</div>` },
    { key: "jfCardStatus", title: "PIPELINE",
      body: row("Rendering", running) + row("Queued", queued) + row("Ready", ready) + row("Published", published) + row("Failed", failed) },
    { key: "jfCardNow", title: "NOW RENDERING",
      body: active ? `<div class="jf-dc-line">${escapeHtml((active.title || active.topic || "Untitled").slice(0, 54))}</div><div class="jf-dc-muted">${escapeHtml(String(active.status))}</div>`
                   : `<div class="jf-dc-muted">Nothing rendering.</div>` },
    { key: "jfCardToday", title: "TODAY",
      body: row("Videos made", madeToday) + row("Published", jobs.filter((j) => j.status === "published" && (() => { const t = j.created_at ? new Date(j.created_at + "Z") : null; return t && t >= todayStart; })()).length) },
    { key: "jfCardNext", title: "NEXT POST",
      body: `<div class="jf-dc-big">${escapeHtml(nextPost)}</div><div class="jf-dc-muted">4 shorts + 1 long / day</div>` },
    { key: "jfCardSchedule", title: "SCHEDULE",
      body: sval("schedule_mode") === "slots"
        ? `<div class="jf-dc-mono">${escapeHtml(sval("post_schedule_times"))}</div><div class="jf-dc-muted">${escapeHtml(sval("post_timezone").replace("America/", ""))}</div>`
        : `<div class="jf-dc-muted">No fixed schedule.</div>` },
    { key: "jfCardRecent", title: "RECENT VIDEOS",
      body: recent.length ? recent.map((j) => `<div class="jf-dc-line small">${escapeHtml((j.title || j.topic || "Untitled").slice(0, 34))} <span class="jf-dc-muted">${escapeHtml(String(j.status).replace("ready_for_review", "ready"))}</span></div>`).join("") : `<div class="jf-dc-muted">No videos yet.</div>` },
    { key: "jfCardChannels", title: "CHANNELS",
      body: channels.length ? channels.map((c) => `<div class="jf-dc-line small">${escapeHtml(c.name)} <span class="jf-dc-muted">${c.youtube_connected ? "live" : "off"}</span></div>`).join("") : `<div class="jf-dc-muted">No channels.</div>` },
    { key: "jfCardGoal", title: "NEXT MILESTONE",
      body: conn ? (() => { const ms = _jfNextMilestone(conn.subscribers || 0); const pct = Math.min(100, Math.round(((conn.subscribers || 0) / ms) * 100)); return `<div class="jf-dc-big">${(conn.subscribers || 0)} / ${ms}</div><div class="jf-dc-meter"><div class="jf-dc-fill" style="width:${pct}%"></div></div><div class="jf-dc-muted">subscribers</div>`; })() : `<div class="jf-dc-muted">—</div>` },
    { key: "jfCardFail", title: "LAST FAILURE",
      body: lastFail ? `<div class="jf-dc-line small">${escapeHtml((lastFail.title || lastFail.topic || "Untitled").slice(0, 34))}</div><div class="jf-dc-muted">${escapeHtml((lastFail.error_message || "no message").slice(0, 60))}</div>` : `<div class="jf-dc-muted">None recently. ✓</div>` },
    { key: "jfCardGestures", title: "GESTURES",
      body: `<div class="jf-dc-big">${trained.length}</div><div class="jf-dc-muted">trained ${trained.length === 1 ? "gesture" : "gestures"}</div>` },
    { key: "jfCardNotes", title: "NOTES",
      body: (notes.notes && notes.notes.length) ? notes.notes.slice(0, 3).map((n) => `<div class="jf-dc-line small">${escapeHtml(String(n).slice(0, 40))}</div>`).join("") : `<div class="jf-dc-muted">No notes yet.</div>` },
  ];

  // Lay them out in ONE horizontal row ACROSS the camera view (fixed/viewport
  // coords from the real window size, so they land ON the feed). The left
  // edges are spread evenly from the left margin to the right margin, so every
  // panel stays fully on-screen and grabbable -- on a wide screen they sit
  // apart with clear gaps; on a narrow one they overlap a little, and you just
  // pinch-drag them apart. Vertically centred so the row reads as a single
  // band over the middle of the feed. Each is finger-scalable to enlarge
  // whichever one you're reading.
  const W = window.innerWidth, H = window.innerHeight;
  const pw = 190, mL = 16, mR = 16;
  const n = cards.length;
  const stepX = n > 1 ? (W - mL - mR - pw) / (n - 1) : 0;
  const rowTop = Math.max(60, Math.round(H * 0.5 - 75));  // ~centred (panels ~150 tall)
  cards.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "jarvis-widget jf-datacard"; el.dataset.card = "1";
    el.style.left = Math.round(mL + i * stepX) + "px";
    el.style.top = rowTop + "px";
    el.innerHTML = `<div class="jarvis-widget-handle">⠿ ${c.title}<button class="jf-datacard-close" title="Close">✕</button></div>
      <div class="jf-datacard-body">${c.body}</div><div class="jf-resize" title="Pinch/drag this corner to resize"></div>`;
    root.appendChild(el);
    // restore saved scale
    try { const s = localStorage.getItem(c.key + ":scale"); if (s) { el.dataset.scale = s; el.style.transformOrigin = "top left"; el.style.transform = `scale(${s})`; } } catch (e) { /* fine */ }
    jarvisMakeDraggable(el, el.querySelector(".jarvis-widget-handle"), c.key);
    // mouse resize on the corner grip
    const grip = el.querySelector(".jf-resize");
    grip.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); jarvisResizeStart(el, e.clientX, e.clientY); const mv = (ev) => jarvisResizeMove(ev.clientX, ev.clientY); const up = () => { jarvisResizeEnd(); window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); }; window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up); });
    // scroll to scale
    el.addEventListener("wheel", (e) => { e.preventDefault(); let s = Number(el.dataset.scale || 1) * (e.deltaY < 0 ? 1.08 : 0.93); s = Math.max(0.6, Math.min(2.6, s)); el.dataset.scale = s; el.style.transformOrigin = "top left"; el.style.transform = `scale(${s})`; try { localStorage.setItem(c.key + ":scale", String(s)); } catch (er) {} }, { passive: false });
    el.querySelector(".jf-datacard-close").addEventListener("click", () => el.remove());
  });
  toast(`${cards.length} data panels up — pinch a title bar to move, pinch a corner to resize.`);
}

function jarvisHideDataCards() {
  document.querySelectorAll(".jf-datacard[data-card]").forEach((el) => el.remove());
}

// --- gesture action helpers ---
function _jfNextMilestone(n) {
  if (n <= 0) return 10;
  if (n < 10) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  for (const m of [pow, 2 * pow, 5 * pow, 10 * pow]) if (m > n) return m;
  return 10 * pow;
}
function _jfCountUp(el, target, dur) {
  target = Number(target) || 0;
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(2, -10 * t);  // easeOutExpo
  const frame = (now) => {
    const t = Math.min(1, (now - start) / dur);
    el.textContent = Math.round(target * ease(t)).toLocaleString();
    if (t < 1) requestAnimationFrame(frame);
    else el.textContent = target.toLocaleString();
  };
  // set the final value immediately as a fallback (rAF won't tick in a
  // backgrounded tab), then animate when the tab is actually visible.
  el.textContent = target.toLocaleString();
  requestAnimationFrame(frame);
}

/** Futuristic, animated live-metrics overlay. Subs / views / videos are
 *  different units, so each is its OWN animated stat tile with a meter toward
 *  its next milestone -- never one bogus shared-axis chart. */
async function jarvisShowLiveStats() {
  if (document.getElementById("jf-stats-overlay")) return;
  let stats = [];
  try {
    const d = await API("/api/jarvis/stats");
    stats = d.stats || [];
  } catch (e) { toast("Couldn't load live stats."); return; }

  const tile = (label, value, showMeter) => {
    if (!showMeter) {
      return `<div class="jf-tile jf-tile-off"><div class="jf-tile-label">${label}</div>
        <div class="jf-tile-value">—</div><div class="jf-tile-milestone">not connected</div></div>`;
    }
    const ms = _jfNextMilestone(value);
    const pct = Math.max(2, Math.min(100, Math.round((value / ms) * 100)));
    return `<div class="jf-tile" data-count="${value}">
      <div class="jf-tile-label">${label}</div>
      <div class="jf-tile-value jf-count">0</div>
      <div class="jf-tile-meter"><div class="jf-tile-fill" data-pct="${pct}"></div></div>
      <div class="jf-tile-milestone">→ ${ms.toLocaleString()}</div></div>`;
  };

  const channelsHTML = stats.map((s) => {
    const connected = s.connected && !s.error;
    const nameLine = connected
      ? `<div class="jf-stats-channel-name">${escapeHtml(s.channel)}${s.youtube_title ? ` · <b>@${escapeHtml(s.youtube_title)}</b>` : ""}</div>`
      : `<div class="jf-stats-channel-name">${escapeHtml(s.channel)} · <span style="opacity:.7">${escapeHtml(s.error ? "stats unavailable" : "not connected")}</span></div>`;
    return `<div class="jf-stats-channel">${nameLine}
      <div class="jf-stats-tiles">
        ${tile("SUBSCRIBERS", s.subscribers, connected)}
        ${tile("TOTAL VIEWS", s.views, connected)}
        ${tile("VIDEOS", s.video_count, connected)}
      </div></div>`;
  }).join("") || `<div class="jf-stats-channel-name">No channels yet.</div>`;

  const el = document.createElement("div");
  el.className = "jf-stats-overlay"; el.id = "jf-stats-overlay";
  el.innerHTML = `<div class="jf-stats-card">
    <div class="jf-stats-head">
      <div class="jf-stats-title">LIVE METRICS</div>
      <button class="jf-stats-close" id="jf-stats-close">CLOSE ✕</button>
    </div>
    <div class="jf-stats-scan"></div>
    ${channelsHTML}</div>`;
  document.body.appendChild(el);

  // Stagger tile entrance + trigger count-up and meter fills.
  const tiles = el.querySelectorAll(".jf-tile");
  tiles.forEach((t, i) => {
    t.style.animationDelay = `${0.08 * i + 0.15}s`;
    const count = t.querySelector(".jf-count");
    const fill = t.querySelector(".jf-tile-fill");
    const target = Number(t.dataset.count || 0);
    setTimeout(() => {
      if (count) _jfCountUp(count, target, 1200);
      if (fill) fill.style.width = (fill.dataset.pct || 0) + "%";
    }, 80 * i + 260);
  });

  const close = () => el.remove();
  el.addEventListener("click", (e) => { if (e.target === el) close(); });
  document.getElementById("jf-stats-close").addEventListener("click", close);
  document.addEventListener("keydown", function esc(ev) {
    if (ev.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });
}

async function jarvisShowScheduleToast() {
  try {
    const s = await API("/api/settings").catch(() => ({}));
    const sval = (k) => { const v = s[k]; return v && typeof v === "object" ? (v.value || "") : (v || ""); };
    if (sval("schedule_mode") === "slots") {
      toast(`Schedule (${sval("post_timezone").replace("America/", "")}): ${sval("post_schedule_times")} — 4 shorts + 1 long/day`);
    } else {
      toast("No fixed schedule set.");
    }
  } catch (e) { toast("Couldn't load the schedule."); }
}

async function jarvisShowStatusToast() {
  try {
    const jobs = await API("/api/jobs?limit=30");
    const running = jobs.filter((j) => !["published", "ready_for_review", "failed", "queued"].includes(String(j.status))).length;
    const ready = jobs.filter((j) => j.status === "ready_for_review").length;
    const published = jobs.filter((j) => j.status === "published").length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    toast(`${running} rendering · ${ready} ready · ${published} published · ${failed} failed`);
  } catch (e) { toast("Couldn't load status."); }
}

async function jarvisOpenYouTubeChannel() {
  try {
    const chans = await API("/api/channels");
    const c = chans.find((x) => x.youtube_connected && x.youtube_channel_title);
    const handle = c ? c.youtube_channel_title.replace(/\s+/g, "") : "";
    window.open(handle ? `https://www.youtube.com/@${encodeURIComponent(handle)}` : "https://www.youtube.com", "_blank", "noopener");
  } catch (e) { window.open("https://www.youtube.com", "_blank", "noopener"); }
}

function jarvisScrollActiveView(dir) {
  const el = document.getElementById("bigpanel-inner")
    || document.getElementById("jarvis-log")
    || document.scrollingElement || document.body;
  const amount = Math.round((el.clientHeight || 400) * 0.7) * dir;
  try { el.scrollBy({ top: amount, behavior: "smooth" }); } catch (e) { el.scrollTop += amount; }
}

function jarvisStopSpeaking() {
  try { if (jarvisSpeakAudio) { jarvisSpeakAudio.pause(); jarvisSpeakAudio = null; } } catch (e) { /* nothing playing */ }
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* fine */ }
  jarvisSetOrbState("idle");
  if (typeof jarvisSetBusy === "function") jarvisSetBusy(false); else jarvisBusy = false;
}

function jarvisShowHelpGuide() {
  if (document.getElementById("jarvis-help-overlay")) return;
  const gestureRows = JARVIS_GESTURE_ACTIONS.map((a) =>
    `<tr><td style="padding:3px 10px 3px 0;opacity:.85">${escapeHtml(a.label)}</td></tr>`
  ).join("");
  const el = document.createElement("div");
  el.id = "jarvis-help-overlay";
  el.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(4,8,16,0.82);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:24px";
  el.innerHTML = `
    <div style="max-width:640px;max-height:86vh;overflow:auto;background:rgba(10,16,28,0.96);border:1px solid rgba(120,170,255,0.35);border-radius:12px;padding:22px 26px;color:var(--ink,#e8ecef);font-family:var(--font-body,sans-serif);line-height:1.55">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h2 style="margin:0;font-size:18px">How this app works</h2>
        <button id="jarvis-help-close" style="background:transparent;border:1px solid rgba(255,255,255,.3);color:inherit;border-radius:6px;padding:3px 10px;cursor:pointer">Close ✕</button>
      </div>
      <p style="margin:6px 0"><b>What it does:</b> it automatically writes, voices, illustrates, and publishes videos to your channels on a schedule — you don't touch each one.</p>
      <p style="margin:6px 0"><b>The panels</b> (left sidebar, or say them to Jarvis):</p>
      <ul style="margin:4px 0 10px 18px;padding:0">
        <li><b>Mission Control</b> — live stats and a feed of what every agent is doing right now.</li>
        <li><b>Videos</b> — every video, its status (rendering / ready / published / failed), and its log.</li>
        <li><b>Channels</b> — your channels, their niche, connections, and automation.</li>
        <li><b>Settings</b> — API keys, voice, and the posting schedule.</li>
        <li><b>Jarvis</b> — talk or type to run any of it hands-free.</li>
      </ul>
      <p style="margin:6px 0"><b>Jarvis</b> can check jobs, pull live subs/views, retry or start videos, and more — hold 🎤 (or Enter) and speak, or type.</p>
      <p style="margin:10px 0 4px"><b>Camera gestures</b> — turn on the camera, then train your own hand poses (hold a pose, name it, bind it to one of these actions, save):</p>
      <table style="border-collapse:collapse;font-size:13px">${gestureRows}</table>
    </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.addEventListener("click", (e) => { if (e.target === el) close(); });
  document.getElementById("jarvis-help-close").addEventListener("click", close);
}


let jarvisGestureTrainingArmed = false;
let jarvisLastGestureMatchAt = 0;

/** Kicks off training: a short countdown so you have time to get into
 *  position, then the next still frame is captured as the new gesture's
 *  pose. The actual save (name + action binding) happens in the small
 *  form jarvisCaptureTrainedGesture reveals once it has a vector. */
function jarvisStartGestureTraining() {
  const status = document.getElementById("jarvis-gesture-train-status");
  if (status) status.textContent = "Hold your gesture… capturing in 3";
  let n = 3;
  const tick = setInterval(() => {
    n -= 1;
    if (status) status.textContent = n > 0 ? `Hold your gesture… capturing in ${n}` : "Capturing…";
    if (n <= 0) {
      clearInterval(tick);
      jarvisGestureTrainingArmed = true;
    }
  }, 700);
}

function jarvisCaptureTrainedGesture(landmarks) {
  const vector = jarvisGestureFeatureVector(landmarks);
  const form = document.getElementById("jarvis-gesture-train-form");
  const status = document.getElementById("jarvis-gesture-train-status");
  if (status) status.textContent = "Captured. Name it and pick what it should do:";
  if (!form) return;
  form.style.display = "flex";
  form.dataset.pendingVector = JSON.stringify(vector);
}

function jarvisSaveGestureFromForm() {
  const form = document.getElementById("jarvis-gesture-train-form");
  const nameInput = document.getElementById("jarvis-gesture-name");
  const actionSelect = document.getElementById("jarvis-gesture-action");
  if (!form || !form.dataset.pendingVector) return;
  const name = (nameInput.value || "").trim() || "Untitled gesture";
  const action = actionSelect.value;
  const vector = JSON.parse(form.dataset.pendingVector);
  jarvisSaveTrainedGesture(name, action, vector);
  jarvisPlayGestureChime();
  toast(`Trained "${name}" -- hold that pose again to trigger it.`);
  form.style.display = "none";
  delete form.dataset.pendingVector;
  nameInput.value = "";
  const status = document.getElementById("jarvis-gesture-train-status");
  if (status) status.textContent = "";
  jarvisRenderTrainedGesturesList();
}

function jarvisRenderTrainedGesturesList() {
  const list = document.getElementById("jarvis-gesture-list");
  if (!list) return;
  const gestures = jarvisLoadTrainedGestures();
  if (!gestures.length) {
    list.innerHTML = `<div class="hint">No gestures yet — train one: hold a pose, name it, pick an action, save.</div>`;
    return;
  }
  list.innerHTML = gestures.map((g, i) => {
    const found = JARVIS_GESTURE_ACTIONS.find((a) => a.value === g.action);
    return `<div class="qa-row jarvis-gest-item">
      <b class="jarvis-gest-name">${escapeHtml(g.name)}</b>
      <span class="qa-status jarvis-gest-action">${escapeHtml(found ? found.label : g.action)}</span>
      <button class="jarvis-gesture-del" data-idx="${i}" title="Delete this gesture">🗑 Delete</button>
    </div>`;
  }).join("") +
  `<button id="jarvis-gesture-clear-all" class="jarvis-gesture-clear">Clear ALL gestures</button>`;

  list.querySelectorAll(".jarvis-gesture-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.idx);
      const name = (jarvisLoadTrainedGestures()[i] || {}).name || "gesture";
      jarvisDeleteTrainedGesture(i);
      jarvisRenderTrainedGesturesList();
      toast(`Deleted "${name}".`);
    });
  });
  const clearAll = document.getElementById("jarvis-gesture-clear-all");
  if (clearAll) clearAll.addEventListener("click", () => {
    if (window.confirm("Delete ALL trained gestures? This can't be undone.")) {
      try { localStorage.removeItem(JARVIS_GESTURES_KEY); } catch (e) { /* fine */ }
      jarvisRenderTrainedGesturesList();
      toast("All gestures cleared.");
    }
  });
}

/** A clean, distinct confirmation chime -- separate from jarvisPlayTone's
 *  thinking/alert sounds so a recognized gesture doesn't sound like either
 *  of those. A short two-note rising ping. */
function jarvisPlayGestureChime() {
  const ctx = _jarvisAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  [[720, 0], [960, 0.09]].forEach(([freq, start]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now + start);
    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(0.07, now + start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + start + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + 0.15);
  });
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

/** The client-side half of the control_camera_dock tool -- Claude decides
 *  WHETHER and WHEN to do this from the conversation (a real tool call,
 *  not a keyword match on my end); this is just the DOM action once it
 *  has, since the backend tool itself can't touch the page. */
// "center" used to be the only place the camera dock could be moved to on
// request -- these are the actual named spots Jarvis can now move it to.
const JARVIS_DOCK_SPOTS = {
  "center": (r) => ({ top: (window.innerHeight - r.height) / 2, left: (window.innerWidth - r.width) / 2 }),
  "top-left": () => ({ top: 20, left: 20 }),
  "top-right": (r) => ({ top: 20, left: window.innerWidth - r.width - 20 }),
  "bottom-left": (r) => ({ top: window.innerHeight - r.height - 20, left: 20 }),
  "bottom-right": (r) => ({ top: window.innerHeight - r.height - 20, left: window.innerWidth - r.width - 20 }),
};

function jarvisCameraDockAction(action) {
  const dock = document.querySelector(".jarvis-camdock");
  if (!dock) return;
  const hud = document.querySelector(".jarvis-hud");
  if (action === "open") { if (jarvisCameraOpen) jarvisCameraOpen(); }
  else if (action === "close") { if (jarvisCameraClose) jarvisCameraClose(); }
  else if (action === "expand") { dock.classList.add("jf-expanded"); }
  else if (action === "shrink") { dock.classList.remove("jf-expanded"); }
  else if (action === "fullscreen") {
    dock.classList.add("jf-fullscreen");
    if (hud) hud.classList.add("jf-camera-fullscreen");
  } else if (action === "restore") {
    dock.classList.remove("jf-fullscreen", "jf-expanded");
    if (hud) hud.classList.remove("jf-camera-fullscreen");
  } else if (JARVIS_DOCK_SPOTS[action]) {
    const rect = dock.getBoundingClientRect();
    const spot = JARVIS_DOCK_SPOTS[action](rect);
    const top = Math.max(20, Math.min(window.innerHeight - rect.height - 20, spot.top));
    const left = Math.max(20, Math.min(window.innerWidth - rect.width - 20, spot.left));
    dock.style.right = "auto";
    dock.style.top = `${top}px`;
    dock.style.left = `${left}px`;
    try { localStorage.setItem("jarvisCamPos", JSON.stringify({ top: `${top}px`, left: `${left}px` })); } catch (e) {}
  }
}

/** The "futuristic tabs to open things" ask -- appears the moment gesture
 *  control turns on, gone the moment it turns off, real data throughout
 *  (no invented content): recent video jobs, channels, and saved notes.
 *  Deliberately NOT a raw file-browser tab -- that would mean a new public
 *  REST endpoint exposing the whole project tree with no LLM-mediated
 *  whitelist in front of it, a materially bigger exposure than anything
 *  else built so far. Notes covers the "files" instinct safely instead. */
function jarvisShowQuickAccess() {
  const panel = document.getElementById("jarvis-quickaccess");
  if (!panel) return;
  panel.style.display = "block";
  jarvisLoadQuickAccessTab("jobs");
}

function jarvisHideQuickAccess() {
  const panel = document.getElementById("jarvis-quickaccess");
  if (panel) panel.style.display = "none";
}

async function jarvisLoadQuickAccessTab(tab) {
  const panel = document.getElementById("jarvis-qa-panel");
  if (!panel) return;
  panel.innerHTML = `<div class="hint">Loading…</div>`;
  try {
    if (tab === "jobs") {
      const jobs = await API("/api/jobs?limit=15");
      panel.innerHTML = jobs.length
        ? jobs.map((j) => `<div class="qa-row"><b>${escapeHtml(j.title || j.topic || "Untitled")}</b><span class="qa-status qa-${escapeHtml(String(j.status))}">${escapeHtml(String(j.status))}</span></div>`).join("")
        : `<div class="hint">No jobs yet.</div>`;
    } else if (tab === "channels") {
      const channels = await API("/api/channels");
      panel.innerHTML = channels.length
        ? channels.map((c) => `<div class="qa-row"><b>${escapeHtml(c.name)}</b><span class="qa-status">${c.auto_enabled ? `${c.auto_per_day}/day` : "manual"}</span></div>`).join("")
        : `<div class="hint">No channels yet.</div>`;
    } else if (tab === "notes") {
      const r = await API("/api/jarvis/notes?limit=10");
      panel.innerHTML = (r.notes && r.notes.length)
        ? r.notes.map((n) => `<div class="qa-row qa-note">${escapeHtml(n)}</div>`).join("")
        : `<div class="hint">No notes yet -- ask Jarvis to save one.</div>`;
    }
  } catch (e) {
    panel.innerHTML = `<div class="hint">Couldn't load that right now.</div>`;
  }
}

function jarvisSetupGestureControl(panelEl) {
  // `running` used to be the only flag the toggle checked, but it only
  // becomes true once hand-tracking finishes loading (a CDN fetch that
  // takes a couple seconds) -- clicking "off" during that window re-ran
  // start() instead of stop(), which is exactly the "nothing happens when
  // I try to turn it off" bug. `active` flips the instant the button is
  // clicked, and `genId` invalidates any start() still in flight so a
  // stop() mid-load actually wins instead of being silently overwritten
  // by the load finishing afterward.
  const state = { pinching: false, resizing: false, running: false, active: false, genId: 0 };
  let videoEl = null;

  const toggle = document.getElementById("jarvis-gesture-toggle");
  const empty = document.getElementById("jarvis-camdock-empty");

  const stop = () => {
    state.active = false;
    state.running = false;
    state.genId++;
    if (jarvisGestureRAF) cancelAnimationFrame(jarvisGestureRAF);
    jarvisGestureRAF = null;
    if (jarvisCameraStream) { jarvisCameraStream.getTracks().forEach((t) => t.stop()); jarvisCameraStream = null; }
    if (videoEl) videoEl.style.display = "none";
    if (empty) empty.style.display = "block";
    if (toggle) { toggle.textContent = "📷 Gesture Control: Off"; toggle.classList.remove("copied"); }
    jarvisCameraDockAction("restore");
    jarvisHideQuickAccess();
    jarvisHideDataCards();  // clear the floating panels when the camera turns off
    const gw = document.getElementById("jarvis-gestures-widget");
    if (gw) gw.style.display = "none";
  };

  const start = async () => {
    if (state.active) return;  // already on, or already turning on -- ignore a duplicate press
    state.active = true;
    const myGen = ++state.genId;
    if (toggle) toggle.textContent = "📷 Starting…";

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("This browser doesn't support camera access.");
      state.active = false;
      if (toggle) toggle.textContent = "📷 Gesture Control: Off";
      return;
    }
    try {
      jarvisCameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: 240, height: 180 } });
    } catch (e) {
      toast("Camera permission denied or unavailable.");
      state.active = false;
      if (toggle) toggle.textContent = "📷 Gesture Control: Off";
      return;
    }
    if (myGen !== state.genId) {  // stop() ran while we were waiting on permission
      jarvisCameraStream.getTracks().forEach((t) => t.stop());
      jarvisCameraStream = null;
      return;
    }

    videoEl = document.getElementById("jarvis-cam-video");
    if (!videoEl) return;
    videoEl.srcObject = jarvisCameraStream;
    await videoEl.play();
    if (myGen !== state.genId) { stop(); return; }
    videoEl.style.display = "block";
    if (empty) empty.style.display = "none";
    if (toggle) { toggle.textContent = "📷 Gesture Control: On"; toggle.classList.add("copied"); }
    // Opening the camera used to leave it as the small 160px dock -- "large
    // camera control" and gesture tracking both want a feed you can
    // actually see and gesture in front of, so opening it now goes
    // straight to the same fullscreen mode the "make it fullscreen" tool
    // call uses, not a separate path.
    jarvisCameraDockAction("fullscreen");
    jarvisShowQuickAccess();
    const gw = document.getElementById("jarvis-gestures-widget");
    if (gw) gw.style.display = "block";
    jarvisRenderTrainedGesturesList();
    jarvisShowDataCards();  // the floating data panels appear on the camera page

    // Hand-tracking loads 3 separate resources from external CDNs (jsdelivr
    // twice, storage.googleapis.com once) -- ANY blip there (a firewall, an
    // ad-blocker, a transient CDN hiccup) used to call stop() here, which
    // tore the whole camera back down even though getUserMedia had already
    // succeeded and the plain video feed was fine. That's exactly the "shows
    // me for a second then goes away" symptom: the camera was genuinely
    // working, this unrelated failure killed it anyway. Now a model-load
    // failure only disables GESTURES -- the camera preview stays up.
    let model = null;
    try {
      model = await jarvisLoadHandModel();
    } catch (e) {
      toast("Camera's on, but hand-tracking couldn't load (check your connection) -- gestures are off for now.");
    }
    if (myGen !== state.genId) return;  // stopped while the model was loading
    if (!model) return;  // camera stays up; just no gesture loop to run

    state.running = true;
    const loop = () => {
      if (!state.running || myGen !== state.genId) return;
      try {
        const result = model.detectForVideo(videoEl, performance.now());
        const landmarks = result.landmarks && result.landmarks[0];
        jarvisProcessHandLandmarks(panelEl, landmarks, state);
        // Only look at a still, un-pinched hand -- mid-drag or mid-pinch
        // isn't a "held pose" and shouldn't be mistaken for a trained one.
        if (landmarks && !state.pinching) {
          if (jarvisGestureTrainingArmed) {
            jarvisGestureTrainingArmed = false;
            jarvisCaptureTrainedGesture(landmarks);
          } else {
            const now = performance.now();
            // Only YOUR trained gestures fire -- no pre-made poses.
            if (now - jarvisLastGestureMatchAt > GESTURE_MATCH_COOLDOWN_MS) {
              const match = jarvisMatchTrainedGesture(landmarks, jarvisLoadTrainedGestures());
              if (match) {
                jarvisLastGestureMatchAt = now;
                jarvisPlayGestureChime();
                toast(`Gesture recognized: ${match.name}`);
                jarvisExecuteGestureAction(match.action);
              }
            }
          }
        }
      } catch (e) { /* a single bad frame isn't worth stopping the whole feature over */ }
      jarvisGestureRAF = requestAnimationFrame(loop);
    };
    loop();
  };

  if (toggle) {
    toggle.addEventListener("click", () => { state.active ? stop() : start(); });
  }

  jarvisCameraOpen = start;
  jarvisCameraClose = stop;

  return stop;
}

// ---------------------------------------------------------------- HUD art
// Inline SVG for the cockpit frame and glyphs -- no external assets, matches
// the app's "no build step" approach. Structurally modeled on the reference
// layout (angular corner brackets, arc gauges, scattered widgets) but every
// piece of content is either abstract/generic or real app data -- nothing
// here references or resembles the specific reference image's subject.
/** A small hexagon outline, for the edge-panel texture strips. */
function _hex(cx, cy, r) {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  return `<polygon points="${pts}" class="jf-hex" />`;
}
function _hexColumn(x, yStart, yEnd, r) {
  const out = [];
  for (let y = yStart, i = 0; y < yEnd; y += r * 1.9, i++) {
    out.push(_hex(x + (i % 2 ? r * 0.9 : 0), y, r));
  }
  return out.join("");
}
function _ticks(x1, x2, y, count) {
  const out = [];
  for (let i = 0; i <= count; i++) {
    const x = x1 + ((x2 - x1) * i) / count;
    out.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${y + (i % 4 === 0 ? 14 : 7)}" class="jf-dim" stroke-width="1.5"/>`);
  }
  return out.join("");
}

function jarvisFrameSVG() {
  return `<svg class="jarvis-frame" viewBox="0 0 1920 1080" preserveAspectRatio="none">
    <!-- corner brackets: double-line viewfinder style -->
    <path d="M20,140 L20,20 L140,20" />
    <path d="M36,140 L36,36 L140,36" class="jf-dim" />
    <path d="M1900,140 L1900,20 L1780,20" />
    <path d="M1884,140 L1884,36 L1780,36" class="jf-dim" />
    <path d="M20,940 L20,1060 L140,1060" />
    <path d="M36,940 L36,1044 L140,1044" class="jf-dim" />
    <path d="M1900,940 L1900,1060 L1780,1060" />
    <path d="M1884,940 L1884,1044 L1780,1044" class="jf-dim" />

    <!-- small indicator clusters, top corners -->
    <rect x="50" y="55" width="10" height="10" />
    <rect x="66" y="55" width="10" height="10" class="jf-dim" />
    <rect x="82" y="55" width="10" height="10" class="jf-dim" />
    <circle cx="1850" cy="60" r="5" />
    <circle cx="1866" cy="60" r="5" class="jf-dim" />
    <circle cx="1882" cy="60" r="5" class="jf-dim" />

    <!-- top arc under the clock, with tick marks -->
    <path d="M700,14 A420,420 0 0 1 1220,14" />
    ${_ticks(700, 1220, 14, 24)}

    <!-- bottom chevron + rule -->
    <path d="M840,1055 L960,1005 L1080,1055" class="jf-dim" />
    <line x1="300" y1="1062" x2="820" y2="1062" class="jf-dim" stroke-width="1.5" />
    <line x1="1100" y1="1062" x2="1620" y2="1062" class="jf-dim" stroke-width="1.5" />

    <!-- edge hex-panel texture -->
    <line x1="4" y1="180" x2="4" y2="900" stroke-width="1.5" class="jf-dim" />
    <line x1="1916" y1="180" x2="1916" y2="900" stroke-width="1.5" class="jf-dim" />
    <g transform="translate(0,220)">${_hexColumn(20, 0, 620, 16)}</g>
    <g transform="translate(1870,220)">${_hexColumn(20, 0, 620, 16)}</g>
    <circle cx="15" cy="300" r="3" class="jf-fill" />
    <circle cx="15" cy="780" r="3" class="jf-fill" />
    <circle cx="1905" cy="300" r="3" class="jf-fill" />
    <circle cx="1905" cy="780" r="3" class="jf-fill" />
  </svg>`;
}

function jarvisWorldMapSVG() {
  // Abstract dotted landmass shapes -- ambient decoration only, no real
  // geodata, deliberately not meant to read as any specific place.
  const dots = [];
  for (let i = 0; i < 70; i++) {
    const x = 20 + ((i * 37) % 260);
    const y = 10 + Math.floor(i / 9) * 12 + ((i * 13) % 5);
    if ((i * 29) % 4 === 0) continue;
    dots.push(`<circle cx="${x}" cy="${y}" r="1.4" class="jf-fill" opacity="0.35"/>`);
  }
  return `<svg class="jarvis-worldmap" style="position:absolute;bottom:16px;left:16px;width:260px;height:80px;opacity:0.6" viewBox="0 0 280 90">${dots.join("")}</svg>`;
}

function jarvisRadarSVG() {
  return `<svg class="jarvis-radar" style="position:absolute;bottom:20px;right:20px;width:100px;height:100px;opacity:0.55" viewBox="0 0 100 100">
    <circle cx="50" cy="50" r="46"/><circle cx="50" cy="50" r="30"/><circle cx="50" cy="50" r="14"/>
    <line x1="50" y1="4" x2="50" y2="96" class="jf-dim"/><line x1="4" y1="50" x2="96" y2="50" class="jf-dim"/>
  </svg>`;
}

/** The center emblem -- a chip die with circuit traces radiating outward,
 *  not a person. jarvis-orb-ring / jarvis-eq / the state class on
 *  .jarvis-center-emblem are the real functional hooks, matched by
 *  jarvisSetOrbState (idle/listening/thinking/speaking/alert). */
/** One elbowed circuit trace from the chip's edge out toward the frame --
 *  own line art (not the reference photo, which carries a stock-site
 *  watermark neither reproduced nor referenced here). Snaps its second leg
 *  to a 45deg step so it reads as a circuit trace, not a straight ray, and
 *  optionally forks a shorter side-branch partway along, the way the
 *  reference's traces split rather than running as lone straight rays. */
function _circuitTrace(cx, cy, angleDeg, r1, r2, seed) {
  const rad = (angleDeg * Math.PI) / 180;
  const x1 = cx + Math.cos(rad) * r1, y1 = cy + Math.sin(rad) * r1;
  const bendDeg = Math.round(angleDeg / 45) * 45 + ((seed % 2) * 2 - 1) * 15;
  const rad2 = (bendDeg * Math.PI) / 180;
  const x2 = x1 + Math.cos(rad2) * (r2 - r1), y2 = y1 + Math.sin(rad2) * (r2 - r1);
  let branch = "";
  if (seed % 3 === 0) {
    // fork off roughly 60% of the way along the second leg
    const bx = x1 + (x2 - x1) * 0.6, by = y1 + (y2 - y1) * 0.6;
    const branchDeg = bendDeg + ((seed % 2) * 2 - 1) * 45;
    const branchRad = (branchDeg * Math.PI) / 180;
    const blen = 22 + (seed % 3) * 10;
    branch = { x2: bx + Math.cos(branchRad) * blen, y2: by + Math.sin(branchRad) * blen, x1: bx, y1: by };
  }
  return {
    d: `M${cx.toFixed(1)},${cy.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)}`,
    x2, y2, branch,
  };
}

/** The dense field of tiny vias and trace stubs that filled the background
 *  of the reference photo, plus a handful of soft bright "bloom" highlights
 *  like the specular hot-spots scattered along its lines. Deterministic
 *  pseudo-random placement (index-driven, no Math.random) so it's stable
 *  across re-renders, same approach as jarvisWorldMapSVG's dot scatter. */
function _pcbTexture(cx, cy, rInner, rOuter) {
  const out = [];
  for (let i = 0; i < 190; i++) {
    // two co-prime-ish strides so the scatter doesn't visibly repeat
    const angle = (i * 137.5) % 360;
    const rad = (angle * Math.PI) / 180;
    const dist = rInner + ((i * 53) % (rOuter - rInner));
    const x = cx + Math.cos(rad) * dist, y = cy + Math.sin(rad) * dist;
    if (i % 11 === 0) {
      // an occasional bright bloom, like the reference's specular highlights
      out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${3 + (i % 3)}" class="jf-pcb-bloom"/>`);
    } else if (i % 3 === 0) {
      out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${1.4 + (i % 3) * 0.5}" class="jf-pcb"/>`);
    } else {
      const legAngle = Math.round(angle / 90) * 90 + ((i % 2) * 2 - 1) * 45;
      const legRad = (legAngle * Math.PI) / 180;
      const len = 7 + (i % 5) * 4;
      const x2 = x + Math.cos(legRad) * len, y2 = y + Math.sin(legRad) * len;
      out.push(`<line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="jf-pcb" stroke-width="${1 + (i % 3) * 0.5}"/>`);
    }
  }
  return out.join("");
}

function jarvisGlyphSVG() {
  const cx = 220, cy = 220, chipR = 70;
  const traceCount = 24;
  const pcbBg = _pcbTexture(cx, cy, chipR + 18, 216);
  let traces = "";
  for (let i = 0; i < traceCount; i++) {
    const angle = (360 / traceCount) * i + (i % 3) * 5;
    // organic, uneven reach -- not every trace makes it to the frame edge
    const r2 = 150 + ((i * 17) % 66);
    const t = _circuitTrace(cx, cy, angle, chipR, r2, i);
    const dash = 50 + (i % 5) * 12;
    const width = 1.3 + (i % 3) * 0.5;
    traces += `<path d="${t.d}" class="jf-trace" style="stroke-dasharray:${dash};stroke-width:${width}" />`;
    traces += `<circle cx="${t.x2}" cy="${t.y2}" r="${2.6 + (i % 3) * 0.6}" class="jf-trace-node" />`;
    if (t.branch) {
      traces += `<line x1="${t.branch.x1.toFixed(1)}" y1="${t.branch.y1.toFixed(1)}" x2="${t.branch.x2.toFixed(1)}" y2="${t.branch.y2.toFixed(1)}" class="jf-trace" stroke-width="1"/>`;
      traces += `<circle cx="${t.branch.x2}" cy="${t.branch.y2}" r="2" class="jf-trace-node"/>`;
    }
  }
  // The chip: a dark body with small pin ticks along each edge, and a
  // lighter die square in the middle -- JARVIS sits across the die.
  const half = 46, pins = [];
  for (let i = -3; i <= 3; i++) {
    pins.push(`<line x1="${cx - half - 8}" y1="${cy + i * 12}" x2="${cx - half}" y2="${cy + i * 12}" class="jf-pin"/>`);
    pins.push(`<line x1="${cx + half}" y1="${cy + i * 12}" x2="${cx + half + 8}" y2="${cy + i * 12}" class="jf-pin"/>`);
    pins.push(`<line x1="${cx + i * 12}" y1="${cy - half - 8}" x2="${cx + i * 12}" y2="${cy - half}" class="jf-pin"/>`);
    pins.push(`<line x1="${cx + i * 12}" y1="${cy + half}" x2="${cx + i * 12}" y2="${cy + half + 8}" class="jf-pin"/>`);
  }

  return `<svg id="jarvis-orb" class="jarvis-glyph" viewBox="0 0 440 440">
    ${pcbBg}
    ${traces}
    ${pins.join("")}
    <rect x="${cx - half}" y="${cy - half}" width="${half * 2}" height="${half * 2}" rx="4" class="jf-chip-body" id="jarvis-orb-ring"/>
    <rect x="${cx - half + 14}" y="${cy - half + 14}" width="${(half - 14) * 2}" height="${(half - 14) * 2}" rx="2" class="jf-chip-die"/>
    <text x="${cx}" y="${cy + 4}" text-anchor="middle" class="jf-chip-label">JARVIS</text>
  </svg>`;
}

const JARVIS_AGENT_IDS = ["athena", "iris", "hephaestus"];
function jarvisAgentGlyphSVG(working) {
  return `<svg width="44" height="56" viewBox="0 0 44 56">
    <path d="M22,4 L38,14 L38,42 L22,52 L6,42 L6,14 Z" stroke="var(--cyan)" stroke-width="1.6" opacity="${working ? 1 : 0.9}"/>
    <circle cx="22" cy="22" r="6" stroke="var(--cyan)" stroke-width="1.4"/>
    <line x1="22" y1="28" x2="22" y2="42" stroke="var(--cyan)" stroke-width="1.4"/>
    <circle cx="22" cy="22" r="2.4" fill="var(--cyan)" opacity="${working ? 1 : 0.6}"/>
  </svg>`;
}

function jarvisArcGaugeSVG(frac) {
  const r = 50, cx = 60, cy = 60;
  const start = Math.PI, end = Math.PI + Math.PI * Math.max(0, Math.min(1, frac));
  const x1 = cx + r * Math.cos(start), y1 = cy + r * Math.sin(start);
  const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
  const large = frac > 0.5 ? 1 : 0;
  return `<svg width="130" height="70" viewBox="0 0 120 65">
    <path d="M10,60 A50,50 0 0 1 110,60" stroke="var(--border)" stroke-width="6" opacity="0.4"/>
    <path d="M${x1 - 0},${y1 - 0} A${r},${r} 0 ${large} 1 ${x2},${y2}" stroke="var(--cyan)" stroke-width="6" stroke-linecap="round"/>
  </svg>`;
}

function jarvisDialSVG() {
  return `<svg viewBox="0 0 190 190">
    <circle cx="95" cy="95" r="86" stroke="var(--border)" stroke-width="2"/>
    <circle cx="95" cy="95" r="86" id="jarvis-dial-ring" stroke="var(--green)" stroke-width="3" stroke-dasharray="540" stroke-dashoffset="0" transform="rotate(-90 95 95)"/>
    <circle cx="95" cy="95" r="70" stroke="var(--border)" stroke-width="1" opacity="0.5"/>
  </svg>`;
}

async function renderJarvisPanel(body) {
  // Pick up the last conversation instead of always starting fresh --
  // restored below (after the log DOM exists) rather than reset here.
  const savedConvo = jarvisLoadConversation();
  jarvisHistory = (savedConvo && savedConvo.history) || [];
  jarvisTranscript = [];
  jarvisSeenBlockedIds = null;
  jarvisBusy = false;
  jarvisKeyHeld = false;
  body.innerHTML = `<div class="jarvis-page">
    <div class="jarvis-hud">
      ${jarvisFrameSVG()}
      ${jarvisWorldMapSVG()}
      ${jarvisRadarSVG()}
      <div class="jarvis-clock" id="jarvis-clock">00:00</div>
      <div class="jarvis-gauge">
        ${jarvisArcGaugeSVG(0)}
        <div class="jarvis-gauge-value" id="jarvis-gauge-value">0/0</div>
        <div class="jarvis-gauge-label">Today's videos</div>
      </div>
      <svg class="jarvis-spin" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" stroke="currentColor" stroke-width="2" stroke-dasharray="18 82"/></svg>

      <div class="jarvis-widget jarvis-camdock" id="jarvis-cam-preview">
        <div class="jarvis-widget-handle">⠿ Camera</div>
        <div class="jarvis-camdock-body">
          <video id="jarvis-cam-video" width="180" height="135" muted playsinline style="display:none"></video>
          <div class="jarvis-camdock-empty" id="jarvis-camdock-empty">No camera connected.<br>Click below to enable gesture control.</div>
        </div>
        <button class="jarvis-gesture-btn" id="jarvis-gesture-toggle" title="Toggle webcam gesture control">📷 Gesture Control: Off</button>
      </div>

      <div class="jarvis-widget jarvis-gestures" id="jarvis-gestures-widget" style="display:none">
        <div class="jarvis-widget-handle">⠿ Train Gestures</div>
        <button class="jarvis-gesture-btn" id="jarvis-gesture-train-btn">✋ Hold a pose to train</button>
        <div class="jarvis-gesture-train-status" id="jarvis-gesture-train-status"></div>
        <div class="jarvis-gesture-train-form" id="jarvis-gesture-train-form" style="display:none">
          <input type="text" id="jarvis-gesture-name" placeholder="Name this gesture…"/>
          <select id="jarvis-gesture-action">
            ${JARVIS_GESTURE_ACTIONS.map((a) => `<option value="${a.value}">${a.label}</option>`).join("")}
          </select>
          <button class="jarvis-gesture-btn" id="jarvis-gesture-save-btn">Save gesture</button>
        </div>
        <div class="jarvis-gesture-list" id="jarvis-gesture-list"></div>
      </div>

      <div class="jarvis-widget jarvis-tasks" id="jarvis-tasks-widget">
        <div class="jarvis-widget-handle">⠿ Teach a Task</div>
        <button class="jarvis-gesture-btn" id="jarvis-task-rec-btn" title="Record yourself doing a task, then Jarvis can repeat it">● Record a task</button>
        <div class="jarvis-task-reccount" id="jarvis-task-reccount" style="display:none"></div>
        <div class="jarvis-gesture-list" id="jarvis-task-list"></div>
      </div>

      <div class="jarvis-widget jarvis-quickaccess" id="jarvis-quickaccess" style="display:none">
        <div class="jarvis-widget-handle">⠿ Quick Access</div>
        <div class="jarvis-tabs">
          <button class="jarvis-tab qa-tab active" data-qa-tab="jobs">Jobs</button>
          <button class="jarvis-tab qa-tab" data-qa-tab="channels">Channels</button>
          <button class="jarvis-tab qa-tab" data-qa-tab="notes">Notes</button>
        </div>
        <div class="jarvis-tabpanel" id="jarvis-qa-panel"><div class="hint">Loading…</div></div>
      </div>

      <div class="jarvis-nav-stack" id="jarvis-nav-stack">
        <button class="jarvis-nav-item" data-nav="orbit">🏘️ Village</button>
        <button class="jarvis-nav-item" data-nav="missioncontrol">🛰️ Mission Control</button>
        <button class="jarvis-nav-item" data-nav="jobs">🎬 Videos</button>
        <button class="jarvis-nav-item" data-nav="channels">📺 Channels</button>
        <button class="jarvis-nav-item" data-nav="settings">⚙️ Settings</button>
      </div>

      <div class="jarvis-dial" id="jarvis-kill-toggle" title="Click to switch Jarvis on/off">
        ${jarvisDialSVG()}
        <div class="jarvis-dial-label">JARVIS</div>
        <div class="jarvis-dial-status"><span class="jarvis-status-dot" id="jarvis-status-dot"></span> <span id="jarvis-status-text">checking…</span></div>
      </div>
      <div class="jarvis-dial-note">Jarvis can only manage jobs, channels, and automation in this app — nothing else. Every action is logged in the Activity tab.</div>

      <div class="jarvis-center-emblem">
        ${jarvisGlyphSVG()}
        <div class="jarvis-eq" id="jarvis-eq">${Array.from({ length: 7 }).map(() => `<div class="jarvis-eq-bar"></div>`).join("")}</div>
      </div>

      <div class="jarvis-searchbox">
        <input type="text" id="jarvis-text-input" placeholder="Ask Jarvis…"/>
        <button class="icon-btn" id="jarvis-mic" title="Hold to talk (manual, optional)" style="width:28px;height:28px">🎤</button>
        <button class="icon-btn" id="jarvis-wake-toggle" title="Tap to try always-listening mode (off by default)" style="width:28px;height:28px">🔇</button>
        <button class="icon-btn" id="jarvis-send" title="Send" style="width:28px;height:28px">➤</button>
      </div>
      <div class="jarvis-wake-status" id="jarvis-wake-status" style="font-size:10px;opacity:0.65;margin-top:2px">Hold Enter or the mic to talk — tap 🔇 to try always-listening</div>
      <div class="jarvis-mic-row" style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11px;opacity:0.8">
        <span style="white-space:nowrap">🎙️ Mic:</span>
        <select id="jarvis-mic-device" title="Choose your microphone (including Bluetooth)" style="flex:1;min-width:0;background:rgba(255,255,255,0.06);color:inherit;border:1px solid rgba(120,170,255,0.3);border-radius:6px;padding:3px 6px;font-size:11px">
          <option value="">Default microphone</option>
        </select>
        <button class="icon-btn" id="jarvis-mic-refresh" title="Refresh device list (click after connecting a Bluetooth mic)" style="width:24px;height:24px;font-size:12px">⟳</button>
      </div>
      <div class="jarvis-caption-float" id="jarvis-caption">Hold Enter to talk, or type above.</div>

      <div class="jarvis-schedule" id="jarvis-schedule">
        <div class="jarvis-schedule-title">Schedule</div>
        <div class="jarvis-schedule-body">Loading…</div>
      </div>

      <div class="jarvis-agent-row" id="jarvis-agent-row"></div>

      <div class="jarvis-widget jarvis-right">
        <div class="jarvis-widget-handle">⠿ Log</div>
        <div class="jarvis-tabs">
          <button class="jarvis-tab active" data-tab="chat">Transcript</button>
          <button class="jarvis-tab" data-tab="activity">Activity</button>
        </div>
        <div class="jarvis-tabpanel" id="jarvis-tabpanel">
          <div class="jarvis-log" id="jarvis-log"></div>
        </div>
      </div>

      <div class="jarvis-stat-bars" id="jarvis-readout"></div>
    </div>
  </div>`;

  // Live clock, matching the reference's top readout -- cleaned up on close.
  const clockEl = document.getElementById("jarvis-clock");
  const tickClock = () => { if (clockEl) clockEl.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
  tickClock();
  const clockInterval = setInterval(tickClock, 1000);

  // Nav stack -- same destinations as the sidebar, just styled for this HUD.
  document.querySelectorAll(".jarvis-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const which = btn.dataset.nav;
      if (which === "orbit") closeBigPanel();
      else { openBigPanel(which); setActiveSideItem(which); }
    });
  });

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
  // No re-entrancy guard here used to mean every impatient extra click (no
  // visible change for two full network round trips) fired its own
  // independent GET-then-POST chain -- twenty clicks really did mean twenty
  // overlapping toggles racing each other, landing on whatever state the
  // last one happened to finish in. The dial now visibly dims and ignores
  // clicks the instant the first one starts, so there's nothing left to
  // double-fire and the "toggling" state matches what's actually happening.
  let killToggleBusy = false;
  const killDial = document.getElementById("jarvis-kill-toggle");
  killDial.addEventListener("click", async () => {
    if (killToggleBusy) return;
    killToggleBusy = true;
    killDial.style.opacity = "0.5";
    killDial.style.pointerEvents = "none";
    try {
      const { enabled } = await API("/api/jarvis/enabled");
      await API("/api/jarvis/enabled", { method: "POST", body: JSON.stringify({ enabled: !enabled }) });
      await refreshKillState();
      toast(enabled ? "Jarvis switched off." : "Jarvis switched back on.");
    } finally {
      killToggleBusy = false;
      killDial.style.opacity = "";
      killDial.style.pointerEvents = "";
    }
  });

  jarvisSetOrbState("idle");
  // Both used to be their own independent setInterval(..., 8000), started
  // back to back -- which meant every 8s landed two separate API round
  // trips and two separate batches of DOM writes (gauge, schedule, stat
  // bars, agent row) within the same moment instead of one. One shared
  // interval halves that churn.
  const jarvisPollTick = () => { jarvisRefreshReadout(); jarvisCheckSecurity(); };
  jarvisPollTick();
  const readoutInterval = setInterval(jarvisPollTick, 8000);

  // Tabs
  document.querySelectorAll(".jarvis-tab:not(.qa-tab)").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".jarvis-tab:not(.qa-tab)").forEach((t) => t.classList.remove("active"));
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

  // Quick Access tabs -- a SEPARATE tab strip (Jobs/Channels/Notes), scoped
  // off .qa-tab specifically so it can't collide with the Transcript/
  // Activity tabs above despite sharing the same visual .jarvis-tab style.
  document.querySelectorAll(".qa-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".qa-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      jarvisLoadQuickAccessTab(tab.dataset.qaTab);
    });
  });
  const cleanupDragQuickAccess = jarvisMakeDraggable(
    document.querySelector(".jarvis-quickaccess"), document.querySelector(".jarvis-quickaccess .jarvis-widget-handle"), "jarvisQuickAccessPos"
  );
  const cleanupDragGestures = jarvisMakeDraggable(
    document.querySelector(".jarvis-gestures"), document.querySelector(".jarvis-gestures .jarvis-widget-handle"), "jarvisGesturesPos"
  );
  document.getElementById("jarvis-gesture-train-btn").addEventListener("click", jarvisStartGestureTraining);
  document.getElementById("jarvis-gesture-save-btn").addEventListener("click", jarvisSaveGestureFromForm);

  // Teach-a-Task widget: record button toggles record/stop, and the saved
  // task list renders immediately (so tasks taught earlier are there on open).
  const cleanupDragTasks = jarvisMakeDraggable(
    document.querySelector(".jarvis-tasks"), document.querySelector(".jarvis-tasks .jarvis-widget-handle"), "jarvisTasksPos"
  );
  const taskRecBtn = document.getElementById("jarvis-task-rec-btn");
  if (taskRecBtn) taskRecBtn.addEventListener("click", () => {
    jarvisTaskRecording ? jarvisStopTaskRecording() : jarvisStartTaskRecording();
  });
  jarvisRenderTaskList();

  // Typed input
  const input = document.getElementById("jarvis-text-input");
  document.getElementById("jarvis-send").addEventListener("click", () => {
    jarvisUnlockAudio();
    if (input.value.trim()) { jarvisSend(input.value.trim()); input.value = ""; }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.repeat) return;
    e.preventDefault();
    jarvisUnlockAudio();
    if (input.value.trim()) {
      jarvisSend(input.value.trim());
      input.value = "";
      return;
    }
    // Empty box + Enter = PUSH-TO-TALK. This is the fix for "holding Enter
    // does nothing": the cursor stays in this box after you type to Jarvis,
    // and the global push-to-talk handler deliberately ignores Enter while a
    // text field is focused -- so voice silently never started again until
    // you happened to click elsewhere. Confirmed live before the fix: focus
    // in this box => Enter was a complete no-op (no listening, no caption,
    // no words on screen, no error); focus anywhere else => voice worked.
    // Handled here rather than in the global handler because only this
    // handler knows the box was empty BEFORE a send cleared it. Uses
    // jarvisStartRecording (same reliable path as the mic button), not
    // jarvisStartListening -- see the note in jarvisSetupGlobalPushToTalk
    // for why that one doesn't actually work on Windows/Edge. The matching
    // keyup (stop) is handled by the global handler regardless of focus.
    jarvisStartRecording();
  });

  // Hold-to-talk mic button -> records from your chosen device and transcribes
  // server-side (jarvisStartRecording). Depends on none of the things that
  // kept breaking: not the Enter key, not cursor focus, not the browser's
  // speech engine, not any Windows speech setting. Press and hold, speak, let
  // go. Pointer events cover mouse/pen/touch; release is handled on window so
  // drifting off the button can't leave it stuck recording.
  const mic = document.getElementById("jarvis-mic");
  if (mic) {
    const micDown = (e) => {
      e.preventDefault();
      const ae = document.activeElement;
      if (ae && typeof ae.blur === "function") ae.blur();
      jarvisStartRecording();
    };
    const micUp = () => { if (jarvisRecording) jarvisStopRecording(); };
    mic.addEventListener("pointerdown", micDown);
    window.addEventListener("pointerup", micUp);
    window.addEventListener("pointercancel", micUp);
    window.addEventListener("blur", () => { if (jarvisRecording) jarvisStopRecording(); });
  }

  // Always-listening wake word ("Jarvis" / "Hey Jarvis") -- no push-to-talk
  // required. Safe to call every time this panel mounts: jarvisStartWakeListening
  // no-ops if already running, so navigating away and back doesn't stack up
  // duplicate listeners.
  jarvisSetupWakeWord();

  // Microphone device picker (lets you choose a Bluetooth mic).
  const micDevice = document.getElementById("jarvis-mic-device");
  if (micDevice) {
    micDevice.addEventListener("change", () => {
      localStorage.setItem(JARVIS_MIC_DEVICE_KEY, micDevice.value || "");
    });
  }
  const micRefresh = document.getElementById("jarvis-mic-refresh");
  if (micRefresh) {
    micRefresh.addEventListener("click", () => { jarvisPopulateMicDevices(true); });
  }
  // Populate the list on open (labels fill in once permission is granted --
  // the ⟳ button forces that). Also refresh automatically if devices change,
  // e.g. a Bluetooth mic connecting or disconnecting.
  jarvisPopulateMicDevices(false);
  if (navigator.mediaDevices) {
    navigator.mediaDevices.ondevicechange = () => { jarvisPopulateMicDevices(false); };
  }

  // Push-to-talk itself is wired globally now (see jarvisSetupGlobalPushToTalk,
  // called once at app boot) so holding Enter works from any panel, not just
  // while this HUD happens to be open -- nothing panel-specific to wire here.

  const cleanupDragRight = jarvisMakeDraggable(
    document.querySelector(".jarvis-right"), document.querySelector(".jarvis-right .jarvis-widget-handle"), "jarvisRightPos"
  );
  const cleanupDragCam = jarvisMakeDraggable(
    document.querySelector(".jarvis-camdock"), document.querySelector(".jarvis-camdock .jarvis-widget-handle"), "jarvisCamPos"
  );
  const cleanupGestures = jarvisSetupGestureControl(document.getElementById("bigpanel-inner"));

  // Cleaned up whenever the panel closes/changes -- stopAllPanelPolls runs on
  // every panel switch, so hooking removal there keeps this from piling up
  // as a second, third, fourth global listener (or camera stream!) every
  // time Jarvis reopens.
  const _origStop = stopAllPanelPolls;
  window.stopAllPanelPolls = function () {
    window.speechSynthesis && window.speechSynthesis.cancel();
    if (jarvisSpeakAudio) { jarvisSpeakAudio.pause(); jarvisSpeakAudio = null; }
    clearInterval(clockInterval);
    clearInterval(readoutInterval);
    // jarvisDragPanel is one shared variable across every draggable widget.
    // If a drag is interrupted mid-motion by the panel tearing down (e.g.
    // the button-focus bug above forcing a re-mount mid-drag), the mouseup
    // that would normally clear it never fires on a live target, and it's
    // left pointing at a now-detached element forever -- which is exactly
    // what made dragging stop working entirely afterward, on ANY widget,
    // not just the one being dragged. A teardown now always clears it.
    jarvisDragPanel = null;
    cleanupDragRight();
    cleanupDragCam();
    cleanupDragQuickAccess();
    cleanupDragGestures();
    cleanupDragTasks();
    cleanupGestures();
    window.stopAllPanelPolls = _origStop;
    _origStop();
  };

  if (savedConvo && savedConvo.transcript.length) {
    // Replay the saved transcript into the fresh log rather than a canned
    // greeting -- skipRecord since jarvisAppendMsg would otherwise push a
    // second copy of each restored line onto jarvisTranscript.
    savedConvo.transcript.forEach((m) => jarvisAppendMsg(m.role, m.text, { skipRecord: true }));
    jarvisTranscript = savedConvo.transcript.slice();
    jarvisAppendMsg("assistant", "Welcome back.", { skipRecord: true });
  } else {
    jarvisAppendMsg("assistant", "Online. Ask me how a channel's doing, or tell me to retry something.");
  }
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
    <div class="card"><h2>Jarvis — Brain</h2>
      <label>Which LLM answers for Jarvis</label>
      <select id="st-jarvis_llm_provider">
        <option value="anthropic" ${(!s.jarvis_llm_provider.value || s.jarvis_llm_provider.value === "anthropic") ? "selected" : ""}>Anthropic (Claude)</option>
        <option value="gemini" ${s.jarvis_llm_provider.value === "gemini" ? "selected" : ""}>Gemini</option>
      </select>
      <div class="hint">Independent of the Script Writer provider above — you can run scripts on one and Jarvis on the other.
      Gemini uses the key already entered under Script Writer.</div>
      ${field("jarvis_gemini_model", "Gemini model (optional)", "gemini-3.5-flash", "text")}
      ${field("jarvis_voice_id", "ElevenLabs voice ID for Jarvis (optional)", "leave blank for the default voice", "text")}
      <div class="hint">Jarvis speaks with your ElevenLabs key (entered under Voice — ElevenLabs below) once one's set — same
      account as your video narration, just a separate voice if you want Jarvis to sound different. Without a key,
      Jarvis falls back to your browser's built-in voice.</div>
    </div>
    <div class="card"><h2>Jarvis — WhatsApp</h2>
      ${field("twilio_account_sid", "Twilio Account SID", "AC…", "text")}
      ${field("twilio_auth_token", "Twilio Auth Token", "")}
      ${field("twilio_whatsapp_number", "Twilio WhatsApp number", "whatsapp:+1415…", "text")}
      ${field("jarvis_phone_allowlist", "Your phone number(s)", "+15551234567", "text")}
      <div class="hint">Comma-separate multiple numbers. Only messages from these numbers, with a verified
      Twilio signature, ever reach Jarvis — everything else is silently ignored.
      Webhook URL for Twilio's WhatsApp sandbox/number: <code>${location.origin}/api/jarvis/whatsapp</code></div>
    </div>
    <div class="card"><h2>Jarvis — Push Notifications (ntfy, free)</h2>
      ${field("ntfy_topic", "ntfy topic", "e.g. jarvis-9f2a1c7e-alerts", "text")}
      <div class="hint">Free forever, no account needed. Install the <b>ntfy</b> app
      (<a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy.sh</a> — iOS/Android/web), subscribe to the
      exact topic name you enter here, and save. Treat the topic name like a password — anyone who knows it can
      read and send to it on the public server, so use a long, hard-to-guess one, not something like "jarvis".</div>
    </div>
    <div class="card"><h2>Jarvis — Proactive Alerts</h2>
      <label>When something needs your attention</label>
      <select id="st-jarvis_proactive_alerts">
        <option value="true" ${(s.jarvis_proactive_alerts && s.jarvis_proactive_alerts.value) !== "false" ? "selected" : ""}>On — alert me the moment a video fails or Jarvis blocks an unauthorized action (Recommended)</option>
        <option value="false" ${(s.jarvis_proactive_alerts && s.jarvis_proactive_alerts.value) === "false" ? "selected" : ""}>Off — I'll only hear from Jarvis when I message him first</option>
      </select>
      <div class="hint">Goes out over whichever of WhatsApp / ntfy you've set up above (either is enough, both is fine
      too). Each failure/blocked-attempt is only ever sent once, so this can't turn into spam.</div>
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
      "twilio_account_sid", "twilio_auth_token", "twilio_whatsapp_number", "jarvis_phone_allowlist",
      "jarvis_llm_provider", "jarvis_gemini_model", "jarvis_voice_id", "jarvis_proactive_alerts", "ntfy_topic"];
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
  // The 3D village is gone entirely -- it was a second full-screen animation
  // loop competing for frame budget, which is exactly what made the old app
  // lag. Overview is now just the first scene in the same scroll track as
  // everything else (see index.html + the SCENE NAVIGATION block above).
  initClock();
  pollActiveJob();
  bannerPoll = pollInterval(pollActiveJob, 5000);
  const skip = $("#boot-skip");
  if (skip) skip.addEventListener("click", endBoot);

  // Scroll-driven navigation: a real scroll gesture activates a scene via
  // the IntersectionObserver; the dot-nav is the click-to-jump alternative
  // (same destinations the old sidebar had, same openBigPanel/closeBigPanel
  // every other feature already calls -- see the SCENE NAVIGATION block).
  _jarvisSetupSceneObserver();
  document.querySelectorAll("#dot-nav .dot").forEach((el) => {
    el.addEventListener("click", () => {
      const which = el.dataset.jump;
      if (which === "overview") closeBigPanel(); else openBigPanel(which);
      // A clicked <button> keeps keyboard focus by default, which used to
      // make Enter (push-to-talk) re-click the last-focused nav button
      // instead of starting a recording -- blurring closes that off.
      el.blur();
    });
  });
  _jarvisActivateScene("overview");  // render the home scene immediately, don't wait on the observer's first fire
  jarvisSetupGlobalPushToTalk();
  // Browsers sometimes pause speechSynthesis (not the ElevenLabs <audio>
  // path -- real <audio> elements aren't affected) when a tab goes to the
  // background, as a power-saving quirk rather than anything intentional
  // in this app. Resuming it the moment the tab becomes visible again
  // means switching back mid-reply picks the voice back up instead of
  // leaving it silently stuck.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && window.speechSynthesis && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
  });
  // General fix for the whole "focused button reacts to Enter" bug class --
  // the sidebar Jarvis icon was the first one found, but the HUD has its
  // OWN buttons too (nav-items, tabs, the gesture toggle, send, the kill
  // dial), any of which could be the one left focused before you next hold
  // Enter for push-to-talk, silently re-clicking itself and re-mounting
  // the whole panel mid-recording. Blurring every button immediately after
  // its own click fires closes this for good, for any button anywhere in
  // the app, present or future -- not just the one instance already found.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn) btn.blur();
  });
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
