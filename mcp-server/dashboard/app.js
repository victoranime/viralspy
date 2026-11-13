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
  dbCategory: "all",
  dbPosts: [],
  dbCreators: [],
  videoDbCategory: "all",
  categories: ["Health", "Pets", "Fitness", "Beauty", "Finance", "Tech & AI", "Lifestyle"],
  creatorCategoryMap: {},
  dbCategoryCounts: {},
  videoDbCategoryCounts: {},
  expandedPacks: new Set(),
  vaultTab: "saved",
  myAccounts: {
    activeAccountId: "pets_wade",
    subTab: "priority",
    ctaFilter: "all",
    excludeLocalDrafts: false,
    ownSort: "outlier",
    reproFilter: "all",
    selectedCtaByCode: {},
    data: null,
  },
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
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw lastErr;
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
  if (viewName === "accounts") loadMyAccounts();
  if (viewName === "vault") renderVault();
  if (viewName === "videodb") renderVideoDb();
  if (viewName === "database") refreshMasterDatabase();
}

function syncViewFromHash() {
  const h = (window.location.hash || "").replace(/^#/, "").toLowerCase();
  if (h === "accounts" || h === "my-accounts") switchView("accounts");
  else if (h === "saved" || h === "vault") switchView("vault");
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

    if (Array.isArray(data.categories) && data.categories.length) {
      state.categories = data.categories;
    }
    if (data.creatorMap) state.creatorCategoryMap = data.creatorMap;
    if (data.dbCategoryCounts) state.dbCategoryCounts = data.dbCategoryCounts;
    if (data.videoDbCategoryCounts) state.videoDbCategoryCounts = data.videoDbCategoryCounts;

    populateCategorySelects();
    renderVideoDbCategoryBar();
    renderMasterDbCategoryBar();
    updateSidebarCounts();
    renderRecentScans();

    if (!state.currentScan && state.library.recentScans.length > 0) {
      state.currentScan = state.library.recentScans[0];
      renderSpyResults();
    } else if (state.currentScan) {
      const freshScan = state.library.recentScans.find(
        (s) => s.username === state.currentScan.username && (s.platform || "instagram") === (state.currentScan.platform || "instagram")
      );
      if (freshScan) state.currentScan = freshScan;
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

// ── Thematic Categories & Live Post Description Hydration ───────────────────

function getEffectiveCategories() {
  const ordered = ["Health", "Pets"];
  const add = (c) => {
    const t = String(c || "").trim();
    if (!t || t === "Uncategorized" || t.toLowerCase() === "all") return;
    if (!ordered.some((x) => x.toLowerCase() === t.toLowerCase())) ordered.push(t);
  };
  (state.categories || []).forEach(add);
  Object.keys(state.dbCategoryCounts || {}).forEach(add);
  Object.keys(state.videoDbCategoryCounts || {}).forEach(add);
  return ordered;
}

function buildInlineCategoryOptionsHtml(selectedCategory) {
  const cur = String(selectedCategory || "Uncategorized").trim() || "Uncategorized";
  const cats = getEffectiveCategories();
  if (cur !== "Uncategorized" && !cats.some((c) => c.toLowerCase() === cur.toLowerCase())) {
    cats.push(cur);
  }
  return (
    cats
      .map((c) => `<option value="${esc(c)}" ${c.toLowerCase() === cur.toLowerCase() ? "selected" : ""}>${esc(c)}</option>`)
      .join("") +
    `<option value="Uncategorized" ${cur === "Uncategorized" ? "selected" : ""}>Uncategorized</option>` +
    `<option value="__add__">+ New Category…</option>`
  );
}

async function promptAddNewCategory() {
  const raw = window.prompt("New thematic category name (e.g. Cooking, Mindset, Tech):");
  if (!raw || !raw.trim()) return null;
  try {
    const res = await apiPost("/api/categories/add", { name: raw.trim() });
    if (res?.ok && res.category) {
      if (Array.isArray(res.categories)) state.categories = res.categories;
      if (res.dbCounts) state.dbCategoryCounts = res.dbCounts;
      if (res.videoDbCounts) state.videoDbCategoryCounts = res.videoDbCounts;
      populateCategorySelects();
      renderVideoDbCategoryBar();
      renderMasterDbCategoryBar();
      toast(`Category "${res.category}" added`);
      return res.category;
    }
  } catch (_) {
    toast("Could not create category");
  }
  return null;
}

function populateCategorySelects() {
  const cats = getEffectiveCategories();
  ["spyCategorySelect", "radarCategorySelect", "reproduceCategorySelect"].forEach((id) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value && sel.value !== "__add__" ? sel.value : "";
    sel.innerHTML =
      `<option value="">Auto Niche</option>` +
      cats.map((c) => `<option value="${esc(c)}" ${c === prev ? "selected" : ""}>${esc(c)}</option>`).join("") +
      `<option value="__add__">+ New Category…</option>`;
    if (!sel.dataset.wiredAdd) {
      sel.dataset.wiredAdd = "1";
      sel.addEventListener("change", async () => {
        if (sel.value === "__add__") {
          const created = await promptAddNewCategory();
          sel.value = created || "";
        }
      });
    }
  });
}

function renderCategoryBar(containerId, countsMap, totalCount, activeCat, onSelect) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const cats = getEffectiveCategories();
  const visibleCats = cats.filter((c, idx) => {
    if (c === "Health" || c === "Pets") return true;
    if ((countsMap?.[c] || 0) > 0) return true;
    if (activeCat && activeCat.toLowerCase() === c.toLowerCase()) return true;
    return idx < 7 && !(
      ["Fitness", "Beauty", "Finance", "Tech & AI", "Lifestyle"].includes(c) && (countsMap?.[c] || 0) === 0
    );
  });
  if ((countsMap?.Uncategorized || 0) > 0 || activeCat === "Uncategorized") {
    visibleCats.push("Uncategorized");
  }

  const pillsHtml = [
    `<button type="button" class="cat-pill ${activeCat === "all" ? "is-active" : ""}" data-cat-filter="all">
      <span>All</span>
      <span class="cat-pill-count">${totalCount}</span>
    </button>`,
    ...visibleCats.map((c) => {
      const cnt = countsMap?.[c] || 0;
      const isAct = activeCat.toLowerCase() === c.toLowerCase();
      return `<button type="button" class="cat-pill ${isAct ? "is-active" : ""}" data-cat-filter="${esc(c)}">
        <span>${esc(c)}</span>
        <span class="cat-pill-count">${cnt}</span>
      </button>`;
    }),
    `<button type="button" class="cat-pill cat-pill-add" data-cat-add="1" title="Create a new thematic category">+ Category</button>`,
  ].join("");

  el.innerHTML = pillsHtml;
  el.querySelectorAll("[data-cat-filter]").forEach((btn) => {
    btn.addEventListener("click", () => onSelect(btn.dataset.catFilter));
  });
  el.querySelector("[data-cat-add]")?.addEventListener("click", async () => {
    const created = await promptAddNewCategory();
    if (created) onSelect(created);
  });
}

function renderVideoDbCategoryBar() {
  const packs = state.library.reproducePacks || [];
  const liveCounts = {};
  for (const p of packs) {
    const c = p.category || "Uncategorized";
    liveCounts[c] = (liveCounts[c] || 0) + 1;
  }
  state.videoDbCategoryCounts = liveCounts;
  renderCategoryBar("videoDbCategoryBar", liveCounts, packs.length, state.videoDbCategory, (cat) => {
    state.videoDbCategory = cat;
    renderVideoDb();
  });
}

function renderMasterDbCategoryBar() {
  const total = state.library.postsDbCount || Object.values(state.dbCategoryCounts || {}).reduce((s, n) => s + n, 0);
  renderCategoryBar("masterDbCategoryBar", state.dbCategoryCounts || {}, total, state.dbCategory, (cat) => {
    state.dbCategory = cat;
    refreshMasterDatabase();
  });
}

async function assignCategoryToItem({ category, platform = "instagram", username = "", shortcode = "", applyToCreator = true }) {
  const res = await apiPost("/api/categories/assign", {
    category,
    platform,
    username,
    shortcode,
    applyToCreator,
  });
  if (!res?.ok) {
    toast(res?.message || "Failed to update category");
    return null;
  }
  const cat = res.category;
  if (Array.isArray(res.categories)) state.categories = res.categories;
  if (res.dbCounts) state.dbCategoryCounts = res.dbCounts;
  if (res.videoDbCounts) state.videoDbCategoryCounts = res.videoDbCounts;

  const cleanU = String(username || "").replace(/^@/, "").toLowerCase();
  const matchItem = (it) => {
    if (!it) return false;
    const itCode = it.shortcode || it.code || "";
    const itUser = String(it.username || "").replace(/^@/, "").toLowerCase();
    if (shortcode && itCode === shortcode) return true;
    if (applyToCreator && cleanU && itUser === cleanU) return true;
    return false;
  };

  [
    state.currentScan?.posts,
    state.radarRun?.leaderboard,
    state.dbPosts,
    state.library.savedPosts,
    state.library.reproducePacks,
  ].forEach((arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((it) => {
      if (matchItem(it)) it.category = cat;
    });
  });
  if (matchItem(state.activePost)) state.activePost.category = cat;

  populateCategorySelects();
  renderVideoDbCategoryBar();
  renderMasterDbCategoryBar();
  if (document.getElementById("view-spy").classList.contains("is-active")) renderSpyResults();
  if (document.getElementById("view-radar").classList.contains("is-active")) renderRadarResults();
  if (document.getElementById("view-videodb").classList.contains("is-active")) renderVideoDb();
  if (document.getElementById("view-database").classList.contains("is-active")) refreshMasterDatabase();
  if (document.getElementById("view-vault").classList.contains("is-active")) renderVault();

  toast(
    applyToCreator && cleanU
      ? `Assigned @${cleanU} to "${cat}"`
      : `Assigned post to "${cat}"`
  );
  return cat;
}

function applyHydratedPostInMemory(updated) {
  if (!updated) return;
  const code = updated.shortcode || updated.code || "";
  if (!code) return;

  const mergeInto = (it) => {
    if (!it) return;
    if ((it.shortcode || it.code) !== code) return;
    if (updated.caption) it.caption = updated.caption;
    if (updated.videoUrl) it.videoUrl = updated.videoUrl;
    if (updated.thumbnailUrl && !it.thumbnailUrl) it.thumbnailUrl = updated.thumbnailUrl;
    if (updated.username && !it.username) it.username = updated.username;
    if (updated.category) it.category = updated.category;
    if (updated.views != null && updated.views > 0) it.views = updated.views;
    if (updated.likes != null && updated.likes >= 0) it.likes = updated.likes;
    if (updated.comments != null && updated.comments >= 0) it.comments = updated.comments;
  };

  mergeInto(state.activePost);
  [
    state.currentScan?.posts,
    state.radarRun?.leaderboard,
    state.dbPosts,
    state.library.savedPosts,
    state.library.reproducePacks,
  ].forEach((arr) => {
    if (Array.isArray(arr)) arr.forEach(mergeInto);
  });

  if (updated.caption) {
    document.querySelectorAll(`.reel-card[data-code="${CSS.escape(code)}"] .reel-caption`).forEach((el) => {
      el.textContent = updated.caption;
      el.classList.remove("is-muted-hint");
    });
  }
}

async function fetchPostDetailsForInspector(post, { force = false, silent = false } = {}) {
  const code = post?.shortcode || post?.code || "";
  if (!code) return null;
  const capEl = document.getElementById("drawerCaption");
  const refreshBtn = document.getElementById("refreshCaptionBtn");

  if (state.activePost === post && capEl) {
    capEl.textContent = "Retrieving post description from Instagram…";
    capEl.classList.add("is-loading");
  }
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Fetching…";
  }

  try {
    const res = await apiPost("/api/post-details", {
      shortcode: code,
      platform: post.platform || "instagram",
      username: post.username || "",
      url: post.url || "",
      force,
    });
    if (!res?.ok || !res.post) {
      if (state.activePost === post && capEl) {
        capEl.classList.remove("is-loading");
        capEl.textContent = post.caption || "Description unavailable (check Chrome connection)";
      }
      if (!silent) toast(res?.message || "Could not fetch post description");
      return null;
    }

    applyHydratedPostInMemory(res.post);

    if (state.activePost === post) {
      if (capEl) {
        capEl.classList.remove("is-loading");
        capEl.textContent = res.post.caption || "No description written on this post.";
      }
      if (res.post.username) {
        document.getElementById("drawerCreator").textContent = `@${res.post.username}`;
      }
      if (res.post.views != null) document.getElementById("drawerViews").textContent = fmtCompact(res.post.views);
      if (res.post.likes != null) document.getElementById("drawerLikes").textContent = fmtCompact(res.post.likes);
      if (res.post.comments != null) document.getElementById("drawerComments").textContent = fmtCompact(res.post.comments);

      const dlBtn = document.getElementById("drawerDownloadMp4Btn");
      if (res.post.videoUrl && dlBtn.hidden) {
        dlBtn.hidden = false;
        dlBtn.href = proxyMedia(res.post.videoUrl, true, `${res.post.username || "reel"}_${code}.mp4`);
      }
      const videoWrap = document.getElementById("drawerVideoWrap");
      if (res.post.videoUrl && videoWrap && !videoWrap.querySelector("video")) {
        const posterSrc = res.post.thumbnailUrl ? proxyMedia(res.post.thumbnailUrl) : "";
        videoWrap.innerHTML = `<video src="${esc(proxyMedia(res.post.videoUrl))}" poster="${esc(
          posterSrc
        )}" controls playsinline preload="metadata"></video>`;
      }
    }

    if (!silent) {
      toast(res.post.caption ? "Post description retrieved & saved to DB" : "Verified: post has an empty caption");
    }
    return res.post;
  } catch (_) {
    if (state.activePost === post && capEl) {
      capEl.classList.remove("is-loading");
      capEl.textContent = post.caption || "Could not reach local Hub";
    }
    if (!silent) toast("Network error fetching post description");
    return null;
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Fetch";
    }
  }
}

