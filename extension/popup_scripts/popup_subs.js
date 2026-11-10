////////////////////////////////////////////////////////////////////////////////
// Footer fade-in helper — re-triggers notionFadeUp when a footer becomes visible
////////////////////////////////////////////////////////////////////////////////
function sfShowFooter(el) {
  if (typeof el === 'string') el = document.getElementById(el);
  el.classList.remove('sf-fade-footer');
  void el.offsetWidth;               // force reflow so animation restarts
  el.classList.add('sf-fade-footer');
  el.style.display = 'flex';

  // Mark the popup "paid" only when the compact icon-only footer is the one
  // showing. subFooter (signed out) and FreeFooter both carry the tall "Get Pro"
  // block, so they're not paid. The sort UI reads body.sf-paid (together with the
  // feature-banner state) to decide when there's room to relax the compacted
  // TikTok sort rows back to full height.
  document.body.classList.toggle('sf-paid', !!el && el.id === 'PaidFooter');
}

////////////////////////////////////////////////////////////////////////////////
// Footer account button — the signed-in user's first initial
// background.js stores { userID, name, email } under sort_feed_user_profile
// when account.sortfeed.com sends the sign-in. A profile only counts while its
// userID matches the signed-in one; none yet → the person icon stays.
////////////////////////////////////////////////////////////////////////////////

const SF_PROFILE_KEY = "sort_feed_user_profile";
// { userID, hasLibrary } — written only by background.js (SF_LIBRARY_STATUS, a first save, sign-out). Like the
// profile, it only counts while its userID matches the signed-in one.
const SF_LIBRARY_KEY = "sort_feed_library";

// The letter and the tooltip title come from the SAME source so they always
// agree: a usable name → its initial + the first name; otherwise the email's
// initial + "Account" (the email right under it explains the letter).
// Array.from keeps a surrogate pair whole; a name starting with anything but
// a letter/digit (emoji, punctuation) falls through to the email.
function sfAccountLabelOf(profile) {
  const first = (value) => {
    const ch = Array.from(String(value || "").trim())[0] || "";
    return /[\p{L}\p{N}]/u.test(ch) ? ch.toLocaleUpperCase() : "";
  };
  const name = String(profile?.name || "").trim();
  const fromName = first(name);
  if (fromName) return { initial: fromName, title: name.split(/\s+/)[0] };
  return { initial: first(profile?.email), title: "Account" };
}

async function sfRenderAccountAvatar() {
  const link = document.getElementById("sfAccountLink");
  const icon = document.getElementById("sfAccountIcon");
  const avatar = document.getElementById("sfAccountAvatar");
  const titleEl = document.getElementById("sfAccountTipTitle");
  const emailEl = document.getElementById("sfAccountEmail");
  if (!link || !icon || !avatar || !titleEl || !emailEl) return;

  let stored = {};
  try {
    stored = await chrome.storage.local.get(["sort_feed_user_id", SF_PROFILE_KEY, SF_LIBRARY_KEY]);
  } catch (e) {
    if (DBUG) console.warn("[Footer] profile read failed", e);
  }

  const profile = stored[SF_PROFILE_KEY];
  const mine = profile && stored.sort_feed_user_id && profile.userID === stored.sort_feed_user_id ? profile : null;
  const { initial, title } = mine ? sfAccountLabelOf(mine) : { initial: "", title: "Account" };
  const email = mine && typeof mine.email === "string" ? mine.email : "";
  const lib = stored[SF_LIBRARY_KEY];
  const hasLibrary = !!(lib && stored.sort_feed_user_id && lib.userID === stored.sort_feed_user_id && lib.hasLibrary === true);

  avatar.textContent = initial;
  avatar.hidden = !initial;
  icon.hidden = !!initial;

  // No library: the avatar is the account link it always was, its tooltip the name over the email.
  // A library: the avatar opens the Library / Account menu; who is signed in moves into the menu's head.
  link.dataset.sfLibrary = hasLibrary ? "1" : "";
  if (hasLibrary) {
    titleEl.textContent = "Library and account";
    emailEl.textContent = "";
    link.setAttribute("aria-label", "Library and account");
    link.setAttribute("aria-haspopup", "menu");
    if (!link.hasAttribute("aria-expanded")) link.setAttribute("aria-expanded", "false");
  } else {
    titleEl.textContent = title;
    emailEl.textContent = email;
    link.setAttribute("aria-label", email ? `${title}, ${email}` : "Account");
    link.removeAttribute("aria-haspopup");
    link.removeAttribute("aria-expanded");
    sfCloseAccountMenu();
  }

  // Menu head: the footer's letter + the first name, or the email when there is no usable name (sfAccountLabelOf
  // titles those "Account"). Nothing to show → no head, just the two rows.
  const head = document.getElementById("sfAccountMenuHead");
  const divider = document.getElementById("sfAccountMenuDivider");
  const menuAvatar = document.getElementById("sfAccountMenuAvatar");
  const nameEl = document.getElementById("sfAccountMenuName");
  if (head && divider && menuAvatar && nameEl) {
    const hasName = !!(mine && String(mine.name || "").trim() && title !== "Account");
    const label = hasName ? title : email;
    menuAvatar.textContent = initial;
    menuAvatar.hidden = !initial;
    nameEl.textContent = label;
    head.hidden = divider.hidden = !label;
  }
}

function sfCloseAccountMenu() {
  const menu = document.getElementById("sfAccountMenu");
  const link = document.getElementById("sfAccountLink");
  if (!menu || menu.classList.contains("sf-hidden")) return;
  menu.classList.add("sf-hidden");
  menu.setAttribute("aria-hidden", "true");
  if (link && link.hasAttribute("aria-expanded")) link.setAttribute("aria-expanded", "false");
  document.querySelectorAll(".footer_div_again_sub.sf-account-open").forEach((f) => f.classList.remove("sf-account-open"));
}

function sfOpenAccountMenu() {
  const menu = document.getElementById("sfAccountMenu");
  const link = document.getElementById("sfAccountLink");
  if (!menu || !link) return;
  menu.classList.remove("sf-hidden");
  menu.setAttribute("aria-hidden", "false");
  link.setAttribute("aria-expanded", "true");
  const footer = link.closest(".footer_div_again_sub");
  if (footer) footer.classList.add("sf-account-open");
}

// Ask background to re-check the library (signed in only). It stores the answer; the storage listener below redraws.
function sfRefreshLibraryStatus() {
  try {
    chrome.runtime.sendMessage({ type: "SF_LIBRARY_STATUS" }, () => void chrome.runtime.lastError);
  } catch (_) { /* the popup must open regardless */ }
}

document.addEventListener("DOMContentLoaded", async () => {
  const link = document.getElementById("sfAccountLink");
  const menu = document.getElementById("sfAccountMenu");
  if (!link || !menu) return;

  // With a library the avatar toggles its menu; without one the click falls through to the account link.
  link.addEventListener("click", (e) => {
    if (link.dataset.sfLibrary !== "1") return;
    e.preventDefault();
    if (menu.classList.contains("sf-hidden")) sfOpenAccountMenu();
    else sfCloseAccountMenu();
  });
  // Capture phase: the ••• trigger stops its own click from bubbling, and that click must still close this menu.
  document.addEventListener("click", (e) => {
    if (link.contains(e.target) || menu.contains(e.target)) return;
    sfCloseAccountMenu();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") sfCloseAccountMenu(); });
  menu.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => sfCloseAccountMenu()));

  // Same rhythm as the Pro check: the footer already drew from the stored answer; signed in → re-check in the background.
  let signedIn = false;
  try { signedIn = !!(await chrome.storage.local.get("sort_feed_user_id")).sort_feed_user_id; } catch (_) { /* signed out */ }
  if (signedIn) sfRefreshLibraryStatus();
});

