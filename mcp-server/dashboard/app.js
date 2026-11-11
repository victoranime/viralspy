const state = {
  platform: "instagram",
  spySort: "outlier",
  spyFilter: "",
  currentScan: null,
  similarAccounts: [],
  radarDays: 30,
  radarSort: "outlier",
  radarRun: null,
  radarSelectedHandles: new Set(),
  dbSort: "outlier",
  dbPosts: [],
  dbCreators: [],
  expandedPacks: new Set(),
  vaultTab: "saved",
  library: {
    savedPosts: [],
    reproducePacks: [],
    postsDbCount: 0,
    transcripts: {},
    visualHooks: {},
    comments: {},
    recentScans: [],
    radarRuns: [],
  },
  activePost: null,
};

// ── Formatting Helpers ──────────────────────────────────────────────────────

function fmtCompact(n) {
  if (n == null || Number.isNaN(+n)) return "—";
  const v = +n;
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(v));
}

function fmtRelativeAge(iso, fallbackHours) {
  let hrs = fallbackHours;
  if (iso) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) {
      hrs = Math.max(0.2, (Date.now() - ms) / 3600000);
    } else {
      return iso;
    }
  }
  if (hrs == null) return "";
  if (hrs < 24) return `${Math.max(1, Math.round(hrs))}h ago`;
  const days = hrs / 24;
  if (days < 30) return `${Math.round(days)}d ago`;
  const months = days / 30;
  if (months < 12) return `${Math.round(months)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

function fmtSeconds(sec) {
  const s = Math.max(0, Math.floor(+sec || 0));
  const m = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, "0");
  return `${m}:${rem}`;
}

function proxyMedia(url, dl = false, filename = "") {
  if (!url) return "";
  if (url.startsWith("/")) return url;
  const qs = new URLSearchParams({ url });
  if (dl) {
    qs.set("dl", "1");
    if (filename) qs.set("filename", filename);
  }
  return `/api/media-proxy?${qs.toString()}`;
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(msg, durationMs = 3400) {
  const wrap = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

function setBanner(visible, text = "") {
  const banner = document.getElementById("globalJobBanner");
  const label = document.getElementById("globalJobText");
  banner.hidden = !visible;
  if (text) label.textContent = text;
}

function triggerBrowserDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  if (filename) a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1200);
}

async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return await res.json();
}

// ── Theme & Navigation ──────────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem("viralspy_studio_theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  document.getElementById("themeToggleBtn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", cur);
    localStorage.setItem("viralspy_studio_theme", cur);
  });
}

function switchView(viewName) {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.view === viewName);
  });
  document.querySelectorAll(".view-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.id === `view-${viewName}`);
  });
  if (viewName === "vault") renderVault();
  if (viewName === "videodb") renderVideoDb();
  if (viewName === "database") refreshMasterDatabase();
}

function syncViewFromHash() {
  const h = (window.location.hash || "").replace(/^#/, "").toLowerCase();
  if (h === "saved" || h === "vault") switchView("vault");
  else if (h === "videodb" || h === "reproduce") switchView("videodb");
  else if (h === "database" || h === "db") switchView("database");
  else if (h === "radar") switchView("radar");
  else if (h === "comments") switchView("comments");
}

function initNavigation() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.view;
      history.replaceState(null, "", `#${v}`);
      switchView(v);
    });
  });
  window.addEventListener("hashchange", syncViewFromHash);
  syncViewFromHash();
}

// ── Live Status, Two-Way Sync & Workspace Library ───────────────────────────

function renderLiveRadarAccounts(accountsObj) {
  const bar = document.getElementById("radarLiveAccountsBar");
  const entries = Object.entries(accountsObj || {});
  if (!entries.length) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  bar.hidden = false;
  bar.innerHTML = entries
    .map(([handle, info]) => {
      const st = info?.status || "queued";
      const cls = st === "scanning" ? "is-scanning" : st === "done" ? "is-done" : "";
      const tag =
        st === "scanning"
          ? "scraping ⚡"
          : st === "done"
          ? `saved ✓ (${info.scannedCount || 0})`
          : st === "error"
          ? "failed"
          : "queued";
      return `<div class="radar-stat-pill ${cls}"><strong>@${esc(handle)}</strong><code>${esc(tag)}</code></div>`;
    })
    .join("");
}

async function refreshStatus() {
  try {
    const st = await fetch("/api/status").then((r) => r.json());
    const dot = document.getElementById("extDot");
    const title = document.getElementById("extStatusTitle");
    const sub = document.getElementById("extStatusSub");
    const online = !!st?.extension?.connected;

    dot.className = `status-dot ${online ? "is-online" : "is-offline"}`;
    title.textContent = online ? "Chrome · Connected" : "Waiting for Chrome…";
    sub.textContent = online
      ? `${st.extension.browser || "Chrome"} · v${st.extension.version || "21.0"}`
      : "Open Chrome with ViralSpy enabled";

    const whisperChip = document.getElementById("whisperChip");
    whisperChip.classList.toggle("is-ready", !!st?.whisper?.modelAvailable);
    whisperChip.textContent = st?.whisper?.modelAvailable ? "Whisper GPU · Ready" : "Whisper · Missing";

    const visionChip = document.getElementById("visionChip");
    visionChip.classList.toggle("is-ready", !!st?.visionOcrAvailable);
    visionChip.textContent = st?.visionOcrAvailable ? "Vision OCR · Ready" : "Vision OCR";

    if (typeof st?.postsDbCount === "number") {
      document.getElementById("masterDbCountBadge").textContent = String(st.postsDbCount);
    }
    if (typeof st?.reproducePacksCount === "number") {
      document.getElementById("videoDbCountBadge").textContent = String(st.reproducePacksCount);
    }

    if (st?.liveRadar?.running) {
      setBanner(true, st.liveRadar.step || "Scraping accounts in parallel…");
      renderLiveRadarAccounts(st.liveRadar.accounts);
    } else {
      document.getElementById("radarLiveAccountsBar").hidden = true;
    }

    // Two-way sync check: if Chrome extension saved/unsaved or created a pack, refresh library automatically
    if (
      (typeof st?.savedLibraryCount === "number" && st.savedLibraryCount !== state.library.savedPosts.length) ||
      (typeof st?.reproducePacksCount === "number" && st.reproducePacksCount !== state.library.reproducePacks.length)
    ) {
      await loadLibrary();
    }
  } catch (_) {}
}

async function loadLibrary() {
  try {
    const data = await fetch("/api/library").then((r) => r.json());
    if (!data?.ok) return;
    state.library.savedPosts = data.savedPosts || [];
    state.library.reproducePacks = data.reproducePacks || [];
    state.library.postsDbCount = data.postsDbCount || 0;
    state.library.transcripts = data.transcripts || {};
    state.library.visualHooks = data.visualHooks || {};
    state.library.comments = data.comments || {};
    state.library.recentScans = data.recentScans || [];
    state.library.radarRuns = data.radarRuns || [];

    updateSidebarCounts();
    renderRecentScans();

    if (!state.currentScan && state.library.recentScans.length > 0) {
      state.currentScan = state.library.recentScans[0];
      renderSpyResults();
    } else if (state.currentScan) {
      renderSpyResults();
    }

    if (!state.radarRun && state.library.radarRuns.length > 0) {
      state.radarRun = state.library.radarRuns[0];
      renderRadarResults();
    } else if (state.radarRun) {
      renderRadarResults();
    }

    if (document.getElementById("view-vault").classList.contains("is-active")) {
      renderVault();
    }
    if (document.getElementById("view-videodb").classList.contains("is-active")) {
      renderVideoDb();
    }
  } catch (_) {}
}

