// ─────────────────────────────────────────────────────────────────────────────
// Sort Feed — Instagram profile sorts across tabs (service worker)
//
// new-sort-logic Phases 4–5. Plan: NEW_SORT_PLAN.md.
//
// The clock (Phase 4). Chrome slows a hidden tab's timers to one a second, then
// one a minute after ~5 hidden minutes. The service worker's timers aren't
// throttled, so a hidden tab asks here: { type: "SF_SORT_WAIT", ms } is answered
// after ms. Pacing itself (how long) stays in the page (script_instagram.js).
//
// The line (Phase 5). One profile sort runs at a time across every tab; up to
// MAX_SORTS (running + waiting) are kept, in the order they were started. When
// the running one ends (collected, stopped, failed, cancelled, tab closed or left
// the profile) the next starts after a short break (BREAK_MS), like a person
// moving on. Every message comes from banner_on_insta.js (the content script):
//   SF_LINE_JOIN  { who }   → { ok, go } | { ok: false, reason: "full" | "paused" }
//   SF_LINE_LEAVE           — this tab's sort is over or cancelled
//   SF_LINE_PAGE            → { factor } — one page asked for; >1 = slow down
//   SF_LINE_REFUSED { code } — Instagram refused: stop every tab, pause 2 h
// and it tells tabs: SF_LINE_UPDATE { position, ahead, starting }, SF_LINE_GO,
// SF_LINE_STOP_ALL, SF_LINE_LEFT.
//
// Slowdown only inside a line session (user's rule): a session starts when a
// 2nd sort joins and ends when the line is empty; past SESSION_SLOW_PAGES pages
// in one session every gap doubles. A single sort is never slowed.
//
// Waiting tabs re-join every ~15 s (a heartbeat), so a service worker that was
// stopped and restarted rebuilds the line instead of leaving tabs waiting forever.
// ─────────────────────────────────────────────────────────────────────────────
(() => {
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log("[sf-line]", ...a); };

  const MAX_WAIT_MS = 15000;           // the longest gap a page ever asks for is ~6 s (12 s slowed down)
  const MAX_SORTS = 5;                 // running + waiting
  const BREAK_MS = [5000, 10000];      // before the next sort in the line starts (user, 2026-11-09)
  const SESSION_SLOW_PAGES = 300;      // ≈ 3,600 posts in one line session
  const PAUSE_MS = 2 * 60 * 60 * 1000; // after Instagram refuses
  const PAUSE_KEY = "sfIgSortPausedUntil";
  // The wait estimate in a waiting tab's title ("Starts in ~45s", user 2026-11-09).
  const POSTS_PER_PAGE = 12;
  const PAGE_MS_DEFAULT = 2200;        // the collector's average gap (NEW_SORT_PLAN.md › Pacing)
  const START_MS = 3000;               // a sort's own start: its page load and page 1
  const RELOAD_CHECK_MS = 1500;     // after a "loading" event, ask the tab whether its sort is still there
  const UPDATE_EVERY_MS = 10000;       // refresh waiting tabs' estimates

  // [{ tabId, who, target, pct, state: "waiting" | "running" }], in line order.
  // target = posts asked for (null for date / "All" sorts: no estimate), pct = the running one's progress.
  const line = [];
  const session = { active: false, pages: 0 };
  let breakTimer = null;
  let breakEndsAt = 0;
  let updateTimer = null;
  const pace = { pageMs: PAGE_MS_DEFAULT, lastAt: new Map() }; // measured time per page, across the line

  // Chrome stops an idle service worker and starts a fresh one on the next event,
  // which would forget the line — and a fresh line could start a waiting tab
  // while another tab's sort is still running. So the line is kept in session
  // storage and put back before the new worker handles anything.
  const LINE_KEY = "sfIgSortLine";
  function save() {
    try { chrome.storage.session.set({ [LINE_KEY]: { line: line.map((e) => ({ ...e })), session: { ...session } } }); } catch (e) {}
  }
  const restored = (async () => {
    try {
      const got = await chrome.storage.session.get(LINE_KEY);
      const s = got && got[LINE_KEY];
      if (!s || !Array.isArray(s.line)) return;
      for (const e of s.line) {
        try { await chrome.tabs.get(e.tabId); line.push(e); } catch (err) {} // the tab is gone
      }
      session.active = !!(s.session && s.session.active);
      session.pages = (s.session && s.session.pages) || 0;
      log("restored", line.length, "sorts");
      if (line.length && !running()) startNext(true);
      else broadcast();
    } catch (e) {}
  })();

  const send = (tabId, msg) => {
    try { chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError); } catch (e) {}
  };
  const running = () => line.find((e) => e.state === "running") || null;
  const between = (a, b) => Math.round(a + Math.random() * (b - a));

  // For the toolbar count badge (background_action_badge.js): redraw on every change.
  const publish = () => {
    globalThis.__sfLineWaiting = line.filter((e) => e.state === "waiting").length;
    try { if (typeof globalThis.__sfLineChanged === "function") globalThis.__sfLineChanged(); } catch (e) {}
  };

  // Tell every waiting tab where it stands: its place (the running sort is 1st),
  // who's just ahead of it, and whether it's about to start (the break).
  function broadcast() {
    publish();
    const run = running();
    let pos = run ? 1 : 0;
    line.forEach((e, i) => {
      if (e.state === "running") return;
      pos++;
      const ahead = i > 0 ? line[i - 1].who : null;
      // next = the one tab that starts when the running sort is done (only it counts down in its title).
      const next = e === line.find((x) => x.state === "waiting");
      send(e.tabId, { type: "SF_LINE_UPDATE", position: pos, ahead, next, starting: next && !run && !!breakTimer, eta: etaOf(i) });
    });
    save();
    // Waiting tabs' estimates count down between events too.
    const anyWaiting = line.some((e) => e.state === "waiting");
    if (anyWaiting && !updateTimer) updateTimer = setInterval(broadcast, UPDATE_EVERY_MS);
    if (!anyWaiting && updateTimer) { clearInterval(updateTimer); updateTimer = null; }
  }

  // Roughly how long until the waiting sort at line[i] starts, in ms; null when a
  // sort ahead has no known size (a date or "All" sort). What's left of the
  // running sort, then each sort ahead from start to finish, plus the breaks.
  function etaOf(i) {
    const avgBreak = (BREAK_MS[0] + BREAK_MS[1]) / 2;
    const pagesFor = (posts) => Math.max(0, Math.ceil(posts / POSTS_PER_PAGE) - 1); // page 1 is Instagram's own
    let ms = breakTimer ? Math.max(0, breakEndsAt - Date.now()) : 0;
    for (let j = 0; j < i; j++) {
      const e = line[j];
      if (!(e.target > 0)) return null;
      if (e.state === "running") {
        const left = e.target * (1 - Math.min(100, Math.max(0, e.pct || 0)) / 100);
        ms += pagesFor(left + POSTS_PER_PAGE) * pace.pageMs + avgBreak;
      } else {
        ms += START_MS + pagesFor(e.target) * pace.pageMs + avgBreak;
      }
    }
    return Math.round(ms);
  }

  function go() {
    breakTimer = null;
    if (running()) return broadcast();
    const next = line.find((e) => e.state === "waiting");
    if (!next) return broadcast();
    next.state = "running";
    log("go", next.tabId, next.who);
    send(next.tabId, { type: "SF_LINE_GO" });
    broadcast();
  }

  function startNext(withBreak) {
    clearTimeout(breakTimer);
    breakTimer = null;
    if (running() || !line.length) return broadcast();
    if (withBreak) {
      const ms = between(BREAK_MS[0], BREAK_MS[1]);
      breakEndsAt = Date.now() + ms;
      breakTimer = setTimeout(go, ms);
      broadcast();
    } else {
      go();
    }
  }

  function leave(tabId, why) {
    const i = line.findIndex((e) => e.tabId === tabId);
    if (i < 0) return;
    const wasRunning = line[i].state === "running";
    line.splice(i, 1);
    pace.lastAt.delete(tabId);
    log("leave", tabId, why);
    if (!line.length) {
      session.active = false;
      session.pages = 0;
      clearTimeout(breakTimer);
      breakTimer = null;
      publish();
      save();
      return;
    }
    if (wasRunning) startNext(true);
    else broadcast();
  }

  async function pausedUntil() {
    try {
      const got = await chrome.storage.local.get(PAUSE_KEY);
      return Number(got && got[PAUSE_KEY]) || 0;
    } catch (e) { return 0; }
  }

  async function join(tabId, who, rejoin, target, scope) {
    const known = line.find((e) => e.tabId === tabId);
    if (known && rejoin) return { ok: true, go: known.state === "running" }; // heartbeat
    const until = await pausedUntil();
    if (until > Date.now()) return { ok: false, reason: "paused", until };
    if (known) leave(tabId, "re-sort"); // a new sort in the same tab replaces its old place
    if (line.length >= MAX_SORTS) return { ok: false, reason: "full" };
    line.push({ tabId, who: who || null, scope: scope || null, target: Number(target) > 0 ? Number(target) : null, pct: 0, state: "waiting" });
    if (line.length >= 2) session.active = true;
    if (!running() && !breakTimer) startNext(false);
    else broadcast();
    const me = line.find((e) => e.tabId === tabId);
    return { ok: true, go: !!me && me.state === "running" };
  }

  // Instagram refused (429, security check, login wall): stop everything.
  async function refused(tabId, code) {
    try { await chrome.storage.local.set({ [PAUSE_KEY]: Date.now() + PAUSE_MS }); } catch (e) {}
    log("refused", code, "— stopping", line.length, "sorts");
    clearTimeout(breakTimer);
    breakTimer = null;
    for (const e of line) if (e.tabId !== tabId) send(e.tabId, { type: "SF_LINE_STOP_ALL", code });
    line.length = 0;
    session.active = false;
    session.pages = 0;
    publish();
    save();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;
    const tabId = sender && sender.tab ? sender.tab.id : null;

    if (msg.type === "SF_SORT_WAIT") {
      const ms = Math.max(0, Math.min(MAX_WAIT_MS, Number(msg.ms) || 0));
      setTimeout(() => { try { sendResponse({ ok: true }); } catch (e) {} }, ms);
      return true;
    }
    if (tabId == null) return;
    if (msg.type === "SF_LINE_JOIN") {
      restored.then(() => join(tabId, msg.who, !!msg.rejoin, msg.target, msg.scope)).then(sendResponse, () => sendResponse({ ok: true, go: true }));
      return true;
    }
    if (msg.type === "SF_LINE_LEAVE") {
      restored.then(() => { leave(tabId, msg.why || "done"); sendResponse({ ok: true }); });
      return true;
    }
    if (msg.type === "SF_LINE_PAGE") {
      restored.then(() => sendResponse(page(tabId, msg)));
      return true;
    }
    if (msg.type === "SF_LINE_REFUSED") {
      restored.then(() => refused(tabId, msg.code)).then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  // One page asked for by the running sort: progress, time per page, the session count.
  function page(tabId, msg) {
    {
      // A running sort the worker doesn't know (it was restarted mid-sort): take it back.
      if (!line.find((e) => e.tabId === tabId) && !running()) line.unshift({ tabId, who: msg.who || null, scope: msg.scope || null, target: Number(msg.target) > 0 ? Number(msg.target) : null, pct: 0, state: "running" });
      const me = line.find((e) => e.tabId === tabId);
      if (me && Number.isFinite(Number(msg.pct))) me.pct = Number(msg.pct);
      // Time per page, measured (it doubles when the line slows down).
      const now = Date.now(), prev = pace.lastAt.get(tabId);
      if (prev && now - prev < 30000) pace.pageMs = Math.round(pace.pageMs * 0.7 + (now - prev) * 0.3);
      pace.lastAt.set(tabId, now);
      if (session.active) session.pages++;
      return { factor: session.active && session.pages > SESSION_SLOW_PAGES ? 2 : 1 };
    }
  }

  chrome.tabs.onRemoved.addListener((tabId) => { restored.then(() => leave(tabId, "closed")); });
  chrome.tabs.onUpdated.addListener((tabId, info) => { restored.then(() => tabUpdated(tabId, info)); });
  function tabUpdated(tabId, info) {
    const e = line.find((x) => x.tabId === tabId);
    if (!e) return;
    if (info.url) {
      // Left the page the sort lives on (Instagram moves between pages without
      // reloading): the address no longer starts with the sort's scope — the
      // profile ("/natgeo/") or Saved › All Posts ("/me/saved/all-posts/"). A
      // search's scope names its keyword too ("/explore/search/?q=fitness"):
      // every search shares one path, so a new keyword is a new page.
      let path = "", q = "";
      try { const u = new URL(info.url); path = u.pathname.toLowerCase(); q = (u.searchParams.get("q") || "").trim().toLowerCase(); } catch (err) {}
      if (!path.endsWith("/")) path += "/";
      const scope = e.scope || (e.who && String(e.who).startsWith("@") ? "/" + String(e.who).slice(1).toLowerCase() + "/" : null);
      const at = scope ? scope.indexOf("?q=") : -1;
      const scopePath = at === -1 ? scope : scope.slice(0, at);
      if (scope && (!path.startsWith(scopePath) || (at !== -1 && q !== scope.slice(at + 3)))) {
        send(tabId, { type: "SF_LINE_LEFT" });
        leave(tabId, "left");
      }
    } else if (info.status === "loading") {
      // Not proof of a reload: Chrome also says "loading" when Instagram rewrites
      // its own history (same URL), mid-sort. Dropping the tab then let the next
      // tab start beside a sort that was still running (user, 2026-11-09). So ask
      // the tab a moment later: a page that really reloaded has a new content
      // script that isn't in the line (or none yet) and doesn't say yes.
      setTimeout(() => {
        if (!line.find((x) => x.tabId === tabId)) return;
        try {
          chrome.tabs.sendMessage(tabId, { type: "SF_LINE_PING" }, (r) => {
            void chrome.runtime.lastError;
            if (!r || !r.inLine) leave(tabId, "reloaded"); // a reloaded tab re-joins if its sort starts again
          });
        } catch (err) { leave(tabId, "reloaded"); }
      }, RELOAD_CHECK_MS);
    }
  }

  // Test hook (tests/sort_line_harness.mjs only).
  globalThis.__sfLineState = () => ({ line: line.map((e) => ({ ...e })), session: { ...session }, breaking: !!breakTimer });
})();
