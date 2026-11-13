const DEBUG = false;

// ViralSpy Pro + Local MCP initialization
function ensureViralSpyProState() {
  try {
    chrome.storage.local.get(["sortfeed_agent_local"], (cur) => {
      const localCfg = cur?.sortfeed_agent_local && typeof cur.sortfeed_agent_local === "object"
        ? { enabled: true, port: cur.sortfeed_agent_local.port || 8765 }
        : { enabled: true, port: 8765 };
      chrome.storage.local.set({
        sort_feed_state_type_flag: "pro",
        sort_feed_user_id: "viralspy_local_pro",
        sort_feed_user_profile: {
          userID: "viralspy_local_pro",
          name: "ViralSpy Pro",
          email: "local@viralspy.ai",
        },
        sortFeedUser: {
          userID: "viralspy_local_pro",
          stateType: "pro",
          createdAt: "2026-01-01T00:00:00.000Z",
          cachedAt: Date.now(),
        },
        sortfeed_agent_local: localCfg,
        sortfeed_mcp_access_everyone: true,
      });
    });
  } catch (_) {}
}
ensureViralSpyProState();

// Agent mode (Claude / Antigravity → local MCP server → this worker → hidden IG tab) lives in
// its own file so the shipped sort/transcription paths here stay untouched.
// Guarded: if that file ever fails to load, sign-in, transcription and message routing below still work.
try { importScripts("background_agent.js"); } catch (e) {}
// Toolbar icon while profile sorts run: the count badge with a % ring (new-sort-logic,
// replaces the Phase 0 colour sweep in background_action_ring.js, kept but not loaded). Same guard.
try { importScripts("background_action_badge.js"); } catch (e) {}
// Instagram profile sorts across tabs: the pacing clock for hidden tabs (Phase 4)
// and the line, one sort at a time (Phase 5). Same guard.
try { importScripts("background_sort_clock.js"); } catch (e) {}
// The Instagram review ask's record: wins, answers, and the one tab that may ask. Same guard.
try { importScripts("background_reviews.js"); } catch (e) {}

const TRANS_WORKER_ABORT_MS = 180000;

function startSwKeepalive() {
  return setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch {}
  }, 20000);
}

////////////////////////////////////////////////////////////////////////////////
// ViralSpy Local Free Whisper Transcription + Local Storage Endpoints
////////////////////////////////////////////////////////////////////////////////

const TRANS_WORKER_URL_IG = "http://127.0.0.1:8765/trans/instagram/";
const TRANS_WORKER_URL_TIKTOK = "http://127.0.0.1:8765/trans/tiktok/";
const TRANS_WORKER_URL_FB = "http://127.0.0.1:8765/trans/facebook/";
const TRANS_QUOTA_CHECK_URL = "http://127.0.0.1:8765/trans-quota/";
const TRANS_CACHE_URL = "http://127.0.0.1:8765/trans-cache/v1/";
const TRANS_CACHE_ABORT_MS = 8000;
const REVIEWS_FEEDBACK_URL = "http://127.0.0.1:8765/reviews/v1/feedback";
const SIMILAR_ACCOUNTS_URL = "http://127.0.0.1:8765/ig-similar-accounts/v1/";
const TT_SIMILAR_ACCOUNTS_URL = "http://127.0.0.1:8765/tt-similar-accounts/v1/";
const SAVE_API_LIVE = "http://127.0.0.1:8765/save";
const SAVE_API_LIVE_VERSION = "v2";
const SAVE_API_STAGING = "http://127.0.0.1:8765/save";
const SAVE_API_HOST_KEY = "sortfeed_save_host";
const SAVE_API_TIKTOK_LIVE = "http://127.0.0.1:8765/save/tiktok";
const SAVE_API_TIKTOK_LIVE_VERSION = "v1";
const SAVE_API_TIKTOK_STAGING = "http://127.0.0.1:8765/save/tiktok";
const SAVE_STATUS_URL = "http://127.0.0.1:8765/save-status/v1/";
const SF_LIBRARY_KEY = "sort_feed_library";

// In-flight single transcribes, keyed `${tabId}:${jobId}` (jobId counters are
// per-tab, so two tabs can reuse the same number). Lets the Stop button abort
// the worker fetch; the refund then fires from the abort path.
const activeTransJobs = {};

// Client-generated job id — becomes the worker's trans_job_id, so a job can
// be refunded even when its response never arrived.
function makeClientJobId() {
  return "sf_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

// Fire-and-forget: undo the charge for a job whose result the user never got.
// Idempotent server-side (cancels a running job / refunds a finished one,
// at most once), so calling it for a job that never started is harmless.
function refundTransJob(workerBase, clientJobId, userID, reason) {
  try {
    fetch(workerBase + "refund", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trans_job_id: clientJobId, userID, reason }),
    }).catch(() => {});
  } catch {}
}

// Quota lookup that ONLY feeds the banner subtitle ("X of Y monthly mins
// left") — it runs in parallel with the job and never gates it; the v3 worker
// enforces the real limit server-side. msgType: TRANS_QUOTA_INFO (single) or
// MISSION_TRANS_STARTED (missions — their subtitle-update message).
function sendQuotaInfoToTab(tabId, jobId, userID, msgType) {
  if (tabId == null) return;
  fetch(TRANS_QUOTA_CHECK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userID }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data?.monthly_quota_mins == null) return;
      chrome.tabs.sendMessage(tabId, {
        type: msgType,
        jobId,
        monthly_quota_mins: data.monthly_quota_mins,
        monthly_usage_secs: data.monthly_usage_secs,
      });
    })
    .catch(() => {}); // subtitle is a nicety — never surface a failure for it
}

// Maps a failed worker fetch to an errorCode the content scripts can turn
// into a specific banner. Abort reasons are set by ctrl.abort("timeout") /
// ctrl.abort("cancelled").
function classifyTransFetchError(ctrl) {
  if (ctrl?.signal?.aborted) {
    return ctrl.signal.reason === "cancelled" ? "cancelled" : "timeout";
  }
  return navigator.onLine === false ? "offline" : "network";
}

// v6 limit replies. quota_exceeded = the user's own cap (fair-use daily or
// monthly, or the legacy plan's 150/month), busy = the site-wide brake,
// not_pro = the account isn't Pro any more (stale local state) → the same Get
// Pro banner the client gate shows. All three end the job on the limit path.
function _sfIsTransLimitReply(data) {
  const code = data?.errorCode;
  return code === "quota_exceeded" || code === "busy" || code === "not_pro";
}

// One field set for both message types: single transcribes read `data`,
// missions read `limitMessage`; `plan` drives the banner variant.
function _sfTransLimitFields(data) {
  const message = data?.remainderLimitReachedMessage || data?.message || "";
  return {
    data: message,
    limitMessage: message,
    plan: data?.errorCode === "not_pro" ? "free" : (data?.plan || null), // "fair_use" | "plan_limit" | "free"
    limitKind: data?.limitKind || (data?.errorCode === "busy" ? "site" : null),
    resetsOn: data?.resetsOn || null,
    limitMins: data?.usage?.monthly?.limit_mins ?? null,
  };
}

////////////////////////////////////////////////////////////////////////////////
// get user state based on userID (this function gets triggered by popup script)
////////////////////////////////////////////////////////////////////////////////

async function fetchUserStateFromWorker(userID) {
  return "pro";
}


////////////////////////////////////////////////////////////////////////////////
// save sort feed user id
////////////////////////////////////////////////////////////////////////////////
// listen to events coming from web-app 
////////////////////////////////////////////////////////////////////////////////

// The popup footer shows the user's first initial (sort_feed_user_profile).
// Only strings are kept, trimmed and capped; the popup renders them as text.
function profileFromPayload(userID, payload) {
  const clean = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  const name = clean(payload?.name, 120);
  const email = clean(payload?.email, 254);
  return name || email ? { userID, name, email } : null;
}

