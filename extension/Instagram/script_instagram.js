
const DEBUG = false;

// ── IG GraphQL endpoint migration ────────────────────────────────────────────
// IG is moving profile queries off /graphql/query onto /api/graphql. The move is
// per-query and mid-rollout, so BOTH endpoints are live at once: as of this
// build a fresh Profile > Reels load fires its clips connection at /api/graphql
// while the Posts timeline still arrives on /graphql/query. Matching only the
// old path meant nothing was intercepted on Reels — and since the collect loop
// (and the scrolling it drives) only starts on the first intercepted response,
// the sort sat on "Getting ready to sort" forever.
//
// Same fix explore already carries — see sfExploreIsGraphqlUrl in
// explore_sort_instagram.js. Matching both is safe: every call site below also
// tests for its own response key, which rejects the unrelated traffic sharing
// /api/graphql (ig_quick_promotion_batch_fetch_root,
// xdt_api__v1__discover__chaining, ...).
// ⚠️ TEST SWITCH — must ship false.
// Makes the page world ignore every GraphQL response, reproducing exactly the
// failure this guards against: the payload arrives, nothing is intercepted, the
// collect loop never starts and the page never scrolls. Use it to watch the
// stall watchdog in banner_on_insta.js fire on a real sort.
const SF_TEST_FORCE_STALL = false;

function sfIsGraphqlUrl(url) {
  if (SF_TEST_FORCE_STALL) return false;
  if (!url) return false;
  return url.includes("/graphql/query") || url.includes("/api/graphql");
}

// ── Profile Reels: the clips connection moved ────────────────────────────────
// IG relocated the profile Reels payload. It used to arrive as
//     data.xdt_api__v1__clips__user__connection_v2
// and now arrives as
//     data.fetch__XDTUserDict.clips_connection
// Everything BELOW the connection is unchanged — same edges[].node.media, same
// pk / code / media_type / like_count / comment_count / play_count /
// clips_tab_pinned_user_ids / user.pk, same page_info.has_next_page. Only the
// container moved, which is why the sort stalled silently: the payload arrived
// on every page load and each gate declined it for want of the old key.
//
// Both shapes are resolved because the rollout is partial — sessions still on
// the old bundle must keep working.
function sfGetClipsConnectionFromData(data) {
  if (!data) return null;
  return (
    data.xdt_api__v1__clips__user__connection_v2 ||
    (data.fetch__XDTUserDict && data.fetch__XDTUserDict.clips_connection) ||
    null
  );
}

function sfGetClipsConnection(jsonResponse) {
  return sfGetClipsConnectionFromData(jsonResponse && jsonResponse.data);
}

// let isSortingSessionActive = false;// let isSortingSessionActive = false;
// const IG_SESSION_KEY = "sfIGSession";

let profileNameIG=null; 

const inMemoryFeedData = {
  items: [],
};

function save_data_locally_again(singleNodeJSON) {
  inMemoryFeedData.items.push(singleNodeJSON);
  return inMemoryFeedData.items;
}

function reset_in_memory_feed_data() {
  inMemoryFeedData.items = [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop Sorting — immediate abort
//
// The banner's Stop button raises `sortFeedStopSorting` AND posts
// `sf_stop_sorting` (see _sfRequestStopInsta in banner_on_insta.js). The flag on
// its own can only be POLLED, and every collect loop polls it *after*
// `await find_element_*` — a wait that spends up to ~3s hunting the anchor and
// another ~3.2s waiting for the thumbnail. On a shallow scrape those resolve on
// the first synchronous check so Stop felt instant; deep into a 200-item scrape
// they time out on nearly every item, so Stop appeared to hang for seconds.
//
// The message is therefore the real signal, and it does three things at once:
//   1. flips `_sfStop.requested` synchronously, so every checkpoint sees it;
//   2. settles every in-flight find_element wait on the spot (timers cleared),
//      instead of letting it finish its poll ladder;
//   3. renders straight from what has already been collected — so a Stop
//      pressed in the gap BETWEEN pages, where no loop is running at all and
//      nothing was polling anything, doesn't wait on the next XHR either.
// ─────────────────────────────────────────────────────────────────────────────

const _sfStop = {
  requested: false,
  waiters: new Set(), // every in-flight find_element wait, so Stop can cut them short
};

// True once Stop has been requested by either channel. The sessionStorage read
// is the fallback for anything that raises the flag without posting the message.
function _sfStopRequested() {
  if (_sfStop.requested) return true;
  try {
    return sessionStorage.getItem("sortFeedStopSorting") === "on";
  } catch (e) {
    return false;
  }
}

// Register a pending wait. The caller keeps the handle, parks its pending
// setTimeout id on `.timer`, and settles through _sfStopSettle so the
// registration is always cleaned up exactly once.
function _sfStopRegisterWaiter(resolve) {
  const waiter = { resolve: resolve, timer: null, settled: false };
  _sfStop.waiters.add(waiter);
  return waiter;
}

function _sfStopSettle(waiter, value) {
  if (waiter.settled) return;
  waiter.settled = true;
  clearTimeout(waiter.timer);
  _sfStop.waiters.delete(waiter);
  try {
    waiter.resolve(value);
  } catch (e) {}
}

// Cut every pending wait short with null and kill its timer, so no zombie poll
// ladder keeps running querySelector/scrollIntoView after the sort is over.
// Callers drop the in-flight item on abort (its element capture is incomplete),
// so a null here never paints a blank tile.
function _sfStopFlushWaiters() {
  const pending = Array.from(_sfStop.waiters);
  _sfStop.waiters.clear();
  pending.forEach((w) => {
    if (w.settled) return;
    w.settled = true;
    clearTimeout(w.timer);
    try {
      w.resolve(null);
    } catch (e) {}
  });
}

// The express route: abort everything in flight and finish the sort from what
// has already been collected. Idempotent.
function _sfStopNow() {
  if (_sfStop.requested) return;
  _sfStop.requested = true;
  _sfStopFlushWaiters();                                   // per-item DOM/media waits
  try { window.__sfIgProfilePager?.abort(); } catch (e) {} // a page request in flight (Phase 3)
  const outlierMeta = _sfOutlierCancel();                  // pool mode + its watchdog
  _sfRenderSorted(inMemoryFeedData.items, outlierMeta);    // render now, don't wait for a loop
}

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || !event.data.sf_stop_sorting) return;
  // Profile surface only. Explore and Saved run in their own page-world scripts
  // with their own memory, and all three receive this same broadcast — the
  // surface flag (unset on Profile) decides which one owns the abort.
  if (sessionStorage.getItem("sortFeedSurface")) return;
  _sfStopNow();
});

// ─────────────────────────────────────────────────────────────────────────────
// Back-to-back re-sorting — the sort-context record
//
// A second popup sort used to be rejected outright ("Back-to-back sorting isn't
// supported yet") because nothing on the page remembered what had just been
// sorted: remove_items_local_storage() wipes sortFeedSortBy / NoItems /
// ItemsVsDates the moment the banner mounts.
//
// These two globals describe the scrape, so the content script can decide whether
// a new request is already covered by what's on screen (→ re-shuffle instantly)
// or needs a fresh scrape (→ reload):
//
//   _sfFeedExhausted — the last page reported no next page, i.e. we hold the
//     whole feed, so ANY request is covered. A real coverage signal.
//
//   _sfDeepestSeenMs — the oldest createDate seen in ANY parsed response.
//     ⚠️ DIAGNOSTIC ONLY — do NOT use this to judge coverage. It measures what we
//     SAW, not what we KEPT, and the two diverge badly: a "1 week" sort reads
//     pages reaching months back but discards everything outside the week, so a
//     deep `deepestSeenMs` sits next to a set holding six items. Judging coverage
//     off it silently served a 1-month request from a 1-week set. Coverage is
//     computed in resort_instagram.js from the items actually retained.
//
// Both are read in _sfRenderSorted, which is the single exit every sort funnels
// through (natural completion AND the Stop express route above) — so a sort
// ended with Stop records its context exactly like a completed one.
// ─────────────────────────────────────────────────────────────────────────────
let _sfDeepestSeenMs = null;
let _sfFeedExhausted = false;

// Raised when a DATE sort skips a pinned item because it fell outside the range.
//
// IG floats pinned posts to the top of the grid whatever their age, so a date
// scrape steps over the ones that are too old. That leaves a set which is no
// longer a faithful prefix of the feed — and "the latest 25" built from it would
// be missing a pinned post that a real items sort puts first. So a later
// items re-sort is only allowed to reuse this set when nothing was skipped.
//
// Note it's about pinned items ACTUALLY skipped, not about the account merely
// having pinned posts: a pinned post inside the range is kept like any other and
// leaves this false.
let _sfDatePinnedSkipped = false;

