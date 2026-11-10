// Page-world script — Explore search sorting (counterpart to script_instagram.js).
// Intercepts `xdt_fbsearch__top_serp_graphql` XHR responses and builds the same
// metadata shape the profile flow uses, so banner / hover / export / download
// helpers all work unchanged.
//
// Gated on `sessionStorage.sortFeedSurface === "explore_search"` so it stays
// completely dormant during a profile sort.

const SF_EXPLORE_DEBUG = false;

const sfExploreMemory = {
  items: [],
  seen: new Set(), // post ids / codes already collected — a search can hand the same post back on a later page
};

function sfExploreSeenKey(meta) {
  return meta.postID != null ? "id:" + meta.postID : meta.code ? "code:" + meta.code : "";
}

function sfExploreSaveLocally(meta) {
  const key = sfExploreSeenKey(meta);
  if (key) sfExploreMemory.seen.add(key);
  // Collection index, for back-to-back re-sorting. Search results come back in
  // IG's relevance order, which nothing on the item can reconstruct — so
  // narrowing a re-sort (100 → latest 50) has to slice on arrival order.
  meta._sfSeq = sfExploreMemory.items.length;
  sfExploreMemory.items.push(meta);
  return sfExploreMemory.items;
}

// ── Stop Sorting — immediate abort ──────────────────────────────────────────
// Mirrors the profile flow's `_sfStop` (script_instagram.js), kept self-contained
// because the three page-world scripts are injected as independent <script> tags
// with no guaranteed execution order.
//
// The banner's Stop button raises the `sortFeedStopSorting` flag AND posts
// `sf_stop_sorting`. The flag alone could only be polled — and the poll sits
// *after* `await sfExploreFindElement`, which spends up to ~1.2s hunting the
// anchor plus ~1.4s waiting for the tile's media before returning. This registry
// settles those waits on the click's own tick instead.
const sfExploreStop = {
  requested: false,
  waiters: new Set(),
};

function sfExploreStopRequested() {
  if (sfExploreStop.requested) return true;
  try {
    return sessionStorage.getItem("sortFeedStopSorting") === "on";
  } catch (e) {
    return false;
  }
}

function sfExploreRegisterWaiter(resolve) {
  const waiter = { resolve: resolve, timer: null, settled: false };
  sfExploreStop.waiters.add(waiter);
  return waiter;
}

function sfExploreSettle(waiter, value) {
  if (waiter.settled) return;
  waiter.settled = true;
  clearTimeout(waiter.timer);
  sfExploreStop.waiters.delete(waiter);
  try {
    waiter.resolve(value);
  } catch (e) {}
}

// Cut every pending wait short and kill its timer, so no zombie poll ladder
// keeps scrolling the page after the sort is over.
function sfExploreFlushWaiters() {
  const pending = Array.from(sfExploreStop.waiters);
  sfExploreStop.waiters.clear();
  pending.forEach((w) => {
    if (w.settled) return;
    w.settled = true;
    clearTimeout(w.timer);
    try {
      w.resolve(null);
    } catch (e) {}
  });
}

// Abort everything in flight and finish from what has already been collected —
// including when Stop lands in the gap between pages, where no batch is running.
function sfExploreStopNow() {
  if (sfExploreStop.requested) return;
  sfExploreStop.requested = true;
  sfExploreFlushWaiters();
  sfExploreFinalize(sfExploreMemory.items);
}

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || !event.data.sf_stop_sorting) return;
  // Explore search only — the profile and saved scripts get this same broadcast.
  if (sessionStorage.getItem("sortFeedSurface") !== "explore_search") return;
  sfExploreStopNow();
});

// Convert one XDTMediaDict item from the search response into the same metadata
// shape `createMetadataJson` produces for profile posts. Keep field names
// identical so downstream renderers and exporters need no surface-specific code.
function sfExploreCreateMetadata(item) {
  const ts = item?.taken_at ? item.taken_at * 1000 : null;
  return {
    createDate: ts ? new Date(ts).toISOString() : "",
    code: item?.code || "",
    commentsCount: item?.comment_count ?? null,
    likesCount: item?.like_count ?? null,
    mediaType: item?.media_type ?? null,
    viewCount: item?.view_count ?? null,
    userName: item?.user?.username || "",
    caption: item?.caption?.text || "",
    postID: item?.pk ?? null,
    // Poster frame for the player — widest cover candidate, same rule
    // as the profile captures in script_instagram.js.
    thumbnailUrl: (() => {
      const c = item?.image_versions2?.candidates;
      if (!Array.isArray(c) || !c.length) return null;
      let best = null, bestW = -1;
      for (const cand of c) {
        const w = cand?.width || 0;
        if (cand?.url && w > bestW) { bestW = w; best = cand.url; }
      }
      return best;
    })(),
    // Smaller cover for a card built from data (_sfGridThumb in script_instagram.js).
    gridThumbUrl: typeof _sfGridThumb === "function" ? _sfGridThumb(item) : null,
  };
}