async function batchHydrateTopCaptions({ posts = [], username = "", platform = "instagram" }, btn = null) {
  const missing = (posts || []).filter((p) => !p.caption && (p.shortcode || p.code)).slice(0, 20);
  const shortcodes = missing.map((p) => p.shortcode || p.code);
  if (!shortcodes.length && !username) {
    toast("All visible top posts already have their descriptions saved!");
    return;
  }
  const orig = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Fetching Captions…";
  }
  setBanner(true, `Retrieving descriptions for ${shortcodes.length || 20} top posts via Chrome…`);
  try {
    const res = await apiPost("/api/hydrate-captions", {
      shortcodes,
      username,
      platform,
      limit: 20,
    });
    if (!res?.ok) {
      toast(res?.message || "Caption hydration failed — verify Chrome is connected");
      return;
    }
    await loadLibrary();
    if (document.getElementById("view-database").classList.contains("is-active")) {
      await refreshMasterDatabase();
    }
    toast(`Retrieved & saved ${res.hydrated || 0} post descriptions to Master DB!`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = orig || "Fetch Top Captions";
    }
    setBanner(false);
  }
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
    .map((sc, idx) => {
      const firstCat = sc.category || sc.posts?.[0]?.category || "";
      const tag = firstCat && firstCat !== "Uncategorized" ? firstCat : (sc.platform || "ig").slice(0, 2).toUpperCase();
      return `
      <button type="button" class="recent-scan-btn" data-scan-idx="${idx}">
        <span>@${esc(sc.username)}</span>
        <span class="recent-scan-meta">${esc(tag)} · ${(sc.posts || []).length}</span>
      </button>
    `;
    })
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
      const cat = p.category || "Uncategorized";
      const hasCaption = Boolean(p.caption && String(p.caption).trim());

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
          <div class="reel-cat-row">
            <span class="badge-category" data-cat="${esc(cat)}">${esc(cat)}</span>
          </div>
          <p class="reel-caption ${hasCaption ? "" : "is-muted-hint"}">${esc(
        hasCaption ? p.caption : "Click Inspect to load post description"
      )}</p>
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
  const headers = ["Rank", "Category", "Platform", "Username", "Shortcode", "URL", "Created", "OutlierScore", "VelocityScore", "ViewsPerHour", "Views", "Likes", "Comments", "VideoMP4", "Caption"];
  const csvLines = [
    headers.join(","),
    ...rows.map((r, i) =>
      [
        i + 1,
        `"${String(r.category || "Uncategorized").replace(/"/g, '""')}"`,
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

  document.getElementById("spyHydrateCaptionsBtn")?.addEventListener("click", async (ev) => {
    const scan = state.currentScan;
    if (!scan?.posts?.length) {
      toast("Scan or select a creator profile first");
      return;
    }
    const sorted = sortPostsClient(scan.posts, state.spySort);
    await batchHydrateTopCaptions(
      {
        posts: sorted,
        username: scan.username,
        platform: scan.platform || state.platform,
      },
      ev.currentTarget
    );
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
    const categorySel = document.getElementById("spyCategorySelect")?.value || "";
    const category = categorySel === "__add__" ? "" : categorySel;
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
        category,
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
    const radarCatVal = document.getElementById("radarCategorySelect")?.value || "";
    const category = radarCatVal === "__add__" ? "" : radarCatVal;
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
        category,
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
  const allPacks = state.library.reproducePacks || [];
  renderVideoDbCategoryBar();

  const packs =
    state.videoDbCategory === "all"
      ? allPacks
      : allPacks.filter(
          (p) => String(p.category || "Uncategorized").toLowerCase() === state.videoDbCategory.toLowerCase()
        );

  const emptyEl = document.getElementById("videoDbEmptyState");
  const emptyTitle = document.getElementById("videoDbEmptyTitle");
  const emptyDesc = document.getElementById("videoDbEmptyDesc");
  const listEl = document.getElementById("videoDbList");

  if (!packs.length) {
    emptyEl.hidden = false;
    if (allPacks.length > 0 && state.videoDbCategory !== "all") {
      if (emptyTitle) emptyTitle.textContent = `No Reproduce Packs in "${state.videoDbCategory}" yet`;
      if (emptyDesc) {
        emptyDesc.innerHTML = `Paste a Reel link above with <strong>${esc(
          state.videoDbCategory
        )}</strong> selected, or click <strong>Reproduce</strong> on any ${esc(state.videoDbCategory)} post.`;
      }
    } else {
      if (emptyTitle) emptyTitle.textContent = "No Reproduce Packs yet";
      if (emptyDesc) {
        emptyDesc.innerHTML =
          'Paste a Reel link above, click <strong>Reproduce</strong> on any card in Studio, or click the clapperboard icon right above Save directly on Instagram &amp; TikTok.';
      }
    }
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
      const cat = p.category || "Uncategorized";
      const hasCap = Boolean(p.caption && String(p.caption).trim());

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
              <select class="category-select-pill" data-pack-cat data-cat="${esc(cat)}" title="Change thematic category">
                ${buildInlineCategoryOptionsHtml(cat)}
              </select>
              ${outBadge}
              <span class="mini-tag">${p.sceneCount || 0} scenes · ${Math.round(p.durationSeconds || 0)}s</span>
              ${p.wordsPerMinute ? `<span class="mini-tag">${p.wordsPerMinute} WPM</span>` : ""}
            </div>

            ${p.spokenHook ? `<p class="pack-hook-quote">“${esc(p.spokenHook)}”</p>` : ""}
            ${p.onScreenHook ? `<p class="pack-ocr-line">On-Screen OCR: ${esc(p.onScreenHook)}</p>` : ""}
            <p class="pack-transcript-preview">${esc(p.transcript || "No spoken dialogue detected.")}</p>

            <div class="pack-caption-box">
              <div class="pack-caption-head">
                <span class="section-eyebrow">Post Description (caption.txt)</span>
                <div class="drawer-caption-actions">
                  ${
                    hasCap
                      ? `<button type="button" class="btn-ghost-xs" data-pack-act="copy-caption">Copy Caption</button>`
                      : `<button type="button" class="btn-ghost-xs" data-pack-act="fetch-caption">Fetch Description</button>`
                  }
                </div>
              </div>
              <p class="pack-caption-text">${esc(
                hasCap ? p.caption : "No caption cached yet — click Fetch Description to retrieve from Instagram."
              )}</p>
            </div>

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
    const pack = allPacks.find((x) => x.packId === packId);
    if (!pack) return;

    card.querySelector("[data-pack-cat]")?.addEventListener("change", async (ev) => {
      const sel = ev.currentTarget;
      let chosen = sel.value;
      if (chosen === "__add__") {
        const created = await promptAddNewCategory();
        if (!created) {
          sel.value = pack.category || "Uncategorized";
          return;
        }
        chosen = created;
      }
      await assignCategoryToItem({
        category: chosen,
        platform: pack.platform || "instagram",
        username: pack.username || "",
        shortcode: pack.shortcode || "",
        applyToCreator: Boolean(pack.username),
      });
    });

    card.querySelector('[data-pack-act="copy-caption"]')?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(pack.caption || "");
      toast("Copied original post description!");
    });

    card.querySelector('[data-pack-act="fetch-caption"]')?.addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = "Fetching…";
      const updated = await fetchPostDetailsForInspector(pack, { force: true, silent: false });
      if (updated?.caption) {
        pack.caption = updated.caption;
        renderVideoDb();
      } else {
        btn.disabled = false;
        btn.textContent = "Fetch Description";
      }
    });

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
    const catSel = document.getElementById("reproduceCategorySelect")?.value || "";
    const category = catSel === "__add__" ? "" : catSel;
    const btn = document.getElementById("reproduceSubmitBtn");
    const pack = await runOneShotReproduce({ url, category }, btn);
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
    category: state.dbCategory,
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
    if (res.categoryCounts) state.dbCategoryCounts = res.categoryCounts;
    if (Array.isArray(res.categories) && res.categories.length) state.categories = res.categories;
    renderMasterDbCategoryBar();
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

  document.getElementById("dbHydrateCaptionsBtn")?.addEventListener("click", async (ev) => {
    if (!state.dbPosts.length) {
      toast("No posts in current filter");
      return;
    }
    await batchHydrateTopCaptions({ posts: state.dbPosts }, ev.currentTarget);
  });

  document.getElementById("dbExportCsvBtn").addEventListener("click", () => {
    exportPostsRows(state.dbPosts, `viralspy_master_db_${state.dbCategory}_${state.dbSort}`, "csv");
  });
  document.getElementById("dbExportJsonBtn").addEventListener("click", () => {
    exportPostsRows(state.dbPosts, `viralspy_master_db_${state.dbCategory}_${state.dbSort}`, "json");
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
  const drawerCatSel = document.getElementById("drawerCategorySelect");
  const curCat = post.category || "Uncategorized";
  if (drawerCatSel) {
    drawerCatSel.innerHTML = buildInlineCategoryOptionsHtml(curCat);
    drawerCatSel.setAttribute("data-cat", curCat);
  }

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

  const capEl = document.getElementById("drawerCaption");
  const resolvedCaption = post.caption || existingPack?.caption || "";
  if (resolvedCaption) {
    post.caption = resolvedCaption;
    capEl.classList.remove("is-loading");
    capEl.textContent = resolvedCaption;
  } else {
    capEl.classList.add("is-loading");
    capEl.textContent = "Retrieving post description from Instagram…";
  }

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

  // Auto-fetch missing post description immediately from Instagram via Chrome extension
  if (!resolvedCaption && code) {
    fetchPostDetailsForInspector(post, { force: false, silent: true });
  }
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

  document.getElementById("drawerCategorySelect")?.addEventListener("change", async (ev) => {
    const post = state.activePost;
    if (!post) return;
    const sel = ev.currentTarget;
    let chosen = sel.value;
    if (chosen === "__add__") {
      const created = await promptAddNewCategory();
      if (!created) {
        sel.value = post.category || "Uncategorized";
        return;
      }
      chosen = created;
    }
    const updatedCat = await assignCategoryToItem({
      category: chosen,
      platform: post.platform || "instagram",
      username: post.username || "",
      shortcode: post.shortcode || post.code || "",
      applyToCreator: Boolean(post.username),
    });
    if (updatedCat) {
      sel.innerHTML = buildInlineCategoryOptionsHtml(updatedCat);
      sel.setAttribute("data-cat", updatedCat);
    }
  });

  document.getElementById("refreshCaptionBtn")?.addEventListener("click", async () => {
    if (!state.activePost) return;
    await fetchPostDetailsForInspector(state.activePost, { force: true, silent: false });
  });

  document.getElementById("copyCaptionBtn")?.addEventListener("click", () => {
    const txt = state.activePost?.caption || document.getElementById("drawerCaption")?.textContent || "";
    if (!txt || txt.startsWith("Retrieving post description")) return;
    navigator.clipboard.writeText(txt);
    toast("Copied post description to clipboard");
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

// ── View 0: My Accounts Intelligence Hub ────────────────────────────────────

async function loadMyAccounts() {
  try {
    const qs = new URLSearchParams({
      accountId: state.myAccounts.activeAccountId || "pets_wade",
      excludeLocalDrafts: state.myAccounts.excludeLocalDrafts ? "1" : "0",
    });
    const res = await fetch(`/api/my-accounts?${qs.toString()}`).then((r) => r.json());
    if (!res?.ok) return;
    state.myAccounts.data = res;
    if (res.activeAccountId) state.myAccounts.activeAccountId = res.activeAccountId;
    renderMyAccounts();
  } catch (_) {}
}

function renderMyAccounts() {
  const data = state.myAccounts.data;
  if (!data || !data.account) return;
  const acc = data.account;
  const kpis = data.kpis || {};
  const cron = data.cron || {};

  // Account Switcher Pills
  const seg = document.getElementById("accountsProfileSeg");
  if (seg) {
    seg.innerHTML = (data.accounts || [])
      .map(
        (a) =>
          `<button type="button" class="seg-btn ${a.id === acc.id ? "is-active" : ""}" data-acc-id="${esc(a.id)}">@${esc(
            a.username
          )} · ${esc(a.category || "Niche")}</button>`
      )
      .join("");
    seg.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const nextId = btn.dataset.accId;
        state.myAccounts.activeAccountId = nextId;
        await apiPost("/api/my-accounts/config", { action: "setActiveAccount", accountId: nextId });
        await loadMyAccounts();
      });
    });
  }

  // Cron bar
  const cronPill = document.getElementById("cronStatusPill");
  const cronSel = document.getElementById("cronIntervalSelect");
  if (cronSel) {
    cronSel.value = cron.enabled ? String(cron.intervalHours || 6) : "0";
  }
  if (cronPill) {
    const lastTxt = cron.lastRunAt ? `Last sync: ${fmtRelativeAge(cron.lastRunAt)}` : "Waiting for 1st sync";
    const nextTxt = cron.enabled && cron.nextRunAt ? `Next: ${fmtRelativeAge(cron.nextRunAt).replace(" ago", "")}` : "Paused";
    cronPill.textContent = cron.running
      ? "⏳ Cron Sync Running…"
      : cron.enabled
      ? `⏱ Auto-Cron ${cron.intervalHours || 6}h · ${lastTxt}`
      : `⏸ Auto-Cron Paused · ${lastTxt}`;
    cronPill.classList.toggle("is-running", !!cron.running);
    cronPill.title = `Next scheduled check: ${nextTxt}`;
  }

  const syncOwnBtn = document.getElementById("syncOwnAccountBtn");
  if (syncOwnBtn) syncOwnBtn.textContent = `Sync @${acc.username}`;

  // KPI cards
  document.getElementById("accKpiOwnCount").textContent = String(kpis.ownPublishedCount || 0);
  document.getElementById("accKpiOwnSub").textContent = `${kpis.localReelsCount || 0} reels in local Reels/ folder`;

  document.getElementById("accKpiOwnPerf").textContent = kpis.ownMedianViews
    ? `${fmtCompact(kpis.ownMedianViews)} med`
    : "—";
  document.getElementById("accKpiOwnPerfSub").textContent = kpis.ownPeakOutlier
    ? `Peak ${kpis.ownPeakOutlier}x outlier on @${acc.username}`
    : `Click Sync @${acc.username} to benchmark`;

  document.getElementById("accKpiReproCount").textContent = `${kpis.reproducedPublishedCount || 0} IG`;
  document.getElementById("accKpiReproSub").textContent = `+${kpis.reproducedLocalDraftCount || 0} prepared locally (not posted yet)`;

  document.getElementById("accKpiCompCount").textContent = `${kpis.trackedCompetitorsCount || 0} creators`;
  document.getElementById("accKpiCompSub").textContent = `${fmtCompact(kpis.competitorPostsCount || 0)} posts · ${
    kpis.recent7dBreakouts || 0
  } breakouts (7d)`;

  // Sub-tabs visibility
  const sub = state.myAccounts.subTab || "priority";
  document.querySelectorAll("#accountsSubTabSeg .seg-btn").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.acctab === sub);
  });
  ["priority", "own", "reproduced", "competitors"].forEach((name) => {
    const el = document.getElementById(`accPanel-${name}`);
    if (el) el.hidden = name !== sub;
  });

  if (sub === "priority") renderAccountsPriorityTab(data);
  if (sub === "own") renderAccountsOwnPostsTab(data);
  if (sub === "reproduced") renderAccountsReproTab(data);
  if (sub === "competitors") renderAccountsCompetitorsTab(data);
}