function updateSidebarCounts() {
  const totalVault = state.library.savedPosts.length;
  document.getElementById("vaultCountBadge").textContent = String(totalVault);
  document.getElementById("videoDbCountBadge").textContent = String(state.library.reproducePacks.length);
  document.getElementById("masterDbCountBadge").textContent = String(state.library.postsDbCount || 0);
}

// Re-sync immediately when switching back from Chrome tab to Studio tab
window.addEventListener("focus", () => {
  loadLibrary();
});

function renderRecentScans() {
  const wrap = document.getElementById("recentScansList");
  const scans = state.library.recentScans || [];
  if (!scans.length) {
    wrap.innerHTML = `<div class="empty-hint">No profiles scanned yet</div>`;
    return;
  }
  wrap.innerHTML = scans
    .slice(0, 14)
    .map(
      (sc, idx) => `
      <button type="button" class="recent-scan-btn" data-scan-idx="${idx}">
        <span>@${esc(sc.username)}</span>
        <span class="recent-scan-meta">${esc((sc.platform || "ig").slice(0, 2).toUpperCase())} · ${(sc.posts || []).length}</span>
      </button>
    `
    )
    .join("");

  wrap.querySelectorAll(".recent-scan-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const scan = scans[Number(btn.dataset.scanIdx)];
      if (!scan) return;
      state.currentScan = scan;
      document.getElementById("spyUsernameInput").value = scan.username || "";
      switchView("spy");
      renderSpyResults();
    });
  });
}

// ── Shared Reproduce Helper (1-Shot VideoBot Pack + .zip + Skill Prompt) ───

function getPackForCode(code) {
  if (!code) return null;
  return state.library.reproducePacks.find((p) => p.shortcode === code) || null;
}

async function runOneShotReproduce(postOrParams, triggerBtn = null) {
  const origLabel = triggerBtn ? triggerBtn.textContent : "";
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = "Packing…";
  }
  const codeLabel = postOrParams.shortcode || postOrParams.code || postOrParams.url || "video";
  setBanner(true, `Building Reproduce Pack (${codeLabel}): FFmpeg scene cuts + Whisper word alignment + .zip…`);

  try {
    const res = await apiPost("/api/reproduce", postOrParams);
    if (!res?.ok) {
      toast(res?.message || "Reproduce Pack failed — verify Chrome is open");
      return null;
    }
    const pack = res.pack || res;
    const existingIdx = state.library.reproducePacks.findIndex((p) => p.packId === pack.packId);
    if (existingIdx >= 0) state.library.reproducePacks.splice(existingIdx, 1);
    state.library.reproducePacks.unshift(pack);
    updateSidebarCounts();

    // Auto-download the .zip immediately (exact VideoBot workflow)
    triggerBrowserDownload(pack.zipUrl, `${pack.packId}.zip`);

    // Also copy the ready-to-run video-storyboard Skill prompt to clipboard
    if (pack.skillPrompt) {
      try {
        await navigator.clipboard.writeText(pack.skillPrompt);
        toast(`${pack.packId}.zip downloaded (${pack.sceneCount} scenes) + Remake Skill prompt copied!`, 4800);
      } catch (_) {
        toast(`${pack.packId}.zip downloaded (${pack.sceneCount} scenes)!`, 4200);
      }
    }

    if (triggerBtn) {
      triggerBtn.classList.add("is-pack-ready");
      triggerBtn.textContent = "Pack ✓";
    }
    renderVideoDb();
    return pack;
  } catch (err) {
    toast("Error communicating with local Reproduce Engine");
    return null;
  } finally {
    if (triggerBtn) {
      triggerBtn.disabled = false;
      if (!triggerBtn.classList.contains("is-pack-ready")) {
        triggerBtn.textContent = origLabel || "Reproduce";
      }
    }
    setBanner(false);
  }
}

// ── Shared 9:16 Media Card Renderer ─────────────────────────────────────────

function sortPostsClient(posts, sortBy) {
  const arr = [...(posts || [])];
  arr.sort((a, b) => {
    if (sortBy === "velocity") {
      return ((b.velocityScore ?? b.viewsPerHour) || 0) - ((a.velocityScore ?? a.viewsPerHour) || 0);
    }
    if (sortBy === "views") return (b.views || 0) - (a.views || 0);
    if (sortBy === "likes") return (b.likes || 0) - (a.likes || 0);
    if (sortBy === "comments") return (b.comments || 0) - (a.comments || 0);
    if (sortBy === "recent") return String(b.lastScrapedAt || "").localeCompare(String(a.lastScrapedAt || ""));
    return ((b.outlierScore ?? b.views) || 0) - ((a.outlierScore ?? a.views) || 0);
  });
  return arr;
}

function isPostSaved(code) {
  if (!code) return false;
  return state.library.savedPosts.some((p) => p.code === code || p.shortcode === code);
}