// Note one parsed page's depth. Called for every clips/timeline response while a
// sort is running — including pages a collect loop breaks out of early, which is
// the whole point (see _sfDeepestSeenMs above).
function _sfNoteResponseDepth(jsonResponse) {
  const conn =
    sfGetClipsConnection(jsonResponse) ||
    jsonResponse?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
  if (!conn) return;

  const isClips = !!sfGetClipsConnection(jsonResponse);
  for (const edge of conn.edges || []) {
    // Reels nest the media one level down; Posts carry taken_at on the node.
    const node = isClips ? edge?.node?.media : edge?.node;
    if (!node) continue;
    const ms = node.taken_at
      ? node.taken_at * 1000
      : Number(new Date(pk_to_create_date(node.pk)));
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (_sfDeepestSeenMs === null || ms < _sfDeepestSeenMs) _sfDeepestSeenMs = ms;
  }

  _sfFeedExhausted = !conn.page_info?.has_next_page;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sort timing log (new-sort-logic Phase 1)
//
// TEST SWITCH: must be false in anything shipped. When on, a profile sort notes
// when each Reels / Posts page arrived, and at the end prints a summary to the
// console and downloads it as sortfeed-sort-timing-<profile>-<posts>.txt.
// t = 0 is the page load the sort starts from (IG reloads on every sort), so the
// first line is how long Instagram took to send page 1.
// ─────────────────────────────────────────────────────────────────────────────
const SF_SORT_TIMING = false;
const _sfTimingPages = [];

function _sfTimingPage(jsonResponse) {
  if (!SF_SORT_TIMING) return;
  const conn =
    sfGetClipsConnection(jsonResponse) ||
    jsonResponse?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
  if (!conn) return;
  _sfTimingPages.push({ at: performance.now(), posts: (conn.edges || []).length });
}

function _sfTimingFinish(collected, stopped) {
  if (!SF_SORT_TIMING || !_sfTimingPages.length) return;
  const s = (ms) => (ms / 1000).toFixed(2);
  const ss = (k) => { try { return sessionStorage.getItem(k) || ""; } catch (e) { return ""; } };
  const profile = location.pathname.split("/").filter(Boolean)[0] || "profile";
  const end = performance.now();
  const first = _sfTimingPages[0].at;
  const pages = _sfTimingPages.length;
  const gaps = _sfTimingPages.slice(1).map((p, i) => p.at - _sfTimingPages[i].at);
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const minutes = (end - first) / 60000;
  const lines = [
    "Sort Feed — sort timing",
    `profile: @${profile} · tab: ${ss("sortFeedPostsVSReels")} · mode: ${ss("sortItemsVsDates")} ${ss("sortFeedNoItems")} · sort by: ${ss("sortFeedSortBy")}`,
    `cards: ${_sfDataTilesOn() ? "built from data" : "copied from Instagram"}`,
    `collected by: ${_sfReq.on ? `request (Instagram's page 1 + ${_sfReq.requests} asked by Sort Feed)` : _sfReq.fellBack ? `scrolling (request fell back: ${_sfReq.fellBack})` : "scrolling"}${_sfReq.error && _sfReq.on ? ` · stopped by ${_sfReq.error}` : ""}`,
    `posts collected: ${collected} · pages: ${pages}${stopped ? " · stopped early" : ""}`,
    "",
    `page load → first page: ${s(first)} s`,
    `first page → done: ${s(end - first)} s`,
    `total: ${s(end)} s`,
    `average between pages: ${s(avgGap)} s · pages per minute: ${minutes > 0 ? (gaps.length / minutes).toFixed(1) : "—"} · posts per minute: ${minutes > 0 ? (collected / minutes).toFixed(0) : "—"}`,
    "",
    "page   at (s)   gap (s)   posts",
    ..._sfTimingPages.map((p, i) =>
      `${String(i + 1).padEnd(6)} ${s(p.at).padEnd(8)} ${(i ? s(p.at - _sfTimingPages[i - 1].at) : "—").padEnd(9)} ${p.posts}`),
    `done   ${s(end)}`,
  ];
  const text = lines.join("\n");
  console.log(text);
  try {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `sortfeed-sort-timing-${profile}-${collected}.txt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) {}
  _sfTimingPages.length = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cards built from data (new-sort-logic Phase 2)
//
// The sorted grid draws profile cards from the post's own data (link, cover,
// marks) instead of pasting a copy of Instagram's card, so the collect loop no
// longer needs to store each card's HTML. localStorage sfDataTilesIG = "0"
// switches back to copied cards, for side-by-side checks. The same switch is
// read by show_overlay_banner.js, which draws the cards.
// ─────────────────────────────────────────────────────────────────────────────
function _sfDataTilesOn() {
  try { return localStorage.getItem("sfDataTilesIG") !== "0"; } catch (e) { return true; }
}

// A grid-sized cover: the smallest candidate at least 480px wide (a ~240px card
// on a 2x screen), else the largest there is. thumbnailUrl is the widest one,
// 1080px+, right for the player but heavy times 500 cards. Carousels carry their
// cover on the first slide.
function _sfGridThumb(media) {
  const own = media?.image_versions2?.candidates;
  const list = (own && own.length ? own : media?.carousel_media?.[0]?.image_versions2?.candidates) || [];
  const ok = list.filter((x) => x?.url).sort((a, b) => (a.width || 0) - (b.width || 0));
  if (!ok.length) return null;
  return (ok.find((x) => (x.width || 0) >= 480) || ok[ok.length - 1]).url;
}

// The record itself. Rides along with the render post so the content script can
// pair it with the grid it describes.
function _sfBuildSortContext(collectedCount, sfOutlierMeta) {
  return {
    mode: sessionStorage.getItem("sortItemsVsDates"),      // "items" | "dates"
    selection: sessionStorage.getItem("sortFeedNoItems"),  // "100_reels" | "3_month" | "custom_…"
    sortBy: sessionStorage.getItem("sortFeedSortBy"),
    tab: sessionStorage.getItem("sortFeedPostsVSReels"),   // "Reels" | "Posts"
    surface: sessionStorage.getItem("sortFeedSurface") || "profile",
    path: location.pathname,
    collectedCount: collectedCount,
    deepestSeenMs: _sfDeepestSeenMs,
    feedExhausted: _sfFeedExhausted,
    pinnedSkipped: _sfDatePinnedSkipped,
    // Stop leaves a PARTIAL set. The count above is still exact — an aborted
    // find_element wait resolves null and the caller drops that item rather than
    // half-saving it — so "stopped at 40 of 100" really means 40 whole items.
    stoppedByUser: _sfStopRequested(),
    outlier: sfOutlierMeta || null,
  };
}

// ── One render, ever ────────────────────────────────────────────────────────
// Both the natural completion chains and the Stop express route funnel through
// _sfRenderSorted / _sfFinalizeEmptyRange; whichever arrives first wins and the
// other becomes a no-op. Without the latch, a Stop that renders while a loop is
// still unwinding could be followed by that loop's own `.then()` painting a
// second grid.
let _sfSortFinalized = false;

function _sfRenderSorted(items, sfOutlierMeta) {
  if (_sfSortFinalized) return;
  _sfSortFinalized = true;

  const list = Array.isArray(items) ? items : [];
  // Built BEFORE the removeItem calls below — it reads the very keys they clear.
  const sfCtx = _sfBuildSortContext(list.length, sfOutlierMeta);

  // Captured for the same reason: the opportunistic-baseline work below would
  // otherwise read these after they're gone.
  // Note _sfOutlierScorableSurface, NOT _sfOutlierRecordOn — the collect loop has
  // already cleared sortFeedStatus by now, so the in-flight test would be false.
  const scoreable = _sfOutlierScorableSurface();
  const stoppedShort = _sfStopRequested();
  _sfTimingFinish(list.length, stoppedShort);
  _sfDiagFinish(list.length);

  sessionStorage.removeItem("sortFeedStopSorting");
  sessionStorage.removeItem("sortFeedStatus");
  profileNameIG = null;

  // Stopped before a single item finished capturing — there is nothing to
  // render, so leave IG's own feed alone and just clear our chrome.
  if (!list.length) {
    removeSortFeedBannerMessage();
    remove_overlay();
    return;
  }

  // ── Opportunistic baseline ──
  // The user sorted by views/likes, but if the pages we already read happen to
  // cover the scoring window, the median is pure arithmetic on data in memory —
  // no extra fetch, no delay. Compute it, so Outlier becomes available in the
  // banner's Sort-by list without a re-scrape.
  //
  // Skipped after a Stop: that pool is truncated the same way the display set is,
  // and a truncated window would bias the median.
  //
  // `_sfOutlierEvaluate` is the same gate an explicit outlier sort uses, and it
  // only says "ok" when the window is genuinely covered — so this cannot invent
  // a baseline that a real outlier sort wouldn't have produced.
  let opportunistic = null;
  if (!sfOutlierMeta && scoreable && !stoppedShort) {
    const free = _sfOutlierEvaluate();
    if (free && free.status === "ok" && free.baseline > 0) opportunistic = free;
  }

  const meta = sfOutlierMeta || opportunistic;
  sfCtx.outlier = meta; // record what actually scored this grid, however it arrived

  _sfOutlierStampScores(list, meta);
  // Toasts stay tied to a REQUESTED outlier sort — "not enough reels" or "no
  // breakout" would be baffling on a plain likes sort the user never asked to score.
  _sfOutlierNotifyOutcome(list, sfOutlierMeta);

  const sort_by = sessionStorage.getItem("sortFeedSortBy");
  const sorted_items = sort_items(list, sort_by);

  // Collecting is over: the tab title's ✓ goes now (banner_on_insta.js).
  // A tab that sorted in the background draws its grid right away too, with
  // every animation cut short (_sfInstantMode), so opening it shows the sorted
  // page as it will stay — no snackbar leaving, banner sliding in or page
  // scrolling in the first half second (user, 2026-11-09).
  window.postMessage({ sf_sort_collected: { count: sorted_items.length } }, "*");
  if (document.hidden) _sfInstantMode();
  removeSortFeedBannerMessage(); // banner_on_insta.js: removes overlay + loading banner
  remove_overlay();              // removes the overlay again
  window.postMessage(
    { logo_animate_off: true, payload: sorted_items, sf_outlier: meta, sf_ctx: sfCtx },
    "*",
  );
}

// Motion off for a render done in a hidden tab. A hidden tab runs no animation
// frames, so the banner's exit, its entrance and the scroll home would all play
// the moment the tab is opened. With html.sf-instant, CSS animations and
// transitions last 1 ms; when the tab is opened, any animation still pending
// (CSS or script) is finished on the spot, for the first SF_INSTANT_MS on
// screen, and then motion is back to normal.
const SF_INSTANT_MS = 800;
function _sfInstantMode() {
  const root = document.documentElement;
  if (root.classList.contains("sf-instant")) return;
  if (!document.getElementById("sf-instant-style")) {
    const st = document.createElement("style");
    st.id = "sf-instant-style";
    st.textContent = "html.sf-instant *,html.sf-instant *::before,html.sf-instant *::after{animation-duration:1ms!important;animation-delay:0s!important;transition-duration:1ms!important;transition-delay:0s!important;scroll-behavior:auto!important}";
    (document.head || root).appendChild(st);
  }
  root.classList.add("sf-instant");
  const finishAll = () => {
    try {
      document.getAnimations().forEach((a) => {
        try {
          const end = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().endTime : Infinity;
          if (Number.isFinite(end)) a.finish(); // never an endless one (spinners)
        } catch (e) {}
      });
    } catch (e) {}
  };
  const onVis = () => {
    if (document.hidden) return;
    document.removeEventListener("visibilitychange", onVis);
    finishAll();
    const until = performance.now() + SF_INSTANT_MS;
    const loop = () => {
      finishAll();
      if (performance.now() < until) requestAnimationFrame(loop);
      else root.classList.remove("sf-instant");
    };
    requestAnimationFrame(loop);
  };
  document.addEventListener("visibilitychange", onVis);
}

// Date sorts that matched nothing: leave the original feed exactly as it is and
// turn the progress banner into a friendly toast. Shares the render latch so a
// Stop that already finished can't be followed by a bogus "nothing in range".
function _sfFinalizeEmptyRange(type) {
  if (_sfSortFinalized) return;
  _sfSortFinalized = true;

  // `empty` tells the re-sort router there is no grid to re-shuffle, so a
  // follow-up popup sort must take the cold path.
  const sfCtx = _sfBuildSortContext(0, null);
  sfCtx.empty = true;

  sessionStorage.removeItem("sortFeedStopSorting");
  sessionStorage.removeItem("sortFeedStatus");
  profileNameIG = null;

  // The toast animates: show it when the tab is visible (Phase 4).
  _sfWhenVisible(() => window.postMessage({ insta_date_range_empty: true, type: type, sf_ctx: sfCtx }, "*"));
}

// Similar accounts needs the sorted profile's numeric id. Every media item
// carries its owner (user.pk + user.username); collab posts can belong to the
// other creator, so only an item owned by the profile in the URL counts. The
// first match wins and is kept as "username:pk" for the banner to read.
// Reels nodes may carry user.pk without a username; then the owner is the pk
// seen on two items (a collab would have to appear twice to win).
const _sfProfilePkVotes = {};
function _sfRememberProfilePk(user) {
  try {
    const pk = user?.pk ?? user?.id;
    if (!pk) return;
    const profile = (window.location.pathname.split("/")[1] || "").toLowerCase();
    if (!profile) return;
    const prev = sessionStorage.getItem("sortFeedProfilePkIG") || "";
    if (prev.startsWith(profile + ":")) return;

    const owner = String(user?.username || "").toLowerCase();
    if (owner) {
      if (owner !== profile) return;
    } else {
      const key = profile + ":" + String(pk);
      _sfProfilePkVotes[key] = (_sfProfilePkVotes[key] || 0) + 1;
      if (_sfProfilePkVotes[key] < 2) return;
    }
    sessionStorage.setItem("sortFeedProfilePkIG", profile + ":" + String(pk));
  } catch (e) {}
}

function createMetadataJson(jsonResponse) {
  _sfRememberProfilePk(jsonResponse?.user);
  let metadataPerPost = {};

  // Create date
  let createDate = jsonResponse?.taken_at;
  let timestamp = createDate ? createDate * 1000 : null;
  metadataPerPost.createDate = timestamp
    ? new Date(timestamp).toISOString()
    : "";

  // Create code (post ID)
  metadataPerPost.code = jsonResponse?.code || "";

  // Comments count
  metadataPerPost.commentsCount = jsonResponse?.comment_count ?? null;

  // Likes count
  metadataPerPost.likesCount = jsonResponse?.like_count ?? null;

  // Media type
  metadataPerPost.mediaType = jsonResponse?.media_type ?? null;

  // View count
  metadataPerPost.viewCount = jsonResponse?.view_count ?? null;

  // Username
  metadataPerPost.userName = jsonResponse?.user?.username || "";

  // Caption text
  metadataPerPost.caption = jsonResponse?.caption?.text || "";

  // Post id
  metadataPerPost.postID = jsonResponse?.pk ?? null;

  // Pinned — IG floats pinned posts to the TOP of the grid regardless of date,
  // so feed order is "pinned first, then newest-first". The re-sort router needs
  // that to narrow a set faithfully (taking the latest 50 of 100 by date alone
  // would pick a different 50 than a real "Latest 50" sort returns). The field
  // is already read for the outlier median and the date-sort boundary check —
  // this just carries it onto the item.
  metadataPerPost.pinned = !!(
    jsonResponse?.timeline_pinned_user_ids &&
    jsonResponse.timeline_pinned_user_ids.length > 0
  );

  // Poster frame for the player — same widest-candidate rule as the Reels
  // capture below; the timeline payload carries image_versions2 too.
  metadataPerPost.thumbnailUrl = (() => {
    const c = jsonResponse?.image_versions2?.candidates;
    if (!Array.isArray(c) || !c.length) return null;
    let best = null, bestW = -1;
    for (const cand of c) {
      const w = cand?.width || 0;
      if (cand?.url && w > bestW) { bestW = w; best = cand.url; }
    }
    return best;
  })();

  // Smaller cover for a card built from data (_sfGridThumb).
  metadataPerPost.gridThumbUrl = _sfGridThumb(jsonResponse);

  return metadataPerPost;
}

function getUserNameReels() {
  // 1️⃣ Check cache
  // const cached = sessionStorage.getItem("sortFeedProfileName");
  // if (cached) return cached;

  // 2️⃣ Try to read from DOM immediately
  if (profileNameIG) {
    return profileNameIG;
  }
  else {
  const usernameElement = document.querySelector("header h2 span");
  if (usernameElement) {
    const username = usernameElement.innerText.trim(); 
    profileNameIG=username;
    // sessionStorage.setItem("sortFeedProfileName", username);
    return profileNameIG;
  }
  }
  // // 3️⃣ Nothing found
  // return "";
}

// Instagram media IDs (pk) are Snowflake-style: the high 41 bits encode the
// creation time in ms since the IG epoch. Reels payloads carry no `taken_at`,
// so we recover the create date straight from the pk — the same instant
// `taken_at` reports for posts. Verified to the second against IG's own
// "X ago" labels (see Docs/Dates). Returns an ISO string, or "" if no pk.
const IG_PK_EPOCH_MS = 1314220021721;
function pk_to_create_date(pk) {
  if (pk === null || pk === undefined || pk === "") return "";
  try {
    const ms = (BigInt(pk) >> 23n) + BigInt(IG_PK_EPOCH_MS);
    return new Date(Number(ms)).toISOString();
  } catch (e) {
    return "";
  }
}

function createMetadataJsonReels(jsonResponse) {
  _sfRememberProfilePk(jsonResponse?.user);
  let metadataPerPost = {};

  // Create date — decoded from the media pk (reels have no taken_at). Kept as
  // an ISO string so it matches the Posts createDate shape for sort + export.
  metadataPerPost.createDate = pk_to_create_date(jsonResponse?.pk);

  // View count (try play_count, fallback to view_count)
  let createPlayCount =
    jsonResponse?.play_count ?? jsonResponse?.view_count ?? null;
  metadataPerPost.viewCount = createPlayCount;

  // Post ID
  metadataPerPost.code = jsonResponse?.code || "";

  // Comments count
  metadataPerPost.commentsCount = jsonResponse?.comment_count ?? null;

  // Likes count
  metadataPerPost.likesCount = jsonResponse?.like_count ?? null;

  // Media type
  metadataPerPost.mediaType = jsonResponse?.media_type ?? null;

  // Username (assumes a helper function like getUserNameReels exists)
  let createUserName = getUserNameReels?.() || "";
  metadataPerPost.userName = createUserName;

  // Reel id
  metadataPerPost.reelID = jsonResponse?.pk ?? null;

  // Pinned — see the note in createMetadataJson; the Reels tab uses its own field.
  metadataPerPost.pinned = !!(
    jsonResponse?.clips_tab_pinned_user_ids &&
    jsonResponse.clips_tab_pinned_user_ids.length > 0
  );

  // Poster frame for the player — the reel's own 9:16 cover, straight off the
  // clips payload (candidates run 640x1136 / 361x640 against a 1080x1920
  // original). Costs nothing: this response is already intercepted.
  //
  // The player would otherwise fall back to scraping the <img> out of the
  // cloned grid tile, which is IG's SQUARE grid crop — cropped a second time by
  // object-fit on a 9:16 stage, and a visibly different frame from the one the
  // video opens on. Widest candidate wins; order isn't guaranteed.
  metadataPerPost.thumbnailUrl = (() => {
    const c = jsonResponse?.image_versions2?.candidates;
    if (!Array.isArray(c) || !c.length) return null;
    let best = null, bestW = -1;
    for (const cand of c) {
      const w = cand?.width || 0;
      if (cand?.url && w > bestW) { bestW = w; best = cand.url; }
    }
    return best;
  })();

  // Smaller cover for a card built from data (_sfGridThumb).
  metadataPerPost.gridThumbUrl = _sfGridThumb(jsonResponse);

  return metadataPerPost;
}

function scroll_to_view(lastElement) {
  lastElement.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Outlier score — baseline pool (Profile → Reels AND Posts, gated by the
// `sortFeedOutlier` sessionStorage flag set in init_sortfeed_instagram.js).
//
// score = item metric ÷ baseline. The metric depends on the tab:
//   Reels → VIEWS   ·   Posts → LIKES   (a reel inside the Posts grid is
//   scored on its likes like everything else there — views aren't comparable
//   across photos/carousels/reels).
// baseline = MEDIAN metric of the account's most recent 25 qualifying items —
// qualifying = unpinned and at least 72h old. There is NO time window (the
// 90→180→365 ladder was removed 2026-08-27; see _sfOutlierComputeMeta for why).
// Floor: fewer than 20 qualifying in the whole feed → status "insufficient", no
// badges, which now genuinely means a new or tiny account.
//
// ⚠️ The cap is a STOP condition, not a target: _sfOutlierEvaluate returns the
// moment 25 items qualify. It was 100, which forced a free user's 25-item sort
// to sit through ~4x the pagination it asked for, watching a "collecting…"
// banner for data it would never display. At 25 the display scrape has almost
// always already recorded enough — it parses WHOLE pages while the display loop
// stops mid-page — so tier 1 hits at the end of collection and pool mode never
// runs. Cost: a median off ~25 samples instead of ~100 is noisier (roughly ±18%
// vs ±10% for a log-normal view distribution), which the 2×/5×/10× tiers are
// coarse enough to absorb except right at a boundary.
//
// The cap is deliberately NOT coupled to the user's item selection (25/50/100):
// one baseline per creator keeps the same reel showing the same multiple across
// sorts, and keeps the server cache coherent — its key is
// (platform, surface, creator_id) with no notion of n.
//
// Collection: every clips (Reels) / timeline (Posts) page the display sort
// scrolls through is recorded for free; if the display phase ends with fewer
// than the cap banked, "pool mode" keeps IG paginating with one lightweight
// scroll per page (same infinite-scroll mechanism, but no find_element
// image-wait and no element capture) until the cap is full or the feed runs out.
// The render waits on `_sfOutlierEnsurePool` so badges paint with the grid.
// ─────────────────────────────────────────────────────────────────────────────

const SF_OUTLIER_MIN_AGE_MS = 72 * 60 * 60 * 1000; // <72h = too new to have matured
const SF_OUTLIER_FLOOR = 20;                       // min qualifying reels for a trustworthy median
const SF_OUTLIER_CAP = 25;                         // most-recent qualifying reels kept for the median (see note above)
const SF_OUTLIER_MAX_POOL_PAGES = 40;              // safety: runaway pagination
const SF_OUTLIER_MAX_POOL_MS = 90 * 1000;          // safety: wall-clock cap
const SF_OUTLIER_PAGE_WAIT_MS = 3500;              // watchdog per scroll attempt
const SF_OUTLIER_MAX_SCROLL_ATTEMPTS = 4;          // re-scrolls before treating the feed as stalled

const _sfOutlierPool = {
  map: new Map(),        // pk → { dateMs, metricVal, pinned }
  active: false,         // pool mode running (display phase done, still paginating)
  hasNext: true,
  lastCode: null,        // code of the newest-fetched item (pool mode's scroll target)
  stoppedByUser: false,  // Stop Sorting clicked during the display phase
  pagesFetched: 0,
  startTs: 0,
  waitTimer: null,
  scrollAttempts: 0,
  resolveFn: null,
};

// ── No server-cached median (V2 removed 2026-08-27) ─────────────────────────
// There used to be a Cloudflare/D1 cache of each creator's median, read once per
// sort and written back after every live compute. With SF_OUTLIER_CAP at 25 the
// local compute (tier 1 below) almost always succeeds the moment collection
// ends, so the cached answer was being fetched and then discarded — a worker
// round-trip plus a D1 write per sort, for a value nothing read.
//
// Computing fresh every time is also simply better: a cached baseline could be
// up to 7 days stale on a growing account, and two people sorting the same
// profile on the same day could see different multiples depending on who hit the
// cache. The score is now a pure function of the feed as it stands right now.
//
// What this costs: an account that was active a year ago and went quiet (few
// recent items, deep back catalogue) can't reach 25 qualifying or the 90-day
// boundary from the display scrape, so pool mode paginates instead of taking the
// short-circuit. Bounded by SF_OUTLIER_MAX_POOL_PAGES / _MS.
//
// The worker itself is still deployed and still used by TikTok / Facebook /
// YouTube, so this is reversible: git revert brings the bridge back.

// Which metric drives the score for the active tab: Reels → views, Posts →
// likes. Read from the tab flag so it's consistent everywhere (record, median,
// stamp, sort fallback).
function _sfOutlierMetric() {
  return sessionStorage.getItem("sortFeedPostsVSReels") === "Posts" ? "likes" : "views";
}

// A scoring SESSION is on — the user explicitly asked for an outlier sort. Gates
// pool mode, the "analyzing" banner and the outcome toasts.
function _sfOutlierSessionOn() {
  return sessionStorage.getItem("sortFeedOutlier") === "on" && _sfOutlierRecordOn();
}

// Can this surface be scored at all? Profile Posts/Reels — no time element.
//
// ⚠️ Deliberately does NOT test `sortFeedStatus`. Every collect loop clears that
// flag just BEFORE it resolves, so by the time the render runs the sort no longer
// looks "in flight". Gating the render-time baseline work on it meant tiers 1 and
// 2 never ran on an ordinary sort — sorting by likes and then picking Outlier
// always refreshed, while outlier-then-likes worked fine (that path carries its
// own meta and never consults this).
function _sfOutlierScorableSurface() {
  const pv = sessionStorage.getItem("sortFeedPostsVSReels");
  return (pv === "Reels" || pv === "Posts") && !sessionStorage.getItem("sortFeedSurface");
}

// Whether to RECORD a response into the pool — a scorable surface with a sort
// actually in flight. The in-flight test belongs here and only here, so IG's own
// background fetches after a sort can't leak into the pool.
//
// Deliberately weaker than _sfOutlierSessionOn: the recorder runs on every
// profile sort now, not just outlier ones, so that an ordinary views/likes sort
// can compute a median for free when it happens to have read enough pages. It
// costs one Map.set per item on responses already being parsed.
function _sfOutlierRecordOn() {
  return (
    _sfOutlierScorableSurface() &&
    (sessionStorage.getItem("sortFeedStatus") !== null || _sfOutlierPool.active)
  );
}

// pk → creation time in ms (same Snowflake decode as pk_to_create_date).
function _sfOutlierPkMs(pk) {
  try {
    return Number((BigInt(pk) >> 23n) + BigInt(IG_PK_EPOCH_MS));
  } catch (e) {
    return NaN;
  }
}

// Record every item of a clips (Reels) OR timeline (Posts) page into the pool
// (deduped by pk) and track the cursor state. Runs for display-phase pages AND
// pool-mode pages. metricVal = the surface's metric: views for Reels, likes for
// Posts. The two connections are surface-exclusive (clips only fires on the
// Reels tab, timeline only on Posts), so the present connection picks the metric.
function _sfOutlierRecordResponse(jsonResponse) {
  const data = jsonResponse?.data;
  const clips = sfGetClipsConnectionFromData(data);
  const timeline = data?.xdt_api__v1__feed__user_timeline_graphql_connection;
  const conn = clips || timeline;
  if (!conn) return;
  for (const edge of conn.edges || []) {
    let node, metricVal, pinned;
    if (clips) {
      const media = edge?.node?.media;
      if (!media || media.media_type !== 2) continue;
      node = media;
      metricVal = media.play_count ?? media.view_count ?? null;
      pinned = !!(media.clips_tab_pinned_user_ids && media.clips_tab_pinned_user_ids.length > 0);
    } else {
      node = edge?.node;
      if (!node) continue;
      metricVal = node.like_count ?? null;              // Posts score on LIKES
      pinned = !!(node.timeline_pinned_user_ids && node.timeline_pinned_user_ids.length > 0);
    }
    // Dedup key: pk when present, else code/id. A missing pk must NOT drop the
    // item — Posts date off taken_at (not the pk decode), and the Posts timeline
    // node can lack pk while still carrying code, which was silently emptying the
    // Posts pool (→ "0 collected" + endless scroll). Reels always carry media.pk.
    const key = node.pk != null ? String(node.pk) : (node.code || node.id || null);
    if (!key) continue;
    if (!_sfOutlierPool.map.has(key)) {
      // Posts: taken_at (seconds, canonical). Reels: decode the pk.
      const dateMs = node.taken_at ? node.taken_at * 1000 : _sfOutlierPkMs(node.pk);
      _sfOutlierPool.map.set(key, { dateMs, metricVal, pinned });
    }
    if (node.code) _sfOutlierPool.lastCode = node.code;
  }
  _sfOutlierPool.hasNext = !!conn.page_info?.has_next_page;
  if (_sfOutlierPool.active) _sfOutlierPoolPageArrived();
}

// Qualifying items: unpinned, matured (≥72h), with a metric value (views on
// Reels / likes on Posts). No age ceiling — see _sfOutlierComputeMeta.
function _sfOutlierQualifying() {
  const now = Date.now();
  const out = [];
  _sfOutlierPool.map.forEach((r) => {
    if (r.pinned || r.metricVal === null || !Number.isFinite(r.dateMs)) return;
    if (now - r.dateMs >= SF_OUTLIER_MIN_AGE_MS) out.push(r);
  });
  return out;
}

// Pool progress (0..1) for the banner's bar: qualifying items ÷ cap.
//
// This used to also weigh "window coverage" (oldest item's age ÷ the window) and
// take the max of the two, because the pool could finish either by filling the
// cap or by scrolling past the window's edge. With the window gone there is one
// finish line left, so there is one signal.
function _sfOutlierPoolProgress() {
  return Math.max(0, Math.min(1, _sfOutlierQualifying().length / SF_OUTLIER_CAP));
}

// Count shown in the analyzing banner: the QUALIFYING reels (unpinned, ≥72h)
// that actually feed the median — NOT the raw pool — clamped to the cap so the
// number never overshoots on the page that crosses it.
function _sfOutlierDisplayCount() {
  return Math.min(SF_OUTLIER_CAP, _sfOutlierQualifying().length);
}

// Median of the most recent SF_OUTLIER_CAP qualifying items. `metric`
// ("views" | "likes") rides on the meta so the content script knows which field
// to score + label with, without re-reading the tab flag.
//
// ── No time window (2026-08-27) ─────────────────────────────────────────────
// The baseline used to be "qualifying items inside a 90-day window", widening to
// 180 then 365 when fewer than SF_OUTLIER_FLOOR qualified, and giving up as
// `insufficient` if 365 still fell short. That ladder was built for a cap of 100.
// At a cap of 25 it does almost nothing useful and one thing actively harmful:
//
//   • For any account posting even weekly, the most recent 25 items already sit
//     inside ~6 months, so the window never binds. It costs nothing and saves
//     nothing.
//   • For a SLOW account it is the only thing that binds — and what it does is
//     refuse to score. A real profile prompted this: 50 reels available, but
//     only 2 inside 90 days, 4 inside 180, 10 inside 365. Floor 20, so:
//     "not enough reels" on an account with fifty of them sitting right there.
//
// So the window is gone. The baseline is simply the most recent 25 qualifying
// items, whenever they were posted, and `insufficient` now means what the toast
// says it means: fewer than 20 mature items in total — a genuinely new or tiny
// account.
//
// The trade-off, stated plainly: on a slow account those 25 can span a long time
// (18 months on the profile above), so "more views than usual" means "than this
// creator's recent history" rather than "than they're doing lately". Unavoidable
// — there is no way to score a creator who posts ten times a year AND keep the
// baseline tight — and far better than refusing to score at all.
function _sfOutlierComputeMeta() {
  const metric = _sfOutlierMetric();
  let q = _sfOutlierQualifying();
  if (q.length < SF_OUTLIER_FLOOR) {
    return { status: "insufficient", baseline: null, poolSize: q.length, metric };
  }
  q.sort((a, b) => b.dateMs - a.dateMs);          // newest first
  if (q.length > SF_OUTLIER_CAP) q = q.slice(0, SF_OUTLIER_CAP);
  const vals = q.map((r) => +r.metricVal).sort((a, b) => a - b);
  const mid = vals.length >> 1;
  const baseline = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  if (!(baseline > 0)) {
    return { status: "insufficient", baseline: null, poolSize: q.length, metric };
  }
  return { status: "ok", baseline, poolSize: q.length, metric };
}

// Decide whether the pool is complete. Returns the final meta, or null when more
// pages are needed. Two finish lines, down from four:
//   • the cap is full — the feed is newest-first, so these ARE the most recent;
//   • the feed is exhausted — no more pages are coming, so compute with whatever
//     qualified (which returns `insufficient` below the floor).
function _sfOutlierEvaluate() {
  const P = _sfOutlierPool;
  if (_sfOutlierQualifying().length >= SF_OUTLIER_CAP) return _sfOutlierComputeMeta();
  if (!P.hasNext) return _sfOutlierComputeMeta();
  return null; // more pages needed
}

function _sfOutlierFinish(meta) {
  const P = _sfOutlierPool;
  P.active = false;
  clearTimeout(P.waitTimer);
  P.waitTimer = null;
  const resolveFn = P.resolveFn;
  P.resolveFn = null;
  // No "finishing" step — resolving hands straight to the render, which removes
  // the banner (animating the bar to 100% then fading) as the sorted feed appears.
  if (resolveFn) resolveFn(meta);
}

// Stop pressed during an outlier sort. Pool mode used to notice only when a
// page landed or when its 3.5s watchdog ticked — this kills it on the click.
// Returns the meta the render should use: a cancelled meta when a scoring
// session was on (no badges), else null (no scoring session at all).
function _sfOutlierCancel() {
  const P = _sfOutlierPool;
  P.stoppedByUser = true;
  P.active = false;
  clearTimeout(P.waitTimer);
  P.waitTimer = null;

  const cancelled = { status: "cancelled", baseline: null, poolSize: 0 };

  // A pending _sfOutlierEnsurePool() must not hang — resolve it so the loop's
  // own chain can unwind (it will hit the render latch and no-op).
  const resolveFn = P.resolveFn;
  P.resolveFn = null;
  if (resolveFn) resolveFn(cancelled);

  return sessionStorage.getItem("sortFeedOutlier") === "on" ? cancelled : null;
}

// Pool mode's per-page tick — called from the recorder for every clips page
// that lands while pool mode is active.
function _sfOutlierPoolPageArrived() {
  const P = _sfOutlierPool;
  if (!P.active) return;
  P.pagesFetched++;
  P.scrollAttempts = 0;
  clearTimeout(P.waitTimer);
  window.postMessage(
    { sf_outlier_analyzing: true, count: _sfOutlierDisplayCount(), progress: _sfOutlierPoolProgress() },
    "*",
  );

  // Stop button pressed during pool mode → render without badges.
  if (sessionStorage.getItem("sortFeedStopSorting") === "on") {
    sessionStorage.removeItem("sortFeedStopSorting");
    _sfOutlierFinish({ status: "cancelled", baseline: null, poolSize: 0 });
    return;
  }

  const meta = _sfOutlierEvaluate();
  if (meta) { _sfOutlierFinish(meta); return; }

  if (P.pagesFetched >= SF_OUTLIER_MAX_POOL_PAGES || Date.now() - P.startTs > SF_OUTLIER_MAX_POOL_MS) {
    // A truncated window would bias the median — bail to the no-badge state.
    _sfOutlierFinish({ status: "error", baseline: null, poolSize: 0 });
    return;
  }
  _sfOutlierRequestNextPage();
}

// Trigger IG's own infinite scroll for the next page (clips OR timeline). Jump
// to the BOTTOM of the loaded grid — the reliable "load more" trigger on both
// the Reels and Posts grids, and NO media wait (pool items are metadata-only).
//
// Why not center the last tile (the old approach): once collection has scrolled
// deep, that tile often sits ABOVE the viewport center, so scrollIntoView(center)
// scrolls UP — away from the bottom — and fails to fetch, stalling the pool until
// the 3.5s watchdog retries. That stall made Posts collection much slower than
// Reels. Scrolling to the bottom always crosses IG's fetch threshold.
function _sfOutlierRequestNextPage() {
  const P = _sfOutlierPool;
  if (!P.active) return;
  // Collecting by request (Phase 3): ask for the next pool page instead of
  // scrolling; no watchdog, the request itself resolves or fails.
  if (_sfReq.on) { _sfReqNextPage(); return; }
  // Nudge the last-known tile into view first (helps virtualized grids render
  // the tail), then jump to the absolute bottom to trip the infinite scroll.
  const anchor = P.lastCode ? document.querySelector(`a[href*="${P.lastCode}"]`) : null;
  if (anchor) anchor.scrollIntoView({ behavior: "auto", block: "end" });
  window.scrollTo(0, document.body.scrollHeight);
  clearTimeout(P.waitTimer);
  P.waitTimer = setTimeout(() => {
    if (!P.active) return;
    if (sessionStorage.getItem("sortFeedStopSorting") === "on") {
      sessionStorage.removeItem("sortFeedStopSorting");
      _sfOutlierFinish({ status: "cancelled", baseline: null, poolSize: 0 });
      return;
    }
    if (++P.scrollAttempts >= SF_OUTLIER_MAX_SCROLL_ATTEMPTS) {
      _sfOutlierFinish({ status: "error", baseline: null, poolSize: 0 });
    } else {
      _sfOutlierRequestNextPage();
    }
  }, SF_OUTLIER_PAGE_WAIT_MS);
}

// Display phase finished → decide the baseline before rendering:
//   (1) the pool already holds enough to compute a median → compute live. At
//       SF_OUTLIER_CAP 25 this is the normal outcome: the recorder takes WHOLE
//       pages while the display loop stops mid-page, so collection has usually
//       banked more than the cap needs.
//   (2) not enough yet → pool mode (keep paginating 90→180→365).
// Resolves with the outlier meta, or null when no scoring session is on. Never
// rejects, so it can sit inline in the render chain.
function _sfOutlierEnsurePool() {
  return new Promise((resolve) => {
    try {
      if (sessionStorage.getItem("sortFeedOutlier") !== "on") { resolve(null); return; }
      const P = _sfOutlierPool;
      if (P.stoppedByUser || _sfStopRequested()) {
        resolve({ status: "cancelled", baseline: null, poolSize: 0 });
        return;
      }
      // (1) Pool already holds enough → compute live, no extra pagination.
      const early = _sfOutlierEvaluate();
      if (early) { resolve(early); return; }

      // (2) Not enough yet → pool mode.
      if (DEBUG) console.log("[sf-outlier] pool short of the cap → pool mode");
      P.active = true;
      P.startTs = Date.now();
      P.pagesFetched = 0;
      P.scrollAttempts = 0;
      P.resolveFn = resolve;
      window.postMessage(
        { sf_outlier_analyzing: true, count: _sfOutlierDisplayCount(), progress: _sfOutlierPoolProgress() },
        "*",
      );
      _sfOutlierRequestNextPage();
    } catch (e) {
      resolve({ status: "error", baseline: null, poolSize: 0 });
    }
  });
}

// Score below which an item gets no badge — mirrors _sfOutlierTier's tier-1
// cutoff in show_overlay_banner.js (2×). Kept here so the page world can tell
// when a sort produced ZERO badges without importing the content-script code.
const SF_OUTLIER_BADGE_MIN = 2;

// After an outlier sort resolves, post the user-facing note (if any) the banner
// should show on removal, BEFORE removeSortFeedBannerMessage so it swaps the
// banner instead of fading. Two OUTCOMES, deliberately worded apart because they
// are not the same claim:
//   • NO BASELINE (case B) → we never had a yardstick, so we can say nothing
//     about consistency. Copy asks for more reels and names the fallback order.
//     Covers `insufficient` AND `error` (a pool-mode bail: page/time/stall cap).
//     `error` used to be silent, which left a views-ordered grid with no
//     explanation at all.
//   • BASELINE OK, nothing cleared the badge floor (all < 2×) (case A) → this
//     genuinely IS "everything performed consistently"; scores exist and the
//     cards show real multiples, so the copy must NOT claim a views fallback.
// `cancelled` stays silent on purpose — the user pressed Stop and knows why.
//
// metric falls back to the live tab flag: the `error` / `cancelled` metas are
// built at the bail sites without one, and the noun/metric words differ per tab
// (Reels → reels/views, Posts → posts/likes).
function _sfOutlierNotifyOutcome(items, meta) {
  if (!meta) return;
  const metric = meta.metric || _sfOutlierMetric();
  if (
    (meta.status === "insufficient" || meta.status === "error") &&
    sessionStorage.getItem("sortFeedSortBy") === "outlier"
  ) {
    window.postMessage({ sf_outlier_insufficient: true, metric: metric }, "*");
    return;
  }
  if (meta.status === "ok" && Array.isArray(items)) {
    const anyBadge = items.some(
      (it) => it && typeof it.outlierScore === "number" && it.outlierScore >= SF_OUTLIER_BADGE_MIN,
    );
    if (!anyBadge) window.postMessage({ sf_outlier_no_breakout: true, metric: metric }, "*");
  }
}

// Stamp each display item's score = its metric ÷ baseline (views on Reels,
// likes on Posts). Scores ride the items through the render postMessage, so
// badges/sort/filters never need a second round-trip. Items excluded from the
// BASELINE (pinned / <72h / out-of-window) still get scored.
function _sfOutlierStampScores(items, meta) {
  if (!meta || meta.status !== "ok" || !(meta.baseline > 0) || !Array.isArray(items)) return;
  const key = meta.metric === "likes" ? "likesCount" : "viewCount";
  items.forEach((it) => {
    if (!it) return;
    it.outlierScore = it[key] != null ? +it[key] / meta.baseline : null;
  });
}

// Save feed data locally, init and append
function save_data_locally(singleNodeJSON) {
  if (sessionStorage.getItem("sortFeedData") !== null) {
    let itemsCleaned = JSON.parse(sessionStorage.getItem("sortFeedData"));
    itemsCleaned.push(singleNodeJSON);
    sessionStorage.setItem("sortFeedData", JSON.stringify(itemsCleaned));
    return itemsCleaned;
  } else {
    let itemsCleaned = [];
    itemsCleaned.push(singleNodeJSON);
    sessionStorage.setItem("sortFeedData", JSON.stringify(itemsCleaned));
    return itemsCleaned;
  }
}

// Return no of items selected, 0 if all items were selected
function return_number_selected() {
  let sort_selected = sessionStorage.getItem("sortFeedNoItems");

  if (sort_selected === "all_reels") {
    return 0;
  } else {
    return parseInt(sort_selected.replace("_reels", ""), 10) || 0;
  }
}

// Return href
function return_herf(singleNodeJSON) {
  // if media type is 1 or 8 then post (/natgeo/p/DGn8RJ7TQ22/")
  if ([1, 8].includes(singleNodeJSON["mediaType"])) {
    return `/${singleNodeJSON["userName"]}/p/${singleNodeJSON["code"]}/`;
  }
  // if media type is 8 then reel (natgeo/reel/DGolfZ-KQxF/)
  else {
    return `/${singleNodeJSON["userName"]}/reel/${singleNodeJSON["code"]}/`;
  }
}

function find_element(href, retries = 30, interval = 100) {
  return new Promise((resolve) => {
    const waiter = _sfStopRegisterWaiter(resolve);
    if (_sfStop.requested) {
      _sfStopSettle(waiter, null);
      return;
    }
    const tryFind = (attemptsLeft) => {
      if (waiter.settled) return;
      const element = document.querySelector(`a[href*="${href}"]`);
      if (element) {
        const parentDiv = element.closest("div");
        _sfStopSettle(waiter, parentDiv);
      } else if (attemptsLeft > 0) {
        waiter.timer = setTimeout(() => tryFind(attemptsLeft - 1), interval);
      } else {
        _sfStopSettle(waiter, null);
      }
    };
    tryFind(retries); // Start the loop with retry count
  });
}

// function find_element_instagram_again(href, retries = 30, interval = 100) {
//   return new Promise((resolve) => {
//     const tryFind = (attemptsLeft) => {
//       const element = document.querySelector(`a[href*="${href}"]`);
//       // console.log(`Looking for: a[href*="${href}"]`, element ? 'FOUND' : 'NOT FOUND', `(attempts left: ${attemptsLeft})`);

//       if (element) {
        
//         // this is the div that has the reel 
//         const parentDiv = element.closest("div");
//         // Scroll to trigger lazy loading (same spot as TikTok)
//         parentDiv?.scrollIntoView({ behavior: "auto", block: "center" });

//         // Retry until background-image is valid, then resolve
//         const checkBgLoaded = () => {
//           const bgDiv = parentDiv?.querySelector('[style*="background-image"]');
//           const match = bgDiv?.style?.backgroundImage?.match(/url\(["']?(.*?)["']?\)/);
//           const bgUrl = match ? match[1] : "";
//           const isValid = bgUrl && !bgUrl.startsWith("data:image/gif");

//           if (isValid) {
//             resolve(parentDiv);
//           } else if (retries > 0) {
//             retries--;
//             setTimeout(checkBgLoaded, interval);
//           } else {
//             // Fallback resolve even if media didn't fully load
//             resolve(parentDiv);
//           }
//         };

//         setTimeout(checkBgLoaded, 300);
//       } else if (attemptsLeft > 0) {
//         setTimeout(() => tryFind(attemptsLeft - 1), interval);
//       } else {
//         resolve(null);
//       }
//     };
//     tryFind(retries);
//   });
// }

// Registered with the Stop registry: this wait runs up to ~3s hunting the
// anchor and then up to ~3.2s more waiting for the thumbnail, so Stop settles
// it directly rather than waiting for the ladder to finish (see _sfStop).
function find_element_instagram_again(href, retries = 30, interval = 100) {
  return new Promise((resolve) => {
    const waiter = _sfStopRegisterWaiter(resolve);
    if (_sfStop.requested) {
      _sfStopSettle(waiter, null);
      return;
    }

    const tryFind = (attemptsLeft) => {
      if (waiter.settled) return;
      const element = document.querySelector(`a[href*="${href}"]`);

      if (element) {
        const parentDiv = element.closest("div");
        parentDiv?.scrollIntoView({ behavior: "auto", block: "center" });

        const isValidBg = () => {
          const bgDiv = parentDiv?.querySelector('[style*="background-image"]');
          const match = bgDiv?.style?.backgroundImage?.match(/url\(["']?(.*?)["']?\)/);
          const bgUrl = match ? match[1] : "";
          return bgUrl && !bgUrl.startsWith("data:image/gif");
        };

        const checkBgLoaded = () => {
          if (waiter.settled) return;
          if (isValidBg()) {
            _sfStopSettle(waiter, parentDiv);
          } else if (retries-- > 0) {
            waiter.timer = setTimeout(checkBgLoaded, interval);
          } else {
            _sfStopSettle(waiter, parentDiv);
          }
        };

        // Check immediately first, only wait if not ready
        if (isValidBg()) {
          _sfStopSettle(waiter, parentDiv);
        } else {
          waiter.timer = setTimeout(checkBgLoaded, 200);
        }

      } else if (attemptsLeft > 0) {
        waiter.timer = setTimeout(() => tryFind(attemptsLeft - 1), interval);
      } else {
        _sfStopSettle(waiter, null);
      }
    };

    tryFind(retries);
  });
}

// Registered with the Stop registry — same reasoning as
// find_element_instagram_again above.
function find_element_instagram_again_posts(href, retries = 30, interval = 100) {
  return new Promise((resolve) => {
    const waiter = _sfStopRegisterWaiter(resolve);
    if (_sfStop.requested) {
      _sfStopSettle(waiter, null);
      return;
    }

    const tryFind = (attemptsLeft) => {
      if (waiter.settled) return;
      const anchor = document.querySelector(`a[href*="${href}"]`);
      if (anchor) {
        const parentDiv = anchor.closest("div");
        parentDiv?.scrollIntoView({ behavior: "auto", block: "center" });

        const isRealUrl = (u) => u && !u.startsWith("data:image/gif");

        const hasVisualMedia = () => {
          // 1) <img src="...">
          const img = parentDiv?.querySelector("img[src]");
          const imgUrl = img?.getAttribute("src") || "";

          // 2) inline background-image: url(...)
          const bgDiv = parentDiv?.querySelector('[style*="background-image"]');
          const bgUrl = bgDiv?.style?.backgroundImage
            ?.match(/url\(["']?(.*?)["']?\)/)?.[1] || "";

          return isRealUrl(imgUrl) || isRealUrl(bgUrl);
        };

        const checkMediaLoaded = () => {
          if (waiter.settled) return;
          if (hasVisualMedia()) {
            _sfStopSettle(waiter, parentDiv);
          } else if (retries-- > 0) {
            waiter.timer = setTimeout(checkMediaLoaded, interval);
          } else {
            // Fallback: don't block forever—resolve so lazy loading can continue
            _sfStopSettle(waiter, parentDiv);
          }
        };

        // Try immediately; if not ready yet, poll
        if (hasVisualMedia()) {
          _sfStopSettle(waiter, parentDiv);
        } else {
          waiter.timer = setTimeout(checkMediaLoaded, 200);
        }
      } else if (attemptsLeft > 0) {
        // setTimeout(() => tryFind(a - 1), interval);
        waiter.timer = setTimeout(() => tryFind(attemptsLeft - 1), interval);
      } else {
        _sfStopSettle(waiter, null);
      }
    };

    tryFind(retries);
  });
}


// Sort based on selection, most views, etc.
function sort_items(data, sortBy) {
  if (sortBy === "views") {
    return [...data].sort((a, b) => b.viewCount - a.viewCount);
  } else if (sortBy === "outlier") {
    // One shared baseline makes the score monotonic in the metric, so the
    // metric order IS the outlier order — the fallback (views on Reels, likes
    // on Posts) keeps the sort correct when scoring came back insufficient and
    // no scores were stamped.
    const fb = sessionStorage.getItem("sortFeedPostsVSReels") === "Posts" ? "likesCount" : "viewCount";
    return [...data].sort(
      (a, b) => ((b.outlierScore ?? b[fb]) || 0) - ((a.outlierScore ?? a[fb]) || 0),
    );
  } else if (sortBy === "velocity") {
    const fb = sessionStorage.getItem("sortFeedPostsVSReels") === "Posts" ? "likesCount" : "viewCount";
    const velOf = (item) => {
      const val = +(item?.[fb] ?? 0);
      const ms = item?.createDate ? Date.parse(item.createDate) : NaN;
      const hrs = Number.isFinite(ms) ? Math.max(1, (Date.now() - ms) / 3600000) : 8760;
      return val / hrs;
    };
    return [...data].sort((a, b) => velOf(b) - velOf(a));
  } else if (sortBy === "likes") {
    return [...data].sort((a, b) => b.likesCount - a.likesCount);
  } else if (sortBy === "comments") {
    return [...data].sort((a, b) => b.commentsCount - a.commentsCount);
  } else if (sortBy === "oldest") {
    return [...data].reverse();
  } else {
    return 0;
  }
}

// Add string element key/field to main posts data
function update_data_object_with_element(singleNodeJSON, element) {
  // Cards built from data don't need the copy; keep it only when there's no
  // cover to build from, so that card can still fall back to the copied one.
  singleNodeJSON.element = _sfDataTilesOn() && (singleNodeJSON.gridThumbUrl || singleNodeJSON.thumbnailUrl) ? null : element?.outerHTML;
  return singleNodeJSON;
}


function send_items_collected_no(itemsCleaned) {
  if (itemsCleaned !== null) {
    try {
      let items_collected_no = itemsCleaned.length;
      // if (DEBUG) console.log('SEND MESSAGE');
      window.postMessage(
        { item_collected_no: true, number_items: items_collected_no },
        "*",
      );
    } catch (e) {
      console.error("Error sending message", e);
    }
  }
}

// ── Scan progress — the bar for sorts that have no item target ───────────────
// A DATE sort's finish line isn't a count, it's a date. The feed is newest-
// first, so the timestamp of the item the collect loop is on IS the distance
// travelled from now back toward the range's start — a real, monotonic 0..1 the
// banner can drive its bar off. Same idea as _sfOutlierPoolProgress, which
// measures how full the outlier baseline pool is.
//
// Two signals, maxed together (again mirroring the outlier bar, and for the same
// reason — either one alone stalls on some accounts):
//   • time coverage — exact whenever the range's start lies inside the feed;
//   • a work asymptote, collected ÷ (collected + K) — takes over when time says
//     nothing: an "All Posts" scrape (whose finish line is "feed exhausted", not
//     a date) or an account younger than the requested range, where coverage
//     would top out low and then jump.
// Plus a floor once IG reports no next page: the last page has landed, so only
// per-item DOM work remains and the bar belongs near the end.
const SF_SCAN_WORK_K = 60;            // knee of the work asymptote, in items
const SF_SCAN_LAST_PAGE_FLOOR = 0.9;  // reached the final page → nearly done

// The oldest createDate the collect loop has actually REACHED. Deliberately not
// _sfDeepestSeenMs: that one jumps a whole page ahead the moment a response
// lands, so the bar would leap then sit still through the per-item DOM work.
// This advances one item at a time, which is what makes the bar move smoothly.
let _sfScanCursorMs = null;

function _sfNoteScanCursor(createDate) {
  const ms = Number(new Date(createDate));
  if (!Number.isFinite(ms) || ms <= 0) return;
  if (_sfScanCursorMs === null || ms < _sfScanCursorMs) _sfScanCursorMs = ms;
}

function _sfScanWorkProgress() {
  const n = (inMemoryFeedData.items || []).length;
  return n / (n + SF_SCAN_WORK_K);
}

// 0..1, or null when this sort has a real item target and doesn't need it.
function _sfScanProgress() {
  const mode = sessionStorage.getItem("sortItemsVsDates");
  const selection = sessionStorage.getItem("sortFeedNoItems") || "";
  const openEnded = selection === "all_reels";

  // Item sorts drive the bar off count ÷ target — except "All", which has no
  // target and fell into the very same dead branch in the banner.
  if (mode !== "dates" && !openEnded) return null;

  let progress = _sfScanWorkProgress();

  // Time coverage: the journey is now → the range's start, and the cursor says
  // where we are along it. One formula covers both legs of a historical custom
  // range — the "seek" down to the range's top edge takes exactly its true share
  // of the bar, so there's no discontinuity when the range itself is reached.
  // Skipped for "All", whose 10-year span is a stand-in for "everything", not a
  // real boundary to travel to.
  if (!openEnded && _sfScanCursorMs !== null) {
    let range = null;
    try { range = return_date_range(selection); } catch (e) {}
    const now = Date.now();
    const journey = range ? now - Number(range[0]) : NaN;
    if (Number.isFinite(journey) && journey > 0) {
      progress = Math.max(progress, (now - _sfScanCursorMs) / journey);
    }
  }

  if (_sfFeedExhausted) progress = Math.max(progress, SF_SCAN_LAST_PAGE_FLOOR);
  return Math.max(0, Math.min(1, progress));
}

function insta_banner_notification(itemsCleaned, postType) {
  if (itemsCleaned !== null) {
    try {
      let items_collected_no = itemsCleaned.length;
      const msg = {
        insta_banner_notification: true,
        count: items_collected_no,
        type: postType,
      };
      // An outlier sort's DISPLAY phase drives the bar exactly like the same
      // sort without outlier — count/target for items, coverage for dates.
      //
      // It used to hand the banner window coverage instead, for both phases, so
      // the display→pool handoff was one continuous stream. That made sense when
      // the pool ran to 100 items and dwarfed the display phase. At
      // SF_OUTLIER_CAP 25 the coverage signal (max of window coverage and
      // qualifying÷cap) saturates almost immediately, so the bar shot to its 95%
      // ceiling and sat there for the whole scrape looking hung.
      //
      // Pool mode still drives its own bar (sf_outlier_analyzing →
      // _sfOutlierBannerAnalyzing), and it now picks up from whatever the display
      // phase had painted rather than restarting from coverage.
      const scan = _sfScanProgress();
      if (scan !== null) msg.scanProgress = scan;
      window.postMessage(msg, "*");
    } catch (e) {
      console.error("Error sending message", e);
    }
  }
}

// sends message to banner_on_insta to remove both (overlay & loading banner)
function removeSortFeedBannerMessage() {
  window.postMessage({ insta_banner_notification_remove: true }, "*");
}

async function sort_item_posts(
  numberItems,
  jsonResponse,
  sort_selected,
  nextPage,
) {
  return new Promise(async (resolve) => {
    for (let i = 0; i < numberItems; i++) {
      // Stop owns the finish from here on — bail without resolving (the express
      // route already rendered; _sfStopNow is a no-op if so).
      if (_sfStopRequested()) { _sfStopNow(); return; }

      let singleNode =jsonResponse.data.xdt_api__v1__feed__user_timeline_graphql_connection.edges[i].node;
      let singleNodeJSON = createMetadataJson(singleNode);
      let post_id = singleNodeJSON.code;
      let element = _sfReq.on ? await _sfReqItemTick() : await find_element_instagram_again_posts(post_id);

      // Checked BEFORE the item is saved: an aborted wait hands back a null
      // element, and saving that would paint a blank tile.
      if (_sfStopRequested()) { _sfStopNow(); return; }

      let singleNodeJSONUpdated = update_data_object_with_element(singleNodeJSON,element);
      let itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);

      if (sessionStorage.getItem("sortFeedStatus")) { 
      send_items_collected_no(itemsCleaned);
      insta_banner_notification(itemsCleaned, "Posts");
      // check that Stop Socrting wasn't clicks
      let sort_feed_sorting = sessionStorage.getItem("sortFeedStopSorting");

      // ✅ Case 00 -- user clicked stop sorting
      if (sort_feed_sorting === "on") {
        _sfOutlierPool.stoppedByUser = true; // aborted sort → skip outlier scoring

        sessionStorage.removeItem("sortFeedStopSorting");
        sessionStorage.removeItem("sortFeedStatus");
        profileNameIG=null;
        resolve(itemsCleaned);
        return;
      }
      
      else { 
        // ✅ Case 01 -- scrapped same length chosen
        if (itemsCleaned.length === sort_selected) {

          // reset params & remove overlay/banner
          sessionStorage.removeItem("sortFeedStopSorting");
          sessionStorage.removeItem("sortFeedStatus");
          profileNameIG=null; 
          // removeSortFeedBannerMessage();
          // resolve 
          resolve(itemsCleaned);
          return;
        } 

        // ✅ Case 02 -- no more next pages and reached end of network length
        else if (i === numberItems - 1 && !nextPage) {

          // reset params & remove overlay/banner
          sessionStorage.removeItem("sortFeedStopSorting");
          sessionStorage.removeItem("sortFeedStatus");
          profileNameIG=null; 
          // removeSortFeedBannerMessage();
          // resolve 
          resolve(itemsCleaned);
          return;
        }
        
        // ✅ Case 03 -- keep scrapping!
        else if (i === numberItems - 1 && nextPage) {

          break;
        } 
      }
    }
    }
    // No scrolling (Phase 3): ask for the next page ourselves, or finish.
    _sfReqAfterPage(nextPage, resolve);
  });
}

// sort reels function.
async function sort_not_all_reels(
  numberItems,
  jsonResponse,
  sort_selected,
  nextPage,
) {
  return new Promise(async (resolve) => {
    for (let i = 0; i < numberItems; i++) {
      // Stop owns the finish from here on — see sort_item_posts.
      if (_sfStopRequested()) { _sfStopNow(); return; }

      let singleNode =
        sfGetClipsConnection(jsonResponse).edges[i].node.media;

      if (singleNode.media_type === 2) {
        let singleNodeJSON = createMetadataJsonReels(singleNode);
        // get HTML elements
        let href = return_herf(singleNodeJSON);
        let post_id = singleNodeJSON.code;
        let element = _sfReq.on ? await _sfReqItemTick() : await find_element_instagram_again(post_id);

        // Before the save — an aborted wait hands back a null element.
        if (_sfStopRequested()) { _sfStopNow(); return; }

        // // debug components  
        // console.log('element'); 
        // console.log(post_id); 
        
        let singleNodeJSONUpdated = update_data_object_with_element(
          singleNodeJSON,
          element,
        );
        let itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);

      if (sessionStorage.getItem("sortFeedStatus")) {
        send_items_collected_no(itemsCleaned);
        // add loading banner with updated reels number 
        insta_banner_notification(itemsCleaned, "Reels");
        let sort_feed_sorting = sessionStorage.getItem("sortFeedStopSorting");

        // ✅ Case 00 -- user clicked stop sorting
        if (sort_feed_sorting === "on") {
          _sfOutlierPool.stoppedByUser = true; // aborted sort → skip outlier scoring

            // reset params & remove overlay/banner
          sessionStorage.removeItem("sortFeedStopSorting");
          sessionStorage.removeItem("sortFeedStatus");
          profileNameIG=null;
          // removeSortFeedBannerMessage();
          // resolve

          resolve(itemsCleaned);
          return;
        }
        
        else { 
          // ✅ Case 01 -- scrapped same length chosen
          if (itemsCleaned.length === sort_selected) {
  
            // reset params & remove overlay/banner
            sessionStorage.removeItem("sortFeedStopSorting");
            sessionStorage.removeItem("sortFeedStatus");
            profileNameIG=null; 
            // removeSortFeedBannerMessage();
            // resolve 

            resolve(itemsCleaned);
            return;
          } 

          // ✅ Case 02 -- no more next pages and reached end of network length
          else if (i === numberItems - 1 && !nextPage) {
  




            // reset params & remove overlay/banner
            sessionStorage.removeItem("sortFeedStopSorting");
            sessionStorage.removeItem("sortFeedStatus");
            profileNameIG=null; 
            // removeSortFeedBannerMessage();
            // resolve 

            resolve(itemsCleaned);
            return;
          }
          
          // ✅ Case 03 -- keep scrapping!
          else if (i === numberItems - 1 && nextPage) {
  
            break;
          } 
        }
      }
      }
    }
    // No scrolling (Phase 3): ask for the next page ourselves, or finish.
    _sfReqAfterPage(nextPage, resolve);
  });
}

// remove overlay
function remove_overlay() {
  // if (DEBUG) console.log('REMOVED OVERLAY');
  // document.getElementById("overlay_sort_reels").remove();
  const ov = document.getElementById("overlay_sort_reels");
  if (ov) ov.remove();
}

function return_date_range(sort_selected) {
  // Custom range — encoded as `custom_<fromMs>_<toMs>`
  if (typeof sort_selected === "string" && sort_selected.startsWith("custom_")) {
    const parts = sort_selected.split("_");
    const fromMs = parseInt(parts[1], 10);
    const toMs = parseInt(parts[2], 10);
    if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
      const start_date = new Date(fromMs);
      const end_date = new Date(toMs);
      // Normalise To to end-of-day so a same-day pick captures the full day.
      end_date.setHours(23, 59, 59, 999);
      return [start_date, end_date];
    }
  }
  let start_date = new Date(); // Current date
  let end_date = new Date(); // Copy current date
  if (sort_selected === "1_week") {
    start_date.setDate(end_date.getDate() - 7);
    return [start_date, end_date];
  } else if (sort_selected === "1_month") {
    start_date.setDate(end_date.getDate() - 30);
    return [start_date, end_date];
  } else if (sort_selected === "3_month") {
    start_date.setDate(end_date.getDate() - 90);
    return [start_date, end_date];
  } else if (sort_selected === "6_month") {
    start_date.setDate(end_date.getDate() - 180);
    return [start_date, end_date];
  } else if (sort_selected === "1_year") {
    start_date.setDate(end_date.getDate() - 360);
    return [start_date, end_date];
  } else if (sort_selected === "all_reels") {
    start_date.setDate(end_date.getDate() - 3600); // 10 years ago
    return [start_date, end_date];
  }
}

function is_create_date_in_range(createDate, startDate, endDate) {
  const createDateObj = new Date(createDate);
  if (isNaN(createDateObj) || isNaN(startDate) || isNaN(endDate)) {
    throw new Error("Invalid date format");
  }
  return createDateObj >= startDate && createDateObj < endDate;
}

async function sort_date_posts(
  numberItems,
  jsonResponse,
  nextPage,
  startDate,
  endDate
) {
  return new Promise(async (resolve) => {
    // Show the sort banner immediately so the user sees feedback even when the
    // first batch of posts is all newer than the requested range (skipped via continue).
    insta_banner_notification(inMemoryFeedData.items || [], "Posts");
    for (let i = 0; i < numberItems; i++) {
      // Stop owns the finish from here on — see sort_item_posts.
      if (_sfStopRequested()) { _sfStopNow(); return; }

      let singleNode = jsonResponse.data.xdt_api__v1__feed__user_timeline_graphql_connection.edges[i].node;
      let singleNodeJSON = createMetadataJson(singleNode);
      let element = _sfReq.on ? await _sfReqItemTick() : await find_element_instagram_again_posts(singleNodeJSON.code);

      // Before the save — an aborted wait hands back a null element.
      if (_sfStopRequested()) { _sfStopNow(); return; }

      let singleNodeJSONUpdated = update_data_object_with_element(singleNodeJSON, element);
      let createDate = singleNodeJSONUpdated.createDate;

      // Advance the progress cursor — but never off a PINNED post. IG floats
      // those to the top whatever their age, so a pinned 2019 post would read as
      // "we've already scrolled back years" and slam the bar to 100% on item one.
      if (!(singleNode.timeline_pinned_user_ids && singleNode.timeline_pinned_user_ids.length > 0)) {
        _sfNoteScanCursor(createDate);
      }

      if (sessionStorage.getItem("sortFeedStatus")) {
      let sort_feed_sorting = sessionStorage.getItem("sortFeedStopSorting");

        // ✅ Case 00 -- user clicked stop sorting
        if (sort_feed_sorting === "on") {
          _sfOutlierPool.stoppedByUser = true; // aborted sort → skip outlier scoring
          // Only save the in-progress post if it's actually in range. For deep
          // past ranges where the loop is skipping newer-than-end posts, the
          // current post is out-of-range and saving it would surface a wrong post.
          let itemsCleaned;
          try {
            if (is_create_date_in_range(createDate, startDate, endDate)) {
              itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);
            } else {
              itemsCleaned = inMemoryFeedData.items;
            }
          } catch (e) {
            itemsCleaned = inMemoryFeedData.items;
          }
          removeSortFeedBannerMessage();
          sessionStorage.removeItem("sortFeedStopSorting");
          sessionStorage.removeItem("sortFeedStatus");
          resolve(itemsCleaned);
          return;
        } else {

          // ✅ Case 01 — In range, more items ahead (keep scrolling)
          if (is_create_date_in_range(createDate, startDate, endDate) && i !== numberItems - 1) {
  
            let itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);
            send_items_collected_no(itemsCleaned);
            insta_banner_notification(itemsCleaned, "Posts");
          }

          // ✅ Case 02 — In range, last item, no next page
          else if (is_create_date_in_range(createDate, startDate, endDate) && i === numberItems - 1 && nextPage === false) {
  
            let itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);
            send_items_collected_no(itemsCleaned);
            insta_banner_notification(itemsCleaned, "Posts");
            sessionStorage.removeItem("sortFeedStopSorting");
            sessionStorage.removeItem("sortFeedStatus");
            resolve(itemsCleaned);
          }

          // ✅ Case 03 — In range, last item, but more pages
          else if (is_create_date_in_range(createDate, startDate, endDate) && i === numberItems - 1 && nextPage === true) {
  
            let itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);
            send_items_collected_no(itemsCleaned);
            insta_banner_notification(itemsCleaned, "Posts");
          }

          // ✅ Case 04 — Out of range
          else if (!is_create_date_in_range(createDate, startDate, endDate)) {
            if (singleNode.timeline_pinned_user_ids && singleNode.timeline_pinned_user_ids.length > 0) {
              _sfDatePinnedSkipped = true; // see the flag's note — blocks dates→items re-sorts
              continue; // skip pinned
            }
            // Newer than the end of the range — skip and keep scrolling toward older posts.
            // (For relative-back ranges where end ≈ now this branch never fires.)
            if (new Date(createDate) > endDate) {
              // Tick the banner anyway. Nothing is collected on this leg, so
              // without it the seek down to a historical range is completely
              // silent — the count stays put (the message no-ops on an unchanged
              // number) but the scan progress moves, which is the whole point.
              insta_banner_notification(inMemoryFeedData.items || [], "Posts");
              continue;
            }
            // Older than the start — stop the scroll.
            let itemsCleaned = inMemoryFeedData.items;
            sessionStorage.removeItem("sortFeedStopSorting");
            sessionStorage.removeItem("sortFeedStatus");
            resolve(itemsCleaned);
            break;
          }
        }
      }
    }
    // No scrolling (Phase 3): ask for the next page ourselves, or finish.
    _sfReqAfterPage(nextPage, resolve);
  });
}


// Reels date sorting — mirrors sort_date_posts exactly, the only difference is
// the create date comes from the pk decode (createMetadataJsonReels) instead of
// taken_at, and pinned reels are detected via clips_tab_pinned_user_ids.
async function sort_date_reels(
  numberItems,
  jsonResponse,
  nextPage,
  startDate,
  endDate
) {
  return new Promise(async (resolve) => {
    // Show the sort banner immediately so the user sees feedback even when the
    // first batch of reels is all newer than the requested range (skipped via continue).
    insta_banner_notification(inMemoryFeedData.items || [], "Reels");
    for (let i = 0; i < numberItems; i++) {
      // Stop owns the finish from here on — see sort_item_posts.
      if (_sfStopRequested()) { _sfStopNow(); return; }

      let singleNode =
        sfGetClipsConnection(jsonResponse).edges[i].node.media;

      // The clips connection only returns reels (media_type 2) — guard defensively.
      if (singleNode.media_type !== 2) continue;

      let singleNodeJSON = createMetadataJsonReels(singleNode);
      let element = _sfReq.on ? await _sfReqItemTick() : await find_element_instagram_again(singleNodeJSON.code);

      // Before the save — an aborted wait hands back a null element.
      if (_sfStopRequested()) { _sfStopNow(); return; }

      let singleNodeJSONUpdated = update_data_object_with_element(singleNodeJSON, element);
      let createDate = singleNodeJSONUpdated.createDate;

      // Pinned reels must not move the cursor — see the note in sort_date_posts.
      if (!(singleNode.clips_tab_pinned_user_ids && singleNode.clips_tab_pinned_user_ids.length > 0)) {
        _sfNoteScanCursor(createDate);
      }

      if (sessionStorage.getItem("sortFeedStatus")) {
        let sort_feed_sorting = sessionStorage.getItem("sortFeedStopSorting");

        // ✅ Case 00 -- user clicked stop sorting
        if (sort_feed_sorting === "on") {
          _sfOutlierPool.stoppedByUser = true; // aborted sort → skip outlier scoring
          // Only save the in-progress reel if it's actually in range. For deep
          // past ranges where the loop is skipping newer-than-end reels, the
          // current reel is out-of-range and saving it would surface a wrong one.
          let itemsCleaned;
          try {
            if (is_create_date_in_range(createDate, startDate, endDate)) {
              itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);
            } else {
              itemsCleaned = inMemoryFeedData.items;
            }
          } catch (e) {
            itemsCleaned = inMemoryFeedData.items;
          }
          removeSortFeedBannerMessage();
          sessionStorage.removeItem("sortFeedStopSorting");
          sessionStorage.removeItem("sortFeedStatus");
          profileNameIG = null;
          resolve(itemsCleaned);
          return;
        } else {

          // ✅ Case 01 — In range, more items ahead (keep scrolling)
          if (is_create_date_in_range(createDate, startDate, endDate) && i !== numberItems - 1) {
            let itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);
            send_items_collected_no(itemsCleaned);
            insta_banner_notification(itemsCleaned, "Reels");
          }

          // ✅ Case 02 — In range, last item, no next page
          else if (is_create_date_in_range(createDate, startDate, endDate) && i === numberItems - 1 && nextPage === false) {
            let itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);
            send_items_collected_no(itemsCleaned);
            insta_banner_notification(itemsCleaned, "Reels");
            sessionStorage.removeItem("sortFeedStopSorting");
            sessionStorage.removeItem("sortFeedStatus");
            profileNameIG = null;
            resolve(itemsCleaned);
          }

          // ✅ Case 03 — In range, last item, but more pages
          else if (is_create_date_in_range(createDate, startDate, endDate) && i === numberItems - 1 && nextPage === true) {
            let itemsCleaned = save_data_locally_again(singleNodeJSONUpdated);
            send_items_collected_no(itemsCleaned);
            insta_banner_notification(itemsCleaned, "Reels");
          }

          // ✅ Case 04 — Out of range
          else if (!is_create_date_in_range(createDate, startDate, endDate)) {
            // Pinned reels can float to the top regardless of age — skip them so
            // an old pinned reel doesn't halt the scroll before the in-range ones.
            if (singleNode.clips_tab_pinned_user_ids && singleNode.clips_tab_pinned_user_ids.length > 0) {
              _sfDatePinnedSkipped = true; // see the flag's note — blocks dates→items re-sorts
              continue; // skip pinned
            }
            // Newer than the end of the range — skip and keep scrolling toward older reels.
            // (For relative-back ranges where end ≈ now this branch never fires.)
            if (new Date(createDate) > endDate) {
              // Keep the bar alive through the silent seek leg — see sort_date_posts.
              insta_banner_notification(inMemoryFeedData.items || [], "Reels");
              continue;
            }
            // Older than the start — stop the scroll.
            let itemsCleaned = inMemoryFeedData.items;
            sessionStorage.removeItem("sortFeedStopSorting");
            sessionStorage.removeItem("sortFeedStatus");
            profileNameIG = null;
            resolve(itemsCleaned);
            break;
          }
        }
      }
    }
    // No scrolling (Phase 3): ask for the next page ourselves, or finish.
    _sfReqAfterPage(nextPage, resolve);
  });
}


// Main listening function
(function () {
  // Idempotence guard. This file is now a MAIN-world content script, so it is
  // evaluated exactly once — but wrapping XMLHttpRequest twice would parse every
  // response twice (duplicate items, double-counted progress), and that failure
  // is quiet enough to be worth one line of insurance.
  if (window.__sfIgXhrWrapped) return;
  window.__sfIgXhrWrapped = true;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method,
    url,
    async,
    user,
    password,
  ) {
    this._url = url; // Store the URL for later use
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    _sfDiagNoteIgRequest(this, body);
    this.addEventListener("load", function () {
      // Stories: cache the reel (every item of one account's story) so the
      // story download button picks the active item without a fetch. Since
      // Oct 2026 the web app loads it over GraphQL
      // (PolarisStoriesV3ReelPageStandaloneQuery →
      // data.xdt_api__v1__feed__reels_media.reels_media, same reel shape);
      // the REST /api/v1/feed/reels_media/ answers 500 and is kept in case it
      // comes back. The tray moved the same way
      // (PolarisStoriesV3TrayContainerQuery → data.xdt_api__v1__feed__reels_tray.tray).
      if (this._url) {
        const url = this._url;
        const isGql = url.includes("/graphql/query") || url.includes("/api/graphql");
        let text = null;
        try {
          if (this.responseType === "" || this.responseType === "text") text = this.responseText;
        } catch (e) {}

        if (text && (url.includes("/api/v1/feed/reels_media/") ||
            (isGql && text.includes('"xdt_api__v1__feed__reels_media"')))) {
          try {
            const json = JSON.parse(text);
            const reels = json?.reels_media || json?.data?.xdt_api__v1__feed__reels_media?.reels_media;
            if (Array.isArray(reels)) {
              for (const reel of reels) {
                const reelId = reel?.id || reel?.user?.pk || reel?.user?.id;
                if (reelId && Array.isArray(reel.items)) {
                  window.postMessage(
                    {
                      sf_reels_media: {
                        reel_id: String(reelId),
                        items: reel.items,
                        user: reel.user || null,
                      },
                    },
                    "*",
                  );
                }
              }
            }
          } catch (e) {}
        }

        // Tray: lets the first click on a live story skip a fetch.
        if (text && (url.includes("/api/v1/feed/reels_tray/") ||
            (isGql && text.includes('"xdt_api__v1__feed__reels_tray"')))) {
          try {
            const json = JSON.parse(text);
            const tray = json?.tray || json?.data?.xdt_api__v1__feed__reels_tray?.tray;
            if (Array.isArray(tray)) {
              window.postMessage({ sf_reels_tray: tray }, "*");
            }
          } catch (e) {}
        }
      }

      // Profile Reels / Posts pages: the depth note, the timing log, the outlier
      // record and the sort loops all live in _sfOnProfilePage, which the
      // no-scroll collector (new-sort-logic Phase 3) also feeds with the pages it
      // asks Instagram for itself. Only parsed while a sort (or its outlier pool)
      // is running.
      if (
        this._url &&
        sfIsGraphqlUrl(this._url) &&
        (this.responseType === "" || this.responseType === "text") &&
        (sessionStorage.getItem("sortFeedStatus") || _sfOutlierPool.active)
      ) {
        let json = null;
        try { json = JSON.parse(this.responseText); } catch (e) {}
        if (json) {
          try { _sfOnProfilePage(json, "instagram"); } catch (e) { if (DEBUG) console.error(e); }
        }
      }
    });
    return originalSend.apply(this, arguments);
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// One profile page in (new-sort-logic Phase 3)
//
// Every Reels / Posts page of a profile sort comes through here: Instagram's own
// (from the XHR wrap above; page 1, or every page when collecting by scrolling)
// and the ones the no-scroll collector asks for itself. Same steps for both, in
// the order the XHR wrap always ran them: depth note + timing, the collector's
// pace for this page, the outlier record (which can ask for the next pool page),
// then the sort loop for the tab and mode.
// ─────────────────────────────────────────────────────────────────────────────
function _sfOnProfilePage(json, source) {
  const conn =
    sfGetClipsConnection(json) ||
    json?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
  if (!conn) return;
  // Once the collector has asked Instagram for a page itself, a page Instagram
  // loads on its own isn't ours to count again.
  if (source === "instagram" && _sfReq.started) return;

  const status = sessionStorage.getItem("sortFeedStatus");
  // The line (Phase 5): a profile sort waits for its turn before it counts
  // anything — Instagram's page 1 is held until the line says go.
  if (status && !sessionStorage.getItem("sortFeedSurface") && !_sfLineGate.go) {
    _sfLineHold(json, source);
    return;
  }
  if (status) {
    _sfNoteResponseDepth(json);
    _sfTimingPage(json);
  }
  // The collector only follows the tab being sorted (a Reels sort can also see
  // Instagram load the Posts grid, and that cursor isn't ours).
  const ownTab = (sessionStorage.getItem("sortFeedPostsVSReels") === "Reels") === !!sfGetClipsConnection(json);
  if ((status || _sfOutlierPool.active) && ownTab) _sfReqPageArrived(conn);
  if (_sfOutlierRecordOn()) _sfOutlierRecordResponse(json);
  if (status) _sfDispatchProfilePage(json, conn);
}

// The tab + mode → sort loop routing that used to sit inline in the XHR wrap.
function _sfDispatchProfilePage(jsonResponse, conn) {
  const surface = sessionStorage.getItem("sortFeedSurface");
  if (surface === "explore_search" || surface === "saved") return;
  const tab = sessionStorage.getItem("sortFeedPostsVSReels");
  const mode = sessionStorage.getItem("sortItemsVsDates");
  const isClips = !!sfGetClipsConnection(jsonResponse);
  const numberItems = (conn.edges || []).length;
  const nextPage = conn.page_info?.has_next_page;

  // Posts tab: Date sorting
  if (tab === "Posts" && !isClips && mode === "dates") {
    let sort_selected = sessionStorage.getItem("sortFeedNoItems");
    let [start_date, end_date] = return_date_range(sort_selected);
    sort_date_posts(numberItems, jsonResponse, nextPage, start_date, end_date).then((itemsCleaned) => {
      if (!itemsCleaned || itemsCleaned.length === 0) {
        // Date range matched nothing — leave the original feed exactly as it is
        // and turn the progress banner into a "no Posts in this range" toast.
        _sfFinalizeEmptyRange("Posts");
      } else {
        // Outlier (Posts → likes): finish the baseline pool, stamp scores, THEN render.
        return _sfOutlierEnsurePool().then((sfOutlierMeta) => {
          _sfRenderSorted(itemsCleaned, sfOutlierMeta);
        });
      }
    });
  }
  // Posts tab: Item sorting
  else if (tab === "Posts" && !isClips && mode === "items") {
    let sort_selected = return_number_selected();
    let sortValue = sort_selected == 0 ? 10000 : sort_selected;
    sort_item_posts(numberItems, jsonResponse, sortValue, nextPage).then((itemsCleaned) =>
      _sfOutlierEnsurePool().then((sfOutlierMeta) => {
        _sfRenderSorted(itemsCleaned, sfOutlierMeta);
      })
    );
  }
  // Reels tab: Date sorting
  else if (tab === "Reels" && isClips && mode === "dates") {
    let sort_selected = sessionStorage.getItem("sortFeedNoItems");
    let [start_date, end_date] = return_date_range(sort_selected);
    sort_date_reels(numberItems, jsonResponse, nextPage, start_date, end_date)
      .then((itemsCleaned) => {
        if (!itemsCleaned || itemsCleaned.length === 0) {
          _sfFinalizeEmptyRange("Reels");
        } else {
          // Outlier: finish the baseline pool first, stamp scores, THEN render.
          return _sfOutlierEnsurePool().then((sfOutlierMeta) => {
            _sfRenderSorted(itemsCleaned, sfOutlierMeta);
          });
        }
      })
      .catch((e) => {
        console.error("Reels date sort error:", e);
      });
  }
  // Reels tab: Item sorting
  else if (tab === "Reels" && isClips && mode !== "dates") {
    let sort_selected = return_number_selected();
    let sortValue = sort_selected == 0 ? 10000 : sort_selected;
    sort_not_all_reels(numberItems, jsonResponse, sortValue, nextPage)
      .then((itemsCleaned) =>
        // Outlier: finish the baseline pool first, stamp scores, THEN render —
        // badges paint together with the grid.
        _sfOutlierEnsurePool().then((sfOutlierMeta) => {
          _sfRenderSorted(itemsCleaned, sfOutlierMeta);
        })
      )
      .catch((e) => {
        console.error("Reels sort error:", e);
      });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Collect by request (new-sort-logic Phase 3)
//
// A profile sort no longer scrolls Instagram's grid to make it load the next
// page. Page 1 is still Instagram's own (the request it makes as the profile
// loads); every page after that is asked for directly, 12 posts at a time,
// through the agent runner's request code (window.__sfIgProfilePager — the one
// home of the request shape), paced like a person flicking down a grid
// (NEW_SORT_PLAN.md › Pacing: today's scroll sort runs ~6.4 reels a second; this
// stays at or under it, with a third of the requests). The cards are built from
// data (Phase 2), so nothing has to be on screen and the page stays still.
//
// The count still climbs one by one: a page's posts are counted in one at a time,
// spread across the wait before the next request (itemDelay).
//
// Falls back to scrolling when the request can't be built on this page (or
// localStorage sfRequestSortIG = "0"). A refusal from Instagram (429, security
// check, login wall) stops the sort and shows what was collected; it never falls
// back to scrolling, which would only ask again.
// ─────────────────────────────────────────────────────────────────────────────
const SF_REQ_PACE = {
  centreMin: 1500, centreMax: 1900, // ms between pages, centre picked once per sort (avg ≈ 2.2 s with pauses)
  jitter: 0.2,                      // log-normal spread around the centre
  pauseEvery: [6, 10],              // a longer "reading" pause every 6–10 pages…
  pauseMs: [3000, 6000],            // …of 3–6 s
  tiredAfter: 25,                   // after page 25 (300 posts) gaps grow…
  tiredStep: 0.02,                  // …2% a page…
  tiredMax: 1.6,                    // …up to 1.6×
  itemMaxMs: 160,                   // the count never ticks slower than this per post
  floorAvgMs: 1850,                 // the running average never drops below this: today's
                                    // scroll sort is ~6.4 reels/s, i.e. a 12-reel page per 1.85 s
};
const _SF_REQ_NO_FALLBACK = ["THROTTLED", "CHECKPOINT", "LOGGED_OUT", "AUTH"];

const _sfReq = {
  decided: false, on: false, started: false, fellBack: null,
  centre: 0, pages: 0, nextPauseAt: 0, nextAt: 0, itemDelay: 0, gapSum: 0,
  factor: 1,                        // the line's slowdown (2 past 300 pages in a line session)
  cursor: null, inflight: false, requests: 0, okPages: 0, error: null,
};

function _sfReqSurface() {
  return sessionStorage.getItem("sortFeedPostsVSReels") === "Posts" ? "posts" : "reels";
}
function _sfReqUser() {
  return (location.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
}

// Chosen once, on the sort's first page.
function _sfReqUsable() {
  try { if (localStorage.getItem("sfRequestSortIG") === "0") return false; } catch (e) {}
  if (!_sfDataTilesOn()) return false; // copied cards need the page to scroll past every card
  const pager = window.__sfIgProfilePager;
  return !!(pager && pager.ready(_sfReqSurface()));
}

// The wait before the next request: human-shaped, never a fixed beat.
function _sfReqGap() {
  const P = SF_REQ_PACE, R = _sfReq;
  const between = (a, b) => a + Math.random() * (b - a);
  if (!R.centre) {
    R.centre = between(P.centreMin, P.centreMax);
    R.nextPauseAt = Math.round(between(P.pauseEvery[0], P.pauseEvery[1]));
  }
  R.pages++;
  const keep = (ms) => { ms = Math.round(ms); R.gapSum += ms; return ms; };
  if (R.pages >= R.nextPauseAt) {
    R.nextPauseAt = R.pages + Math.round(between(P.pauseEvery[0], P.pauseEvery[1]));
    return keep(between(P.pauseMs[0], P.pauseMs[1]) * R.factor);
  }
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  const randn = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  let ms = R.centre * Math.exp(P.jitter * randn);
  ms = Math.max(R.centre * 0.7, Math.min(ms, R.centre * 1.4));
  if (R.pages > P.tiredAfter) ms *= Math.min(P.tiredMax, 1 + P.tiredStep * (R.pages - P.tiredAfter));
  // Never faster than today on average (a short sort may not reach a pause).
  const need = P.floorAvgMs * R.pages - R.gapSum;
  if (ms < need) ms = need + Math.random() * 150;
  return keep(ms * R.factor);
}

// A page arrived (Instagram's page 1, or one we asked for): settle the mode on
// the first one, note the cursor, and set this page's pace.
function _sfReqPageArrived(conn) {
  if (!_sfReq.decided) {
    _sfReq.decided = true;
    _sfReq.on = _sfReqUsable();
  }
  _sfReq.cursor = conn.page_info?.end_cursor || null;
  if (!_sfReq.on) return;
  const n = (conn.edges || []).length;
  const gap = _sfReqGap();
  _sfReq.nextAt = performance.now() + gap;
  _sfReq.itemDelay = Math.min(SF_REQ_PACE.itemMaxMs, gap / Math.max(1, n));
}

// A Stop-aware wait (Stop's flush settles it at once).
function _sfReqSleep(ms) {
  return new Promise((resolve) => {
    const waiter = _sfStopRegisterWaiter(resolve);
    if (_sfStop.requested) { _sfStopSettle(waiter, null); return; }
    waiter.timer = setTimeout(() => _sfStopSettle(waiter, null), Math.max(0, ms));
  });
}

// Replaces find_element_* in the collect loops while collecting by request: no
// scrolling, just the per-post beat that makes the count climb one by one.
// Resolves null, like an element wait with nothing on screen.
function _sfReqItemTick() {
  // Hidden tab: the tab title and toolbar icon still show this count, so it
  // climbs one by one there too — timed by the background clock (_sfReqWait),
  // since Chrome stretches a hidden page's own timers to a second, then a minute.
  return _sfReqWait(_sfReq.itemDelay);
}

// The wait before the next request. In a visible tab a plain timer; in a hidden
// one the background service worker keeps the time (Chrome throttles a hidden
// page's timers, not the extension's), relayed by banner_on_insta.js
// (sf_req_wait → SF_SORT_WAIT → sf_req_waited). Stop settles it at once; if the
// extension never answers (reloaded mid-sort) a long page timer still ends it.
let _sfReqWaitSeq = 0;
function _sfReqWait(ms) {
  if (!(ms > 0)) return Promise.resolve(null);
  if (!document.hidden) return _sfReqSleep(ms);
  return new Promise((resolve) => {
    const waiter = _sfStopRegisterWaiter(resolve);
    if (_sfStop.requested) { _sfStopSettle(waiter, null); return; }
    const id = ++_sfReqWaitSeq;
    const onMsg = (ev) => {
      if (ev.source !== window || !ev.data || ev.data.sf_req_waited !== id) return;
      window.removeEventListener("message", onMsg);
      _sfStopSettle(waiter, null);
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ sf_req_wait: { id, ms: Math.round(ms) } }, "*");
    waiter.timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      _sfStopSettle(waiter, null);
    }, ms + 10000);
  });
}

// Run fn now if the tab is visible, else the moment it's opened.
function _sfWhenVisible(fn) {
  if (!document.hidden) { fn(); return; }
  const onVis = () => {
    if (document.hidden) return;
    document.removeEventListener("visibilitychange", onVis);
    fn();
  };
  document.addEventListener("visibilitychange", onVis);
}

// End of a page's loop that neither finished nor stopped the sort: ask for the
// next page, or finish when the feed has none (the scroll path would have hung
// here if the last item wasn't one the loop counts).
function _sfReqAfterPage(nextPage, resolve) {
  if (!_sfReq.on || _sfStopRequested() || !sessionStorage.getItem("sortFeedStatus")) return;
  if (nextPage) { _sfReqNextPage(); return; }
  sessionStorage.removeItem("sortFeedStatus");
  profileNameIG = null;
  resolve(inMemoryFeedData.items);
}

function _sfReqProfileId(user) {
  try {
    const [u, pk] = (sessionStorage.getItem("sortFeedProfilePkIG") || "").split(":");
    if (u && pk && u.toLowerCase() === user) return pk;
  } catch (e) {}
  return null; // the pager finds it on the page
}

// Wait out this page's pace, then ask for the next page and feed it in.
async function _sfReqNextPage() {
  if (_sfReq.inflight || !_sfReq.cursor) return;
  _sfReq.inflight = true;
  try {
    await _sfReqWait(_sfReq.nextAt - performance.now());
    if (_sfStopRequested()) return;
    if (!sessionStorage.getItem("sortFeedStatus") && !_sfOutlierPool.active) return;
    const user = _sfReqUser();
    const ctx = { username: user, id: _sfReqProfileId(user) };
    _sfReq.started = true;
    _sfReq.requests++;
    _sfDiagNoteOurs(ctx);
    const json = await window.__sfIgProfilePager.page(_sfReqSurface(), ctx, _sfReq.cursor);
    if (_sfStopRequested()) return;
    _sfReq.okPages++;
    window.postMessage({ sf_line_page: true }, "*"); // the line counts it; may answer with a slowdown
    _sfReq.inflight = false;
    _sfOnProfilePage(json, "request");
  } catch (e) {
    _sfReqFail(e);
  } finally {
    _sfReq.inflight = false;
  }
}

function _sfReqFail(e) {
  const code = (e && e.code) || "ERROR";
  _sfReq.error = code;
  _sfDiagNoteError(e);
  if (DEBUG) console.log("[sf-req] request failed", code, e && e.message);
  if (_sfStopRequested()) return;
  // Before any page of ours arrived, Instagram's own paging is still on page 1:
  // scrolling picks up exactly where we are, so fall back — unless Instagram
  // refused, in which case scrolling would only ask again.
  if (_sfReq.okPages === 0 && !_SF_REQ_NO_FALLBACK.includes(code)) {
    _sfReq.on = false;
    _sfReq.started = false;
    _sfReq.fellBack = code;
    if (_sfOutlierPool.active) _sfOutlierRequestNextPage();
    else window.scrollTo(0, document.body.scrollHeight);
    return;
  }
  // Instagram refused: every tab in the line stops too, and new sorts pause (Phase 5).
  if (_SF_REQ_NO_FALLBACK.includes(code)) window.postMessage({ sf_line_refused: { code } }, "*");
  // Otherwise stop here and show what was collected, the same as Stop.
  if (_sfOutlierPool.active) _sfOutlierFinish({ status: "error", baseline: null, poolSize: 0 });
  else _sfStopNow();
}

// ─────────────────────────────────────────────────────────────────────────────
// Request diagnostics (new-sort-logic Phase 3)
//
// TEST SWITCH: must be false in anything shipped. When on, every profile sort
// downloads sortfeed-request-diag-<profile>.txt when it ends: what Sort Feed
// asked Instagram for and what came back (the error message on a refusal), and
// the shape of Instagram's OWN profile requests seen on this page load (query
// name, query id, variables). Tokens are never written: only the names of the
// other form fields.
// ─────────────────────────────────────────────────────────────────────────────
const SF_REQ_DIAG = false;
const _sfDiag = { ig: [], ours: [], errors: [] };
const _SF_DIAG_TOKENS = new Set(["fb_dtsg", "lsd", "jazoest", "av", "__user", "__hs", "__hsi", "__rev", "__spin_r", "__spin_b", "__spin_t", "__dyn", "__csr", "__s", "__hsdp", "__hblp", "__sjsp", "__crn"]);

function _sfDiagNoteIgRequest(xhr, body) {
  if (!SF_REQ_DIAG || typeof body !== "string" || !body.includes("fb_api_req_friendly_name")) return;
  try {
    const p = new URLSearchParams(body);
    const friendly = p.get("fb_api_req_friendly_name") || "";
    if (!/profile|reel|clips|timeline|posts|user/i.test(friendly)) return;
    const entry = {
      at: Math.round(performance.now()), url: String(xhr._url || ""), friendly, docId: p.get("doc_id"),
      variables: (p.get("variables") || "").slice(0, 2000),
      otherFields: [...p.keys()].filter((k) => !["fb_api_req_friendly_name", "doc_id", "variables"].includes(k)).map((k) => (_SF_DIAG_TOKENS.has(k) ? k + "=…" : k + "=" + p.get(k))).join("&"),
      status: null, dataKeys: null, edges: null,
    };
    _sfDiag.ig.push(entry);
    xhr.addEventListener("load", () => {
      try {
        entry.status = xhr.status;
        const j = JSON.parse(xhr.responseText);
        entry.dataKeys = j && j.data ? Object.keys(j.data) : (j && j.errors ? "errors: " + JSON.stringify(j.errors).slice(0, 400) : null);
        const conn = sfGetClipsConnection(j) || j?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
        if (conn) entry.edges = (conn.edges || []).length + (conn.page_info?.has_next_page ? " (has next)" : " (last)");
      } catch (e) {}
    });
  } catch (e) {}
}

function _sfDiagNoteOurs(ctx) {
  if (!SF_REQ_DIAG) return;
  try {
    const d = window.__sfIgProfilePager.describe(_sfReqSurface(), ctx, _sfReq.cursor);
    _sfDiag.ours.push({ at: Math.round(performance.now()), surface: _sfReqSurface(), after: _sfReq.cursor, idUsed: ctx.id || "(found on page)", ...d });
  } catch (e) { _sfDiag.ours.push({ describeError: String(e && e.message || e) }); }
}

function _sfDiagNoteError(e) {
  if (!SF_REQ_DIAG) return;
  _sfDiag.errors.push({ at: Math.round(performance.now()), code: (e && e.code) || "ERROR", message: String((e && e.message) || e) });
}

function _sfDiagFinish(collected) {
  if (!SF_REQ_DIAG) return;
  const ss = (k) => { try { return sessionStorage.getItem(k) || ""; } catch (e) { return ""; } };
  const profile = location.pathname.split("/").filter(Boolean)[0] || "profile";
  let templates = "";
  try { templates = localStorage.getItem("sfAgentTemplates") || "(none)"; } catch (e) {}
  let ready = null;
  try { ready = window.__sfIgProfilePager ? window.__sfIgProfilePager.ready(_sfReqSurface()) : "no pager on this page"; } catch (e) { ready = "error: " + e.message; }
  const out = {
    what: "Sort Feed — request diagnostics (new-sort-logic Phase 3)",
    when: new Date().toISOString(),
    page: location.pathname,
    sort: { tab: ss("sortFeedPostsVSReels"), mode: ss("sortItemsVsDates"), target: ss("sortFeedNoItems"), sortBy: ss("sortFeedSortBy"), collected },
    collector: { on: _sfReq.on, decided: _sfReq.decided, pagerReady: ready, requests: _sfReq.requests, okPages: _sfReq.okPages, fellBack: _sfReq.fellBack, error: _sfReq.error, profilePk: ss("sortFeedProfilePkIG") },
    errors: _sfDiag.errors,
    oursAsked: _sfDiag.ours,
    instagramsOwnProfileRequests: _sfDiag.ig,
    learntTemplates: templates,
  };
  const text = JSON.stringify(out, null, 2);
  if (DEBUG) console.log(text);
  try {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `sortfeed-request-diag-${profile}.txt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Waiting for the line (new-sort-logic Phase 5)
//
// A profile sort only counts once the line (background_sort_clock.js, through
// banner_on_insta.js) says it's this tab's turn: sf_line_go. Until then the
// first page Instagram loads is held here. banner_on_insta.js answers fast —
// sf_line_go at once for the only sort, or sf_line_hold while it waits — and if
// nothing answers in a few seconds (an extension reloaded under the page) the
// sort goes ahead on its own rather than wait forever.
// ─────────────────────────────────────────────────────────────────────────────
const SF_LINE_ANSWER_MS = 4000;
const _sfLineGate = { go: false, held: null, holdSeen: false, timer: null };

function _sfLineHold(json, source) {
  if (!_sfLineGate.held) _sfLineGate.held = { json, source };
  if (_sfLineGate.timer || _sfLineGate.holdSeen) return;
  _sfLineGate.timer = setTimeout(() => {
    _sfLineGate.timer = null;
    if (!_sfLineGate.holdSeen) _sfLineGo();
  }, SF_LINE_ANSWER_MS);
}

function _sfLineGo() {
  if (_sfLineGate.go) return;
  _sfLineGate.go = true;
  clearTimeout(_sfLineGate.timer);
  _sfLineGate.timer = null;
  const held = _sfLineGate.held;
  _sfLineGate.held = null;
  if (held) _sfOnProfilePage(held.json, held.source);
}

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data) return;
  if (event.data.sf_line_go) _sfLineGo();
  else if (event.data.sf_line_hold) { _sfLineGate.holdSeen = true; clearTimeout(_sfLineGate.timer); _sfLineGate.timer = null; }
  else if (event.data.sf_line_factor) _sfReq.factor = Number(event.data.sf_line_factor.factor) > 1 ? Number(event.data.sf_line_factor.factor) : 1;
});
