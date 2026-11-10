// ─────────────────────────────────────────────────────────────────────────────
// Sort Feed — toolbar icon progress while a sort runs (service worker)
//
// new-sort-logic Phase 0 (2026-11-03). Option B, "colour sweep", on the
// "Toolbar progress · five options" board of the Parallel IG sorts canvas.
// Plan: NEW_SORT_PLAN.md.
//
//   start     → the colour logo shrinks away while a grey one pops in, the
//               same motion as the check at the end
//   progress  → its colour comes back clockwise from 12 o'clock with the
//               snackbar's %; the hover tooltip says "Sorting @natgeo · 34%"
//   done      → the colour tops off, the logo slips away as a check pops in,
//               the check holds ~1s, then the logo grows back to normal
//   stopped / failed → the colour sweeps back to full, no check
//
// Chrome only lets an extension swap the toolbar image, so every frame is drawn
// here on an OffscreenCanvas and handed to chrome.action.setIcon({ imageData }).
// Frames run only while something moves (an ease toward a new %, the check) and
// stop when the picture is still, so a long sort doesn't spam setIcon.
//
// The content script sends { type: "SF_ACTION_RING", state, pct, dark, who }
// (see _sfRing* in Instagram/banner_on_insta.js). Only the tab that started the
// sort drives it. Safety nets: a sort that goes quiet for IDLE_MS, its tab
// reloading or closing, or this worker starting up fresh all put the normal
// icon back, so a grey logo can never be left behind.
// ─────────────────────────────────────────────────────────────────────────────
(() => {
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log("[sf-ring]", ...a); };
  // Paused 2026-11-09 (user): the toolbar keeps the plain Sort Feed logo and its
  // usual tooltip — no sweep, no check. Flip to true to bring the animation back.
  const SF_ACTION_RING_ON = false;

  const SIZES = [16, 32];
  const DEFAULT_ICON = { 16: "Icons/16 Sort Feed.png", 48: "Icons/48 Sort Feed.png", 128: "Icons/128 Sort Feed.png" };
  const FRAME_MS = 33;
  const IDLE_MS = 90 * 1000;
  const GREY_ALPHA = 0.45;           // the not-yet-sorted part of the logo
  // start: the colour logo shrinks away 0–150 while the grey one pops in 80–300, the same motion as the check
  const INTRO_MS = 300;
  const EASE = 0.25;                 // per-frame ease toward a new %
  // In the mockup's 40-unit box.
  const CHECK = [[12, 20.5], [17.5, 26], [28, 14.5]];
  const CHECK_LEN = Math.hypot(5.5, 5.5) + Math.hypot(10.5, 11.5);
  // done: logo out 0–150, check draws 80–280 with a pop, holds, fades 1250–1450, logo back 1300–1600
  const DONE_MS = 1600;
  const OUT_MS = 260;                // stopped / failed: colour sweeps back to full

  let logo = null;                   // ImageBitmap of the 128px icon
  let grey = null;                   // the same, desaturated
  const st = {
    mode: "idle",                    // idle | fill | done | out
    tabId: null, dark: false,
    target: 0, shown: 0,             // 0..1
    who: null,                       // "@natgeo" on a profile sort, for the tooltip
    intro: false,                    // play the colour → grey intro at the start of "fill"
    modeT0: 0, outFrom: 0,
    timer: null, idleTimer: null,
  };

  const ease = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  async function loadLogo() {
    if (logo) return logo;
    const res = await fetch(chrome.runtime.getURL(DEFAULT_ICON[128]));
    logo = await createImageBitmap(await res.blob());
    const c = new OffscreenCanvas(logo.width, logo.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(logo, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = l;
    }
    ctx.putImageData(img, 0, 0);
    grey = await createImageBitmap(c);
    return logo;
  }

  function resetIcon() {
    stopFrames();
    clearTimeout(st.idleTimer);
    st.mode = "idle"; st.tabId = null; st.target = 0; st.shown = 0;
    try { chrome.action.setIcon({ path: DEFAULT_ICON }); } catch (e) {}
    setTitle(null);
  }

  // The hover tooltip (Chrome's own grey box). null = the extension's normal one.
  // Only sent when the words change; Chrome doesn't redraw a tooltip that's already showing.
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

  // One picture, in the mockup's 40-unit box, at every size Chrome asks for.
  // p = { sweep 0..1, scale, logoAlpha, leave + leaveScale (the colour logo
  //       on its way out), checkDraw, checkScale, checkAlpha }
  function paint(p) {
    if (!logo) return;
    const ink = st.dark ? "#f2f3f5" : "#37352f";
    const imageData = {};
    for (const size of SIZES) {
      const c = new OffscreenCanvas(size, size);
      const ctx = c.getContext("2d");
      ctx.scale(size / 40, size / 40);
      const s = 40 * p.scale, o = 20 - s / 2;

      if (p.leave > 0) {
        const ls = 40 * p.leaveScale, lo = 20 - ls / 2;
        ctx.globalAlpha = p.leave;
        ctx.drawImage(logo, lo, lo, ls, ls);
      }
      if (p.logoAlpha > 0) {
        if (p.sweep < 1) {
          ctx.globalAlpha = p.logoAlpha * GREY_ALPHA;
          ctx.drawImage(grey, o, o, s, s);
        }
        if (p.sweep > 0) {
          // The sorted part: full colour inside a wedge from 12 o'clock, clockwise.
          ctx.save();
          if (p.sweep < 1) {
            ctx.beginPath();
            ctx.moveTo(20, 20);
            ctx.arc(20, 20, 40, -Math.PI / 2, -Math.PI / 2 + p.sweep * Math.PI * 2);
            ctx.closePath();
            ctx.clip();
          }
          ctx.globalAlpha = p.logoAlpha;
          ctx.drawImage(logo, o, o, s, s);
          ctx.restore();
        }
      }
      if (p.checkAlpha > 0 && p.checkDraw > 0) {
        ctx.save();
        ctx.globalAlpha = p.checkAlpha;
        ctx.translate(20, 20); ctx.scale(p.checkScale, p.checkScale); ctx.translate(-20, -20);
        ctx.lineWidth = size <= 16 ? 4.2 : 3.6;
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.strokeStyle = ink;
        ctx.setLineDash([CHECK_LEN * p.checkDraw, CHECK_LEN]);
        ctx.beginPath();
        ctx.moveTo(...CHECK[0]); ctx.lineTo(...CHECK[1]); ctx.lineTo(...CHECK[2]);
        ctx.stroke();
        ctx.restore();
      }
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    try { chrome.action.setIcon({ imageData }); } catch (e) {}
  }

  const still = { scale: 1, logoAlpha: 1, leave: 0, leaveScale: 1, checkDraw: 0, checkScale: 1, checkAlpha: 0 };

  // The pop both the check and the grey logo come in with: 0.6 → 1.08 → 1 between 80 and 300ms.
  const popScale = (t) => t < 80 ? 0.6 : t < 220 ? 0.6 + 0.48 * ease((t - 80) / 140) : t < 300 ? 1.08 - 0.08 * ease((t - 220) / 80) : 1;

  // Returns true while another frame is needed.
  function frame() {
    const now = Date.now();
    const t = now - st.modeT0;

    if (st.mode === "fill") {
      const gap = st.target - st.shown;
      st.shown = Math.abs(gap) < 0.004 ? st.target : st.shown + gap * EASE;
      if (st.intro && t < INTRO_MS) {
        const k = ease(t / 150);
        paint({ ...still, sweep: st.shown, scale: popScale(t), logoAlpha: clamp01((t - 80) / 60), leave: 1 - k, leaveScale: 1 - 0.4 * k });
        return true;
      }
      paint({ ...still, sweep: st.shown });
      return st.shown !== st.target || (st.intro && t < INTRO_MS + FRAME_MS);
    }

    if (st.mode === "done") {
      // Top the colour off first if it isn't full yet (an items sort usually is).
      if (st.shown < 1) {
        st.shown = Math.min(1, st.shown + Math.max(0.06, (1 - st.shown) * EASE));
        paint({ ...still, sweep: st.shown });
        if (st.shown >= 1) st.modeT0 = now;
        return true;
      }
      const out = 1 - ease(t / 150);
      const draw = ease((t - 80) / 200);
      const pop = popScale(t);
      const checkAlpha = t < 1250 ? clamp01((t - 80) / 60) : 1 - ease((t - 1250) / 200);
      const back = ease((t - 1300) / 300);
      paint({
        sweep: 1,
        scale: back > 0 ? 0.8 + 0.2 * back : 1 - 0.2 * (1 - out),
        logoAlpha: back > 0 ? back : out,
        checkDraw: draw, checkScale: pop, checkAlpha,
      });
      if (t >= DONE_MS) { resetIcon(); return false; }
      return true;
    }

    if (st.mode === "out") {
      const k = ease(t / OUT_MS);
      paint({ ...still, sweep: st.outFrom + (1 - st.outFrom) * k });
      if (t >= OUT_MS) { resetIcon(); return false; }
      return true;
    }
    return false;
  }

  function stopFrames() { clearTimeout(st.timer); st.timer = null; }
  function runFrames() {
    if (st.timer) return;
    const tick = () => {
      st.timer = null;
      if (frame()) st.timer = setTimeout(tick, FRAME_MS);
    };
    tick();
  }

  function setMode(mode) {
    st.mode = mode;
    st.modeT0 = Date.now();
    stopFrames();
    runFrames();
  }

  function armIdle() {
    clearTimeout(st.idleTimer);
    st.idleTimer = setTimeout(() => { log("idle → reset"); resetIcon(); }, IDLE_MS);
  }

  async function onRing(msg, tabId) {
    const state = msg.state;
    if (state === "start") {
      // Straight into progress: the logo slips away, grows back grey at 0%, and colours back in with the %.
      await loadLogo();
      st.tabId = tabId; st.dark = !!msg.dark; st.who = msg.who || null;
      st.target = 0; st.shown = 0; st.intro = true;
      setMode("fill");
      setTitle(st.who ? `Getting ready to sort ${st.who}` : "Getting ready to sort");
      armIdle();
      return;
    }
    const pct = clamp01((Number(msg.pct) || 0) / 100);
    if (st.mode === "idle" && state === "progress" && pct > 0) {
      // This worker was restarted mid-sort (idle shutdown): pick the sort back up.
      await loadLogo();
      st.tabId = tabId; st.dark = !!msg.dark; st.who = msg.who || null;
      st.target = pct; st.shown = pct; st.intro = false;
      setMode("fill");
    }
    if (tabId !== st.tabId || st.mode === "idle") return;   // only the sorting tab drives it
    armIdle();
    if (state === "progress") {
      st.target = Math.max(st.target, pct);                   // never runs backwards
      if (st.mode === "fill") runFrames();
      // In 10% steps: a tooltip whose text changes every second never gets the
      // ~1s of stillness Chrome waits for before showing it.
      // "· 2 waiting" from the line (background_sort_clock.js, Phase 5).
      const waiting = Number(globalThis.__sfLineWaiting) || 0;
      setTitle(`Sorting${st.who ? " " + st.who : ""} · ${Math.floor(st.target * 10) * 10}%${waiting ? ` · ${waiting} waiting` : ""}`);
      return;
    }
    if (state === "done") { if (st.mode === "fill") setMode("done"); setTitle(null); return; }
    if (state === "stopped" || state === "failed") { if (st.mode !== "out") { st.outFrom = st.shown; setMode("out"); } setTitle(null); return; }
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== "SF_ACTION_RING") return;
    if (!SF_ACTION_RING_ON) return;
    const tabId = sender && sender.tab ? sender.tab.id : null;
    log(msg.state, msg.pct, tabId);
    onRing(msg, tabId).catch((e) => { log("ring error", e); resetIcon(); });
  });

  chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === st.tabId) resetIcon(); });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId === st.tabId && info.status === "loading" && st.mode !== "done") resetIcon();
  });

  // A fresh worker has no sort in memory: never leave an old progress frame up.
  resetIcon();
})();