function buildMediaGridHtml(posts) {
  return posts
    .map((p, idx) => {
      const code = p.shortcode || p.code || "";
      const outVal = typeof p.outlierScore === "number" ? p.outlierScore : null;
      const outHot = outVal != null && outVal >= 2.5;
      const outText = outVal != null ? `${outVal.toFixed(1)}x` : `#${idx + 1}`;
      const velText =
        p.velocityScore != null
          ? `⚡ ${Number(p.velocityScore).toFixed(1)}x/d`
          : p.viewsPerHour != null
          ? `⚡ ${fmtCompact(p.viewsPerHour)}/h`
          : "";
      const coverSrc = p.thumbnailUrl ? proxyMedia(p.thumbnailUrl) : "";
      const saved = isPostSaved(code);
      const pack = getPackForCode(code);
      const age = fmtRelativeAge(p.createDate, p.ageHours);

      return `
      <article class="reel-card" data-code="${esc(code)}" data-idx="${idx}">
        <div class="reel-cover-wrap" data-action="inspect">
          ${
            coverSrc
              ? `<img src="${esc(coverSrc)}" alt="" class="reel-cover-img" loading="lazy" />`
              : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#71717a;font-size:12px;">No Cover</div>`
          }
          <div class="reel-badges-top">
            <span class="badge-outlier ${outHot ? "is-hot" : ""}">${esc(outText)}</span>
            ${velText ? `<span class="badge-velocity">${esc(velText)}</span>` : ""}
          </div>
          <div class="reel-scrim-bottom">
            <div class="reel-creator-line">
              <span>@${esc(p.username || "creator")}</span>
              <span class="reel-age">${esc(age)}</span>
            </div>
            <div class="reel-kpis">
              ${p.views != null ? `<span>▶ ${fmtCompact(p.views)}</span>` : ""}
              ${p.likes != null ? `<span>♥ ${fmtCompact(p.likes)}</span>` : ""}
              ${p.comments != null ? `<span>💬 ${fmtCompact(p.comments)}</span>` : ""}
            </div>
          </div>
        </div>
        <div class="reel-body">
          <p class="reel-caption">${esc(p.caption || "No caption")}</p>
          <div class="reel-actions">
            <button type="button" class="card-btn is-primary" data-action="inspect">Inspect</button>
            <button type="button" class="card-btn ${pack ? "is-pack-ready" : "is-reproduce"}" data-action="reproduce" title="One-Shot Reproduce Pack (.zip + scenes + script + Skill prompt)">${
              pack ? "Pack ✓" : "Reproduce"
            }</button>
            <button type="button" class="card-btn" data-action="hook" title="Extract 3-frame Visual Hook + OCR">OCR</button>
            <button type="button" class="card-btn ${saved ? "is-saved" : ""}" data-action="save" title="Save (two-way synced with Chrome)">${
              saved ? "★" : "☆"
            }</button>
          </div>
        </div>
      </article>
      `;
    })
    .join("");
}

function wireGridEvents(container, postsList) {
  container.querySelectorAll(".reel-card").forEach((card) => {
    const post = postsList[Number(card.dataset.idx)];
    if (!post) return;

    card.querySelectorAll('[data-action="inspect"]').forEach((el) => {
      el.addEventListener("click", () => openInspector(post));
    });

    card.querySelector('[data-action="reproduce"]')?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      await runOneShotReproduce(post, btn);
    });

    card.querySelector('[data-action="hook"]')?.addEventListener("click", async () => {
      await openInspector(post);
      triggerVisualHookExtraction();
    });

    card.querySelector('[data-action="save"]')?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      const code = post.shortcode || post.code;
      const currentlySaved = isPostSaved(code);
      if (currentlySaved) {
        await apiPost("/save/v2/posts/unsave", { code, platform: post.platform || "instagram" });
        state.library.savedPosts = state.library.savedPosts.filter((p) => p.code !== code && p.shortcode !== code);
        btn.classList.remove("is-saved");
        btn.textContent = "☆";
        toast("Removed from Swipe Vault (synced with Chrome)");
      } else {
        const res = await apiPost("/save/v2/posts", post);
        const savedObj = res?.post || { ...post, code, shortcode: code };
        state.library.savedPosts = state.library.savedPosts.filter((p) => p.code !== code && p.shortcode !== code);
        state.library.savedPosts.unshift(savedObj);
        btn.classList.add("is-saved");
        btn.textContent = "★";
        toast("Saved to Swipe Vault (synced with Chrome)");
      }
      updateSidebarCounts();
    });
  });
}

// ── View 1: Creator Spy ─────────────────────────────────────────────────────

function syncSurfaceDropdown() {
  const sel = document.getElementById("spySurfaceSelect");
  if (state.platform === "youtube") {
    sel.innerHTML = `<option value="shorts">Shorts</option><option value="videos">Videos</option>`;
  } else if (state.platform === "tiktok") {
    sel.innerHTML = `<option value="videos">Videos</option>`;
  } else {
    sel.innerHTML = `<option value="reels">Reels</option><option value="posts">Posts</option>`;
  }
}

function renderSpyResults() {
  const scan = state.currentScan;
  const emptyEl = document.getElementById("spyEmptyState");
  const kpiGrid = document.getElementById("spyKpiGrid");
  const exportActions = document.getElementById("spyExportActions");
  const mediaGrid = document.getElementById("spyMediaGrid");

  if (!scan || !Array.isArray(scan.posts) || !scan.posts.length) {
    emptyEl.hidden = false;
    kpiGrid.hidden = true;
    exportActions.hidden = true;
    mediaGrid.innerHTML = "";
    return;
  }

  emptyEl.hidden = true;
  kpiGrid.hidden = false;
  exportActions.hidden = false;

  const q = state.spyFilter.trim().toLowerCase();
  const filtered = q
    ? scan.posts.filter((p) => String(p.caption || "").toLowerCase().includes(q))
    : scan.posts;
  const sorted = sortPostsClient(filtered, state.spySort);

  const baseline = scan.outlierBaseline?.baseline ?? null;
  const peakOutlier = scan.posts.reduce((mx, p) => Math.max(mx, p.outlierScore || 0), 0);
  const topVel = scan.posts.reduce((mx, p) => Math.max(mx, p.viewsPerHour || 0), 0);

  document.getElementById("kpiCreator").textContent = `@${scan.username}`;
  document.getElementById("kpiScannedSub").textContent = `${scan.posts.length} ${scan.surface || "items"} saved to DB`;
  document.getElementById("kpiBaseline").textContent = baseline ? fmtCompact(baseline) : "—";
  document.getElementById("kpiPeakOutlier").textContent = peakOutlier > 0 ? `${peakOutlier.toFixed(1)}x` : "—";
  document.getElementById("kpiTopVelocity").textContent = topVel > 0 ? `${fmtCompact(topVel)} / hr` : "—";

  mediaGrid.innerHTML = buildMediaGridHtml(sorted);
  wireGridEvents(mediaGrid, sorted);
}

function exportPostsRows(rows, slug, format = "csv") {
  if (!rows?.length) {
    toast("No posts to export");
    return;
  }
  if (format === "json") {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
    triggerBrowserDownload(URL.createObjectURL(blob), `${slug}.json`);
    return;
  }
  const headers = ["Rank", "Platform", "Username", "Shortcode", "URL", "Created", "OutlierScore", "VelocityScore", "ViewsPerHour", "Views", "Likes", "Comments", "VideoMP4", "Caption"];
  const csvLines = [
    headers.join(","),
    ...rows.map((r, i) =>
      [
        i + 1,
        r.platform || "instagram",
        r.username || "",
        r.shortcode || r.code || "",
        r.url || "",
        r.createDate || "",
        r.outlierScore ?? "",
        r.velocityScore ?? "",
        r.viewsPerHour ?? "",
        r.views ?? "",
        r.likes ?? "",
        r.comments ?? "",
        r.videoUrl ?? "",
        `"${String(r.caption || "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`,
      ].join(",")
    ),
  ];
  const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8" });
  triggerBrowserDownload(URL.createObjectURL(blob), `${slug}.csv`);
}

function initCreatorSpy() {
  document.querySelectorAll("#platformSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#platformSeg .seg-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.platform = btn.dataset.platform;
      syncSurfaceDropdown();
    });
  });

  document.querySelectorAll("#spySortSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#spySortSeg .seg-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.spySort = btn.dataset.sort;
      renderSpyResults();
    });
  });

  document.getElementById("spyFilterInput").addEventListener("input", (ev) => {
    state.spyFilter = ev.target.value || "";
    renderSpyResults();
  });

  document.querySelectorAll(".sample-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.getElementById("spyUsernameInput").value = chip.dataset.sample;
      document.getElementById("spyForm").requestSubmit();
    });
  });

  document.getElementById("spyForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const rawUser = document.getElementById("spyUsernameInput").value.trim();
    if (!rawUser) return;
    const surface = document.getElementById("spySurfaceSelect").value;
    const rawDepth = document.getElementById("spyDepthSelect").value;
    const depth = rawDepth === "all" ? "all" : Number(rawDepth || 60);
    const btn = document.getElementById("spySubmitBtn");

    btn.disabled = true;
    setBanner(true, `Scanning ${rawUser} via Chrome extension & archiving to Master DB…`);
    try {
      const res = await apiPost("/api/sort", {
        platform: state.platform,
        username: rawUser,
        surface,
        sortBy: state.spySort,
        depth,
      });
      if (!res?.ok) {
        toast(res?.message || "Sort failed — check Chrome & sign-in");
        return;
      }
      state.currentScan = res;
      document.getElementById("similarStrip").hidden = true;
      renderSpyResults();
      await loadLibrary();
      toast(`Sorted & permanently saved ${res.posts.length} posts for @${res.username}`);
    } catch (_) {
      toast("Network error talking to local ViralSpy Hub");
    } finally {
      btn.disabled = false;
      setBanner(false);
    }
  });

  document.getElementById("exportCsvBtn").addEventListener("click", () => {
    const scan = state.currentScan;
    if (scan?.posts?.length) {
      exportPostsRows(sortPostsClient(scan.posts, state.spySort), `${scan.username}_${scan.platform || "ig"}_${state.spySort}`, "csv");
    }
  });
  document.getElementById("exportJsonBtn").addEventListener("click", () => {
    const scan = state.currentScan;
    if (scan?.posts?.length) {
      exportPostsRows(sortPostsClient(scan.posts, state.spySort), `${scan.username}_${scan.platform || "ig"}_${state.spySort}`, "json");
    }
  });

  document.getElementById("discoverSimilarBtn").addEventListener("click", async () => {
    const uname = state.currentScan?.username || document.getElementById("spyUsernameInput").value.trim();
    if (!uname) return;
    setBanner(true, `Fetching Instagram similar accounts for @${uname}…`);
    try {
      const res = await apiPost("/api/similar", { username: uname });
      if (!res?.ok || !Array.isArray(res.accounts)) {
        toast(res?.error?.message || res?.message || "Could not load similar accounts");
        return;
      }
      state.similarAccounts = res.accounts.filter((a) => !a.is_private);
      const strip = document.getElementById("similarStrip");
      const row = document.getElementById("similarChipsRow");
      document.getElementById("similarStripTitle").textContent = `${state.similarAccounts.length} creators similar to @${uname} (click any handle to spy)`;
      row.innerHTML = state.similarAccounts
        .slice(0, 24)
        .map((a) => `<button type="button" class="creator-chip" data-handle="${esc(a.username)}">@${esc(a.username)}</button>`)
        .join("");
      strip.hidden = false;

      row.querySelectorAll(".creator-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          document.getElementById("spyUsernameInput").value = chip.dataset.handle;
          document.getElementById("spyForm").requestSubmit();
        });
      });
    } finally {
      setBanner(false);
    }
  });

  document.getElementById("closeSimilarStripBtn").addEventListener("click", () => {
    document.getElementById("similarStrip").hidden = true;
  });

  document.getElementById("sendSimilarToRadarBtn").addEventListener("click", () => {
    if (!state.similarAccounts.length) return;
    const seed = state.currentScan?.username;
    const picks = [
      ...(seed ? [`https://www.instagram.com/${seed}/`] : []),
      ...state.similarAccounts.slice(0, 5).map((a) => `https://www.instagram.com/${a.username}/`),
    ];
    document.getElementById("radarAccountsTextarea").value = picks.join("\n");
    switchView("radar");
  });
}