function getSelectedCtaVariant(post) {
  const chosenKey = state.myAccounts.selectedCtaByCode[post.code] || post.cta?.recommendedCtaType || "multivitamin";
  return post.cta?.variants?.[chosenKey] || post.cta;
}

function renderAccountsPriorityTab(data) {
  const listEl = document.getElementById("accPriorityList");
  if (!listEl) return;
  const ctaFilter = state.myAccounts.ctaFilter || "all";
  let items = [...(data.priorityTop10 || [])];
  if (ctaFilter !== "all") {
    items = items.filter((p) => {
      const selKey = state.myAccounts.selectedCtaByCode[p.code] || p.cta?.recommendedCtaType;
      return selKey === ctaFilter;
    });
  }

  if (!items.length) {
    listEl.innerHTML = `<div class="empty-stage"><h2>No Priority Candidates in This Filter</h2><p>Switch CTA filter back to All CTAs or run Sync All to fetch fresh competitor breakouts.</p></div>`;
    return;
  }

  listEl.innerHTML = items
    .map((p) => {
      const code = p.code || p.shortcode || "";
      const coverSrc = p.thumbnailUrl ? proxyMedia(p.thumbnailUrl) : "";
      const pack = getPackForCode(code);
      const chosenKey = state.myAccounts.selectedCtaByCode[code] || p.cta?.recommendedCtaType || "multivitamin";
      const activeVar = getSelectedCtaVariant(p) || {};
      const variantsArr = Object.values(p.cta?.variants || {});
      const hookPreview = p.spokenHook || p.onScreenHook || p.caption || "Click Inspect or Reproduce .zip to extract spoken hook & scenes.";
      const age = fmtRelativeAge(p.createDate, p.ageHours);

      return `
      <article class="priority-card" data-code="${esc(code)}">
        <div class="priority-thumb-col" data-action="inspect">
          ${
            coverSrc
              ? `<img src="${esc(coverSrc)}" alt="" loading="lazy" />`
              : `<div class="priority-no-thumb">9:16</div>`
          }
          <span class="priority-rank-badge">#${p.priorityRank || 1} PRIO</span>
          ${p.outlierScore != null ? `<span class="priority-outlier-badge">${p.outlierScore.toFixed(1)}x</span>` : ""}
        </div>

        <div class="priority-main-col">
          <div class="priority-head-row">
            <div class="priority-creator-group">
              <strong class="priority-creator">@${esc(p.username || "competitor")}</strong>
              <span class="priority-score-pill">Score ${p.priorityScore}/100</span>
              ${
                p.reproStatus === "local_draft_only" && p.localDraft
                  ? `<span class="mini-tag is-warn-tag" title="Prepared locally in ${esc(
                      p.localDraft.folderName
                    )} but not detected live on @${esc(data.account.username)}">📁 Local Reel #${esc(
                      p.localDraft.reelNumber
                    )} (Not on IG)</span>`
                  : `<span class="mini-tag is-fresh-tag">New Opportunity</span>`
              }
            </div>
            <div class="priority-metrics-row">
              ${p.views != null ? `<span>▶ ${fmtCompact(p.views)}</span>` : ""}
              ${p.viewsPerHour != null ? `<span>⚡ ${fmtCompact(p.viewsPerHour)}/h</span>` : ""}
              ${p.comments != null ? `<span>💬 ${fmtCompact(p.comments)}</span>` : ""}
              ${age ? `<span>${esc(age)}</span>` : ""}
            </div>
          </div>

          <div class="priority-reasons-row">
            ${(p.priorityReasons || []).map((r) => `<span class="reason-chip">${esc(r)}</span>`).join("")}
          </div>

          <p class="priority-hook-preview">${esc(hookPreview.slice(0, 260))}${hookPreview.length > 260 ? "…" : ""}</p>

          <!-- Interactive CTA & Funnel Studio -->
          <div class="cta-studio-box">
            <div class="cta-studio-head">
              <div class="cta-pills-row">
                ${variantsArr
                  .map(
                    (v) => `
                  <button type="button" class="cta-pill ${v.key === chosenKey ? "is-active" : ""} ${
                      v.key === p.cta?.recommendedCtaType ? "is-recommended" : ""
                    }" data-action="switch-cta" data-cta-key="${esc(v.key)}">
                    ${v.key === p.cta?.recommendedCtaType ? "✦ " : ""}${esc(v.label)}
                  </button>`
                  )
                  .join("")}
              </div>
              <span class="cta-kw-badge">Keyword: <strong>${esc(activeVar.keyword || "HABITS")}</strong></span>
            </div>

            <p class="cta-why-line">${esc(
              chosenKey === p.cta?.recommendedCtaType ? p.cta?.whyAngle || activeVar.why : activeVar.why || ""
            )}</p>

            <div class="cta-script-box">
              <div class="cta-script-label">Ready-to-shoot Transition + CTA (${esc(activeVar.productName || activeVar.label || "")})</div>
              <p class="cta-script-text">"${esc(activeVar.transitionLine || "")} ${esc(activeVar.ctaLine || "")}"</p>
            </div>
          </div>

          <div class="priority-actions-row">
            <button type="button" class="btn-secondary btn-sm" data-action="copy-cta">Copy CTA Script</button>
            <button type="button" class="btn-primary btn-sm" data-action="reproduce">${
              pack ? "Pack .zip ✓" : "Reproduce .zip ✦"
            }</button>
            <button type="button" class="btn-secondary btn-sm" data-action="inspect">Inspect Reel</button>
            <a href="${esc(p.url || `https://www.instagram.com/reel/${code}/`)}" target="_blank" rel="noopener noreferrer" class="btn-secondary btn-sm">Open IG ↗</a>
            <button type="button" class="btn-ghost-xs" data-action="mark-done" title="Mark as already reproduced on IG">Mark Done ✓</button>
            <button type="button" class="btn-ghost-xs" data-action="ignore" title="Skip this candidate from Top 10">Skip ✕</button>
          </div>
        </div>
      </article>
      `;
    })
    .join("");

  listEl.querySelectorAll(".priority-card").forEach((card) => {
    const code = card.dataset.code;
    const post = (data.priorityTop10 || []).find((x) => (x.code || x.shortcode) === code);
    if (!post) return;

    card.querySelectorAll('[data-action="inspect"]').forEach((el) => {
      el.addEventListener("click", () => openInspector(post));
    });

    card.querySelectorAll('[data-action="switch-cta"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        state.myAccounts.selectedCtaByCode[code] = btn.dataset.ctaKey;
        renderAccountsPriorityTab(data);
      });
    });

    card.querySelector('[data-action="copy-cta"]')?.addEventListener("click", async () => {
      const v = getSelectedCtaVariant(post);
      const txt = `Keyword: ${v.keyword}\nProduct/Funnel: ${v.productName}\nScript:\n${v.transitionLine} ${v.ctaLine}`;
      await navigator.clipboard.writeText(txt);
      toast(`Copied ${v.label} CTA script (${v.keyword})`);
    });

    card.querySelector('[data-action="reproduce"]')?.addEventListener("click", async (ev) => {
      await runOneShotReproduce(post, ev.currentTarget);
      await loadMyAccounts();
    });

    card.querySelector('[data-action="mark-done"]')?.addEventListener("click", async () => {
      const res = await apiPost("/api/my-accounts/config", {
        action: "markReproduced",
        shortcode: code,
        status: "published",
      });
      if (res?.ok) {
        state.myAccounts.data = res;
        renderMyAccounts();
        toast("Marked as published on your account — Top 10 updated");
      }
    });

    card.querySelector('[data-action="ignore"]')?.addEventListener("click", async () => {
      const res = await apiPost("/api/my-accounts/config", {
        action: "markReproduced",
        shortcode: code,
        status: "ignored",
      });
      if (res?.ok) {
        state.myAccounts.data = res;
        renderMyAccounts();
        toast("Skipped video — next candidate promoted to Top 10");
      }
    });
  });
}

function renderAccountsOwnPostsTab(data) {
  const emptyEl = document.getElementById("accOwnEmptyCallout");
  const gridEl = document.getElementById("accOwnMediaGrid");
  const counterEl = document.getElementById("accOwnCounter");
  const acc = data.account;
  let posts = [...(data.ownPosts || [])];

  if (!posts.length) {
    emptyEl.hidden = false;
    document.getElementById("accOwnEmptyDesc").textContent = `@${acc.username} has not been scanned from Instagram yet (${
      (data.localReels || []).length
    } local reels exist in Reels/). Click below to fetch your live Instagram Reels & performance metrics.`;
    gridEl.innerHTML = "";
    counterEl.textContent = "0 published posts";
    return;
  }

  emptyEl.hidden = true;
  const sortBy = state.myAccounts.ownSort || "outlier";
  if (sortBy === "commentRate") {
    posts.sort((a, b) => (b.commentRate || 0) - (a.commentRate || 0));
  } else {
    posts = sortPostsClient(posts, sortBy);
  }
  counterEl.textContent = `${posts.length} published IG posts`;
  gridEl.innerHTML = buildMediaGridHtml(posts);
  wireGridEvents(gridEl, posts);
}

function renderAccountsReproTab(data) {
  const listEl = document.getElementById("accReproList");
  const counterEl = document.getElementById("accReproCounter");
  const filter = state.myAccounts.reproFilter || "all";
  let rows = [...(data.reproducedComparisons || [])];
  if (filter !== "all") {
    rows = rows.filter((r) => r.status === filter);
  }
  counterEl.textContent = `${rows.length} comparisons`;

  if (!rows.length) {
    listEl.innerHTML = `<div class="empty-stage"><h2>No Matched Comparisons Yet</h2><p>Sync @${esc(
      data.account.username
    )} from Instagram to compare your published Reels side by side against competitor outliers.</p></div>`;
    return;
  }

  listEl.innerHTML = rows
    .map((r) => {
      const isLive = r.status === "published_on_ig";
      const own = r.ownPost;
      const lr = r.localReel;
      const comp = r.competitorPost;
      const ratioBadge =
        r.viewsRatio != null
          ? `<span class="mini-tag ${r.viewsRatio >= 0.5 ? "is-fresh-tag" : ""}">Perf vs Original: ${(r.viewsRatio * 100).toFixed(0)}%</span>`
          : "";

      return `
      <article class="comparison-row">
        <div class="comparison-status-col">
          <span class="mini-tag ${isLive ? "is-fresh-tag" : "is-warn-tag"}">${
            isLive ? "✓ Published on IG" : "📁 Local Reels/ Only"
          }</span>
          ${ratioBadge}
        </div>
        <div class="comparison-side">
          <span class="section-eyebrow">Your Version (${isLive ? "@" + esc(data.account.username) : "Local Prod"})</span>
          ${
            own
              ? `<strong>${esc((own.caption || lr?.hook || own.code || "").slice(0, 110))}</strong>
                 <div class="comparison-metrics">
                   <span>${own.outlierScore != null ? own.outlierScore.toFixed(1) + "x" : "—"}</span>
                   <span>▶ ${fmtCompact(own.views)}</span>
                   <span>💬 ${fmtCompact(own.comments)}</span>
                 </div>`
              : lr
              ? `<strong>#${esc(lr.reelNumber)} · ${esc(lr.slug)}</strong>
                 <div class="comparison-metrics">
                   <span>Keyword: ${esc(lr.keyword || "—")}</span>
                   <span>Product: ${esc(lr.product || "—")}</span>
                 </div>`
              : `<span class="empty-hint">No local match</span>`
          }
        </div>
        <div class="comparison-side">
          <span class="section-eyebrow">Niche Original ${comp ? `(@${esc(comp.username)})` : ""}</span>
          ${
            comp
              ? `<strong>${esc((comp.spokenHook || comp.caption || comp.code || "").slice(0, 110))}</strong>
                 <div class="comparison-metrics">
                   <span>${comp.outlierScore != null ? comp.outlierScore.toFixed(1) + "x" : "—"}</span>
                   <span>▶ ${fmtCompact(comp.views)}</span>
                   <span>⚡ ${comp.viewsPerHour != null ? fmtCompact(comp.viewsPerHour) + "/h" : "—"}</span>
                   <a href="${esc(comp.url || `https://www.instagram.com/reel/${comp.code}/`)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
                 </div>`
              : `<span class="empty-hint">Original post (no competitor match in DB)</span>`
          }
        </div>
      </article>
      `;
    })
    .join("");
}

