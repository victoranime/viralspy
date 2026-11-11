// ─────────────────────────────────────────────────────────────────────────────
// Sort Feed — Agent mode runner (Instagram, MAIN world)
//
// Collect-only sort for jobs that arrive from Claude (via the MCP bridge), as
// opposed to the scroll-driven sort a user clicks in the popup. Nothing here
// touches the grid: it replays the same next-page GraphQL request Instagram
// fires on scroll, walks the cursor, parses each page with the parsers in
// script_instagram.js, sorts with sort_items(), scores outliers with the same
// rules as _sfOutlier*, and hands the rows back to the content-script bridge.
//
// Runs in the MAIN world (listed right after script_instagram.js in the
// manifest) so it can call those parsers directly and read the page's own
// session tokens. Works while the tab is hidden — no scrolling, no drawing.
//
// Protocol (window.postMessage, same window):
//   bridge → runner   { sf_agent_job: { jobId, username, surface, depth, sortBy, outlier } }
//   runner → banner   { insta_banner_notification, count, type }   (banner_on_insta.js renders)
//                     { sf_outlier_analyzing, count, progress }      (pool mode)
//                     { insta_banner_notification_remove }
//   banner → runner   { sf_stop_sorting }                            (Stop button)
//   runner → bridge   { sf_agent_result: { jobId, ok, rows, outlier, stopped, requests, ms, error? } }
//
// Safety: Instagram's own page size, human-shaped pacing, hard depth cap, stop
// cold on the first 429 / challenge / login wall. Read-only. Tokens are read
// from the live page at request time and never persisted or sent anywhere.
// Passive capture stores only the two doc_ids (per surface) in localStorage so
// a rotation heals itself the next time the user browses normally.
//
// Search (Sort Feed 16.7): a job with { kind: "search", query } runs on Instagram's
// keyword-search page. There is no hand-written template for that request — the
// page's own first request teaches it (query id, friendly name, variables, which
// fields hold the keyword and the cursor), its answer is page 1, and the runner
// replays it for the pages after that. `window.__sfAgentSearchDiag()` in the page
// console shows what was learnt.
//
// Saved (16.7): { kind: "saved", saved: "all_posts" } runs on /<viewer>/saved/all-posts/.
// Same idea: the page's own first REST request (method, address, headers) is
// remembered for this page load, its answer is page 1, and later pages ask the
// same request again with max_id. Never cached upstream — it's the user's own feed.
// A saved collection ({ saved: "collection", collection: { id, slug, name } }) runs on
// /<viewer>/saved/<slug>/<id>/ and is GraphQL, learnt like Search from the page's
// own first request; comment counts are reliable there, so comments sort too.
// ─────────────────────────────────────────────────────────────────────────────
(() => {
  if (window.__sfAgentRunnerLoaded) return;
  window.__sfAgentRunnerLoaded = true;

  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log("[sf-agent]", ...a); };

  const CFG = {
    FIRST: 12,                     // IG's own page size for both tabs
    DEPTH_CEILING: 10000,          // supports "All Posts" scans up to 10,000 items
    IG_APP_ID: "936619743392459",
    ASBD_ID: "359341",
    GAP_BASE_MIN_MS: 700,          // human-shaped pacing — see pacing note in the plan
    GAP_BASE_MAX_MS: 1500,
    GAP_LONG_EVERY: 8,
    GAP_LONG_MIN_MS: 2500,
    GAP_LONG_MAX_MS: 4000,
    REQUEST_TIMEOUT_MS: 20000,
    TEMPLATE_KEY: "sfAgentTemplates",
  };

  // Outlier rules — read the extension's constants when present (script_instagram.js),
  // else the same values.
  const OUT = {
    MIN_AGE_MS: typeof SF_OUTLIER_MIN_AGE_MS !== "undefined" ? SF_OUTLIER_MIN_AGE_MS : 72 * 60 * 60 * 1000,
    FLOOR: typeof SF_OUTLIER_FLOOR !== "undefined" ? SF_OUTLIER_FLOOR : 20,
    CAP: typeof SF_OUTLIER_CAP !== "undefined" ? SF_OUTLIER_CAP : 25,
    MAX_POOL_PAGES: typeof SF_OUTLIER_MAX_POOL_PAGES !== "undefined" ? SF_OUTLIER_MAX_POOL_PAGES : 40,
    MAX_POOL_MS: typeof SF_OUTLIER_MAX_POOL_MS !== "undefined" ? SF_OUTLIER_MAX_POOL_MS : 90 * 1000,
  };
  const PK_EPOCH = typeof IG_PK_EPOCH_MS !== "undefined" ? IG_PK_EPOCH_MS : 1314220021721;
  const pkMs = (pk) => { try { return Number((BigInt(pk) >> 23n) + BigInt(PK_EPOCH)); } catch { return NaN; } };
  const pkIso = (pk) => { const ms = pkMs(pk); return Number.isFinite(ms) ? new Date(ms).toISOString() : ""; };
  const bestThumb = (m) => { const c = m?.image_versions2?.candidates; if (!Array.isArray(c) || !c.length) return null; let b = null, w = -1; for (const x of c) if (x?.url && (x.width || 0) > w) { w = x.width; b = x.url; } return b; };
  // Smallest candidate that is still ≥ 300 px wide (else the smallest) — for inline cover frames in Claude.
  const smallThumb = (m) => { const c = (m?.image_versions2?.candidates || []).filter((x) => x?.url).sort((a, b) => (a.width || 0) - (b.width || 0)); if (!c.length) return null; return (c.find((x) => (x.width || 0) >= 300) || c[c.length - 1]).url; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // When a creator hides like counts, IG still sends like_count — a tiny placeholder (typically 3),
  // flagged by like_and_view_counts_disabled. Report "hidden" (null), never the placeholder.
  const hideLikes = (node, row) => { if (node && node.like_and_view_counts_disabled) { row.likesCount = null; row.likesHidden = true; } return row; };
  const bestVideo = (m) => {
    const v = m?.video_versions;
    if (Array.isArray(v) && v.length && v[0]?.url) return v[0].url;
    const cm = m?.carousel_media;
    if (Array.isArray(cm)) {
      for (const slide of cm) {
        if (Array.isArray(slide?.video_versions) && slide.video_versions[0]?.url) return slide.video_versions[0].url;
      }
    }
    return null;
  };
  const bestAudio = (m) => {
    const prog = m?.clips_metadata?.original_sound_info?.progressive_download_url;
    if (prog && /^https?:\/\//i.test(prog)) return prog;
    const dash = m?.video_dash_manifest;
    if (dash) {
      const mUrl = dash.match(/<AdaptationSet[^>]*contentType="audio"[^>]*>[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>/i)?.[1]?.replace(/&amp;/g, "&");
      if (mUrl) return mUrl;
    }
    return bestVideo(m);
  };
  const enrichMediaRow = (m, row) => {
    if (!row) return row;
    if (!row.caption) {
      const capText =
        m?.caption?.text ||
        m?.edge_media_to_caption?.edges?.[0]?.node?.text ||
        "";
      if (capText) row.caption = capText;
    }
    row.videoUrl = bestVideo(m);
    row.audioUrl = bestAudio(m);
    row.mediaId = m?.pk != null ? String(m.pk) : (row.reelID != null ? String(row.reelID) : (row.postID != null ? String(row.postID) : null));
    row.videoDuration = m?.video_duration ?? null;
    const createdMs = row.createDate ? Date.parse(row.createDate) : NaN;
    const ageHours = Number.isFinite(createdMs) ? Math.max(0.5, (Date.now() - createdMs) / 3600000) : null;
    row.ageHours = ageHours != null ? Number(ageHours.toFixed(2)) : null;
    const metricVal = row.viewCount ?? row.likesCount ?? null;
    row.viewsPerHour = ageHours != null && metricVal != null ? Number((+metricVal / ageHours).toFixed(2)) : null;
    return hideLikes(m, row);
  };

  // ── Surfaces ───────────────────────────────────────────────────────────────
  const SEARCH_ROOT = "xdt_fbsearch__top_serp_graphql";
  const SEARCH_UNLEARNT = "Sort Feed couldn't read Instagram's search request in this browser yet. Open instagram.com in that browser, search for any word once (the search box → Enter), then ask again.";
  const COLLECTION_ROOT = "fetch__MediaCollection";
  const COLLECTION_UNLEARNT = "Sort Feed couldn't read Instagram's collection request in this browser yet. Open that collection once on instagram.com in that browser (Saved → the collection), then ask again.";
  // A saved item in the Posts shape (All Posts and collections share it): the Saved code's own builder when present.
  const parseSavedMedia = (m) => {
    const row = typeof sfSavedCreateMetadata === "function" ? sfSavedCreateMetadata(m) : {
      createDate: m?.taken_at ? new Date(m.taken_at * 1000).toISOString() : pkIso(m?.pk), code: m?.code || "",
      commentsCount: m?.comment_count ?? null, likesCount: m?.like_count ?? null, mediaType: m?.media_type ?? null,
      viewCount: m?.play_count ?? m?.view_count ?? null, userName: m?.user?.username || m?.owner?.username || "", caption: m?.caption?.text || "",
      postID: m?.pk ?? null, thumbnailUrl: bestThumb(m),
    };
    row.carouselCount = m?.carousel_media_count ?? null;
    row.thumbnailSmallUrl = smallThumb(m);
    return enrichMediaRow(m, row);
  };
  // A collection page (GraphQL) in the REST shape the Saved code consumes: the Saved code's own normaliser when present.
  const normalizeCollection = (json) => {
    if (typeof sfSavedNormalizeGraphql === "function") return sfSavedNormalizeGraphql(json);
    const media = json?.data?.[COLLECTION_ROOT]?.media;
    if (!media || !Array.isArray(media.edges)) return null;
    const items = media.edges.map((e) => { let n = e?.node; if (n && n.media && n.media.pk) n = n.media; return n ? { media: n } : null; }).filter(Boolean);
    return { items, more_available: !!media.page_info?.has_next_page, next_max_id: media.page_info?.end_cursor || null };
  };
  const SURFACES = {
    reels: {
      key: "reels",
      label: "Reels",
      defaultDocId: "28817597357844655",
      friendly: "PolarisProfileReelsTabContentQuery_connection",
      rootField: "fetch__XDTUserDict",
      needsId: true,
      metricKey: "viewCount",
      variables: (ctx, after) => ({
        after: after ?? null,
        data: { include_feed_video: true, page_size: 12, target_user_id: String(ctx.id) },
        first: CFG.FIRST,
        id: String(ctx.id),
        __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
      }),
      connection: (json) => (typeof sfGetClipsConnection === "function" ? sfGetClipsConnection(json) : null)
        || json?.data?.xdt_api__v1__clips__user__connection_v2
        || json?.data?.fetch__XDTUserDict?.clips_connection || null,
      node: (edge) => edge?.node?.media,
      accept: (m) => m?.media_type === 2,
      parse: (m, username) => {
        const row = typeof createMetadataJsonReels === "function" ? createMetadataJsonReels(m) : {
          createDate: pkIso(m?.pk), viewCount: m?.play_count ?? m?.view_count ?? null, code: m?.code || "",
          commentsCount: m?.comment_count ?? null, likesCount: m?.like_count ?? null, mediaType: m?.media_type ?? null,
          reelID: m?.pk ?? null, pinned: !!(m?.clips_tab_pinned_user_ids?.length), thumbnailUrl: bestThumb(m),
        };
        row.userName = username;
        row.thumbnailSmallUrl = smallThumb(m);
        return enrichMediaRow(m, row);
      },
      poolRecord: (m) => (m && m.media_type === 2 ? {
        key: m.pk != null ? String(m.pk) : (m.code || m.id || null), dateMs: pkMs(m.pk),
        metricVal: m.play_count ?? m.view_count ?? null,
        pinned: !!(m.clips_tab_pinned_user_ids && m.clips_tab_pinned_user_ids.length > 0),
      } : null),
    },
    posts: {
      key: "posts",
      label: "Posts",
      defaultDocId: "38491138490501953",
      friendly: "PolarisProfilePostsTabContentQuery_connection",
      rootField: "xdt_api__v1__feed__user_timeline_graphql_connection",
      needsId: false,
      metricKey: "likesCount",
      variables: (ctx, after) => ({
        after: after ?? null, before: null,
        data: { count: 12, include_reel_media_seen_timestamp: true, include_relationship_info: true, latest_besties_reel_media: true, latest_reel_media: true },
        first: CFG.FIRST, include_multi_captions: false, last: null, username: ctx.username,
        __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: false,
        __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true,
        __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false,
        __relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider: false,
        __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
      }),
      connection: (json) => json?.data?.xdt_api__v1__feed__user_timeline_graphql_connection || null,
      node: (edge) => edge?.node,
      accept: () => true,
      parse: (n, username) => {
        const row = typeof createMetadataJson === "function" ? createMetadataJson(n) : {
          createDate: n?.taken_at ? new Date(n.taken_at * 1000).toISOString() : "", code: n?.code || "",
          commentsCount: n?.comment_count ?? null, likesCount: n?.like_count ?? null, mediaType: n?.media_type ?? null,
          viewCount: n?.view_count ?? null, userName: n?.user?.username || "", caption: n?.caption?.text || "",
          postID: n?.pk ?? null, pinned: !!(n?.timeline_pinned_user_ids?.length), thumbnailUrl: bestThumb(n),
        };
        if (!row.userName) row.userName = username;
        row.carouselCount = n?.carousel_media_count ?? null;
        row.productType = n?.product_type ?? null;
        row.thumbnailSmallUrl = smallThumb(n);
        return enrichMediaRow(n, row);
      },
      poolRecord: (n) => (n ? {
        key: n.pk != null ? String(n.pk) : (n.code || n.id || null),
        dateMs: n.taken_at ? n.taken_at * 1000 : pkMs(n.pk),
        metricVal: n.like_and_view_counts_disabled ? null : (n.like_count ?? null),   // hidden likes can't feed the Posts baseline
        pinned: !!(n.timeline_pinned_user_ids && n.timeline_pinned_user_ids.length > 0),
      } : null),
    },
    // The signed-in user's own saved posts (Saved › All Posts): a REST feed, newest saved first, from any creator.
    // Rows take the Posts shape; the export drops Comments (Instagram sends none here) and adds Views (reels only).
    saved: {
      key: "saved",
      label: "Posts",
      rest: true,
      metricKey: "likesCount",
      page: (json) => (json && Array.isArray(json.items)
        ? {
          nodes: typeof sfSavedFlattenItems === "function" ? sfSavedFlattenItems(json) : json.items.map((it) => it && it.media).filter((m) => m && m.pk && m.code),
          hasNext: !!json.more_available,
          after: json.next_max_id || null,
        }
        : null),
      accept: (m) => !!(m && m.code),
      parse: (m) => parseSavedMedia(m),
      poolRecord: () => null,
    },
    // A saved collection: GraphQL (PolarisSavedCollectionPageWWWQuery → fetch__MediaCollection), newest saved first, from
    // any creator. Learnt from the collection page's own first request; page 1 is that request's answer.
    collection: {
      key: "collection",
      label: "Posts",
      defaultDocId: null,
      friendly: null,
      rootField: COLLECTION_ROOT,
      needsId: false,
      metricKey: "likesCount",
      url: () => readTemplates().collection?.url || "https://www.instagram.com/api/graphql",
      variables: (ctx, after) => {
        const t = readTemplates().collection;
        if (!t || !t.variables || typeof t.variables !== "object") throw new StopError("SHAPE", COLLECTION_UNLEARNT);
        const vars = JSON.parse(JSON.stringify(t.variables));
        if (String(t.collectionId || "") !== String(ctx.collectionId || "")) {   // learnt on another collection: swap the id in
          if (!t.idPath) throw new StopError("SHAPE", COLLECTION_UNLEARNT);
          setAt(vars, t.idPath, String(ctx.collectionId));
        }
        setAt(vars, t.cursorPath || ["after"], after ?? null);
        return vars;
      },
      page: (json) => {
        const norm = normalizeCollection(json);
        if (!norm) return null;
        const nodes = typeof sfSavedFlattenItems === "function" ? sfSavedFlattenItems(norm) : (norm.items || []).map((it) => it && it.media).filter((m) => m && m.pk && m.code);
        return { nodes, hasNext: !!norm.more_available, after: norm.next_max_id || null };
      },
      accept: (m) => !!(m && m.code),
      parse: (m) => parseSavedMedia(m),
      poolRecord: () => null,
    },
    // Instagram keyword search: posts and reels from many creators, in Instagram's own result order. Rows take the
    // Posts shape (the Profile column carries each creator), like the popup's Search sort. No views, no baseline.
    search: {
      key: "search",
      label: "Posts",
      defaultDocId: null,            // learnt from the search page's own request (learnSearch) — never guessed
      friendly: null,
      rootField: SEARCH_ROOT,
      needsId: false,
      metricKey: "likesCount",
      url: () => readTemplates().search?.url || "https://www.instagram.com/graphql/query",
      variables: (ctx, after) => {
        const t = readTemplates().search;
        if (!t || !t.variables || typeof t.variables !== "object") throw new StopError("SHAPE", SEARCH_UNLEARNT);
        const vars = JSON.parse(JSON.stringify(t.variables));
        if (!sameQ(t.q, ctx.query)) {                          // learnt on another keyword: swap it in, if we know where it lives
          if (!t.queryPath) throw new StopError("SHAPE", SEARCH_UNLEARNT);
          setAt(vars, t.queryPath, ctx.query);
        }
        setAt(vars, t.cursorPath || ["after"], after ?? null);
        return vars;
      },
      connection: (json) => json?.data?.[SEARCH_ROOT] || null,   // { edges: [grid units], page_info }
      items: (conn) => (typeof sfExploreFlattenSerp === "function" ? sfExploreFlattenSerp(conn) : flattenSerp(conn)),
      node: (e) => e,
      accept: (m) => !!(m && m.code),
      parse: (m, _username) => {
        const row = typeof sfExploreCreateMetadata === "function" ? sfExploreCreateMetadata(m) : {
          createDate: m?.taken_at ? new Date(m.taken_at * 1000).toISOString() : pkIso(m?.pk), code: m?.code || "",
          commentsCount: m?.comment_count ?? null, likesCount: m?.like_count ?? null, mediaType: m?.media_type ?? null,
          viewCount: m?.view_count ?? null, userName: m?.user?.username || "", caption: m?.caption?.text || "",
          postID: m?.pk ?? null, thumbnailUrl: bestThumb(m),
        };
        row.carouselCount = m?.carousel_media_count ?? null;
        row.thumbnailSmallUrl = smallThumb(m);
        return enrichMediaRow(m, row);
      },
      poolRecord: () => null,
    },
  };

  // One shape for a page of any surface: the media nodes plus whether and where the feed continues.
  function pageOf(S, json) {
    if (S.page) return S.page(json);
    const conn = S.connection(json);
    if (!conn) return null;
    const nodes = S.items ? S.items(conn) : (conn.edges || []).map(S.node);
    return { nodes, hasNext: !!conn.page_info?.has_next_page, after: conn.page_info?.end_cursor || null };
  }

  // ── Passive capture (self-healing templates) ───────────────────────────────
  // Profiles: ONLY { docId, capturedAt } per surface from IG's own requests during
  // normal browsing. No tokens, no bodies persisted.
  // Search: the whole request shape, learnt from any response that carries the
  // search root field — the page's own first request on a search page load, or a
  // search the user runs by hand. Variables are kept (they hold the keyword and a
  // cursor, nothing secret); the page tokens are still read live at request time.
  function readTemplates() { try { return JSON.parse(localStorage.getItem(CFG.TEMPLATE_KEY) || "{}"); } catch { return {}; } }
  function docIdFor(S) {
    const t = readTemplates()[S.key];
    return t?.docId || S.defaultDocId;
  }
  const learnt = (S) => S.defaultDocId === null;   // search, collection: no hand-written request, the page teaches it
  const friendlyOf = (S) => (learnt(S) ? readTemplates()[S.key]?.friendly || S.friendly : S.friendly);
  const rootFieldOf = (S) => (learnt(S) ? readTemplates()[S.key]?.rootField || S.rootField : S.rootField);

  const isGraphqlUrl = (u) => typeof u === "string" && (u.includes("/graphql/query") || u.includes("/api/graphql"));
  const search = { pages: [], waiters: [] };   // SERP pages seen on this page load: { q, after, json, at }
  const pageQuery = () => { try { return (new URLSearchParams(location.search).get("q") || "").trim(); } catch { return ""; } };
  const norm = (v) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();
  const sameQ = (a, b) => norm(a) === norm(b);
  const CURSOR_KEYS = ["after", "cursor", "end_cursor", "max_id", "next_max_id"];
  function findPath(obj, pred, path = []) {   // first [key, …] whose (key, value) satisfies pred, depth-first
    if (!obj || typeof obj !== "object") return null;
    for (const [k, v] of Object.entries(obj)) {
      if (pred(k, v)) return [...path, k];
      if (v && typeof v === "object") { const p = findPath(v, pred, [...path, k]); if (p) return p; }
    }
    return null;
  }
  const getAt = (o, p) => (p || []).reduce((a, k) => (a == null ? undefined : a[k]), o);
  function setAt(o, p, v) { let a = o; for (let i = 0; i < p.length - 1; i++) { if (a[p[i]] == null || typeof a[p[i]] !== "object") a[p[i]] = {}; a = a[p[i]]; } a[p[p.length - 1]] = v; }
  function formParams(body) {
    try {
      if (typeof body === "string") return new URLSearchParams(body);
      if (body instanceof URLSearchParams) return body;
      if (typeof FormData !== "undefined" && body instanceof FormData) { const p = new URLSearchParams(); body.forEach((v, k) => { if (typeof v === "string") p.set(k, v); }); return p; }
    } catch {}
    return null;
  }
  function headerOf(h, name) {
    try {
      if (!h) return null;
      if (typeof Headers !== "undefined" && h instanceof Headers) return h.get(name);
      if (Array.isArray(h)) { const hit = h.find(([k]) => String(k).toLowerCase() === name); return hit ? hit[1] : null; }
      for (const k of Object.keys(h)) if (k.toLowerCase() === name) return h[k];
    } catch {}
    return null;
  }
  function flattenSerp(serp) {
    const out = [];
    for (const e of serp?.edges || []) {
      if (e?.node?.__typename !== "XDTTopSerpMediaGridUnit") continue;
      for (const it of e.node.items || []) if (it?.__typename === "XDTMediaDict") out.push(it);
    }
    return out;
  }

  function learnSearch(url, headers, body, text) {
    if (typeof text !== "string" || text.indexOf(SEARCH_ROOT) === -1) return;
    const params = formParams(body);
    const rawVars = params && params.get("variables");
    if (!rawVars) return;
    let vars, json;
    try { vars = JSON.parse(rawVars); json = JSON.parse(text.replace(/^for \(;;\);/, "")); } catch { return; }
    const serp = json && json.data && json.data[SEARCH_ROOT];
    if (!serp || !vars || typeof vars !== "object") return;
    const q = pageQuery();
    const cursorPath = findPath(vars, (k, v) => CURSOR_KEYS.includes(k) && (v === null || typeof v === "string")) || ["after"];
    const after = getAt(vars, cursorPath) ?? null;
    const queryPath = q ? findPath(vars, (k, v) => typeof v === "string" && sameQ(v, q)) : null;
    const all = readTemplates();
    const prev = all.search || {};
    all.search = {
      docId: params.get("doc_id") || prev.docId || null,
      friendly: params.get("fb_api_req_friendly_name") || prev.friendly || null,
      rootField: headerOf(headers, "x-root-field-name") || prev.rootField || SEARCH_ROOT,
      url: String(url).includes("/api/graphql") ? "https://www.instagram.com/api/graphql" : "https://www.instagram.com/graphql/query",
      variables: vars, q: q || prev.q || null, queryPath: queryPath || prev.queryPath || null, cursorPath, capturedAt: Date.now(),
    };
    try { localStorage.setItem(CFG.TEMPLATE_KEY, JSON.stringify(all)); } catch {}
    search.pages.push({ q, after, json, at: Date.now() });
    search.waiters = search.waiters.filter((w) => !w());
    log("search: learnt", all.search.friendly, "cursor at", cursorPath.join("."), "query at", (all.search.queryPath || []).join(".") || "?");
  }

  // Saved › All Posts: Instagram's own request for the feed, seen on this page load (the saved page fetches page 1
  // by itself). Kept in memory only — it carries the session's request headers, which are read live and never stored.
  const isSavedUrl = (u) => typeof u === "string" && u.includes("/api/v1/feed/saved/posts/");
  const saved = { pages: [], waiters: [] };   // { url, method, headers, body, json, after }
  function plainHeaders(h) {
    const out = {};
    try {
      if (!h) return out;
      if (typeof Headers !== "undefined" && h instanceof Headers) { h.forEach((v, k) => { out[k.toLowerCase()] = v; }); return out; }
      if (Array.isArray(h)) { for (const [k, v] of h) out[String(k).toLowerCase()] = String(v); return out; }
      for (const k of Object.keys(h)) out[k.toLowerCase()] = String(h[k]);
    } catch {}
    return out;
  }
  function maxIdOf(url, body) {
    try { const q = new URL(String(url), location.origin).searchParams.get("max_id"); if (q) return q; } catch {}
    const p = formParams(body); return (p && p.get("max_id")) || null;
  }
  function learnSaved(url, method, headers, body, text) {
    if (!isSavedUrl(url) || typeof text !== "string") return;
    let json; try { json = JSON.parse(text.replace(/^for \(;;\);/, "")); } catch { return; }
    if (!json || !Array.isArray(json.items)) return;
    saved.pages.push({ url: String(url), method: String(method || "GET").toUpperCase(), headers: plainHeaders(headers), body: typeof body === "string" ? body : null, json, after: maxIdOf(url, body), at: Date.now() });
    saved.waiters = saved.waiters.filter((w) => !w());
    log("saved: learnt request", saved.pages.at(-1).method, "items", json.items.length, "more", !!json.more_available);
  }
  function waitForSavedPage(ms) {
    const hit = () => saved.pages.find((p) => p.after === null) || null;
    return new Promise((resolve) => {
      const now = hit();
      if (now) return resolve(now);
      const timer = setTimeout(() => resolve(hit()), ms);
      saved.waiters.push(() => { const p = hit(); if (!p) return false; clearTimeout(timer); resolve(p); return true; });
    });
  }
  // The request for a page of the saved feed: Instagram's own request from this page load when seen (its headers,
  // its method), else the same call the extension's other REST paths make — with max_id for every page after the first.
  function savedRequest(after, tok) {
    const t = saved.pages.find((p) => p.json) || null;
    const method = t ? t.method : "GET";
    const headers = t && Object.keys(t.headers).length ? { ...t.headers } : {
      "x-asbd-id": CFG.ASBD_ID, "x-csrftoken": tok.csrftoken || "", "x-ig-app-id": CFG.IG_APP_ID, "x-requested-with": "XMLHttpRequest",
      "x-ig-www-claim": (() => { try { return sessionStorage.getItem("www-claim-v2") || "0"; } catch { return "0"; } })(),
    };
    let url = t ? t.url : "https://www.instagram.com/api/v1/feed/saved/posts/";
    const u = new URL(url, "https://www.instagram.com");
    u.searchParams.delete("max_id");
    let body = null;
    if (method === "POST") {
      const p = new URLSearchParams(t && t.body ? t.body : "");
      p.delete("max_id");
      if (after) p.set("max_id", after);
      body = p.toString();
      if (!headers["content-type"]) headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (after) u.searchParams.set("max_id", after);
    return { url: u.toString(), init: { method, headers, ...(body !== null ? { body } : {}) } };
  }

  // A saved collection's GraphQL request, learnt the same way. The page's address names the collection id, so the
  // learner also finds which variable carries it (for reuse on another collection).
  const collection = { pages: [], waiters: [] };   // { id, after, json, at }
  const pageCollectionId = () => { const m = /^\/[^/]+\/saved\/[^/]+\/(\d+)\/?/.exec(location.pathname); return m ? m[1] : ""; };
  function learnCollection(url, headers, body, text) {
    if (typeof text !== "string" || text.indexOf(COLLECTION_ROOT) === -1) return;
    const params = formParams(body);
    const rawVars = params && params.get("variables");
    if (!rawVars) return;
    let vars, json;
    try { vars = JSON.parse(rawVars); json = JSON.parse(text.replace(/^for \(;;\);/, "")); } catch { return; }
    if (!json?.data?.[COLLECTION_ROOT] || !vars || typeof vars !== "object") return;
    const id = pageCollectionId();
    const cursorPath = findPath(vars, (k, v) => CURSOR_KEYS.includes(k) && (v === null || typeof v === "string")) || ["after"];
    const after = getAt(vars, cursorPath) ?? null;
    const idPath = id ? findPath(vars, (k, v) => (typeof v === "string" || typeof v === "number") && String(v) === id) : null;
    const all = readTemplates();
    const prev = all.collection || {};
    all.collection = {
      docId: params.get("doc_id") || prev.docId || null,
      friendly: params.get("fb_api_req_friendly_name") || prev.friendly || null,
      rootField: headerOf(headers, "x-root-field-name") || prev.rootField || COLLECTION_ROOT,
      url: String(url).includes("/graphql/query") ? "https://www.instagram.com/graphql/query" : "https://www.instagram.com/api/graphql",
      variables: vars, collectionId: id || prev.collectionId || null, idPath: idPath || prev.idPath || null, cursorPath, capturedAt: Date.now(),
    };
    try { localStorage.setItem(CFG.TEMPLATE_KEY, JSON.stringify(all)); } catch {}
    collection.pages.push({ id, after, json, at: Date.now() });
    collection.waiters = collection.waiters.filter((w) => !w());
    log("collection: learnt", all.collection.friendly, "id at", (idPath || []).join(".") || "?", "cursor at", cursorPath.join("."));
  }
  function waitForCollectionPage(id, ms) {
    const hit = () => collection.pages.find((p) => String(p.id) === String(id) && p.after === null) || null;
    return new Promise((resolve) => {
      const now = hit();
      if (now) return resolve(now);
      const timer = setTimeout(() => resolve(hit()), ms);
      collection.waiters.push(() => { const p = hit(); if (!p) return false; clearTimeout(timer); resolve(p); return true; });
    });
  }
  // Profiles: the "__relay_internal__pv__…" switches. Instagram adds required ones over time (2026-11-04:
  // PolarisSEOIsCrawler + PolarisThreadsStyleComments → "missing_required_variable_value"), so the hand-written
  // lists above are only a fallback: the switches are copied from Instagram's own request for the same tab on
  // this page load (page 1 — PolarisProfilePostsQuery / its Reels twin — or a later page), values included.
  const relay = { posts: null, reels: null, waiters: [] };
  const pageSize = { posts: null, reels: null };
  function learnRelay(body) {
    const params = formParams(body);
    const friendly = (params && params.get("fb_api_req_friendly_name")) || "";
    const key = /^PolarisProfilePosts/.test(friendly) ? "posts" : /^PolarisProfileReels/.test(friendly) ? "reels" : null;
    if (!key) return;
    let vars; try { vars = JSON.parse(params.get("variables") || "{}"); } catch { return; }
    // The page size Instagram's own request uses (data.count on Posts, data.page_size on Reels; 12 on
    // 2026-11-09). Only the popup's pager reads it (new-sort-logic Phase 4); MCP keeps CFG.FIRST.
    const size = Number(vars?.data?.count ?? vars?.data?.page_size);
    if (size >= 1 && size <= 50) pageSize[key] = size;
    const sw = {};
    for (const k of Object.keys(vars || {})) if (k.startsWith("__relay_internal__pv__")) sw[k] = vars[k];
    if (!Object.keys(sw).length) return;
    relay[key] = sw;
    relay.waiters = relay.waiters.filter((w) => !w());
    log("relay: learnt", key, Object.keys(sw).length, "switches from", friendly);
  }
  function waitForRelay(key, ms) {
    return new Promise((resolve) => {
      if (relay[key]) return resolve(relay[key]);
      const timer = setTimeout(() => resolve(relay[key]), ms);
      relay.waiters.push(() => { if (!relay[key]) return false; clearTimeout(timer); resolve(relay[key]); return true; });
    });
  }
  // A profile page's variables with the learnt switches in place of the hand-written ones (include_multi_captions follows MultiCaption, as in Instagram's paging request).
  function withRelay(vars, sw) {
    if (!sw) return vars;
    for (const k of Object.keys(vars)) if (k.startsWith("__relay_internal__pv__")) delete vars[k];
    Object.assign(vars, sw);
    const mc = "__relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider";
    if ("include_multi_captions" in vars && mc in sw) vars.include_multi_captions = !!sw[mc];
    return vars;
  }

  // Any GraphQL response goes to both learners; each one only acts on its own root field.
  const learnGraphql = (url, headers, body, text) => { learnSearch(url, headers, body, text); learnCollection(url, headers, body, text); };

  // The user's saved collections, as Instagram's own responses name them ({ collection_id, collection_name } objects):
  // the Saved page asks for that list on load whether or not it ever draws the tiles, so the bridge can read it here.
  const collectionsSeen = new Map();
  function collectionsIn(v, depth = 0) {
    if (!v || typeof v !== "object" || depth > 12) return;
    if (Array.isArray(v)) { for (const x of v) collectionsIn(x, depth + 1); return; }
    const id = v.collection_id != null ? String(v.collection_id) : null;
    const name = typeof v.collection_name === "string" ? v.collection_name : null;
    if (id && /^\d{5,}$/.test(id) && name && !collectionsSeen.has(id)) {
      collectionsSeen.set(id, { id, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "collection", name: name.slice(0, 120) });
    }
    for (const k of Object.keys(v)) collectionsIn(v[k], depth + 1);
  }
  function learnCollectionsList(text) {
    if (typeof text !== "string" || text.indexOf('"collection_id"') === -1) return;
    try { collectionsIn(JSON.parse(text.replace(/^for \(;;\);/, ""))); } catch {}
  }
  const isCollectionsUrl = (u) => typeof u === "string" && u.includes("/api/v1/collections/");
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.sf_agent_collections_req) return;
    post({ sf_agent_collections: [...collectionsSeen.values()] });
  });

  // The first SERP page for `q` seen on this page load (the search page fetches it by itself on load), or null after `ms`.
  function waitForSearchPage(q, ms) {
    const hit = () => search.pages.find((p) => sameQ(p.q, q) && p.after === null) || null;
    return new Promise((resolve) => {
      const now = hit();
      if (now) return resolve(now);
      const timer = setTimeout(() => resolve(hit()), ms);
      search.waiters.push(() => { const p = hit(); if (!p) return false; clearTimeout(timer); resolve(p); return true; });
    });
  }

  window.__sfAgentSearchDiag = () => {
    const t = readTemplates().search;
    return {
      template: t ? { docId: t.docId, friendly: t.friendly, rootField: t.rootField, url: t.url, q: t.q, queryPath: t.queryPath, cursorPath: t.cursorPath, variableKeys: Object.keys(t.variables || {}), capturedAt: t.capturedAt ? new Date(t.capturedAt).toISOString() : null } : null,
      pages: search.pages.map((p) => ({ q: p.q, after: p.after ? String(p.after).slice(0, 12) + "…" : null, items: flattenSerp(p.json?.data?.[SEARCH_ROOT]).length, hasNext: !!p.json?.data?.[SEARCH_ROOT]?.page_info?.has_next_page })),
      saved: saved.pages.map((p) => ({ method: p.method, url: p.url.replace(/max_id=[^&]+/, "max_id=…"), after: !!p.after, items: (p.json?.items || []).length, more: !!p.json?.more_available, headerNames: Object.keys(p.headers) })),
      collectionTemplate: (() => { const c = readTemplates().collection; return c ? { docId: c.docId, friendly: c.friendly, rootField: c.rootField, url: c.url, collectionId: c.collectionId, idPath: c.idPath, cursorPath: c.cursorPath, variableKeys: Object.keys(c.variables || {}), capturedAt: c.capturedAt ? new Date(c.capturedAt).toISOString() : null } : null; })(),
      collectionPages: collection.pages.map((p) => ({ id: p.id, after: !!p.after, items: (normalizeCollection(p.json)?.items || []).length, more: !!normalizeCollection(p.json)?.more_available })),
    };
  };

  (function installCapture() {
    if (window.__sfAgentCaptureInstalled) return;
    window.__sfAgentCaptureInstalled = true;
    const oOpen = XMLHttpRequest.prototype.open, oSetHeader = XMLHttpRequest.prototype.setRequestHeader, oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) { try { this.__sfUrl = String(url); this.__sfMethod = String(method || "GET"); this.__sfHeaders = {}; } catch {} return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { if (this.__sfHeaders) this.__sfHeaders[String(k).toLowerCase()] = String(v); } catch {} return oSetHeader.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (typeof body === "string" && body.includes("PolarisProfile")) learnRelay(body);
        if (typeof body === "string" && body.includes("doc_id=")) {
          for (const S of Object.values(SURFACES)) {
            if (!S.friendly || !body.includes(S.friendly)) continue;
            const m = /(?:^|&)doc_id=(\d+)/.exec(body);
            if (!m) continue;
            const all = readTemplates();
            if (all[S.key]?.docId !== m[1]) {
              all[S.key] = { docId: m[1], capturedAt: Date.now() };
              try { localStorage.setItem(CFG.TEMPLATE_KEY, JSON.stringify(all)); } catch {}
              log("captured doc_id for", S.key, m[1]);
            }
          }
        }
        if (isGraphqlUrl(this.__sfUrl) || isSavedUrl(this.__sfUrl) || isCollectionsUrl(this.__sfUrl)) {
          const xhr = this;
          xhr.addEventListener("loadend", () => {
            try {
              const rt = xhr.responseType;
              const text = rt === "" || rt === "text" ? xhr.responseText : rt === "json" ? JSON.stringify(xhr.response) : null;
              learnCollectionsList(text);
              if (isSavedUrl(xhr.__sfUrl)) learnSaved(xhr.__sfUrl, xhr.__sfMethod, xhr.__sfHeaders, body, text);
              else learnGraphql(xhr.__sfUrl, xhr.__sfHeaders, body, text);
            } catch {}
          });
        }
      } catch {}
      return oSend.apply(this, arguments);
    };
    const oFetch = window.fetch;
    window.__sfAgentFetch = oFetch;   // the runner's own requests use this, so they never feed the capture
    window.fetch = function (input, init) {
      const p = oFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : input && input.url;
        const isReq = typeof Request !== "undefined" && input instanceof Request;
        if (isSavedUrl(url)) {
          const method = (init && init.method) || (isReq ? input.method : "GET");
          const headers = (init && init.headers) || (isReq ? input.headers : null);
          const body = init && typeof init.body === "string" ? init.body : null;
          p.then((res) => { try { res.clone().text().then((t) => { learnCollectionsList(t); learnSaved(url, method, headers, body, t); }).catch(() => {}); } catch {} }).catch(() => {});
        } else if (isGraphqlUrl(url) && init && init.body != null) {
          learnRelay(init.body);
          p.then((res) => { try { res.clone().text().then((t) => { learnCollectionsList(t); learnGraphql(url, init.headers, init.body, t); }).catch(() => {}); } catch {} }).catch(() => {});
        } else if (isCollectionsUrl(url) || isGraphqlUrl(url)) {
          p.then((res) => { try { res.clone().text().then(learnCollectionsList).catch(() => {}); } catch {} }).catch(() => {});
        }
      } catch {}
      return p;
    };
  })();

  // ── Tokens off the live page ───────────────────────────────────────────────
  function readPageTokens() {
    const html = document.documentElement.innerHTML;
    const grab = (re) => { const m = html.match(re); return m ? m[1] : null; };
    const cookie = (k) => { const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)")); return m ? decodeURIComponent(m[1]) : null; };
    const t = {
      fb_dtsg: grab(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{"token":"([^"]+)"/),
      lsd: grab(/"LSD"\s*,\s*\[\]\s*,\s*\{"token":"([^"]+)"/),
      csrftoken: cookie("csrftoken"),
      av: grab(/"IG_USER_EIMU":"(\d+)"/),
      hs: grab(/"haste_session":"([^"]+)"/),
      rev: grab(/"server_revision":(\d+)/),
      hsi: grab(/"hsi":"(\d+)"/),
      spin_r: grab(/"__spin_r":(\d+)/),
      spin_b: grab(/"__spin_b":"([^"]+)"/),
      spin_t: grab(/"__spin_t":(\d+)/),
    };
    if (t.fb_dtsg) t.jazoest = "2" + [...t.fb_dtsg].reduce((s, c) => s + c.charCodeAt(0), 0);
    return t;
  }

  function findIdOnPage(username) {
    const html = document.documentElement.innerHTML;
    const needle = `"username":"${username}"`;
    const counts = new Map();
    let i = -1;
    while ((i = html.indexOf(needle, i + 1)) !== -1) {
      const win = html.slice(Math.max(0, i - 400), i + needle.length + 400);
      for (const m of win.matchAll(/"(?:pk|id|pk_id|profile_id|user_id|target_user_id)":"?(\d{3,20})"?/g)) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
    for (const re of [/"profilePage_(\d+)"/g, /"profile_id":"(\d+)"/g, /"target_user_id":"(\d+)"/g]) for (const m of html.matchAll(re)) counts.set(m[1], (counts.get(m[1]) || 0) + 2);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return ranked.length ? ranked[0][0] : null;
  }

  // ── Request ────────────────────────────────────────────────────────────────
  let reqNo = 1;
  function buildBody(S, variables, tok) {
    const p = new URLSearchParams();
    if (tok.av) p.set("av", tok.av);
    p.set("__d", "www"); p.set("__user", "0"); p.set("__a", "1");
    p.set("__req", (reqNo++).toString(36));
    if (tok.hs) p.set("__hs", tok.hs);
    p.set("dpr", String(Math.round(window.devicePixelRatio || 1)));
    p.set("__ccg", "EXCELLENT");
    if (tok.rev) p.set("__rev", tok.rev);
    if (tok.hsi) p.set("__hsi", tok.hsi);
    p.set("__comet_req", "7");
    if (tok.fb_dtsg) p.set("fb_dtsg", tok.fb_dtsg);
    if (tok.jazoest) p.set("jazoest", tok.jazoest);
    if (tok.lsd) p.set("lsd", tok.lsd);
    if (tok.spin_r) p.set("__spin_r", tok.spin_r);
    if (tok.spin_b) p.set("__spin_b", tok.spin_b);
    if (tok.spin_t) p.set("__spin_t", tok.spin_t);
    p.set("fb_api_caller_class", "RelayModern");
    p.set("fb_api_req_friendly_name", friendlyOf(S));
    p.set("variables", JSON.stringify(variables));
    p.set("server_timestamps", "true");
    p.set("doc_id", docIdFor(S));
    return p.toString();
  }
  function buildHeaders(S, tok) {
    return {
      "content-type": "application/x-www-form-urlencoded",
      "x-asbd-id": CFG.ASBD_ID,
      "x-csrftoken": tok.csrftoken || "",
      "x-fb-friendly-name": friendlyOf(S),
      "x-fb-lsd": tok.lsd || "",
      "x-ig-app-id": CFG.IG_APP_ID,
      "x-root-field-name": rootFieldOf(S),
    };
  }

  class StopError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

  // Human-shaped pacing: per-run band, log-normal gaps, occasional linger.
  function makePacer() {
    const centre = CFG.GAP_BASE_MIN_MS + Math.random() * (CFG.GAP_BASE_MAX_MS - CFG.GAP_BASE_MIN_MS);
    const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    return () => {
      if (Math.random() < 1 / CFG.GAP_LONG_EVERY) return Math.round(CFG.GAP_LONG_MIN_MS + Math.random() * (CFG.GAP_LONG_MAX_MS - CFG.GAP_LONG_MIN_MS));
      const ms = centre * Math.exp(0.2 * randn());
      return Math.round(Math.max(CFG.GAP_BASE_MIN_MS * 0.8, Math.min(ms, CFG.GAP_BASE_MAX_MS * 1.6)));
    };
  }

  // ── Outlier (same rules as _sfOutlierQualifying / _sfOutlierComputeMeta / _sfOutlierStampScores) ──
  function outlierQualifying(pool) {
    const now = Date.now(); const out = [];
    pool.forEach((r) => { if (r.pinned || r.metricVal === null || !Number.isFinite(r.dateMs)) return; if (now - r.dateMs >= OUT.MIN_AGE_MS) out.push(r); });
    return out;
  }
  function outlierComputeMeta(pool, metric) {
    let q = outlierQualifying(pool);
    if (q.length < OUT.FLOOR) return { status: "insufficient", baseline: null, poolSize: q.length, metric };
    q.sort((a, b) => b.dateMs - a.dateMs);
    if (q.length > OUT.CAP) q = q.slice(0, OUT.CAP);
    const vals = q.map((r) => +r.metricVal).sort((a, b) => a - b);
    const mid = vals.length >> 1;
    const baseline = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    if (!(baseline > 0)) return { status: "insufficient", baseline: null, poolSize: q.length, metric };
    return { status: "ok", baseline, poolSize: q.length, metric };
  }

  // ── The job ────────────────────────────────────────────────────────────────
  const state = { running: false, stop: false, inflight: null, jobId: null };

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data) return;
    if (ev.data.sf_stop_sorting && state.running) { state.stop = true; try { state.inflight?.abort(); } catch {} }
    if (ev.data.sf_agent_job) runJob(ev.data.sf_agent_job);
  });

  function post(msg) { try { window.postMessage(msg, "*"); } catch {} }
  function finish(jobId, payload) {
    state.running = false; state.jobId = null; state.inflight = null;
    // The bridge owns the overlay + banner for the whole run (several profiles), so nothing is removed here.
    post({ sf_agent_result: { jobId, ...payload } });
  }

  const postGraphql = (headers, body, url = "https://www.instagram.com/graphql/query") => requestJson(url, { method: "POST", headers, body });
  async function requestJson(url, init) {
    const ctl = new AbortController();
    state.inflight = ctl;
    const timer = setTimeout(() => ctl.abort(), CFG.REQUEST_TIMEOUT_MS);
    const doFetch = window.__sfAgentFetch || fetch;
    let res;
    try { res = await doFetch(url, { ...init, credentials: "include", signal: ctl.signal }); }
    catch (e) { if (state.stop) throw new StopError("USER_STOP", "stopped from the banner"); throw new StopError("NETWORK", e?.message || String(e)); }
    finally { clearTimeout(timer); state.inflight = null; }

    if (res.status === 429) throw new StopError("THROTTLED", "Instagram asked us to slow down (429). Stopped — try again in a couple of hours.");
    if (res.status === 401 || res.status === 403) throw new StopError("AUTH", `Instagram rejected the session (${res.status}).`);
    if (res.redirected && /accounts\/login/.test(res.url)) throw new StopError("LOGGED_OUT", "Instagram sent us to the login page — sign in to Instagram in Chrome.");
    if (!res.ok) throw new StopError("HTTP_" + res.status, `Instagram returned HTTP ${res.status}.`);
    const text = await res.text();
    if (/^\s*</.test(text)) throw new StopError("LOGGED_OUT", "Instagram returned a page instead of data — login wall or challenge. Sign in to Instagram in Chrome.");
    let json;
    try { json = JSON.parse(text.replace(/^for \(;;\);/, "")); } catch { throw new StopError("NOT_JSON", "Unreadable response from Instagram."); }
    if (json.status === "fail" || json.errors) {
      // A GraphQL answer can carry its data AND an "errors" list about one field of one item (2026-11-04: a
      // field_exception on location.profile_pic_url on every @ashscarrott Posts page, Instagram's own requests
      // included). Instagram's page shows the data and ignores the note, so do the same; only an answer without
      // data is a refusal.
      const hasData = json.status !== "fail" && json.data && typeof json.data === "object" && Object.values(json.data).some((v) => v != null);
      if (hasData) { log("ignored errors next to data:", json.errors); return json; }
      const msg = json.message || json.errors?.[0]?.message || "unknown";
      if (/checkpoint|challenge/i.test(msg)) throw new StopError("CHECKPOINT", "Instagram raised a security check on this account. Stopped — open Instagram and complete it.");
      throw new StopError("API_FAIL", "Instagram refused the request: " + msg);
    }
    return json;
  }

  async function runJob(job) {
    if (state.running) { post({ sf_agent_result: { jobId: job.jobId, ok: false, error: { code: "BUSY", message: "A sort is already running in this tab." } } }); return; }
    state.running = true; state.stop = false; state.jobId = job.jobId;
    const t0 = performance.now();
    const isSearch = job.kind === "search";
    const isCollection = job.kind === "saved" && job.saved === "collection";
    const isSaved = job.kind === "saved" && !isCollection;   // Saved › All Posts
    const S = isSearch ? SURFACES.search : isCollection ? SURFACES.collection : isSaved ? SURFACES.saved : SURFACES[job.surface === "posts" ? "posts" : "reels"];
    const collectionId = isCollection && job.collection ? String(job.collection.id || "") : null;
    const username = String(job.username || "").replace(/^@/, "").toLowerCase();
    const query = isSearch ? String(job.query || "").replace(/\s+/g, " ").trim() : null;
    // Time window (optional): job.since / job.until are ms timestamps. With a
    // window, the scan runs until the feed crosses `since` (newest-first), and
    // depth is only a cap. The server sets depth on every job; the ceiling is ours.
    const sinceMs = Number.isFinite(+job.since) && +job.since > 0 ? +job.since : null;
    const untilMs = Number.isFinite(+job.until) && +job.until > 0 ? +job.until : null;
    const windowMode = sinceMs !== null;
    const depth = Math.max(1, Math.min(CFG.DEPTH_CEILING, parseInt(job.depth, 10) || 50));
    const maxPages = Math.ceil(depth / CFG.FIRST);   // a window scan skips newer items, so pages bound it, not rows
    const sortBy = isSearch
      ? (["likes", "comments", "oldest"].includes(job.sortBy) ? job.sortBy : "likes")   // Search: no view counts, no baseline
      : isSaved
      ? (["likes", "oldest"].includes(job.sortBy) ? job.sortBy : "likes")               // Saved: no comment counts either
      : isCollection
      ? (["likes", "comments", "oldest"].includes(job.sortBy) ? job.sortBy : "likes")   // collections do carry comment counts
      : ["views", "likes", "comments", "oldest", "outlier", "velocity"].includes(job.sortBy) ? job.sortBy : (S.metricKey === "likesCount" ? "likes" : "views");
    const outlierMode = isSearch || isSaved || isCollection ? "off" : job.outlier === "off" ? "off" : job.outlier === "on" || sortBy === "outlier" || sortBy === "velocity" ? "on" : "auto";
    const gap = makePacer();
    let requests = 0;

    try {
      const tok = readPageTokens();
      if (!tok.csrftoken || !tok.lsd || !tok.fb_dtsg) throw new StopError("LOGGED_OUT", "Couldn't find an Instagram session on this page — sign in to Instagram in Chrome.");
      const ctx = { username, query, collectionId, id: null };
      if (S.needsId) {
        ctx.id = findIdOnPage(username);
        if (!ctx.id) throw new StopError("NO_ID", `Couldn't identify @${username} on this page.`);
      }
      // Search: the page load fires Instagram's own first request. Wait for it — it teaches this browser the
      // request shape, and its answer IS page 1, so that page is read rather than asked for a second time.
      let firstPage = null;
      if (isSearch) {
        const known = !!readTemplates().search?.docId;
        firstPage = await waitForSearchPage(query, known ? 2500 : 12000);
        if (!firstPage && !known) throw new StopError("SHAPE", SEARCH_UNLEARNT);
      } else if (isSaved) {
        firstPage = await waitForSavedPage(10000);   // the saved page fetches page 1 by itself; if it doesn't, we ask ourselves
      } else if (isCollection) {
        if (!collectionId) throw new StopError("NO_COLLECTION", "The job named no collection.");
        const known = !!readTemplates().collection?.docId;
        firstPage = await waitForCollectionPage(collectionId, known ? 2500 : 12000);
        if (!firstPage && !known) throw new StopError("SHAPE", COLLECTION_UNLEARNT);
      }
      // Profiles: the page fires its own page-1 request on load; its switches replace the hand-written ones.
      const sw = S === SURFACES.posts || S === SURFACES.reels ? await waitForRelay(S.key, 3000) : null;
      const headers = S.rest ? null : buildHeaders(S, tok);
      const sendPage = (after) => {
        if (after === null && firstPage) return Promise.resolve(firstPage.json);
        if (S.rest) { const r = savedRequest(after, tok); return requestJson(r.url, r.init); }
        return postGraphql(headers, buildBody(S, withRelay(S.variables(ctx, after), sw), tok), S.url ? S.url() : undefined);
      };

      // Collect
      const seen = new Set(); const rows = []; const pool = new Map();
      let after = null, page = 0, hasNext = true, stopped = false;
      let oldestSeenMs = null, reachedWindowEnd = false;
      while (rows.length < depth && page < maxPages) {
        if (state.stop) { stopped = true; break; }
        page++;
        let json;
        try { json = await sendPage(after); } catch (e) { if (e instanceof StopError && e.code === "USER_STOP") { stopped = true; break; } throw e; }
        requests++;
        const pg = pageOf(S, json);
        if (!pg) throw new StopError("SHAPE", "Instagram's response shape changed — the sort couldn't read it.");
        let crossed = false;
        for (const node of pg.nodes) {
          if (!node) continue;
          const pr = S.poolRecord(node);
          if (pr && pr.key && !pool.has(pr.key)) pool.set(pr.key, pr);   // the outlier pool ignores the window, like today
          if (!S.accept(node)) continue;
          if (windowMode && pr && Number.isFinite(pr.dateMs)) {
            // IG floats pinned items to the top whatever their age: an old pinned
            // item is skipped but must not end the scan (same rule as the date sort).
            if (!pr.pinned) oldestSeenMs = oldestSeenMs === null ? pr.dateMs : Math.min(oldestSeenMs, pr.dateMs);
            if (pr.dateMs < sinceMs) { if (!pr.pinned) crossed = true; continue; }
            if (untilMs !== null && pr.dateMs > untilMs) continue;
          }
          const pk = String(node.pk);
          if (seen.has(pk)) continue;
          seen.add(pk);
          rows.push(S.parse(node, username));
          if (rows.length >= depth) break;
        }
        // Window scans have no item target — report coverage (0..1) so the banner's bar and Claude's status line can move.
        const scan = windowMode && oldestSeenMs !== null
          ? Math.max(0, Math.min(1, (Date.now() - oldestSeenMs) / Math.max(1, Date.now() - sinceMs)))
          : undefined;
        post({ insta_banner_notification: true, count: rows.length, type: S.label, ...(scan !== undefined ? { scanProgress: scan } : {}) });
        hasNext = pg.hasNext;
        after = pg.after;
        if (crossed) { reachedWindowEnd = true; break; }
        if (!hasNext || !after) break;
        if (rows.length < depth) await sleep(gap());
      }

      // Outlier baseline: "auto" scores from what was read (no extra pages); "on" pages on until 25 qualify.
      let meta = null;
      if (outlierMode !== "off" && !stopped) {
        const metric = S.metricKey === "likesCount" ? "likes" : "views";
        if (outlierMode === "on") {
          let poolPages = 0; const tPool = performance.now();
          while (outlierQualifying(pool).length < OUT.CAP && hasNext && after && poolPages < OUT.MAX_POOL_PAGES && performance.now() - tPool < OUT.MAX_POOL_MS) {
            if (state.stop) { stopped = true; break; }
            await sleep(gap());
            let json;
            try { json = await sendPage(after); } catch (e) { if (e instanceof StopError && e.code === "USER_STOP") { stopped = true; break; } throw e; }
            requests++; poolPages++;
            const pg = pageOf(S, json);
            if (!pg) break;
            for (const node of pg.nodes) { const pr = S.poolRecord(node); if (pr && pr.key && !pool.has(pr.key)) pool.set(pr.key, pr); }
            hasNext = pg.hasNext;
            after = pg.after;
            const q = outlierQualifying(pool).length;
            post({ sf_outlier_analyzing: true, count: Math.min(OUT.CAP, q), progress: Math.min(1, q / OUT.CAP) });
          }
        }
        meta = stopped ? { status: "cancelled", baseline: null, poolSize: 0, metric } : outlierComputeMeta(pool, metric);
        if (outlierMode === "auto" && meta.status === "insufficient" && hasNext) meta = { status: "not_computed", baseline: null, poolSize: meta.poolSize, metric };
        if (meta.status === "ok") {
          rows.forEach((it) => {
            it.outlierScore = it[S.metricKey] != null ? +it[S.metricKey] / meta.baseline : null;
            if (it.viewsPerHour != null && meta.baseline > 0) {
              it.velocityScore = Number(((it.viewsPerHour * 24) / meta.baseline).toFixed(2));
            }
          });
        }
      }

      // Sort
      let sorted;
      if (isSearch) { sorted = typeof sfExploreSortItems === "function" ? sfExploreSortItems(rows, sortBy) : sortSearch(rows, sortBy); }   // result order isn't chronological, so "oldest" sorts by date
      else if (isSaved || isCollection) { sorted = typeof sfSavedSortItems === "function" ? sfSavedSortItems(rows, sortBy) : sortSearch(rows, sortBy); }   // saved order is "recently saved", so "oldest" sorts by date too
      else if (sortBy === "velocity") { sorted = [...rows].sort((a, b) => ((b.velocityScore ?? b.viewsPerHour) || 0) - ((a.velocityScore ?? a.viewsPerHour) || 0)); }
      else if (sortBy === "outlier") { const fb = S.metricKey; sorted = [...rows].sort((a, b) => ((b.outlierScore ?? b[fb]) || 0) - ((a.outlierScore ?? a[fb]) || 0)); }
      else if (typeof sort_items === "function" && Array.isArray((sorted = sort_items(rows, sortBy)))) { /* extension sort */ }
      else { const k = { views: "viewCount", likes: "likesCount", comments: "commentsCount" }[sortBy]; sorted = sortBy === "oldest" ? [...rows].reverse() : [...rows].sort((a, b) => (b[k] ?? 0) - (a[k] ?? 0)); }

      const windowInfo = windowMode
        ? { sinceMs, untilMs, oldestSeenMs, truncated: !reachedWindowEnd && hasNext && !stopped } // cap hit before the feed crossed `since`
        : null;
      const kind = isSearch ? { kind: "search", query } : isSaved ? { kind: "saved", saved: "all_posts" } : isCollection ? { kind: "saved", saved: "collection", collection: job.collection } : {};
      finish(job.jobId, { ok: true, rows: sorted, outlier: meta, stopped, requests, ms: Math.round(performance.now() - t0), surface: S.label, sortBy, depth, seenInFeed: rows.length, window: windowInfo, ...kind });
    } catch (e) {
      const code = e instanceof StopError ? e.code : "ERROR";
      finish(job.jobId, { ok: false, error: { code, message: e?.message || String(e) }, requests, ms: Math.round(performance.now() - t0), surface: S.label, ...(isSearch ? { kind: "search", query } : isSaved ? { kind: "saved", saved: "all_posts" } : isCollection ? { kind: "saved", saved: "collection", collection: job.collection } : {}) });
    }
  }

  // ── For the popup's profile sorts (new-sort-logic Phase 3) ─────────────────
  // script_instagram.js asks for a profile's next Reels / Posts page through
  // this, so the request shape (tokens, doc_id, variables — with the relay
  // switches learnt from Instagram's own request, withRelay) has one home. It is
  // a plain request: no pacing, depth or limits here — the caller paces it.
  // MCP jobs don't use it and are unchanged. Tokens are read once per page load.
  let pagerTok = null;
  // Ask for as many posts per page as Instagram's own page does (learnt above), 12 if none seen.
  function withPageSize(vars, n) {
    if (!(n > 0)) return vars;
    if ("first" in vars) vars.first = n;
    if (vars.data && "count" in vars.data) vars.data.count = n;
    if (vars.data && "page_size" in vars.data) vars.data.page_size = n;
    return vars;
  }
  window.__sfIgProfilePager = {
    ready(surface) {
      const S = SURFACES[surface];
      if (!S || (surface !== "reels" && surface !== "posts")) return false;
      pagerTok = pagerTok || readPageTokens();
      return !!(pagerTok.csrftoken && pagerTok.lsd && pagerTok.fb_dtsg && docIdFor(S));
    },
    // ctx = { username, id } (id: the profile's numeric pk, needed for Reels). Resolves with Instagram's JSON.
    async page(surface, ctx, after) {
      const S = SURFACES[surface];
      pagerTok = pagerTok || readPageTokens();
      const c = { username: ctx.username, id: ctx.id || (S.needsId ? findIdOnPage(ctx.username) : null) };
      if (S.needsId && !c.id) throw new StopError("NO_ID", `Couldn't identify @${ctx.username} on this page.`);
      return postGraphql(buildHeaders(S, pagerTok), buildBody(S, withPageSize(withRelay(S.variables(c, after), relay[surface]), pageSize[surface]), pagerTok));
    },
    abort() { try { state.inflight?.abort(); } catch {} },
    // For the Phase 3 diagnostic file only: what page() would send, minus every token.
    describe(surface, ctx, after) {
      const S = SURFACES[surface];
      if (!S) return null;
      pagerTok = pagerTok || readPageTokens();
      const t = readTemplates()[S.key];
      let variables = null;
      try { variables = withPageSize(withRelay(S.variables({ username: ctx.username, id: ctx.id || (S.needsId ? findIdOnPage(ctx.username) : null) }, after), relay[surface]), pageSize[surface]); } catch (e) { variables = "error: " + (e?.message || e); }
      return {
        friendly: friendlyOf(S), docId: docIdFor(S), docIdFrom: t?.docId ? `learnt ${new Date(t.capturedAt || 0).toISOString()}` : "built-in default",
        rootField: rootFieldOf(S), variables, relayFrom: relay[surface] ? "copied from Instagram's own request" : "built-in list (none seen on this page)", pageSizeFrom: pageSize[surface] ? `Instagram's own request (${pageSize[surface]})` : "fallback (12)",
        tokensFound: { csrftoken: !!pagerTok.csrftoken, lsd: !!pagerTok.lsd, fb_dtsg: !!pagerTok.fb_dtsg, av: !!pagerTok.av },
      };
    },
  };

  // ── Saved › All Posts pager for the popup's own Saved sort (new-sort-logic Phase 7) ──
  // Page 1 is Instagram's own (the saved page fetches it as it loads); later pages are the same REST request again with
  // max_id — Instagram's own request from this page load when seen (its headers, its method), else the hand-built one.
  // Errors come back as the same StopError codes as the profile pager (THROTTLED, AUTH, LOGGED_OUT, CHECKPOINT, …).
  window.__sfIgSavedPager = {
    ready() {
      pagerTok = pagerTok || readPageTokens();
      return !!(pagerTok.csrftoken || saved.pages.some((p) => p.json));
    },
    async page(after) {
      pagerTok = pagerTok || readPageTokens();
      const r = savedRequest(after, pagerTok);
      return requestJson(r.url, r.init);
    },
    abort() { try { state.inflight?.abort(); } catch {} },
  };

  // ── Saved collection pager for the popup's own collection sort (new-sort-logic Phase 7) ──
  // Page 1 is Instagram's own (the collection page fetches it as it loads, and that request is what teaches this
  // browser the shape — learnCollection above); later pages are that same GraphQL request with the next cursor.
  // ready() is false until the request has been learnt (the first collection ever opened in this browser learns it
  // from its own page 1, a moment after that page arrives). Resolves with Instagram's JSON (fetch__MediaCollection).
  window.__sfIgCollectionPager = {
    ready(collectionId) {
      const t = readTemplates().collection;
      if (!collectionId || !t || !t.docId || !t.variables || typeof t.variables !== "object") return false;
      if (String(t.collectionId || "") !== String(collectionId) && !t.idPath) return false;
      pagerTok = pagerTok || readPageTokens();
      return !!(pagerTok.csrftoken && pagerTok.lsd && pagerTok.fb_dtsg);
    },
    async page(collectionId, after) {
      const S = SURFACES.collection;
      pagerTok = pagerTok || readPageTokens();
      return postGraphql(buildHeaders(S, pagerTok), buildBody(S, S.variables({ collectionId: String(collectionId) }, after), pagerTok), S.url());
    },
    abort() { try { state.inflight?.abort(); } catch {} },
  };

  // ── Search pager for the popup's own Explore search sort (new-sort-logic Phase 7) ──
  // Page 1 is Instagram's own (the search page fetches it as it loads, and that request teaches this browser the
  // shape — learnSearch above); later pages are that same GraphQL request with the next cursor. ready() is false
  // until Instagram's own request for THIS keyword has been seen on this page load: its variables carry values made
  // for this visit, so a request remembered from an earlier visit is never replayed. Resolves with Instagram's JSON.
  window.__sfIgSearchPager = {
    ready(query) {
      const t = readTemplates().search;
      if (!query || !t || !t.docId || !t.variables || typeof t.variables !== "object") return false;
      if (!sameQ(t.q, query) && !t.queryPath) return false;
      if (!search.pages.some((p) => sameQ(p.q, query))) return false;
      pagerTok = pagerTok || readPageTokens();
      return !!(pagerTok.csrftoken && pagerTok.lsd && pagerTok.fb_dtsg);
    },
    async page(query, after) {
      const S = SURFACES.search;
      pagerTok = pagerTok || readPageTokens();
      return postGraphql(buildHeaders(S, pagerTok), buildBody(S, S.variables({ query }, after), pagerTok), S.url());
    },
    abort() { try { state.inflight?.abort(); } catch {} },
  };

  // Search results arrive in relevance order, so "oldest" must sort by date (the profile flow reverses a chronological feed).
  function sortSearch(rows, by) {
    const t = (r) => (r.createDate ? Date.parse(r.createDate) : 0);
    if (by === "oldest") return [...rows].sort((a, b) => t(a) - t(b));
    const k = by === "comments" ? "commentsCount" : "likesCount";
    return [...rows].sort((a, b) => (b[k] ?? 0) - (a[k] ?? 0));
  }
})();