// Sign-ins and sign-outs from the website land while the popup may be open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[SF_PROFILE_KEY] || changes.sort_feed_user_id || changes[SF_LIBRARY_KEY]) sfRenderAccountAvatar();
  if (changes.sort_feed_user_id?.newValue) sfRefreshLibraryStatus();   // a sign-in (or a new account) while open
});

////////////////////////////////////////////////////////////////////////////////
// Upgrade-click analytics
// One seam for every "Get Pro / Upgrade" surface so the footer bar and the
// dropdown row can be A/B'd by distinct event names. No analytics backend yet —
// this fires a runtime message (background can forward it later) and never
// throws, so a click always still opens the pricing page.
////////////////////////////////////////////////////////////////////////////////

const SF_PRICING_URL = "https://www.sortfeed.com/pricing";

function sfTrackUpgradeClick(eventName, meta = {}) {
  try {
    if (typeof DEBUG !== "undefined" && DEBUG) {
      console.log("[analytics]", eventName, meta);
    }
    chrome.runtime.sendMessage(
      { type: "SF_ANALYTICS", event: eventName, ...meta },
      () => void chrome.runtime.lastError   // swallow "no receiver" errors
    );
  } catch (_) { /* analytics must never break the click */ }
}

////////////////////////////////////////////////////////////////////////////////
// custom dropdown logic (Notion-style)
////////////////////////////////////////////////////////////////////////////////

// Maps custom dropdown id → hidden select id
const SF_DD_MAP = {
  "sf-dd-ig-items":  "no_reels_selected",
  "sf-dd-ig-dates":  "dates_selected",
  "sf-dd-tt-items":  "no_reels_selected_tiktok",
  "sf-dd-tt-dates":  "dates_selected_tiktok",
  "sf-dd-fb-items":  "no_reels_selected_facebook",
  "sf-dd-fb-dates":  "dates_selected_facebook",
  "sf-dd-yt-items":  "no_reels_selected_youtube",
  "sf-dd-yt-dates":  "dates_selected_youtube",
};

// Per-dropdown "Custom…" row label. Only IG overrides it; every other dropdown
// falls back to the plain "Custom…". Applied in sf_dd_init() (before first
// paint) and read back by the reset/select helpers below.
const SF_DD_CUSTOM_LABEL = {
  "sf-dd-ig-items":  "Custom Posts…",
  "sf-dd-ig-dates":  "Custom Date…",
};

// The custom row's resting label, stashed on the element in sf_dd_init().
function sf_custom_label(customOpt) {
  return customOpt?.dataset.customLabel || "Custom…";
}

// Custom range helpers (shared with popup.js migration)
function sf_set_custom_select_value_raw(selectEl, value, label) {
  selectEl.querySelector("option.sf-dd-custom-option")?.remove();
  const opt = document.createElement("option");
  opt.className = "sf-dd-custom-option";
  opt.value = value;
  opt.textContent = label;
  selectEl.appendChild(opt);
  selectEl.value = opt.value;
  selectEl.dispatchEvent(new Event("change"));
}

function sf_set_custom_select_value(selectEl, n) {
  // Items dropdown shortcut — wraps the raw helper with the `Latest N Posts` label format.
  const noun = selectEl.dataset.itemsNoun || "Posts";
  sf_set_custom_select_value_raw(selectEl, `${n}_reels`, `Latest ${n} ${noun}`);
}

function sf_reset_custom_row(menu) {
  const customOpt = menu.querySelector(".sf-dd-opt-custom");
  if (!customOpt) return;
  const lbl = customOpt.querySelector(".sf-dd-opt-label");
  if (lbl) lbl.textContent = sf_custom_label(customOpt);
  customOpt.classList.remove("sf-dd-selected");
  // Re-surface the "New" pill — Pro users see it whenever a preset is the
  // active selection (i.e. custom row is not locked and not selected).
  const pill = customOpt.querySelector(".sf-dd-new-pill");
  if (pill && !customOpt.classList.contains("sf-dd-locked")) {
    pill.classList.add("sf-show");
  }
}

function sf_mark_custom_row_selected(menu, label) {
  const customOpt = menu.querySelector(".sf-dd-opt-custom");
  if (!customOpt) return;
  const lbl = customOpt.querySelector(".sf-dd-opt-label");
  // Keep the resting noun in the selected label: "Custom Posts (347)" etc.
  const base = sf_custom_label(customOpt).replace(/…\s*$/, "");
  if (lbl) lbl.textContent = `${base} (${label})`;
  menu.querySelectorAll(".sf-dd-opt").forEach(o => o.classList.remove("sf-dd-selected"));
  customOpt.classList.add("sf-dd-selected");
  const pill = customOpt.querySelector(".sf-dd-new-pill");
  if (pill) pill.classList.remove("sf-show");
}

// Cancel resets the dropdown to the default preset (the <option selected> in HTML)
// and drops any active custom selection from both the select and the UI.
function sf_reset_to_default(dd, selectEl, menu) {
  selectEl.querySelector("option.sf-dd-custom-option")?.remove();
  const defaultOpt = selectEl.querySelector("option[selected]") || selectEl.options[0];
  if (!defaultOpt) return;
  selectEl.value = defaultOpt.value;
  selectEl.dispatchEvent(new Event("change"));

  const ddLabel = dd.querySelector(".sf-dd-label");
  if (ddLabel) ddLabel.textContent = defaultOpt.textContent;

  menu.querySelectorAll(".sf-dd-opt").forEach(o => o.classList.remove("sf-dd-selected"));
  const matchingDdOpt = menu.querySelector(`.sf-dd-opt[data-value="${defaultOpt.value}"]`);
  if (matchingDdOpt) matchingDdOpt.classList.add("sf-dd-selected");

  sf_reset_custom_row(menu);
}

////////////////////////////////////////////////////////////////////////////////
// Custom date range — calendar widget (UI preview)
////////////////////////////////////////////////////////////////////////////////

const SF_CAL_MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const SF_CAL_MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Per-menu calendar state, keyed by the menu element via WeakMap.
const _sfCalState = new WeakMap();

