////////////////////////////////////////////////////////////////////////////////
// Agent mode — "Connect to Claude" (Phase 3)
//
// Pulled into the service worker by background.js via importScripts().
//
// When "Connect to Claude" is on (popup → gear → Instagram Settings), the
// service worker keeps a WebSocket open to Sort Feed's MCP server
// (wss://mcp.sortfeed.com/ext). The server relays jobs from Claude; this side
// opens (or reuses) a hidden instagram.com tab on the profile, hands the job to
// the content-script bridge (Instagram/agent/agent_bridge_instagram.js), and
// sends the rows back.
//
// Signing in: there is no second sign-in here. account.sortfeed.com — where the
// user is already signed in — mints a socket token and hands it over with an
// SF_SET_AGENT_TOKEN message, the same way it hands over the userID.
//
// Parameters over the wire, never code. One job at a time. The 20 s ping keeps
// the worker alive while connected (Chrome 116+ resets the idle timer on socket
// traffic); an alarm re-tries the connection whenever it drops.
//
// Developers: the Phase 2 local server still works. From the service worker's
// console:  chrome.storage.local.set({ sortfeed_agent_local: { enabled: true, port: 8765 } })
// While that key is enabled it wins over the hosted connection.
////////////////////////////////////////////////////////////////////////////////

const SF_AGENT_CLOUD_HOST = "mcp.sortfeed.com";       // the one place the hosted server's name lives
const SF_AGENT_STAGING_HOST = "mcp-staging.sortfeed.com";   // where an unpacked (developer) build goes by default
const SF_AGENT_HOST_KEY = "sortfeed_agent_host";      // developer override, no UI: another *.sortfeed.com server (staging)
const SF_AGENT_PROTOCOL = "sortfeed.v1";
const SF_AGENT_LINK_URL = "https://account.sortfeed.com/?connect=extension";
const SF_AGENT_CLOUD_KEY = "sortfeed_agent";          // { enabled }
const SF_AGENT_TOKEN_KEY = "sortfeed_agent_token";    // socket token minted by account.sortfeed.com
const SF_AGENT_TOKEN_HOST_KEY = "sortfeed_agent_token_host";   // which server minted it — a token is only good there
const SF_AGENT_CLAUDE_KEY = "sortfeed_agent_claude";  // true once this account has approved Claude (the server tells us)
const SF_AGENT_KEY = "sortfeed_agent_local";          // { enabled, port } — developer override, no UI
const SF_AGENT_STATUS_KEY = "sortfeed_agent_status";  // { state, at } — read by the popup
const SF_AGENT_USAGE_KEY = "sortfeed_agent_usage";    // [[ts, pageRequests], …] — last 24 h
const SF_AGENT_COOL_KEY = "sortfeed_agent_cool";      // { until, reason } — circuit breaker
const SF_AGENT_ACTIVE_KEY = "sfAgentLastActivity";    // chrome.storage.session — survives worker restarts
const SF_AGENT_TAB_KEY = "sortfeed_agent_tab";        // the job tab's id — so a reloaded extension can reload it (its scripts are orphaned)

// The server owns the limits: the request caps arrive in its `welcome` message and
// each job carries the depth it may scan, so a limit change is a server deploy, not
// an extension release. This side — where the Instagram requests actually happen —
// keeps only the ceilings: double the real values, and the most it will ever do no
// matter what a server says. They only bite when a server is wrong.
const SF_AGENT_LIMITS = { hour: 2000, day: 10000, coolDownMs: 30 * 60000, presenceMaxIdleMin: 0 };
const SF_AGENT_CEILING = { hour: 5000, day: 20000, depth: 2000 };

const SF_AGENT = {
  ws: null, tabId: null, port: 8765, enabled: true, pingTimer: null, reconnectTimer: null, queue: Promise.resolve(),
  mode: "local",                           // "cloud" | "local" | "off"
  token: null, failures: 0, retryMs: 5000,
  host: SF_AGENT_CLOUD_HOST,               // see sfAgentHostFrom
  running: false, current: null,           // the sort in flight: { username, next }
  awaitingNext: null, awaitTimer: null,    // a promised next profile the tab is holding its overlay for
  lastActivity: 0, lastPresenceSent: 0,
};

function sfAgentSetStatus(state) {
  try { chrome.storage.local.set({ [SF_AGENT_STATUS_KEY]: { state, at: Date.now(), host: SF_AGENT.host } }); } catch (e) {}   // host: the popup says "· staging" when it isn't live
}

// Which hosted server this browser talks to. The store build talks to mcp.sortfeed.com. An unpacked build (loaded
// from a folder on chrome://extensions — its manifest has no update_url, which Chrome adds only for store installs)
// talks to the staging server, so a test build never touches the live one and needs no setup step. Either can be
// overridden from the service-worker console, e.g. to make an unpacked build use live:
//   chrome.storage.local.set({ sortfeed_agent_host: "mcp.sortfeed.com" })
// Only a *.sortfeed.com name is accepted (that is what the host permission and externally_connectable cover).
// account.sortfeed.com asks which host (SF_GET_AGENT_STATE) and mints the browser's token there.
const SF_STORE_EXTENSION_ID = "lhiilgfanjkbombmnlfelondlfohfpfg";   // the Chrome Web Store build — always the live server, whatever else
function sfAgentDefaultHost() {
  try {
    if (chrome.runtime.id === SF_STORE_EXTENSION_ID) return SF_AGENT_CLOUD_HOST;
    return chrome.runtime.getManifest().update_url ? SF_AGENT_CLOUD_HOST : SF_AGENT_STAGING_HOST;
  } catch (e) { return SF_AGENT_CLOUD_HOST; }
}
const sfAgentHostFrom = (v) => (typeof v === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.sortfeed\.com$/i.test(v.trim()) ? v.trim().toLowerCase() : sfAgentDefaultHost());

async function sfAgentLoadConfig() {
  const r = await chrome.storage.local.get([SF_AGENT_KEY, SF_AGENT_CLOUD_KEY, SF_AGENT_TOKEN_KEY, SF_AGENT_TOKEN_HOST_KEY, SF_AGENT_HOST_KEY]);
  const local = r[SF_AGENT_KEY] || {};
  SF_AGENT.port = parseInt(local.port, 10) || 8765;
  SF_AGENT.host = sfAgentHostFrom(r[SF_AGENT_HOST_KEY]);
  SF_AGENT.token = typeof r[SF_AGENT_TOKEN_KEY] === "string" ? r[SF_AGENT_TOKEN_KEY] : null;
  // A token minted by another server (this build changed servers, or a build that once linked to live now defaults
  // to staging) is worthless here: forget it now, so the next visit to account.sortfeed.com links this browser afresh.
  // Older builds recorded no host: their token came from the override host if one was set, else from live.
  const tokenHost = r[SF_AGENT_TOKEN_HOST_KEY] || (r[SF_AGENT_HOST_KEY] ? sfAgentHostFrom(r[SF_AGENT_HOST_KEY]) : SF_AGENT_CLOUD_HOST);
  if (SF_AGENT.token && tokenHost !== SF_AGENT.host) {
    SF_AGENT.token = null;
    try { await chrome.storage.local.remove([SF_AGENT_TOKEN_KEY, SF_AGENT_TOKEN_HOST_KEY, SF_AGENT_CLAUDE_KEY]); } catch (e) {}
  }
  // ViralSpy defaults to local MCP server on port 8765 unless explicitly disabled
  const localEnabled = local.enabled !== false;
  SF_AGENT.mode = localEnabled ? "local" : (r[SF_AGENT_CLOUD_KEY] || {}).enabled ? "cloud" : "off";
  SF_AGENT.enabled = SF_AGENT.mode !== "off";
}

function sfAgentSend(obj) {
  try { if (SF_AGENT.ws && SF_AGENT.ws.readyState === 1) SF_AGENT.ws.send(JSON.stringify(obj)); } catch (e) {}
}

async function sfAgentConnect() {
  const was = SF_AGENT.mode;
  await sfAgentLoadConfig();
  if (!SF_AGENT.enabled) { sfAgentDisconnect(); return; }
  if (was !== SF_AGENT.mode && SF_AGENT.ws) { try { SF_AGENT.ws.close(); } catch (e) {} SF_AGENT.ws = null; }
  if (SF_AGENT.mode === "cloud" && !SF_AGENT.token) { sfAgentSetStatus("needs_link"); return; } // the popup opens the link page
  if (SF_AGENT.ws && (SF_AGENT.ws.readyState === 0 || SF_AGENT.ws.readyState === 1)) return;

  let ws;
  try {
    ws = SF_AGENT.mode === "cloud"
      ? new WebSocket(`wss://${SF_AGENT.host}/ext`, [SF_AGENT_PROTOCOL, SF_AGENT.token]) // a browser socket can't set headers; the token rides as a subprotocol
      : new WebSocket(`ws://127.0.0.1:${SF_AGENT.port}/ext`);
  } catch (e) { sfAgentScheduleReconnect(); return; }
  SF_AGENT.ws = ws;
  sfAgentSetStatus("connecting");

  ws.onopen = async () => {
    SF_AGENT.failures = 0;
    SF_AGENT.retryMs = 5000;
    sfAgentSetStatus("connected");
    const active = await sfAgentLastActivity();
    sfAgentSend({ type: "hello", version: chrome.runtime.getManifest().version, browser: sfAgentBrowserName(), ...(active ? { activeAgoMs: Date.now() - active } : {}) });
    clearInterval(SF_AGENT.pingTimer);
    // A bare "ping": the hosted server answers it without waking anything up; the local one ignores it.
    SF_AGENT.pingTimer = setInterval(() => { try { if (SF_AGENT.ws && SF_AGENT.ws.readyState === 1) SF_AGENT.ws.send("ping"); } catch (e) {} }, 20000);
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }   // "pong"
    if (msg && msg.type === "job" && msg.job) sfAgentEnqueue(msg.job);
    else if (msg && msg.type === "focus") sfAgentFocusTab(msg.requestId, msg.port, !!msg.any);
    else if (msg && msg.type === "welcome") { sfAgentApplyLimits(msg); if (typeof msg.claude === "boolean") sfAgentSetClaude(msg.claude); }
    else if (msg && msg.type === "claude") sfAgentSetClaude(!!msg.connected);
  };
  ws.onclose = () => {
    if (SF_AGENT.ws === ws) SF_AGENT.ws = null;
    clearInterval(SF_AGENT.pingTimer);
    sfAgentSetStatus(SF_AGENT.enabled ? "disconnected" : "off");
    // A refused handshake looks the same as a network blip from here, so after a few
    // failures in a row ask the server whether the token is still good.
    if (SF_AGENT.mode === "cloud" && ++SF_AGENT.failures >= 3) { SF_AGENT.failures = 0; sfAgentCheckToken(); }
    sfAgentScheduleReconnect();
  };
  ws.onerror = () => {};
}

