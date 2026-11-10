// ── Similar accounts (TikTok) — page-world fetch ─────────────────────────────
// Injected into tiktok.com's main world by inject_tiktok_script.js. Answers one
// request from similar_accounts_tiktok.js (content script) over postMessage:
//
//   → { source: "sf-tt-similar", type: "request", reqId, username }
//   ← { source: "sf-tt-similar", type: "response", reqId, result }
//
// result: { ok: true, accounts: [...] } or { ok: false, error } with error
// "TIKTOK_SIGNED_OUT" | "NO_PROFILE" | "UPSTREAM".
//
// The list is the one behind the profile's "Suggested accounts" (person-plus
// button next to Message): /api/user/list/?scene=151&targetUserId=<id>. A bare
// unsigned URL works from this world; a captured signed URL replays as an
// empty body, so the URL is always built here. Signed out, TikTok answers the
// same generic celebrity list for every profile, so a signed-out viewer gets
// TIKTOK_SIGNED_OUT instead of a misleading list.
//
// Filler: TikTok always answers 30. When it has fewer real suggestions for a
// profile (small creators), it tops the list up with that same generic list
// (LISA, JENNIE, Selena Gomez…), always at the end. So the generic list is
// fetched once per tab (no cookies = TikTok's signed-out answer, in the
// viewer's own region) and, walking up from the bottom, every account on it is
// dropped until the first one that isn't — if that's 2 or more. A generic
// account higher up (Tate McRae on Charli's list) has real suggestions after
// it, so the walk never reaches it.

(() => {
  if (window.__sfTtSimilarFetchInstalled) return;
  window.__sfTtSimilarFetchInstalled = true;

  const SOURCE = "sf-tt-similar";
  const MAX_ACCOUNTS = 30;   // TikTok's page size; hasMore comes back false
  const GENERIC_KEY = "sfTtSimilarGenericV1";      // sessionStorage: survives the sort's reloads
  const GENERIC_KEEP_MS = 6 * 60 * 60 * 1000;
  const GENERIC_WAIT_MS = 2000;                    // slower than this → show the list unfiltered
  const FILLER_MIN = 2;                            // one famous name at the end may be real

  function readScope(doc) {
    try {
      const el = doc.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      return el ? JSON.parse(el.textContent).__DEFAULT_SCOPE__ || null : null;
    } catch (e) {
      return null;
    }
  }

  // Signed in ⇔ the app context carries the viewer. Signed out it has no
  // `user` key at all.
  function viewerSignedIn() {
    const app = readScope(document)?.["webapp.app-context"];
    return !!(app && app.user && (app.user.uid || app.user.uniqueId || app.user.secUid));
  }

  // The profile's numeric id. The page's own data is used when it still
  // describes this profile; after an in-app navigation it can be stale, so the
  // profile page's HTML is the fallback (same parse as the video page lookup).
  async function profileId(username) {
    const want = String(username || "").toLowerCase();
    const fromPage = readScope(document)?.["webapp.user-detail"]?.userInfo?.user;
    if (fromPage?.id && String(fromPage.uniqueId || "").toLowerCase() === want) return String(fromPage.id);

    try {
      const res = await fetch(`/@${encodeURIComponent(want)}?lang=en`, { credentials: "include" });
      if (!res.ok) return null;
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const user = readScope(doc)?.["webapp.user-detail"]?.userInfo?.user;
      if (user?.id && String(user.uniqueId || "").toLowerCase() === want) return String(user.id);
    } catch (e) {}
    return null;
  }

  async function suggested(id, credentials = "include") {
    const url =
      "/api/user/list/?aid=1988&app_name=tiktok_web&scene=151&count=" + MAX_ACCOUNTS +
      "&maxCursor=0&minCursor=0&targetUserId=" + encodeURIComponent(id);
    const res = await fetch(url, { credentials });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;   // TikTok's "refused" is an empty 200
    try {
      const data = JSON.parse(text);
      return data?.statusCode === 0 && Array.isArray(data.userList) ? data.userList : null;
    } catch (e) {
      return null;
    }
  }

  // TikTok's generic list as a Set of lowercase handles, or null (failed). Any
  // profile id works: signed out, the answer ignores it.
  let genericInflight = null;
  async function fetchGeneric(id) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(GENERIC_KEY) || "null");
      if (saved && Date.now() - saved.at < GENERIC_KEEP_MS && Array.isArray(saved.names) && saved.names.length) {
        return new Set(saved.names);
      }
    } catch (e) {}
    const list = await suggested(id, "omit").catch(() => null);
    if (!list || !list.length) return null;
    const names = list.map((e) => String(e?.user?.uniqueId || "").toLowerCase()).filter(Boolean);
    try { sessionStorage.setItem(GENERIC_KEY, JSON.stringify({ at: Date.now(), names })); } catch (e) {}
    return new Set(names);
  }
  function genericList(id) {
    if (!genericInflight) {
      genericInflight = fetchGeneric(id).finally(() => { genericInflight = null; });
    }
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), GENERIC_WAIT_MS));
    return Promise.race([genericInflight, timeout]);
  }

  // Walk up from the bottom while accounts are on the generic list; drop that
  // run when it's FILLER_MIN or longer.
  function dropFiller(accounts, generic) {
    if (!generic) return accounts;
    let cut = accounts.length;
    while (cut > 0 && generic.has(accounts[cut - 1].username.toLowerCase())) cut--;
    return accounts.length - cut >= FILLER_MIN ? accounts.slice(0, cut) : accounts;
  }

  async function lookup(username) {
    if (!viewerSignedIn()) return { ok: false, error: "TIKTOK_SIGNED_OUT" };
    const id = await profileId(username);
    if (!id) return { ok: false, error: "NO_PROFILE" };
    const genericPromise = genericList(id);   // in parallel with the real list

    let list = null;
    try { list = await suggested(id); } catch (e) {}
    if (!list) return { ok: false, error: "UPSTREAM" };

    const self = String(username).toLowerCase();
    const seen = new Set();
    const accounts = [];
    for (const entry of list) {
      const u = entry?.user;
      const handle = String(u?.uniqueId || "");
      const key = handle.toLowerCase();
      // The list can include the profile itself; private accounts can't be sorted.
      if (!handle || key === self || u.privateAccount || u.secret || seen.has(key)) continue;
      seen.add(key);
      accounts.push({
        id: String(u.id || ""),
        username: handle,
        full_name: u.nickname || "",
        is_verified: !!u.verified,
        pic: u.avatarMedium || u.avatarThumb || "",
        followers: Number(entry?.stats?.followerCount) || 0,
      });
    }
    // Self and private accounts are already out, so the walk starts at the
    // last account the panel would show (Charli's own handle ends her list).
    return { ok: true, accounts: dropFiller(accounts, await genericPromise) };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== SOURCE || msg.type !== "request") return;
    lookup(msg.username)
      .catch(() => ({ ok: false, error: "UPSTREAM" }))
      .then((result) => {
        window.postMessage({ source: SOURCE, type: "response", reqId: msg.reqId, result }, "*");
      });
  });
})();