// ── View 2: Niche Radar (Parallel Multi-URL Scraper + Permanent Archive) ───

function syncRadarTextareaFromSet() {
  document.getElementById("radarAccountsTextarea").value = Array.from(state.radarSelectedHandles)
    .map((h) => `https://www.instagram.com/${h}/`)
    .join("\n");
}

function renderRadarResults() {
  const run = state.radarRun;
  const bar = document.getElementById("radarSummaryBar");
  const grid = document.getElementById("radarMediaGrid");

  if (!run || !Array.isArray(run.leaderboard) || !run.leaderboard.length) {
    bar.hidden = true;
    grid.innerHTML = "";
    return;
  }

  bar.hidden = false;
  bar.innerHTML = (run.accountSummaries || [])
    .map((s) =>
      s.ok
        ? `<div class="radar-stat-pill is-done"><strong>@${esc(s.username)}</strong><code>${s.scannedCount || 0} saved · median ${fmtCompact(
            s.baseline
          )} · top ${s.topOutlier ? s.topOutlier.toFixed(1) + "x" : "—"}</code></div>`
        : `<div class="radar-stat-pill"><strong>@${esc(s.username)}</strong><code>skipped</code></div>`
    )
    .join("");

  const sorted = sortPostsClient(run.leaderboard, state.radarSort);
  grid.innerHTML = buildMediaGridHtml(sorted);
  wireGridEvents(grid, sorted);
}