// Token revoked (the user signed out everywhere, or disconnected this browser on the
// account page): forget it and stop retrying. Turning the toggle on again re-links.
async function sfAgentCheckToken() {
  if (!SF_AGENT.token) return;
  try {
    const res = await fetch(`https://${SF_AGENT.host}/ext/check`, { method: "POST", headers: { authorization: `Bearer ${SF_AGENT.token}` } });
    if (res.status !== 401) return;
    await chrome.storage.local.remove([SF_AGENT_TOKEN_KEY, SF_AGENT_TOKEN_HOST_KEY, SF_AGENT_CLAUDE_KEY]);
    SF_AGENT.token = null;
    clearTimeout(SF_AGENT.reconnectTimer);
    sfAgentSetStatus("needs_link");
  } catch (e) {}
}

function sfAgentSetClaude(connected) {
  try { chrome.storage.local.set({ [SF_AGENT_CLAUDE_KEY]: !!connected }); } catch (e) {}
}

function sfAgentApplyLimits(msg) {
  const clamp = (v, def, max) => (Number.isFinite(v) && v > 0 ? Math.min(v, max) : def);
  if (msg.caps) {
    SF_AGENT_LIMITS.hour = clamp(msg.caps.hour, SF_AGENT_LIMITS.hour, SF_AGENT_CEILING.hour);
    SF_AGENT_LIMITS.day = clamp(msg.caps.day, SF_AGENT_LIMITS.day, SF_AGENT_CEILING.day);
  }
  if (Number.isFinite(msg.coolDownMs) && msg.coolDownMs >= 30 * 60000) SF_AGENT_LIMITS.coolDownMs = msg.coolDownMs; // never shorter than 30 min
  if (Number.isFinite(msg.presenceMaxIdleMin) && msg.presenceMaxIdleMin >= 0) SF_AGENT_LIMITS.presenceMaxIdleMin = msg.presenceMaxIdleMin;
}

function sfAgentDisconnect() {
  try { if (SF_AGENT.ws) SF_AGENT.ws.close(); } catch (e) {}
  SF_AGENT.ws = null;
  clearInterval(SF_AGENT.pingTimer);
  clearTimeout(SF_AGENT.reconnectTimer);
  sfAgentSetStatus("off");
}

function sfAgentScheduleReconnect() {
  if (!SF_AGENT.enabled) return;
  clearTimeout(SF_AGENT.reconnectTimer);
  // Back off (5 s → 10 s → … → 5 min, reset on a successful connect) with a little jitter, so that if the
  // server is ever down, thousands of browsers don't all knock on it every five seconds.
  const wait = SF_AGENT.mode === "local" ? 5000 : Math.round(SF_AGENT.retryMs * (0.85 + Math.random() * 0.3));
  SF_AGENT.retryMs = Math.min(SF_AGENT.retryMs * 2, 300000);
  SF_AGENT.reconnectTimer = setTimeout(sfAgentConnect, wait);                 // while the worker is awake
  try { chrome.alarms.create("sfAgentReconnect", { delayInMinutes: Math.max(0.5, wait / 60000) }); } catch (e) {} // and after it sleeps
}

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "sfAgentReconnect") sfAgentConnect(); });
chrome.runtime.onStartup.addListener(() => { sfAgentConnect(); });
chrome.runtime.onInstalled.addListener(() => { sfAgentConnect(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes[SF_AGENT_KEY] || changes[SF_AGENT_CLOUD_KEY] || changes[SF_AGENT_TOKEN_KEY] || changes[SF_AGENT_HOST_KEY])) return;
  if (changes[SF_AGENT_HOST_KEY]) {
    // A new host means a new socket, and the old token belongs to the old host: forget it, so the next visit to
    // account.sortfeed.com links this browser to the new server (the site asks which host and mints the token there).
    if (SF_AGENT.ws) { try { SF_AGENT.ws.close(); } catch (e) {} SF_AGENT.ws = null; }
    if (!changes[SF_AGENT_TOKEN_KEY]) { chrome.storage.local.remove([SF_AGENT_TOKEN_KEY, SF_AGENT_TOKEN_HOST_KEY, SF_AGENT_CLAUDE_KEY]); return; }   // the removal fires this listener again
  }
  sfAgentConnect();
});
sfAgentConnect();

// ── Linking: account.sortfeed.com hands over the socket token ───────────────
// manifest.json's externally_connectable already limits senders to *.sortfeed.com;
// the origin is checked again here because a token is worth more than a userID.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message) return;
  if (message.type === "SF_SET_AGENT_TOKEN") {
    let origin = ""; try { origin = new URL(sender.url || sender.origin || "").origin; } catch (e) {}
    const token = message.payload && message.payload.token;
    if (origin !== "https://account.sortfeed.com" || typeof token !== "string" || !/^sfx_[0-9a-f]{64}$/.test(token)) { sendResponse({ ok: false }); return; }
    chrome.storage.local.set({ [SF_AGENT_TOKEN_KEY]: token, [SF_AGENT_TOKEN_HOST_KEY]: SF_AGENT.host, [SF_AGENT_CLOUD_KEY]: { enabled: true } }, () => sendResponse({ ok: true, version: chrome.runtime.getManifest().version }));
    return true;
  }
  // account.sortfeed.com asks before minting a token, so a linked browser isn't re-linked on every page load.
  if (message.type === "SF_GET_AGENT_STATE") {
    let origin = ""; try { origin = new URL(sender.url || sender.origin || "").origin; } catch (e) {}
    if (origin !== "https://account.sortfeed.com") { sendResponse({ ok: false }); return; }
    chrome.storage.local.get([SF_AGENT_TOKEN_KEY, SF_AGENT_CLOUD_KEY, SF_AGENT_HOST_KEY], (r) => {
      // `host` tells the site which server to mint the token on (staging for a developer's build; normally the live one).
      sendResponse({ ok: true, linked: !!r[SF_AGENT_TOKEN_KEY] && !!(r[SF_AGENT_CLOUD_KEY] || {}).enabled, version: chrome.runtime.getManifest().version, host: sfAgentHostFrom(r[SF_AGENT_HOST_KEY]), staging: sfAgentHostFrom(r[SF_AGENT_HOST_KEY]) !== SF_AGENT_CLOUD_HOST });
    });
    return true;
  }
  // Signing out of Sort Feed also disconnects Claude.
  if (message.type === "SF_SET_USER_ID" && (!message.payload || message.payload.userID == null)) {
    chrome.storage.local.remove([SF_AGENT_TOKEN_KEY, SF_AGENT_TOKEN_HOST_KEY, SF_AGENT_CLAUDE_KEY]);
    chrome.storage.local.set({ [SF_AGENT_CLOUD_KEY]: { enabled: false } });
  }
});

// ── Presence: Sort Feed only sorts while someone is using this browser ──────
// No new permission: tab switches and window focus are signals the extension
// already receives. Kept in storage.session so a worker restart doesn't forget.
async function sfAgentLastActivity() {
  if (SF_AGENT.lastActivity) return SF_AGENT.lastActivity;
  try { const r = await chrome.storage.session.get([SF_AGENT_ACTIVE_KEY]); SF_AGENT.lastActivity = r[SF_AGENT_ACTIVE_KEY] || 0; } catch (e) {}
  return SF_AGENT.lastActivity;
}
function sfAgentNoteActivity() {
  const now = Date.now();
  if (now - SF_AGENT.lastActivity < 5000) return;
  SF_AGENT.lastActivity = now;
  try { chrome.storage.session.set({ [SF_AGENT_ACTIVE_KEY]: now }); } catch (e) {}
  if (now - SF_AGENT.lastPresenceSent > 60000) { SF_AGENT.lastPresenceSent = now; sfAgentSend({ type: "presence", activeAgoMs: 0 }); }
}
chrome.tabs.onActivated.addListener((info) => { if (info.tabId !== SF_AGENT.tabId) sfAgentNoteActivity(); });
chrome.windows.onFocusChanged.addListener((windowId) => { if (windowId !== chrome.windows.WINDOW_ID_NONE) sfAgentNoteActivity(); });
chrome.runtime.onStartup.addListener(sfAgentNoteActivity);