function _sfStartOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function _sfStartOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function sfFormatDateShort(ms) {
  const d = new Date(ms);
  return `${SF_CAL_MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

function sfFormatDateRange(fromMs, toMs) {
  const f = new Date(fromMs), t = new Date(toMs);
  const today = new Date();
  const sameYear = f.getFullYear() === t.getFullYear() && f.getFullYear() === today.getFullYear();
  if (sameYear) {
    return `${SF_CAL_MONTHS_SHORT[f.getMonth()]} ${f.getDate()} – ${SF_CAL_MONTHS_SHORT[t.getMonth()]} ${t.getDate()}`;
  }
  return `${SF_CAL_MONTHS_SHORT[f.getMonth()]} ${f.getDate()}, ${f.getFullYear()} – ${SF_CAL_MONTHS_SHORT[t.getMonth()]} ${t.getDate()}, ${t.getFullYear()}`;
}

function sfCalRender(panelRoot) {
  const st = _sfCalState.get(panelRoot);
  if (!st) return;
  const grid = panelRoot.querySelector(".sf-cal-grid");
  const titleEl = panelRoot.querySelector(".sf-cal-title");
  if (!grid || !titleEl) return;

  const view = st.visibleMonth; // Date at first of month
  titleEl.textContent = `${SF_CAL_MONTHS[view.getMonth()]} ${view.getFullYear()}`;

  // Build 6 weeks (42 cells) starting on Sunday
  const firstWeekday = view.getDay(); // 0..6 (Sun..Sat)
  const startDate = new Date(view);
  startDate.setDate(1 - firstWeekday);

  const today = _sfStartOfDay(new Date()).getTime();
  const fromMs = st.fromMs;
  const toMs   = st.toMs;
  const hover  = st.hoverMs;

  // Compute preview range when only From is set and user hovers a day.
  let pStart = null, pEnd = null;
  if (fromMs && !toMs && hover != null && hover !== fromMs) {
    pStart = Math.min(fromMs, hover);
    pEnd   = Math.max(fromMs, hover);
  }

  // Compute committed range
  let rStart = null, rEnd = null;
  if (fromMs && toMs) {
    rStart = Math.min(fromMs, toMs);
    rEnd   = Math.max(fromMs, toMs);
  }

  let html = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const dayMs = _sfStartOfDay(d).getTime();
    const otherMonth = d.getMonth() !== view.getMonth();
    const future = dayMs > today;
    const isToday = dayMs === today;
    const isFrom = fromMs != null && dayMs === fromMs;
    const isTo = toMs != null && dayMs === toMs;
    const inRange = (rStart != null && dayMs >= rStart && dayMs <= rEnd) ||
                    (pStart != null && dayMs >= pStart && dayMs <= pEnd);
    const isRangeStart = inRange && rStart != null && dayMs === rStart;
    const isRangeEnd = inRange && rEnd != null && dayMs === rEnd;

    const cls = [
      "sf-cal-day",
      otherMonth ? "sf-cal-day-other-month" : "",
      future ? "sf-cal-day-future" : "",
      isToday ? "sf-cal-day-today" : "",
      (isFrom || isTo) ? "sf-cal-day-endpoint" : "",
      inRange ? "sf-cal-day-in-range" : "",
      isRangeStart ? "sf-cal-day-range-start" : "",
      isRangeEnd ? "sf-cal-day-range-end" : "",
    ].filter(Boolean).join(" ");

    html += `<button type="button" class="${cls}" data-ms="${dayMs}" ${future ? "disabled" : ""}>${d.getDate()}</button>`;
  }
  grid.innerHTML = html;

  // Disable next button when entire next month is in the future
  const next = new Date(view.getFullYear(), view.getMonth() + 1, 1);
  const nextBtn = panelRoot.querySelector(".sf-cal-next");
  if (nextBtn) nextBtn.disabled = next.getTime() > today;
}

function _sfDatePanelSyncFields(panelRoot) {
  const st = _sfCalState.get(panelRoot);
  if (!st) return;
  const status = panelRoot.querySelector(".sf-date-status");
  if (!status) return;
  if (st.fromMs != null && st.toMs != null) {
    const a = Math.min(st.fromMs, st.toMs);
    const b = Math.max(st.fromMs, st.toMs);
    status.textContent = `${sfFormatDateShort(a)} – ${sfFormatDateShort(b)}`;
    status.classList.add("sf-date-status-range");
  } else {
    status.textContent = "";
    status.classList.remove("sf-date-status-range");
  }
}

function _sfDatePanelSyncFocusUI(_panelRoot) {
  /* No-op — From/To input fields removed; calendar conveys focus via endpoint highlight. */
}

function _sfDatePanelSyncAccept(panelRoot) {
  const st = _sfCalState.get(panelRoot);
  const acc = panelRoot.querySelector(".sf-dd-custom-accept");
  const errEl = panelRoot.querySelector(".sf-dd-custom-error");
  if (!acc) return;
  if (!st || st.fromMs == null || st.toMs == null) {
    acc.disabled = true;
    if (errEl) {
      errEl.textContent = "";
      errEl.classList.remove("sf-dd-custom-error-visible");
    }
    return;
  }
  if (st.fromMs > st.toMs) {
    acc.disabled = true;
    if (errEl) {
      errEl.textContent = "From must be on or before To";
      errEl.classList.add("sf-dd-custom-error-visible");
    }
    return;
  }
  acc.disabled = false;
  if (errEl) {
    errEl.textContent = "";
    errEl.classList.remove("sf-dd-custom-error-visible");
  }
}

function sfCalOpen(menu, selectEl) {
  let st = _sfCalState.get(menu);
  if (!st) {
    st = { visibleMonth: _sfStartOfMonth(new Date()), fromMs: null, toMs: null, hoverMs: null, focused: "from" };
    _sfCalState.set(menu, st);
  }

  // Seed from the active custom value (if any) so re-opening shows the saved range.
  const active = selectEl?.value || "";
  const m = /^custom_(\d+)_(\d+)$/.exec(active);
  if (m) {
    const fromMs = parseInt(m[1], 10);
    const toMs   = parseInt(m[2], 10);
    if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
      st.fromMs = fromMs;
      st.toMs = toMs;
      st.visibleMonth = _sfStartOfMonth(new Date(fromMs));
    }
  } else {
    st.fromMs = null;
    st.toMs = null;
    st.visibleMonth = _sfStartOfMonth(new Date());
  }
  st.focused = "from";
  st.hoverMs = null;

  _sfDatePanelSyncFields(menu);
  _sfDatePanelSyncFocusUI(menu);
  _sfDatePanelSyncAccept(menu);
  sfCalRender(menu);
  // Grow the popup so the absolute panel is fully contained.
  document.body.classList.add("sf-date-panel-open");
}

function _sfCalClose() {
  document.body.classList.remove("sf-date-panel-open");
}

function sfDatePanelInit(menu, dd, selectEl) {
  const panel = menu.querySelector(".sf-dd-custom-panel-date");
  if (!panel) return;

  // Stop clicks inside the panel from closing the dropdown.
  panel.addEventListener("click", (e) => e.stopPropagation());

  // Prev / next month nav
  const prevBtn = panel.querySelector(".sf-cal-prev");
  const nextBtn = panel.querySelector(".sf-cal-next");
  if (prevBtn) {
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const st = _sfCalState.get(menu);
      if (!st) return;
      st.visibleMonth = new Date(st.visibleMonth.getFullYear(), st.visibleMonth.getMonth() - 1, 1);
      sfCalRender(menu);
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (nextBtn.disabled) return;
      const st = _sfCalState.get(menu);
      if (!st) return;
      st.visibleMonth = new Date(st.visibleMonth.getFullYear(), st.visibleMonth.getMonth() + 1, 1);
      sfCalRender(menu);
    });
  }

  // Day click + hover (event delegation on the grid)
  const grid = panel.querySelector(".sf-cal-grid");
  if (grid) {
    grid.addEventListener("click", (e) => {
      const cell = e.target.closest(".sf-cal-day");
      if (!cell || cell.disabled || cell.classList.contains("sf-cal-day-future")) return;
      const ms = parseInt(cell.dataset.ms, 10);
      const st = _sfCalState.get(menu);
      if (!st || !Number.isFinite(ms)) return;

      if (st.focused === "from") {
        st.fromMs = ms;
        if (st.toMs != null && st.fromMs > st.toMs) st.toMs = null;
        st.focused = "to";
      } else {
        if (st.fromMs != null && ms < st.fromMs) {
          st.toMs = st.fromMs;
          st.fromMs = ms;
        } else {
          st.toMs = ms;
        }
        st.focused = "from";
      }
      st.hoverMs = null;
      _sfDatePanelSyncFields(menu);
      _sfDatePanelSyncFocusUI(menu);
      _sfDatePanelSyncAccept(menu);
      sfCalRender(menu);
    });

    grid.addEventListener("mouseover", (e) => {
      const cell = e.target.closest(".sf-cal-day");
      if (!cell || cell.disabled) return;
      const st = _sfCalState.get(menu);
      if (!st || st.fromMs == null || st.toMs != null) return;
      const ms = parseInt(cell.dataset.ms, 10);
      if (!Number.isFinite(ms) || ms === st.hoverMs) return;
      st.hoverMs = ms;
      sfCalRender(menu);
    });

    grid.addEventListener("mouseleave", () => {
      const st = _sfCalState.get(menu);
      if (!st || st.hoverMs == null) return;
      st.hoverMs = null;
      sfCalRender(menu);
    });
  }

  // Cancel — clear any active custom date and revert to the default preset.
  const cancelBtn = panel.querySelector(".sf-dd-custom-cancel");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      sf_reset_to_default(dd, selectEl, menu);
      menu.classList.remove("sf-dd-show-custom");
      menu.classList.remove("sf-dd-open");
      _sfCalClose();
    });
  }

  // Accept — apply custom date range, persist via change event, close.
  const acceptBtn = panel.querySelector(".sf-dd-custom-accept");
  if (acceptBtn) {
    acceptBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (acceptBtn.disabled) return;

      const st = _sfCalState.get(menu);
      if (!st || st.fromMs == null || st.toMs == null) return;
      const fromMs = Math.min(st.fromMs, st.toMs);
      const toMs   = Math.max(st.fromMs, st.toMs);

      const value = `custom_${fromMs}_${toMs}`;
      const label = sfFormatDateRange(fromMs, toMs);

      sf_set_custom_select_value_raw(selectEl, value, label);
      const labelEl = dd.querySelector(".sf-dd-label");
      if (labelEl) labelEl.textContent = label;
      sf_mark_custom_row_selected(menu, label);

      menu.classList.remove("sf-dd-show-custom");
      menu.classList.remove("sf-dd-open");
      _sfCalClose();
    });
  }

  // Esc closes dropdown when panel is shown.
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      menu.classList.remove("sf-dd-show-custom");
      menu.classList.remove("sf-dd-open");
      _sfCalClose();
    }
  });
}

// Ensure a dropdown menu has the free-state "Get Pro" nudge row as the last
// item in its options list. IG ships it in the HTML; every other platform's
// dropdowns (TikTok/Facebook/YouTube) get it injected here, so all free
// dropdowns show the same upgrade row. sf_dd_lock()/unlock_all_options() toggle
// its visibility, and the button's click is wired below in sf_dd_init().
function sf_inject_get_pro_row(menu) {
  if (!menu || menu.querySelector(".sf-dd-get-pro")) return;
  const list = menu.querySelector(".sf-dd-options-list");
  if (!list) return;
  list.insertAdjacentHTML("beforeend",
    '<div class="sf-dd-get-pro" style="display:none;">' +
      '<div class="sf-dd-divider"></div>' +
      '<button type="button" class="sf-dd-get-pro-btn" data-sf-upgrade="dropdown_row">' +
        '<span class="sf-dd-get-pro-left">' +
          '<span class="sf-dd-get-pro-icon" aria-hidden="true"></span>' +
          '<span class="sf-dd-get-pro-label">Get Pro</span>' +
        '</span>' +
        '<span class="sf-dd-get-pro-arrow" aria-hidden="true"></span>' +
      '</button>' +
    '</div>'
  );
}

function sf_dd_init() {

  Object.keys(SF_DD_MAP).forEach((ddId) => {
    const dd = document.getElementById(ddId);
    if (!dd) return;

    const trigger = dd.querySelector(".sf-dd-trigger");
    const menu    = dd.querySelector(".sf-dd-menu");
    const selectEl = document.getElementById(SF_DD_MAP[ddId]);

    // Add the free-state Get Pro row (no-op for IG, which already has it in HTML).
    sf_inject_get_pro_row(menu);

    // Apply the per-dropdown "Custom…" label (IG only) and stash it so the
    // reset/select helpers can restore it. Runs before first paint → no flash.
    const customOpt = menu.querySelector(".sf-dd-opt-custom");
    if (customOpt) {
      const customLabel = SF_DD_CUSTOM_LABEL[ddId] || "Custom…";
      customOpt.dataset.customLabel = customLabel;
      const customLbl = customOpt.querySelector(".sf-dd-opt-label");
      if (customLbl) customLbl.textContent = customLabel;
    }

    // open / close
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = menu.classList.contains("sf-dd-open");
      // close all others first (and reset their custom-panel state)
      document.querySelectorAll(".sf-dd-menu.sf-dd-open").forEach(m => {
        m.classList.remove("sf-dd-open");
        m.classList.remove("sf-dd-show-custom");
      });
      if (!isOpen) {
        // Always open on the options list, never on the custom panel.
        menu.classList.remove("sf-dd-show-custom");
        menu.classList.add("sf-dd-open");
      }
    });

    // option click
    menu.querySelectorAll(".sf-dd-opt").forEach((opt) => {
      opt.addEventListener("click", (e) => {
        // Locked "Pro" rows are inert on every platform (they look disabled);
        // only the Get Pro row at the bottom of the menu is clickable.
        if (opt.classList.contains("sf-dd-locked")) return;

        // Custom… row — slide the input panel in.
        if (opt.classList.contains("sf-dd-opt-custom")) {
          e.stopPropagation();
          menu.classList.add("sf-dd-show-custom");

          const datePanel = menu.querySelector(".sf-dd-custom-panel-date");
          if (datePanel) {
            sfCalOpen(menu, selectEl);
            return;
          }

          const input = menu.querySelector(".sf-dd-custom-input");
          const acc   = menu.querySelector(".sf-dd-custom-accept");
          if (input) {
            // Pre-fill if a custom value is currently active
            const customOpt = selectEl.querySelector("option.sf-dd-custom-option");
            if (customOpt && customOpt.value === selectEl.value) {
              input.value = String(parseInt(selectEl.value, 10));
              input.dispatchEvent(new Event("input"));
            } else {
              input.value = "";
              if (acc) acc.disabled = true;
            }
            setTimeout(() => input.focus(), 0);
          }
          return;
        }

        const val = opt.dataset.value;
        const label = opt.querySelector("span:first-child")?.textContent || opt.textContent.trim();

        dd.querySelector(".sf-dd-label").textContent = label;
        selectEl.value = val;
        selectEl.dispatchEvent(new Event("change"));

        // Picking a preset clears any active custom selection.
        selectEl.querySelector("option.sf-dd-custom-option")?.remove();
        sf_reset_custom_row(menu);

        menu.querySelectorAll(".sf-dd-opt").forEach(o => o.classList.remove("sf-dd-selected"));
        opt.classList.add("sf-dd-selected");
        menu.classList.remove("sf-dd-open");
      });
    });

    // Custom panel — preview-only wiring (input validation + buttons close the panel).
    // Real apply / save logic is added in a later phase.
    const customInput  = menu.querySelector(".sf-dd-custom-input");
    const customAccept = menu.querySelector(".sf-dd-custom-accept");
    const customCancel = menu.querySelector(".sf-dd-custom-cancel");
    const customError  = menu.querySelector(".sf-dd-custom-error");
    const customPanel  = menu.querySelector(".sf-dd-custom-panel");

    if (customInput && customAccept && customPanel) {
      customPanel.addEventListener("click", (e) => e.stopPropagation());

      const setError = (msg) => {
        if (msg) {
          customError.textContent = msg;
          customError.classList.add("sf-dd-custom-error-visible");
          customInput.classList.add("sf-dd-custom-input-error");
        } else {
          customError.textContent = "";
          customError.classList.remove("sf-dd-custom-error-visible");
          customInput.classList.remove("sf-dd-custom-input-error");
        }
      };

      const errorNoun = (selectEl?.dataset?.itemsNoun || "Posts").toLowerCase();

      customInput.addEventListener("input", () => {
        const raw = customInput.value.replace(/[^\d]/g, "");
        if (raw !== customInput.value) customInput.value = raw;
        if (raw === "") {
          setError("");
          customAccept.disabled = true;
          return;
        }
        const n = parseInt(raw, 10);
        if (n > 10000) {
          setError(`Custom ${errorNoun} can't go beyond 10K`);
          customAccept.disabled = true;
        } else if (n < 1) {
          setError(`Custom ${errorNoun} must be at least 1`);
          customAccept.disabled = true;
        } else {
          setError("");
          customAccept.disabled = false;
        }
      });

      customInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !customAccept.disabled) {
          e.preventDefault();
          customAccept.click();
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (customCancel) customCancel.click();
        }
      });

      if (customCancel) {
        customCancel.addEventListener("click", (e) => {
          e.stopPropagation();
          // Cancel clears any active custom value and reverts to the default preset.
          sf_reset_to_default(dd, selectEl, menu);
          menu.classList.remove("sf-dd-show-custom");
          menu.classList.remove("sf-dd-open");
          setError("");
        });
      }

      customAccept.addEventListener("click", (e) => {
        e.stopPropagation();
        const n = parseInt((customInput.value || "").replace(/[^\d]/g, ""), 10);
        if (!Number.isFinite(n) || n < 1 || n > 10000) return; // safety net
        sf_set_custom_select_value(selectEl, n);
        const noun = selectEl.dataset.itemsNoun || "Posts";
        dd.querySelector(".sf-dd-label").textContent = `Latest ${n} ${noun}`;
        sf_mark_custom_row_selected(menu, n);
        setError("");
        menu.classList.remove("sf-dd-show-custom");
        menu.classList.remove("sf-dd-open");
      });
    }


    // Date custom panel wiring — calendar interactions (preview only for now).
    const datePanel = menu.querySelector(".sf-dd-custom-panel-date");
    if (datePanel) {
      sfDatePanelInit(menu, dd, selectEl);
    }

    // Upgrade row inside menu (Notion-style, free/signed-out only)
    const getProBtn = dd.querySelector(".sf-dd-get-pro-btn");
    if (getProBtn) {
      getProBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        sfTrackUpgradeClick("upgrade_click_dropdown_row", { dropdown: ddId });
        window.open(SF_PRICING_URL, "_blank");
      });
    }
  });

  // close on outside click
  document.addEventListener("click", () => {
    document.querySelectorAll(".sf-dd-menu.sf-dd-open").forEach(m => {
      m.classList.remove("sf-dd-open");
      m.classList.remove("sf-dd-show-custom");
    });
    _sfCalClose();
  });
}