chrome.runtime.onMessageExternal.addListener((message) => {
  if (message?.type !== "SF_SET_USER_ID") return;

  const userID = message?.payload?.userID ?? null;

  if (userID === null) {
    chrome.storage.local.remove(["sort_feed_user_id", "sort_feed_user_profile", SF_LIBRARY_KEY]);
    // forward signed-out state to popup
    chrome.runtime.sendMessage({ type: "HANDLE_STATE_FROM_WEBSITE", userState: null });
  } else {
    // An older account site sends no name/email: keep whatever is stored. The
    // popup ignores a profile whose userID doesn't match the signed-in one.
    const profile = profileFromPayload(userID, message.payload);
    chrome.storage.local.set(
      profile ? { sort_feed_user_id: userID, sort_feed_user_profile: profile } : { sort_feed_user_id: userID }
    );
    // fetch real state then forward to popup
    fetchUserStateFromWorker(userID).then((userState) => {
      chrome.runtime.sendMessage({ type: "HANDLE_STATE_FROM_WEBSITE", userState });
    });
  }
});

// chrome.runtime.onMessageExternal.addListener((message) => {
//   if (message?.type !== "SF_SET_USER_ID") return;

//   const userID = message?.payload?.userID ?? null;

//   if (userID === null) {
//     // logout / clear
//     chrome.storage.local.remove("sort_feed_user_id");
//     // send message to popup? 
//   } else {
//     // login / set
//     chrome.storage.local.set({
//       sort_feed_user_id: userID,
//     });
//     // send message to popup? 
//   }
// });

// chrome.storage.local.get("sort_feed_user_id").then(console.log);


////////////////////////////////////////////////////////////////////////////////
// create or sync userID 
////////////////////////////////////////////////////////////////////////////////
// config and functions used to get metadata (legacy, chrome email, chrome id)
////////////////////////////////////////////////////////////////////////////////

// ---- config ----
// const CHECK_DELAYS = new Set([0, 2000, 4000, 6000]);
// let creatingUserId = false; // guard (prevents duplicate "create" runs)

// returns true or flase based on whether legacy pro flag was avaiable 
async function getLegacyProFlag() {
  try {
    const value = await getDBItem("userSortFeed"); // "Pro" or null/undefined
    return value === "Pro";
  } catch {
    return false; // IndexedDB not ready / not found
  }
}

// returns chrome email and chrome id 
function getChromeEmail() {
  return new Promise((resolve) => {
    chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (info) => {
      // info = { email: string, id: string } — id may still be empty
      resolve(info?.email || "");
    });
  });
}

async function removeLegacyFlagIndexDB() {
  try {
    await deleteDBItem("userSortFeed");   // ✨ CHANGED: deletes the key instead of reading it
    if (DEBUG) console.log("🗑️ Legacy flag removed successfully from IndexedDB");
    return { ok: true };
  } catch (err) {

    return { ok: false, error: String(err) };
  }
}

////////////////////////////////////////////////////////////////////////////////
// enter license key flow 
////////////////////////////////////////////////////////////////////////////////
// 02 update user from free to paid 
////////////////////////////////////////////////////////////////////////////////

// ✨ CHANGED: accept licenseKey and pass through to updateStateType
async function handleBackendUpdate(resp, licenseKey) {  // ✨ CHANGED: added licenseKey param
  if (!resp?.ok || !resp?.found ) {

    return;
  }

  if (DEBUG) console.log("✅ Running backend update for:", resp.row.userID);

  try {
    // ✨ CHANGED: pass licenseKey to the worker update call
    if (DEBUG) console.log('licenseKey STRING: ', licenseKey);
    const up = await updateStateType(resp.row.userID, licenseKey);  // ✨ CHANGED
    if (up?.ok && up.row) {
      if (DEBUG) console.log("🔄 Backend updated successfully:", up.row);

      const { userID, stateType, createdAt } = up.row;
      await saveSortFeedUser(userID, stateType, createdAt);
      if (DEBUG) console.log("💾 Saved locally:", { userID, stateType, createdAt });
    } else {

    }
  } catch (e) {

  }
}



////////////////////////////////////////////////////////////////////////////////
// enter license key flow 
////////////////////////////////////////////////////////////////////////////////
// 01 check that user is already in the server 
////////////////////////////////////////////////////////////////////////////////

// not needed anymore
async function checkUserOnServer(email) {
  // const CHECK_URL = "https://check-if-email-found.taher-el-sheikh.workers.dev/";
  // const CHECK_URL = "https://check-if-email-found.chrome-workers.com/";
  const CHECK_URL = "https://api.sortfeed.com/sortfeed-check-if-email-found";
  if (!email) return { ok: false, error: "missing-email" };

  try {
    const res = await fetch(CHECK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (!res.ok) {
      // e.g. 500, 404, etc.
      return { ok: false, error: `http-${res.status}` };
    }

    const json = await res.json();
    // Ensure we always return a shaped object
    return json || { ok: false, error: "empty-response" };
  } catch (err) {
    return { ok: false, error: err?.message || "fetch-failed" };
  }
}

////////////////////////////////////////////////////////////////////////////////
// create or sync userID 
////////////////////////////////////////////////////////////////////////////////
// save iid and metadata to local storage 
////////////////////////////////////////////////////////////////////////////////

async function saveSortFeedUser(userID, stateType, createdAt) {
  try {
    await chrome.storage.local.set({
      sortFeedUser: {
        userID,
        stateType,
        createdAt,
        cachedAt: Date.now(),
      },
    });
    return { ok: true };
  } catch (err) {

    return { ok: false, error: String(err) };
  }
}

////////////////////////////////////////////////////////////////////////////////
// create or sync userID 
////////////////////////////////////////////////////////////////////////////////
// server shows "free" but indexDB has legacy Pro flag → upgrade on server to "pro" and reuse userID 
////////////////////////////////////////////////////////////////////////////////

async function updateStateType(userID, licenseKey) {
  if (DEBUG) console.log('licenseKey STRING: ', licenseKey);
  // const url = "https://change-statetype-existing-userid.taher-el-sheikh.workers.dev/";
  // const url = "https://change-statetype-existing-userid.chrome-workers.com/";
  const url = "https://api.sortfeed.com/sortfeed-change-statetype-existing-userid";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userID, licenseKey}),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

////////////////////////////////////////////////////////////////////////////////
// create or sync userID 
////////////////////////////////////////////////////////////////////////////////
// create a random userID, this is triggered from install or update and save data into DB 
////////////////////////////////////////////////////////////////////////////////

// not needed anymore 
async function createUserIdInstallOrUpdate(createdAt, userChromeEmail) {
  // const url = "https://create-new-record-install-update.taher-el-sheikh.workers.dev/";
  const url = "https://api.sortfeed.com/sortfeed-create-new-record-install-update";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createdAt, userChromeEmail }),
    });

    const data = await res.json().catch(() => null);
    if (DEBUG) console.log("[worker response]", data);
    return data; // return to caller if you want to use it
  } catch (err) {

    return { ok: false, error: String(err) };
  }
}


////////////////////////////////////////////////////////////////////////////////
// create or sync userID 
////////////////////////////////////////////////////////////////////////////////
// handle installs and updates 
////////////////////////////////////////////////////////////////////////////////

// background.js (MV3 service worker)

async function handleUserIDChecks() {
  const userChromeEmail = await getChromeEmail();

  // 01 Check for email -- check that identity.email is available 
  if (!userChromeEmail) {
    if (DEBUG) console.log("email not found for user after update/install");
    return true;
  }

  // 02 Check server using email
  try {

    if (DEBUG) console.log("email found");
    if (DEBUG) console.log(userChromeEmail);

    // const res = await fetch("https://sortfeed-check-if-email-found.taher-el-sheikh.workers.dev/", {
    // const res = await fetch("https://check-if-email-found.chrome-workers.com/", {
    const res = await fetch("https://api.sortfeed.com/sortfeed-check-if-email-found", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: userChromeEmail }),
    });

    const json = await res.json();
    if (DEBUG) console.log(json);

    if (!json.ok) { 
      // error calling the check email function 

      return true;
    }

    // email found (server data found)
    if (json.found) {
              let serverData = json.row;
              if (DEBUG) console.log("server Data", serverData);

              const legacyPro = await getLegacyProFlag();
              if (DEBUG) console.log("legacy flag:", legacyPro);

              // Upgrade if needed, then use the UPDATED row
              if (legacyPro && serverData.stateType === "free") {
                try {
                  const up = await updateStateType(serverData.userID, "legacy");
                  if (up?.ok && up.row) {serverData = up.row; await removeLegacyFlagIndexDB(); }

                } catch (e) {

                }
              }

              // Save once using final server state
              await saveSortFeedUser(serverData.userID, serverData.stateType, serverData.createdAt);

              // Optional logs
              if (legacyPro) {
                if (DEBUG) console.log(serverData.stateType === "pro" ? "upgraded to pro" : "flag found & server already pro");
              } else {
                if (DEBUG) console.log("flag wasn't found");
              }
    }

    // email found (server data NOT found)
    else {
          if (DEBUG) console.log("Email Not Found");

          const createdAt = new Date().toISOString();
          const resp = await createUserIdInstallOrUpdate(createdAt, userChromeEmail);

          // only proceed if server created a row
          if (!resp?.ok || !resp.row) {

            return true;
          }

          let serverData = resp.row;

          // upgrade if legacy flag present and server is free
          const legacyPro = await getLegacyProFlag();
          if (legacyPro && serverData.stateType === "free") {
            try {
              const up = await updateStateType(serverData.userID, "legacy");
              if (up?.ok && up.row) { serverData = up.row; await removeLegacyFlagIndexDB();}

            } catch (e) {

            }
          }

          // save once using final server state
          await saveSortFeedUser(serverData.userID, serverData.stateType, serverData.createdAt);
  }


  } catch (e) {

  }

  return true;
}

