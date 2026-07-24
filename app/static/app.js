// Faceless Control Center -- vanilla JS SPA, no build step needed.

const el = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
};

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${resp.status}: ${body}`);
  }
  const ct = resp.headers.get("content-type") || "";
  return ct.includes("application/json") ? resp.json() : resp;
}

function toast(msg) {
  const t = el(`<div class="toast">${msg}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

const routes = {
  "": renderDashboard,
  "/": renderDashboard,
  "/channels": renderChannels,
  "/new": renderNewVideo,
  "/jobs": renderJobs,
  "/settings": renderSettings,
};

async function router() {
  const hash = location.hash.replace(/^#/, "") || "/";
  document.querySelectorAll(".nav a").forEach((a) => a.classList.remove("active"));
  const navMatch = document.querySelector(`.nav a[href="#${hash.split("/").slice(0, 2).join("/")}"]`)
    || document.querySelector(`.nav a[href="#${hash}"]`);
  if (navMatch) navMatch.classList.add("active");

  const main = document.getElementById("main");
  const jobDetailMatch = hash.match(/^\/jobs\/(.+)$/);
  if (jobDetailMatch) {
    return renderJobDetail(main, jobDetailMatch[1]);
  }
  const renderer = routes[hash] || renderDashboard;
  return renderer(main);
}

window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", router);

// ---------- Command Center (Dashboard) ----------
const AGENT_META = {
  script: { icon: "🧠", label: "Script Agent" },
  voice: { icon: "🎙️", label: "Voice Agent" },
  visuals: { icon: "🎨", label: "Visual Agent" },
  assembly: { icon: "🎬", label: "Assembly Agent" },
  publish: { icon: "📡", label: "Publish Agent" },
};

async function renderDashboard(main) {
  main.innerHTML = `<h1>Command Center</h1><div class="page-sub">Live status across every agent running your faceless channels.</div>`;
  const [channels, jobs, rundown] = await Promise.all([
    api("/api/channels"), api("/api/jobs"), api("/api/rundown"),
  ]);

  const banner = el(`
    <div class="rundown-banner">
      <div class="rb-label">// Daily Rundown</div>
      <div>${rundown.briefing}</div>
      <div class="live-strip">
        ${Object.entries(rundown.live_agents).map(([name, on]) => `
          <div class="live-chip ${on ? "on" : ""}">
            <span class="blip"></span>${AGENT_META[name] ? AGENT_META[name].icon : ""} ${AGENT_META[name] ? AGENT_META[name].label : name} ${on ? "— active" : "— idle"}
          </div>
        `).join("")}
      </div>
    </div>
  `);
  main.appendChild(banner);

  const active = jobs.filter((j) => !["published", "failed", "ready_for_review"].includes(j.status));
  const grid = el(`<div class="grid section"></div>`);
  grid.appendChild(el(`<div class="card"><div class="stat">${channels.length}</div><div class="stat-label">Channels</div></div>`));
  grid.appendChild(el(`<div class="card"><div class="stat">${jobs.length}</div><div class="stat-label">Total videos</div></div>`));
  grid.appendChild(el(`<div class="card"><div class="stat">${active.length}</div><div class="stat-label">In progress</div></div>`));
  grid.appendChild(el(`<div class="card"><div class="stat">${jobs.filter(j => j.status === 'published').length}</div><div class="stat-label">Published</div></div>`));
  main.appendChild(grid);

  main.appendChild(el(`<div class="pill-row">
    <a class="btn" href="#/new">+ New video</a>
    <a class="btn secondary" href="#/channels">Manage channels</a>
  </div>`));

  main.appendChild(el(`<h2>Recent jobs</h2>`));
  const list = el(`<div></div>`);
  main.appendChild(list);
  if (jobs.length === 0) {
    list.appendChild(el(`<div class="card">No videos yet. <a class="link" href="#/new">Create your first one</a>.</div>`));
  }
  jobs.slice(0, 6).forEach((j) => list.appendChild(jobRow(j, channels)));

  if (active.length > 0) {
    setTimeout(() => { if (location.hash === "" || location.hash === "#/") renderDashboard(main); }, 4000);
  }
}

function jobRow(job, channels) {
  const ch = channels.find((c) => c.id === job.channel_id);
  const row = el(`
    <div class="job-row">
      <div>
        <div class="job-title">${job.title || "(untitled — still generating)"}</div>
        <div class="job-meta">${ch ? ch.name : "?"} · ${fmtDate(job.created_at)}</div>
      </div>
      <span class="badge ${job.status}">${job.status.replace(/_/g, " ")}</span>
    </div>
  `);
  row.addEventListener("click", () => (location.hash = `#/jobs/${job.id}`));
  return row;
}

// ---------- Channels ----------
async function renderChannels(main) {
  main.innerHTML = `<h1>Channels</h1><div class="page-sub">Each channel has its own niche, voice, and platform connections.</div>`;
  const channels = await api("/api/channels");

  const grid = el(`<div class="grid section"></div>`);
  channels.forEach((c) => grid.appendChild(channelCard(c)));
  main.appendChild(grid);

  main.appendChild(el(`<h2>Add a channel</h2>`));
  const form = el(`
    <div class="card" style="max-width:520px">
      <label>Channel name</label>
      <input id="c-name" placeholder="e.g. Late Night Facts" />
      <label>Niche / content description</label>
      <textarea id="c-niche" placeholder="e.g. eerie true stories with a twist ending, 60 seconds, dark academia tone"></textarea>
      <label>Style notes (optional)</label>
      <textarea id="c-style" placeholder="e.g. always end on a question to the viewer"></textarea>
      <div class="form-row">
        <div>
          <label>ElevenLabs voice ID (optional)</label>
          <input id="c-voice" placeholder="leave blank to use default" />
        </div>
        <div>
          <label>Visual style suffix (optional)</label>
          <input id="c-visual" placeholder="e.g. moody, film grain, 35mm" />
        </div>
      </div>
      <button id="c-save">Create channel</button>
    </div>
  `);
  form.querySelector("#c-save").addEventListener("click", async () => {
    const payload = {
      name: form.querySelector("#c-name").value.trim(),
      niche: form.querySelector("#c-niche").value.trim(),
      style_notes: form.querySelector("#c-style").value.trim(),
      voice_id: form.querySelector("#c-voice").value.trim(),
      visual_style: form.querySelector("#c-visual").value.trim(),
    };
    if (!payload.name) return toast("Give the channel a name first.");
    await api("/api/channels", { method: "POST", body: JSON.stringify(payload) });
    router();
  });
  main.appendChild(form);
}

function channelCard(c) {
  const card = el(`
    <div class="card">
      <h2>${c.name}</h2>
      <div class="job-meta" style="margin-bottom:10px">${c.niche || "No niche set"}</div>
      <div class="conn-status"><span class="dot ${c.youtube_connected ? "on" : ""}"></span>
        YouTube ${c.youtube_connected ? "connected (" + c.youtube_channel_title + ")" : "not connected"}</div>
      <div class="conn-status"><span class="dot ${c.tiktok_connected ? "on" : ""}"></span>
        TikTok ${c.tiktok_connected ? "connected" : "not connected"}</div>
      <div class="pill-row" style="margin-top:12px">
        ${c.youtube_connected ? "" : `<a class="btn secondary" href="/auth/youtube/start?channel_id=${c.id}">Connect YouTube</a>`}
        ${c.tiktok_connected ? "" : `<a class="btn secondary" href="/auth/tiktok/start?channel_id=${c.id}">Connect TikTok</a>`}
        <button class="danger" data-del="${c.id}">Delete</button>
      </div>
    </div>
  `);
  card.querySelector("[data-del]").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete channel "${c.name}" and all its jobs?`)) return;
    await api(`/api/channels/${c.id}`, { method: "DELETE" });
    router();
  });
  return card;
}

// ---------- New video ----------
async function renderNewVideo(main) {
  main.innerHTML = `<h1>New video</h1><div class="page-sub">Kick off a new script → voice → visuals → assembly run.</div>`;
  const channels = await api("/api/channels");
  if (channels.length === 0) {
    main.appendChild(el(`<div class="card">You need a channel first. <a class="link" href="#/channels">Create one</a>.</div>`));
    return;
  }
  const options = channels.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
  const form = el(`
    <div class="card" style="max-width:520px">
      <label>Channel</label>
      <select id="j-channel">${options}</select>
      <label>Topic (optional — leave blank to let the writer pick one for this niche)</label>
      <textarea id="j-topic" placeholder="e.g. the Mary Celeste"></textarea>
      <label style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" id="j-publish" style="width:auto;margin:0" /> Auto-publish when ready (uses connected YouTube/TikTok accounts)
      </label>
      <button id="j-save">Generate video</button>
    </div>
  `);
  form.querySelector("#j-save").addEventListener("click", async () => {
    const payload = {
      channel_id: form.querySelector("#j-channel").value,
      topic: form.querySelector("#j-topic").value.trim(),
      auto_publish: form.querySelector("#j-publish").checked,
    };
    const job = await api("/api/jobs", { method: "POST", body: JSON.stringify(payload) });
    toast("Job started — generating…");
    location.hash = `#/jobs/${job.id}`;
  });
  main.appendChild(form);
}