function renderAccountsCompetitorsTab(data) {
  const grid = document.getElementById("accCompetitorsGrid");
  if (!grid) return;
  const list = data.competitorStatusList || [];
  grid.innerHTML = list
    .map(
      (c) => `
      <div class="comp-watch-card">
        <div class="comp-watch-head">
          <strong>@${esc(c.username)}</strong>
          <button type="button" class="btn-ghost-xs" data-remove-comp="${esc(c.username)}" title="Remove competitor">✕</button>
        </div>
        <div class="comp-watch-stats">
          <span>${c.postsCount} posts in DB</span>
          <span>${c.peakOutlier != null ? `Peak ${c.peakOutlier}x` : "Not scanned yet"}</span>
        </div>
        <div class="comp-watch-foot">
          <span class="empty-hint">${c.lastScrapedAt ? `Updated ${fmtRelativeAge(c.lastScrapedAt)}` : "Never scraped"}</span>
          <button type="button" class="btn-secondary btn-sm" data-scan-comp="${esc(c.username)}">Scan Now</button>
        </div>
      </div>
    `
    )
    .join("");

  grid.querySelectorAll("[data-remove-comp]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const res = await apiPost("/api/my-accounts/config", {
        action: "removeCompetitor",
        accountId: data.account.id,
        competitor: btn.dataset.removeComp,
      });
      if (res?.ok) {
        state.myAccounts.data = res;
        renderMyAccounts();
      }
    });
  });

  grid.querySelectorAll("[data-scan-comp]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const handle = btn.dataset.scanComp;
      setBanner(true, `Scanning competitor @${handle}…`);
      btn.disabled = true;
      try {
        const res = await apiPost("/api/my-accounts/sync", {
          accountId: data.account.id,
          onlyHandles: [handle],
          depthCompetitors: 40,
        });
        if (res?.ok && res.data) {
          state.myAccounts.data = res.data;
          renderMyAccounts();
          toast(`@${handle} synced to My Accounts`);
        } else {
          toast(res?.message || `Failed to sync @${handle}`);
        }
      } finally {
        setBanner(false);
        btn.disabled = false;
      }
    });
  });
}