////////////////////////////////////////////////////////////////////////////////
// feature gating — lock / unlock custom dropdowns
////////////////////////////////////////////////////////////////////////////////

function handle_lock_emojis() {
  // Free state: mark the body so the dropdowns show a "selected" check on the
  // one unlocked (first) option. Pro clears it in unlock_all_options().
  document.body.classList.add("sf-locked");
  // lock IG items (exempt: first option)
  sf_dd_lock("sf-dd-ig-items", 0);
  // lock IG dates (exempt: first option)
  sf_dd_lock("sf-dd-ig-dates", 0);
  // lock TT items (exempt: first option)
  sf_dd_lock("sf-dd-tt-items", 0);
  // lock TT dates (exempt: first option)
  sf_dd_lock("sf-dd-tt-dates", 0);
  // lock FB items (exempt: first option)
  sf_dd_lock("sf-dd-fb-items", 0);
  // lock FB dates (exempt: first option)
  sf_dd_lock("sf-dd-fb-dates", 0);
  // lock YT items (exempt: first option)
  sf_dd_lock("sf-dd-yt-items", 0);
  // lock YT dates (exempt: first option)
  sf_dd_lock("sf-dd-yt-dates", 0);

  // also keep hidden selects consistent
  _lock_hidden_select("no_reels_selected",          "25_reels");
  _lock_hidden_select("dates_selected",              "1_week");
  _lock_hidden_select("no_reels_selected_tiktok",    "25_reels");
  _lock_hidden_select("dates_selected_tiktok",       "1_week");
  _lock_hidden_select("no_reels_selected_facebook",  "25_reels");
  _lock_hidden_select("dates_selected_facebook",     "1_week");
  _lock_hidden_select("no_reels_selected_youtube",   "25_reels");
  _lock_hidden_select("dates_selected_youtube",      "1_week");
}