////////////////////////////////////////////////////////////////////////////////
// Show Pin Website on Install
////////////////////////////////////////////////////////////////////////////////

chrome.runtime.onInstalled.addListener(async function (details) {
  // Reviews: remember the first moment we knew about this user. Written once,
  // never overwritten — an update on top of an older install keeps the older
  // date; an existing user receiving this version gets the update date.
  try {
    const { sortfeed_reviews } = await chrome.storage.local.get("sortfeed_reviews");
    const cur = sortfeed_reviews && typeof sortfeed_reviews === "object" ? sortfeed_reviews : {};
    const next = { v: 1, ...cur };
    if (!next.installedAt) next.installedAt = Date.now();
    // installId: a random per-install token with no identity behind it. Lets
    // the feedback route group / rate-limit a signed-out user's rows.
    if (!next.installId) next.installId = crypto.randomUUID();
    if (next.installedAt !== cur.installedAt || next.installId !== cur.installId) {
      await chrome.storage.local.set({ sortfeed_reviews: next });
    }
  } catch (_) {}

  ensureViralSpyProState();
  if (details.reason === "install") {
    // ViralSpy: no external marketing tab on install
  } 
  else if (details.reason === "update") {
    // await handleUserIDChecks();
  }
});

// chrome.runtime.onStartup.addListener(() => scheduleUserIdChecks());

// ////////////////////////////////////////////////////////////////////////////////
// // create or sync userID 
// ////////////////////////////////////////////////////////////////////////////////
// // 02 check if sync or legacy flag is found, else created new userID
// ////////////////////////////////////////////////////////////////////////////////

// async function ensureUserId(delay) {
//   console.log("ensureUserId @:", delay);

//   // 1) Check sync storage
//   const { sortFeedUserID } = await chrome.storage.sync.get("sortFeedUserID");
//   if (sortFeedUserID) {
//     console.log("userID found, don't do anything");
//     return true;
//   }

//   // 2) Check legacy flag
//   const legacyPro = await getLegacyProFlag();

//   // 3) For 0/2/4/6s: just observe/log and exit
//   if (CHECK_DELAYS.has(delay)) {
//     console.log(
//       legacyPro
//         ? "legacy flag present, but still waiting for sync!"
//         : "legacy flag not found, but still waiting for sync!"
//     );
//     return false;
//   }

//   // 4) For 8s (or later): if this is ture is skips the try and finally functions. Avoid creating userID when function is in flight 
//   if (creatingUserId) {
//     console.log("create already in flight — skipping");
//     return false;
//   }

//   creatingUserId = true;

//   try {

//     console.log("create new userID");

//     // create user metadata object 
//     const createdAt = new Date().toISOString();
//     const email = await getChromeEmail();
//     const data = {
//       userID: null, 
//       licenseKey: null,
//       legacyPro: legacyPro,
//       createdAt: createdAt,
//       userChromeEmail: email
//     };

//     // send object to cloudflare (create userID function)
//     const resp = await postUserData(data);            // ⬅️ await here
//     // console.log(data); 
//     console.log("Worker response:", resp);
//     return true;    
//   } 
  
//   finally {
//     creatingUserId = false;
//   }
// }


////////////////////////////////////////////////////////////////////////////////
// adding tiktok code 
////////////////////////////////////////////////////////////////////////////////

// chrome.webNavigation.onCommitted.addListener(async (details) => {

//   if (!details.url.includes("tiktok.com")) return;
//   if (details.frameId !== 0) return; // main frame only

//   await chrome.scripting.executeScript({
//     target: { tabId: details.tabId },
//     world: "MAIN",
//     files: [
//       "Tiktok/script_tiktok.js",
//       "Tiktok/download_function.js"
//     ]
//   });

// });


////////////////////////////////////////////////////////////////////////////////
// Popup is declared via manifest.json "default_popup": "popup.html".
// Do NOT call chrome.action.setPopup inside chrome.tabs.onUpdated, as mutating
// the active tab's action popup during New Tab creation steals omnibox focus.
////////////////////////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////////////////////////
// save data into indexDB
////////////////////////////////////////////////////////////////////////////////

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("SortFeedDB", 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function setDBItem(key, value) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  });
}

function getDBItem(key) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readonly");
      const req = tx.objectStore("settings").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}

function deleteDBItem(key) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      const req = tx.objectStore("settings").delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });
}

////////////////////////////////////////////////////////////////////////////////
// check if user is pro
////////////////////////////////////////////////////////////////////////////////

// function checkUserStatus(sendResponse) {
//   getDBItem("userSortFeed")
//     .then((value) => {
//       const isPro = value === "Pro";
//       sendResponse({ isPro });
//     })
//     .catch(() => {
//       sendResponse({ isPro: false });
//     });
//   return true; // keep message channel open
// }

function checkUserStatusNew(sendResponse) {
  sendResponse({ isPro: true });
  return true;
}

////////////////////////////////////////////////////////////////////////////////
// select mission transcription
////////////////////////////////////////////////////////////////////////////////

const missionAbortControllers = {};

// Shared mission job runner — IG and TikTok differ only in worker URL and
// payload shape. Sends MISSION_TRANS_RESULT / MISSION_TRANS_ERROR /
// MISSION_TRANS_LIMIT; quota subtitle arrives separately via
// sendQuotaInfoToTab (fired once per mission from the message handlers).
async function _runMissionTransJob(workerBase, bodyPayload, jobId, userID, tabId) {
  const clientJobId = makeClientJobId();
  const ctrl = new AbortController();
  missionAbortControllers[jobId] = ctrl;
  const t = setTimeout(() => ctrl.abort("timeout"), TRANS_WORKER_ABORT_MS);
  const keepalive = startSwKeepalive();

  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "MISSION_TRANS_LOADING", jobId });

  try {
    const res = await fetch(workerBase, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...bodyPayload, userID, clientJobId, surface: "mission" }),
      signal: ctrl.signal,
    });

    const data = await res.json().catch(() => ({}));

    // Server-side limit (cap, site brake or not-Pro) — stop the whole mission,
    // same UX as the old pre-check path; the content script picks the banner
    // variant from `plan`.
    if (_sfIsTransLimitReply(data)) {
      if (tabId != null) chrome.tabs.sendMessage(tabId, {
        type: "MISSION_TRANS_LIMIT",
        jobId,
        ..._sfTransLimitFields(data),
      });
      return;
    }

    const transcription = (data?.transcription || "").trim();
    if (!res.ok || data?.ok === false || !transcription) {
      if (tabId != null) chrome.tabs.sendMessage(tabId, {
        type: "MISSION_TRANS_ERROR",
        jobId,
        errorCode: data?.errorCode || (res.ok ? "empty_transcript" : "internal_error"),
      });
      return;
    }

    if (tabId != null) chrome.tabs.sendMessage(tabId, {
      type: "MISSION_TRANS_RESULT",
      transcription,
      partial: !!data.partial,
      jobId,
    });
  } catch (e) {
    const errorCode = classifyTransFetchError(ctrl);
    // The worker may still finish and charge server-side — refund what the
    // user never received. No-op if the job never reached the worker.
    refundTransJob(workerBase, clientJobId, userID, errorCode);
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "MISSION_TRANS_ERROR", jobId, errorCode });
  } finally {
    clearTimeout(t);
    clearInterval(keepalive);
    delete missionAbortControllers[jobId];
  }
}