function initNicheRadar() {
  document.querySelectorAll("#radarWindowSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#radarWindowSeg .seg-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.radarDays = Number(btn.dataset.days);
    });
  });

  document.querySelectorAll("#radarSortSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#radarSortSeg .seg-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.radarSort = btn.dataset.sort;
      renderRadarResults();
    });
  });

  document.getElementById("radarExpandBtn").addEventListener("click", async () => {
    const seed = document.getElementById("radarSeedInput").value.trim();
    if (!seed) {
      toast("Enter a seed profile URL or handle first");
      return;
    }
    setBanner(true, `Discovering competitors similar to ${seed}…`);
    try {
      const res = await apiPost("/api/similar", { username: seed });
      if (!res?.ok || !Array.isArray(res.accounts)) {
        if (Array.isArray(res?.suggestions) && res.suggestions.length) {
          const box = document.getElementById("radarDiscoveredBox");
          const pills = document.getElementById("radarDiscoveredPills");
          box.querySelector(".control-label").textContent = `Account wasn't found — click a matching Instagram handle:`;
          pills.innerHTML = res.suggestions
            .map((a) => `<button type="button" class="creator-chip" data-suggest="${esc(a.username)}">@${esc(a.username)}</button>`)
            .join("");
          box.hidden = false;
          pills.querySelectorAll(".creator-chip").forEach((chip) => {
            chip.addEventListener("click", () => {
              document.getElementById("radarSeedInput").value = chip.dataset.suggest;
              document.getElementById("radarExpandBtn").click();
            });
          });
          return;
        }
        toast(res?.error?.message || res?.message || "Could not discover similar accounts");
        return;
      }
      const cleanSeed = res.username || seed.replace(/^@/, "");
      const list = res.accounts.filter((a) => !a.is_private).slice(0, 18);
      state.radarSelectedHandles = new Set([cleanSeed, ...list.slice(0, 5).map((a) => a.username)]);
      syncRadarTextareaFromSet();

      const box = document.getElementById("radarDiscoveredBox");
      box.querySelector(".control-label").textContent = "Click to toggle discovered competitors:";
      const pills = document.getElementById("radarDiscoveredPills");
      pills.innerHTML = [
        `<button type="button" class="creator-chip is-selected" data-h="${esc(cleanSeed)}">@${esc(cleanSeed)}</button>`,
        ...list.map(
          (a) =>
            `<button type="button" class="creator-chip ${
              state.radarSelectedHandles.has(a.username) ? "is-selected" : ""
            }" data-h="${esc(a.username)}">@${esc(a.username)}</button>`
        ),
      ].join("");
      box.hidden = false;

      pills.querySelectorAll(".creator-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const h = chip.dataset.h;
          if (state.radarSelectedHandles.has(h)) {
            state.radarSelectedHandles.delete(h);
            chip.classList.remove("is-selected");
          } else {
            state.radarSelectedHandles.add(h);
            chip.classList.add("is-selected");
          }
          syncRadarTextareaFromSet();
        });
      });
    } finally {
      setBanner(false);
    }
  });

  document.getElementById("runRadarBtn").addEventListener("click", async () => {
    const rawText = document.getElementById("radarAccountsTextarea").value.trim();
    const tokens = rawText
      .split(/[\s,\n\r;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const seed = document.getElementById("radarSeedInput").value.trim();

    if (!tokens.length && !seed) {
      toast("Paste competitor profile URLs / @handles or enter a seed creator");
      return;
    }

    const rawRadarDepth = document.getElementById("radarDepthSelect").value;
    const perAccountDepth = rawRadarDepth === "all" ? "all" : Number(rawRadarDepth || 36);
    const btn = document.getElementById("runRadarBtn");
    btn.disabled = true;
    setBanner(true, `Scraping ${tokens.length || 6} accounts simultaneously in parallel…`);

    const fastPoll = setInterval(refreshStatus, 1200);
    try {
      const res = await apiPost("/api/niche-radar", {
        usernames: tokens,
        urlsOrHandles: rawText,
        seedUsername: tokens.length ? "" : seed,
        daysBack: state.radarDays,
        perAccountDepth,
        sortBy: state.radarSort,
        concurrency: 3,
      });
      if (!res?.ok) {
        toast(res?.message || "Niche Radar failed");
        return;
      }
      state.radarRun = res;
      renderRadarResults();
      await loadLibrary();
      toast(
        `Parallel Radar complete: ${res.totalPostsScrapedAndSaved || res.totalPostsInWindow} posts permanently saved across ${res.totalCreatorsScanned} creators`,
        4500
      );
    } finally {
      clearInterval(fastPoll);
      btn.disabled = false;
      setBanner(false);
      document.getElementById("radarLiveAccountsBar").hidden = true;
    }
  });
}

// ── View 3: Video Database (VideoBot Reproduce Packs) ───────────────────────

function renderVideoDb() {
  const packs = state.library.reproducePacks || [];
  const emptyEl = document.getElementById("videoDbEmptyState");
  const listEl = document.getElementById("videoDbList");

  if (!packs.length) {
    emptyEl.hidden = false;
    listEl.innerHTML = "";
    return;
  }
  emptyEl.hidden = true;

  listEl.innerHTML = packs
    .map((p) => {
      const isExpanded = state.expandedPacks.has(p.packId);
      const outBadge =
        typeof p.outlierScore === "number"
          ? `<span class="badge-outlier ${p.outlierScore >= 2.5 ? "is-hot" : ""}">${p.outlierScore.toFixed(1)}x</span>`
          : "";

      return `
      <article class="pack-row-card" data-pack-id="${esc(p.packId)}">
        <div class="pack-row-top">
          <div class="pack-thumb-box">
            <img src="${esc(p.thumbnailAssetUrl)}" alt="${esc(p.packId)}" loading="lazy" />
          </div>

          <div class="pack-meta-main">
            <div class="pack-title-line">
              <span class="pack-id-code">${esc(p.packId)}.zip</span>
              ${p.username ? `<strong>@${esc(p.username)}</strong>` : ""}
              ${outBadge}
              <span class="mini-tag">${p.sceneCount || 0} scenes · ${Math.round(p.durationSeconds || 0)}s</span>
              ${p.wordsPerMinute ? `<span class="mini-tag">${p.wordsPerMinute} WPM</span>` : ""}
            </div>

            ${p.spokenHook ? `<p class="pack-hook-quote">“${esc(p.spokenHook)}”</p>` : ""}
            ${p.onScreenHook ? `<p class="pack-ocr-line">On-Screen OCR: ${esc(p.onScreenHook)}</p>` : ""}
            <p class="pack-transcript-preview">${esc(p.transcript || "No spoken dialogue detected.")}</p>
            <div class="pack-path-line" title="${esc(p.folderPath)}">Local folder: ${esc(p.folderPath)}</div>
          </div>

          <div class="pack-actions-col">
            <button type="button" class="btn-primary btn-sm" data-pack-act="copy-skill">Copy Skill Prompt ✦</button>
            <a href="${esc(p.zipUrl)}" download="${esc(p.packId)}.zip" class="btn-secondary btn-sm">Download .zip ↓</a>
            <button type="button" class="btn-secondary btn-sm" data-pack-act="toggle-scenes">${
              isExpanded ? "Hide Scenes ▲" : `View ${p.sceneCount || 0} Scenes ▼`
            }</button>
            <button type="button" class="btn-ghost-xs" data-pack-act="delete" style="align-self:flex-end;">Delete</button>
          </div>
        </div>

        ${
          isExpanded
            ? `
          <div class="pack-scenes-drawer">
            <div class="callout-head">
              <span class="section-eyebrow">Shot-by-Shot Breakdown (scenes.txt + frames/scene_NN.jpg)</span>
              <a href="${esc(p.storyboardAssetUrl)}" target="_blank" rel="noopener" class="btn-ghost-xs">Open Storyboard Sheet ↗</a>
            </div>
            <div class="pack-scenes-grid">
              ${(p.scenes || [])
                .map(
                  (sc) => `
                <div class="scene-shot-card">
                  <img src="${esc(sc.frameUrl)}" alt="Scene ${sc.index}" loading="lazy" />
                  <div class="scene-shot-body">
                    <div class="scene-shot-head">
                      <span>Scene ${sc.index}</span>
                      <span>${esc(sc.timeRange)}</span>
                    </div>
                    <p class="scene-shot-spoken">${esc(sc.spokenText || "(visual beat)")}</p>
                    ${sc.ocrText ? `<p class="scene-shot-ocr">OCR: ${esc(sc.ocrText)}</p>` : ""}
                  </div>
                </div>
              `
                )
                .join("")}
            </div>
          </div>
        `
            : ""
        }
      </article>
      `;
    })
    .join("");

  listEl.querySelectorAll(".pack-row-card").forEach((card) => {
    const packId = card.dataset.packId;
    const pack = packs.find((x) => x.packId === packId);
    if (!pack) return;

    card.querySelector('[data-pack-act="copy-skill"]')?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(pack.skillPrompt || "");
      toast("Copied Remake Skill prompt — paste straight into Antigravity or Claude!");
    });

    card.querySelector('[data-pack-act="toggle-scenes"]')?.addEventListener("click", () => {
      if (state.expandedPacks.has(packId)) state.expandedPacks.delete(packId);
      else state.expandedPacks.add(packId);
      renderVideoDb();
    });

    card.querySelector('[data-pack-act="delete"]')?.addEventListener("click", async () => {
      await fetch(`/api/reproduce/${encodeURIComponent(packId)}`, { method: "DELETE" });
      state.library.reproducePacks = state.library.reproducePacks.filter((x) => x.packId !== packId);
      updateSidebarCounts();
      renderVideoDb();
      toast(`Deleted ${packId}`);
    });
  });
}