function sf_dd_lock(ddId, exemptIndex) {
  const dd = document.getElementById(ddId);
  if (!dd) return;
  const opts = dd.querySelectorAll(".sf-dd-opt");
  opts.forEach((opt, i) => {
    if (i === exemptIndex) {
      opt.classList.remove("sf-dd-locked");
    } else {
      opt.classList.add("sf-dd-locked");
      // add Pro pill if not already there
      if (!opt.querySelector(".sf-dd-pro-pill")) {
        const pill = document.createElement("span");
        pill.className = "sf-dd-pro-pill";
        pill.textContent = "Pro";
        opt.appendChild(pill);
      }
    }
  });
  // show Get Pro nudge inside menu
  const getPro = dd.querySelector(".sf-dd-get-pro");
  if (getPro) getPro.style.display = "flex";
}

function _lock_hidden_select(selectId, exemptValue) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  for (const opt of sel.options) {
    opt.disabled = opt.value !== exemptValue;
  }
}

function unlock_all_options() {
  // Pro state: no "selected" check on any option.
  document.body.classList.remove("sf-locked");
  ["sf-dd-ig-items","sf-dd-ig-dates","sf-dd-tt-items","sf-dd-tt-dates","sf-dd-fb-items","sf-dd-fb-dates","sf-dd-yt-items","sf-dd-yt-dates"].forEach((ddId) => {
    const dd = document.getElementById(ddId);
    if (!dd) return;
    dd.querySelectorAll(".sf-dd-opt").forEach(opt => {
      opt.classList.remove("sf-dd-locked");
      // remove Pro pill from DOM entirely
      const pill = opt.querySelector(".sf-dd-pro-pill");
      if (pill) pill.remove();
    });
    // hide Get Pro nudge
    const getPro = dd.querySelector(".sf-dd-get-pro");
    if (getPro) getPro.style.display = "none";
  });

  // unlock hidden selects too
  ["no_reels_selected","dates_selected","no_reels_selected_tiktok","dates_selected_tiktok","no_reels_selected_facebook","dates_selected_facebook","no_reels_selected_youtube","dates_selected_youtube"].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    for (const opt of sel.options) opt.disabled = false;
  });

  // Pro user: surface the "New" pill on the Custom… row (until first use).
  sf_apply_custom_new_pills();
}

// Show the "New" pill on every Custom… row whose dropdown is currently sitting
// on a preset (not on a custom selection). Called from unlock_all_options(), so
// it only ever runs on Pro users.
function sf_apply_custom_new_pills() {
  document.querySelectorAll(".sf-dd-opt-custom").forEach(customOpt => {
    const pill = customOpt.querySelector(".sf-dd-new-pill");
    if (!pill) return;
    if (customOpt.classList.contains("sf-dd-selected")) {
      pill.classList.remove("sf-show");
    } else {
      pill.classList.add("sf-show");
    }
  });
}



function add_activate_pro_footer() {
  sfShowFooter("subFooter");
  // document.querySelector(".footer_div_again_sub_feature").style.display = "none";
}

////////////////////////////////////////////////////////////////////////////////
// handle footer logic 
////////////////////////////////////////////////////////////////////////////////