function startMissionTranscriptionJobTikTok(
  ReelType, ReelBase64, jobId, userID, tabId,
  reelIdUi, platform, profileName,
  ReelURL = null, partialHint = false
) {
  const bodyPayload = { ReelType, reelIdUi, platform, profileName };
  if (ReelURL) bodyPayload.ReelURL = ReelURL;
  else bodyPayload.ReelBase64 = ReelBase64;
  if (partialHint) bodyPayload.partialHint = true; // v6 never caches a cut-short file
  return _runMissionTransJob(TRANS_WORKER_URL_TIKTOK, bodyPayload, jobId, userID, tabId);
}

function startMissionTranscriptionJob(
  ReelType, ReelURL, jobId, userID, tabId,
  reelIdUi, platform, profileName,
  ReelBase64 = null, isPrivate = null, partialHint = false
) {
  const bodyPayload = { ReelType, reelIdUi, platform, profileName };
  if (typeof isPrivate === "boolean") bodyPayload.isPrivate = isPrivate;
  if (partialHint) bodyPayload.partialHint = true;
  if (ReelBase64) bodyPayload.ReelBase64 = ReelBase64;
  else bodyPayload.ReelURL = ReelURL;
  return _runMissionTransJob(TRANS_WORKER_URL_IG, bodyPayload, jobId, userID, tabId);
}

// Facebook mission — URL path (dashAudio/progressive) primary; base64 accepted
// for parity with the single-item runner, though the FB mission only sends URLs.
function startMissionTranscriptionJobFacebook(
  ReelType, ReelBase64, jobId, userID, tabId,
  reelIdUi, platform, profileName,
  ReelURL = null
) {
  const bodyPayload = { ReelType, reelIdUi, platform, profileName };
  if (ReelURL) bodyPayload.ReelURL = ReelURL;
  else bodyPayload.ReelBase64 = ReelBase64;
  return _runMissionTransJob(TRANS_WORKER_URL_FB, bodyPayload, jobId, userID, tabId);
}

////////////////////////////////////////////////////////////////////////////////
// tranascitpion feature
////////////////////////////////////////////////////////////////////////////////
// start trans job assuming job is still in limit
////////////////////////////////////////////////////////////////////////////////

// Shared single-transcribe runner (v3). Quota is enforced by the worker; the
// subtitle quota lookup runs in parallel via sendQuotaInfoToTab. partialHint
// is set when the CONTENT script already truncated the media (TikTok base64
// fallback) so the partial banner shows even though the worker saw a
// complete-looking file.
async function _runSingleTransJob(workerBase, bodyPayload, jobId, userID, tabId, partialHint = false) {
  const clientJobId = makeClientJobId();
  const ctrl = new AbortController();
  const jobKey = `${tabId}:${jobId}`;
  activeTransJobs[jobKey] = { ctrl, clientJobId, userID, workerBase };
  const t = setTimeout(() => ctrl.abort("timeout"), TRANS_WORKER_ABORT_MS);
  const keepalive = startSwKeepalive();

  // clientJobId rides along so the content script can request a refund even
  // if this service worker dies mid-job (its safety timeout wakes a fresh one).
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "TRANS_STARTED", jobId, clientJobId });
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "TRANS_LOADING", jobId });
  // (quota subtitle: requested by the content script at click time via
  // fetchTransQuotaInfo — not here, so it shows before media resolution)

  try {
    const res = await fetch(workerBase, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...bodyPayload, userID, clientJobId, surface: "single" }),
      signal: ctrl.signal,
    });

    const data = await res.json().catch(() => ({}));

    // Server-side limit (cap, site brake or not-Pro) → limit-banner path; the
    // content script picks the banner variant from `plan`.
    if (_sfIsTransLimitReply(data)) {
      if (tabId != null) chrome.tabs.sendMessage(tabId, {
        type: "TRANS_LIMIT_REACHED",
        jobId,
        ..._sfTransLimitFields(data),
      });
      return;
    }

    const transcription = (data?.transcription || "").trim();
    if (!res.ok || data?.ok === false || !transcription) {
      if (tabId != null) chrome.tabs.sendMessage(tabId, {
        type: "TRANSCRIPTION_ERROR",
        errorCode: data?.errorCode || (res.ok ? "empty_transcript" : "internal_error"),
        error: data?.message || `HTTP ${res.status}`,
        jobId,
      });
      return;
    }

    if (tabId != null) chrome.tabs.sendMessage(tabId, {
      type: "TRANSCRIPTION_RESULT",
      data: {
        ReelType: data.ReelType,
        ReelURL: data.ReelURL,
        transcription,
        partial: !!data.partial || partialHint,
        duration_seconds: data.duration_seconds,
        // Whisper segments ({ start, end, text }) — drives "Copy with
        // timestamps". Absent on workers that predate the field.
        segments: Array.isArray(data.segments) ? data.segments : null,
      },
      jobId,
    });
  } catch (e) {
    const errorCode = classifyTransFetchError(ctrl);
    // The worker may still finish and charge server-side — refund what the
    // user never received. No-op if the job never reached the worker.
    refundTransJob(workerBase, clientJobId, userID, errorCode);
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "TRANSCRIPTION_ERROR", errorCode, error: e?.message || String(e), jobId });
  } finally {
    clearTimeout(t);
    clearInterval(keepalive);
    delete activeTransJobs[jobKey];
  }
}

// IG — URL path is primary. ReelBase64 arrives only on the browser-fallback
// retry, when our edge couldn't reach the CDN host the viewer's browser can.
function startTranscriptionJob(
  ReelType, ReelURL, jobId, userID, tabId,
  reelIdUi, platform, profileName,
  ReelBase64 = null, partialHint = false, isPrivate = null
) {
  const bodyPayload = { ReelType, reelIdUi, platform, profileName };
  // v7 caches only a post reported as public, and never a cut-short file.
  if (typeof isPrivate === "boolean") bodyPayload.isPrivate = isPrivate;
  if (partialHint) bodyPayload.partialHint = true;
  if (ReelBase64) bodyPayload.ReelBase64 = ReelBase64;
  else bodyPayload.ReelURL = ReelURL;
  return _runSingleTransJob(TRANS_WORKER_URL_IG, bodyPayload, jobId, userID, tabId, !!partialHint);
}

function startTranscriptionJobTikTok(
  ReelType, ReelBase64, jobId, userID, tabId,
  reelIdUi, platform, profileName,
  ReelURL = null, partialHint = false
) {
  const bodyPayload = { ReelType, reelIdUi, platform, profileName };
  if (ReelURL) bodyPayload.ReelURL = ReelURL;
  else bodyPayload.ReelBase64 = ReelBase64;
  if (partialHint) bodyPayload.partialHint = true; // v6 never caches a cut-short file
  return _runSingleTransJob(TRANS_WORKER_URL_TIKTOK, bodyPayload, jobId, userID, tabId, partialHint);
}

// Facebook is IG-style (worker fetches the audio URL) but built on the TikTok
// runner because it keeps the ReelBase64 fallback as insurance. URL path is
// primary; base64 only if the worker can't fetch fbcdn (FB research §6).
function startTranscriptionJobFacebook(
  ReelType, ReelBase64, jobId, userID, tabId,
  reelIdUi, platform, profileName,
  ReelURL = null, partialHint = false
) {
  const bodyPayload = { ReelType, reelIdUi, platform, profileName };
  if (ReelURL) bodyPayload.ReelURL = ReelURL;
  else bodyPayload.ReelBase64 = ReelBase64;
  return _runSingleTransJob(TRANS_WORKER_URL_FB, bodyPayload, jobId, userID, tabId, partialHint);
}

////////////////////////////////////////////////////////////////////////////////
// check if user is pro vs free 
////////////////////////////////////////////////////////////////////////////////

async function isUserSortFeedPro() {
  return true;
}