// ---------- Jobs list ----------
async function renderJobs(main) {
  main.innerHTML = `<h1>Jobs</h1><div class="page-sub">Every video this control center has generated.</div>`;
  const [jobs, channels] = await Promise.all([api("/api/jobs"), api("/api/channels")]);
  const list = el(`<div></div>`);
  if (jobs.length === 0) list.appendChild(el(`<div class="card">No jobs yet.</div>`));
  jobs.forEach((j) => list.appendChild(jobRow(j, channels)));
  main.appendChild(list);
}

// ---------- Job detail (polls while in progress) ----------
let pollTimer = null;
async function renderJobDetail(main, jobId) {
  if (pollTimer) clearInterval(pollTimer);
  const draw = async () => {
    const job = await api(`/api/jobs/${jobId}`);
    main.innerHTML = `<h1>${job.title || "Generating…"}</h1>
      <div class="page-sub">Job ${job.id} · <span class="badge ${job.status}">${job.status.replace(/_/g, " ")}</span></div>`;

    let agentStatuses = {};
    try { agentStatuses = JSON.parse(job.agent_status || "{}"); } catch (e) { /* ignore */ }
    const agentGrid = el(`<div class="agent-grid"></div>`);
    Object.entries(AGENT_META).forEach(([name, meta]) => {
      const status = agentStatuses[name] || "idle";
      const card = el(`
        <div class="agent-card ${status}">
          <div class="agent-icon">${meta.icon}</div>
          <div class="agent-name">${meta.label}</div>
          <div class="agent-status-dot"><span class="blip"></span>${status}</div>
        </div>
      `);
      agentGrid.appendChild(card);
    });
    main.appendChild(agentGrid);

    const cols = el(`<div style="display:flex; gap:24px; flex-wrap:wrap;"></div>`);

    const left = el(`<div style="flex:1; min-width:320px;"></div>`);
    left.appendChild(el(`<h2>Progress log</h2>`));
    left.appendChild(el(`<div class="log-box">${(job.stage_log || "").trim() || "Queued…"}</div>`));
    if (job.error_message) {
      left.appendChild(el(`<div class="card" style="margin-top:12px; border-color:var(--danger)"><b>Error:</b> ${job.error_message}</div>`));
    }
    if (job.script_text) {
      left.appendChild(el(`<h2 style="margin-top:20px">Script</h2>`));
      left.appendChild(el(`<div class="card">${job.description ? `<p class="job-meta">${job.description}</p>` : ""}<div style="white-space:pre-wrap; font-size:13px; line-height:1.6;">${job.script_text}</div></div>`));
    }
    cols.appendChild(left);

    const right = el(`<div style="width:340px;"></div>`);
    if (job.video_path && ["ready_for_review", "publishing", "published"].includes(job.status)) {
      right.appendChild(el(`<h2>Preview</h2>`));
      right.appendChild(el(`<video controls src="/api/jobs/${job.id}/video"></video>`));
      const actions = el(`<div class="pill-row" style="margin-top:12px"></div>`);
      const dl = el(`<a class="btn secondary" href="/api/jobs/${job.id}/video" download>Download MP4</a>`);
      actions.appendChild(dl);
      if (job.status === "ready_for_review") {
        const pub = el(`<button>Publish now</button>`);
        pub.addEventListener("click", async () => {
          pub.disabled = true;
          pub.textContent = "Publishing…";
          try {
            await api(`/api/jobs/${job.id}/publish`, { method: "POST" });
            draw();
          } catch (e) {
            toast("Publish failed: " + e.message);
            pub.disabled = false;
            pub.textContent = "Publish now";
          }
        });
        actions.appendChild(pub);
      }
      right.appendChild(actions);
      if (job.youtube_video_id) right.appendChild(el(`<div class="job-meta" style="margin-top:8px">YouTube video ID: ${job.youtube_video_id}</div>`));
      if (job.tiktok_publish_id) right.appendChild(el(`<div class="job-meta">TikTok publish ID: ${job.tiktok_publish_id}</div>`));
    } else {
      right.appendChild(el(`<div class="card">Video isn't ready yet — this page auto-refreshes.</div>`));
    }
    cols.appendChild(right);
    main.appendChild(cols);

    if (["published", "failed", "ready_for_review"].includes(job.status) && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
  await draw();
  pollTimer = setInterval(draw, 3000);
}

// ---------- Settings ----------
async function renderSettings(main) {
  main.innerHTML = `<h1>Settings</h1><div class="page-sub">API keys are encrypted at rest and never shown in full once saved.</div>`;

  const s = await api("/api/settings");
  const field = (key, label, placeholder, type = "text") => `
    <label>${label}${s[key].set ? ` — currently set (${s[key].value})` : ""}</label>
    <input type="${type}" id="s-${key}" placeholder="${s[key].set ? "leave blank to keep current value" : placeholder}" />
  `;

  main.innerHTML += `
    <div class="section card">
      <h2>Script writer</h2>
      <label>Provider</label>
      <select id="s-llm_provider">
        <option value="anthropic" ${s.llm_provider.value === "anthropic" ? "selected" : ""}>Anthropic (Claude)</option>
        <option value="openai" ${s.llm_provider.value === "openai" ? "selected" : ""}>OpenAI</option>
        <option value="gemini" ${s.llm_provider.value === "gemini" ? "selected" : ""}>Gemini</option>
      </select>
      ${field("anthropic_api_key", "Anthropic (Claude) API key", "sk-ant-...", "password")}
      ${field("openai_api_key", "OpenAI API key", "sk-...", "password")}
      ${field("gemini_api_key", "Gemini API key", "AIza...", "password")}
      <div class="hint">No key yet? The script stage falls back to a placeholder generator so you can still test everything downstream.</div>
    </div>

    <div class="section card">
      <h2>Voice — ElevenLabs</h2>
      ${field("elevenlabs_api_key", "ElevenLabs API key", "", "password")}
      <div class="hint">No key yet? Segments render as timed silence so you can test video assembly/captions.</div>
    </div>

    <div class="section card">
      <h2>Visuals</h2>
      <label>Provider</label>
      <select id="s-image_provider">
        <option value="placeholder" ${s.image_provider.value === "placeholder" || !s.image_provider.value ? "selected" : ""}>Placeholder (no key needed, for testing)</option>
        <option value="openai" ${s.image_provider.value === "openai" ? "selected" : ""}>OpenAI (gpt-image-1)</option>
        <option value="stability" ${s.image_provider.value === "stability" ? "selected" : ""}>Stability AI</option>
        <option value="gemini" ${s.image_provider.value === "gemini" ? "selected" : ""}>Gemini (gemini-2.5-flash-image)</option>
      </select>
      ${field("stability_api_key", "Stability API key", "", "password")}
      <div class="hint">OpenAI and Gemini images reuse the API keys entered above in Script writer.</div>
    </div>

    <div class="section card">
      <h2>YouTube</h2>
      ${field("youtube_client_id", "OAuth Client ID", "from Google Cloud Console")}
      ${field("youtube_client_secret", "OAuth Client Secret", "", "password")}
      <div class="hint">Create these under Google Cloud Console → APIs &amp; Services → Credentials → OAuth client ID (type: Web application), with redirect URI
        <code>${location.origin}/auth/youtube/callback</code>. Keep the consent screen in "Testing" and add yourself as a test user while you build — see the README for why.</div>
    </div>

    <div class="section card">
      <h2>TikTok</h2>
      ${field("tiktok_client_key", "Client Key", "from TikTok Developer Portal")}
      ${field("tiktok_client_secret", "Client Secret", "", "password")}
      <div class="hint">Redirect URI to register: <code>${location.origin}/auth/tiktok/callback</code>. Personal/unaudited apps can only post privately (self-only) until TikTok approves the app for public posting — see the README.</div>
    </div>

    <button id="s-save">Save settings</button>
  `;

  main.querySelector("#s-save").addEventListener("click", async () => {
    const payload = {};
    ["llm_provider", "anthropic_api_key", "openai_api_key", "gemini_api_key", "elevenlabs_api_key", "image_provider",
      "stability_api_key", "youtube_client_id", "youtube_client_secret", "tiktok_client_key", "tiktok_client_secret"]
      .forEach((key) => {
        const elm = main.querySelector(`#s-${key}`);
        if (elm && elm.value) payload[key] = elm.value;
      });
    await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
    toast("Settings saved.");
    router();
  });
}