function show_footer_based_on_state(userState) { 
  // signout footer 
  if (userState==='SIGNED OUT') {
  // document.getElementById("sendEmailFooter").style.display = "none"; // for activation page
  sfShowFooter("subFooter"); // for sigout users
  document.getElementById("PaidFooter").style.display = "none"; // for paid signed in users
  document.getElementById("FreeFooter").style.display = "none"; // for free signed in users
  }
  // sign-in footer FREE — now shows the same compact footer as Pro. Free
  // signed-in users reach their account via the footer's Account icon, so the
  // old "Go to your account" (#FreeFooter) text bar is no longer used.
  else if (userState==='FREE SIGNED-IN') {
  // document.getElementById("sendEmailFooter").style.display = "none"; // for activation page
  document.getElementById("subFooter").style.display = "none"; // for sigout users
  document.getElementById("FreeFooter").style.display = "none"; // legacy free footer, retired
  sfShowFooter("PaidFooter"); // free signed in users now see the compact (pro) footer
  sfRenderAccountAvatar();

  }
  // sign-in footer PAID
  else if (userState==='PAID SIGNED-IN') {
  // document.getElementById("sendEmailFooter").style.display = "none"; // for activation page
  document.getElementById("subFooter").style.display = "none"; // for sigout users
  sfShowFooter("PaidFooter"); // for paid signed in users
  sfRenderAccountAvatar();
  document.getElementById("FreeFooter").style.display = "none"; // for free signed in users
  } 
}

////////////////////////////////////////////////////////////////////////////////
// get state of a user based on userID 
////////////////////////////////////////////////////////////////////////////////

// async function fetchUserStateFromWorker(userID) {
//   if (!userID) return null;

//   // TODO: replace with your real worker URL (or your custom domain)
//   const WORKER_URL = "https://get-user-state-based-on-userid.taher-el-sheikh.workers.dev/";

//   try {
//     const res = await fetch(WORKER_URL, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify({ userID }),
//     });

//     if (!res.ok) return null;

//     const data = await res.json().catch(() => null);
//     // expected shape: { userState: "free" | "pro" | "legacy" | null, stateType, subType }
//     return data?.userState ?? null;
//   } catch (err) {
//     console.error("Worker call failed:", err);
//     return null;
//   }
// }

function fetchUserStateFromBackground(userID) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "GET_STATE_BASED_USERID", userID },
      (resp) => {
        // resp is expected: { type: "HANDLE_STATE_BASED_USERID", userState }
        resolve(resp?.userState ?? null);
      }
    );
  });
}

////////////////////////////////////////////////////////////////////////////////
// save state type to local storage 
////////////////////////////////////////////////////////////////////////////////

async function save_state_type_for_user(stateType) {
  await chrome.storage.local.set({ sort_feed_state_type_flag: stateType });
}

////////////////////////////////////////////////////////////////////////////////
// set intial ui based on state type flag if its avaiable 
////////////////////////////////////////////////////////////////////////////////

function setView(sf_state_type_flag) {
  // free 
  if (sf_state_type_flag === "free") {
    handle_lock_emojis(); // add lock icons
    show_footer_based_on_state("FREE SIGNED-IN"); // add correct footer
  }

  // pro 
  else if (sf_state_type_flag === "pro") {
    unlock_all_options(); // remove lock icons 
    pro_tag_added(); // add pro tag 
    show_footer_based_on_state("PAID SIGNED-IN"); // add correct footer
  }
}

////////////////////////////////////////////////////////////////////////////////
// check user is pro vs. free    
////////////////////////////////////////////////////////////////////////////////

document.addEventListener("DOMContentLoaded", async () => {
  sf_dd_init(); // boot custom dropdowns
  unlock_all_options();
  pro_tag_added();
  show_footer_based_on_state("PAID SIGNED-IN");
  chrome.storage.local.set({
    sort_feed_state_type_flag: "pro",
    sort_feed_user_id: "viralspy_local_pro",
  });
});


// document.addEventListener("DOMContentLoaded", async function () {

//   const { sf_state_type_flag } = await chrome.storage.local.get("sort_feed_state_type_flag");
//   if (sf_state_type_flag) setView(sf_state_type_flag);

//   // 01 check if sort_feed_user_id is in storage
//   const { sort_feed_user_id } = await chrome.storage.local.get("sort_feed_user_id");

//   // console.log(sort_feed_user_id);

//   // If missing => signed out UI, no worker call
//   if (!sort_feed_user_id) {
//     // console.log("No userID found in storage");
//     handle_lock_emojis(); // add lock icons
//     show_footer_based_on_state("SIGNED OUT"); // add correct footer  
//     await save_state_type_for_user('free'); // add free as local chrome storage 
//     return;
//   }

//   // 02 make call to cloudflare to check user state based on userID
//   const userState = await fetchUserStateFromBackground(sort_feed_user_id);

//   // Handle worker result
//   if (userState === "pro" && sf_state_type_flag!=='pro') {
//     unlock_all_options(); // remove lock icons 
//     pro_tag_added(); // add pro tag 
//     show_footer_based_on_state("PAID SIGNED-IN"); // add correct footer
//     await save_state_type_for_user('pro'); // add pro as local chrome storage 
//     return;
//   }

//   if (userState === "free" && sf_state_type_flag!=='free') {
//     handle_lock_emojis(); // add lock icons
//     show_footer_based_on_state("FREE SIGNED-IN"); // add correct footer
//     await save_state_type_for_user('free'); // add free as local chrome storage 
//     return;
//   }

//   // // Handle worker result
//   // if (userState === "pro") {
//   //   unlock_all_options(); // remove lock icons 
//   //   pro_tag_added(); // add pro tag 
//   //   show_footer_based_on_state("PAID SIGNED-IN"); // add correct footer
//   //   await save_state_type_for_user('pro'); // add pro as local chrome storage 
//   //   return;
//   // }

//   // if (userState === "free") {
//   //   handle_lock_emojis(); // add lock icons
//   //   show_footer_based_on_state("FREE SIGNED-IN"); // add correct footer
//   //   await save_state_type_for_user('free'); // add free as local chrome storage 
//   //   return;
//   // }

//   // null/unknown => treat as signed out (or "unknown")
//   handle_lock_emojis(); // add lock icons
//   show_footer_based_on_state("SIGNED OUT"); // add correct footer
//   await save_state_type_for_user('free'); // add free as local chrome storage 
// });

// document.addEventListener("DOMContentLoaded", async function () {
//     // 01 check if sort_feed_user_id is in storage 
//     // 02 if its not there or null then run these functions handle_lock_emojis() & add_activate_pro_footer();  
//     // 03 if its there then run these functions pro_tag_added(); show_join_discord_banner(); unlock_all_options(); 
//     // 04 create worker that gets user id and returns free vs. pro, else null 
//     // 05 if pro then run these functions pro_tag_added(); show_join_discord_banner(); unlock_all_options(); 
//     // 06 if pro then run these functions pro_tag_added(); show_join_discord_banner(); unlock_all_options(); 

//   chrome.runtime.sendMessage({ command: 'checkProStatus' }, (response) => {
//     if (response?.isPro) {
//       // add pro tag 
//       pro_tag_added(); 
//       show_join_discord_banner(); 
//       unlock_all_options(); 
//     } 
//     else {
//       // add chains & disable non-pro content! 
//       handle_lock_emojis();
//       add_activate_pro_footer(); 
//     } 

//   });
// });
  
function first_time_pro() {
  // add pro tag 
  pro_tag_added(); 
  // add new footer 
  // show_join_discord_banner(); 
  // remove lock emojis and disable stuff !
  unlock_all_options(); 
}

////////////////////////////////////////////////////////////////////////////////
// someone  
////////////////////////////////////////////////////////////////////////////////

function save_locally_user_pro() {
  chrome.runtime.sendMessage({ command: 'activatePro' });
}

////////////////////////////////////////////////////////////////////////////////
// rotate between footer (discord vs. leave us review) 
////////////////////////////////////////////////////////////////////////////////

// function add_footer_and_rotate_message() {
//   const showReview = Math.random() < 0.3;
//   const footerBanner = document.getElementById('footerBannerText');

