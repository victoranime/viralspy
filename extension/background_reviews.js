// ─────────────────────────────────────────────────────────────────────────────
// Sort Feed — the review ask's record (service worker). Instagram only.
//
// Branch review-module. Mockup + rules: Worktrees/review-module/review-module-mockup.html.
// The ask itself is a module drawn by Instagram/reviews/review_prompt_instagram.js;
// this file keeps the one record every tab shares and gives at most one tab a yes.
//
//   SF_REVIEW_WIN      { kind }   a win: "sort" | "save" | "transcript" | "export"
//                                 → { ok, maybe, reason }  (maybe: worth waiting to ask)
//   SF_REVIEW_FRICTION { what }   something went wrong → no ask for 48 h
//   SF_REVIEW_CLAIM    { force }  → { ok, reason }  the one yes (tab in front, line empty)
//   SF_REVIEW_OUTCOME  { kind }   love | notgreat | review | feedback | later | close | replaced | left
//   SF_REVIEW_STATE / SF_REVIEW_DEV { cmd, days }   unpacked builds only (testing)
//
// RULES
//   wins      each kind counts once a day at most (so a line of sorts is one sort win).
//   eligible  installed ≥ 3 days ago · wins on ≥ 3 different days · ≥ 5 wins in total
//             · nothing went wrong in the last 48 h.
//   moment    the tab asks after a win, once the page is quiet. Only a tab in front, only
//             with no Instagram sort running or waiting in the line, one claim at a time.
//   again     Leave a review / Send → never. Not now / Skip → 90 days. × / Esc → 60 days.
//             At most once a week, 3 showings ever, 2 dismissals → never.
//             Pushed off by another module, or the page left before an answer → not counted.
//   counted   a showing counts on its first answer (Love it, Not great, ×, Esc).
//   kill      SF_REVIEWS_ON = false here, or chrome.storage.local.sortfeed_reviews_off = true.
//
// Every write goes through one queue, so wins from several tabs never overwrite each other.
// The pure rules live on globalThis.SF_REVIEW_LOGIC for tests/review_module_harness.mjs.
// ─────────────────────────────────────────────────────────────────────────────
(() => {
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log("[sf-review]", ...a); };

  const SF_REVIEWS_ON = true;
  const KEY = "sortfeed_reviews_v2";
  const OLD_KEY = "sortfeed_reviews";        // v1 (the card): install date, installId, past answers
  const OFF_KEY = "sortfeed_reviews_off";
  const LINE_KEY = "sfIgSortLine";           // background_sort_clock.js keeps the line here
  const STORE_ID = "lhiilgfanjkbombmnlfelondlfohfpfg";
  const DAY = 24 * 60 * 60 * 1000;

  const RULES = {
    KINDS: ["sort", "save", "transcript", "export"],
    MIN_AGE_MS: 3 * DAY,
    MIN_DAYS: 3,
    MIN_WINS: 5,
    FRICTION_MS: 2 * DAY,
    GAP_MS: 7 * DAY,
    MAX_SHOWS: 3,
    MAX_DISMISSALS: 2,
    LATER_MS: 90 * DAY,
    CLOSE_MS: 60 * DAY,
    CLAIM_MS: 10 * 60 * 1000,   // a claim nobody answered frees itself after this
  };

  // ── pure rules ─────────────────────────────────────────────────────────────
  const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : 0);
  const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); };

  // v2 record; anything missing or malformed gets a safe default. `old` (v1) gives the install
  // date and, the first time, the answers people already gave the card.
  function normalize(raw, old) {
    const o = raw && typeof raw === "object" && raw.v === 2 ? raw : null;
    const v1 = old && typeof old === "object" ? old : {};
    const s = {
      v: 2,
      installedAt: num(o && o.installedAt) || num(v1.installedAt),
      wins: num(o && o.wins),
      winDays: num(o && o.winDays),
      today: o && o.today && typeof o.today.day === "string" && Array.isArray(o.today.kinds)
        ? { day: o.today.day, kinds: o.today.kinds.filter((k) => RULES.KINDS.includes(k)) } : null,
      frictionAt: num(o && o.frictionAt),
      shows: num(o && o.shows),
      lastShownAt: num(o && o.lastShownAt),
      dismissals: num(o ? o.dismissals : v1.dismissals),
      cooldownUntil: num(o ? o.cooldownUntil : 0),
      done: null,
      claim: o && o.claim && typeof o.claim === "object" ? { tabId: o.claim.tabId, at: num(o.claim.at), counted: !!o.claim.counted } : null,
    };
    const d = o ? o.done : v1.done; // moving over: whoever reviewed, sent feedback or was done stays done
    if (["review", "feedback", "dismissed"].includes(d)) s.done = d;
    if (s.dismissals >= RULES.MAX_DISMISSALS && !s.done) s.done = "dismissed";
    return s;
  }

  function addWin(s, kind, now) {
    if (!RULES.KINDS.includes(kind)) return false;
    const day = dayKey(now);
    if (!s.today || s.today.day !== day) s.today = { day, kinds: [] };
    if (s.today.kinds.includes(kind)) return false;
    s.today.kinds.push(kind);
    s.wins += 1;
    if (s.today.kinds.length === 1) s.winDays += 1;
    return true;
  }

  // The record's own answer (no tab, no line): null = this person may be asked now.
  function eligible(s, now) {
    if (s.done) return "done:" + s.done;
    if (!s.installedAt) return "no-install-date";
    if (now - s.installedAt < RULES.MIN_AGE_MS) return "too-new";
    if (s.winDays < RULES.MIN_DAYS) return "win-days<" + RULES.MIN_DAYS;
    if (s.wins < RULES.MIN_WINS) return "wins<" + RULES.MIN_WINS;
    if (s.frictionAt && now - s.frictionAt < RULES.FRICTION_MS) return "went-wrong-48h";
    if (s.shows >= RULES.MAX_SHOWS) return "show-cap";
    if (s.cooldownUntil && now < s.cooldownUntil) return "cooldown";
    if (s.lastShownAt && now - s.lastShownAt < RULES.GAP_MS) return "week-gap";
    return null;
  }

  // ctx: { tabId, tabActive, lineBusy, force }
  function claim(s, now, ctx) {
    if (s.claim && s.claim.tabId !== ctx.tabId && now - s.claim.at < RULES.CLAIM_MS) return "claimed-by-another-tab";
    if (!ctx.force) {
      const why = eligible(s, now);
      if (why) return why;
    }
    if (ctx.tabActive === false) return "tab-not-in-front";
    if (ctx.lineBusy) return "sorts-in-line";
    s.claim = { tabId: ctx.tabId, at: now, counted: false };
    return null;
  }

  function countShowing(s, now) {
    if (!s.claim || s.claim.counted) return;
    s.claim.counted = true;
    s.shows += 1;
    s.lastShownAt = now;
  }
  function dismiss(s, now, ms) {
    s.dismissals += 1;
    s.cooldownUntil = now + ms;
    if (s.dismissals >= RULES.MAX_DISMISSALS) s.done = "dismissed";
  }

  function outcome(s, kind, now) {
    switch (kind) {
      case "love":
      case "notgreat": countShowing(s, now); return;                              // mid-flow
      case "review":   countShowing(s, now); s.done = "review"; break;
      case "feedback": countShowing(s, now); s.done = "feedback"; break;
      case "later":    countShowing(s, now); dismiss(s, now, RULES.LATER_MS); break; // Not now / Skip
      case "close":    countShowing(s, now); dismiss(s, now, RULES.CLOSE_MS); break; // × / Esc
      case "replaced":                                                             // another module took the spot
      case "left":     break;                                                      // page left: not counted
      default: return;
    }
    s.claim = null;
  }

  globalThis.SF_REVIEW_LOGIC = { RULES, normalize, addWin, eligible, claim, outcome, dayKey };

  // ── service worker side ────────────────────────────────────────────────────
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) return;

  const isStore = () => { try { return chrome.runtime.id === STORE_ID; } catch (e) { return true; } };
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  async function read() {
    const got = await chrome.storage.local.get([KEY, OLD_KEY, OFF_KEY]);
    return { s: normalize(got[KEY], got[OLD_KEY]), off: got[OFF_KEY] === true || !SF_REVIEWS_ON };
  }
  const write = (s) => chrome.storage.local.set({ [KEY]: s });

  async function lineBusy() {
    try {
      const got = await chrome.storage.session.get(LINE_KEY);
      const l = got && got[LINE_KEY];
      return !!(l && Array.isArray(l.line) && l.line.length);
    } catch (e) { return false; }
  }

  async function handle(msg, sender) {
    const now = Date.now();
    const tab = sender && sender.tab;
    const { s, off } = await read();

    if (msg.type === "SF_REVIEW_WIN") {
      const counted = addWin(s, msg.kind, now);
      if (counted) await write(s);
      const why = off ? "off" : eligible(s, now);
      log("win", msg.kind, counted, why, s);
      return { ok: true, counted, maybe: !why, reason: why };
    }
    if (msg.type === "SF_REVIEW_FRICTION") {
      s.frictionAt = now;
      await write(s);
      log("friction", msg.what);
      return { ok: true };
    }
    if (msg.type === "SF_REVIEW_CLAIM") {
      const force = !!msg.force && !isStore();
      if (off && !force) return { ok: false, reason: "off" };
      let tabActive = !!(tab && tab.active);
      if (tabActive && tab.windowId != null) {
        try { tabActive = !!(await chrome.windows.get(tab.windowId)).focused; } catch (e) {}
      }
      const why = claim(s, now, { tabId: tab ? tab.id : null, tabActive, lineBusy: await lineBusy(), force });
      if (!why) await write(s);
      log("claim", why || "yes");
      return { ok: !why, reason: why || "yes" };
    }
    if (msg.type === "SF_REVIEW_OUTCOME") {
      if (msg.force && !isStore()) { s.claim = null; await write(s); return { ok: true, test: true }; } // test runs leave the counts alone
      if (!s.claim || (tab && s.claim.tabId !== tab.id)) return { ok: false, reason: "no-claim" };
      outcome(s, msg.kind, now);
      await write(s);
      log("outcome", msg.kind, s);
      return { ok: true };
    }
    if (msg.type === "SF_REVIEW_STATE" && !isStore()) {
      return { ok: true, state: s, off, why: off ? "off" : eligible(s, now), lineBusy: await lineBusy() };
    }
    if (msg.type === "SF_REVIEW_DEV" && !isStore()) {
      const old = (await chrome.storage.local.get(OLD_KEY))[OLD_KEY] || {};
      let next = s;
      if (msg.cmd === "reset") next = normalize(null, { installedAt: s.installedAt });
      if (msg.cmd === "age") next = { ...s, installedAt: now - (Number(msg.days) || 4) * DAY };
      if (msg.cmd === "ready") next = { ...normalize(null, { installedAt: now - 4 * DAY }), wins: 5, winDays: 3 };
      if (!old.installedAt && next.installedAt) await chrome.storage.local.set({ [OLD_KEY]: { ...old, installedAt: next.installedAt } });
      await write(next);
      return { ok: true, state: next, why: eligible(next, now) };
    }
    return null;
  }

  const TYPES = ["SF_REVIEW_WIN", "SF_REVIEW_FRICTION", "SF_REVIEW_CLAIM", "SF_REVIEW_OUTCOME", "SF_REVIEW_STATE", "SF_REVIEW_DEV"];
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !TYPES.includes(msg.type)) return;
    serial(() => handle(msg, sender))
      .then((r) => { try { sendResponse(r || { ok: false }); } catch (e) {} })
      .catch((err) => { log("failed", err); try { sendResponse({ ok: false, reason: "error" }); } catch (e) {} });
    return true;
  });

  // A tab that closes while it holds the claim frees it at once (otherwise after CLAIM_MS).
  try {
    chrome.tabs.onRemoved.addListener((tabId) => serial(async () => {
      const { s } = await read();
      if (s.claim && s.claim.tabId === tabId) { outcome(s, "left", Date.now()); await write(s); }
    }));
  } catch (e) {}
})();