// ── Limits: when a sort may not run, a code plus the facts ──────────────────
// The hosted server writes the sentence Claude relays (policyRefusal in
// cloud/src/policy.js), so the wording lives in one place. The short message
// here is only a fallback for a server that doesn't (the local dev one).
async function sfAgentRefusal() {
  const now = Date.now();
  const r = await chrome.storage.local.get([SF_AGENT_USAGE_KEY, SF_AGENT_COOL_KEY]);
  const mins = (ms) => Math.max(1, Math.ceil(ms / 60000));

  const cool = r[SF_AGENT_COOL_KEY];
  if (cool && cool.until > now) {
    return { code: "COOLING_DOWN", until: cool.until, reason: cool.reason, message: `Sort Feed is pausing after Instagram pushed back (${cool.reason}); it resumes in about ${mins(cool.until - now)} minutes.` };
  }
  let hour = 0, day = 0, oldestHour = now, oldestDay = now;
  for (const [t, n] of r[SF_AGENT_USAGE_KEY] || []) {
    if (now - t < 86400e3) { day += n; oldestDay = Math.min(oldestDay, t); }
    if (now - t < 3600e3) { hour += n; oldestHour = Math.min(oldestHour, t); }
  }
  if (day >= SF_AGENT_LIMITS.day) { const ms = oldestDay + 86400e3 - now; return { code: "DAILY_LIMIT", limit: SF_AGENT_LIMITS.day, freesInMs: ms, message: `Daily limit of ${SF_AGENT_LIMITS.day} Instagram page requests reached; it frees up in about ${mins(ms)} minutes.` }; }
  if (hour >= SF_AGENT_LIMITS.hour) { const ms = oldestHour + 3600e3 - now; return { code: "HOURLY_LIMIT", limit: SF_AGENT_LIMITS.hour, freesInMs: ms, message: `Hourly limit of ${SF_AGENT_LIMITS.hour} Instagram page requests reached; it frees up in about ${mins(ms)} minutes.` }; }

  return null;
}
// A refusal's facts ride along with the error so the server can word it.
const sfAgentErrorOf = (e) => ({ ...((e && e.detail) || {}), code: (e && e.code) || "ERROR", message: (e && e.message) || String(e) });

async function sfAgentRecord(result) {
  const now = Date.now();
  if (result && result.requests > 0) {
    const r = await chrome.storage.local.get([SF_AGENT_USAGE_KEY]);
    const usage = (r[SF_AGENT_USAGE_KEY] || []).filter(([t]) => now - t < 86400e3);
    usage.push([now, result.requests]);
    await chrome.storage.local.set({ [SF_AGENT_USAGE_KEY]: usage });
  }
  const code = result && result.error && result.error.code;
  if (code === "THROTTLED" || code === "CHECKPOINT") {
    await chrome.storage.local.set({ [SF_AGENT_COOL_KEY]: { until: now + SF_AGENT_LIMITS.coolDownMs, reason: code } });
  }
}

// A RUN is every profile Claude asked for, not one profile. The job tab is
// navigated between profiles (which destroys the page), so each freshly loaded
// page asks "is a run using this tab?" and, if so, covers itself at once:
//   running       → a sort for `current.username` is in flight        → "getting ready to sort @…"
//   awaitingNext  → the last job promised another profile (job.next)  → "moving on to @…"
// If the promised profile never arrives, the run is closed out after NEXT_WAIT_MS.
const SF_AGENT_NEXT_WAIT_MS = 60000;
const SF_PARALLEL_MAX = 3;
const SF_PARALLEL_ACTIVE_TABS = new Map();
const SF_PARALLEL_QUEUE = [];
let sfParallelRunningCount = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  // Progress from the content-script bridge → terminal log on the server.
  if (message.type === "SF_AGENT_PROGRESS") {
    sfAgentSend({ type: "progress", jobId: message.jobId, stage: message.stage || "count", count: message.count, label: message.label, progress: message.progress, scan: message.scan });
    return;
  }
  if (message.type === "SF_AGENT_HELLO") {
    const senderTabId = sender && sender.tab && sender.tab.id;
    const parallelMeta = senderTabId != null ? SF_PARALLEL_ACTIVE_TABS.get(senderTabId) : null;
    if (parallelMeta) {
      sendResponse({ active: true, phase: "prep", username: parallelMeta.username, label: parallelMeta.label });
      return;
    }
    const mine = !!(senderTabId != null && senderTabId === SF_AGENT.tabId);
    if (mine && SF_AGENT.running && SF_AGENT.current) sendResponse({ active: true, phase: "prep", username: SF_AGENT.current.username, label: SF_AGENT.current.label });
    else if (mine && SF_AGENT.awaitingNext) sendResponse({ active: true, phase: "waiting", username: SF_AGENT.awaitingNext, label: SF_AGENT.awaitingLabel || null });
    else sendResponse({ active: false });
  }
});