//   if (showReview) {
//     footerBanner.innerHTML = `
//       Enjoying Sort Feed? 
//       <a href="https://chromewebstore.google.com/detail/sort-feed-works-on-instag/lhiilgfanjkbombmnlfelondlfohfpfg/reviews" target="_blank" class="footer-text-link discord-link">
//         Leave a review →
//       </a>
//     `;
//   } else {
//     footerBanner.innerHTML = `
//       Share feedback or feature ideas on
//       <a href="https://discord.gg/qqu5CRn8Jd" target="_blank" class="footer-text-link discord-link">
//         Discord →
//       </a>
//     `;
//   }
//   document.getElementById("joinDiscord").style.display = "flex";
// }

// // new paid_footer 
// function show_paid_footer() {
//   document.getElementById("joinDiscord").style.display = "flex";
// } 

////////////////////////////////////////////////////////////////////////////////
// handle clicks on activate pro 
////////////////////////////////////////////////////////////////////////////////

// function show_join_discord_banner() {
//   document.getElementById("sendEmailFooter").style.display = "none";
//   document.getElementById("subFooter").style.display = "none";
//   add_footer_and_rotate_message(); 
// }

// The license flow's red banner. This used to be a second, byte-identical copy
// of showPopupWarning — same id, markup, dwell and exit — including its
// "no-op while one is showing" behaviour, so hitting Activate twice with a bad
// key looked like the popup had frozen. Delegating means the license errors
// inherit the in-place message swap (and can't drift from the sort errors).
// popup.js is loaded before this file, so the function is always defined.
function show_error_banner(error_text) {
  if (typeof showPopupWarning === 'function') showPopupWarning(error_text);
}

function show_error_banner_no_icon(error_text) {
  const chrome = document.getElementsByClassName("main_div")[0];
  const chrome_div = document.createElement('div');
  chrome_div.className = 'warning_message animate__animated animate__bounceInRight';
  chrome_div.style.setProperty('--animate-duration', '.5s');
  chrome_div.style.cssText = "z-index: 100; position: relative; background-color: #fbe8ea; position: absolute; padding-left: 17px; padding-right: 17px;";
  chrome_div.id = 'error_message';
  chrome_div.innerHTML = `
  <p class="warning_text">
  ${error_text}
  </p>
  `;
  chrome.insertBefore(chrome_div, chrome.firstChild);

  setTimeout(() => {
    chrome_div.style.display = 'none';
  }, 4500);
}

function show_sucess_banner() {
  const chrome = document.getElementsByClassName("main_div")[0];
  if (!chrome) return;

  // Prevent duplicates
  const existing = document.getElementById('success_message');
  if (existing) existing.remove();

  const chrome_div = document.createElement('div');
  chrome_div.className = 'sucess_message animate__animated animate__bounceInRight';
  chrome_div.style.setProperty('--animate-duration', '.5s');
  chrome_div.style.cssText = `
    z-index: 100;
    position: absolute;
    width: 100%;
    background-color: #F7FFF8;
    padding: 0 16px;
    box-sizing: border-box;
  `;
  chrome_div.id = 'success_message';
  chrome_div.innerHTML = `
    <p class="sucess_text">
      <img src="Icons/ZeroStateIcons/Party.png" alt="Success Icon" style="width: 13px; vertical-align: middle; margin-right: 5px; margin-top: -0.1rem;">
      Welcome to Sort Feed Pro!
    </p>
  `;
  chrome.insertBefore(chrome_div, chrome.firstChild);

  // Animate out (up) smoothly after 3.5s
  setTimeout(() => {
    // Inject custom exit animation once
    if (!document.getElementById('sf-exit-style')) {
      const style = document.createElement('style');
      style.id = 'sf-exit-style';
      style.textContent = `
        @keyframes sfExitUp {
          0%   { transform: translateY(0); opacity: 1; filter: none; }
          40%  { transform: translateY(-6px); opacity: 0.9; filter: blur(0.3px); }
          100% { transform: translateY(-120%); opacity: 0; filter: blur(1px); }
        }
        .sf-exit-up {
          animation: sfExitUp 0.35s cubic-bezier(.22,1,.36,1) forwards;
          will-change: transform, opacity, filter;
        }
      `;
      document.head.appendChild(style);
    }

    // Trigger exit animation
    chrome_div.classList.remove('animate__bounceInRight');
    chrome_div.classList.add('sf-exit-up');

    // Remove element when animation ends
    chrome_div.addEventListener('animationend', () => chrome_div.remove(), { once: true });
  }, 3500);
}

function slide_pro_ui() {
  // Get current active tab URL
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    var url = tabs[0].url || "";

    if (url.includes("tiktok.com")) {
      const subDiv = document.querySelector(".TikTokMain");
      if (subDiv) {
        subDiv.style.display = "flex";
        subDiv.classList.add("slide-left-animation");

      }
      // This path re-shows a feed without going through its *_mode_on(), so the
      // header gear has to be repointed here too.
      sfSetSettingsSurface("tt");
      document.getElementsByClassName("main_nav_div_zero_state_sub")[0].style.display = "none";

    } else if (url.includes("instagram.com")) {
      const subDiv = document.querySelector(".InstaMain");
      if (subDiv) {
        subDiv.style.display = "flex";
        subDiv.classList.add("slide-left-animation");
      }
      sfSetSettingsSurface("ig");
      document.getElementsByClassName("main_nav_div_zero_state_sub")[0].style.display = "none";

    } else {
      const subDiv = document.querySelector(".main_nav_div_zero_state");
      if (subDiv) {
        subDiv.style.display = "flex";
        subDiv.classList.add("slide-left-animation");
      }
      sfSetSettingsSurface(null);
      document.getElementsByClassName("main_nav_div_zero_state_sub")[0].style.display = "none";
    }
  });
}

function pro_tag_added() {
  // Update beta tag
  const betaSpan = document.querySelector('.beta');
  if (betaSpan) {
    betaSpan.innerHTML = '';

    const icon = document.createElement('img');
    icon.src = 'Icons/ZeroStateIcons/black_star.svg';
    icon.style.width = '5px';
    icon.style.marginRight = '2px';

    const textNode = document.createTextNode('Pro');

    betaSpan.style.backgroundColor = '#fde082';
    betaSpan.style.color = 'black';
    betaSpan.style.display = 'inline-flex';
    betaSpan.style.alignItems = 'center';

    betaSpan.appendChild(icon);
    betaSpan.appendChild(textNode);
  }    
}


function active_button_loading_on() {
  const activateButton = document.getElementById("activiatePro");
  const img = activateButton.querySelector("img");
  img.src = "Icons/ZeroStateIcons/loading.png";
  img.style.animation = "spin 0.5s linear infinite"; // ⚡ Faster spin
}

function active_button_loading_off() {
  const activateButton = document.getElementById("activiatePro");
  const img = activateButton.querySelector("img");
  img.src = "Icons/ZeroStateIcons/black_star.svg";
  img.style.animation = "none"; // Stop spinning
}

function add_confetti() {
  confetti({
    particleCount: 200,
    spread: 70,
    origin: { y: 0.6 }
  });
}

////////////////////////////////////////////////////////////////////////////////
// liceney key entered flow 
////////////////////////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////////////////////////
// CONTENT SCRIPT
////////////////////////////////////////////////////////////////////////////////

// --- 1️⃣ Send message to background to check if user exists on server ---
function checkUserOnServer(email, licenseKey) {            // ✨ CHANGED: added licenseKey param
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "CHECK_SERVER_USER", email, licenseKey },    // ✨ CHANGED: include licenseKey in payload
      (resp) => resolve(resp || { ok: false, error: "no-response" })
    );
  });
}

