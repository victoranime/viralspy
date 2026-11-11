(() => {
  if (window !== window.top || window.__viralSpyOverlayLoaded) return;
  window.__viralSpyOverlayLoaded = true;

  const IS_TIKTOK = /tiktok\.com$/i.test(location.hostname);
  const IS_FACEBOOK = /facebook\.com$/i.test(location.hostname);
  const PLATFORM = IS_TIKTOK ? "tiktok" : IS_FACEBOOK ? "facebook" : "instagram";

  // Ensure local pro user ID is always present so .sf-save-btn & local transcribe never ask to sign in
  try {
    chrome.storage.local.get(["sort_feed_user_id", "sortFeedUser"], (got) => {
      if (!got?.sort_feed_user_id) {
        chrome.storage.local.set({
          sort_feed_user_id: "viralspy_local_pro",
          sortFeedUser: { userID: "viralspy_local_pro", stateType: "pro", cachedAt: Date.now() },
        });
      }
    });
  } catch (_) {}

  // Clapperboard / Scene-Cut SVG icon (crisp at 11.5px)
  const CLAPPER_SVG = `
    <svg class="vs-reproduce-glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10.5" rx="1.8"></rect>
      <path d="M2 6.6h12"></path>
      <path d="M5.4 3 3.9 6.6"></path>
      <path d="M9.4 3 7.9 6.6"></path>
      <path d="M12.6 3 11.2 6.6"></path>
      <polygon points="6.8,8.5 6.8,11.7 9.8,10.1" fill="currentColor" stroke="none"></polygon>
    </svg>
  `;

  const CHECK_SVG = `
    <svg class="vs-reproduce-glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="3.2 8.4 6.5 11.7 12.8 4.6"></polyline>
    </svg>
  `;

  // ── Toast Helper ──────────────────────────────────────────────────────────
  let activeToastEl = null;
  let activeToastTimer = null;

  function showPackToast({ loading = false, error = false, text = "", actions = [], autoHideMs = 0 }) {
    if (activeToastTimer) {
      clearTimeout(activeToastTimer);
      activeToastTimer = null;
    }
    if (!activeToastEl) {
      activeToastEl = document.createElement("div");
      activeToastEl.className = "vs-pack-toast";
      document.body.appendChild(activeToastEl);
    }
    activeToastEl.innerHTML = "";

    if (loading) {
      const sp = document.createElement("span");
      sp.className = "vs-pack-toast-spinner";
      activeToastEl.appendChild(sp);
    } else {
      const dot = document.createElement("span");
      dot.className = "vs-pack-toast-dot" + (error ? " is-error" : "");
      activeToastEl.appendChild(dot);
    }

    const label = document.createElement("span");
    label.className = "vs-pack-toast-text";
    label.textContent = text;
    activeToastEl.appendChild(label);

    if (actions.length) {
      const actWrap = document.createElement("div");
      actWrap.className = "vs-pack-toast-actions";
      for (const act of actions) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "vs-pack-toast-btn" + (act.accent ? " is-accent" : "");
        b.textContent = act.label;
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          act.onClick?.();
        });
        actWrap.appendChild(b);
      }
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "vs-pack-toast-btn";
      closeBtn.textContent = "✕";
      closeBtn.addEventListener("click", () => dismissPackToast());
      actWrap.appendChild(closeBtn);
      activeToastEl.appendChild(actWrap);
    }

    if (autoHideMs > 0) {
      activeToastTimer = setTimeout(() => dismissPackToast(), autoHideMs);
    }
  }

  function dismissPackToast() {
    if (activeToastTimer) {
      clearTimeout(activeToastTimer);
      activeToastTimer = null;
    }
    if (activeToastEl) {
      activeToastEl.remove();
      activeToastEl = null;
    }
  }

  // ── Extract Post Info around Save Buttons & Facebook Stacks ───────────────
  function parseIgCodeFromHref(href) {
    const m = String(href || "").match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    return m ? m[1] : null;
  }

  function parseTkInfoFromHref(href) {
    const m = String(href || "").match(/\/@([^/?#]+)\/(video|photo)\/(\d+)/i);
    return m ? { username: m[1], kind: m[2], code: m[3] } : null;
  }

  function parseFbCodeFromHref(href) {
    const m = String(href || "").match(/(?:\/reel\/|\/videos\/)(\d+)/i);
    return m ? m[1] : null;
  }

  function extractFbCreatorName(stageEl) {
    if (stageEl) {
      const ownerLinks = stageEl.querySelectorAll('a[aria-label="See Owner Profile"]');
      for (const a of ownerLinks) {
        const txt = (a.textContent || "").trim();
        if (txt) return txt;
      }
      for (const sp of stageEl.querySelectorAll("span")) {
        const txt = (sp.textContent || "").trim();
        if (/ · /.test(txt) && /audio/i.test(txt)) return txt.split("·")[0].trim();
      }
    }
    const reserved = new Set(["notifications", "facebook", "menu", "home", "reels", "watch", "marketplace", "search", "groups", "friends", "video"]);
    for (const h1 of document.querySelectorAll("h1")) {
      const txt = (h1.textContent || "").replace(/\bVerified account\b/gi, "").replace(/\s+/g, " ").trim();
      if (txt && txt.length <= 60 && !reserved.has(txt.toLowerCase())) return txt;
    }
    return "";
  }

  function resolveContextFromFbStack(stackEl) {
    // 1. Sorted Facebook tile (.sf-fb-tile-actions inside [data-sf-sorted-item="true"])
    const sortedTile = stackEl.closest('[data-sf-sorted-item="true"]');
    if (sortedTile?.dataset?.sfItemJson) {
      try {
        const item = JSON.parse(sortedTile.dataset.sfItemJson);
        const code = String(item?.VideoID || item?.code || item?.id || "").trim();
        if (code) {
          return {
            platform: "facebook",
            shortcode: code,
            username: item?.Profile || item?.userName || "",
            url: `https://www.facebook.com/reel/${code}/`,
            thumbnailUrl: item?.Thumb || item?.thumbnailUrl || null,
            caption: item?.Caption || item?.caption || "",
            views: item?.Views ?? item?.viewCount ?? null,
            likes: item?.Likes ?? item?.likesCount ?? null,
            comments: item?.Comments ?? item?.commentsCount ?? null,
            outlierScore: item?.OutlierScore ?? item?.outlierScore ?? null,
          };
        }
      } catch (_) {}
    }

    // 2. Unsorted profile Reels hover (.sf-fb-hover-cluster inside a[href*="/reel/"])
    const linkEl = stackEl.closest('a[href*="/reel/"], a[href*="/videos/"]');
    if (linkEl) {
      const code = parseFbCodeFromHref(linkEl.getAttribute("href"));
      if (code) {
        return {
          platform: "facebook",
          shortcode: code,
          username: extractFbCreatorName(null),
          url: `https://www.facebook.com/reel/${code}/`,
        };
      }
    }

    // 3. Single Facebook Reel page (/reel/<id>) with .sf-fb-reel-pill
    const stageEl = stackEl._sfStage || stackEl.closest("[data-video-id]");
    const pathCode = parseFbCodeFromHref(location.pathname);
    const stageCode = stageEl?.getAttribute?.("data-video-id") || null;
    // Prefer canonical Reel ID from location.pathname (/reel/<id>) over internal xpv_asset_id
    const code = pathCode || stageCode;
    return {
      platform: "facebook",
      shortcode: code,
      username: extractFbCreatorName(stageEl),
      url: code ? `https://www.facebook.com/reel/${code}/` : location.href,
    };
  }

  function resolveContextFromSaveBtn(saveBtn) {
    const opts = saveBtn._sfSaveOpts || {};
    let tileItem = null;
    const tileEl = opts.tile || saveBtn.closest("[data-sf-item-json]");
    if (tileEl?.dataset?.sfItemJson) {
      try {
        tileItem = JSON.parse(tileEl.dataset.sfItemJson);
      } catch (_) {}
    }

    if (IS_TIKTOK) {
      let code =
        (typeof opts.getCode === "function" ? opts.getCode() : null) ||
        opts.code ||
        tileItem?.code ||
        null;
      let username = opts.profile || tileItem?.userName || "";
      const linkEl = saveBtn.closest('a[href*="/video/"], a[href*="/photo/"]') ||
        tileEl?.querySelector?.('a[href*="/video/"], a[href*="/photo/"]');
      if (linkEl) {
        const parsed = parseTkInfoFromHref(linkEl.getAttribute("href"));
        if (parsed) {
          code = code || parsed.code;
          username = username || parsed.username;
        }
      }
      if (!code) {
        const pageParsed = parseTkInfoFromHref(location.pathname);
        if (pageParsed) {
          code = pageParsed.code;
          username = username || pageParsed.username;
        }
      }
      const url = code
        ? `https://www.tiktok.com/@${username || "_"}/video/${code}`
        : location.href;
      return {
        platform: "tiktok",
        shortcode: code,
        username,
        url,
        videoUrl: tileItem?.videoUrl || null,
        thumbnailUrl: tileItem?.thumbnailUrl || null,
        caption: tileItem?.caption || "",
        views: tileItem?.viewCount ?? null,
        likes: tileItem?.likesCount ?? null,
        comments: tileItem?.commentsCount ?? null,
        outlierScore: tileItem?.outlierScore ?? null,
      };
    }

    // Instagram
    let shortcode =
      (typeof opts.getShortcode === "function" ? opts.getShortcode() : null) ||
      opts.shortcode ||
      tileItem?.code ||
      null;
    const anchor = saveBtn.closest("a[href]");
    if (!shortcode && anchor) {
      shortcode = parseIgCodeFromHref(anchor.getAttribute("href"));
    }
    if (!shortcode) {
      shortcode = parseIgCodeFromHref(location.pathname);
    }

    let username = tileItem?.userName || "";
    if (!username) {
      const mPath = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/(?:reels|p|reel)?/i);
      if (mPath && !["reels", "reel", "p", "explore", "stories", "direct", "accounts"].includes(mPath[1].toLowerCase())) {
        username = mPath[1];
      }
    }

    const url = tileItem?.url || (shortcode ? `https://www.instagram.com/reel/${shortcode}/` : location.href);
    return {
      platform: "instagram",
      shortcode,
      username,
      url,
      videoUrl: tileItem?.videoUrl || null,
      thumbnailUrl: tileItem?.thumbnailUrl || null,
      caption: tileItem?.caption || "",
      views: tileItem?.viewCount ?? null,
      likes: tileItem?.likesCount ?? null,
      comments: tileItem?.commentsCount ?? null,
      outlierScore: tileItem?.outlierScore ?? null,
    };
  }

  function triggerBrowserZipDownload(zipUrl, filename) {
    const a = document.createElement("a");
    a.href = zipUrl;
    a.download = filename || "reproduce_pack.zip";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1200);
  }

  // ── Create & Mount One-Shot Reproduce Button ──────────────────────────────
  function createReproduceBtnElement(getContextFn, isSinglePostTheme) {
    const btn = document.createElement("div");
    btn.className = "vs-reproduce-btn" + (isSinglePostTheme ? " vs-reproduce-sp" : "");
    btn.dataset.sfAction = "true";
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("aria-label", "Reproduce Video Pack (.zip)");

    const sq = document.createElement("span");
    sq.className = "vs-reproduce-square";
    sq.innerHTML = CLAPPER_SVG;
    btn.appendChild(sq);

    const tip = document.createElement("div");
    tip.className = "vs-reproduce-tip";
    tip.innerHTML = `<span>Reproduce</span><span class="vs-reproduce-pill-tag">.ZIP</span>`;
    btn.appendChild(tip);

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (btn.classList.contains("is-loading")) return;

      const ctx = getContextFn();
      if (!ctx?.shortcode && !ctx?.url) {
        showPackToast({ error: true, text: "Could not detect video code on this tile.", autoHideMs: 3500 });
        return;
      }

      btn.classList.remove("is-done");
      btn.classList.add("is-loading");
      sq.innerHTML = `<span class="vs-reproduce-spinner"></span>`;

      showPackToast({
        loading: true,
        text: `Building Reproduce Pack (${ctx.shortcode || "video"}): scenes + Whisper script + .zip…`,
      });

      chrome.runtime.sendMessage({ type: "VS_REPRODUCE_VIDEO", payload: ctx }, (res) => {
        btn.classList.remove("is-loading");
        if (chrome.runtime.lastError || !res?.ok) {
          sq.innerHTML = CLAPPER_SVG;
          showPackToast({
            error: true,
            text: res?.message || "Reproduce failed. Make sure ViralSpy Studio Hub is running.",
            autoHideMs: 5500,
          });
          return;
        }

        btn.classList.add("is-done");
        sq.innerHTML = CHECK_SVG;

        const pack = res.pack || res;
        const zipUrl = `http://127.0.0.1:8765${pack.zipUrl}`;
        triggerBrowserZipDownload(zipUrl, `${pack.packId}.zip`);

        showPackToast({
          text: `${pack.packId}.zip downloaded (${pack.sceneCount || 0} scenes + script)`,
          actions: [
            {
              label: "Copy Skill Prompt ✦",
              accent: true,
              onClick: () => {
                navigator.clipboard.writeText(pack.skillPrompt || "");
                showPackToast({
                  text: "Copied Remake prompt (paste in Antigravity / Claude to launch storyboard)",
                  autoHideMs: 3800,
                });
              },
            },
            {
              label: "Video DB ↗",
              onClick: () => {
                chrome.runtime.sendMessage({ type: "VS_OPEN_STUDIO", hash: "#videodb" });
              },
            },
          ],
          autoHideMs: 14000,
        });
      });
    });

    return btn;
  }

  function attachReproduceAboveSave(saveBtn) {
    if (!saveBtn || saveBtn.dataset.vsReproduceAttached === "1") return;
    const parent = saveBtn.parentElement;
    if (!parent) return;
    saveBtn.dataset.vsReproduceAttached = "1";

    const isSp = saveBtn.classList.contains("sf-save-sp");
    const repBtn = createReproduceBtnElement(() => resolveContextFromSaveBtn(saveBtn), isSp);

    // Special case: sorted TikTok tiles position each button wrapper absolutely via style.bottom (10, 34, 58)
    const inlineBottom = parent.style?.bottom || "";
    if (
      IS_TIKTOK &&
      parent.children.length === 1 &&
      parent.style?.position === "absolute" &&
      /^\d+px$/.test(inlineBottom)
    ) {
      const saveBottomPx = parseInt(inlineBottom, 10) || 58;
      const wrap = document.createElement("div");
      wrap.className = "vs-tk-sorted-reproduce-wrap";
      wrap.dataset.sfCustomUi = "true";
      wrap.dataset.sfAction = "true";
      wrap.style.cssText = `
        position: absolute;
        bottom: ${saveBottomPx + 24}px;
        right: ${parent.style.right || "10px"};
        opacity: 0;
        transition: opacity 120ms ease-out;
        z-index: 10001;
      `;
      wrap.appendChild(repBtn);
      parent.parentElement?.appendChild(wrap);
      return;
    }

    // Standard vertical flex stack (.sf-hover-btns-wrapper, #sf-sp-pill, .sf-sp-pill-reels, .sf-tk-hover-btns-wrapper)
    parent.insertBefore(repBtn, saveBtn);
  }

  function attachReproduceOnFacebookStack(stackEl) {
    if (!stackEl || stackEl.dataset.vsReproduceAttached === "1") return;
    stackEl.dataset.vsReproduceAttached = "1";
    const isReelPill = stackEl.classList.contains("sf-fb-reel-pill");
    const repBtn = createReproduceBtnElement(() => resolveContextFromFbStack(stackEl), isReelPill);
    stackEl.insertBefore(repBtn, stackEl.firstChild);
  }

  function scanAndAttachAll() {
    document.querySelectorAll(".sf-save-btn").forEach(attachReproduceAboveSave);
    if (IS_FACEBOOK) {
      document
        .querySelectorAll(".sf-fb-reel-pill, .sf-fb-hover-cluster, .sf-fb-tile-actions")
        .forEach(attachReproduceOnFacebookStack);
    }
  }

  // ── Two-Way Save Sync on Focus / Visibility ───────────────────────────────
  let syncInFlight = false;
  function syncSaveStatesFromStudio() {
    if (syncInFlight || document.visibilityState !== "visible") return;
    const buttons = Array.from(document.querySelectorAll(".sf-save-btn, .sf-save-row"));
    if (!buttons.length) return;

    const codeToBtns = new Map();
    for (const b of buttons) {
      const ctx = resolveContextFromSaveBtn(b);
      if (ctx.shortcode) {
        if (!codeToBtns.has(ctx.shortcode)) codeToBtns.set(ctx.shortcode, []);
        codeToBtns.get(ctx.shortcode).push(b);
      }
    }
    const codes = Array.from(codeToBtns.keys()).slice(0, 200);
    if (!codes.length) return;

    syncInFlight = true;
    chrome.runtime.sendMessage(
      {
        type: "SF_SAVE_API",
        path: "posts/lookup",
        body: { platform: PLATFORM, codes },
      },
      (res) => {
        syncInFlight = false;
        if (chrome.runtime.lastError || !res?.ok || !res.saved) return;
        for (const [code, list] of codeToBtns.entries()) {
          const isSaved = Object.prototype.hasOwnProperty.call(res.saved, code);
          for (const el of list) {
            el.classList.toggle("sf-saved", isSaved);
            el.setAttribute("aria-pressed", isSaved ? "true" : "false");
            const tipLbl = el.querySelector(".sf-save-tip-label");
            if (tipLbl) tipLbl.textContent = isSaved ? "Remove" : "Save";
            const rowLbl = el.querySelector(".sf-save-row-label");
            if (rowLbl) rowLbl.textContent = isSaved ? "Saved" : "Save";
          }
        }
      }
    );
  }

  window.addEventListener("focus", syncSaveStatesFromStudio);
  document.addEventListener("visibilitychange", syncSaveStatesFromStudio);

  // ── Auto-Archive All In-Page Sorted Posts to Master Database ──────────────
  const ingestedCodes = new Set();
  let ingestTimer = null;

  function scheduleSortedPostsIngest() {
    if (ingestTimer) clearTimeout(ingestTimer);
    ingestTimer = setTimeout(() => {
      const batch = [];
      document.querySelectorAll('[data-sf-sorted-item="true"][data-sf-item-json]').forEach((el) => {
        try {
          const item = JSON.parse(el.dataset.sfItemJson);
          const code = item?.code || item?.shortcode || item?.VideoID;
          if (!code || ingestedCodes.has(code)) return;
          ingestedCodes.add(code);
          batch.push(item);
        } catch (_) {}
      });
      if (batch.length > 0) {
        chrome.runtime.sendMessage({
          type: "VS_INGEST_POSTS",
          payload: {
            platform: PLATFORM,
            source: "chrome_inpage_sort",
            posts: batch,
          },
        });
      }
    }, 1500);
  }

  // ── DOM Observer ──────────────────────────────────────────────────────────
  const ACTION_SELECTOR = IS_FACEBOOK
    ? ".sf-save-btn, .sf-fb-reel-pill, .sf-fb-hover-cluster, .sf-fb-tile-actions"
    : ".sf-save-btn";

  function bootObserver() {
    scanAndAttachAll();
    const obs = new MutationObserver((mutations) => {
      let sawAction = false;
      let sawSorted = false;
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches?.(ACTION_SELECTOR) || n.querySelector?.(ACTION_SELECTOR)) {
            sawAction = true;
          }
          if (n.dataset?.sfSortedItem === "true" || n.querySelector?.('[data-sf-sorted-item="true"]')) {
            sawSorted = true;
          }
        }
      }
      if (sawAction) scanAndAttachAll();
      if (sawSorted) scheduleSortedPostsIngest();
    });
    obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }

  if (document.body) {
    bootObserver();
  } else {
    document.addEventListener("DOMContentLoaded", bootObserver, { once: true });
  }
})();