// "Watch in Chrome": a link in the chat can't point at an existing tab, so it
// opens a tiny page on the local server, which asks us to bring the sorting tab
// to the front. We focus that tab + its window, then close the helper tab(s)
// the click opened, so the user simply lands on the banner and progress bar.
// `live` tells the server whether a run is in progress (a sort in flight, or the
// overlay holding for a promised next profile). With `any`, the tab is brought
// forward even after the run is over, so the link is never a dead end.
//
// A chat link opens in the OS default browser, which may not be this one — the
// local server uses the app name below to put this browser in front of it.
function sfAgentBrowserName() {
  try {
    const brands = ((navigator.userAgentData && navigator.userAgentData.brands) || []).map((b) => b.brand).join(" ");
    const ua = navigator.userAgent || "";
    if (/Brave/i.test(brands)) return "Brave Browser";
    if (/Microsoft Edge/i.test(brands) || /Edg\//.test(ua)) return "Microsoft Edge";
    if (/Opera/i.test(brands) || /OPR\//.test(ua)) return "Opera";
    if (/Vivaldi/i.test(ua)) return "Vivaldi";
  } catch (e) {}
  return "Google Chrome"; // Arc reports itself as Chrome; the server checks which of the two is running
}

async function sfAgentFocusTab(requestId, port, any) {
  let ok = false, reason = "";
  const live = !!(SF_AGENT.running || SF_AGENT.awaitingNext);
  try {
    if (!live && !any) reason = "no_job";
    else if (SF_AGENT.tabId == null) reason = "no_tab";
    else {
      const tab = await chrome.tabs.get(SF_AGENT.tabId);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      ok = true;
    }
  } catch (e) { reason = "tab_gone"; }
  if (ok) {
    try {
      const prefix = `http://127.0.0.1:${port || SF_AGENT.port}/watch`;
      const all = await chrome.tabs.query({});
      for (const t of all) if (t.id !== SF_AGENT.tabId && typeof t.url === "string" && t.url.startsWith(prefix)) chrome.tabs.remove(t.id);
    } catch (e) {}
  }
  sfAgentSend({ type: "focused", requestId, ok, reason, live });
}

function sfAgentEnqueue(job) {
  if (job && job.parallel) {
    sfAgentEnqueueParallel(job);
    return;
  }
  SF_AGENT.queue = SF_AGENT.queue.then(() => sfAgentRunJob(job)).catch(() => {});
}

function sfAgentEnqueueParallel(job) {
  SF_PARALLEL_QUEUE.push(job);
  sfAgentDrainParallel();
}

function sfAgentDrainParallel() {
  while (sfParallelRunningCount < SF_PARALLEL_MAX && SF_PARALLEL_QUEUE.length > 0) {
    const nextJob = SF_PARALLEL_QUEUE.shift();
    sfParallelRunningCount += 1;
    sfAgentRunParallelJob(nextJob)
      .catch(() => {})
      .finally(() => {
        sfParallelRunningCount = Math.max(0, sfParallelRunningCount - 1);
        sfAgentDrainParallel();
      });
  }
}

async function sfAgentRunParallelJob(job) {
  const jobId = job.jobId;
  const platform = String(job.kind || job.platform || "instagram").toLowerCase();
  const cleanHandle = sfAgentCleanName(job.username);
  const depth = Math.max(1, Math.min(SF_AGENT_CEILING.depth, parseInt(job.depth, 10) || 40));
  const t0 = Date.now();
  let workerTabId = null;

  sfAgentSend({ type: "status", jobId, stage: "accepted", parallel: true });
  try {
    if (!cleanHandle) {
      throw Object.assign(new Error("Missing username for parallel scan."), { code: "BAD_USERNAME" });
    }
    let targetUrl;
    if (platform === "tiktok") {
      targetUrl = `https://www.tiktok.com/@${encodeURIComponent(cleanHandle)}`;
    } else if (platform === "youtube") {
      const ytSurf = job.surface === "videos" ? "videos" : "shorts";
      targetUrl = `https://www.youtube.com/@${encodeURIComponent(cleanHandle)}/${ytSurf}`;
    } else {
      if (!sfAgentValidName(cleanHandle)) {
        throw Object.assign(new Error(`"${job.username}" isn't a valid Instagram username.`), { code: "BAD_USERNAME" });
      }
      targetUrl = `https://www.instagram.com/${cleanHandle}/${job.surface === "posts" ? "" : "reels/"}`;
    }

    const tab = await chrome.tabs.create({ url: targetUrl, active: false });
    workerTabId = tab.id;
    SF_PARALLEL_ACTIVE_TABS.set(workerTabId, { username: cleanHandle, label: `@${cleanHandle}` });
    await sfAgentWaitForLoad(workerTabId, 32000);
    await new Promise((r) => setTimeout(r, 1500));
    sfAgentSend({ type: "status", jobId, stage: "tab_ready", tabId: workerTabId, parallel: true });

    if (platform === "tiktok") {
      const execRes = await chrome.scripting.executeScript({
        target: { tabId: workerTabId },
        world: "MAIN",
        args: [cleanHandle, depth, String(job.sortBy || "outlier")],
        func: async (handle, maxDepth, sortBy) => {
          const parseCompact = (txt) => {
            if (typeof txt === "number") return txt;
            if (!txt) return null;
            const s = String(txt).trim().replace(/,/g, "");
            const m = s.match(/^(\d+(?:\.\d+)?)\s*([KMBkmb])?$/);
            if (!m) return null;
            let n = parseFloat(m[1]);
            const u = (m[2] || "").toUpperCase();
            if (u === "K") n *= 1e3;
            else if (u === "M") n *= 1e6;
            else if (u === "B") n *= 1e9;
            return Math.round(n);
          };
          for (let i = 0; i < Math.ceil(maxDepth / 24); i++) {
            window.scrollTo(0, document.documentElement.scrollHeight);
            await new Promise((r) => setTimeout(r, 900));
          }
          const items = new Map();
          try {
            const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
            if (el?.textContent) {
              const data = JSON.parse(el.textContent);
              const walk = (o) => {
                if (!o || typeof o !== "object") return;
                if (o.id && o.stats && (o.stats.playCount != null || o.statsV2?.playCount != null) && o.video) {
                  const vid = String(o.id);
                  if (!items.has(vid)) {
                    const createDate = o.createTime ? new Date(Number(o.createTime) * 1000).toISOString() : "";
                    const views = Number(o.stats.playCount ?? o.statsV2?.playCount ?? 0);
                    const ageHours = createDate ? Math.max(0.5, (Date.now() - Date.parse(createDate)) / 3600000) : null;
                    items.set(vid, {
                      code: vid,
                      url: `https://www.tiktok.com/@${o.author?.uniqueId || handle}/video/${vid}`,
                      userName: o.author?.uniqueId || handle,
                      caption: String(o.desc || ""),
                      viewCount: views,
                      likesCount: Number(o.stats.diggCount ?? 0),
                      commentsCount: Number(o.stats.commentCount ?? 0),
                      sharesCount: Number(o.stats.shareCount ?? 0),
                      createDate,
                      ageHours: ageHours ? Number(ageHours.toFixed(2)) : null,
                      viewsPerHour: ageHours ? Number((views / ageHours).toFixed(2)) : null,
                      mediaType: 2,
                      videoUrl: o.video?.playAddr || o.video?.downloadAddr || null,
                      thumbnailUrl: o.video?.cover || o.video?.originCover || null,
                      platform: "tiktok",
                    });
                  }
                }
                for (const k of Object.keys(o)) if (o[k] && typeof o[k] === "object") walk(o[k]);
              };
              walk(data);
            }
          } catch (_) {}
          document.querySelectorAll('[data-e2e="user-post-item"]').forEach((card) => {
            const a = card.querySelector('a[href*="/video/"]');
            if (!a) return;
            const href = a.getAttribute("href") || "";
            const m = href.match(/\/video\/(\d+)/);
            if (!m || items.has(m[1])) return;
            const img = card.querySelector("img");
            items.set(m[1], {
              code: m[1],
              url: href.startsWith("http") ? href : `https://www.tiktok.com${href}`,
              userName: handle,
              caption: img?.getAttribute("alt") || "",
              viewCount: parseCompact(card.querySelector('[data-e2e="video-views"]')?.textContent || ""),
              likesCount: null,
              commentsCount: null,
              createDate: "",
              mediaType: 2,
              thumbnailUrl: img?.getAttribute("src") || null,
              platform: "tiktok",
            });
          });
          const rows = Array.from(items.values()).slice(0, maxDepth);
          const validViews = rows.map((r) => r.viewCount).filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
          const baseline = validViews.length ? validViews[Math.floor(validViews.length / 2)] : null;
          if (baseline && baseline > 0) {
            rows.forEach((r) => {
              r.outlierScore = r.viewCount != null ? Number((r.viewCount / baseline).toFixed(2)) : null;
              if (r.viewsPerHour != null) r.velocityScore = Number(((r.viewsPerHour * 24) / baseline).toFixed(2));
            });
          }
          rows.sort((a, b) => ((b.outlierScore ?? b.viewCount) || 0) - ((a.outlierScore ?? a.viewCount) || 0));
          return {
            ok: true,
            platform: "tiktok",
            username: handle,
            surface: "videos",
            sortBy,
            seenInFeed: rows.length,
            rows,
            outlier: baseline ? { status: "ok", baseline, poolSize: validViews.length, metric: "views" } : { status: "insufficient", baseline: null, poolSize: 0, metric: "views" },
          };
        },
      });
      const out = execRes?.[0]?.result || { ok: false, error: { code: "ERROR", message: "Failed to scan TikTok profile." } };
      sfAgentSend({ type: "result", jobId, ...out, ms: Date.now() - t0 });
      return;
    }

    if (platform === "youtube") {
      const ytSurf = job.surface === "videos" ? "videos" : "shorts";
      const execRes = await chrome.scripting.executeScript({
        target: { tabId: workerTabId },
        world: "MAIN",
        args: [cleanHandle, ytSurf, depth, String(job.sortBy || "outlier")],
        func: async (handle, surface, maxDepth, sortBy) => {
          const parseViews = (txt) => {
            if (!txt) return null;
            const clean = String(txt).replace(/\u00a0/g, " ").replace(/,/g, ".").trim();
            const m = clean.match(/(\d+(?:\.\d+)?)\s*([KMBkmb]|Md|k|m)?/);
            if (!m) return null;
            let num = parseFloat(m[1]);
            const suf = (m[2] || "").toUpperCase();
            if (suf === "K") num *= 1e3;
            else if (suf === "M") num *= 1e6;
            else if (suf === "B" || suf === "MD") num *= 1e9;
            return Math.round(num);
          };
          for (let s = 0; s < Math.ceil(maxDepth / 28); s++) {
            window.scrollTo(0, document.documentElement.scrollHeight);
            await new Promise((r) => setTimeout(r, 850));
          }
          const items = new Map();
          const walk = (node) => {
            if (!node || typeof node !== "object") return;
            if (node.shortsLockupViewModel) {
              const sl = node.shortsLockupViewModel;
              const vid = sl?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || sl?.entityId?.replace(/^shorts-shelf-item-/, "") || "";
              if (vid && !items.has(vid)) {
                items.set(vid, {
                  code: vid,
                  url: `https://www.youtube.com/shorts/${vid}`,
                  userName: handle,
                  caption: sl?.overlayMetadata?.primaryText?.content || "",
                  viewCount: parseViews(sl?.overlayMetadata?.secondaryText?.content || sl?.accessibilityText || ""),
                  likesCount: null,
                  commentsCount: null,
                  createDate: "",
                  mediaType: 2,
                  thumbnailUrl: sl?.thumbnail?.sources?.[sl.thumbnail.sources.length - 1]?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
                  platform: "youtube",
                });
              }
            }
            for (const k of Object.keys(node)) if (node[k] && typeof node[k] === "object") walk(node[k]);
          };
          try { walk(window.ytInitialData); } catch (_) {}
          const rows = Array.from(items.values()).slice(0, maxDepth);
          const validViews = rows.map((r) => r.viewCount).filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
          const baseline = validViews.length ? validViews[Math.floor(validViews.length / 2)] : null;
          if (baseline && baseline > 0) {
            rows.forEach((r) => { r.outlierScore = r.viewCount != null ? Number((r.viewCount / baseline).toFixed(2)) : null; });
          }
          rows.sort((a, b) => ((b.outlierScore ?? b.viewCount) || 0) - ((a.outlierScore ?? a.viewCount) || 0));
          return {
            ok: true,
            platform: "youtube",
            username: handle,
            surface,
            sortBy,
            seenInFeed: rows.length,
            rows,
            outlier: baseline ? { status: "ok", baseline, poolSize: validViews.length, metric: "views" } : { status: "insufficient", baseline: null, poolSize: 0, metric: "views" },
          };
        },
      });
      const out = execRes?.[0]?.result || { ok: false, error: { code: "ERROR", message: "Failed to scan YouTube channel." } };
      sfAgentSend({ type: "result", jobId, ...out, ms: Date.now() - t0 });
      return;
    }

    const tabJob = { ...job, username: cleanHandle, next: null, depth };
    const result = await sfAgentSendJobToTab(workerTabId, tabJob);
    await sfAgentRecord(result);
    sfAgentSend({ type: "result", jobId, ...result });
  } catch (e) {
    sfAgentSend({ type: "result", jobId, ok: false, error: sfAgentErrorOf(e) });
  } finally {
    if (workerTabId != null) {
      SF_PARALLEL_ACTIVE_TABS.delete(workerTabId);
      try { await chrome.tabs.remove(workerTabId); } catch (_) {}
    }
  }
}

const sfAgentCleanName = (v) => String(v || "").replace(/^@/, "").trim().toLowerCase();
const sfAgentValidName = (v) => /^[a-z0-9._]{1,30}$/.test(v);
const sfAgentCleanQuery = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 100);

// Two kinds of job: a profile (the Phase 2 job, `username`) and — since 16.7 — an Instagram keyword search
// (`kind: "search"`, `query`). Both run in the same hidden tab; only the page it opens differs.
async function sfAgentRunJob(job) {
  const jobId = job.jobId;
  const isSearch = job.kind === "search";
  const isSimilar = job.kind === "similar";
  const isMediaInfo = job.kind === "media_info";
  const isComments = job.kind === "comments";
  const isYoutube = job.kind === "youtube";
  const isTiktok = job.kind === "tiktok";
  const isList = job.kind === "collections";                          // list the user's saved collections (no sort)
  const isCollection = job.kind === "saved" && job.saved === "collection";   // one saved collection, by name or id
  const isSaved = job.kind === "saved" && !isCollection;              // the user's own Saved › All Posts
  const query = isSearch ? sfAgentCleanQuery(job.query) : null;
  const wantCollection = isCollection ? String(job.collection || "").trim().slice(0, 120) : null;
  const username = isSearch || isSaved || isCollection || isList || isMediaInfo || isComments || isYoutube || isTiktok ? null : sfAgentCleanName(job.username);
  const label = isSearch ? `“${query}” on Search` : isSaved ? "your saved posts" : isCollection ? `your “${wantCollection}” collection` : isList ? "your saved collections" : isMediaInfo ? `post ${job.shortcode || job.mediaId}` : isComments ? `comments on ${job.shortcode || job.mediaId}` : isYoutube ? `YouTube @${job.username}` : isTiktok ? `TikTok @${job.username}` : `@${username}`;   // what the in-page banner calls this job
  const next = sfAgentValidName(sfAgentCleanName(job.next)) ? sfAgentCleanName(job.next) : null;
  // What the "moving on" line names between sorts: the server's label (any kind of sort) or the next profile.
  const nextLabel = typeof job.nextLabel === "string" && job.nextLabel.trim() ? job.nextLabel.trim().slice(0, 80) : (next ? `@${next}` : null);

  // This job IS the promised next sort (or a new run): stop waiting.
  clearTimeout(SF_AGENT.awaitTimer);
  SF_AGENT.awaitingNext = null;
  SF_AGENT.awaitingLabel = null;
  SF_AGENT.current = { username, label, next, nextLabel };   // set BEFORE the tab loads, so its SF_AGENT_HELLO gets "prep"
  SF_AGENT.running = true;

  let stopped = false, touchedTab = false, handedOff = false;   // touchedTab: this job loaded or asked the tab; handedOff: the tab has the job and owns the banner
  sfAgentSend({ type: "status", jobId, stage: "accepted" });
  try {
    if (isMediaInfo) {
      const t0 = Date.now();
      const rawUrl = String(job.url || "");
      const isTtMedia = job.platform === "tiktok" || /tiktok\.com/i.test(rawUrl);

      if (isTtMedia) {
        const ttTarget = rawUrl || `https://www.tiktok.com/@${job.username || "_"}/video/${job.shortcode || job.mediaId}`;
        const tempTab = await chrome.tabs.create({ url: ttTarget, active: false });
        try {
          await sfAgentWaitForLoad(tempTab.id, 25000);
          await new Promise((r) => setTimeout(r, 1200));
          const execRes = await chrome.scripting.executeScript({
            target: { tabId: tempTab.id },
            world: "MAIN",
            args: [String(job.shortcode || "")],
            func: (targetVid) => {
              try {
                const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
                if (el?.textContent) {
                  const data = JSON.parse(el.textContent);
                  let found = null;
                  const walk = (o) => {
                    if (!o || typeof o !== "object" || found) return;
                    if (o.id && o.video && (o.video.playAddr || o.video.downloadAddr)) {
                      if (!targetVid || String(o.id) === targetVid) {
                        found = o;
                        return;
                      }
                    }
                    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === "object") walk(o[k]);
                  };
                  walk(data);
                  if (found) {
                    const vUrl = found.video?.downloadAddr || found.video?.playAddr || null;
                    return {
                      ok: true,
                      platform: "tiktok",
                      shortcode: String(found.id),
                      mediaId: String(found.id),
                      username: found.author?.uniqueId || "",
                      caption: String(found.desc || ""),
                      viewCount: Number(found.stats?.playCount ?? 0),
                      likesCount: Number(found.stats?.diggCount ?? 0),
                      commentsCount: Number(found.stats?.commentCount ?? 0),
                      videoDuration: Number(found.video?.duration ?? 0),
                      thumbnailUrl: found.video?.cover || found.video?.originCover || null,
                      createDate: found.createTime ? new Date(Number(found.createTime) * 1000).toISOString() : "",
                      videoUrl: vUrl,
                      audioUrl: vUrl,
                    };
                  }
                }
                const domVid = document.querySelector("video");
                if (domVid?.src && /^https?:/i.test(domVid.src)) {
                  return {
                    ok: true,
                    platform: "tiktok",
                    shortcode: targetVid,
                    videoUrl: domVid.src,
                    audioUrl: domVid.src,
                  };
                }
              } catch (_) {}
              return { ok: false, error: { code: "NOT_FOUND", message: "Could not resolve TikTok video stream." } };
            },
          });
          const out = execRes?.[0]?.result || { ok: false, error: { code: "ERROR", message: "Failed to inspect TikTok video." } };
          sfAgentSend({ type: "result", jobId, ...out, ms: Date.now() - t0 });
        } finally {
          try { await chrome.tabs.remove(tempTab.id); } catch (_) {}
        }
        return;
      }

      const tabId = await sfAgentOpenTabUnless("https://www.instagram.com/");
      const execRes = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [String(job.shortcode || ""), String(job.mediaId || "")],
        func: async (shortcode, mediaIdArg) => {
          const shortcodeToPk = (code) => {
            const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let id = 0n;
            for (const ch of String(code || "").trim()) {
              const idx = alphabet.indexOf(ch);
              if (idx < 0) return null;
              id = id * 64n + BigInt(idx);
            }
            return id > 0n ? id.toString(10) : null;
          };
          const pk = mediaIdArg || shortcodeToPk(shortcode);
          if (!pk) return { ok: false, error: { code: "BAD_MEDIA", message: "Invalid Instagram shortcode or media ID." } };
          const csrf = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || "";
          const res = await fetch(`https://www.instagram.com/api/v1/media/${encodeURIComponent(pk)}/info/`, {
            method: "GET",
            credentials: "include",
            headers: {
              "x-ig-app-id": "936619743392459",
              "x-asbd-id": "359341",
              "x-requested-with": "XMLHttpRequest",
              ...(csrf ? { "x-csrftoken": csrf } : {}),
            },
          });
          const json = await res.json().catch(() => null);
          const item = Array.isArray(json) ? json[0] : json?.items?.[0] ?? null;
          if (!res.ok || !item) {
            return { ok: false, error: { code: "NOT_FOUND", message: json?.message || `HTTP ${res.status}` } };
          }
          const prog = item?.clips_metadata?.original_sound_info?.progressive_download_url;
          let audioUrl = prog && /^https?:\/\//i.test(prog) ? prog : null;
          if (!audioUrl && item?.video_dash_manifest) {
            audioUrl = item.video_dash_manifest.match(/<AdaptationSet[^>]*contentType="audio"[^>]*>[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>/i)?.[1]?.replace(/&amp;/g, "&") || null;
          }
          const videoUrl = item?.video_versions?.[0]?.url || item?.carousel_media?.[0]?.video_versions?.[0]?.url || null;
          if (!audioUrl) audioUrl = videoUrl;
          const thumbnailUrl =
            item?.image_versions2?.candidates?.[0]?.url ||
            item?.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
            null;
          return {
            ok: true,
            platform: "instagram",
            shortcode: item?.code || shortcode,
            mediaId: String(item?.pk || pk),
            username: item?.user?.username || "",
            caption: item?.caption?.text || "",
            viewCount: item?.play_count ?? item?.view_count ?? null,
            likesCount: item?.like_count ?? null,
            commentsCount: item?.comment_count ?? null,
            videoDuration: item?.video_duration ?? null,
            createDate: item?.taken_at ? new Date(item.taken_at * 1000).toISOString() : "",
            thumbnailUrl,
            videoUrl,
            audioUrl,
          };
        },
      });
      const out = execRes?.[0]?.result || { ok: false, error: { code: "ERROR", message: "Failed to inspect media in browser tab." } };
      sfAgentSend({ type: "result", jobId, ...out, ms: Date.now() - t0 });
      return;
    }

    if (isComments) {
      const t0 = Date.now();
      const tabId = await sfAgentOpenTabUnless("https://www.instagram.com/");
      const maxComments = Math.max(15, Math.min(150, parseInt(job.limit, 10) || 60));
      const execRes = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [String(job.shortcode || ""), String(job.mediaId || ""), maxComments],
        func: async (shortcode, mediaIdArg, targetCount) => {
          const shortcodeToPk = (code) => {
            const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let id = 0n;
            for (const ch of String(code || "").trim()) {
              const idx = alphabet.indexOf(ch);
              if (idx < 0) return null;
              id = id * 64n + BigInt(idx);
            }
            return id > 0n ? id.toString(10) : null;
          };
          const pk = mediaIdArg || shortcodeToPk(shortcode);
          if (!pk) return { ok: false, error: { code: "BAD_MEDIA", message: "Invalid Instagram shortcode or media ID." } };
          const csrf = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || "";
          const headers = {
            "x-ig-app-id": "936619743392459",
            "x-asbd-id": "359341",
            "x-requested-with": "XMLHttpRequest",
            ...(csrf ? { "x-csrftoken": csrf } : {}),
          };
          const seen = new Map();
          let minId = null;
          let captionText = "";
          for (let page = 0; page < 3 && seen.size < targetCount; page++) {
            const qs = new URLSearchParams({
              can_support_threading: "true",
              permalink_enabled: "false",
            });
            if (minId) qs.set("min_id", minId);
            const res = await fetch(`https://www.instagram.com/api/v1/media/${encodeURIComponent(pk)}/comments/?${qs}`, {
              method: "GET",
              credentials: "include",
              headers,
            });
            if (!res.ok) {
              if (page === 0) return { ok: false, error: { code: "UPSTREAM", message: `Instagram comments API returned HTTP ${res.status}.` } };
              break;
            }
            const json = await res.json().catch(() => null);
            if (!json) break;
            if (!captionText && json.caption?.text) captionText = json.caption.text;
            const list = [...(Array.isArray(json.comments) ? json.comments : []), ...(Array.isArray(json.preview_comments) ? json.preview_comments : [])];
            for (const c of list) {
              const cid = String(c?.pk || "");
              const text = String(c?.text || "").trim();
              if (!cid || !text || seen.has(cid)) continue;
              seen.set(cid, {
                id: cid,
                username: c?.user?.username || "",
                fullName: c?.user?.full_name || "",
                isVerified: !!c?.user?.is_verified,
                text,
                likes: Number(c?.comment_like_count || 0),
                replyCount: Number(c?.child_comment_count || 0),
                createdAt: c?.created_at ? new Date(c.created_at * 1000).toISOString() : "",
              });
            }
            minId = json.next_min_id || null;
            if (!minId) break;
          }
          const all = Array.from(seen.values()).sort((a, b) => (b.likes - a.likes) || (b.replyCount - a.replyCount));
          const qRe = /\?|\b(how|what|where|why|which|who|when|can you|could you|anyone know|comment|quel|quelle|quels|quelles|combien|pourquoi|où|est-ce)\b/i;
          const reqRe = /\b(link|price|cost|buy|shop|recipe|tutorial|part 2|guide|template|app|brand|lien|prix|acheter|recette|tuto|programme|pdf|marque|référence|ref)\b/i;
          const questions = all.filter((c) => qRe.test(c.text) && c.text.length >= 8).slice(0, 25);
          const requests = all.filter((c) => reqRe.test(c.text)).slice(0, 25);
          return {
            ok: true,
            shortcode,
            mediaId: String(pk),
            caption: captionText,
            totalFetched: all.length,
            questions,
            requests,
            topComments: all.slice(0, targetCount),
          };
        },
      });
      const out = execRes?.[0]?.result || { ok: false, error: { code: "ERROR", message: "Failed to mine comments." } };
      sfAgentSend({ type: "result", jobId, ...out, ms: Date.now() - t0 });
      return;
    }

    if (isYoutube) {
      const t0 = Date.now();
      const rawHandle = String(job.username || "").trim().replace(/^https?:\/\/(www\.)?youtube\.com\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
      if (!rawHandle) throw Object.assign(new Error("Provide a YouTube channel handle (e.g. @mrbeast)."), { code: "BAD_USERNAME" });
      const ytSurface = job.surface === "videos" ? "videos" : "shorts";
      const targetDepth = Math.max(12, Math.min(200, parseInt(job.depth, 10) || 48));
      const ytUrl = `https://www.youtube.com/@${encodeURIComponent(rawHandle)}/${ytSurface}`;
      const tabId = await sfAgentOpenTab(ytUrl);
      const execRes = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [rawHandle, ytSurface, targetDepth, String(job.sortBy || "outlier")],
        func: async (handle, surface, depth, sortBy) => {
          const parseViews = (txt) => {
            if (!txt) return null;
            const clean = String(txt).replace(/\u00a0/g, " ").replace(/,/g, ".").trim();
            const m = clean.match(/(\d+(?:\.\d+)?)\s*([KMBkmb]|Md|k|m)?/);
            if (!m) return null;
            let num = parseFloat(m[1]);
            const suf = (m[2] || "").toUpperCase();
            if (suf === "K") num *= 1e3;
            else if (suf === "M") num *= 1e6;
            else if (suf === "B" || suf === "MD") num *= 1e9;
            else {
              const digitsOnly = String(txt).replace(/[^\d]/g, "");
              if (digitsOnly.length >= 4) num = parseInt(digitsOnly, 10);
            }
            return Math.round(num);
          };
          for (let s = 0; s < Math.ceil(depth / 28); s++) {
            window.scrollTo(0, document.documentElement.scrollHeight);
            await new Promise((r) => setTimeout(r, 900));
          }
          const items = new Map();
          // Walk ytInitialData first
          const walk = (node) => {
            if (!node || typeof node !== "object") return;
            if (node.shortsLockupViewModel) {
              const sl = node.shortsLockupViewModel;
              const vid = sl?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || sl?.entityId?.replace(/^shorts-shelf-item-/, "") || "";
              if (vid && !items.has(vid)) {
                const title = sl?.overlayMetadata?.primaryText?.content || "";
                const viewsTxt = sl?.overlayMetadata?.secondaryText?.content || sl?.accessibilityText || "";
                const thumb = sl?.thumbnail?.sources?.[sl.thumbnail.sources.length - 1]?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
                items.set(vid, {
                  code: vid,
                  url: `https://www.youtube.com/shorts/${vid}`,
                  userName: handle,
                  caption: title,
                  viewCount: parseViews(viewsTxt),
                  likesCount: null,
                  commentsCount: null,
                  createDate: "",
                  mediaType: 2,
                  thumbnailUrl: thumb,
                  platform: "youtube",
                });
              }
            }
            if (node.videoRenderer && node.videoRenderer.videoId) {
              const vr = node.videoRenderer;
              const vid = vr.videoId;
              if (!items.has(vid)) {
                const title = vr.title?.runs?.[0]?.text || vr.title?.simpleText || "";
                const viewsTxt = vr.viewCountText?.simpleText || vr.shortViewCountText?.simpleText || "";
                const thumb = vr.thumbnail?.thumbnails?.[vr.thumbnail.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
                items.set(vid, {
                  code: vid,
                  url: `https://www.youtube.com/watch?v=${vid}`,
                  userName: handle,
                  caption: title,
                  viewCount: parseViews(viewsTxt),
                  likesCount: null,
                  commentsCount: null,
                  createDate: vr.publishedTimeText?.simpleText || "",
                  mediaType: 2,
                  thumbnailUrl: thumb,
                  platform: "youtube",
                });
              }
            }
            for (const k of Object.keys(node)) {
              const v = node[k];
              if (v && typeof v === "object") walk(v);
            }
          };
          try { walk(window.ytInitialData); } catch (_) {}
          // Also pick up live DOM cards loaded via scroll
          document.querySelectorAll("ytd-rich-item-renderer").forEach((card) => {
            const a = card.querySelector('a[href*="/shorts/"], a#video-title-link, a[href*="/watch?v="]');
            if (!a) return;
            const href = a.getAttribute("href") || "";
            const m = href.match(/\/shorts\/([A-Za-z0-9_-]{8,15})/) || href.match(/[?&]v=([A-Za-z0-9_-]{8,15})/);
            if (!m) return;
            const vid = m[1];
            if (items.has(vid)) return;
            const title = (card.querySelector("#video-title, h3")?.textContent || a.getAttribute("title") || "").trim();
            const metaText = Array.from(card.querySelectorAll("span")).map((el) => el.textContent || "").find((t) => /view|spectateur|vue/i.test(t)) || "";
            items.set(vid, {
              code: vid,
              url: href.includes("/shorts/") ? `https://www.youtube.com/shorts/${vid}` : `https://www.youtube.com/watch?v=${vid}`,
              userName: handle,
              caption: title,
              viewCount: parseViews(metaText),
              likesCount: null,
              commentsCount: null,
              createDate: "",
              mediaType: 2,
              thumbnailUrl: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              platform: "youtube",
            });
          });

          const rows = Array.from(items.values()).slice(0, depth);
          const validViews = rows.map((r) => r.viewCount).filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
          const baseline = validViews.length ? validViews[Math.floor(validViews.length / 2)] : null;
          if (baseline && baseline > 0) {
            rows.forEach((r) => {
              r.outlierScore = r.viewCount != null ? Number((r.viewCount / baseline).toFixed(2)) : null;
            });
          }
          const sorted = [...rows].sort((a, b) => {
            if (sortBy === "outlier" && baseline) return (b.outlierScore || 0) - (a.outlierScore || 0);
            return (b.viewCount || 0) - (a.viewCount || 0);
          });
          return {
            ok: true,
            platform: "youtube",
            username: handle,
            surface,
            sortBy,
            seenInFeed: rows.length,
            rows: sorted,
            outlier: baseline ? { status: "ok", baseline, poolSize: validViews.length, metric: "views" } : { status: "insufficient", baseline: null, poolSize: validViews.length, metric: "views" },
          };
        },
      });
      const out = execRes?.[0]?.result || { ok: false, error: { code: "ERROR", message: "Failed to scan YouTube channel." } };
      sfAgentSend({ type: "result", jobId, ...out, ms: Date.now() - t0 });
      return;
    }

    if (isTiktok) {
      const t0 = Date.now();
      const rawHandle = String(job.username || "").trim().replace(/^https?:\/\/(www\.)?tiktok\.com\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
      if (!rawHandle) throw Object.assign(new Error("Provide a TikTok username (e.g. @khaby.lame)."), { code: "BAD_USERNAME" });
      const targetDepth = Math.max(12, Math.min(150, parseInt(job.depth, 10) || 40));
      const ttUrl = `https://www.tiktok.com/@${encodeURIComponent(rawHandle)}`;
      const tabId = await sfAgentOpenTab(ttUrl);
      const execRes = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [rawHandle, targetDepth, String(job.sortBy || "outlier")],
        func: async (handle, depth, sortBy) => {
          const parseCompact = (txt) => {
            if (typeof txt === "number") return txt;
            if (!txt) return null;
            const s = String(txt).trim().replace(/,/g, "");
            const m = s.match(/^(\d+(?:\.\d+)?)\s*([KMBkmb])?$/);
            if (!m) return null;
            let n = parseFloat(m[1]);
            const u = (m[2] || "").toUpperCase();
            if (u === "K") n *= 1e3;
            else if (u === "M") n *= 1e6;
            else if (u === "B") n *= 1e9;
            return Math.round(n);
          };
          for (let i = 0; i < Math.ceil(depth / 24); i++) {
            window.scrollTo(0, document.documentElement.scrollHeight);
            await new Promise((r) => setTimeout(r, 950));
          }
          const items = new Map();
          try {
            const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
            if (el?.textContent) {
              const data = JSON.parse(el.textContent);
              const walk = (o) => {
                if (!o || typeof o !== "object") return;
                if (o.id && o.stats && (o.stats.playCount != null || o.statsV2?.playCount != null) && o.video) {
                  const vid = String(o.id);
                  if (!items.has(vid)) {
                    const createDate = o.createTime ? new Date(Number(o.createTime) * 1000).toISOString() : "";
                    const views = Number(o.stats.playCount ?? o.statsV2?.playCount ?? 0);
                    const ageHours = createDate ? Math.max(0.5, (Date.now() - Date.parse(createDate)) / 3600000) : null;
                    items.set(vid, {
                      code: vid,
                      url: `https://www.tiktok.com/@${o.author?.uniqueId || handle}/video/${vid}`,
                      userName: o.author?.uniqueId || handle,
                      caption: String(o.desc || ""),
                      viewCount: views,
                      likesCount: Number(o.stats.diggCount ?? 0),
                      commentsCount: Number(o.stats.commentCount ?? 0),
                      sharesCount: Number(o.stats.shareCount ?? 0),
                      createDate,
                      ageHours: ageHours ? Number(ageHours.toFixed(2)) : null,
                      viewsPerHour: ageHours ? Number((views / ageHours).toFixed(2)) : null,
                      mediaType: 2,
                      videoUrl: o.video?.playAddr || o.video?.downloadAddr || null,
                      thumbnailUrl: o.video?.cover || o.video?.originCover || null,
                      platform: "tiktok",
                    });
                  }
                }
                for (const k of Object.keys(o)) if (o[k] && typeof o[k] === "object") walk(o[k]);
              };
              walk(data);
            }
          } catch (_) {}

          document.querySelectorAll('[data-e2e="user-post-item"]').forEach((card) => {
            const a = card.querySelector('a[href*="/video/"]');
            if (!a) return;
            const href = a.getAttribute("href") || "";
            const m = href.match(/\/video\/(\d+)/);
            if (!m) return;
            const vid = m[1];
            if (items.has(vid)) return;
            const viewsTxt = card.querySelector('[data-e2e="video-views"]')?.textContent || "";
            const img = card.querySelector("img");
            items.set(vid, {
              code: vid,
              url: href.startsWith("http") ? href : `https://www.tiktok.com${href}`,
              userName: handle,
              caption: img?.getAttribute("alt") || "",
              viewCount: parseCompact(viewsTxt),
              likesCount: null,
              commentsCount: null,
              createDate: "",
              mediaType: 2,
              thumbnailUrl: img?.getAttribute("src") || null,
              platform: "tiktok",
            });
          });

          const rows = Array.from(items.values()).slice(0, depth);
          const validViews = rows.map((r) => r.viewCount).filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
          const baseline = validViews.length ? validViews[Math.floor(validViews.length / 2)] : null;
          if (baseline && baseline > 0) {
            rows.forEach((r) => {
              r.outlierScore = r.viewCount != null ? Number((r.viewCount / baseline).toFixed(2)) : null;
              if (r.viewsPerHour != null) r.velocityScore = Number(((r.viewsPerHour * 24) / baseline).toFixed(2));
            });
          }
          const sorted = [...rows].sort((a, b) => {
            if (sortBy === "velocity") return ((b.velocityScore ?? b.viewsPerHour) || 0) - ((a.velocityScore ?? a.viewsPerHour) || 0);
            if (sortBy === "likes") return (b.likesCount || 0) - (a.likesCount || 0);
            if (sortBy === "outlier" && baseline) return (b.outlierScore || 0) - (a.outlierScore || 0);
            return (b.viewCount || 0) - (a.viewCount || 0);
          });
          return {
            ok: true,
            platform: "tiktok",
            username: handle,
            surface: "videos",
            sortBy,
            seenInFeed: rows.length,
            rows: sorted,
            outlier: baseline ? { status: "ok", baseline, poolSize: validViews.length, metric: "views" } : { status: "insufficient", baseline: null, poolSize: validViews.length, metric: "views" },
          };
        },
      });
      const out = execRes?.[0]?.result || { ok: false, error: { code: "ERROR", message: "Failed to scan TikTok profile." } };
      sfAgentSend({ type: "result", jobId, ...out, ms: Date.now() - t0 });
      return;
    }

    if (isSimilar) {
      if (!sfAgentValidName(username)) {
        throw Object.assign(new Error(`"${job.username}" isn't a valid Instagram username.`), { code: "BAD_USERNAME" });
      }
      const t0 = Date.now();
      const tabId = await sfAgentOpenTabUnless(`https://www.instagram.com/${username}/`);
      const execRes = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [username, String(job.targetPk || "")],
        func: async (uname, pkArg) => {
          const csrf = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || "";
          const headers = {
            "x-ig-app-id": "936619743392459",
            "x-asbd-id": "359341",
            "x-requested-with": "XMLHttpRequest",
            ...(csrf ? { "x-csrftoken": csrf } : {}),
          };

          const findIdOnLoadedPage = (handle) => {
            const html = document.documentElement?.innerHTML || "";
            const needle = `"username":"${handle}"`;
            const counts = new Map();
            let idx = -1;
            while ((idx = html.indexOf(needle, idx + 1)) !== -1) {
              const win = html.slice(Math.max(0, idx - 400), idx + needle.length + 400);
              for (const m of win.matchAll(/"(?:pk|id|pk_id|profile_id|user_id|target_user_id)":"?(\d{3,20})"?/g)) {
                counts.set(m[1], (counts.get(m[1]) || 0) + 2);
              }
            }
            for (const re of [/"profilePage_(\d+)"/g, /"profile_id":"(\d+)"/g, /"target_user_id":"(\d+)"/g]) {
              for (const m of html.matchAll(re)) {
                counts.set(m[1], (counts.get(m[1]) || 0) + 3);
              }
            }
            const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
            return ranked.length ? ranked[0][0] : "";
          };

          let resolvedPk = pkArg || findIdOnLoadedPage(uname);
          let profileInfo = null;

          if (!resolvedPk) {
            try {
              const profRes = await fetch(
                `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(uname)}`,
                { credentials: "include", headers }
              );
              if (profRes.ok) {
                const profJson = await profRes.json().catch(() => null);
                const u = profJson?.data?.user;
                if (u) {
                  resolvedPk = String(u.id || u.pk || "");
                  profileInfo = {
                    username: u.username || uname,
                    full_name: u.full_name || "",
                    followers: u.edge_followed_by?.count ?? null,
                    following: u.edge_follow?.count ?? null,
                    biography: u.biography || "",
                    is_verified: !!u.is_verified,
                  };
                }
              }
            } catch (_) {}
          }

          // Fallback 2: Instagram topsearch (resolves exact handle OR returns closest real handles if misspelled)
          let searchSuggestions = [];
          if (!resolvedPk) {
            for (const q of [uname, uname.replace(/[._]+/g, " ").trim()]) {
              if (!q) continue;
              try {
                const sRes = await fetch(
                  `https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=${encodeURIComponent(q)}&include_reel=false`,
                  { credentials: "include", headers }
                );
                if (sRes.ok) {
                  const sJson = await sRes.json().catch(() => null);
                  const foundUsers = (sJson?.users || [])
                    .map((entry) => entry?.user || entry)
                    .filter((u) => u?.username);
                  const exact = foundUsers.find((u) => String(u.username).toLowerCase() === uname.toLowerCase());
                  if (exact) {
                    resolvedPk = String(exact.pk || exact.id || "");
                    profileInfo = {
                      username: exact.username,
                      full_name: exact.full_name || "",
                      is_verified: !!exact.is_verified,
                    };
                    break;
                  }
                  for (const u of foundUsers) {
                    if (!searchSuggestions.some((x) => x.username === u.username)) {
                      searchSuggestions.push({
                        pk: String(u.pk || u.id || ""),
                        username: String(u.username),
                        full_name: String(u.full_name || ""),
                        is_verified: !!u.is_verified,
                        is_private: !!u.is_private,
                        pic: String(u.profile_pic_url || ""),
                      });
                    }
                  }
                  if (searchSuggestions.length >= 8) break;
                }
              } catch (_) {}
            }
          }

          if (!resolvedPk) {
            return {
              ok: false,
              suggestions: searchSuggestions.slice(0, 12),
              error: {
                code: searchSuggestions.length ? "NOT_FOUND_SUGGESTIONS" : "NOT_FOUND",
                message: searchSuggestions.length
                  ? `@${uname} doesn't exist on Instagram — click one of the closest matching accounts below.`
                  : `@${uname} was not found on Instagram (check spelling or make sure you're signed in to Instagram in Chrome).`,
              },
            };
          }

          const res = await fetch(
            `https://www.instagram.com/api/v1/discover/chaining/?target_id=${encodeURIComponent(resolvedPk)}`,
            { credentials: "include", headers }
          );
          if (!res.ok) {
            return { ok: false, error: { code: "UPSTREAM", message: `Instagram chaining API returned HTTP ${res.status}.` } };
          }
          const json = await res.json().catch(() => null);
          const users = Array.isArray(json?.users) ? json.users : [];
          const accounts = users
            .map((u) => ({
              pk: String(u.pk || u.id || ""),
              username: String(u.username || ""),
              full_name: String(u.full_name || ""),
              is_verified: !!u.is_verified,
              is_private: !!u.is_private,
              pic: String(u.profile_pic_url || ""),
            }))
            .filter((u) => u.username);
          return { ok: true, username: uname, targetPk: resolvedPk, profile: profileInfo, accounts, count: accounts.length };
        },
      });
      const out = execRes?.[0]?.result || { ok: false, error: { code: "ERROR", message: "Failed to fetch similar accounts." } };
      sfAgentSend({ type: "result", jobId, ...out, requests: 2, ms: Date.now() - t0 });
      return;
    }

    if (isSearch ? !query : isCollection ? !wantCollection : isSaved || isList ? false : !sfAgentValidName(username)) {
      throw isSearch
        ? Object.assign(new Error("The search query is empty."), { code: "BAD_QUERY" })
        : isCollection
        ? Object.assign(new Error("No collection was named."), { code: "NO_COLLECTION" })
        : Object.assign(new Error(`"${job.username}" isn't a valid Instagram username.`), { code: "BAD_USERNAME" });
    }
    const refused = await sfAgentRefusal();          // caps · circuit breaker · presence — before any tab opens
    if (refused) throw Object.assign(new Error(refused.message), { code: refused.code, detail: refused });
    // The server chose how deep to scan; the ceiling is the only say this side has.
    const depth = Math.max(1, Math.min(SF_AGENT_CEILING.depth, parseInt(job.depth, 10) || 50));
    let url, tabJob;
    if (isSaved || isCollection || isList) {
      // Saved lives at /<viewer>/saved/… — find out who is signed in first.
      touchedTab = true;
      const viewer = await sfAgentFindViewer();
      if (!viewer) throw Object.assign(new Error("Couldn't tell which Instagram account this browser is signed in as. Sign in to Instagram in this browser and try again."), { code: "LOGGED_OUT" });
      if (isSaved) { url = `https://www.instagram.com/${viewer}/saved/all-posts/`; tabJob = { ...job, next, depth }; }
      else {
        // Collections: the Saved page lists them as links with the name and id; read that list, then match.
        const rootTab = await sfAgentOpenTabUnless(`https://www.instagram.com/${viewer}/saved/`);
        const found = await sfAgentAskTab(rootTab, { type: "SF_AGENT_COLLECTIONS" });
        const collections = found && Array.isArray(found.collections) ? found.collections : [];
        if (isList) {
          const result = { ok: true, collections, viewer, requests: 0, ms: 0 };
          sfAgentSend({ type: "result", jobId, ...result });
          return;
        }
        const match = sfAgentMatchCollection(collections, wantCollection);
        if (!match.hit) throw Object.assign(new Error(match.message), { code: match.code });
        url = `https://www.instagram.com/${viewer}/saved/${match.hit.slug}/${match.hit.id}/`;
        tabJob = { ...job, collection: match.hit, next, depth };
      }
    } else {
      url = isSearch
        ? `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(query)}`
        : `https://www.instagram.com/${username}/${job.surface === "posts" ? "" : "reels/"}`;
      tabJob = isSearch ? { ...job, query, next, depth } : { ...job, username, next, depth };
    }
    touchedTab = true;
    const tabId = await sfAgentOpenTab(url);
    sfAgentSend({ type: "status", jobId, stage: "tab_ready", tabId });
    handedOff = true;
    const result = await sfAgentSendJobToTab(tabId, tabJob);
    await sfAgentRecord(result);
    stopped = !!(result && result.stopped);
    sfAgentSend({ type: "result", jobId, ...result });
  } catch (e) {
    sfAgentSend({ type: "result", jobId, ok: false, error: sfAgentErrorOf(e) });
    // The job died before the tab got it (no such collection, signed out, no viewer…): the tab may be showing the
    // "getting ready" banner from its page load — have it play the failure and close out, as it would for its own.
    if (touchedTab && !handedOff && SF_AGENT.tabId != null) {   // a refusal before any tab was touched has no banner to close
      chrome.tabs.sendMessage(SF_AGENT.tabId, { type: "SF_AGENT_RUN_END", failed: { who: label, why: sfAgentShortWhy(e) }, next: nextLabel }).catch(() => {});
    }
  } finally {
    SF_AGENT.running = false;
    SF_AGENT.current = null;
    // Another sort was promised → the tab keeps its overlay ("moving on to …").
    // If it never comes (Claude stopped, the user cancelled), close the run out.
    if (nextLabel && !stopped) {
      SF_AGENT.awaitingNext = next || nextLabel;
      SF_AGENT.awaitingLabel = nextLabel;
      SF_AGENT.awaitTimer = setTimeout(() => {
        SF_AGENT.awaitingNext = null;
        SF_AGENT.awaitingLabel = null;
        if (SF_AGENT.tabId != null) chrome.tabs.sendMessage(SF_AGENT.tabId, { type: "SF_AGENT_RUN_END" }).catch(() => {});
      }, SF_AGENT_NEXT_WAIT_MS);
    }
  }
}