async function handleServerUserCheck(userChromeEmail, licenseKey) { 
  if (!userChromeEmail) {
    if (DEBUG) console.warn("⚠️ No Chrome email found — skipping server check");
    return;
  }

  // ✨ CHANGED: pass licenseKey into the check call
  const srv = await checkUserOnServer(userChromeEmail, licenseKey);
  if (DEBUG) console.log("[CHECK_SERVER_USER] response:", srv);

  if (!srv.ok) {
    if (DEBUG) console.warn("Server check failed:", srv.error);
    return;
  }

  if (srv.found) {
    if (DEBUG) console.log("✅ User found on server. Row:", srv.row);
  } else {
    if (DEBUG) console.log("🚫 User NOT found on server.");
  }
}

async function cloudflare_activate(licenseInput, userChromeEmail) {
  try {
    const res = await fetch('https://sortfeedtest.taher-el-sheikh.workers.dev/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: licenseInput })
    });

    const data = await res.json();

    if (data.activated) {
      // ✨ CHANGED: pass licenseInput as the licenseKey to server check
      await handleServerUserCheck(userChromeEmail, licenseInput);

      confetti({ particleCount: 200, spread: 70, origin: { y: 0.6 } });
      show_sucess_banner();
      slide_pro_ui();
      first_time_pro();
    } else if (data.error === 'This license key has reached the activation limit.') {
      show_error_banner("This key was already used before and it reached it's activation limit");
    } else {
      show_error_banner('Oops! This is an invalid key');
    }
  } catch (err) {
    if (DEBUG) console.error(err);
  } finally {
    active_button_loading_off();
  }
}

////////////////////////////////////////////////////////////////////////////////
// active pro click 
////////////////////////////////////////////////////////////////////////////////

var activiatePro = document.getElementById("activiatePro");
var licenseInputField = document.querySelector(".license-input_sub");

// Activate on button click
activiatePro.addEventListener("click", function () {
  triggerActivation();
});

// Activate on Enter key
licenseInputField.addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    triggerActivation();
  }
});


function isBraveBrowser() {
  const ua = navigator.userAgent || "";
  const brands = navigator.userAgentData?.brands || [];
  
  const isBrave = !!navigator.brave;

  return isBrave;
}

function isChromeBrowser() {
  const ua = navigator.userAgent || "";
  const brands = navigator.userAgentData?.brands || [];
  
  const hasGoogleChrome = brands.some(b => b.brand === "Google Chrome");
  return hasGoogleChrome;
}



// Helper: Ask background for Chrome email
function getUserChromeEmail() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_CHROME_EMAIL" }, (response) => {
      resolve(response?.email || "");
    });
  });
}

// Existing triggerActivation flow, updated
async function triggerActivation() {
  const licenseInput = licenseInputField.value.trim();

  if (!licenseInput) {
    show_error_banner("Please enter your license key!");
    return;
  }

  active_button_loading_on();

  // // ❌ Detect if NOT Chrome (Brave, Arc, Edge, etc.)
  // if (isRealChrome()) {
  //   show_error_banner_no_icon("Sort Feed Pro doesn't work with Brave at the moment. Please switch to Chrome to continue.");
  //   active_button_loading_off();
  //   return;
  // }

  // Get Chrome email before activating
  const userChromeEmail = await getUserChromeEmail();

  if (!userChromeEmail) {
      if (isChromeBrowser()) {
        show_error_banner_no_icon("Unable to fetch your Chrome email. Make sure you're signed into a Chrome profile, not Guest mode.");
        active_button_loading_off();
        return;
      }
      if (isBraveBrowser()) {
        show_error_banner_no_icon("Sort Feed Pro isn't compatible with Brave yet. Please use Chrome to continue.");
        active_button_loading_off();
        return;
      }
      else {
        show_error_banner("Unable to fetch your Chrome email. Please sign into a Chrome profile using Chrome to continue.");
        active_button_loading_off(); // optional — reset button state
        return;
      }
  }

  // error 01: can't fetch & not using chrome 

  // error 02: can't fetch & using chrome 

  // ✅ Email confirmed → proceed
  if (DEBUG) console.log("✅ Chrome email found:", userChromeEmail);
  cloudflare_activate(licenseInput, userChromeEmail); // pass it if needed
}

////////////////////////////////////////////////////////////////////////////////
// clicks on Get Pro - open up Lemon Squeezy! 
////////////////////////////////////////////////////////////////////////////////

["get_pro_button_signed_out", "get_pro_button_free"].forEach((id) => {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener("click", () => {
    sfTrackUpgradeClick("upgrade_click_footer_bar", { surface: id });
    window.open(SF_PRICING_URL, "_blank");
  });
});

////////////////////////////////////////////////////////////////////////////////
// handle clicks on Enter License Key 
////////////////////////////////////////////////////////////////////////////////

var EnterLicenseKey = document.getElementById("EnterLicenseKey");
EnterLicenseKey.addEventListener("click", function () {
  // make tiktok, insta, zero state go, subs footer set to none!   
  document.querySelector(".main_nav_div_zero_state").style.display = "none";
  document.querySelector(".TikTokMain").style.display = "none";
  document.querySelector(".InstaMain").style.display = "none";
  sfSetSettingsSurface(null); // no feed on screen → no header gear
  document.getElementById("subFooter").style.display = "none";

  // take users to website 
  chrome.tabs.create({ url: "https://account.sortfeed.com" })

  // // show add active id page 
  // const subDiv = document.querySelector(".main_nav_div_zero_state_sub");
  // subDiv.style.display = "flex";
  // subDiv.classList.add("slide-left-animation");
  // document.getElementById("sendEmailFooter").style.display = "flex";
}) 


////////////////////////////////////////////////////////////////////////////////
// listening to changes in states coming from the website 
////////////////////////////////////////////////////////////////////////////////

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "HANDLE_STATE_FROM_WEBSITE") return;

  const userState = msg?.userState ?? null;

  if (userState === "pro") {
    save_state_type_for_user("pro");
    unlock_all_options();
    pro_tag_added();
    show_footer_based_on_state("PAID SIGNED-IN");
  } else if (userState === "free") {
    save_state_type_for_user("free");
    handle_lock_emojis();
    show_footer_based_on_state("FREE SIGNED-IN");
    chrome.storage.local.set({ sort_feed_state_type_flag: "free" });
  } else {
    save_state_type_for_user("signed-out");
    handle_lock_emojis();
    show_footer_based_on_state("SIGNED OUT");
    chrome.storage.local.set({ sort_feed_state_type_flag: "free" });
  }
});

////////////////////////////////////////////////////////////////////////////////
// handle clicks on back 
////////////////////////////////////////////////////////////////////////////////

var backButton = document.getElementById("BackFromLicensePage");

backButton.addEventListener("click", function () { 
  // Hide the license key page
  document.querySelector(".main_nav_div_zero_state_sub").style.display = "none";
  
  // Get the active tab URL (in a Chrome extension popup)
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var url = tabs[0].url || "";

    if (url.includes("tiktok.com")) {
      const subDiv = document.querySelector(".TikTokMain");
      subDiv.style.display = "flex";
      subDiv.classList.add("slide-right-animation");
      // Re-shows a feed outside its *_mode_on() — repoint the header gear.
      sfSetSettingsSurface("tt");
      // document.getElementById("sendEmailFooter").style.display = "none";
      sfShowFooter("subFooter");

    } else if (url.includes("instagram.com")) {
      const subDiv = document.querySelector(".InstaMain");
      subDiv.style.display = "flex";
      subDiv.classList.add("slide-right-animation");
      sfSetSettingsSurface("ig");
      // document.getElementById("sendEmailFooter").style.display = "none";
      sfShowFooter("subFooter");

    } else {
      const subDiv = document.querySelector(".main_nav_div_zero_state");
      subDiv.style.display = "flex";
      subDiv.classList.add("slide-right-animation");
      sfSetSettingsSurface(null);
      // document.getElementById("sendEmailFooter").style.display = "none";
      sfShowFooter("subFooter");
    }
  });
});