function initVideoDbView() {
  document.getElementById("reproduceForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = document.getElementById("reproduceUrlInput");
    const url = input.value.trim();
    if (!url) return;
    const btn = document.getElementById("reproduceSubmitBtn");
    const pack = await runOneShotReproduce({ url }, btn);
    if (pack) {
      input.value = "";
      state.expandedPacks.add(pack.packId);
      renderVideoDb();
    }
  });
}

// ── View 4: Permanent Master Database ───────────────────────────────────────

let dbDebounce = null;
async function refreshMasterDatabase() {
  const search = document.getElementById("dbSearchInput").value.trim();
  const username = document.getElementById("dbCreatorSelect").value;
  const platform = document.getElementById("dbPlatformSelect").value;
  const minOutlier = document.getElementById("dbMinOutlierSelect").value;
  const savedOnly = document.getElementById("dbSavedOnlyCheck").checked ? "1" : "0";
  const reproducedOnly = document.getElementById("dbReproducedOnlyCheck").checked ? "1" : "0";

  const qs = new URLSearchParams({
    search,
    username,
    platform,
    minOutlier,
    savedOnly,
    reproducedOnly,
    sortBy: state.dbSort,
    limit: "10000",
  });

  try {
    const res = await fetch(`/api/db/posts?${qs.toString()}`).then((r) => r.json());
    if (!res?.ok) return;
    state.dbPosts = res.posts || [];
    state.library.postsDbCount = res.totalInDb || 0;
    updateSidebarCounts();

    // Populate creator dropdown preserving current selection
    const creatorSel = document.getElementById("dbCreatorSelect");
    const prevVal = creatorSel.value;
    const creators = res.creators || [];
    creatorSel.innerHTML =
      `<option value="">All Creators (${creators.length})</option>` +
      creators.map((c) => `<option value="${esc(c)}" ${c === prevVal ? "selected" : ""}>@${esc(c)}</option>`).join("");

    document.getElementById("dbResultCounter").textContent = `${res.filteredCount} of ${res.totalInDb} archived posts`;

    const grid = document.getElementById("dbMediaGrid");
    if (!state.dbPosts.length) {
      grid.innerHTML = `<div class="empty-hint">No archived posts match the current filters.</div>`;
    } else {
      grid.innerHTML = buildMediaGridHtml(state.dbPosts);
      wireGridEvents(grid, state.dbPosts);
    }
  } catch (_) {}
}

function initMasterDatabaseView() {
  const schedule = () => {
    if (dbDebounce) clearTimeout(dbDebounce);
    dbDebounce = setTimeout(refreshMasterDatabase, 200);
  };

  document.getElementById("dbSearchInput").addEventListener("input", schedule);
  document.getElementById("dbCreatorSelect").addEventListener("change", refreshMasterDatabase);
  document.getElementById("dbPlatformSelect").addEventListener("change", refreshMasterDatabase);
  document.getElementById("dbMinOutlierSelect").addEventListener("change", refreshMasterDatabase);
  document.getElementById("dbSavedOnlyCheck").addEventListener("change", refreshMasterDatabase);
  document.getElementById("dbReproducedOnlyCheck").addEventListener("change", refreshMasterDatabase);

  document.querySelectorAll("#dbSortSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#dbSortSeg .seg-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.dbSort = btn.dataset.sort;
      refreshMasterDatabase();
    });
  });

  document.getElementById("dbExportCsvBtn").addEventListener("click", () => {
    exportPostsRows(state.dbPosts, `viralspy_master_db_${state.dbSort}`, "csv");
  });
  document.getElementById("dbExportJsonBtn").addEventListener("click", () => {
    exportPostsRows(state.dbPosts, `viralspy_master_db_${state.dbSort}`, "json");
  });
}

// ── View 5: Comment Goldmine ────────────────────────────────────────────────

function renderCommentStack(list, emptyMsg) {
  if (!Array.isArray(list) || !list.length) {
    return `<div class="empty-hint">${esc(emptyMsg)}</div>`;
  }
  return list
    .map(
      (c) => `
      <div class="comment-item">
        <div class="comment-item-top">
          <span class="comment-author">@${esc(c.username)}</span>
          <span class="comment-likes">♥ ${fmtCompact(c.likes)} · ${c.replyCount || 0} replies</span>
        </div>
        <p class="comment-text">${esc(c.text)}</p>
      </div>
    `
    )
    .join("");
}

function initCommentsView() {
  document.getElementById("commentsForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = document.getElementById("commentsUrlInput").value.trim();
    if (!input) return;
    const limit = Number(document.getElementById("commentsLimitSelect").value || 80);

    setBanner(true, "Mining top Instagram comments & audience questions…");
    try {
      const res = await apiPost("/api/comments", { postUrlOrShortcode: input, limit, force: false });
      if (!res?.ok) {
        toast(res?.message || "Failed to fetch comments");
        return;
      }
      document.getElementById("commentsResultsWrap").hidden = false;
      document.getElementById("questionsCountBadge").textContent = String((res.questions || []).length);
      document.getElementById("requestsCountBadge").textContent = String((res.requests || []).length);
      document.getElementById("topCommentsCountBadge").textContent = String((res.topComments || []).length);

      document.getElementById("questionsList").innerHTML = renderCommentStack(res.questions, "No questions detected in top comments.");
      document.getElementById("requestsList").innerHTML = renderCommentStack(res.requests, "No link or product requests detected.");
      document.getElementById("topCommentsList").innerHTML = renderCommentStack(res.topComments, "No comments returned.");
      toast(`Mined ${res.totalFetched} comments`);
    } finally {
      setBanner(false);
    }
  });
}

// ── View 6: Swipe Vault (Two-Way Synced with Chrome) ────────────────────────