// Auto-recovers tabs that were already open before an extension reload/update:
// if `chrome.tabs.sendMessage` hits "Receiving end does not exist", sets the
// sort sessionStorage keys via `chrome.scripting.executeScript` and reloads/navigates
// the tab so `document_start` content scripts attach and run the sort immediately.
function sendSortMessageWithAutoReload(tab, payload, platform) {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, payload, () => {
    const err = chrome.runtime.lastError;
    if (!err || !/Receiving end does not exist/i.test(err.message || "")) return;
    try {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [payload, platform],
        func: (msg, plat) => {
          try {
            if (plat === "ig") {
              const parts = location.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
              const reserved = new Set(["explore", "reels", "reel", "p", "tv", "stories", "direct", "accounts", "challenge", "about", "legal", "developer"]);
              const isExplore = /^\/explore\/search\//.test(location.pathname);
              const isSaved = /^\/[^/]+\/saved(?:\/|$)/.test(location.pathname);
              const isProfile = parts.length >= 1 && !reserved.has((parts[0] || "").toLowerCase());

              sessionStorage.removeItem("sortFeedData");
              sessionStorage.removeItem("sortFeedStopSorting");
              sessionStorage.setItem("sortFeedSortBy", msg.sort_by);
              sessionStorage.setItem("sortFeedNoItems", msg.no_items);
              sessionStorage.setItem("sortFeedStatus", "true");
              sessionStorage.setItem("sortItemsVsDates", msg.dates_items);

              if (isExplore) {
                sessionStorage.setItem("sortFeedSurface", "explore_search");
                sessionStorage.setItem("sortFeedPostsVSReels", "Posts");
                sessionStorage.setItem("sortFeedPrepLabel", "search");
                location.reload();
                return;
              }
              if (isSaved) {
                sessionStorage.setItem("sortFeedSurface", "saved");
                sessionStorage.setItem("sortFeedPostsVSReels", "Posts");
                sessionStorage.setItem("sortFeedPrepLabel", "saved");
                location.reload();
                return;
              }
              if (isProfile) {
                sessionStorage.removeItem("sortFeedSurface");
                const sub = (parts[1] || "").toLowerCase();
                const goReels = sub === "reels" || msg.sort_by === "views";
                sessionStorage.setItem("sortFeedPostsVSReels", goReels ? "Reels" : "Posts");
                if (msg.outlier_scores) sessionStorage.setItem("sortFeedOutlier", "on");
                else sessionStorage.removeItem("sortFeedOutlier");
                sessionStorage.setItem("sortFeedPrepLabel", "profile");
                if (goReels && sub !== "reels") {
                  location.href = "/" + parts[0] + "/reels/";
                } else {
                  location.reload();
                }
                return;
              }
            } else if (plat === "tt") {
              sessionStorage.removeItem("sortFeedData");
              sessionStorage.removeItem("sortFeedStopSorting");
              sessionStorage.setItem("sortFeedSortBy", msg.sort_by);
              sessionStorage.setItem("sortFeedNoItems", msg.no_items);
              sessionStorage.setItem("sortFeedStatusTikTok", "true");
              sessionStorage.setItem("sortItemsVsDates", msg.dates_items);
              if (msg.outlier_scores) sessionStorage.setItem("sortFeedOutlierTikTok", "on");
              else sessionStorage.removeItem("sortFeedOutlierTikTok");
              location.reload();
              return;
            }
            location.reload();
          } catch (_) {
            location.reload();
          }
        },
      });
    } catch (_) {}
  });
}


////////////////////////////////////////////////////////////////////////////////
// handel message coming from content script
////////////////////////////////////////////////////////////////////////////////

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  
  if (message?.type === "GET_STATE_BASED_USERID") {
    (async () => {
      const userID = message?.userID ?? null;
      const userState = await fetchUserStateFromWorker(userID);

      sendResponse({
        type: "HANDLE_STATE_BASED_USERID",
        userState, // "free" | "pro" | "legacy" | null
      });
    })();

    return true; // IMPORTANT: keep channel open for async sendResponse
  }
  
  // sorting Instagram 
  if (message.refresh === "ON") {
  (async () => {
    const isPro = await isUserSortFeedPro();

    const isItemOnly = message.dates_items === "items";
    const isReels25 = message.no_items === "25_reels";
    const isDateOnly = message.dates_items === "dates";
    const isWeek1 = message.no_items === "1_week";

    const allowItemRefresh = isItemOnly && (isReels25 || isPro);
    const allowDateRefresh = isDateOnly && (isWeek1 || isPro);

    if (allowItemRefresh || allowDateRefresh) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        sendSortMessageWithAutoReload(
          tabs?.[0],
          {
            action: "refreshPage",
            sort_by: message.sort_by,
            no_items: message.no_items,
            dates_items: message.dates_items,
            outlier_scores: message.outlier_scores === true,
          },
          "ig"
        );
      });
    }
  })();

  return true;
  }

  // sorting tiktok 
  else if (message.refresh === "ON_TikTok") {
  (async () => {
    const isPro = await isUserSortFeedPro();

    const isItemOnly = message.dates_items === "items";
    const isReels25 = message.no_items === "25_reels";
    const isDateOnly = message.dates_items === "dates";
    const isWeek1 = message.no_items === "1_week";

    const allowItemRefresh = isItemOnly && (isReels25 || isPro);
    const allowDateRefresh = isDateOnly && (isWeek1 || isPro);

    if (allowItemRefresh || allowDateRefresh) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        sendSortMessageWithAutoReload(
          tabs?.[0],
          {
            action: "refreshPageTikTok",
            sort_by: message.sort_by,
            no_items: message.no_items,
            dates_items: message.dates_items,
            outlier_scores: message.outlier_scores === true,
          },
          "tt"
        );
      });
    }
  })();

  return true;
  }

  // sorting facebook
  else if (message.refresh === "ON_Facebook") {
  (async () => {
    const isPro = await isUserSortFeedPro();

    const isItemOnly = message.dates_items === "items";
    const isReels25 = message.no_items === "25_reels";
    const isDateOnly = message.dates_items === "dates";
    const isWeek1 = message.no_items === "1_week";

    const allowItemRefresh = isItemOnly && (isReels25 || isPro);
    const allowDateRefresh = isDateOnly && (isWeek1 || isPro);

    if (allowItemRefresh || allowDateRefresh) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        sendSortMessageWithAutoReload(
          tabs?.[0],
          {
            action: "refreshPageFacebook",
            sort_by: message.sort_by,
            no_items: message.no_items,
            dates_items: message.dates_items,
            outlier_scores: message.outlier_scores === true,
          },
          "fb"
        );
      });
    }
  })();

  return true;
  }

  // sorting youtube — Pro-gated exactly like Instagram/TikTok/Facebook: free
  // users may only run "Latest 25" (items) or "1 week" (dates); anything larger
  // requires Pro. The popup already locks the dropdowns to those presets for free
  // users (popup_subs.js); this is the enforcement layer.
  else if (message.refresh === "ON_YouTube") {
  (async () => {
    const isPro = await isUserSortFeedPro();

    const isItemOnly = message.dates_items === "items";
    const isReels25 = message.no_items === "25_reels";
    const isDateOnly = message.dates_items === "dates";
    const isWeek1 = message.no_items === "1_week";

    const allowItemRefresh = isItemOnly && (isReels25 || isPro);
    const allowDateRefresh = isDateOnly && (isWeek1 || isPro);

    if (allowItemRefresh || allowDateRefresh) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        sendSortMessageWithAutoReload(
          tabs?.[0],
          {
            action: "refreshPageYouTube",
            sort_by: message.sort_by,
            no_items: message.no_items,
            dates_items: message.dates_items,
            outlier_scores: message.outlier_scores === true,
          },
          "yt"
        );
      });
    }
  })();

  return true;
  }

  // // sorting items for Instagram
  // if (message.refresh === "ON") {
  //   checkUserStatusNew(({ isPro }) => {
  //     const isItemOnly = message.dates_items === "items";
  //     const isReels25 = message.no_items === "25_reels";
  //     const isDateOnly = message.dates_items === "dates";
  //     const isWeek1 = message.no_items === "1_week";

  //     const allowItemRefresh = isItemOnly && (isReels25 || isPro);
  //     const allowDateRefresh = isDateOnly && (isWeek1 || isPro);

  //     if (allowItemRefresh || allowDateRefresh) {
  //       chrome.tabs.query(
  //         { active: true, currentWindow: true },
  //         function (tabs) {
  //           chrome.tabs.sendMessage(tabs[0].id, {
  //             action: "refreshPage",
  //             sort_by: message.sort_by,
  //             no_items: message.no_items,
  //             dates_items: message.dates_items,
  //           });
  //         },
  //       );
  //     }
  //   });
  //   return true; // keep message channel open for async sendResponse
  // }

  // // sorting items for tiktok
  // else if (message.refresh === "ON_TikTok") {
  //   checkUserStatusNew(({ isPro }) => {
  //     const isItemOnly = message.dates_items === "items";
  //     const isReels25 = message.no_items === "25_reels";
  //     const isDateOnly = message.dates_items === "dates";
  //     const isWeek1 = message.no_items === "1_week";

  //     const allowItemRefresh = isItemOnly && (isReels25 || isPro);
  //     const allowDateRefresh = isDateOnly && (isWeek1 || isPro);

  //     if (allowItemRefresh || allowDateRefresh) {
  //       chrome.tabs.query(
  //         { active: true, currentWindow: true },
  //         function (tabs) {
  //           if (DEBUG) console.log("refreshPageTikTok");
  //           chrome.tabs.sendMessage(tabs[0].id, {
  //             action: "refreshPageTikTok",
  //             sort_by: message.sort_by,
  //             no_items: message.no_items,
  //             dates_items: message.dates_items,
  //           });
  //         },
  //       );
  //     }
  //   });
  //   return true;
  // }

  // if error recieved from (new_refresh_key_changed.js) then send error message to popup.js
  else if (message.sort_feed_error) {
    if (DEBUG) console.log("SEND ERROR");
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      chrome.tabs.sendMessage(tabs[0].id, {
        sort_feed_error: true,
        error_type: message.error_type,
      });
    });
  }

  // if animate logo was recieved from (new_errors_overlay.js)
  else if (message.logo_animate_on) {
    chrome.tabs.query(
      { active: true, currentWindow: true },

      function (tabs) {
        if (DEBUG) console.log("logo ON");
        chrome.tabs.sendMessage(tabs[0].id, { logo_animate_on: true });
      },
    );
  }

  // tiktok scroll
  else if (message.message === "scroll tiktok") {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      chrome.tabs.sendMessage(tabs[0].id, { message: "scroll tiktok" });
    });
  }

  // received items collected no
  else if (message.item_collected_no) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (DEBUG) console.log("ITEMS COLLECTED");
      if (DEBUG) console.log(message.item_collected_no);
      if (DEBUG) console.log(message.number_items);
      chrome.tabs.sendMessage(tabs[0].id, {
        item_collected_no: true,
        number_items: message.number_items,
      });
    });
  }

  // if animate logo was recieved from (new_refresh_key_changed.js)
  else if (message.logo_animate_off) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (DEBUG) console.log("logo OFF");
      chrome.tabs.sendMessage(tabs[0].id, { logo_animate_off: true });
    });
  }

  // export click from instagram
  else if (message.export_click) {
    if (DEBUG) console.log("export click from background");

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      chrome.tabs.sendMessage(tabs[0].id, {
        export_click_background: true,
        posts_vs_reels: message.posts_vs_reels,
        sorted_data: message.sorted_data,
        export_format: message.export_format,
      });
    });
  } 
  
  // export click from tiktok
  else if (message.export_click_tiktok) {
    if (DEBUG) console.log("export click from background");

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      chrome.tabs.sendMessage(tabs[0].id, {
        export_click_background_tiktok: true,
        posts_vs_reels: message.posts_vs_reels,
        sorted_data: message.sorted_data,
        export_format: message.export_format,
      });
    });
  }