// Short banner wording for a failure that happened in this worker, before the tab had the job.
function sfAgentShortWhy(e) {
  const code = (e && e.code) || "";
  return {
    NO_COLLECTION: "no saved collection by that name", AMBIGUOUS_COLLECTION: "more than one collection matches that name", NO_COLLECTIONS: "this account has no saved collections",
    LOGGED_OUT: "sign in to Instagram in this browser first", TAB_TIMEOUT: "the Instagram page didn't finish loading", NO_CONTENT_SCRIPT: "Sort Feed isn't running in the Instagram tab",
    HOURLY_LIMIT: "the hourly limit is used up", DAILY_LIMIT: "the daily limit is used up", COOLING_DOWN: "Sort Feed is pausing for a while", AWAY: "nobody has used this browser for a while",
  }[code] || "something went wrong";
}

// Does the job tab's Sort Feed answer? After an extension reload, pages loaded before it keep scripts that can no
// longer hear us (and keep their banner up): such a tab is navigated afresh, never reused as it is.
async function sfAgentTabAlive(tabId) {
  try { const r = await chrome.tabs.sendMessage(tabId, { type: "SF_AGENT_PING" }); return !!(r && r.ok); } catch (e) { return false; }
}

// The job tab, on `url` — reused as it is when it's already there and alive (a reload would only race the page's
// own rendering); navigated otherwise.
async function sfAgentOpenTabUnless(url) {
  try {
    const t = SF_AGENT.tabId != null ? await chrome.tabs.get(SF_AGENT.tabId) : null;
    if (t && typeof t.url === "string" && t.url.replace(/[?#].*$/, "") === url && (await sfAgentTabAlive(t.id))) return t.id;
  } catch (e) {}
  return sfAgentOpenTab(url);
}

// The extension was reloaded or updated: the previous job tab's scripts are orphaned (mute, banner frozen) — reload it.
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.storage.local.get([SF_AGENT_TAB_KEY], async (r) => {
      const id = r && r[SF_AGENT_TAB_KEY];
      if (!Number.isInteger(id) || typeof chrome.tabs.reload !== "function") return;
      try { const t = await chrome.tabs.get(id); if (t && typeof t.url === "string" && t.url.startsWith("https://www.instagram.com/")) await chrome.tabs.reload(id); } catch (e) {}
    });
  } catch (e) {}
});

