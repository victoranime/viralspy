// ─────────────────────────────────────────────────────────────────────────────
// Sort Feed — toolbar count badge while profile sorts run (service worker)
//
// new-sort-logic, 2026-11-09 (user's pick: "Black, white ring" on the Toolbar
// Count Badge mockup, tests/toolbar_count_badge_mockup.html). Replaces the
// colour sweep (background_action_ring.js, no longer imported).
//
//   • the Sort Feed logo steps aside to 80% in the top-left while sorts run
//   • a black disc in its bottom-right corner, cut out of the logo, shows how
//     many sorts are in the line (the running one + the ones waiting, ≤ 5)
//   • a white ring inside the disc fills clockwise from 12 o'clock with the
//     RUNNING sort's % (the snackbar's %), all the way to 100%; no spinner
//   • a sort at 100% holds its full ring a moment, then the number drops by one
//     and the ring starts empty for the next sort (after the 5–10 s break)
//   • the line empty → the plain logo and the extension's tooltip come back
//
// Inputs, both in this worker:
//   - the line (background_sort_clock.js) calls globalThis.__sfLineChanged()
//     whenever it changes; __sfLineState() gives the line itself
//   - the % arrives on the tabs' SF_ACTION_RING messages (_sfRing* in
//     Instagram/banner_on_insta.js), kept per tab
// Chrome draws its own badge without a ring, so every picture is drawn here on
// an OffscreenCanvas and set with chrome.action.setIcon({ imageData }) — only
// when the number or the whole % changes, at most every DRAW_MS.
// ─────────────────────────────────────────────────────────────────────────────
(() => {
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log("[sf-badge]", ...a); };
  // Off since 2026-11-09 (user): too small to read at 16 px, and the tab titles
  // already say it all. The toolbar keeps the plain logo and its usual tooltip.
  // Flip to true to bring the badge back (tests/toolbar_badge_harness.mjs turns it on).
  const SF_ACTION_BADGE_ON = false;

  const SIZES = [16, 32];
  const DEFAULT_ICON = { 16: "Icons/16 Sort Feed.png", 48: "Icons/48 Sort Feed.png", 128: "Icons/128 Sort Feed.png" };
  const DRAW_MS = 120;               // at most ~8 pictures a second
  const DONE_HOLD_MS = 600;          // a finished sort shows its full ring this long
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Helvetica, Arial, sans-serif';

  const pctByTab = new Map();        // tabId → 0..1, the latest % that tab's sort reported
  let holdUntil = 0;                 // after a sort reaches 100%
  let logo = null, logoLoading = null;
  let lastKey = "plain";             // what's on the toolbar now
  let drawTimer = null, lastDrawAt = 0;

  function loadLogo() {
    if (logo) return Promise.resolve(logo);
    if (!logoLoading) {
      logoLoading = fetch(chrome.runtime.getURL(DEFAULT_ICON[128]))
        .then((r) => r.blob()).then((b) => createImageBitmap(b))
        .then((bm) => (logo = bm))
        .catch((e) => { logoLoading = null; throw e; });
    }
    return logoLoading;
  }

  // The hover tooltip; null = the extension's normal one. Only sent when the words change.
  let lastTitle;
  function setTitle(text) {
    if (text === lastTitle) return;
    lastTitle = text;
    let title = text;
    if (title == null) {
      try { const m = chrome.runtime.getManifest(); title = (m.action && m.action.default_title) || m.name; } catch (e) { title = "Sort Feed"; }
    }
    try { chrome.action.setTitle({ title }); } catch (e) {}
  }

  // The badge, in the mockup's 32-unit box (option C on the Badge Size Options
  // mockup, tests/toolbar_badge_size_mockup.html, user's pick 2026-11-09): the logo
  // steps aside to 80% in the top-left while sorts run, the disc at (21.5, 21.5)
  // r 10.5 with a 1.6 gap cut out of the logo around it, the ring 2.1 wide inside
  // the disc's edge, the number 10.5 bold.
  function picture(count, pct) {
    const imageData = {};
    for (const size of SIZES) {
      const c = new OffscreenCanvas(size, size);
      const x = c.getContext("2d");
      const k = size / 32, cx = 21.5 * k, cy = 21.5 * k, r = 10.5 * k;
      x.drawImage(logo, 0, 0, 25.5 * k, 25.5 * k);
      x.save(); x.globalCompositeOperation = "destination-out";
      x.beginPath(); x.arc(cx, cy, r + 1.6 * k, 0, Math.PI * 2); x.fill(); x.restore();
      x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fillStyle = "#111"; x.fill();
      const lw = 2.1 * k, rr = r - lw / 2 - 0.5 * k, top = -Math.PI / 2;
      x.lineWidth = lw;
      x.beginPath(); x.arc(cx, cy, rr, 0, Math.PI * 2); x.strokeStyle = "rgba(255,255,255,0.22)"; x.stroke();
      if (pct > 0) {
        x.lineCap = pct >= 1 ? "butt" : "round";
        x.beginPath(); x.arc(cx, cy, rr, top, top + Math.min(1, pct) * Math.PI * 2); x.strokeStyle = "#fff"; x.stroke();
      }
      x.fillStyle = "#fff"; x.textAlign = "center"; x.textBaseline = "middle";
      x.font = `700 ${10.5 * k}px ${FONT}`;
      x.fillText(String(count), cx, cy + 0.6 * k);
      imageData[size] = x.getImageData(0, 0, size, size);
    }
    return imageData;
  }

  // What the toolbar should show right now, from the line + the running tab's %.
  function wanted() {
    const s = typeof globalThis.__sfLineState === "function" ? globalThis.__sfLineState() : { line: [] };
    const line = s.line || [];
    if (!line.length) return { count: 0 };
    const run = line.find((e) => e.state === "running");
    const waiting = line.filter((e) => e.state === "waiting");
    const pct = run ? (pctByTab.get(run.tabId) || 0) : 0;
    let title;
    if (run) title = `Sorting${run.who ? " " + run.who : ""} · ${Math.floor(pct * 10) * 10}%${waiting.length ? ` · ${waiting.length} waiting` : ""}`;
    else title = waiting[0] && waiting[0].who ? `Next: ${waiting[0].who}` : "Starting the next sort";
    return { count: line.length, pct, title };
  }

  // Draw now, or as soon as allowed (the throttle, or a finished sort's hold).
  function render(now_ = false) {
    if (!SF_ACTION_BADGE_ON) return;
    const now = Date.now();
    const wait = now_ ? 0 : Math.max(holdUntil - now, lastDrawAt + DRAW_MS - now);
    if (wait > 0) {
      if (!drawTimer) drawTimer = setTimeout(() => { drawTimer = null; render(); }, wait);
      return;
    }
    const w = wanted();
    globalThis.__sfBadgeShown = w; // for the test harness
    if (!w.count) {
      if (lastKey !== "plain") {
        lastKey = "plain";
        try { chrome.action.setIcon({ path: DEFAULT_ICON }); } catch (e) {}
        log("plain");
      }
      setTitle(null);
      return;
    }
    setTitle(w.title);
    const key = `${w.count}:${Math.round(w.pct * 100)}`;
    if (key === lastKey) return;
    lastDrawAt = now;
    loadLogo().then(() => {
      // The line may have moved while the logo loaded: draw what's true now.
      const v = wanted();
      if (!v.count) return render();
      lastKey = `${v.count}:${Math.round(v.pct * 100)}`;
      try { chrome.action.setIcon({ imageData: picture(v.count, v.pct) }); } catch (e) {}
      log("badge", lastKey);
    }).catch((e) => log("logo failed", e));
  }

  globalThis.__sfLineChanged = render;

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== "SF_ACTION_RING") return;
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId == null) return;
    const p = Math.min(1, Math.max(0, (Number(msg.pct) || 0) / 100));
    if (msg.state === "start") pctByTab.set(tabId, 0);
    else if (msg.state === "progress") pctByTab.set(tabId, Math.max(pctByTab.get(tabId) || 0, p)); // never runs backwards
    else if (msg.state === "done") {
      // Full ring at once, then hold it before the number drops (the line leave follows right after).
      pctByTab.set(tabId, 1);
      render(true);
      holdUntil = Date.now() + DONE_HOLD_MS;
      return;
    }
    else if (msg.state === "stopped" || msg.state === "failed") pctByTab.delete(tabId);
    render();
  });
  chrome.tabs.onRemoved.addListener((tabId) => { pctByTab.delete(tabId); });

  // A fresh worker: the plain logo until the line (restored from session storage) says otherwise.
  // (Also puts the logo back if an older build left a badge on the toolbar.)
  try { chrome.action.setIcon({ path: DEFAULT_ICON }); } catch (e) {}
})();