function renderVault() {
  const savedGrid = document.getElementById("vaultSavedGrid");
  const transList = document.getElementById("vaultTranscriptsList");
  const hooksList = document.getElementById("vaultHooksList");

  savedGrid.hidden = state.vaultTab !== "saved";
  transList.hidden = state.vaultTab !== "transcripts";
  hooksList.hidden = state.vaultTab !== "hooks";

  if (state.vaultTab === "saved") {
    if (!state.library.savedPosts.length) {
      savedGrid.innerHTML = `<div class="empty-hint">Click Save on Instagram / TikTok in Chrome or ★ on any card here — both sync automatically.</div>`;
    } else {
      savedGrid.innerHTML = buildMediaGridHtml(state.library.savedPosts);
      wireGridEvents(savedGrid, state.library.savedPosts);
    }
  } else if (state.vaultTab === "transcripts") {
    const entries = Object.entries(state.library.transcripts || {});
    if (!entries.length) {
      transList.innerHTML = `<div class="empty-hint">No local Whisper transcripts cached yet.</div>`;
    } else {
      transList.innerHTML = entries
        .reverse()
        .map(
          ([code, tr]) => `
          <div class="vault-card">
            <div class="vault-card-head">
              <strong>${esc(tr.profileName ? "@" + tr.profileName : "Post")} · <code>${esc(code)}</code></strong>
              <span class="mini-tag">${esc(tr.language || "auto")} · ${tr.duration_seconds || 0}s</span>
            </div>
            ${tr.hook ? `<p style="margin:0 0 8px;font-weight:600;color:var(--accent-amber);">Hook: "${esc(tr.hook)}"</p>` : ""}
            <p style="margin:0;font-size:13px;color:var(--text-secondary);">${esc(tr.transcription)}</p>
          </div>
        `
        )
        .join("");
    }
  } else if (state.vaultTab === "hooks") {
    const entries = Object.values(state.library.visualHooks || {});
    if (!entries.length) {
      hooksList.innerHTML = `<div class="empty-hint">No 3-frame Visual Hooks extracted yet. Click "OCR" on any Reel card to extract one.</div>`;
    } else {
      hooksList.innerHTML = entries
        .reverse()
        .map(
          (vh) => `
          <div class="vault-card">
            <div class="vault-card-head">
              <strong>Reel <code>${esc(vh.shortcode)}</code></strong>
              <span class="mini-tag">${esc(vh.onScreenHookText || "Visual Storyboard")}</span>
            </div>
            <div class="hook-frames-grid">
              ${(vh.frames || [])
                .map(
                  (f) => `
                <div class="hook-frame-card">
                  <img src="${esc(f.imageUrl)}" alt="${esc(f.label)}" loading="lazy" />
                  <div class="hook-frame-meta">
                    <span class="hook-frame-ts">${esc(f.label)}</span>
                    <span class="hook-frame-ocr">${esc(f.ocrText || "—")}</span>
                  </div>
                </div>
              `
                )
                .join("")}
            </div>
          </div>
        `
        )
        .join("");
    }
  }
}

function initVault() {
  document.querySelectorAll("#vaultTabSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#vaultTabSeg .seg-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.vaultTab = btn.dataset.vault;
      renderVault();
    });
  });
}

// ── Deep Inspector Drawer ───────────────────────────────────────────────────

function renderPackInDrawer(pack) {
  const card = document.getElementById("drawerPackCard");
  if (!pack) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  document.getElementById("drawerPackSub").textContent = `${pack.packId}.zip · ${pack.sceneCount || 0} shot cuts · ${Math.round(
    pack.durationSeconds || 0
  )}s`;
  const zipLink = document.getElementById("drawerPackZipLink");
  zipLink.href = pack.zipUrl;
  zipLink.setAttribute("download", `${pack.packId}.zip`);

  document.getElementById("drawerCopySkillBtn").onclick = async () => {
    await navigator.clipboard.writeText(pack.skillPrompt || "");
    toast("Copied Remake Skill prompt to clipboard!");
  };

  document.getElementById("drawerPackScenes").innerHTML = (pack.scenes || [])
    .map(
      (sc) => `
      <div class="scene-shot-card">
        <img src="${esc(sc.frameUrl)}" alt="Scene ${sc.index}" loading="lazy" />
        <div class="scene-shot-body">
          <div class="scene-shot-head">
            <span>#${sc.index}</span>
            <span>${esc(sc.timeRange)}</span>
          </div>
          <p class="scene-shot-spoken">${esc(sc.spokenText || "—")}</p>
        </div>
      </div>
    `
    )
    .join("");
}

function renderVisualHookInDrawer(vh) {
  const wrap = document.getElementById("visualHookResult");
  const callout = document.getElementById("onScreenOcrCallout");
  const ocrText = document.getElementById("onScreenOcrText");
  const grid = document.getElementById("hookFramesGrid");

  wrap.hidden = false;
  if (vh.onScreenHookText) {
    callout.hidden = false;
    ocrText.textContent = vh.onScreenHookText;
  } else {
    callout.hidden = true;
  }

  grid.innerHTML = (vh.frames || [])
    .map(
      (f) => `
      <div class="hook-frame-card">
        <img src="${esc(f.imageUrl)}?t=${Date.now()}" alt="${esc(f.label)}" />
        <div class="hook-frame-meta">
          <span class="hook-frame-ts">${esc(f.label)}</span>
          <span class="hook-frame-ocr">${esc(f.ocrText || "No text overlay")}</span>
        </div>
      </div>
    `
    )
    .join("");
}

function renderTranscriptInDrawer(tr) {
  const wrap = document.getElementById("transcriptResult");
  wrap.hidden = false;
  document.getElementById("spokenHookText").textContent = tr.hook || tr.transcription?.slice(0, 140) || "—";
  const wpm = tr.wordsPerMinute ? `${tr.wordsPerMinute} WPM` : `${tr.duration_seconds || 0}s`;
  document.getElementById("scriptWpmPill").textContent = wpm;

  const segWrap = document.getElementById("transcriptSegments");
  const segs =
    Array.isArray(tr.segments) && tr.segments.length
      ? tr.segments
      : [{ start: 0, text: tr.transcription || "" }];

  segWrap.innerHTML = segs
    .map(
      (s) => `
      <button type="button" class="segment-row" data-seek="${s.start || 0}">
        <span class="segment-ts">${fmtSeconds(s.start || 0)}</span>
        <span class="segment-txt">${esc(s.text)}</span>
      </button>
    `
    )
    .join("");

  segWrap.querySelectorAll(".segment-row").forEach((row) => {
    row.addEventListener("click", () => {
      const vid = document.querySelector("#drawerVideoWrap video");
      if (vid) {
        vid.currentTime = Number(row.dataset.seek || 0);
        vid.play().catch(() => {});
      }
    });
  });
}