function initMyAccountsView() {
  document.querySelectorAll("#accountsSubTabSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.myAccounts.subTab = btn.dataset.acctab;
      renderMyAccounts();
    });
  });

  document.querySelectorAll("#accCtaFilterSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#accCtaFilterSeg .seg-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.myAccounts.ctaFilter = btn.dataset.cta;
      if (state.myAccounts.data) renderAccountsPriorityTab(state.myAccounts.data);
    });
  });

  document.getElementById("accExcludeLocalCheck")?.addEventListener("change", (ev) => {
    state.myAccounts.excludeLocalDrafts = ev.currentTarget.checked;
    loadMyAccounts();
  });

  document.querySelectorAll("#accOwnSortSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#accOwnSortSeg .seg-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.myAccounts.ownSort = btn.dataset.sort;
      if (state.myAccounts.data) renderAccountsOwnPostsTab(state.myAccounts.data);
    });
  });

  document.querySelectorAll("#accReproFilterSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#accReproFilterSeg .seg-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.myAccounts.reproFilter = btn.dataset.repro;
      if (state.myAccounts.data) renderAccountsReproTab(state.myAccounts.data);
    });
  });

  const runSync = async (scope, btn, onlyHandles = null) => {
    if (btn) btn.disabled = true;
    setBanner(true, scope === "own" ? "Syncing your Instagram account…" : "Running full Cron sync (Your account + Competitors)…");
    try {
      const res = await apiPost("/api/my-accounts/sync", {
        accountId: state.myAccounts.activeAccountId,
        scope,
        onlyHandles,
      });
      if (res?.ok && res.data) {
        state.myAccounts.data = res.data;
        renderMyAccounts();
        toast("My Accounts synced successfully!");
      } else {
        toast(res?.message || "Sync failed (check Chrome connection)");
      }
    } finally {
      setBanner(false);
      if (btn) btn.disabled = false;
    }
  };

  document.getElementById("syncOwnAccountBtn")?.addEventListener("click", (ev) => runSync("own", ev.currentTarget));
  document.getElementById("accOwnScanNowBtn")?.addEventListener("click", (ev) => runSync("own", ev.currentTarget));
  document.getElementById("syncAllCronBtn")?.addEventListener("click", (ev) => runSync("all", ev.currentTarget));

  document.getElementById("cronIntervalSelect")?.addEventListener("change", async (ev) => {
    const val = Number(ev.currentTarget.value);
    const res = await apiPost("/api/my-accounts/config", {
      action: "updateCron",
      enabled: val > 0,
      intervalHours: val > 0 ? val : 6,
    });
    if (res?.ok) {
      state.myAccounts.data = res;
      renderMyAccounts();
      toast(val > 0 ? `Auto-Cron set to every ${val}h` : "Auto-Cron paused");
    }
  });

  document.getElementById("addMyAccountBtn")?.addEventListener("click", async () => {
    const username = window.prompt("Instagram @handle of your account:");
    if (!username || !username.trim()) return;
    const category = window.prompt("Niche category (e.g. Pets, Health, Fitness):", "Pets") || "Pets";
    const competitors = window.prompt("Competitor @handles (comma separated):", "") || "";
    const res = await apiPost("/api/my-accounts/config", {
      action: "addAccount",
      username: username.trim(),
      category: category.trim(),
      competitors,
    });
    if (res?.ok) {
      state.myAccounts.data = res;
      state.myAccounts.activeAccountId = res.activeAccountId;
      renderMyAccounts();
      toast(`Added @${username.replace(/^@/, "")}`);
    }
  });

  document.getElementById("accAddCompetitorBtn")?.addEventListener("click", async () => {
    const inp = document.getElementById("accAddCompetitorInput");
    if (!inp || !inp.value.trim()) return;
    const res = await apiPost("/api/my-accounts/config", {
      action: "addCompetitor",
      accountId: state.myAccounts.activeAccountId,
      competitor: inp.value.trim(),
    });
    if (res?.ok) {
      inp.value = "";
      state.myAccounts.data = res;
      renderMyAccounts();
      toast("Added competitor(s) to watchlist");
    }
  });

  document.getElementById("accScanMissingCompsBtn")?.addEventListener("click", async (ev) => {
    const list = state.myAccounts.data?.competitorStatusList || [];
    const missing = list.filter((c) => c.needsFirstScan).map((c) => c.username);
    if (!missing.length) {
      toast("All tracked competitors already have posts in DB!");
      return;
    }
    await runSync("competitors", ev.currentTarget, missing);
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────

initTheme();
initNavigation();
syncSurfaceDropdown();
initMyAccountsView();
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