// In your onMessage listener:
else if (message?.type === "CHECK_SERVER_USER") {
  (async () => {
    try {
      const resp = await checkUserOnServer(message.email);
      sendResponse(resp); // respond to content script quickly

      // 🆕 NEW: pass the licenseKey to the backend upgrade path
      if (DEBUG) console.log('licenseKey STRING: ', message.licenseKey); 
      handleBackendUpdate(resp, message.licenseKey);  // ✨ CHANGED: added licenseKey
    } catch (err) {

      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep message channel open for async response
}

else if (message.type === "GET_CHROME_EMAIL") {
    chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, (info) => {
      const email = info?.email || "";
      sendResponse({ email });
    });
    return true; // keep channel open for async response
  }

// v3: no blocking quota pre-check — the worker enforces quota server-side and
// the banner subtitle gets its numbers from a parallel sendQuotaInfoToTab
// inside the job runner. partialHint = the content script truncated the video
// locally (base64 fallback for over-long TikToks).
else if (message.command === "TikTokReelTranscribe") {
  const { ReelType, ReelBase64, jobId, userID, platform, reelIdUi, profileName, partialHint } = message;
  const tabId = sender?.tab?.id ?? null;
  startTranscriptionJobTikTok(ReelType, ReelBase64, jobId, userID, tabId, reelIdUi, platform, profileName, null, !!partialHint);
}

else if (message.command === "TikTokURLTranscribe") {
  const { ReelType, ReelURL, jobId, userID, platform, reelIdUi, profileName } = message;
  const tabId = sender?.tab?.id ?? null;
  startTranscriptionJobTikTok(ReelType, null, jobId, userID, tabId, reelIdUi, platform, profileName, ReelURL);
}

// Facebook — URL path (primary): worker fetches the resolved fbcdn audio URL.
else if (message.command === "FacebookURLTranscribe") {
  const { ReelType, ReelURL, jobId, userID, platform, reelIdUi, profileName } = message;
  const tabId = sender?.tab?.id ?? null;
  startTranscriptionJobFacebook(ReelType, null, jobId, userID, tabId, reelIdUi, platform, profileName, ReelURL);
}

// Facebook — base64 fallback (insurance): content script downloaded the bytes.
else if (message.command === "FacebookReelTranscribe") {
  const { ReelType, ReelBase64, jobId, userID, platform, reelIdUi, profileName, partialHint } = message;
  const tabId = sender?.tab?.id ?? null;
  startTranscriptionJobFacebook(ReelType, ReelBase64, jobId, userID, tabId, reelIdUi, platform, profileName, null, !!partialHint);
}


    // instagram transcibe — v3: worker enforces quota, no blocking pre-check
    else if (message.command === "InstagramReelTranscribe") {
      const { ReelType, ReelURL, ReelBase64, partialHint, isPrivate, jobId, userID, platform, reelIdUi, profileName } = message;
      const tabId = sender?.tab?.id ?? null;
      if (DEBUG) console.log("InstagramReelTranscribe:", { userID, reelIdUi, platform, profileName, isPrivate, viaFallback: !!ReelBase64 });
      startTranscriptionJob(ReelType, ReelURL, jobId, userID, tabId, reelIdUi, platform, profileName, ReelBase64 || null, !!partialHint, isPrivate);
    }



  else if (message.page_loaded) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (DEBUG) console.log("page_loaded_completed");
      chrome.tabs.sendMessage(tabs[0].id, { page_loaded_completed: "ON" });
    });
  } 
  
  else if (message.action === "forwardMessage") {
    if (DEBUG) console.log("Message received in Content Script A");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { action: "receiveMessage" });
    });
  } 
  
  
  else if (message.type === "OPEN_TAB_GSHEETS") {
    chrome.tabs.create({ url: message.url });
  }

  // The sorted tile's ↗ button (Instagram Profile Reels). Opens the post in a
  // BACKGROUND tab: the point of the button is to stash a post for later
  // without losing the feed you are sorting, so stealing focus defeats it.
  //
  // This has to run here rather than in the content script. window.open()
  // always focuses the tab it creates, and the usual trick — dispatching a
  // synthetic ctrl/cmd+click on an anchor — is an untrusted event, which Chrome
  // does not honour for modifier-click tab behaviour. chrome.tabs.create with
  // active:false is the only reliable route, and it needs the service worker.
  // ("tabs" is already in the manifest; create() alone wouldn't even need it.)
  else if (message.type === "SF_REVIEWS_FEEDBACK") {
    // Reviews card → "Not great" → Send. Enrich with what only the background
    // knows (userID, plan, version, installId) and post to the worker. The card
    // already moved on to "Thanks for sharing"; this is fire-and-forget.
    (async () => {
      try {
        const got = await chrome.storage.local.get(["sort_feed_user_id", "sort_feed_state_type_flag", "sortfeed_reviews"]);
        const payload = {
          text: String(message.text || "").trim().slice(0, 500),
          platform: message.platform || "instagram",
          surface: message.surface || null,
          plan: got.sort_feed_state_type_flag || "free",
          extVersion: chrome.runtime.getManifest().version,
          userID: got.sort_feed_user_id || null,
          installId: got.sortfeed_reviews?.installId || null,
        };
        if (!payload.text) return sendResponse({ ok: false, error: "empty" });
        const res = await fetch(REVIEWS_FEEDBACK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => null);
        if (DEBUG) console.log("[reviews feedback]", res.status, data);
        sendResponse({ ok: res.ok, status: res.status });
      } catch (err) {
        if (DEBUG) console.warn("[reviews feedback] failed", err);
        try { sendResponse({ ok: false, error: String(err) }); } catch (_) {}
      }
    })();
    return true; // async sendResponse
  }
  else if (message.type === "SF_SAVE_API") {
    // ViralSpy Unified Two-Way Save Sync: routes Instagram & TikTok saves directly to local Studio Hub (127.0.0.1:8765)
    (async () => {
      try {
        const got = await chrome.storage.local.get(["sort_feed_user_id", "sortFeedUser"]);
        const userID = got.sort_feed_user_id || got.sortFeedUser?.userID || "viralspy_local_pro";
        const path = String(message.path || "").replace(/^\/+/, "");
        if (!/^posts(\/(unsave|lookup))?$/.test(path)) return sendResponse({ ok: false, error: "BAD_PATH" });
        const senderUrl = String(sender?.tab?.url || "");
        const inferredPlatform = message.body?.platform || (/tiktok\.com/i.test(senderUrl) ? "tiktok" : "instagram");
        const host = SAVE_API_LIVE;
        const endpoint = `${SAVE_API_LIVE}/${SAVE_API_LIVE_VERSION}/${path}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        let res;
        try {
          res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              Object.assign(
                { platform: inferredPlatform },
                message.body && typeof message.body === "object" ? message.body : {},
                { sort_feed_user_id: userID }
              )
            ),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        const data = await res.json().catch(() => null);
        if (DEBUG) console.log("[save]", path, res.status, data);
        if (path === "posts" && data?.ok) chrome.storage.local.set({ [SF_LIBRARY_KEY]: { userID, hasLibrary: true } });
        sendResponse(data && typeof data === "object" ? Object.assign(data, { status: res.status, host }) : { ok: false, error: "UPSTREAM", status: res.status });
      } catch (err) {
        if (DEBUG) console.warn("[save] failed", err);
        try { sendResponse({ ok: false, error: "NETWORK", message: "Start ViralSpy Studio Hub on 127.0.0.1:8765" }); } catch (_) {}
      }
    })();
    return true; // async sendResponse
  }
  else if (message.type === "VS_REPRODUCE_VIDEO") {
    // One-Shot VideoBot Reproduce Pack from Instagram / TikTok overlay button
    (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 240000);
        let res;
        try {
          res = await fetch("http://127.0.0.1:8765/api/reproduce", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message.payload || {}),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        const data = await res.json().catch(() => null);
        sendResponse(data && typeof data === "object" ? data : { ok: false, message: "Reproduce engine returned invalid JSON." });
      } catch (err) {
        try {
          sendResponse({
            ok: false,
            message: "Could not reach ViralSpy Studio Hub on 127.0.0.1:8765.",
          });
        } catch (_) {}
      }
    })();
    return true;
  }
  else if (message.type === "VS_INGEST_POSTS") {
    // Auto-archive all in-page sorted posts permanently into ViralSpy Master Database
    (async () => {
      try {
        const res = await fetch("http://127.0.0.1:8765/api/db/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message.payload || {}),
        });
        const data = await res.json().catch(() => ({ ok: false }));
        sendResponse(data);
      } catch (_) {
        try { sendResponse({ ok: false }); } catch (_) {}
      }
    })();
    return true;
  }
  else if (message.type === "VS_OPEN_STUDIO") {
    (async () => {
      const hash = String(message.hash || "#videodb");
      const targetUrl = `http://127.0.0.1:8765/dashboard${hash.startsWith("#") ? hash : "#" + hash}`;
      try {
        const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:8765/*" });
        if (tabs && tabs.length > 0) {
          await chrome.tabs.update(tabs[0].id, { url: targetUrl, active: true });
          await chrome.windows.update(tabs[0].windowId, { focused: true });
        } else {
          await chrome.tabs.create({ url: targetUrl, active: true });
        }
        sendResponse({ ok: true });
      } catch (e) {
        try { sendResponse({ ok: false }); } catch (_) {}
      }
    })();
    return true;
  }
  else if (message.type === "SF_LIBRARY_STATUS") {
    // The popup asks on every open (signed in only). The answer is stored, not returned: the popup draws from
    // `sort_feed_library` and redraws when it changes. A failed check leaves the stored answer as it was.
    (async () => {
      try {
        const got = await chrome.storage.local.get(["sort_feed_user_id"]);
        const userID = got.sort_feed_user_id || null;
        if (!userID) return sendResponse({ ok: false, error: "NOT_SIGNED_IN" });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        let data = null;
        try {
          const res = await fetch(SAVE_STATUS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sort_feed_user_id: userID }),
            signal: controller.signal,
          });
          data = await res.json().catch(() => null);
        } finally {
          clearTimeout(timer);
        }
        if (DEBUG) console.log("[library]", data);
        if (!data?.ok || typeof data.hasLibrary !== "boolean") return sendResponse({ ok: false, error: "UPSTREAM" });
        // Signed out or switched account while the check ran: don't store an answer for the wrong user.
        const now = await chrome.storage.local.get(["sort_feed_user_id"]);
        if (now.sort_feed_user_id !== userID) return sendResponse({ ok: false, error: "USER_CHANGED" });
        await chrome.storage.local.set({ [SF_LIBRARY_KEY]: { userID, hasLibrary: data.hasLibrary } });
        sendResponse({ ok: true, hasLibrary: data.hasLibrary });
      } catch (err) {
        if (DEBUG) console.warn("[library] failed", err);
        try { sendResponse({ ok: false, error: "NETWORK" }); } catch (_) {}
      }
    })();
    return true; // async sendResponse
  }
  else if (message.type === "SF_IG_SIMILAR_FETCH") {
    // ViralSpy Native Similar Accounts: fetch directly from Instagram's chaining API inside the active IG tab
    (async () => {
      try {
        const tabId = sender?.tab?.id;
        const targetPk = String(message.targetPk || "");
        const targetUsername = String(message.targetUsername || "").replace(/^@/, "");
        if (!tabId) return sendResponse({ ok: false, error: "NETWORK" });

        const execRes = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [targetPk, targetUsername],
          func: async (pk, uname) => {
            const csrf = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || "";
            const headers = {
              "x-ig-app-id": "936619743392459",
              "x-asbd-id": "359341",
              "x-requested-with": "XMLHttpRequest",
              ...(csrf ? { "x-csrftoken": csrf } : {}),
            };
            let resolvedPk = pk;
            if (!resolvedPk && uname) {
              const profRes = await fetch(
                `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(uname)}`,
                { credentials: "include", headers }
              );
              if (profRes.ok) {
                const profJson = await profRes.json().catch(() => null);
                resolvedPk = String(profJson?.data?.user?.id || profJson?.data?.user?.pk || "");
              }
            }
            if (!resolvedPk) return { ok: false, error: "UPSTREAM" };
            const res = await fetch(
              `https://www.instagram.com/api/v1/discover/chaining/?target_id=${encodeURIComponent(resolvedPk)}`,
              { credentials: "include", headers }
            );
            if (!res.ok) return { ok: false, error: "UPSTREAM" };
            const json = await res.json().catch(() => null);
            const users = Array.isArray(json?.users) ? json.users : [];
            const accounts = users
              .map((u) => ({
                pk: String(u.pk || u.id || ""),
                username: String(u.username || ""),
                full_name: String(u.full_name || ""),
                is_verified: !!u.is_verified,
                pic: String(u.profile_pic_url || ""),
              }))
              .filter((u) => u.username);
            return { ok: true, accounts };
          },
        });
        const data = execRes?.[0]?.result;
        sendResponse(data && typeof data === "object" ? data : { ok: false, error: "UPSTREAM" });
      } catch (err) {
        if (DEBUG) console.warn("[similar] failed", err);
        try { sendResponse({ ok: false, error: "NETWORK" }); } catch (_) {}
      }
    })();
    return true; // async sendResponse
  }
  else if (message.type === "SF_TT_SIMILAR_CACHE") {
    // ViralSpy: immediately tell TikTok content script to fetch similar accounts directly from TikTok
    if (message.action === "save") {
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: "NOT_CACHED", offline: true });
    }
    return true;
  }
  else if (message.type === "SF_OPEN_BG_TAB" && message.url) {
    // Answer FIRST and synchronously. The sender falls back to a foreground
    // window.open() when it sees a lastError, so a branch that returned nothing
    // would look like a dead worker and open the post twice.
    try { sendResponse({ ok: true }); } catch (e) {}

    const opts = { url: message.url, active: false };
    // Land it directly after the feed and tie it to that tab — where a real
    // ctrl-click would put it, rather than at the end of the strip.
    if (sender && sender.tab) {
      if (typeof sender.tab.id === "number") opts.openerTabId = sender.tab.id;
      if (typeof sender.tab.index === "number") opts.index = sender.tab.index + 1;
    }
    chrome.tabs.create(opts, () => { void chrome.runtime.lastError; });
  }

  else if (message.zero_state === "instagram") {
    var newURL = "https://www.instagram.com/";
    chrome.tabs.create({
      url: newURL,
    });
  } 
  
  else if (message.zero_state === "tiktok") {
    var newURL = "https://www.tiktok.com/";
    chrome.tabs.create({
      url: newURL,
    });
  }

  else if (message.zero_state === "facebook") {
    var newURL = "https://www.facebook.com/";
    chrome.tabs.create({
      url: newURL,
    });
  }

  else if (message.zero_state === "youtube") {
    var newURL = "https://www.youtube.com/";
    chrome.tabs.create({
      url: newURL,
    });
  }

  if (message.command === "activatePro") {
    setDBItem("userSortFeed", "Pro").then(() => {
      //   console.log('Pro status saved to IndexedDB');
    });
  } 
  
  else if (message.command === "checkProStatus") {
    sendResponse({ isPro: true });
    return true;
  }
  
//  else if (message.action === "runUserCheckPro") {
//     // console.log('runUserCheck');
//     handleUserIDChecks();
//   }

  // Quota subtitle ("X of Y monthly mins left") — requested by the content
  // scripts the moment the user clicks, so it shows right away instead of
  // after media resolution. Display-only; the worker enforces the real limit.
  else if (message.command === "fetchTransQuotaInfo") {
    const tabId = sender?.tab?.id ?? null;
    sendQuotaInfoToTab(
      tabId,
      message.jobId,
      message.userID,
      message.mission ? "MISSION_TRANS_STARTED" : "TRANS_QUOTA_INFO"
    );
  }

  // Content-script safety timeout fired (this service worker probably died
  // mid-job and got woken by this message) — refund the orphaned job, which
  // the worker may have finished and charged.
  else if (message.command === "refundTransJob") {
    const { clientJobId, userID, platform } = message;
    if (clientJobId) {
      const workerBase = platform === "tiktok" ? TRANS_WORKER_URL_TIKTOK
                       : platform === "facebook" ? TRANS_WORKER_URL_FB
                       : TRANS_WORKER_URL_IG;
      refundTransJob(workerBase, clientJobId, userID, "client_safety_timeout");
    }
  }

  // v3 mission paths: worker enforces quota per item (a quota_exceeded reply
  // stops the mission via MISSION_TRANS_LIMIT); the subtitle comes from
  // fetchTransQuotaInfo fired at mission start.
  else if (message.command === "SelectMissionTranscribe") {
    const { ReelType, ReelURL, ReelBase64, isPrivate, partialHint, jobId, userID, platform, reelIdUi, profileName } = message;
    const tabId = sender?.tab?.id ?? null;
    startMissionTranscriptionJob(ReelType, ReelURL, jobId, userID, tabId, reelIdUi, platform, profileName, ReelBase64 || null, isPrivate, !!partialHint);
  }

  // Transcript cache lookup (single + Select missions, any platform). Answers
  // { ok, hits } — never throws at the caller: any failure is an empty hit
  // list, so the content script simply transcribes as usual.
  else if (message.command === "TransCacheLookup") {
    (async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort("timeout"), TRANS_CACHE_ABORT_MS);
      try {
        const got = await chrome.storage.local.get(["sort_feed_user_id"]);
        const userID = got.sort_feed_user_id || null;
        const ids = Array.isArray(message.ids) ? message.ids.filter(Boolean).slice(0, 500) : [];
        if (!userID || !ids.length) return sendResponse({ ok: false, hits: {} });
        const res = await fetch(TRANS_CACHE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userID, platform: message.platform, ids, surface: message.surface || null }),
          signal: ctrl.signal,
        });
        const data = await res.json().catch(() => null);
        if (DEBUG) console.log("[trans cache]", message.platform, ids.length, "asked,", Object.keys(data?.hits || {}).length, "hits");
        sendResponse({ ok: !!data?.ok, hits: data?.hits && typeof data.hits === "object" ? data.hits : {} });
      } catch (err) {
        if (DEBUG) console.warn("[trans cache] failed", err);
        try { sendResponse({ ok: false, hits: {} }); } catch (_) {}
      } finally {
        clearTimeout(t);
      }
    })();
    return true; // async sendResponse
  }

  else if (message.command === "SelectMissionTranscribeTikTok") {
    const { ReelType, ReelBase64, ReelURL, partialHint, jobId, userID, platform, reelIdUi, profileName } = message;
    const tabId = sender?.tab?.id ?? null;
    startMissionTranscriptionJobTikTok(ReelType, ReelBase64, jobId, userID, tabId, reelIdUi, platform, profileName, ReelURL, !!partialHint);
  }

  else if (message.command === "SelectMissionTranscribeFacebook") {
    const { ReelType, ReelBase64, ReelURL, jobId, userID, platform, reelIdUi, profileName } = message;
    const tabId = sender?.tab?.id ?? null;
    startMissionTranscriptionJobFacebook(ReelType, ReelBase64, jobId, userID, tabId, reelIdUi, platform, profileName, ReelURL);
  }

  // Stop button on a single transcribe — abort the worker fetch; the job
  // runner's catch path classifies it as "cancelled" and fires the refund.
  else if (message.command === "cancelTranscription") {
    const job = activeTransJobs[`${sender?.tab?.id}:${message.jobId}`];
    if (job) job.ctrl.abort("cancelled");
  }

  else if (message.command === "cancelSelectMission") {
    // Abort every in-flight mission job; each runner's catch path refunds its
    // own clientJobId, so a stopped mission never leaves stray charges.
    Object.values(missionAbortControllers).forEach(ctrl => ctrl.abort("cancelled"));
    Object.keys(missionAbortControllers).forEach(k => delete missionAbortControllers[k]);
  }

});

////////////////////////////////////////////////////////////////////////////////
// Listen for network requests that match our rule (TikTok)
////////////////////////////////////////////////////////////////////////////////

chrome.webNavigation.onCompleted.addListener((details) => {
  // Send message to TikTok content script when main frame loads
  if (details.frameId === 0 && typeof details.url === "string" && details.url.includes("tiktok.com")) {
    chrome.tabs.sendMessage(details.tabId, {
      action: 'pageLoaded',
      url: details.url
    }).catch(() => {}); // Ignore errors if content script not ready
  }
});

////////////////////////////////////////////////////////////////////////////////
// handel scroll to the button logic
////////////////////////////////////////////////////////////////////////////////

// chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
// 	if (message.action === "dataFromPage") {
// 		console.log("received scroll message");
// 			chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
// 					chrome.tabs.sendMessage(tabs[0].id, { action: "scrollToBottom"});
// 			});
// 	}
// });