async function openInspector(post) {
  state.activePost = post;
  const code = post.shortcode || post.code || "";

  document.getElementById("drawerCreator").textContent = `@${post.username || "creator"}`;
  const badges = [];
  if (typeof post.outlierScore === "number") {
    badges.push(`<span class="badge-outlier ${post.outlierScore >= 2.5 ? "is-hot" : ""}">${post.outlierScore.toFixed(1)}x</span>`);
  }
  if (post.velocityScore != null) {
    badges.push(`<span class="mini-tag">⚡ ${Number(post.velocityScore).toFixed(1)}x/day</span>`);
  }
  document.getElementById("drawerBadges").innerHTML = badges.join("");

  document.getElementById("drawerExternalLink").href = post.url || `https://www.instagram.com/reel/${code}/`;

  const existingPack = getPackForCode(code);
  const repBtn = document.getElementById("drawerReproduceBtn");
  repBtn.textContent = existingPack ? "Download Pack .zip ✓" : "Reproduce .zip ✦";

  const dlBtn = document.getElementById("drawerDownloadMp4Btn");
  if (post.videoUrl || existingPack?.videoAssetUrl) {
    dlBtn.hidden = false;
    dlBtn.href = existingPack?.videoAssetUrl || proxyMedia(post.videoUrl, true, `${post.username || "reel"}_${code}.mp4`);
  } else {
    dlBtn.hidden = true;
  }

  document.getElementById("drawerViews").textContent = fmtCompact(post.views);
  document.getElementById("drawerVelocity").textContent =
    post.viewsPerHour != null ? `${fmtCompact(post.viewsPerHour)}/h` : "—";
  document.getElementById("drawerLikes").textContent = fmtCompact(post.likes);
  document.getElementById("drawerComments").textContent = fmtCompact(post.comments);
  document.getElementById("drawerCaption").textContent = post.caption || "No caption";

  const videoWrap = document.getElementById("drawerVideoWrap");
  const vidSrc = existingPack?.videoAssetUrl || (post.videoUrl ? proxyMedia(post.videoUrl) : "");
  const posterSrc = existingPack?.thumbnailAssetUrl || (post.thumbnailUrl ? proxyMedia(post.thumbnailUrl) : "");

  if (vidSrc) {
    videoWrap.innerHTML = `<video src="${esc(vidSrc)}" poster="${esc(posterSrc)}" controls playsinline preload="metadata"></video>`;
  } else if (posterSrc) {
    videoWrap.innerHTML = `<img src="${esc(posterSrc)}" alt="" />`;
  } else {
    videoWrap.innerHTML = "";
  }

  renderPackInDrawer(existingPack);

  const cachedVh = code ? state.library.visualHooks[code] : null;
  if (cachedVh) {
    renderVisualHookInDrawer(cachedVh);
  } else {
    document.getElementById("visualHookResult").hidden = true;
  }

  const cachedTr = code ? state.library.transcripts[code] : null;
  if (cachedTr) {
    renderTranscriptInDrawer(cachedTr);
  } else {
    document.getElementById("transcriptResult").hidden = true;
  }

  const cachedCom = code ? state.library.comments[code] : null;
  const comWrap = document.getElementById("drawerCommentsResult");
  if (cachedCom) {
    comWrap.hidden = false;
    comWrap.innerHTML = renderCommentStack(
      cachedCom.questions?.length ? cachedCom.questions : cachedCom.topComments?.slice(0, 12),
      "No comments found."
    );
  } else {
    comWrap.hidden = true;
  }

  document.getElementById("inspectorBackdrop").hidden = false;
  const drawer = document.getElementById("inspectorDrawer");
  drawer.classList.add("is-open");
  drawer.setAttribute("aria-hidden", "false");
}

function closeInspector() {
  const vid = document.querySelector("#drawerVideoWrap video");
  if (vid) vid.pause();
  document.getElementById("inspectorDrawer").classList.remove("is-open");
  document.getElementById("inspectorDrawer").setAttribute("aria-hidden", "true");
  document.getElementById("inspectorBackdrop").hidden = true;
}

async function triggerVisualHookExtraction() {
  const post = state.activePost;
  if (!post) return;
  const btn = document.getElementById("extractHookBtn");
  btn.disabled = true;
  btn.textContent = "Extracting…";
  try {
    const res = await apiPost("/api/visual-hook", {
      shortcode: post.shortcode || post.code,
      videoUrl: post.videoUrl || null,
    });
    if (!res?.ok) {
      toast(res?.message || "Could not extract visual hook");
      return;
    }
    state.library.visualHooks[res.shortcode] = res;
    renderVisualHookInDrawer(res);
    toast("Extracted 3 hook frames + Apple Vision OCR");
  } finally {
    btn.disabled = false;
    btn.textContent = "Extract 3 Frames + OCR";
  }
}

function initInspectorDrawer() {
  document.getElementById("closeDrawerBtn").addEventListener("click", closeInspector);
  document.getElementById("inspectorBackdrop").addEventListener("click", closeInspector);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeInspector();
  });

  document.getElementById("drawerReproduceBtn").addEventListener("click", async (ev) => {
    if (!state.activePost) return;
    const pack = await runOneShotReproduce(state.activePost, ev.currentTarget);
    if (pack) {
      renderPackInDrawer(pack);
      const code = state.activePost.shortcode || state.activePost.code;
      if (code && state.library.transcripts[code]) {
        renderTranscriptInDrawer(state.library.transcripts[code]);
      }
    }
  });

  document.getElementById("extractHookBtn").addEventListener("click", triggerVisualHookExtraction);

  document.getElementById("transcribeReelBtn").addEventListener("click", async () => {
    const post = state.activePost;
    if (!post) return;
    const btn = document.getElementById("transcribeReelBtn");
    btn.disabled = true;
    btn.textContent = "Transcribing on GPU…";
    try {
      const code = post.shortcode || post.code;
      const res = await apiPost("/api/transcribe", {
        cacheKey: code,
        shortcode: code,
        mediaUrl: post.audioUrl || post.videoUrl || null,
        platform: post.platform || "instagram",
        profileName: post.username || "",
      });
      if (!res?.ok) {
        toast(res?.message || "Whisper transcription failed");
        return;
      }
      if (code) state.library.transcripts[code] = res;
      renderTranscriptInDrawer(res);
      toast("Transcribed locally with Whisper Metal GPU");
    } finally {
      btn.disabled = false;
      btn.textContent = "Transcribe Audio";
    }
  });

  document.getElementById("drawerMineCommentsBtn").addEventListener("click", async () => {
    const post = state.activePost;
    if (!post) return;
    const code = post.shortcode || post.code;
    const btn = document.getElementById("drawerMineCommentsBtn");
    btn.disabled = true;
    btn.textContent = "Mining…";
    try {
      const res = await apiPost("/api/comments", { shortcode: code, limit: 50 });
      if (!res?.ok) {
        toast(res?.message || "Comments unavailable on this platform");
        return;
      }
      state.library.comments[code] = res;
      const comWrap = document.getElementById("drawerCommentsResult");
      comWrap.hidden = false;
      const qHtml = res.questions?.length
        ? `<div class="section-eyebrow" style="margin-bottom:6px;">Audience Questions (${res.questions.length})</div>` +
          renderCommentStack(res.questions.slice(0, 10), "")
        : `<div class="section-eyebrow" style="margin-bottom:6px;">Top Liked Comments</div>` +
          renderCommentStack(res.topComments?.slice(0, 12), "No comments found.");
      comWrap.innerHTML = qHtml;
    } finally {
      btn.disabled = false;
      btn.textContent = "Mine Comments";
    }
  });

  document.getElementById("copyOcrBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(document.getElementById("onScreenOcrText").textContent || "");
    toast("Copied on-screen hook text");
  });

  document.getElementById("copyHookBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(document.getElementById("spokenHookText").textContent || "");
    toast("Copied spoken hook");
  });

  document.getElementById("copyFullScriptBtn").addEventListener("click", () => {
    const code = state.activePost?.shortcode || state.activePost?.code;
    const tr = code ? state.library.transcripts[code] : null;
    if (tr?.transcription) {
      navigator.clipboard.writeText(tr.transcription);
      toast("Copied full transcript");
    }
  });

  document.getElementById("focusChromeBtn").addEventListener("click", async () => {
    await apiPost("/api/focus", { any: true });
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────

initTheme();
initNavigation();
syncSurfaceDropdown();
initCreatorSpy();
initNicheRadar();
initVideoDbView();
initMasterDatabaseView();
initCommentsView();
initVault();
initInspectorDrawer();

await refreshStatus();
await loadLibrary();
setInterval(refreshStatus, 3500);