// Ask the content script in a tab something (it may not be ready the instant the load completes).
async function sfAgentAskTab(tabId, msg) {
  for (let i = 0; i < 8; i++) {
    try { const r = await chrome.tabs.sendMessage(tabId, msg); if (r) return r; } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// The collection the user meant, from the Saved page's list: by id (the number in its link) or by name — same
// letters ignoring case and punctuation, else the one name that starts with the words, else the one that contains
// them. Anything but exactly one hit goes back to Claude with the names, so it can ask.
function sfAgentMatchCollection(list, want) {
  const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const w = String(want || "").trim();
  const names = list.map((c) => c.name).join(" · ");
  if (!list.length) return { code: "NO_COLLECTIONS", message: "This Instagram account has no saved collections yet — only Saved › All Posts. Don't retry." };
  if (/^\d{5,}$/.test(w)) {
    const hit = list.find((c) => String(c.id) === w);
    return hit ? { hit } : { code: "NO_COLLECTION", message: `No saved collection with id ${w} on this account. Its collections: ${names}. Ask the user which one — don't retry the same id.` };
  }
  const nw = norm(w);
  const exact = list.filter((c) => norm(c.name) === nw || norm(c.slug) === nw);
  if (exact.length === 1) return { hit: exact[0] };
  const starts = exact.length ? exact : list.filter((c) => norm(c.name).startsWith(nw));
  if (starts.length === 1) return { hit: starts[0] };
  const within = starts.length ? starts : list.filter((c) => norm(c.name).includes(nw));
  if (within.length === 1) return { hit: within[0] };
  if (within.length > 1) return { code: "AMBIGUOUS_COLLECTION", message: `“${w}” matches more than one saved collection: ${within.map((c) => c.name).join(" · ")}. Ask the user which one, then call again with that exact name (or its id) — don't retry with the same words.` };
  return { code: "NO_COLLECTION", message: `No saved collection called “${w}” on this account. Its collections: ${names}. Ask the user which one (or check the spelling), then call again with that exact name or its id — don't retry with the same words.` };
}

// Who is signed in to Instagram in the job tab: the content script reads it off any instagram.com page. Ask the tab
// where it is; if it isn't on Instagram (or can't tell), open Instagram's home and ask there.
async function sfAgentFindViewer() {
  const ask = async (tabId) => {
    for (let i = 0; i < 6; i++) {
      try { const r = await chrome.tabs.sendMessage(tabId, { type: "SF_AGENT_VIEWER" }); if (r && r.username) return r.username; if (r && r.ok) return null; } catch (e) {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  };
  try {
    const t = SF_AGENT.tabId != null ? await chrome.tabs.get(SF_AGENT.tabId) : null;
    if (t && typeof t.url === "string" && t.url.startsWith("https://www.instagram.com/") && (await sfAgentTabAlive(t.id))) { const v = await ask(t.id); if (v) return v; }
  } catch (e) {}
  return ask(await sfAgentOpenTab("https://www.instagram.com/"));
}

// One hidden tab, reused across jobs, never focused. Navigates it to the
// profile and waits for the load to complete plus a short hydration settle.
async function sfAgentOpenTab(url) {
  let tab = null;
  if (SF_AGENT.tabId != null) {
    try { tab = await chrome.tabs.get(SF_AGENT.tabId); } catch (e) { tab = null; }
  }
  if (tab) {
    const loaded = sfAgentWaitForLoad(tab.id, 30000); // listen BEFORE navigating
    await chrome.tabs.update(tab.id, { url, active: false });
    await loaded;
  } else {
    tab = await chrome.tabs.create({ url, active: false });
    SF_AGENT.tabId = tab.id;
    try { chrome.storage.local.set({ [SF_AGENT_TAB_KEY]: tab.id }); } catch (e) {}
    await sfAgentWaitForLoad(tab.id, 30000);
  }
  await new Promise((r) => setTimeout(r, 1500));
  return tab.id;
}

function sfAgentWaitForLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const onUpd = (id, info) => {
      if (id !== tabId || info.status !== "complete" || done) return;
      done = true; clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpd);
      resolve();
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      reject(Object.assign(new Error("The Instagram tab didn't finish loading."), { code: "TAB_TIMEOUT" }));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

// The content script may not be ready the instant the load completes — retry
// the handoff for a few seconds before giving up.
async function sfAgentSendJobToTab(tabId, job) {
  let lastErr = null;
  for (let i = 0; i < 8; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "SF_AGENT_JOB", job });
      if (res) return res;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Object.assign(new Error("Sort Feed isn't running in the Instagram tab. Reload the tab and try again."), { code: "NO_CONTENT_SCRIPT", cause: lastErr });
}