// Walk the SERP edges and flatten the per-row `items` arrays. Defensive against
// IG mixing in non-media units (account suggestions etc.) in the future.
function sfExploreFlattenSerp(serp) {
  const edges = serp?.edges || [];
  const out = [];
  for (const edge of edges) {
    if (edge?.node?.__typename !== "XDTTopSerpMediaGridUnit") continue;
    const items = edge.node.items || [];
    for (const item of items) {
      if (item?.__typename === "XDTMediaDict") out.push(item);
    }
  }
  return out;
}

// Find the rendered tile in the grid for a given shortcode. Mirrors the profile
// flow's `find_element_instagram_again_posts` (anchor lookup → closest div →
// scroll into view → poll for real media). Exact-match selector (`href="/p/<code>/"`)
// dodges accidental prefix collisions between codes.
function sfExploreFindElement(code, retries = 12, interval = 100) {
  return new Promise((resolve) => {
    const waiter = sfExploreRegisterWaiter(resolve);
    if (sfExploreStop.requested) {
      sfExploreSettle(waiter, null);
      return;
    }
    const tryFind = (attemptsLeft) => {
      if (waiter.settled) return;
      const anchor =
        document.querySelector(`a[href="/p/${code}/"]`) ||
        document.querySelector(`a[href*="/p/${code}/"]`);
      if (anchor) {
        const parentDiv = anchor.closest("div");
        parentDiv?.scrollIntoView({ behavior: "auto", block: "center" });

        const isRealUrl = (u) => u && !u.startsWith("data:image/gif");
        const hasVisualMedia = () => {
          const img = parentDiv?.querySelector("img[src]");
          const imgUrl = img?.getAttribute("src") || "";
          // New IG search tiles render reels as autoplay <video> elements (not
          // just <img>), so detect those too — otherwise every video tile
          // burned the full retry budget waiting for an image that never came.
          const video = parentDiv?.querySelector("video[src], video source[src]");
          const videoUrl = video?.getAttribute("src") || "";
          const bgDiv = parentDiv?.querySelector('[style*="background-image"]');
          const bgUrl =
            bgDiv?.style?.backgroundImage?.match(/url\(["']?(.*?)["']?\)/)?.[1] || "";
          return isRealUrl(imgUrl) || isRealUrl(videoUrl) || isRealUrl(bgUrl);
        };

        const checkMediaLoaded = () => {
          if (waiter.settled) return;
          if (hasVisualMedia()) {
            sfExploreSettle(waiter, parentDiv);
          } else if (retries-- > 0) {
            waiter.timer = setTimeout(checkMediaLoaded, interval);
          } else {
            sfExploreSettle(waiter, parentDiv);
          }
        };

        if (hasVisualMedia()) {
          sfExploreSettle(waiter, parentDiv);
        } else {
          waiter.timer = setTimeout(checkMediaLoaded, 200);
        }
      } else if (attemptsLeft > 0) {
        waiter.timer = setTimeout(() => tryFind(attemptsLeft - 1), interval);
      } else {
        sfExploreSettle(waiter, null);
      }
    };
    tryFind(retries);
  });
}

// Search results come back in relevance order, so "oldest" must sort by
// `taken_at` rather than reversing the input (which is what the profile flow
// does — that only works because profile feeds are chronological).
function sfExploreSortItems(data, sortBy) {
  if (sortBy === "likes") {
    return [...data].sort((a, b) => (b.likesCount ?? 0) - (a.likesCount ?? 0));
  }
  if (sortBy === "comments") {
    return [...data].sort((a, b) => (b.commentsCount ?? 0) - (a.commentsCount ?? 0));
  }
  if (sortBy === "oldest") {
    return [...data].sort((a, b) => {
      const ta = a.createDate ? Date.parse(a.createDate) : 0;
      const tb = b.createDate ? Date.parse(b.createDate) : 0;
      return ta - tb;
    });
  }
  // 'views' is blocked upstream; defensive return.
  return data;
}

function sfExploreReadTarget() {
  const raw = sessionStorage.getItem("sortFeedNoItems") || "";
  // "all_reels" is blocked upstream — defensive cap so a sort can still end.
  if (raw === "all_reels") return 10000;
  const n = parseInt(raw.replace("_reels", ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

function sfExploreNotifyBanner(count) {
  window.postMessage(
    { insta_banner_notification: true, count: count, type: "Posts" },
    "*",
  );
}

function sfExploreNotifyCollected(count) {
  window.postMessage(
    { item_collected_no: true, number_items: count },
    "*",
  );
}

function sfExploreRemoveBannerAndOverlay() {
  // Mirror the profile flow (script_instagram.js `remove_overlay()`): tear the
  // yellow backdrop down *synchronously* in the page world the instant sorting
  // finishes — before the render/scroll message is posted — so the teardown
  // reliably precedes the auto-scroll instead of racing it on the same async
  // beat (which read as "scroll, then banner clears"). The postMessage below
  // still runs the banner's slide-out dismissal in banner_on_insta.js.
  try {
    const ov = document.getElementById("overlay_sort_reels");
    if (ov) ov.remove();
  } catch (e) {}
  // banner_on_insta.js listens to this and clears both the in-page sort banner
  // and the loading overlay.
  window.postMessage({ insta_banner_notification_remove: true }, "*");
}

function sfExploreFinishSort() {
  sessionStorage.removeItem("sortFeedStopSorting");
  sessionStorage.removeItem("sortFeedStatus");
}

// Process one /graphql/query response. Accumulates into `sfExploreMemory` and
// resolves with the final array when the target is reached, the user clicks
// Stop, or IG has no more pages. Otherwise no-ops (returns null) and waits for
// the next XHR to roll in.
async function sfExploreProcessBatch(jsonResponse, nextPage, target) {
  const serp = jsonResponse?.data?.xdt_fbsearch__top_serp_graphql;
  const flatItems = sfExploreFlattenSerp(serp);
  if (SF_EXPLORE_DEBUG) {
    console.log(
      "[SortFeed][explore] batch — flat items:", flatItems.length,
      "next?:", nextPage, "target:", target,
    );
  }

  let added = 0;
  for (let i = 0; i < flatItems.length; i++) {
    if (!sessionStorage.getItem("sortFeedStatus")) {
      return sfExploreMemory.items;
    }

    // Stop owns the finish from here on — bail without returning items (the
    // express route already finalized; sfExploreStopNow is a no-op if so).
    if (sfExploreStopRequested()) { sfExploreStopNow(); return null; }

    const meta = sfExploreCreateMetadata(flatItems[i]);
    // Already collected on an earlier page: not counted twice.
    const seenKey = sfExploreSeenKey(meta);
    if (seenKey && sfExploreMemory.seen.has(seenKey)) continue;
    // By request: no scrolling, just the per-post beat (the card is built from data).
    const element = sfExploreReq.on ? await sfExploreWait(sfExploreReq.itemDelay) : await sfExploreFindElement(meta.code);

    // Checked BEFORE the item is saved: an aborted wait hands back a null
    // element, and saving that would paint a blank tile.
    if (sfExploreStopRequested()) { sfExploreStopNow(); return null; }

    meta.element = sfExploreDataCards() && (meta.gridThumbUrl || meta.thumbnailUrl) ? null : element?.outerHTML;
    const items = sfExploreSaveLocally(meta);
    added++;

    sfExploreNotifyCollected(items.length);
    sfExploreNotifyBanner(items.length);

    if (sessionStorage.getItem("sortFeedStopSorting") === "on") {
      sfExploreFinishSort();
      return items;
    }

    if (items.length >= target) {
      sfExploreFinishSort();
      return items;
    }
  }

  // End of this batch + no further pages → finalize with what we have.
  if (!nextPage) {
    sfExploreFinishSort();
    return sfExploreMemory.items;
  }

  // Still expecting more pages. By request: ask for the next one ourselves.
  if (sfExploreReq.on) {
    // "More" with no cursor, or page after page of posts we already have: done.
    sfExploreReq.emptyPages = added ? 0 : sfExploreReq.emptyPages + 1;
    if (!sfExploreReq.cursor || sfExploreReq.emptyPages >= SF_EXPLORE_EMPTY_PAGES) {
      sfExploreFinishSort();
      return sfExploreMemory.items;
    }
    sfExploreReqNextPage();
    return null;
  }

  // Scrolling — wait for Instagram's next page.
  return null;
}

// Once a sort completes we must never finalize again — a second
// `logo_animate_off` would re-render the banner *after* the content script has
// cleared `sortFeedSortBy` / `sortItemsVsDates`, producing an "undefined"
// banner. `sfExploreDone` latches completion; `sfExploreChain` serializes
// per-page batches so two graphql responses can't process concurrently and
// both reach the target. Both reset naturally — every sort reloads the page.
let sfExploreDone = false;
let sfExploreChain = Promise.resolve();

// True once the SERP reports no next page — the whole result set is in hand, so
// a later re-sort of ANY size is already covered.
let sfExploreFeedExhausted = false;

// Single exit point — the natural completion chain AND the Stop express route
// both come through here, and `sfExploreDone` guarantees only the first one
// renders.
function sfExploreFinalize(items) {
  if (sfExploreDone) return;
  sfExploreDone = true;
  sfExploreFinishSort();

  const list = Array.isArray(items) ? items : [];

  // Stopped before a single tile finished capturing — nothing to render, so
  // leave IG's own results alone and just clear our chrome.
  if (!list.length) {
    sfExploreRemoveBannerAndOverlay();
    return;
  }

  const sortBy = sessionStorage.getItem("sortFeedSortBy");
  const sorted = sfExploreSortItems(list, sortBy);

  if (SF_EXPLORE_DEBUG) {
    console.log(
      "[SortFeed][explore] sort complete —",
      sorted.length, "items, sorted by", sortBy,
    );
  }

  // Sort context for back-to-back re-sorting (see resort_instagram.js). Built
  // BEFORE the banner/finish teardown clears the keys it reads. Search blocks
  // date filters entirely, so this is always an items-mode record. `search` is
  // recorded too — the keyword lives in ?q=, so two different searches share a
  // pathname and must not be mistaken for each other.
  const sfCtx = {
    mode: "items",
    selection: sessionStorage.getItem("sortFeedNoItems"),
    sortBy: sortBy,
    tab: "Posts",
    surface: "explore_search",
    path: location.pathname,
    search: location.search,
    collectedCount: list.length,
    deepestSeenMs: null,   // dates are blocked here — no coverage question to answer
    feedExhausted: sfExploreFeedExhausted,
    stoppedByUser: sfExploreStopRequested(),
    outlier: null,
  };

  // Collecting is over: the tab title's ✓ and the line move on now
  // (banner_on_insta.js); a background tab draws its grid at once, motion off.
  window.postMessage({ sf_sort_collected: { count: sorted.length } }, "*");
  if (document.hidden && typeof _sfInstantMode === "function") _sfInstantMode();
  sfExploreRemoveBannerAndOverlay();

  window.postMessage(
    {
      logo_animate_off: true,
      payload: sorted,
      sf_surface: "explore_search",
      sf_ctx: sfCtx,
    },
    "*",
  );
}

// IG used to fire the search SERP over /graphql/query, but as of the current
// build the PolarisKeywordSearchExplorePageRelayQuery POSTs to /api/graphql
// instead. Match both so we catch the response on whichever endpoint IG uses.
// The xdt_fbsearch__top_serp_graphql response-key check in sfExploreDispatch
// filters out the many unrelated queries that also hit /api/graphql.
function sfExploreIsGraphqlUrl(url) {
  if (!url) return false;
  return url.includes("/graphql/query") || url.includes("/api/graphql");
}

// Shared dispatch — parses a GraphQL response body and, if it carries the
// search SERP, queues it onto the per-page chain. Used by both the XHR and
// fetch wraps so whichever transport IG uses, the same logic runs.
function sfExploreDispatch(responseText, url, transport) {
  if (sfExploreDone) return;

  const surface = sessionStorage.getItem("sortFeedSurface");
  const status = sessionStorage.getItem("sortFeedStatus");

  if (surface !== "explore_search") return;
  if (!status) return;
  if (!sfExploreIsGraphqlUrl(url)) return;

  let jsonResponse;
  try {
    jsonResponse = JSON.parse(responseText);
  } catch (e) {
    if (SF_EXPLORE_DEBUG) {
      console.warn("[SortFeed][explore][" + transport + "] JSON.parse failed:", e);
    }
    return;
  }

  const serp = jsonResponse?.data?.xdt_fbsearch__top_serp_graphql;
  if (!serp) {
    if (SF_EXPLORE_DEBUG) {
      console.log(
        "[SortFeed][explore][" + transport + "] no SERP key on this response.",
        "data keys:", Object.keys(jsonResponse?.data || {}),
      );
    }
    return;
  }

  const edges = serp?.edges || [];
  if (SF_EXPLORE_DEBUG) {
    console.log(
      "[SortFeed][explore][" + transport + "] SERP found —",
      "edges:", edges.length,
      "edge typenames:", edges.map((e) => e?.node?.__typename),
      "has_next_page:", serp?.page_info?.has_next_page,
    );
  }

  sfExploreHandleSerp(jsonResponse, transport);
}

// One page of search results, from Instagram's own request ("xhr" / "fetch") or ours ("request").
function sfExploreHandleSerp(jsonResponse, source) {
  if (sfExploreDone) return;
  // Collecting by request: Instagram's own later pages (if it fetches any) are
  // not ours to count — only page 1 and the pages we ask for.
  if (sfExploreReq.on && source !== "request") return;
  // The line: the first page waits for this tab's turn.
  if (!sfExploreGatePass(jsonResponse, source)) return;
  if (sfExploreReqLearning(jsonResponse, source)) return;
  sfExploreReqPageArrived(jsonResponse);

  const serp = jsonResponse?.data?.xdt_fbsearch__top_serp_graphql;
  const nextPage = !!serp?.page_info?.has_next_page;
  sfExploreFeedExhausted = !nextPage; // reflects the latest page — see sfCtx
  const target = sfExploreReadTarget();

  // Queue this page behind any in-flight batch so they run one at a time.
  sfExploreChain = sfExploreChain
    .then(() => (sfExploreDone ? null : sfExploreProcessBatch(jsonResponse, nextPage, target)))
    .then((items) => {
      if (!items || sfExploreDone) return; // batch consumed, waiting for next page
      sfExploreFinalize(items);
    })
    .catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Search by request (new-sort-logic Phase 7, the profile's Phase 3)
//
// Page 1 is still Instagram's own (the search page fetches it as it loads); every
// page after that is asked for directly through the agent runner's search pager
// (window.__sfIgSearchPager: Instagram's own GraphQL request again, with the next
// cursor) — paced by the profile's clock (_sfReqGap in script_instagram.js: same
// pace, same pauses, the line's slowdown). The cards are built from data, so
// nothing has to be on screen and the page stays still. Hidden tabs keep time
// through the background clock (sf_req_wait), like profiles.
//
// Falls back to scrolling when the pager isn't ready or the first request of
// ours fails for any reason but a refusal (localStorage sfRequestSortIG = "0"
// forces scrolling). A refusal from Instagram (429, security check, login wall)
// stops the sort, shows what was collected and stops the line.
// ─────────────────────────────────────────────────────────────────────────────
const sfExploreReq = {
  decided: false, on: false, cursor: null, inflight: false,
  nextAt: 0, itemDelay: 0, okPages: 0, emptyPages: 0, error: null, fellBack: null,
};
const SF_EXPLORE_REFUSED = ["THROTTLED", "CHECKPOINT", "LOGGED_OUT", "AUTH"];
const SF_EXPLORE_EMPTY_PAGES = 3; // pages in a row that add nothing new → the search has run dry

function sfExploreOn() {
  return sessionStorage.getItem("sortFeedSurface") === "explore_search";
}
// The keyword being searched, from the address (?q=).
function sfExploreQuery() {
  try { return (new URLSearchParams(location.search).get("q") || "").trim(); } catch (e) { return ""; }
}
function sfExploreDataCards() {
  try { return localStorage.getItem("sfDataTilesIG") !== "0"; } catch (e) { return true; }
}
function sfExploreReqAllowed() {
  if (!sfExploreOn() || !sfExploreQuery()) return false;
  try { if (localStorage.getItem("sfRequestSortIG") === "0") return false; } catch (e) {}
  return sfExploreDataCards(); // copied cards need the page to scroll past every card
}
function sfExploreReqUsable() {
  if (!sfExploreReqAllowed()) return false;
  const p = window.__sfIgSearchPager;
  return !!(p && p.ready(sfExploreQuery()));
}
// The request is learnt from Instagram's own page 1 — the same answer this file
// is reading, a moment later (the agent runner's wrap sits outside ours). So when
// page 1 lands here the pager isn't ready yet, and the page waits a few beats for it.
const SF_EXPLORE_LEARN_MS = 100, SF_EXPLORE_LEARN_TRIES = 5;
let sfExploreLearnTries = 0;
function sfExploreReqLearning(json, source) {
  if (sfExploreReq.decided || sfExploreLearnTries >= SF_EXPLORE_LEARN_TRIES) return false;
  if (!sfExploreReqAllowed()) return false;
  const p = window.__sfIgSearchPager;
  if (!p || p.ready(sfExploreQuery())) return false;
  sfExploreLearnTries++;
  setTimeout(() => sfExploreHandleSerp(json, source), SF_EXPLORE_LEARN_MS);
  return true;
}

// A page arrived (Instagram's page 1, or one we asked for): settle the mode on
// the first one, note the cursor, and set this page's pace.
function sfExploreReqPageArrived(json) {
  if (!sfExploreReq.decided) {
    sfExploreReq.decided = true;
    sfExploreReq.on = sfExploreReqUsable();
  }
  const serp = json?.data?.xdt_fbsearch__top_serp_graphql;
  const info = serp?.page_info;
  sfExploreReq.cursor = info?.has_next_page ? info.end_cursor || null : null;
  if (!sfExploreReq.on) return;
  const n = sfExploreFlattenSerp(serp).length;
  const gap = typeof _sfReqGap === "function" ? _sfReqGap() : 2200;
  sfExploreReq.nextAt = performance.now() + gap;
  sfExploreReq.itemDelay = Math.min(160, gap / Math.max(1, n));
}

// A Stop-aware wait; in a hidden tab the background service worker keeps the
// time (Chrome throttles a hidden page's own timers), relayed by
// banner_on_insta.js (sf_req_wait → SF_SORT_WAIT → sf_req_waited).
let sfExploreWaitSeq = 0;
function sfExploreWait(ms) {
  if (!(ms > 0)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiter = sfExploreRegisterWaiter(resolve);
    if (sfExploreStop.requested) { sfExploreSettle(waiter, null); return; }
    if (!document.hidden) { waiter.timer = setTimeout(() => sfExploreSettle(waiter, null), ms); return; }
    const id = "explore-" + ++sfExploreWaitSeq;
    const onMsg = (ev) => {
      if (ev.source !== window || !ev.data || ev.data.sf_req_waited !== id) return;
      window.removeEventListener("message", onMsg);
      sfExploreSettle(waiter, null);
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ sf_req_wait: { id, ms: Math.round(ms) } }, "*");
    waiter.timer = setTimeout(() => { window.removeEventListener("message", onMsg); sfExploreSettle(waiter, null); }, ms + 10000);
  });
}

// Wait out this page's pace, then ask for the next page and feed it in.
async function sfExploreReqNextPage() {
  if (sfExploreReq.inflight || !sfExploreReq.cursor) return;
  sfExploreReq.inflight = true;
  try {
    await sfExploreWait(sfExploreReq.nextAt - performance.now());
    if (sfExploreStopRequested() || sfExploreDone) return;
    if (!sessionStorage.getItem("sortFeedStatus")) return;
    const json = await window.__sfIgSearchPager.page(sfExploreQuery(), sfExploreReq.cursor);
    if (sfExploreStopRequested() || sfExploreDone) return;
    if (!json?.data?.xdt_fbsearch__top_serp_graphql) { const e = new Error("not a search page"); e.code = "SHAPE"; throw e; }
    sfExploreReq.okPages++;
    window.postMessage({ sf_line_page: true }, "*"); // the line counts it; may answer with a slowdown
    sfExploreReq.inflight = false;
    sfExploreHandleSerp(json, "request");
  } catch (e) {
    sfExploreReqFail(e);
  } finally {
    sfExploreReq.inflight = false;
  }
}

function sfExploreReqFail(e) {
  const code = (e && e.code) || "ERROR";
  sfExploreReq.error = code;
  if (SF_EXPLORE_DEBUG) console.log("[SortFeed][explore] request failed", code, e && e.message);
  if (sfExploreStopRequested() || sfExploreDone) return;
  // Nothing of ours has arrived yet: Instagram's own paging is still on page 1,
  // so scrolling picks up exactly where we are — unless Instagram refused.
  if (sfExploreReq.okPages === 0 && !SF_EXPLORE_REFUSED.includes(code)) {
    sfExploreReq.on = false;
    sfExploreReq.fellBack = code;
    sfExploreNudgeLoadMore();
    return;
  }
  if (SF_EXPLORE_REFUSED.includes(code)) window.postMessage({ sf_line_refused: { code } }, "*");
  sfExploreStopNow(); // show what was collected, the same as Stop
}

// Scrolling fallback: bring the last rendered result into view so Instagram
// fetches its next page (the by-request pages never moved the page).
function sfExploreNudgeLoadMore() {
  const anchors = document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]');
  const last = anchors[anchors.length - 1];
  if (!last) return;
  (last.closest("div") || last).scrollIntoView({ behavior: "auto", block: "end" });
}

// ── The line: Instagram's page 1 waits for this tab's turn ──
// Same handshake as the profile's _sfLineGate (script_instagram.js): the banner
// says sf_line_hold when this tab has to wait and sf_line_go on its turn; with no
// answer within SF_EXPLORE_LINE_ANSWER_MS (an older banner, no line) it goes ahead.
const SF_EXPLORE_LINE_ANSWER_MS = 4000;
const sfExploreGate = { go: false, held: null, holdSeen: false, timer: null };

function sfExploreGatePass(json, source) {
  if (sfExploreGate.go || source === "request") return true;
  if (!sfExploreGate.held) sfExploreGate.held = { json, source };
  if (sfExploreGate.timer || sfExploreGate.holdSeen) return false;
  sfExploreGate.timer = setTimeout(() => {
    sfExploreGate.timer = null;
    if (!sfExploreGate.holdSeen) sfExploreGateGo();
  }, SF_EXPLORE_LINE_ANSWER_MS);
  return false;
}
function sfExploreGateGo() {
  if (sfExploreGate.go) return;
  sfExploreGate.go = true;
  clearTimeout(sfExploreGate.timer);
  sfExploreGate.timer = null;
  const held = sfExploreGate.held;
  sfExploreGate.held = null;
  if (held) sfExploreHandleSerp(held.json, held.source);
}
window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data) return;
  if (!sfExploreOn()) return;
  if (event.data.sf_line_go) sfExploreGateGo();
  else if (event.data.sf_line_hold) { sfExploreGate.holdSeen = true; clearTimeout(sfExploreGate.timer); sfExploreGate.timer = null; }
});

// Test hook (tests/search_request_harness.mjs).
window.__sfExploreReqState = () => ({ ...sfExploreReq, items: sfExploreMemory.items.length, done: sfExploreDone });

// XHR wrap — handles the case where IG uses XMLHttpRequest for the search
// GraphQL query. Leaves profile sorts to script_instagram.js (which gates on
// `sortFeedSurface !== "explore_search"`).
(function () {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
    this._sfExploreUrl = url;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener("load", function () {
      // Only text/"" XHRs expose responseText; skip blob/json/arraybuffer.
      if (this.responseType !== "" && this.responseType !== "text") return;
      sfExploreDispatch(this.responseText, this._sfExploreUrl, "xhr");
    });
    return originalSend.apply(this, arguments);
  };
})();

// Fetch wrap — modern IG code paths increasingly use fetch() for GraphQL.
// If the search response arrives via fetch, the XHR wrap above never fires, so
// this is the path that actually catches it on the current IG build.
(function () {
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const fetchPromise = originalFetch.apply(this, args);

    let url = "";
    try {
      const req = args[0];
      url = typeof req === "string" ? req : (req && req.url) || "";
    } catch (e) {}

    if (!sfExploreIsGraphqlUrl(url)) return fetchPromise;
    // Stay completely dormant outside an explore-search sort — don't clone /
    // read unrelated GraphQL responses during profile or saved sorts.
    if (sessionStorage.getItem("sortFeedSurface") !== "explore_search") return fetchPromise;

    fetchPromise
      .then((response) => {
        try {
          response
            .clone()
            .text()
            .then((text) => sfExploreDispatch(text, url, "fetch"))
            .catch((e) => {
              if (SF_EXPLORE_DEBUG) {
                console.warn("[SortFeed][explore][fetch] text() failed:", e);
              }
            });
        } catch (e) {
          if (SF_EXPLORE_DEBUG) {
            console.warn("[SortFeed][explore][fetch] clone failed:", e);
          }
        }
      })
      .catch(() => {});

    return fetchPromise;
  };
})();
