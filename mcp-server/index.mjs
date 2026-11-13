#!/usr/bin/env node
/**
 * ViralSpy v3.0 — Local Studio Hub + VideoBot Reproduce Engine + Master Database + MCP Server
 *
 * 1. Apple-Minimalist Web Dashboard (`http://127.0.0.1:8765/dashboard`)
 * 2. WebSocket Bridge (`ws://127.0.0.1:8765/ext`) with Parallel Multi-Tab Scraping
 * 3. One-Shot VideoBot Reproduce Engine (`ig_<code>.zip`: shot-cut frames, scenes.txt, transcript.txt, storyboard.jpg, video.mp4)
 * 4. Permanent Master Posts Database (`posts_db.json`) + Two-Way Synced Swipe Vault (`saved_library.json`)
 * 5. Free Local Whisper Transcription (Metal GPU) + Apple Vision Neural OCR
 * 6. Multi-Client Safe Architecture (Claude Desktop + Antigravity + Studio Web UI simultaneously)
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// Keep the local Studio Hub alive through transient socket or stream errors
process.on("uncaughtException", (err) => {
  console.error("[ViralSpy] Uncaught exception:", err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[ViralSpy] Unhandled rejection:", reason?.message || reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.VIRALSPY_PORT || "8765", 10);
const HOST = "127.0.0.1";
const DASHBOARD_DIR = path.join(__dirname, "dashboard");
const DATA_DIR = path.join(__dirname, "data");
const EXPORTS_DIR = path.join(DATA_DIR, "exports");
const HOOKS_DIR = path.join(DATA_DIR, "hooks");
const REPRODUCE_DIR = path.join(DATA_DIR, "reproduce_packs");
const THUMBS_DIR = path.join(DATA_DIR, "thumbs");

const TRANSCRIPTS_FILE = path.join(DATA_DIR, "transcripts.json");
const SAVED_LIBRARY_FILE = path.join(DATA_DIR, "saved_library.json");
const VISUAL_HOOKS_FILE = path.join(DATA_DIR, "visual_hooks.json");
const COMMENTS_CACHE_FILE = path.join(DATA_DIR, "comments_cache.json");
const SCAN_HISTORY_FILE = path.join(DATA_DIR, "scan_history.json");
const RADAR_HISTORY_FILE = path.join(DATA_DIR, "radar_history.json");
const POSTS_DB_FILE = path.join(DATA_DIR, "posts_db.json");
const REPRODUCE_DB_FILE = path.join(DATA_DIR, "reproduce_db.json");
const CATEGORIES_FILE = path.join(DATA_DIR, "categories.json");
const MY_ACCOUNTS_FILE = path.join(DATA_DIR, "my_accounts.json");
const OCR_SWIFT_SRC = path.join(__dirname, "ocr_vision.swift");
const OCR_BIN_PATH = path.join(DATA_DIR, "ocr_vision_bin");

function resolveBin(envVal, candidates, fallbackCmd) {
  if (envVal && fs.existsSync(envVal)) return envVal;
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return fallbackCmd;
}

function resolveWhisperModel() {
  if (process.env.WHISPER_MODEL && fs.existsSync(process.env.WHISPER_MODEL)) {
    return process.env.WHISPER_MODEL;
  }
  const dir = path.join(os.homedir(), ".cache/whisper-models");
  const preferred = [
    "ggml-medium.bin",
    "ggml-large-v3-turbo.bin",
    "ggml-small.bin",
    "ggml-base.bin",
    "ggml-tiny.bin",
  ];
  for (const name of preferred) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(dir, "ggml-medium.bin");
}

const FFMPEG_BIN = resolveBin(
  process.env.FFMPEG_BIN,
  ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"],
  "ffmpeg"
);
const FFPROBE_BIN = resolveBin(
  process.env.FFPROBE_BIN,
  ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"],
  "ffprobe"
);
const WHISPER_BIN = resolveBin(
  process.env.WHISPER_BIN,
  ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli", "/opt/homebrew/bin/whisper-cpp"],
  "whisper-cli"
);
const ZIP_BIN = resolveBin(process.env.ZIP_BIN, ["/usr/bin/zip", "/opt/homebrew/bin/zip"], "zip");
const SWIFTC_BIN = resolveBin(process.env.SWIFTC_BIN, ["/usr/bin/swiftc"], null);
const WHISPER_MODEL = resolveWhisperModel();

await fsp.mkdir(EXPORTS_DIR, { recursive: true });
await fsp.mkdir(HOOKS_DIR, { recursive: true });
await fsp.mkdir(REPRODUCE_DIR, { recursive: true });
await fsp.mkdir(THUMBS_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// Persistent Local JSON Stores
// ─────────────────────────────────────────────────────────────────────────────

function loadJsonSync(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (_) {}
  return fallback;
}

async function saveJson(filePath, data) {
  try {
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (_) {}
}

const transcriptCache = loadJsonSync(TRANSCRIPTS_FILE, {});
const savedLibrary = loadJsonSync(SAVED_LIBRARY_FILE, { posts: [] });
const visualHooksCache = loadJsonSync(VISUAL_HOOKS_FILE, {});
const commentsCache = loadJsonSync(COMMENTS_CACHE_FILE, {});
const scanHistory = loadJsonSync(SCAN_HISTORY_FILE, []);
const radarHistory = loadJsonSync(RADAR_HISTORY_FILE, []);
const postsDb = loadJsonSync(POSTS_DB_FILE, {}); // keyed by `${platform}:${code}`
const reproduceDb = loadJsonSync(REPRODUCE_DB_FILE, []); // array of reproduce packs

const DEFAULT_CATEGORIES = ["Health", "Pets", "Fitness", "Beauty", "Finance", "Tech & AI", "Lifestyle"];
const categoriesStore = loadJsonSync(CATEGORIES_FILE, {
  categories: [...DEFAULT_CATEGORIES],
  creatorMap: {},
  postOverrides: {},
});
if (!Array.isArray(categoriesStore.categories) || !categoriesStore.categories.length) {
  categoriesStore.categories = [...DEFAULT_CATEGORIES];
} else {
  for (const defCat of ["Health", "Pets"]) {
    if (!categoriesStore.categories.some((c) => c.toLowerCase() === defCat.toLowerCase())) {
      categoriesStore.categories.unshift(defCat);
    }
  }
}
if (!categoriesStore.creatorMap || typeof categoriesStore.creatorMap !== "object") {
  categoriesStore.creatorMap = {};
}
if (!categoriesStore.postOverrides || typeof categoriesStore.postOverrides !== "object") {
  categoriesStore.postOverrides = {};
}

function normalizeCategoryName(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const lower = s.toLowerCase();
  if (lower === "auto" || lower === "all") return lower;
  if (lower === "pet" || lower === "pets" || lower === "animaux" || lower === "chien" || lower === "chiens") return "Pets";
  if (lower === "els" || lower === "health" || lower === "sante" || lower === "santé" || lower === "wellness") return "Health";
  if (lower === "uncategorized" || lower === "other" || lower === "none") return "Uncategorized";
  const matchExisting = categoriesStore.categories.find((c) => c.toLowerCase() === lower);
  if (matchExisting) return matchExisting;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ensureCategoryExists(catName) {
  const clean = normalizeCategoryName(catName);
  if (!clean || clean === "auto" || clean === "all" || clean === "Uncategorized") return clean;
  if (!categoriesStore.categories.some((c) => c.toLowerCase() === clean.toLowerCase())) {
    categoriesStore.categories.push(clean);
  }
  return clean;
}

const PETS_HANDLE_RE = /(furever|paws|puppy|puppies|doggo|dogs?|pittie|pitbull|rescue|hound|husky|bulldog|golden|poodle|terrier|labrador|dachshund|rottweiler|doberman|kitty|kitten|cats?|k9|canine|petcare|pets?|vet|bark|woof|meow|feline|shihtzu|retriever|shepherd|chien|chat)/i;
const HEALTH_HANDLE_RE = /(health|healthy|wellness|vitality|remedy|remedies|rooted|herbal|herb|holistic|nutrition|longevity|gut|hormone|doctor|healer|healing|muscle|40plus|biohack|detox|immune|sante|remede)/i;

const PETS_TEXT_RE = /\b(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets|vet|veterinary|veterinarian|canine|k9|furever|paws|bark|leash|kibble|collar|breed|senior dogs?|dog health|dog tips|dog treats|feline|chien|chiens|chiot|chat|chats|animaux)\b/i;
const HEALTH_TEXT_RE = /\b(health|healthy|wellness|remedy|remedies|herbal|supplement|supplements|vitamin|vitamins|cortisol|gut|hormone|hormones|sleep|longevity|inflammation|bloating|fasting|parasite|detox|thyroid|liver|blood sugar|immune|holistic|natural cure|santé|remède|sommeil|digestion)\b/i;
const FITNESS_TEXT_RE = /\b(gym|workout|fitness|muscle|cardio|hypertrophy|calisthenics|pilates|marathon|musculation)\b/i;
const BEAUTY_TEXT_RE = /\b(skincare|makeup|haircare|retinol|glow|cosmetic|beauté)\b/i;
const FINANCE_TEXT_RE = /\b(crypto|bitcoin|stocks|investing|trading|dividend|real estate|finance|immobilier)\b/i;
const TECH_TEXT_RE = /\b(chatgpt|claude|openai|coding|saas|software|ai tools|automation)\b/i;

function inferCategory(item = {}) {
  const plat = String(item.platform || "instagram").toLowerCase();
  const code = String(item.code || item.shortcode || "").trim();
  const uname = String(item.username || item.userName || "").replace(/^@/, "").trim().toLowerCase();

  if (code) {
    const postKey = `${plat}:${code}`;
    if (categoriesStore.postOverrides[postKey]) return categoriesStore.postOverrides[postKey];
    if (categoriesStore.postOverrides[code]) return categoriesStore.postOverrides[code];
  }

  if (uname) {
    const creatorKey = `${plat}:${uname}`;
    if (categoriesStore.creatorMap[creatorKey]) return categoriesStore.creatorMap[creatorKey];
    if (categoriesStore.creatorMap[uname]) return categoriesStore.creatorMap[uname];
  }

  if (item.category && item.category !== "Uncategorized" && item.category !== "auto") {
    return normalizeCategoryName(item.category);
  }

  // Check creator username first (Pets checked BEFORE Health so @furever_healthy -> Pets, @rooted.health.tips -> Health)
  if (uname) {
    if (PETS_HANDLE_RE.test(uname)) {
      categoriesStore.creatorMap[`${plat}:${uname}`] = "Pets";
      return "Pets";
    }
    if (HEALTH_HANDLE_RE.test(uname)) {
      categoriesStore.creatorMap[`${plat}:${uname}`] = "Health";
      return "Health";
    }
  }

  const corpus = [
    uname,
    item.caption || "",
    item.transcript || "",
    item.spokenHook || "",
    item.onScreenHook || "",
    code && transcriptCache[code]?.transcription ? transcriptCache[code].transcription : "",
  ]
    .join(" ")
    .trim();

  if (PETS_TEXT_RE.test(corpus)) return "Pets";
  if (HEALTH_TEXT_RE.test(corpus)) return "Health";
  if (FITNESS_TEXT_RE.test(corpus)) return "Fitness";
  if (BEAUTY_TEXT_RE.test(corpus)) return "Beauty";
  if (FINANCE_TEXT_RE.test(corpus)) return "Finance";
  if (TECH_TEXT_RE.test(corpus)) return "Tech & AI";

  return "Uncategorized";
}

const liveRadarStatus = {
  running: false,
  step: "",
  completed: 0,
  total: 0,
  currentAccount: "",
  accounts: {},
  startedAt: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Universal URL & Handle Parsers + Save / DB Normalization
// ─────────────────────────────────────────────────────────────────────────────

const IG_RESERVED_PATHS = new Set([
  "reels",
  "reel",
  "p",
  "tv",
  "explore",
  "stories",
  "direct",
  "accounts",
  "saved",
]);

function parseCreatorTarget(rawInput, defaultPlatform = "instagram") {
  let s = String(rawInput || "").trim();
  if (!s) return null;

  // Full URL parsing
  if (/^https?:\/\//i.test(s) || /^(?:www\.)?(?:instagram|tiktok|youtube)\.com\//i.test(s)) {
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    try {
      const u = new URL(s);
      const host = u.hostname.toLowerCase();
      const segs = u.pathname.split("/").filter(Boolean);

      if (host.includes("instagram.com")) {
        if (!segs.length) return null;
        const first = segs[0].replace(/^@/, "");
        if (IG_RESERVED_PATHS.has(first.toLowerCase())) return null;
        const surface = segs[1]?.toLowerCase() === "posts" ? "posts" : "reels";
        return { platform: "instagram", username: first.toLowerCase(), surface };
      }

      if (host.includes("tiktok.com")) {
        const handleSeg = segs.find((x) => x.startsWith("@")) || segs[0] || "";
        const handle = handleSeg.replace(/^@/, "").trim();
        if (!handle) return null;
        return { platform: "tiktok", username: handle, surface: "videos" };
      }

      if (host.includes("youtube.com")) {
        const handleSeg = segs.find((x) => x.startsWith("@")) || (segs[0] === "c" || segs[0] === "channel" ? segs[1] : segs[0]) || "";
        const handle = handleSeg.replace(/^@/, "").trim();
        if (!handle) return null;
        const surface = segs.some((x) => x.toLowerCase() === "videos") ? "videos" : "shorts";
        return { platform: "youtube", username: handle, surface };
      }
    } catch (_) {}
  }

  // Bare @handle
  const clean = s.replace(/^@/, "").split(/[/?#]/)[0].trim();
  if (!clean) return null;
  const plat = String(defaultPlatform || "instagram").toLowerCase();
  return {
    platform: plat,
    username: plat === "instagram" ? clean.toLowerCase() : clean,
    surface: plat === "youtube" ? "shorts" : plat === "tiktok" ? "videos" : "reels",
  };
}

function parseCreatorList(inputs, defaultPlatform = "instagram") {
  const rawTokens = Array.isArray(inputs)
    ? inputs.flatMap((x) => String(x || "").split(/[\s,\n\r;]+/))
    : String(inputs || "").split(/[\s,\n\r;]+/);

  const seen = new Set();
  const out = [];
  for (const tok of rawTokens) {
    const parsed = parseCreatorTarget(tok, defaultPlatform);
    if (!parsed || !parsed.username) continue;
    const key = `${parsed.platform}:${parsed.username.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

function extractShortcode(input) {
  const s = String(input || "").trim();
  const igMatch = s.match(/instagram\.com\/(?:[^/?#]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (igMatch) return igMatch[1];
  const fbMatch =
    s.match(/facebook\.com\/reel\/(\d+)/i) ||
    s.match(/facebook\.com\/(?:[^/?#]+\/)?videos\/(\d+)/i) ||
    s.match(/facebook\.com\/share\/[rv]\/([A-Za-z0-9_-]+)/i) ||
    s.match(/fb\.watch\/([A-Za-z0-9_-]+)/i);
  if (fbMatch) return fbMatch[1];
  const ttMatch = s.match(/tiktok\.com\/@[^/?#]+\/(?:video|photo)\/(\d+)/i);
  if (ttMatch) return ttMatch[1];
  const ytMatch = s.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{8,15})/i) || s.match(/[?&]v=([A-Za-z0-9_-]{8,15})/i);
  if (ytMatch) return ytMatch[1];
  if (/^[A-Za-z0-9_-]{6,25}$/.test(s) && !/^https?:/i.test(s)) return s;
  return null;
}

function parseVideoTarget(input, fallbackPlatform = "instagram") {
  const s = String(input || "").trim();
  if (!s) return null;

  const igMatch = s.match(/instagram\.com\/(?:([^/?#]+)\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (igMatch) {
    const maybeUser = igMatch[1] && !IG_RESERVED_PATHS.has(igMatch[1].toLowerCase()) ? igMatch[1] : "";
    const shortcode = igMatch[2];
    return {
      platform: "instagram",
      shortcode,
      username: maybeUser,
      url: `https://www.instagram.com/reel/${shortcode}/`,
    };
  }

  const fbReelMatch =
    s.match(/facebook\.com\/reel\/(\d+)/i) ||
    s.match(/facebook\.com\/(?:([^/?#]+)\/)?videos\/(\d+)/i);
  if (fbReelMatch) {
    const shortcode = fbReelMatch[2] || fbReelMatch[1];
    const maybeUser = fbReelMatch[2] && fbReelMatch[1] ? fbReelMatch[1] : "";
    return {
      platform: "facebook",
      shortcode,
      username: maybeUser,
      url: `https://www.facebook.com/reel/${shortcode}/`,
    };
  }

  const fbShareMatch =
    s.match(/facebook\.com\/share\/[rv]\/([A-Za-z0-9_-]+)/i) ||
    s.match(/fb\.watch\/([A-Za-z0-9_-]+)/i);
  if (fbShareMatch) {
    return {
      platform: "facebook",
      shortcode: fbShareMatch[1],
      username: "",
      url: /^https?:/i.test(s) ? s : `https://${s}`,
    };
  }

  const ttMatch = s.match(/tiktok\.com\/@([^/?#]+)\/(?:video|photo)\/(\d+)/i);
  if (ttMatch) {
    return {
      platform: "tiktok",
      username: ttMatch[1],
      shortcode: ttMatch[2],
      url: `https://www.tiktok.com/@${ttMatch[1]}/video/${ttMatch[2]}`,
    };
  }

  const ytMatch = s.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{8,15})/i);
  if (ytMatch) {
    return {
      platform: "youtube",
      username: "",
      shortcode: ytMatch[1],
      url: `https://www.youtube.com/shorts/${ytMatch[1]}`,
    };
  }

  const code = extractShortcode(s);
  if (code) {
    const plat =
      fallbackPlatform === "facebook"
        ? "facebook"
        : /^\d{18,22}$/.test(code)
        ? "tiktok"
        : fallbackPlatform;
    return {
      platform: plat,
      shortcode: code,
      username: "",
      url:
        plat === "facebook"
          ? `https://www.facebook.com/reel/${code}/`
          : plat === "instagram"
          ? `https://www.instagram.com/reel/${code}/`
          : s,
    };
  }
  return null;
}

function normalizeSavedPost(raw, fallbackPlatform = "instagram") {
  if (!raw || typeof raw !== "object") return null;
  const code = String(raw.code || raw.shortcode || raw.reel_code || raw.VideoID || raw.id || "").trim();
  if (!code) return null;

  const platform = String(
    raw.platform ||
      (raw.url && /tiktok\.com/i.test(raw.url)
        ? "tiktok"
        : raw.url && /facebook\.com|fb\.watch/i.test(raw.url)
        ? "facebook"
        : raw.VideoID
        ? "facebook"
        : fallbackPlatform)
  ).toLowerCase();

  const username = String(
    raw.username ||
      raw.userName ||
      raw.Profile ||
      raw.creator?.handle ||
      raw.creator?.username ||
      raw.profile ||
      ""
  )
    .replace(/^@/, "")
    .trim();

  let createDate = raw.createDate || raw.Date || "";
  if (!createDate && raw.posted_at) {
    const ms = Number(raw.posted_at) > 1e11 ? Number(raw.posted_at) : Number(raw.posted_at) * 1000;
    if (Number.isFinite(ms) && ms > 0) createDate = new Date(ms).toISOString();
  }

  const views = raw.views ?? raw.viewCount ?? raw.Views ?? raw.metrics?.views ?? null;
  const likes = raw.likes ?? raw.likesCount ?? raw.Likes ?? raw.metrics?.likes ?? null;
  const comments = raw.comments ?? raw.commentsCount ?? raw.Comments ?? raw.metrics?.comments ?? null;
  const shares = raw.shares ?? raw.sharesCount ?? raw.Shares ?? raw.metrics?.shares ?? null;
  const outlierScore =
    typeof raw.outlierScore === "number"
      ? raw.outlierScore
      : typeof raw.OutlierScore === "number"
      ? raw.OutlierScore
      : typeof raw.outlier === "number"
      ? raw.outlier
      : null;

  const thumbnailUrl =
    raw.thumbnailUrl ||
    raw.thumbnailSmallUrl ||
    raw.Thumb ||
    raw.media?.cover_url ||
    raw.cover_url ||
    null;

  const videoUrl =
    raw.videoUrl ||
    raw.media?.video_url ||
    raw.video_url ||
    null;

  const url =
    raw.url ||
    (platform === "tiktok"
      ? `https://www.tiktok.com/@${username || "_"}/video/${code}`
      : platform === "facebook"
      ? `https://www.facebook.com/reel/${code}/`
      : `https://www.instagram.com/reel/${code}/`);

  const createdMs = createDate ? Date.parse(createDate) : NaN;
  const ageHours =
    raw.ageHours ??
    (Number.isFinite(createdMs) ? Number(Math.max(0.5, (Date.now() - createdMs) / 3600000).toFixed(2)) : null);
  const viewsPerHour =
    raw.viewsPerHour ??
    (ageHours != null && (views ?? likes) != null ? Number((+(views ?? likes) / ageHours).toFixed(2)) : null);

  const itemObj = {
    platform,
    code,
    shortcode: code,
    kind: raw.kind || "reel",
    url,
    username,
    creatorName: raw.creator?.name || "",
    caption: String(raw.caption || raw.Caption || "").trim(),
    createDate,
    ageHours,
    views: views != null ? Number(views) : null,
    likes: likes != null ? Number(likes) : null,
    comments: comments != null ? Number(comments) : null,
    shares: shares != null ? Number(shares) : null,
    outlierScore: outlierScore != null ? Number(Number(outlierScore).toFixed(2)) : null,
    velocityScore: raw.velocityScore != null ? Number(raw.velocityScore) : null,
    viewsPerHour,
    creatorBaseline: raw.creatorBaseline ?? null,
    videoDuration: raw.videoDuration ?? raw.duration ?? null,
    thumbnailUrl,
    videoUrl,
    audioUrl: raw.audioUrl || videoUrl || null,
    savedAt: raw.savedAt || new Date().toISOString(),
  };
  itemObj.category = inferCategory({ ...itemObj, category: raw.category });
  return itemObj;
}

function isCodeSaved(code) {
  if (!code) return false;
  return savedLibrary.posts.some((p) => p.code === code || p.shortcode === code);
}

function findPackForCode(code) {
  if (!code) return null;
  return reproduceDb.find((p) => p.shortcode === code) || null;
}

// Migrate any legacy un-normalized saved entries in memory right away
savedLibrary.posts = (savedLibrary.posts || [])
  .map((p) => normalizeSavedPost(p, p?.platform || "instagram"))
  .filter(Boolean);

// Permanent Master Posts Database Upsert
async function upsertPostsToDb(items, context = {}) {
  if (!Array.isArray(items) || !items.length) return 0;
  const nowIso = new Date().toISOString();
  let count = 0;

  if (context.category && context.category !== "auto" && context.username) {
    const cleanCat = ensureCategoryExists(context.category);
    const plat = String(context.platform || "instagram").toLowerCase();
    const uname = String(context.username).replace(/^@/, "").trim().toLowerCase();
    if (cleanCat && uname) {
      categoriesStore.creatorMap[`${plat}:${uname}`] = cleanCat;
    }
  }

  for (const raw of items) {
    const norm = normalizeSavedPost(raw, context.platform || raw?.platform || "instagram");
    if (!norm || !norm.code) continue;
    const key = `${norm.platform}:${norm.code}`;
    const prev = postsDb[key] || {};

    const baseline = norm.creatorBaseline ?? context.creatorBaseline ?? prev.creatorBaseline ?? null;
    let velocityScore = norm.velocityScore ?? prev.velocityScore ?? null;
    if (velocityScore == null && baseline && baseline > 0 && norm.viewsPerHour != null) {
      velocityScore = Number(((norm.viewsPerHour * 24) / baseline).toFixed(2));
    }

    const mergedUsername = norm.username || context.username || prev.username || "";
    const mergedCaption = norm.caption || prev.caption || "";
    const resolvedCategory = inferCategory({
      platform: norm.platform,
      code: norm.code,
      username: mergedUsername,
      caption: mergedCaption,
      category:
        context.category && context.category !== "auto"
          ? context.category
          : norm.category && norm.category !== "Uncategorized"
          ? norm.category
          : prev.category,
    });

    postsDb[key] = {
      key,
      platform: norm.platform,
      code: norm.code,
      shortcode: norm.code,
      url: norm.url || prev.url || "",
      username: mergedUsername,
      category: resolvedCategory,
      caption: mergedCaption,
      createDate: norm.createDate || prev.createDate || "",
      ageHours: norm.ageHours ?? prev.ageHours ?? null,
      views: norm.views ?? prev.views ?? null,
      likes: norm.likes ?? prev.likes ?? null,
      comments: norm.comments ?? prev.comments ?? null,
      shares: norm.shares ?? prev.shares ?? null,
      outlierScore: norm.outlierScore ?? prev.outlierScore ?? null,
      velocityScore,
      viewsPerHour: norm.viewsPerHour ?? prev.viewsPerHour ?? null,
      creatorBaseline: baseline,
      videoDuration: norm.videoDuration ?? prev.videoDuration ?? null,
      thumbnailUrl: norm.thumbnailUrl || prev.thumbnailUrl || null,
      videoUrl: norm.videoUrl || prev.videoUrl || null,
      audioUrl: norm.audioUrl || prev.audioUrl || null,
      source: context.source || prev.source || "scan",
      firstScrapedAt: prev.firstScrapedAt || nowIso,
      lastScrapedAt: nowIso,
    };
    count += 1;
  }

  if (count > 0 && isPrimaryHub) {
    await saveJson(POSTS_DB_FILE, postsDb);
    await saveJson(CATEGORIES_FILE, categoriesStore);
  }
  return count;
}

// Bootstrap Master Posts DB + sync captions & categories across all stores on startup
function bootstrapPostsDbFromHistorySync() {
  let dbDirty = false;
  let reproduceDirty = false;
  let scansDirty = false;

  for (const scan of scanHistory) {
    for (const p of scan?.posts || []) {
      const norm = normalizeSavedPost(p, scan.platform || "instagram");
      if (!norm) continue;
      const key = `${norm.platform}:${norm.code}`;
      if (!postsDb[key]) {
        postsDb[key] = {
          ...norm,
          key,
          creatorBaseline: scan.outlierBaseline?.baseline ?? null,
          source: "scan_history",
          firstScrapedAt: scan.scannedAt || new Date().toISOString(),
          lastScrapedAt: scan.scannedAt || new Date().toISOString(),
        };
        dbDirty = true;
      }
    }
  }
  for (const run of radarHistory) {
    for (const p of run?.leaderboard || []) {
      const norm = normalizeSavedPost(p, "instagram");
      if (!norm) continue;
      const key = `${norm.platform}:${norm.code}`;
      if (!postsDb[key]) {
        postsDb[key] = {
          ...norm,
          key,
          source: "niche_radar",
          firstScrapedAt: run.createdAt || new Date().toISOString(),
          lastScrapedAt: run.createdAt || new Date().toISOString(),
        };
        dbDirty = true;
      }
    }
  }
  for (const p of savedLibrary.posts) {
    const key = `${p.platform}:${p.code}`;
    if (!postsDb[key]) {
      postsDb[key] = {
        ...p,
        key,
        source: "saved_vault",
        firstScrapedAt: p.savedAt || new Date().toISOString(),
        lastScrapedAt: p.savedAt || new Date().toISOString(),
      };
      dbDirty = true;
    }
  }

  // Sync captions & categories from Reproduce Packs into postsDb and write caption.txt if missing
  for (const pack of reproduceDb) {
    const cat = inferCategory(pack);
    if (pack.category !== cat) {
      pack.category = cat;
      reproduceDirty = true;
    }
    if (pack.folderPath && pack.caption) {
      const capTxtFile = path.join(pack.folderPath, "caption.txt");
      try {
        if (fs.existsSync(pack.folderPath) && !fs.existsSync(capTxtFile)) {
          fs.writeFileSync(capTxtFile, String(pack.caption) + "\n", "utf8");
        }
      } catch (_) {}
    }
    const key = `${pack.platform || "instagram"}:${pack.shortcode}`;
    if (postsDb[key]) {
      if (pack.caption && !postsDb[key].caption) {
        postsDb[key].caption = pack.caption;
        dbDirty = true;
      }
      if (pack.username && !postsDb[key].username) {
        postsDb[key].username = pack.username;
        dbDirty = true;
      }
    }
  }

  // Ensure every post in postsDb has a resolved category
  for (const entry of Object.values(postsDb)) {
    const cat = inferCategory(entry);
    if (entry.category !== cat) {
      entry.category = cat;
      dbDirty = true;
    }
  }

  // Sync enriched captions & categories back into scanHistory and radarHistory
  for (const scan of scanHistory) {
    const plat = scan.platform || "instagram";
    scan.category = inferCategory({ platform: plat, username: scan.username });
    for (const p of scan?.posts || []) {
      const code = p.shortcode || p.code;
      const dbHit = code ? postsDb[`${plat}:${code}`] : null;
      if (dbHit?.caption && !p.caption) {
        p.caption = dbHit.caption;
        scansDirty = true;
      }
      const pCat = dbHit?.category || inferCategory({ ...p, platform: plat, username: p.username || scan.username });
      if (p.category !== pCat) {
        p.category = pCat;
        scansDirty = true;
      }
    }
  }

  for (const run of radarHistory) {
    for (const p of run?.leaderboard || []) {
      const plat = p.platform || "instagram";
      const code = p.shortcode || p.code;
      const dbHit = code ? postsDb[`${plat}:${code}`] : null;
      if (dbHit?.caption && !p.caption) {
        p.caption = dbHit.caption;
      }
      p.category = dbHit?.category || inferCategory(p);
    }
  }

  try {
    fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(categoriesStore, null, 2), "utf8");
    if (dbDirty) fs.writeFileSync(POSTS_DB_FILE, JSON.stringify(postsDb, null, 2), "utf8");
    if (reproduceDirty) fs.writeFileSync(REPRODUCE_DB_FILE, JSON.stringify(reproduceDb, null, 2), "utf8");
    if (scansDirty) fs.writeFileSync(SCAN_HISTORY_FILE, JSON.stringify(scanHistory, null, 2), "utf8");
  } catch (_) {}
}
bootstrapPostsDbFromHistorySync();

function getCategoriesSummary() {
  const dbCounts = { all: Object.keys(postsDb).length };
  const videoDbCounts = { all: reproduceDb.length };

  for (const cat of categoriesStore.categories) {
    dbCounts[cat] = 0;
    videoDbCounts[cat] = 0;
  }
  dbCounts.Uncategorized = 0;
  videoDbCounts.Uncategorized = 0;

  for (const p of Object.values(postsDb)) {
    const cat = p.category || inferCategory(p) || "Uncategorized";
    dbCounts[cat] = (dbCounts[cat] || 0) + 1;
  }

  for (const pack of reproduceDb) {
    const cat = pack.category || inferCategory(pack) || "Uncategorized";
    videoDbCounts[cat] = (videoDbCounts[cat] || 0) + 1;
  }

  return {
    categories: categoriesStore.categories,
    creatorMap: categoriesStore.creatorMap,
    dbCounts,
    videoDbCounts,
  };
}

async function propagatePostEnrichment(platform, code, patch = {}) {
  const plat = String(platform || "instagram").toLowerCase();
  const cleanCode = String(code || "").trim();
  if (!cleanCode) return null;
  const key = `${plat}:${cleanCode}`;

  const existing = postsDb[key] || {
    key,
    platform: plat,
    code: cleanCode,
    shortcode: cleanCode,
    url: plat === "instagram" ? `https://www.instagram.com/reel/${cleanCode}/` : "",
    firstScrapedAt: new Date().toISOString(),
  };

  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && v !== null && v !== "") {
      existing[k] = v;
    }
  }
  existing.category = patch.category ? ensureCategoryExists(patch.category) : inferCategory(existing);
  existing.lastScrapedAt = new Date().toISOString();
  postsDb[key] = existing;

  // Propagate into scanHistory
  let scansChanged = false;
  for (const scan of scanHistory) {
    for (const p of scan?.posts || []) {
      if ((p.shortcode || p.code) === cleanCode) {
        if (existing.caption) p.caption = existing.caption;
        if (existing.username && !p.username) p.username = existing.username;
        if (existing.videoUrl) p.videoUrl = existing.videoUrl;
        if (existing.thumbnailUrl && !p.thumbnailUrl) p.thumbnailUrl = existing.thumbnailUrl;
        if (existing.views != null && p.views == null) p.views = existing.views;
        if (existing.likes != null && p.likes == null) p.likes = existing.likes;
        if (existing.comments != null && p.comments == null) p.comments = existing.comments;
        p.category = existing.category;
        scansChanged = true;
      }
    }
  }

  // Propagate into radarHistory
  let radarChanged = false;
  for (const run of radarHistory) {
    for (const p of run?.leaderboard || []) {
      if ((p.shortcode || p.code) === cleanCode) {
        if (existing.caption) p.caption = existing.caption;
        if (existing.username && !p.username) p.username = existing.username;
        if (existing.videoUrl) p.videoUrl = existing.videoUrl;
        p.category = existing.category;
        radarChanged = true;
      }
    }
  }

  // Propagate into savedLibrary
  let savedChanged = false;
  for (const p of savedLibrary.posts) {
    if ((p.shortcode || p.code) === cleanCode) {
      if (existing.caption) p.caption = existing.caption;
      if (existing.username && !p.username) p.username = existing.username;
      if (existing.videoUrl) p.videoUrl = existing.videoUrl;
      if (existing.thumbnailUrl && !p.thumbnailUrl) p.thumbnailUrl = existing.thumbnailUrl;
      if (existing.views != null && p.views == null) p.views = existing.views;
      if (existing.likes != null && p.likes == null) p.likes = existing.likes;
      if (existing.comments != null && p.comments == null) p.comments = existing.comments;
      p.category = existing.category;
      savedChanged = true;
    }
  }

  // Propagate into reproduceDb
  let packChanged = false;
  for (const pack of reproduceDb) {
    if (pack.shortcode === cleanCode) {
      if (existing.caption && !pack.caption) pack.caption = existing.caption;
      if (existing.username && !pack.username) pack.username = existing.username;
      pack.category = existing.category;
      packChanged = true;
      if (pack.folderPath && fs.existsSync(pack.folderPath)) {
        if (pack.caption) {
          await fsp.writeFile(path.join(pack.folderPath, "caption.txt"), String(pack.caption) + "\n", "utf8").catch(() => {});
        }
        await fsp.writeFile(path.join(pack.folderPath, "metadata.json"), JSON.stringify(pack, null, 2), "utf8").catch(() => {});
      }
    }
  }

  if (isPrimaryHub) {
    await saveJson(POSTS_DB_FILE, postsDb);
    await saveJson(CATEGORIES_FILE, categoriesStore);
    if (scansChanged) await saveJson(SCAN_HISTORY_FILE, scanHistory);
    if (radarChanged) await saveJson(RADAR_HISTORY_FILE, radarHistory);
    if (savedChanged) await saveJson(SAVED_LIBRARY_FILE, savedLibrary);
    if (packChanged) await saveJson(REPRODUCE_DB_FILE, reproduceDb);
  }

  return existing;
}

async function assignCategoryAndPropagate({
  category,
  platform = "instagram",
  username = "",
  shortcode = "",
  applyToCreator = true,
}) {
  const cleanCat = ensureCategoryExists(category);
  if (!cleanCat) return { ok: false, message: "Invalid category name" };

  const plat = String(platform || "instagram").toLowerCase();
  const cleanUser = String(username || "").replace(/^@/, "").trim().toLowerCase();
  const cleanCode = String(shortcode || "").trim();

  if (cleanCode) {
    categoriesStore.postOverrides[`${plat}:${cleanCode}`] = cleanCat;
  }
  if (applyToCreator && cleanUser) {
    categoriesStore.creatorMap[`${plat}:${cleanUser}`] = cleanCat;
    // Clear individual post overrides for this creator unless it's the target post
    for (const k of Object.keys(categoriesStore.postOverrides)) {
      const dbEntry = postsDb[k];
      if (dbEntry && (dbEntry.username || "").toLowerCase() === cleanUser && dbEntry.code !== cleanCode) {
        delete categoriesStore.postOverrides[k];
      }
    }
  }

  let updatedPosts = 0;
  for (const entry of Object.values(postsDb)) {
    const matchesPost = cleanCode && entry.code === cleanCode && entry.platform === plat;
    const matchesCreator = applyToCreator && cleanUser && (entry.username || "").toLowerCase() === cleanUser;
    if (matchesPost || matchesCreator) {
      entry.category = cleanCat;
      updatedPosts += 1;
    }
  }

  for (const pack of reproduceDb) {
    const matchesPost = cleanCode && pack.shortcode === cleanCode;
    const matchesCreator = applyToCreator && cleanUser && (pack.username || "").toLowerCase() === cleanUser;
    if (matchesPost || matchesCreator) {
      pack.category = cleanCat;
      if (pack.folderPath && fs.existsSync(pack.folderPath)) {
        await fsp.writeFile(path.join(pack.folderPath, "metadata.json"), JSON.stringify(pack, null, 2), "utf8").catch(() => {});
      }
    }
  }

  for (const scan of scanHistory) {
    if (applyToCreator && cleanUser && (scan.username || "").toLowerCase() === cleanUser) {
      scan.category = cleanCat;
    }
    for (const p of scan?.posts || []) {
      const pCode = p.shortcode || p.code;
      if ((cleanCode && pCode === cleanCode) || (applyToCreator && cleanUser && ((p.username || scan.username || "").toLowerCase() === cleanUser))) {
        p.category = cleanCat;
      }
    }
  }

  for (const run of radarHistory) {
    for (const p of run?.leaderboard || []) {
      const pCode = p.shortcode || p.code;
      if ((cleanCode && pCode === cleanCode) || (applyToCreator && cleanUser && (p.username || "").toLowerCase() === cleanUser)) {
        p.category = cleanCat;
      }
    }
  }

  for (const p of savedLibrary.posts) {
    const pCode = p.shortcode || p.code;
    if ((cleanCode && pCode === cleanCode) || (applyToCreator && cleanUser && (p.username || "").toLowerCase() === cleanUser)) {
      p.category = cleanCat;
    }
  }

  if (isPrimaryHub) {
    await Promise.all([
      saveJson(CATEGORIES_FILE, categoriesStore),
      saveJson(POSTS_DB_FILE, postsDb),
      saveJson(REPRODUCE_DB_FILE, reproduceDb),
      saveJson(SCAN_HISTORY_FILE, scanHistory),
      saveJson(RADAR_HISTORY_FILE, radarHistory),
      saveJson(SAVED_LIBRARY_FILE, savedLibrary),
    ]);
  }

  return {
    ok: true,
    category: cleanCat,
    updatedPosts,
    ...getCategoriesSummary(),
  };
}

function queryMasterPostsDb({
  search = "",
  username = "",
  platform = "all",
  category = "all",
  minOutlier = 0,
  savedOnly = false,
  reproducedOnly = false,
  sortBy = "outlier",
  limit = 250,
} = {}) {
  const q = String(search || "").trim().toLowerCase();
  const uFilter = String(username || "").replace(/^@/, "").trim().toLowerCase();
  const catFilter = String(category || "all").trim();
  const minOut = Number(minOutlier || 0);

  let list = Object.values(postsDb).map((entry) => {
    const pack = findPackForCode(entry.code);
    const localThumb = pack ? `/api/reproduce/asset/${pack.packId}/thumbnail.jpg` : null;
    const resolvedCat = entry.category || inferCategory(entry);
    return {
      ...entry,
      category: resolvedCat,
      caption: entry.caption || pack?.caption || "",
      thumbnailUrl: localThumb || entry.thumbnailUrl,
      isSaved: isCodeSaved(entry.code),
      hasCachedTranscript: !!transcriptCache[entry.code],
      hasCachedVisualHook: !!visualHooksCache[entry.code],
      reproducePackId: pack ? pack.packId : null,
      reproduceZipUrl: pack ? pack.zipUrl : null,
    };
  });

  if (platform && platform !== "all") {
    list = list.filter((p) => p.platform === platform);
  }
  if (catFilter && catFilter.toLowerCase() !== "all") {
    const normCat = normalizeCategoryName(catFilter);
    list = list.filter((p) => (p.category || "Uncategorized").toLowerCase() === normCat.toLowerCase());
  }
  if (uFilter) {
    list = list.filter((p) => (p.username || "").toLowerCase().includes(uFilter));
  }
  if (minOut > 0) {
    list = list.filter((p) => (p.outlierScore || 0) >= minOut);
  }
  if (savedOnly) {
    list = list.filter((p) => p.isSaved);
  }
  if (reproducedOnly) {
    list = list.filter((p) => !!p.reproducePackId);
  }
  if (q) {
    list = list.filter(
      (p) =>
        (p.username || "").toLowerCase().includes(q) ||
        (p.caption || "").toLowerCase().includes(q) ||
        (p.category || "").toLowerCase().includes(q) ||
        (p.code || "").toLowerCase().includes(q) ||
        String(transcriptCache[p.code]?.transcription || "").toLowerCase().includes(q)
    );
  }

  list.sort((a, b) => {
    if (sortBy === "recent") {
      return String(b.lastScrapedAt || "").localeCompare(String(a.lastScrapedAt || ""));
    }
    if (sortBy === "velocity") {
      return ((b.velocityScore ?? b.viewsPerHour) || 0) - ((a.velocityScore ?? a.viewsPerHour) || 0);
    }
    if (sortBy === "views") return (b.views || 0) - (a.views || 0);
    if (sortBy === "likes") return (b.likes || 0) - (a.likes || 0);
    if (sortBy === "comments") return (b.comments || 0) - (a.comments || 0);
    return ((b.outlierScore ?? b.views) || 0) - ((a.outlierScore ?? a.views) || 0);
  });

  const creators = Array.from(
    new Set(
      Object.values(postsDb)
        .map((p) => p.username)
        .filter(Boolean)
    )
  ).sort();

  const catSummary = getCategoriesSummary();

  return {
    totalInDb: Object.keys(postsDb).length,
    filteredCount: list.length,
    creators,
    categories: catSummary.categories,
    categoryCounts: catSummary.dbCounts,
    posts: list.slice(0, Math.max(1, Math.min(20000, Number(limit) || 10000))),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Media & Whisper Helpers
// ─────────────────────────────────────────────────────────────────────────────

function enrichTranscriptMetrics(record) {
  if (!record || !record.transcription) return record;
  const words = String(record.transcription).trim().split(/\s+/).filter(Boolean);
  const hookWords = String(record.hook || "").trim().split(/\s+/).filter(Boolean);
  const dur = Number(record.duration_seconds || 0);
  return {
    ...record,
    wordCount: words.length,
    hookWordCount: hookWords.length,
    wordsPerMinute: dur > 2 ? Math.round((words.length / dur) * 60) : null,
  };
}

function extractHookFromSegments(segments, hookSeconds = 5.0) {
  if (!Array.isArray(segments) || !segments.length) return "";
  const hookSegs = segments.filter((s) => typeof s.start === "number" && s.start < hookSeconds);
  const chosen = hookSegs.length ? hookSegs : segments.slice(0, 2);
  return chosen
    .map((s) => String(s.text || "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

async function downloadMediaToFile(url, destPath) {
  const referer = url.includes("tiktok")
    ? "https://www.tiktok.com/"
    : url.includes("facebook")
    ? "https://www.facebook.com/"
    : "https://www.instagram.com/";
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "*/*",
      Referer: referer,
    },
  });
  if (!res.ok) {
    throw new Error(`Media download failed with HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  await fsp.writeFile(destPath, Buffer.from(arrayBuffer));
}

// Direct 2026 Facebook Comet Reel Resolver (HTML <script type="application/json"> + yt-dlp fallback)
async function resolveFacebookReelDirect(shortcodeOrUrl) {
  const raw = String(shortcodeOrUrl || "").trim();
  if (!raw) return { ok: false, message: "Missing Facebook Reel ID or URL." };

  const parsed = parseVideoTarget(raw, "facebook");
  let code = parsed?.shortcode || (/^\d+$/.test(raw) ? raw : "");
  const targetUrl =
    /^https?:\/\//i.test(raw)
      ? raw
      : parsed?.url || (code ? `https://www.facebook.com/reel/${code}/` : "");

  if (!targetUrl) return { ok: false, message: "Invalid Facebook Reel target." };

  let videoUrl = null;
  let audioUrl = null;
  let thumbnailUrl = null;
  let username = "";
  let caption = "";
  let likes = null;
  let comments = null;
  let views = null;
  let durationSec = null;

  try {
    const resp = await fetch(targetUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
    });
    if (resp.url) {
      const mFinal = resp.url.match(/\/reel\/(\d+)/i) || resp.url.match(/\/videos\/(\d+)/i);
      if (mFinal) code = mFinal[1];
    }
    if (resp.ok) {
      const html = await resp.text();
      const scriptRe = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
      let match;
      while ((match = scriptRe.exec(html)) !== null) {
        const txt = match[1] || "";
        if (
          !/(browser_native_|playable_url|progressive_url|hd_src|sd_src|dash_manifest|short_form_video_context|creation_story)/.test(
            txt
          )
        ) {
          continue;
        }
        let parsedJson;
        try {
          parsedJson = JSON.parse(txt);
        } catch (_) {
          continue;
        }

        const walk = (node) => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
          }

          const nodeId = String(node.id || node.video_id || "");
          const matchesTarget = !code || !nodeId || nodeId === code;

          // Video & audio delivery fields
          const hd =
            node.browser_native_hd_url ||
            node.playable_url_quality_hd ||
            node.hd_src_no_ratelimit ||
            node.hd_src ||
            (Array.isArray(node.progressive_urls)
              ? node.progressive_urls.find((p) => p?.metadata?.quality === "HD")?.progressive_url
              : null);
          const sd =
            node.browser_native_sd_url ||
            node.playable_url ||
            node.sd_src_no_ratelimit ||
            node.sd_src ||
            (Array.isArray(node.progressive_urls)
              ? node.progressive_urls.find((p) => p?.metadata?.quality === "SD")?.progressive_url ||
                node.progressive_urls.find((p) => p?.progressive_url)?.progressive_url
              : null);

          if ((hd || sd) && (!videoUrl || matchesTarget)) {
            videoUrl = hd || sd || videoUrl;
          }

          const dashXml = node.dash_manifest_xml_string || node.dash_manifest || node.manifest_xml;
          if (typeof dashXml === "string" && !audioUrl) {
            const audioMatch = dashXml.match(
              /<AdaptationSet[^>]*contentType="audio"[^>]*>[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>/i
            );
            if (audioMatch?.[1]) {
              audioUrl = audioMatch[1].replace(/&amp;/g, "&");
            }
          }

          if (!thumbnailUrl) {
            thumbnailUrl =
              node.preferred_thumbnail?.image?.uri ||
              node.thumbnailImage?.uri ||
              node.first_frame_thumbnail ||
              null;
          }
          if (durationSec == null && typeof node.playable_duration_in_ms === "number" && node.playable_duration_in_ms > 0) {
            durationSec = Number((node.playable_duration_in_ms / 1000).toFixed(2));
          }
          if (durationSec == null && typeof node.length_in_second === "number" && node.length_in_second > 0) {
            durationSec = Number(node.length_in_second);
          }

          // Creator & Caption from creation_story / short_form_video_context
          if (!username && node.video_owner?.name) {
            username = String(node.video_owner.name).trim();
          } else if (!username && node.short_form_video_context?.video_owner?.name) {
            username = String(node.short_form_video_context.video_owner.name).trim();
          }

          if (!caption && node.creation_story?.message?.text) {
            caption = String(node.creation_story.message.text).trim();
          } else if (!caption && node.short_form_video_context && node.message?.text) {
            caption = String(node.message.text).trim();
          }

          if (likes == null && typeof node.unified_reactors?.count === "number") {
            likes = node.unified_reactors.count;
          } else if (likes == null && typeof node.likers?.count === "number") {
            likes = node.likers.count;
          }
          if (comments == null && typeof node.total_comment_count === "number") {
            comments = node.total_comment_count;
          }
          if (views == null && typeof node.play_count === "number" && node.play_count > 0) {
            views = node.play_count;
          }

          for (const k of Object.keys(node)) {
            walk(node[k]);
          }
        };

        walk(parsedJson);
      }
    }
  } catch (_) {}

  // Fallback to local yt-dlp if Facebook ever changes its HTML script payload
  if (!videoUrl && fs.existsSync("/opt/homebrew/bin/yt-dlp")) {
    try {
      const { stdout } = await execFileAsync(
        "/opt/homebrew/bin/yt-dlp",
        ["-J", "--no-playlist", "--no-warnings", targetUrl],
        { timeout: 25000, maxBuffer: 15 * 1024 * 1024 }
      );
      const info = JSON.parse(stdout);
      const formats = Array.isArray(info.formats) ? info.formats : [];
      const progressive = formats
        .filter((f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" && f.url)
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      videoUrl = progressive[0]?.url || info.url || null;
      const audioOnly = formats.find((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none") && f.url);
      audioUrl = audioUrl || audioOnly?.url || videoUrl;
      thumbnailUrl = thumbnailUrl || info.thumbnail || null;
      username = username || info.uploader || info.channel || "";
      caption = caption || info.description || info.title || "";
      likes = likes ?? info.like_count ?? null;
      comments = comments ?? info.comment_count ?? null;
      views = views ?? info.view_count ?? null;
      durationSec = durationSec ?? info.duration ?? null;
      code = code || String(info.id || "");
    } catch (_) {}
  }

  if (!videoUrl) {
    return {
      ok: false,
      message: `Facebook did not return an MP4 stream for ${code || targetUrl}.`,
    };
  }

  return {
    ok: true,
    platform: "facebook",
    videoId: code,
    shortcode: code,
    url: code ? `https://www.facebook.com/reel/${code}/` : targetUrl,
    videoUrl,
    audioUrl: audioUrl || videoUrl,
    thumbnailUrl,
    username,
    caption,
    views,
    likes,
    comments,
    videoDuration: durationSec,
  };
}

// Local Whisper.cpp Transcription Engine (with full token offsets via -ojf)
async function transcribeMediaLocal({
  cacheKey = null,
  mediaFilePath = null,
  mediaUrl = null,
  mediaBase64 = null,
  platform = "instagram",
  profileName = "",
  language = "auto",
  force = false,
  needWordTokens = false,
}) {
  const normKey = cacheKey ? String(cacheKey).trim() : null;
  if (!force && normKey && transcriptCache[normKey]?.transcription) {
    const cachedRec = transcriptCache[normKey];
    if (!needWordTokens || Array.isArray(cachedRec.words)) {
      const hit = enrichTranscriptMetrics(cachedRec);
      return {
        ok: true,
        cached: true,
        cacheKey: normKey,
        ...hit,
      };
    }
  }

  const tmpId = "vs_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const tmpInput = mediaFilePath || path.join(os.tmpdir(), `${tmpId}.media`);
  const shouldDeleteInput = !mediaFilePath;
  const tmpWav = path.join(os.tmpdir(), `${tmpId}.wav`);
  const tmpOutPrefix = path.join(os.tmpdir(), `${tmpId}_out`);
  const tmpJson = `${tmpOutPrefix}.json`;

  try {
    if (!mediaFilePath) {
      if (mediaBase64) {
        const cleanB64 = String(mediaBase64).replace(/^data:[^;]+;base64,/, "");
        await fsp.writeFile(tmpInput, Buffer.from(cleanB64, "base64"));
      } else if (mediaUrl) {
        await downloadMediaToFile(mediaUrl, tmpInput);
      } else {
        return { ok: false, errorCode: "media_fetch_failed", message: "No mediaUrl or mediaBase64 provided." };
      }
    }

    await execFileAsync(
      FFMPEG_BIN,
      ["-y", "-i", tmpInput, "-t", "600", "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmpWav],
      { timeout: 60000 }
    );

    await execFileAsync(
      WHISPER_BIN,
      ["-m", WHISPER_MODEL, "-l", language || "auto", "-ojf", "-of", tmpOutPrefix, tmpWav],
      { timeout: 180000 }
    );

    const rawJson = JSON.parse(await fsp.readFile(tmpJson, "utf8"));
    const rawSegs = Array.isArray(rawJson?.transcription) ? rawJson.transcription : [];

    const segments = [];
    const words = [];

    for (const s of rawSegs) {
      const segText = String(s?.text || "").trim();
      if (!segText || /^\[.*\]$/.test(segText) || /^\(.*\)$/.test(segText)) continue;
      const segStart = Number(((s?.offsets?.from ?? 0) / 1000).toFixed(2));
      const segEnd = Number(((s?.offsets?.to ?? 0) / 1000).toFixed(2));
      segments.push({ start: segStart, end: segEnd, text: segText });

      // Extract token-level word timestamps when present in -ojf output
      if (Array.isArray(s.tokens) && s.tokens.length) {
        let curWord = "";
        let wStart = null;
        let wEnd = null;
        for (const tok of s.tokens) {
          const rawT = String(tok?.text || "");
          if (!rawT || /^\[_.*\]$/.test(rawT.trim())) continue;
          const tFrom = (tok?.offsets?.from ?? s?.offsets?.from ?? 0) / 1000;
          const tTo = (tok?.offsets?.to ?? s?.offsets?.to ?? 0) / 1000;
          if (/^\s/.test(rawT) && curWord.trim()) {
            words.push({
              start: Number(wStart.toFixed(2)),
              end: Number(wEnd.toFixed(2)),
              word: curWord.trim(),
            });
            curWord = rawT;
            wStart = tFrom;
            wEnd = tTo;
          } else {
            if (wStart === null) wStart = tFrom;
            wEnd = tTo;
            curWord += rawT;
          }
        }
        if (curWord.trim() && wStart !== null) {
          words.push({
            start: Number(wStart.toFixed(2)),
            end: Number((wEnd ?? wStart).toFixed(2)),
            word: curWord.trim(),
          });
        }
      }
    }

    const transcription = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
    const duration_seconds = segments.length ? Math.ceil(segments[segments.length - 1].end) : 0;
    const detectedLang = rawJson?.result?.language || language || "en";
    const hook = extractHookFromSegments(segments, 5.0);

    const record = enrichTranscriptMetrics({
      transcription,
      hook,
      segments,
      words,
      duration_seconds,
      language: detectedLang,
      platform,
      profileName,
      at: new Date().toISOString(),
    });

    if (normKey && transcription) {
      transcriptCache[normKey] = record;
      if (isPrimaryHub) await saveJson(TRANSCRIPTS_FILE, transcriptCache);
    }

    return {
      ok: true,
      cached: false,
      cacheKey: normKey,
      ...record,
    };
  } catch (err) {
    return {
      ok: false,
      errorCode: "whisper_failed",
      message: err?.message || String(err),
    };
  } finally {
    const cleanup = [tmpWav, tmpJson];
    if (shouldDeleteInput) cleanup.push(tmpInput);
    for (const f of cleanup) {
      try {
        await fsp.unlink(f);
      } catch (_) {}
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual Hook Frame Extractor (0s · 1.5s · 3s) + Apple Vision Neural OCR
// ─────────────────────────────────────────────────────────────────────────────

async function ensureVisionOcrBinary() {
  if (fs.existsSync(OCR_BIN_PATH)) return OCR_BIN_PATH;
  if (process.platform === "darwin" && SWIFTC_BIN && fs.existsSync(OCR_SWIFT_SRC)) {
    try {
      await execFileAsync(SWIFTC_BIN, ["-O", OCR_SWIFT_SRC, "-o", OCR_BIN_PATH], { timeout: 30000 });
      if (fs.existsSync(OCR_BIN_PATH)) return OCR_BIN_PATH;
    } catch (_) {}
  }
  return null;
}

async function probeVideoDuration(videoPath) {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BIN,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath],
      { timeout: 10000 }
    );
    const val = parseFloat(String(stdout || "").trim());
    return Number.isFinite(val) && val > 0 ? val : 6.0;
  } catch (_) {
    return 6.0;
  }
}

async function extractVisualHookLocal({ shortcode, videoUrl, force = false }) {
  const safeCode = String(shortcode || crypto.createHash("md5").update(String(videoUrl || "")).digest("hex").slice(0, 11))
    .replace(/[^a-zA-Z0-9_-]/g, "");

  if (!force && visualHooksCache[safeCode]?.frames?.length) {
    const cached = visualHooksCache[safeCode];
    const allExist = cached.frames.every((f) => f.localPath && fs.existsSync(f.localPath));
    if (allExist) {
      return { ok: true, cached: true, ...cached };
    }
  }

  if (!videoUrl) {
    return { ok: false, message: "No videoUrl available to extract frames." };
  }

  const outDir = path.join(HOOKS_DIR, safeCode);
  await fsp.mkdir(outDir, { recursive: true });
  const tmpVideo = path.join(os.tmpdir(), `vs_hook_${safeCode}_${Date.now()}.mp4`);

  try {
    await downloadMediaToFile(videoUrl, tmpVideo);
    const dur = await probeVideoDuration(tmpVideo);
    const rawTargets = [
      { idx: 0, label: "0.0s · Opening Frame", ts: Math.min(0.08, dur * 0.05) },
      { idx: 1, label: "1.5s · Hook Hold", ts: Math.min(1.5, dur * 0.45) },
      { idx: 2, label: "3.0s · Pattern Shift", ts: Math.min(3.0, Math.max(0.5, dur - 0.2)) },
    ];

    const frameFiles = [];
    for (const t of rawTargets) {
      const fname = `frame_${t.idx}.jpg`;
      const fpath = path.join(outDir, fname);
      await execFileAsync(
        FFMPEG_BIN,
        [
          "-y",
          "-ss",
          t.ts.toFixed(2),
          "-i",
          tmpVideo,
          "-frames:v",
          "1",
          "-vf",
          "scale='min(720,iw)':-2",
          "-q:v",
          "3",
          fpath,
        ],
        { timeout: 25000 }
      );
      frameFiles.push({
        index: t.idx,
        label: t.label,
        timestamp: Number(t.ts.toFixed(2)),
        filename: fname,
        localPath: fpath,
        imageUrl: `/api/hook-frame/${safeCode}/${fname}`,
        ocrLines: [],
        ocrText: "",
      });
    }

    const ocrBin = await ensureVisionOcrBinary();
    if (ocrBin) {
      try {
        const { stdout } = await execFileAsync(
          ocrBin,
          frameFiles.map((f) => f.localPath),
          { timeout: 15000 }
        );
        const ocrArr = JSON.parse(String(stdout || "[]"));
        ocrArr.forEach((entry, idx) => {
          if (frameFiles[idx]) {
            frameFiles[idx].ocrLines = Array.isArray(entry.lines) ? entry.lines : [];
            frameFiles[idx].ocrText = String(entry.text || "").trim();
          }
        });
      } catch (_) {}
    }

    const uniqueLines = [];
    const seenNorm = new Set();
    for (const f of frameFiles) {
      for (const line of f.ocrLines) {
        const norm = line.toLowerCase().replace(/[^a-z0-9àâçéèêëîïôûùüÿñæœ]+/g, "").trim();
        if (norm.length >= 2 && !seenNorm.has(norm)) {
          seenNorm.add(norm);
          uniqueLines.push(line);
        }
      }
    }

    const record = {
      shortcode: safeCode,
      durationSeconds: Number(dur.toFixed(2)),
      onScreenHookText: uniqueLines.join(" · "),
      uniqueOcrLines: uniqueLines,
      frames: frameFiles,
      extractedAt: new Date().toISOString(),
    };

    visualHooksCache[safeCode] = record;
    if (isPrimaryHub) await saveJson(VISUAL_HOOKS_FILE, visualHooksCache);

    return { ok: true, cached: false, ...record };
  } catch (err) {
    return { ok: false, message: err?.message || String(err) };
  } finally {
    try {
      await fsp.unlink(tmpVideo);
    } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VideoBot One-Shot Reproduce Engine (`ig_<shortcode>.zip` + Storyboard Skill)
// ─────────────────────────────────────────────────────────────────────────────

function fmtSceneClock(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

async function detectShotCutScenes(videoPath, durationSec) {
  const cuts = [0.0];
  try {
    const { stderr } = await execFileAsync(
      FFMPEG_BIN,
      [
        "-hide_banner",
        "-i",
        videoPath,
        "-vf",
        "select='gt(scene,0.26)',showinfo",
        "-vsync",
        "vfr",
        "-f",
        "null",
        "-",
      ],
      { timeout: 90000, maxBuffer: 15 * 1024 * 1024 }
    );
    const matches = String(stderr || "").matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g);
    for (const m of matches) {
      const t = parseFloat(m[1]);
      if (!Number.isFinite(t) || t <= 0.6 || t >= durationSec - 0.45) continue;
      if (t - cuts[cuts.length - 1] >= 0.85) {
        cuts.push(Number(t.toFixed(2)));
      }
      if (cuts.length >= 40) break;
    }
  } catch (_) {}

  // Fallback for single-take talking-head videos without hard cuts: split into ~3.8s visual beats
  if (cuts.length < 2 && durationSec > 4.2) {
    const beat = durationSec <= 18 ? 3.2 : 4.2;
    for (let t = beat; t < durationSec - 0.9 && cuts.length < 30; t += beat) {
      cuts.push(Number(t.toFixed(2)));
    }
  }

  const scenes = [];
  for (let i = 0; i < cuts.length; i++) {
    const start = cuts[i];
    const end = i + 1 < cuts.length ? cuts[i + 1] : Number(durationSec.toFixed(2));
    if (end - start < 0.35 && scenes.length > 0) {
      scenes[scenes.length - 1].end = end;
      continue;
    }
    scenes.push({
      index: scenes.length + 1,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
    });
  }
  return scenes;
}

function alignWordsToScenes(scenes, words, segments) {
  if (Array.isArray(words) && words.length > 0) {
    const buckets = scenes.map(() => []);
    for (const w of words) {
      const mid = ((w.start ?? 0) + (w.end ?? w.start ?? 0)) / 2;
      let sIdx = scenes.findIndex((sc, idx) =>
        idx === scenes.length - 1 ? mid >= sc.start - 0.15 : mid >= sc.start - 0.1 && mid < sc.end
      );
      if (sIdx < 0) sIdx = 0;
      buckets[sIdx].push(w.word);
    }
    return buckets.map((arr) => arr.join(" ").replace(/\s+/g, " ").trim());
  }

  // Fallback segment overlap alignment
  return scenes.map((sc) => {
    const matched = (segments || []).filter((seg) => {
      const mid = ((seg.start ?? 0) + (seg.end ?? seg.start ?? 0)) / 2;
      return mid >= sc.start - 0.1 && mid < sc.end + 0.05;
    });
    return matched
      .map((m) => m.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  });
}

function buildSkillRemakePrompt(pack) {
  return [
    `Reproduis cette vidéo en suivant le skill video-storyboard (/Users/victor/.agents/skills/video-storyboard/SKILL.md).`,
    `Le pack complet VideoBot est déjà extrait localement ici : ${pack.folderPath}`,
    `- Découpage plan par plan + texte exact dit sur chaque scène : ${path.join(pack.folderPath, "scenes.txt")}`,
    `- Script complet : ${path.join(pack.folderPath, "transcript.txt")}`,
    `- Description originale du post (caption + CTA) : ${path.join(pack.folderPath, "caption.txt")}`,
    `- Planche contact : ${path.join(pack.folderPath, "storyboard.jpg")}`,
    `- Frames de chaque changement de plan : ${path.join(pack.folderPath, "frames")}`,
    `Commence par me proposer les 5 hooks visuels adaptés à mon personnage, puis demande-moi si je veux voir le storyboard avant d'animer.`,
  ].join("\n");
}

async function reproduceVideoLocal(params = {}) {
  const parsed = parseVideoTarget(
    params.url || params.urlOrShortcode || params.postUrlOrShortcode || params.shortcode || params.code || "",
    params.platform || "instagram"
  );
  let platform = String(params.platform || parsed?.platform || "instagram").toLowerCase();
  let shortcode = String(params.shortcode || params.code || parsed?.shortcode || "").trim();
  let username = String(params.username || parsed?.username || "").replace(/^@/, "").trim();
  let postUrl =
    params.url ||
    parsed?.url ||
    (shortcode
      ? platform === "facebook"
        ? `https://www.facebook.com/reel/${shortcode}/`
        : `https://www.instagram.com/reel/${shortcode}/`
      : "");
  let videoUrl = params.videoUrl || null;
  let thumbnailUrl = params.thumbnailUrl || null;
  let caption = params.caption || "";
  let views = params.views ?? null;
  let likes = params.likes ?? null;
  let comments = params.comments ?? null;
  let outlierScore = params.outlierScore ?? null;
  let requestedCategory = params.category && params.category !== "auto" ? params.category : "";

  // Check if we already have videoUrl/metrics in Master Posts DB
  if (shortcode && postsDb[`${platform}:${shortcode}`]) {
    const known = postsDb[`${platform}:${shortcode}`];
    videoUrl = videoUrl || known.videoUrl;
    thumbnailUrl = thumbnailUrl || known.thumbnailUrl;
    username = username || known.username;
    caption = caption || known.caption;
    views = views ?? known.views;
    likes = likes ?? known.likes;
    comments = comments ?? known.comments;
    outlierScore = outlierScore ?? known.outlierScore;
    if (!requestedCategory && known.category && known.category !== "Uncategorized") {
      requestedCategory = known.category;
    }
  }

  const prefix =
    platform === "tiktok"
      ? "tt"
      : platform === "youtube"
      ? "yt"
      : platform === "facebook"
      ? "fb"
      : "ig";
  const safeCode = (shortcode || crypto.createHash("md5").update(postUrl || String(Date.now())).digest("hex").slice(0, 11))
    .replace(/[^a-zA-Z0-9_-]/g, "");
  const packId = `${prefix}_${safeCode}`;
  const packFolder = path.join(REPRODUCE_DIR, packId);
  const framesDir = path.join(packFolder, "frames");
  const zipPath = path.join(REPRODUCE_DIR, `${packId}.zip`);

  // Resolve fresh videoUrl and/or missing post description (`caption`) via Direct FB Resolver or Chrome extension
  const fetchFreshMediaInfo = async () => {
    if (platform === "facebook") {
      const fb = await resolveFacebookReelDirect(postUrl || safeCode);
      if (fb?.ok) {
        if (fb.videoUrl) videoUrl = fb.videoUrl;
        thumbnailUrl = fb.thumbnailUrl || thumbnailUrl;
        username = fb.username || username;
        caption = fb.caption || caption;
        views = views ?? fb.views ?? null;
        likes = likes ?? fb.likes ?? null;
        comments = comments ?? fb.comments ?? null;
        if (fb.url) postUrl = fb.url;
      }
      return fb;
    }

    const info = await runExtensionJob(
      {
        kind: "media_info",
        platform,
        shortcode: safeCode,
        username,
        url: postUrl,
      },
      55000
    );
    if (info?.ok) {
      if (info.videoUrl) videoUrl = info.videoUrl;
      thumbnailUrl = info.thumbnailUrl || thumbnailUrl;
      username = info.username || username;
      caption = info.caption || caption;
      views = views ?? info.viewCount ?? null;
      likes = likes ?? info.likesCount ?? null;
      comments = comments ?? info.commentsCount ?? null;
    }
    return info;
  };

  // Return cached pack immediately unless force=true (hydrate caption if missing on cached pack)
  if (!params.force) {
    const existing = reproduceDb.find((p) => p.packId === packId);
    if (existing && fs.existsSync(zipPath) && fs.existsSync(path.join(packFolder, "scenes.txt"))) {
      if (!existing.caption && isExtensionConnected()) {
        try {
          await fetchFreshMediaInfo();
          if (caption) {
            existing.caption = caption;
            await propagatePostEnrichment(platform, safeCode, { caption, username });
          }
        } catch (_) {}
      }
      if (requestedCategory) {
        await assignCategoryAndPropagate({
          category: requestedCategory,
          platform,
          username: existing.username || username,
          shortcode: safeCode,
          applyToCreator: true,
        });
      }
      existing.category = existing.category || inferCategory(existing);
      return { ok: true, cached: true, pack: existing };
    }
  }

  // Always fetch media_info when videoUrl OR caption is missing (Instagram Reels grid omits captions)
  if (!videoUrl || !caption) {
    const info = await fetchFreshMediaInfo();
    if (!videoUrl) {
      return {
        ok: false,
        message: info?.error?.message || `Could not resolve MP4 video stream for ${packId}. Make sure Chrome is open and signed in.`,
      };
    }
  }

  // Clean & recreate pack directories
  await fsp.rm(packFolder, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(framesDir, { recursive: true });

  const videoPath = path.join(packFolder, "video.mp4");
  const thumbPath = path.join(packFolder, "thumbnail.jpg");
  const storyboardPath = path.join(packFolder, "storyboard.jpg");
  const transcriptPath = path.join(packFolder, "transcript.txt");
  const captionTxtPath = path.join(packFolder, "caption.txt");
  const scenesTxtPath = path.join(packFolder, "scenes.txt");
  const briefMdPath = path.join(packFolder, "REPRODUCE_BRIEF.md");
  const metaJsonPath = path.join(packFolder, "metadata.json");

  // 1. Download clean MP4 (retry once with fresh media_info if CDN URL expired)
  try {
    await downloadMediaToFile(videoUrl, videoPath);
  } catch (dlErr) {
    await fetchFreshMediaInfo();
    if (!videoUrl) return { ok: false, message: dlErr?.message || "Video download failed." };
    await downloadMediaToFile(videoUrl, videoPath);
  }

  const durationSec = await probeVideoDuration(videoPath);

  // 2. Download or extract cover thumbnail.jpg
  let thumbOk = false;
  if (thumbnailUrl) {
    try {
      await downloadMediaToFile(thumbnailUrl, thumbPath);
      thumbOk = fs.existsSync(thumbPath);
    } catch (_) {}
  }
  if (!thumbOk) {
    await execFileAsync(
      FFMPEG_BIN,
      ["-y", "-ss", "0.10", "-i", videoPath, "-frames:v", "1", "-vf", "scale='min(720,iw)':-2", "-q:v", "3", thumbPath],
      { timeout: 20000 }
    ).catch(() => {});
  }

  // 3. Detect every shot change (`changement de plan`) + extract frames/scene_01.jpg ... scene_NN.jpg
  const rawScenes = await detectShotCutScenes(videoPath, durationSec);
  const sceneRecords = [];

  for (const sc of rawScenes) {
    const padNum = String(sc.index).padStart(2, "0");
    const fileName = `scene_${padNum}.jpg`;
    const filePath = path.join(framesDir, fileName);
    // Sample slightly inside the shot (+0.12s) to avoid transition blur on frame 0
    const sampleTs = Math.min(Math.max(0, sc.end - 0.04), sc.start + Math.min(0.14, (sc.end - sc.start) * 0.25));

    await execFileAsync(
      FFMPEG_BIN,
      [
        "-y",
        "-ss",
        sampleTs.toFixed(2),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale='min(720,iw)':-2",
        "-q:v",
        "3",
        filePath,
      ],
      { timeout: 20000 }
    );

    sceneRecords.push({
      index: sc.index,
      start: sc.start,
      end: sc.end,
      timeRange: `${fmtSceneClock(sc.start)}–${fmtSceneClock(sc.end)}`,
      frameFile: `frames/${fileName}`,
      frameUrl: `/api/reproduce/asset/${packId}/frames/${fileName}`,
      localPath: filePath,
      spokenText: "",
      ocrText: "",
    });
  }

  // 4. Generate storyboard.jpg contact sheet (grid of all scene_NN.jpg frames)
  const cols = Math.min(4, Math.max(1, sceneRecords.length));
  const rows = Math.max(1, Math.ceil(sceneRecords.length / cols));
  await execFileAsync(
    FFMPEG_BIN,
    [
      "-y",
      "-framerate",
      "1",
      "-i",
      path.join(framesDir, "scene_%02d.jpg"),
      "-frames:v",
      "1",
      "-vf",
      `scale=360:-2,tile=${cols}x${rows}:padding=8:margin=8:color=0x111113`,
      "-q:v",
      "3",
      storyboardPath,
    ],
    { timeout: 30000 }
  ).catch(async () => {
    if (sceneRecords[0]?.localPath && fs.existsSync(sceneRecords[0].localPath)) {
      await fsp.copyFile(sceneRecords[0].localPath, storyboardPath).catch(() => {});
    }
  });

  // 5. Run Whisper GPU transcription with word-level alignment + Apple Vision OCR in parallel
  const [whisperRes, ocrBin] = await Promise.all([
    transcribeMediaLocal({
      cacheKey: safeCode,
      mediaFilePath: videoPath,
      platform,
      profileName: username,
      needWordTokens: true,
    }),
    ensureVisionOcrBinary(),
  ]);

  if (ocrBin && sceneRecords.length > 0) {
    try {
      const { stdout } = await execFileAsync(
        ocrBin,
        sceneRecords.map((s) => s.localPath),
        { timeout: 25000 }
      );
      const ocrArr = JSON.parse(String(stdout || "[]"));
      ocrArr.forEach((entry, i) => {
        if (sceneRecords[i]) {
          sceneRecords[i].ocrText = String(entry?.text || "").replace(/\s+/g, " ").trim();
        }
      });
    } catch (_) {}
  }

  const fullTranscript = String(whisperRes?.transcription || "").trim();
  const spokenHook = String(whisperRes?.hook || fullTranscript.slice(0, 140)).trim();
  const perSceneWords = alignWordsToScenes(
    sceneRecords,
    whisperRes?.words || [],
    whisperRes?.segments || []
  );

  sceneRecords.forEach((sc, idx) => {
    sc.spokenText = perSceneWords[idx] || "";
  });

  // 6. Write exact VideoBot `transcript.txt`, `caption.txt`, and `scenes.txt`
  await fsp.writeFile(transcriptPath, (fullTranscript || "(No spoken dialogue detected)") + "\n", "utf8");
  await fsp.writeFile(captionTxtPath, (caption || "(No post caption)") + "\n", "utf8");

  const scenesTxtLines = [
    `Scene Breakdown — video ${packId}`,
    `${sceneRecords.length} scenes. Each scene below = its first frame (scene_NN.jpg) + the lines spoken during it.`,
    ``,
  ];
  for (const sc of sceneRecords) {
    scenesTxtLines.push(`Scene ${sc.index}  [${sc.timeRange}]`);
    scenesTxtLines.push(sc.spokenText || "(visual beat / no speech)");
    scenesTxtLines.push(``);
  }
  const scenesTxtContent = scenesTxtLines.join("\n");
  await fsp.writeFile(scenesTxtPath, scenesTxtContent, "utf8");

  const onScreenHook = sceneRecords
    .slice(0, 3)
    .map((s) => s.ocrText)
    .filter(Boolean)
    .join(" · ");

  const resolvedPackCategory = requestedCategory
    ? ensureCategoryExists(requestedCategory)
    : inferCategory({
        platform,
        code: safeCode,
        username,
        caption,
        transcript: fullTranscript,
        spokenHook,
        onScreenHook,
      });

  // 7. Write REPRODUCE_BRIEF.md & metadata.json inside pack
  const briefLines = [
    `# Reproduce Pack — ${packId}`,
    ``,
    `- **Creator**: ${username ? "@" + username : "Unknown"} (${platform})`,
    `- **Category**: ${resolvedPackCategory}`,
    `- **Source URL**: ${postUrl}`,
    `- **Duration**: ${durationSec.toFixed(1)}s · **Scenes**: ${sceneRecords.length}`,
    ...(outlierScore != null ? [`- **Outlier Score**: ${outlierScore}x`] : []),
    ...(views != null ? [`- **Views**: ${views.toLocaleString()}`] : []),
    ...(onScreenHook ? [`- **On-Screen Hook (OCR)**: ${onScreenHook}`] : []),
    `- **Spoken Hook (0-5s)**: ${spokenHook || "—"}`,
    ``,
    `## Original Post Description (Caption)`,
    caption || "(No post caption)",
    ``,
    `## Full Spoken Transcript`,
    fullTranscript || "(No spoken dialogue)",
    ``,
    `## Shot-by-Shot Breakdown`,
    ...sceneRecords.map(
      (sc) =>
        `### Scene ${sc.index} [${sc.timeRange}] — \`${sc.frameFile}\`\n` +
        `- **Spoken**: ${sc.spokenText || "(silent beat)"}\n` +
        (sc.ocrText ? `- **On-Screen Text**: ${sc.ocrText}\n` : "")
    ),
  ];
  await fsp.writeFile(briefMdPath, briefLines.join("\n"), "utf8");

  const packRecord = {
    packId,
    platform,
    shortcode: safeCode,
    username,
    category: resolvedPackCategory,
    url: postUrl,
    caption,
    views,
    likes,
    comments,
    outlierScore,
    durationSeconds: Number(durationSec.toFixed(2)),
    sceneCount: sceneRecords.length,
    spokenHook,
    onScreenHook,
    transcript: fullTranscript,
    wordsPerMinute: whisperRes?.wordsPerMinute ?? null,
    folderPath: packFolder,
    zipPath,
    zipUrl: `/api/reproduce/zip/${packId}`,
    thumbnailAssetUrl: `/api/reproduce/asset/${packId}/thumbnail.jpg`,
    storyboardAssetUrl: `/api/reproduce/asset/${packId}/storyboard.jpg`,
    videoAssetUrl: `/api/reproduce/asset/${packId}/video.mp4`,
    scenes: sceneRecords.map(({ localPath, ...rest }) => rest),
    createdAt: new Date().toISOString(),
  };
  packRecord.skillPrompt = buildSkillRemakePrompt(packRecord);

  await fsp.writeFile(metaJsonPath, JSON.stringify(packRecord, null, 2), "utf8");

  // 8. Create `ig_<shortcode>.zip` archive identical to VideoBot zip structure
  await fsp.unlink(zipPath).catch(() => {});
  await execFileAsync(ZIP_BIN, ["-rq", `${packId}.zip`, packId], {
    cwd: REPRODUCE_DIR,
    timeout: 60000,
  });

  // 9. Persist in reproduce_db.json AND propagate caption + category across Master DB & scans
  const existingIdx = reproduceDb.findIndex((p) => p.packId === packId);
  if (existingIdx >= 0) reproduceDb.splice(existingIdx, 1);
  reproduceDb.unshift(packRecord);
  if (isPrimaryHub) {
    await saveJson(REPRODUCE_DB_FILE, reproduceDb);
  }

  await upsertPostsToDb(
    [
      {
        platform,
        code: safeCode,
        shortcode: safeCode,
        username,
        category: resolvedPackCategory,
        url: postUrl,
        caption,
        views,
        likes,
        comments,
        outlierScore,
        videoDuration: packRecord.durationSeconds,
        thumbnailUrl: packRecord.thumbnailAssetUrl,
        videoUrl: packRecord.videoAssetUrl,
      },
    ],
    { platform, username, category: resolvedPackCategory, source: "reproduce_pack" }
  );
  await propagatePostEnrichment(platform, safeCode, {
    caption,
    username,
    category: resolvedPackCategory,
  });

  return { ok: true, cached: false, pack: packRecord };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension WebSocket State & Job Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

const extState = {
  ws: null,
  connectedAt: null,
  version: null,
  browser: null,
  lastSeenAt: null,
  pendingJobs: new Map(),
  pendingFocus: new Map(),
};

function isExtensionConnected() {
  return !!(extState.ws && extState.ws.readyState === 1);
}

function dispatchExtensionJobLocal(jobPayload, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    if (!isExtensionConnected()) {
      return reject(
        new Error(
          "ViralSpy Chrome Extension is not connected to ws://127.0.0.1:8765/ext. Open Chrome and make sure the ViralSpy extension is enabled."
        )
      );
    }
    const jobId = jobPayload.jobId || "job_" + crypto.randomUUID().slice(0, 8);
    const fullJob = { ...jobPayload, jobId };

    const timer = setTimeout(() => {
      extState.pendingJobs.delete(jobId);
      reject(new Error(`Extension job ${jobId} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    extState.pendingJobs.set(jobId, {
      job: fullJob,
      progress: [],
      timer,
      resolve: (res) => {
        clearTimeout(timer);
        extState.pendingJobs.delete(jobId);
        resolve(res);
      },
      reject: (err) => {
        clearTimeout(timer);
        extState.pendingJobs.delete(jobId);
        reject(err);
      },
    });

    extState.ws.send(JSON.stringify({ type: "job", job: fullJob }));
  });
}

function focusExtensionTabLocal(any = true) {
  return new Promise((resolve) => {
    if (!isExtensionConnected()) {
      return resolve({ ok: false, reason: "extension_not_connected" });
    }
    const requestId = "focus_" + crypto.randomUUID().slice(0, 8);
    const timer = setTimeout(() => {
      extState.pendingFocus.delete(requestId);
      resolve({ ok: false, reason: "timeout" });
    }, 5000);
    extState.pendingFocus.set(requestId, {
      timer,
      resolve: (msg) => {
        clearTimeout(timer);
        extState.pendingFocus.delete(requestId);
        resolve(msg);
      },
    });
    extState.ws.send(JSON.stringify({ type: "focus", requestId, port: PORT, any: !!any }));
  });
}

async function persistSortExports(result) {
  const savedFiles = {};
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = String(result.username || result.query || "sort").replace(/[^a-zA-Z0-9_-]+/g, "_");
  try {
    if (result.csv) {
      const csvPath = path.join(EXPORTS_DIR, result.filename || `${slug}_${ts}.csv`);
      await fsp.writeFile(csvPath, result.csv, "utf8");
      savedFiles.csvPath = csvPath;
    }
    if (result.json) {
      const jsonPath = path.join(EXPORTS_DIR, result.jsonFilename || `${slug}_${ts}.json`);
      await fsp.writeFile(jsonPath, result.json, "utf8");
      savedFiles.jsonPath = jsonPath;
    } else if (Array.isArray(result.rows) && result.rows.length) {
      const jsonPath = path.join(EXPORTS_DIR, `${slug}_${ts}.json`);
      await fsp.writeFile(jsonPath, JSON.stringify(result.rows, null, 2), "utf8");
      savedFiles.jsonPath = jsonPath;
    }
  } catch (_) {}
  return savedFiles;
}

function formatPostSummary(row, index, fallbackPlatform = "instagram") {
  const platform = row.platform || fallbackPlatform;
  const code = row.code || row.shortcode || "";
  const url =
    row.url ||
    (platform === "instagram" && code
      ? `https://www.instagram.com/reel/${code}/`
      : "");

  const createdMs = row.createDate ? Date.parse(row.createDate) : NaN;
  const ageHours =
    row.ageHours ??
    (Number.isFinite(createdMs) ? Number(Math.max(0.5, (Date.now() - createdMs) / 3600000).toFixed(2)) : null);
  const views = row.viewCount ?? row.views ?? null;
  const likes = row.likesCount ?? row.likes ?? null;
  const metric = views ?? likes ?? null;
  const viewsPerHour =
    row.viewsPerHour ??
    (ageHours != null && metric != null ? Number((+metric / ageHours).toFixed(2)) : null);

  const outlierScore =
    typeof row.outlierScore === "number" ? Number(row.outlierScore.toFixed(2)) : null;
  const outlierStr = outlierScore != null ? `${outlierScore.toFixed(2)}x` : "n/a";
  const pack = findPackForCode(code);
  const dbHit = code ? postsDb[`${platform}:${code}`] : null;
  const resolvedUsername = row.userName || row.username || dbHit?.username || pack?.username || "";
  const resolvedCaption = String(row.caption || dbHit?.caption || pack?.caption || "").trim();
  const resolvedCategory = inferCategory({
    platform,
    code,
    username: resolvedUsername,
    caption: resolvedCaption,
    category: row.category || dbHit?.category || pack?.category,
  });

  return {
    rank: index + 1,
    platform,
    shortcode: code,
    code,
    url,
    username: resolvedUsername,
    category: resolvedCategory,
    createDate: row.createDate || "",
    ageHours,
    outlierScore,
    outlierLabel: outlierStr,
    velocityScore: row.velocityScore ?? null,
    viewsPerHour,
    views,
    likes,
    comments: row.commentsCount ?? row.comments ?? null,
    shares: row.sharesCount ?? row.shares ?? null,
    pinned: !!row.pinned,
    mediaType: row.mediaType === 2 ? "video/reel" : row.mediaType === 8 ? "carousel" : "image",
    carouselCount: row.carouselCount ?? null,
    videoDuration: row.videoDuration ?? null,
    caption: resolvedCaption,
    videoUrl: row.videoUrl || dbHit?.videoUrl || null,
    audioUrl: row.audioUrl || row.videoUrl || dbHit?.audioUrl || null,
    thumbnailUrl: row.thumbnailUrl || row.thumbnailSmallUrl || dbHit?.thumbnailUrl || null,
    hasCachedTranscript: !!(code && transcriptCache[code]),
    hasCachedVisualHook: !!(code && visualHooksCache[code]),
    isSaved: isCodeSaved(code),
    reproducePackId: pack ? pack.packId : null,
    reproduceZipUrl: pack ? pack.zipUrl : null,
  };
}

async function recordScanInHistory(entry) {
  const id = `${entry.platform || "instagram"}:${entry.username}:${entry.surface || "reels"}`;
  const filtered = scanHistory.filter((x) => x.id !== id);
  filtered.unshift({ id, ...entry, scannedAt: new Date().toISOString() });
  scanHistory.length = 0;
  scanHistory.push(...filtered.slice(0, 35));
  await saveJson(SCAN_HISTORY_FILE, scanHistory);
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Client Helpers (Primary Hub or Secondary MCP Process)
// ─────────────────────────────────────────────────────────────────────────────

let isPrimaryHub = false;

async function getHubStatus() {
  if (isPrimaryHub) {
    return {
      ok: true,
      service: "ViralSpy Studio Hub & MCP v3.0",
      mode: "everyone",
      port: PORT,
      dashboardUrl: `http://${HOST}:${PORT}/dashboard`,
      extension: {
        connected: isExtensionConnected(),
        version: extState.version,
        browser: extState.browser,
        connectedAt: extState.connectedAt,
        lastSeenAt: extState.lastSeenAt,
      },
      whisper: {
        binary: WHISPER_BIN,
        model: WHISPER_MODEL,
        modelAvailable: fs.existsSync(WHISPER_MODEL),
        cachedTranscripts: Object.keys(transcriptCache).length,
      },
      visionOcrAvailable: process.platform === "darwin" && (fs.existsSync(OCR_BIN_PATH) || !!SWIFTC_BIN),
      savedLibraryCount: savedLibrary.posts.length,
      postsDbCount: Object.keys(postsDb).length,
      reproducePacksCount: reproduceDb.length,
      visualHooksCount: Object.keys(visualHooksCache).length,
      recentScansCount: scanHistory.length,
      radarRunsCount: radarHistory.length,
      liveRadar: liveRadarStatus,
    };
  }
  const res = await fetch(`http://${HOST}:${PORT}/api/status`);
  return await res.json();
}

async function runExtensionJob(job, timeoutMs = 180000) {
  let result;
  if (isPrimaryHub) {
    result = await dispatchExtensionJobLocal(job, timeoutMs);
  } else {
    const res = await fetch(`http://${HOST}:${PORT}/api/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job, timeoutMs }),
    });
    result = await res.json();
  }
  if (result && result.ok && (result.csv || result.json || result.rows)) {
    result.savedExports = await persistSortExports(result);
  }
  return result;
}

async function runTranscription(params) {
  if (isPrimaryHub) {
    return await transcribeMediaLocal(params);
  }
  const res = await fetch(`http://${HOST}:${PORT}/api/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return await res.json();
}

async function runVisualHook(params) {
  let videoUrl = params.videoUrl || null;
  const parsed = parseVideoTarget(params.postUrlOrShortcode || params.shortcode || "", params.platform || "instagram");
  const platform = String(params.platform || parsed?.platform || "instagram").toLowerCase();
  const shortcode = extractShortcode(params.shortcode || params.postUrlOrShortcode) || parsed?.shortcode || params.shortcode || null;

  if (!videoUrl && shortcode) {
    if (platform === "facebook") {
      const fb = await resolveFacebookReelDirect(params.postUrlOrShortcode || shortcode);
      if (fb?.ok && fb.videoUrl) videoUrl = fb.videoUrl;
    } else {
      const info = await runExtensionJob({ kind: "media_info", platform, shortcode }, 45000);
      if (info?.ok && info.videoUrl) {
        videoUrl = info.videoUrl;
      }
    }
  }

  if (isPrimaryHub) {
    return await extractVisualHookLocal({ shortcode, videoUrl, force: !!params.force });
  }
  const res = await fetch(`http://${HOST}:${PORT}/api/visual-hook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shortcode, videoUrl, force: !!params.force }),
  });
  return await res.json();
}

async function runReproducePack(params) {
  if (isPrimaryHub) {
    return await reproduceVideoLocal(params);
  }
  const res = await fetch(`http://${HOST}:${PORT}/api/reproduce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return await res.json();
}

async function fetchAndPersistPostDetails(params = {}) {
  const parsed = parseVideoTarget(
    params.url || params.postUrlOrShortcode || params.shortcode || params.code || "",
    params.platform || "instagram"
  );
  const platform = String(params.platform || parsed?.platform || "instagram").toLowerCase();
  const shortcode = String(params.shortcode || params.code || parsed?.shortcode || "").trim();
  if (!shortcode) {
    return { ok: false, message: "Missing post shortcode or URL." };
  }

  const key = `${platform}:${shortcode}`;
  const existing = postsDb[key];
  const pack = findPackForCode(shortcode);

  if (!params.force && existing?.caption && existing?.username) {
    return { ok: true, cached: true, post: existing };
  }

  if (!params.force && pack?.caption) {
    const synced = await propagatePostEnrichment(platform, shortcode, {
      caption: pack.caption,
      username: pack.username || existing?.username || params.username || "",
    });
    return { ok: true, cached: true, post: synced };
  }

  let info;
  if (platform === "facebook") {
    const fb = await resolveFacebookReelDirect(
      params.url || existing?.url || parsed?.url || `https://www.facebook.com/reel/${shortcode}/`
    );
    info = fb?.ok
      ? {
          ok: true,
          username: fb.username,
          caption: fb.caption,
          viewCount: fb.views,
          likesCount: fb.likes,
          commentsCount: fb.comments,
          videoDuration: fb.videoDuration,
          thumbnailUrl: fb.thumbnailUrl,
          videoUrl: fb.videoUrl,
          audioUrl: fb.audioUrl,
        }
      : { ok: false, error: { message: fb?.message || "Could not resolve Facebook Reel." } };
  } else {
    info = await runExtensionJob(
      {
        kind: "media_info",
        platform,
        shortcode,
        username: params.username || existing?.username || parsed?.username || "",
        url: params.url || existing?.url || parsed?.url || `https://www.instagram.com/reel/${shortcode}/`,
        noCreateTab: Boolean(params.noCreateTab),
      },
      35000
    );
  }

  if (!info?.ok) {
    return {
      ok: false,
      message: info?.error?.message || "Could not retrieve post description from Instagram.",
    };
  }

  const updated = await propagatePostEnrichment(platform, shortcode, {
    username: info.username || existing?.username || params.username || "",
    caption: info.caption ?? "",
    views: info.viewCount ?? existing?.views ?? null,
    likes: info.likesCount ?? existing?.likes ?? null,
    comments: info.commentsCount ?? existing?.comments ?? null,
    videoDuration: info.videoDuration ?? existing?.videoDuration ?? null,
    createDate: info.createDate || existing?.createDate || "",
    thumbnailUrl: info.thumbnailUrl || existing?.thumbnailUrl || null,
    videoUrl: info.videoUrl || existing?.videoUrl || null,
    audioUrl: info.audioUrl || info.videoUrl || existing?.audioUrl || null,
  });

  // Mark captionChecked even when a creator genuinely published an empty caption
  if (updated && !updated.caption) {
    updated.captionChecked = true;
    if (isPrimaryHub) await saveJson(POSTS_DB_FILE, postsDb);
  }

  return { ok: true, cached: false, post: updated };
}

let captionHydrationRunning = false;
async function hydrateMissingCaptionsBatch({ shortcodes = [], username = "", platform = "instagram", limit = 15 } = {}) {
  if (captionHydrationRunning || !isExtensionConnected()) {
    return { ok: true, hydrated: 0, busy: captionHydrationRunning };
  }
  captionHydrationRunning = true;
  let hydrated = 0;
  try {
    const plat = String(platform || "instagram").toLowerCase();
    const cleanUser = String(username || "").replace(/^@/, "").trim().toLowerCase();

    let targets = [];
    if (Array.isArray(shortcodes) && shortcodes.length) {
      targets = shortcodes.map((c) => String(c || "").trim()).filter(Boolean);
    } else {
      let candidates = Object.values(postsDb).filter(
        (p) => p.platform === plat && !p.caption && !p.captionChecked
      );
      if (cleanUser) {
        candidates = candidates.filter((p) => (p.username || "").toLowerCase() === cleanUser);
      }
      candidates.sort((a, b) => ((b.outlierScore ?? b.views) || 0) - ((a.outlierScore ?? a.views) || 0));
      targets = candidates.slice(0, Math.max(1, Math.min(40, Number(limit) || 15))).map((p) => p.code);
    }

    targets = targets.slice(0, Math.max(1, Math.min(40, Number(limit) || 15)));
    for (const code of targets) {
      if (!isExtensionConnected()) break;
      const key = `${plat}:${code}`;
      if (postsDb[key]?.caption) continue;
      try {
        const res = await fetchAndPersistPostDetails({ shortcode: code, platform: plat, noCreateTab: true });
        if (res?.ok) hydrated += 1;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 260));
    }
  } finally {
    captionHydrationRunning = false;
  }
  return { ok: true, hydrated };
}

async function runMineComments({ postUrlOrShortcode, shortcode: rawCode, limit = 60, force = false }) {
  const shortcode = extractShortcode(postUrlOrShortcode || rawCode) || rawCode;
  if (!shortcode) {
    return { ok: false, message: "Provide a valid Instagram Reel/Post URL or shortcode." };
  }
  if (!force && commentsCache[shortcode]?.topComments?.length) {
    return { ok: true, cached: true, ...commentsCache[shortcode] };
  }
  const res = await runExtensionJob({ kind: "comments", shortcode, limit }, 60000);
  if (res?.ok) {
    const record = {
      shortcode,
      caption: res.caption || "",
      totalFetched: res.totalFetched || 0,
      questions: res.questions || [],
      requests: res.requests || [],
      topComments: res.topComments || [],
      minedAt: new Date().toISOString(),
    };
    commentsCache[shortcode] = record;
    if (isPrimaryHub) await saveJson(COMMENTS_CACHE_FILE, commentsCache);
    return { ok: true, cached: false, ...record };
  }
  return { ok: false, message: res?.error?.message || "Failed to fetch comments." };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parallel Multi-URL Niche Radar + Permanent Database Archival
// ─────────────────────────────────────────────────────────────────────────────

async function runNicheRadar({
  usernames = [],
  urlsOrHandles = "",
  seedUsername = "",
  autoSimilarCount = 5,
  daysBack = 30,
  perAccountDepth = 36,
  sortBy = "outlier",
  concurrency = 3,
  category = "auto",
}) {
  let targetSpecs = parseCreatorList(
    Array.isArray(usernames) && usernames.length ? usernames : urlsOrHandles,
    "instagram"
  );

  const parsedSeed = parseCreatorTarget(seedUsername, "instagram");
  const cleanSeed = parsedSeed?.username || "";
  let discoveredAccounts = [];

  liveRadarStatus.running = true;
  liveRadarStatus.startedAt = new Date().toISOString();
  liveRadarStatus.completed = 0;
  liveRadarStatus.total = Math.max(1, targetSpecs.length);
  liveRadarStatus.accounts = {};
  liveRadarStatus.step = "Initializing Parallel Niche Radar";

  try {
    if (cleanSeed && targetSpecs.length === 0) {
      liveRadarStatus.step = `Discovering competitors similar to @${cleanSeed}`;
      liveRadarStatus.currentAccount = cleanSeed;
      const simRes = await runExtensionJob({ kind: "similar", username: cleanSeed }, 60000);
      if (simRes?.ok && Array.isArray(simRes.accounts)) {
        discoveredAccounts = simRes.accounts.filter((a) => !a.is_private);
        targetSpecs = [
          { platform: "instagram", username: cleanSeed, surface: "reels" },
          ...discoveredAccounts
            .slice(0, Math.max(1, Math.min(15, autoSimilarCount)))
            .map((a) => ({ platform: "instagram", username: a.username.toLowerCase(), surface: "reels" })),
        ];
      } else {
        targetSpecs = [{ platform: "instagram", username: cleanSeed, surface: "reels" }];
      }
    }

    targetSpecs = targetSpecs.slice(0, 16);
    if (!targetSpecs.length) {
      return { ok: false, message: "Paste at least one profile URL / @handle or enter a seed creator." };
    }

    liveRadarStatus.total = targetSpecs.length;
    for (const spec of targetSpecs) {
      liveRadarStatus.accounts[spec.username] = { status: "queued", platform: spec.platform };
    }

    const sinceMs = daysBack > 0 ? Date.now() - daysBack * 86400 * 1000 : null;
    const accountSummaries = new Array(targetSpecs.length);
    const mergedPosts = [];
    let totalSavedToDb = 0;

    // Parallel worker pool (scrapes up to 3 accounts simultaneously!)
    const maxWorkers = Math.max(1, Math.min(4, Number(concurrency) || 3, targetSpecs.length));
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= targetSpecs.length) break;
        const spec = targetSpecs[idx];
        const handle = spec.username;
        const plat = spec.platform || "instagram";

        liveRadarStatus.accounts[handle] = { status: "scanning", platform: plat };
        const activeHandles = Object.entries(liveRadarStatus.accounts)
          .filter(([, v]) => v.status === "scanning")
          .map(([k]) => `@${k}`);
        liveRadarStatus.currentAccount = activeHandles.join(", ");
        liveRadarStatus.step = `Scraping in parallel (${liveRadarStatus.completed}/${targetSpecs.length} done): ${activeHandles.join(" · ")}`;

        const resolvedRadarDepth =
          perAccountDepth === "all" || Number(perAccountDepth) >= 10000 || Number(perAccountDepth) === 0
            ? 10000
            : Math.max(12, Math.min(10000, parseInt(perAccountDepth, 10) || 36));
        const radarTimeoutMs = resolvedRadarDepth >= 10000 ? 1200000 : Math.max(240000, Math.ceil(resolvedRadarDepth / 12) * 5000 + 120000);

        let job;
        if (plat === "tiktok") {
          job = { kind: "tiktok", platform: "tiktok", username: handle, surface: "videos", sortBy: "outlier", depth: resolvedRadarDepth, parallel: true };
        } else if (plat === "youtube") {
          job = { kind: "youtube", platform: "youtube", username: handle, surface: spec.surface || "shorts", sortBy: "outlier", depth: resolvedRadarDepth, parallel: true };
        } else {
          job = {
            platform: "instagram",
            username: handle,
            surface: spec.surface || "reels",
            sortBy: "outlier",
            outlier: "on",
            depth: resolvedRadarDepth,
            parallel: true,
          };
        }

        let res;
        try {
          res = await runExtensionJob(job, radarTimeoutMs);
        } catch (err) {
          res = { ok: false, error: { message: err?.message || "Scan failed" } };
        }

        liveRadarStatus.completed += 1;

        if (!res?.ok) {
          liveRadarStatus.accounts[handle] = { status: "error", platform: plat, error: res?.error?.message || "Failed" };
          accountSummaries[idx] = {
            username: handle,
            platform: plat,
            ok: false,
            error: res?.error?.message || "Scan failed",
          };
          continue;
        }

        const rawRows = Array.isArray(res.rows) ? res.rows : [];
        const baseline = res.outlier?.baseline ?? null;
        const formatted = rawRows.map((r, rIdx) => {
          const item = formatPostSummary(r, rIdx, plat);
          item.username = item.username || handle;
          item.creatorBaseline = baseline;
          if (category && category !== "auto") {
            item.category = ensureCategoryExists(category);
          } else {
            item.category = inferCategory({ ...item, platform: plat, username: handle });
          }
          if (baseline && baseline > 0 && item.viewsPerHour != null && item.velocityScore == null) {
            item.velocityScore = Number(((item.viewsPerHour * 24) / baseline).toFixed(2));
          }
          return item;
        });

        // Permanently save ALL scraped posts into Master Posts DB (never lose data!)
        const savedNow = await upsertPostsToDb(formatted, {
          platform: plat,
          username: handle,
          category,
          creatorBaseline: baseline,
          source: "niche_radar",
        });
        totalSavedToDb += savedNow;

        const inWindow = sinceMs
          ? formatted.filter((p) => {
              const ms = p.createDate ? Date.parse(p.createDate) : NaN;
              return Number.isFinite(ms) ? ms >= sinceMs : true;
            })
          : formatted;

        liveRadarStatus.accounts[handle] = {
          status: "done",
          platform: plat,
          scannedCount: formatted.length,
        };

        accountSummaries[idx] = {
          username: handle,
          platform: plat,
          ok: true,
          scannedCount: formatted.length,
          inWindowCount: inWindow.length,
          baseline,
          topOutlier: inWindow[0]?.outlierScore ?? formatted[0]?.outlierScore ?? null,
        };

        mergedPosts.push(...inWindow);
      }
    };

    await Promise.all(Array.from({ length: maxWorkers }, () => worker()));

    mergedPosts.sort((a, b) => {
      if (sortBy === "velocity") {
        return ((b.velocityScore ?? b.viewsPerHour) || 0) - ((a.velocityScore ?? a.viewsPerHour) || 0);
      }
      if (sortBy === "views") {
        return (b.views || 0) - (a.views || 0);
      }
      return (b.outlierScore || 0) - (a.outlierScore || 0);
    });

    mergedPosts.forEach((p, i) => {
      p.rank = i + 1;
    });

    const radarRun = {
      id: "radar_" + Date.now(),
      createdAt: new Date().toISOString(),
      seedUsername: cleanSeed || targetSpecs[0]?.username || "",
      targets: targetSpecs.map((t) => t.username),
      daysBack,
      perAccountDepth,
      sortBy,
      totalCreatorsScanned: accountSummaries.filter((a) => a?.ok).length,
      totalPostsScrapedAndSaved: totalSavedToDb,
      totalPostsInWindow: mergedPosts.length,
      accountSummaries: accountSummaries.filter(Boolean),
      leaderboard: mergedPosts.slice(0, 200),
    };

    if (isPrimaryHub) {
      radarHistory.unshift(radarRun);
      if (radarHistory.length > 20) radarHistory.length = 20;
      await saveJson(RADAR_HISTORY_FILE, radarHistory);
      const topMissing = mergedPosts
        .filter((p) => p.platform === "instagram" && !p.caption)
        .slice(0, 12)
        .map((p) => p.shortcode || p.code)
        .filter(Boolean);
      if (topMissing.length) {
        hydrateMissingCaptionsBatch({ shortcodes: topMissing, platform: "instagram", limit: 12 }).catch(() => {});
      }
    }

    return { ok: true, ...radarRun };
  } finally {
    liveRadarStatus.running = false;
    liveRadarStatus.completed = liveRadarStatus.total;
    liveRadarStatus.step = "Idle";
    liveRadarStatus.currentAccount = "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// My Accounts Hub, Reproduction Matcher, Top-10 Priority, Smart CTA & 6h Cron
// ─────────────────────────────────────────────────────────────────────────────

function createDefaultMyAccountsStore() {
  const nowIso = new Date().toISOString();
  const nextIso = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
  return {
    activeAccountId: "pets_wade",
    accounts: [
      {
        id: "pets_wade",
        username: "k9americandog",
        aliases: ["k9wade"],
        displayName: "Wade Richter · @k9americandog",
        platform: "instagram",
        category: "Pets",
        localReelsDir: "/Users/victor/Work/AI AVATAR/Wade/Reels",
        localDescriptionsFile: "/Users/victor/Work/AI AVATAR/Wade/scripts/descriptions.py",
        competitors: [
          "farmerpaws",
          "furever_healthy",
          "the.pittie.rescue.dad",
          "lisa.goldengirl85",
          "marcu.sk9",
          "100pitties",
          "amos.beilerr",
          "happypuphacks",
          "sarge.and.the.squad",
          "miamidogdaddy",
        ],
        createdAt: nowIso,
      },
      {
        id: "health_odessa",
        username: "odessa.ageless",
        aliases: ["thebluezonetherapy"],
        displayName: "Odessa Whitfield · @odessa.ageless",
        platform: "instagram",
        category: "Health",
        localReelsDir: "/Users/victor/Work/AI AVATAR/Odessa/Reels",
        localDescriptionsFile: null,
        competitors: [
          "liangsvitality",
          "askoliviahealth",
          "wellnesseverydayhealth",
          "susan.healthy",
          "health.is.forever",
          "health.is.strength",
          "rooted.health.tips",
          "muscle40plus_",
          "mark.healthyliving",
        ],
        createdAt: nowIso,
      },
    ],
    manualReproduced: {},
    cron: {
      enabled: true,
      intervalHours: 6,
      ownDepth: 60,
      competitorDepth: 30,
      running: false,
      lastRunAt: null,
      nextRunAt: nextIso,
      lastSummary: null,
      lastError: null,
    },
  };
}

const myAccountsStore = (() => {
  const def = createDefaultMyAccountsStore();
  const loaded = loadJsonSync(MY_ACCOUNTS_FILE, null);
  if (!loaded || !Array.isArray(loaded.accounts) || !loaded.accounts.length) {
    return def;
  }
  return {
    activeAccountId: loaded.activeAccountId || def.activeAccountId,
    accounts: loaded.accounts,
    manualReproduced:
      loaded.manualReproduced && typeof loaded.manualReproduced === "object"
        ? loaded.manualReproduced
        : {},
    cron: {
      ...def.cron,
      ...(loaded.cron || {}),
      running: false,
    },
  };
})();

const MY_ACCOUNTS_STOPWORDS = new Set([
  "about", "after", "again", "against", "almost", "already", "also", "always",
  "americandogs", "among", "another", "around", "because", "before", "being",
  "between", "both", "could", "comment", "comments", "daily", "didn", "doesn",
  "doing", "dog", "dogs", "dogsofusa", "dogtraining", "dont", "down", "during",
  "each", "else", "even", "ever", "every", "everything", "first", "follow",
  "followed", "following", "food", "from", "germanshepherdsofinstagram", "give",
  "gives", "going", "good", "great", "habit", "habits", "happens", "have",
  "health", "healthy", "help", "helps", "here", "into", "just", "keep", "keeps",
  "know", "last", "later", "learn", "least", "like", "little", "live", "long",
  "longer", "look", "make", "makes", "many", "message", "messages", "might",
  "mine", "more", "morning", "most", "much", "must", "need", "never", "next",
  "night", "none", "only", "other", "over", "owner", "owners", "part", "people",
  "pet", "pets", "puppies", "puppy", "pupganicspartner", "quick", "really",
  "recipe", "recipes", "rescue", "rescuedogsofamerica", "right", "routine",
  "routines", "said", "same", "save", "send", "shelf", "shelter", "should",
  "showing", "shows", "signing", "simple", "simplepupganics", "since", "some",
  "something", "start", "starts", "stay", "still", "stop", "story", "strong",
  "such", "sure", "syntheticperformer", "take", "takes", "tell", "than", "that",
  "their", "them", "then", "there", "these", "they", "thing", "things", "think",
  "this", "those", "three", "time", "today", "together", "told", "took",
  "under", "until", "used", "using", "very", "video", "videos", "want", "wants",
  "watch", "week", "weeks", "well", "were", "what", "when", "where", "which",
  "while", "with", "without", "would", "year", "years", "your", "youre",
]);

function tokenizeTopicText(text) {
  const clean = String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/#[a-z0-9_]+/g, " ")
    .replace(/@[a-z0-9_.]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ");
  const tokens = new Set();
  for (const raw of clean.split(/\s+/)) {
    if (!raw || raw.length < 3 || /^\d+$/.test(raw)) continue;
    const stemmed = raw.endsWith("ies") && raw.length > 5
      ? raw.slice(0, -3) + "y"
      : raw.endsWith("s") && raw.length > 4 && !raw.endsWith("ss")
      ? raw.slice(0, -1)
      : raw;
    if (MY_ACCOUNTS_STOPWORDS.has(raw) || MY_ACCOUNTS_STOPWORDS.has(stemmed)) continue;
    tokens.add(stemmed);
  }
  return tokens;
}

function getPostTopicCorpus(post) {
  const code = post?.shortcode || post?.code || "";
  const tr = code ? transcriptCache[code] : null;
  const vh = code ? visualHooksCache[code] : null;
  const pack = code ? findPackForCode(code) : null;
  return [
    post?.caption || "",
    post?.spokenHook || "",
    post?.onScreenHook || "",
    tr?.hook || "",
    tr?.transcription || "",
    vh?.onScreenHookText || "",
    pack?.spokenHook || "",
    pack?.onScreenHook || "",
    pack?.transcript || "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function computeTopicSimilarity(tokensA, tokensB) {
  if (!tokensA || !tokensB || tokensA.size < 2 || tokensB.size < 2) return 0;
  let inter = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) inter += 1;
  }
  if (inter < 2) return 0;
  const dice = (2 * inter) / (tokensA.size + tokensB.size);
  const containment = inter / Math.min(tokensA.size, tokensB.size);
  return Number((dice * 0.55 + containment * 0.45).toFixed(3));
}

function parseDescriptionsPyMap(filePath) {
  const map = {};
  if (!filePath || !fs.existsSync(filePath)) return map;
  try {
    const src = fs.readFileSync(filePath, "utf8");
    const blockMatch = src.match(/REELS\s*=\s*\{([\s\S]*?)\n\}/);
    if (!blockMatch) return map;
    const entryRe = /"(\d{2})":\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = entryRe.exec(blockMatch[1])) !== null) {
      map[m[1]] = {
        keyword: m[2],
        product: m[3],
        ctaLine: m[4].replace(/\\"/g, '"'),
        hookLine: m[5].replace(/\\"/g, '"'),
      };
    }
  } catch (_) {}
  return map;
}

function scanLocalAvatarReels(account) {
  const dir = account?.localReelsDir;
  if (!dir || !fs.existsSync(dir)) return [];
  const descMap = parseDescriptionsPyMap(account.localDescriptionsFile);
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((d) => /^\d{2}_/.test(d)).sort();
  } catch (_) {
    return [];
  }

  const out = [];
  for (const folderName of entries) {
    const num = folderName.slice(0, 2);
    const slug = folderName.slice(3).replace(/-/g, " ");
    const fullDir = path.join(dir, folderName);
    let combinedText = "";
    let keyword = descMap[num]?.keyword || "";
    let product = descMap[num]?.product || "";
    let hook = descMap[num]?.hookLine || "";

    for (const fname of ["notes.md", "description.md", "script.txt"]) {
      const fpath = path.join(fullDir, fname);
      if (fs.existsSync(fpath)) {
        try {
          const txt = fs.readFileSync(fpath, "utf8");
          combinedText += "\n" + txt;
          if (!keyword) {
            const kwMatch = txt.match(/Mot-clé\s+\*\*([A-Z0-9_]+)\*\*|Mot-clé CTA[^`]*`([A-Z0-9_]+)`|Comment\s+"?([A-Z0-9_]{3,16})"?/);
            if (kwMatch) keyword = kwMatch[1] || kwMatch[2] || kwMatch[3] || "";
          }
          if (!product) {
            const prodMatch = txt.match(/produit\s+\*\*([^*]+)\*\*/i);
            if (prodMatch) product = prodMatch[1].trim();
          }
          if (!hook && fname === "notes.md") {
            const s1Match = txt.match(/\*\*S1[^:]*\*\*\s*:\s*"([^"]+)"/);
            if (s1Match) hook = s1Match[1].trim();
          }
        } catch (_) {}
      }
    }

    const codeSet = new Set();
    for (const m of combinedText.matchAll(/(?:reel\/|p\/|ig_)([A-Za-z0-9_-]{8,14})/g)) {
      codeSet.add(m[1]);
    }
    // Filter out own published shortcodes if any, keeping competitor source refs
    const sourceShortcodes = Array.from(codeSet);
    const topicText = `${slug} ${hook} ${combinedText.slice(0, 1400)}`;
    const tokens = tokenizeTopicText(topicText);

    out.push({
      reelNumber: num,
      folderName,
      slug,
      keyword: keyword || null,
      product: product || null,
      hook: hook || slug,
      sourceShortcodes,
      tokens,
    });
  }
  return out;
}

function getAllHandlesForAccount(account) {
  const handles = new Set();
  if (account?.username) handles.add(String(account.username).replace(/^@/, "").toLowerCase());
  for (const a of account?.aliases || []) {
    if (a) handles.add(String(a).replace(/^@/, "").toLowerCase());
  }
  return handles;
}

function enrichPostRowForAccounts(entry) {
  const code = entry.shortcode || entry.code || "";
  const pack = findPackForCode(code);
  const tr = code ? transcriptCache[code] : null;
  const vh = code ? visualHooksCache[code] : null;
  const localThumb = pack ? `/api/reproduce/asset/${pack.packId}/thumbnail.jpg` : null;
  const views = entry.views ?? null;
  const comments = entry.comments ?? null;
  const commentRate = views && views > 0 && comments != null ? Number(((comments / views) * 100).toFixed(2)) : null;
  return {
    ...entry,
    code,
    shortcode: code,
    category: entry.category || inferCategory(entry),
    caption: entry.caption || pack?.caption || "",
    spokenHook: tr?.hook || pack?.spokenHook || "",
    onScreenHook: vh?.onScreenHookText || pack?.onScreenHook || "",
    hasTranscript: !!(tr?.transcription || pack?.transcript),
    transcriptPreview: (tr?.transcription || pack?.transcript || "").slice(0, 260),
    commentRate,
    thumbnailUrl: localThumb || entry.thumbnailUrl || null,
    isSaved: isCodeSaved(code),
    reproducePackId: pack ? pack.packId : null,
    reproduceZipUrl: pack ? pack.zipUrl : null,
  };
}

function buildCtaRecommendation(post, account) {
  const corpus = getPostTopicCorpus(post);
  const isHealth = String(account?.category || "").toLowerCase() === "health" || account?.id === "health_odessa";

  if (isHealth) {
    const isRecipe = /\b(lentil|chickpea|chia|flax|potato|avocado|beet|bake|oven|blender|simmer|boil|mash|flour|wraps?|bread|mousse|cake|recipe)\b/i.test(corpus);
    const isMetabolic = /\b(sugar|glucose|insulin|carb|craving|weight|metabolism|fasting|berberine|a1c)\b/i.test(corpus);
    const kw = isRecipe ? "RECIPE" : isMetabolic ? "BALANCE" : "GUT";
    let recommendedCtaType = "manychat_value";
    let whyAngle = "High-save health/recipe format: deliver pure recipe value in ManyChat first, then qualify for Physician's Choice.";
    if (isMetabolic) {
      recommendedCtaType = "rootation";
      whyAngle = "Blood-sugar & cravings topic matches Rootation Berberine Gummies.";
    } else if (!isRecipe && /\b(gut|bloat|digestion|constipation|stool|probiotic|enzyme|stomach)\b/i.test(corpus)) {
      recommendedCtaType = "pc_growth_dm";
      whyAngle = "Gut & digestion topic maps straight to Physician's Choice Growth DM (no product shown in video, 35% commission).";
    }

    const variants = {
      manychat_value: {
        key: "manychat_value",
        label: "ManyChat Value",
        productName: isRecipe ? "Step-by-Step Recipe + Routine" : "Loma Linda Daily Gut Routine",
        keyword: isRecipe ? "RECIPE" : "HABITS",
        why: "Pure value DM builds high comment velocity & follower conversions before soft Setter follow-up.",
        transitionLine: isRecipe
          ? "It takes just a few pantry ingredients and leaves your stomach feeling light instead of weighed down."
          : "Your digestion doesn't need extreme restriction at our age, just a steady daily rhythm.",
        ctaLine: isRecipe
          ? `Comment RECIPE and I'll send the exact step-by-step measurements to your messages. Follow me first so it goes through. Stay strong, stay golden.`
          : `Comment HABITS and I'll send my morning routine straight to your messages. Follow me first so it reaches you. Stay strong, stay golden.`,
      },
      pc_growth_dm: {
        key: "pc_growth_dm",
        label: "PC Growth DM (35%)",
        productName: "Physician's Choice Growth DM Link",
        keyword: kw === "RECIPE" ? "SECRET" : kw,
        why: "Growth DM keeps the video 100% educational (no bottle shown) and drops the tracked link inside DMs.",
        transitionLine: "Real food lays the foundation, and supporting your gut lining every morning is what makes the difference stick.",
        ctaLine: `Comment ${kw === "RECIPE" ? "SECRET" : kw} and I'll send you the exact gut support I pair with my morning routine. Follow me first so it reaches your messages. Stay strong, stay golden.`,
      },
      pc_shop: {
        key: "pc_shop",
        label: "PC Shop Voie 1",
        productName: "Physician's Choice Gut Bundle",
        keyword: "HELP",
        why: "Direct Shop CTA for buyer-intent audiences (remember to show bottle >= 3s and use #simplepc only).",
        transitionLine: "When real food still leaves you sluggish after meals, giving your stomach targeted probiotics and enzymes helps break it down.",
        ctaLine: `You can get Physician's Choice Advanced Gut Health Bundle on Amazon, or comment HELP and I'll DM you. Stay strong, stay golden.`,
      },
      rootation: {
        key: "rootation",
        label: "Rootation Berberine",
        productName: "Rootation Berberine Gummies",
        keyword: "BALANCE",
        why: "Strong angle for after-meal energy, cravings, and steady daily balance.",
        transitionLine: "Pairing whole foods with the right morning support keeps afternoon energy steady without the crash.",
        ctaLine: `Comment BALANCE and I'll send you the exact daily gummies I keep on my counter. Follow me first so it reaches your messages. Stay strong, stay golden.`,
      },
      listicle: {
        key: "listicle",
        label: "Listicle / Guide",
        productName: "Blue Zone Shopping Listicle",
        keyword: "LIST",
        why: "Ideal when the post compares 3–7 items or grocery swaps; sends a clean checklist link in DM.",
        transitionLine: "You don't need twenty expensive bottles to feel strong after sixty, just the right five staples.",
        ctaLine: `Comment LIST and I'll send my complete Loma Linda grocery and supplement checklist to your messages. Stay strong, stay golden.`,
      },
    };
    return {
      recommendedCtaType,
      whyAngle,
      ...variants[recommendedCtaType],
      variants,
    };
  }

  // Pets (@k9americandog — Wade Richter)
  const isWetToothbrush = /\btoothbrush\b/i.test(corpus) && /\b(mother|mama|calm|stroke|anxious)\b/i.test(corpus);
  const isDental = !isWetToothbrush && /\b(breath|teeth|tooth|tartar|plaque|gum|gums|gumline|dental|fish\s*breath|bad\s*breath|stinky\s*mouth)\b/i.test(corpus);
  const isDashFood = /\b(kibble|dry\s*food|commercial\s*dog|ultra.?processed|fresh\s*food|human\s*grade|table\s*grade|raw\s*food|picky\s*eater|recall|real\s*meat)\b/i.test(corpus);
  const isListicle = /\b([3-9]|10)\s+(things|foods|mistakes|hacks|signs|habits|secrets|products|supplements)\b/i.test(corpus) || /\b(walmart|petco|petsmart|aisle|stop\s*buying)\b/i.test(corpus);
  const isRecipe = /\b(bake|oven|blender|simmer|boil|mash|flour|oats|peanut\s*butter|pumpkin|sweet\s*potato|bone\s*broth|broccoli|carrot|liver|treats?|recipe)\b/i.test(corpus);
  const isBondingOrBehavior = /\b(bed|heart\s*breaks|circle\s*before|sniff|ear\s*massage|wet\s*toothbrush|calm|anxious|anxiety|fireworks|storm|barking|yell|leash|potty|chosen|god|goodbye|forget)\b/i.test(corpus);

  // Pick specific Wade Zernio keyword matching topic
  let mvKeyword = "CHEW";
  if (/\b(paw|paws|licking|pads|toes|epsom|rusty)\b/i.test(corpus)) mvKeyword = "PAWS";
  else if (/\b(ear|ears|gunk|wax|scratching\s*ear)\b/i.test(corpus)) mvKeyword = "EARS";
  else if (/\b(gut|gas|fart|stomach|foam|vomit|diarrhea|poop|stool|pumpkin)\b/i.test(corpus)) mvKeyword = "GUT";
  else if (/\b(coat|shedding|itch|itchy|skin|flaky|dandruff|shiny)\b/i.test(corpus)) mvKeyword = "COAT";
  else if (/\b(joint|joints|hip|hips|limp|arthritis|stiff|stairs|sit\s*like)\b/i.test(corpus)) mvKeyword = "JOINTS";

  let valueKeyword = "HABITS";
  if (isRecipe) valueKeyword = "RECIPE";
  else if (isWetToothbrush) valueKeyword = "BRUSH";
  else if (/\bsniff\b/i.test(corpus)) valueKeyword = "SNIFF";
  else if (/\b(bark|barking|yell)\b/i.test(corpus)) valueKeyword = "QUIET";
  else if (/\b(potty|pee|crate|house\s*train)\b/i.test(corpus)) valueKeyword = "POTTY";
  else if (/\b(calm|anxious|panic|thumb|firework|thunder|alone)\b/i.test(corpus)) valueKeyword = "CALM";

  let recommendedCtaType = "multivitamin";
  let whyAngle = corpus
    ? "Internal wellness / longevity / symptom video: bridges naturally to Pupganics Daily Soft Chews to cover the gaps in his bowl."
    : "Caption/transcript not yet fetched: default high-converting Multivitamin soft chew angle (click Reproduce .zip to lock exact topic).";

  if (isDental) {
    recommendedCtaType = "dental";
    whyAngle = "Oral hygiene / bad breath / tartar hook -> highest conversion on Pupganics ProSmile Dental Powder (BREATH).";
  } else if (isDashFood && !isListicle) {
    recommendedCtaType = "dash";
    whyAngle = "Kibble critique / fresh nutrition angle -> ideal bridge to DASH gently cooked fresh dog food (-50% custom box).";
  } else if (isListicle && !isDental) {
    recommendedCtaType = "listicle";
    whyAngle = "Multi-item / store-aisle format -> send Wade's comparison Listicle so viewers see every approved pick in one page.";
  } else if (isRecipe) {
    recommendedCtaType = "manychat_value";
    whyAngle = "True homemade recipe -> deliver real kitchen value with RECIPE first, then qualify dog's age in Zernio Setter.";
  } else if (isBondingOrBehavior && !/\b(paw|ear|gut|coat|joint|allerg|shed)\b/i.test(corpus)) {
    recommendedCtaType = "manychat_value";
    whyAngle = `High-share emotional/behavior/care hook -> don't hard-pitch; use ManyChat value (${valueKeyword}) to maximize shares & Setter DMs.`;
  } else if (mvKeyword !== "CHEW") {
    recommendedCtaType = "multivitamin";
    whyAngle = `Targeted symptom (${mvKeyword}) -> wipe/soak only hits the surface, while Pupganics Daily Soft Chews help cover the gaps inside his bowl.`;
  }

  const variants = {
    multivitamin: {
      key: "multivitamin",
      label: "Multivitamin",
      productName: "Pupganics Daily Soft Chews",
      keyword: mvKeyword,
      funnelType: mvKeyword === "CHEW" ? "chew" : "habits",
      why: "Covers internal nutritional gaps (gut, skin, coat, hips, allergy/paw licking) with benefit-first storytelling.",
      transitionLine: "Treating the outside helps for a day, but when this keeps coming back every month, it usually starts inside his bowl.",
      ctaLine: `Comment ${mvKeyword} and I'll send you the daily chew I give my own dogs at the shelter to help cover the gaps in their bowl. Follow me first so it reaches your messages. Wade, signing out.`,
    },
    dental: {
      key: "dental",
      label: "Dental Powder",
      productName: "Pupganics ProSmile Dental Powder",
      keyword: "BREATH",
      funnelType: "dental",
      why: "No-brush, 10-second scoop angle for dog breath, yellow tartar, and gumline hygiene.",
      transitionLine: "Brushing alone misses what sits under the gumline, and most dental chews are gone in ten seconds flat.",
      ctaLine: "Comment BREATH and I'll send you the exact dental powder I scoop into my dogs' food every morning. Follow me first so it reaches your messages. Wade, signing out.",
    },
    dash: {
      key: "dash",
      label: "Dash Dog Food",
      productName: "DASH Fresh Dog Food (-50% Box)",
      keyword: "DASH",
      funnelType: "dash",
      why: "Best for kibble comparisons, longevity nutrition, picky eaters, and cooked vs ultra-processed food.",
      transitionLine: "Most store kibble gets cooked so hot the real nutrition is cooked right out of it before it ever hits his bowl.",
      ctaLine: "If you don't have time to cook fresh meals every night, comment DASH and I'll send you the real-food plan I trust with 50% off your dog's first box. Follow me first so it reaches your messages. Wade, signing out.",
    },
    listicle: {
      key: "listicle",
      label: "Listicle Page",
      productName: "Wade's Shelter Top-Picks Listicle",
      keyword: "LIST",
      funnelType: "habits",
      why: "Best when a video lists 3–7 fixes, store swaps, or multiple symptoms — sends a presell listicle comparing Multivitamin, Dental Powder & DASH.",
      transitionLine: "You don't need a whole cart of pricey pet-store bottles when the right two or three daily basics do the heavy lifting.",
      ctaLine: "Comment LIST and I'll send you my full shelter checklist with the exact toppers, dental scoop, and daily chews I actually use. Follow me first so it reaches your messages. Wade, signing out.",
    },
    manychat_value: {
      key: "manychat_value",
      label: "ManyChat Value",
      productName: valueKeyword === "RECIPE" ? "3 Homemade Bowl Recipes (Growth DM)" : "7 Daily Shelter Habits (Growth DM)",
      keyword: valueKeyword,
      funnelType: valueKeyword === "RECIPE" ? "recipes" : "habits",
      why: valueKeyword === "RECIPE"
        ? "RECIPE rule respected: pure homemade recipe video sends real recipe + triggers Zernio age-qualification Setter."
        : `No hard pitch on viral growth hooks: sends ${valueKeyword} value guide via ManyChat/Zernio so viewers comment, save & enter DM funnel.`,
      transitionLine: valueKeyword === "RECIPE"
        ? "It takes ten minutes in your own kitchen and gives your dog real nutrients you can actually pronounce."
        : "Small daily routines like this build real calm and add healthier years without spending a fortune.",
      ctaLine: valueKeyword === "RECIPE"
        ? "Comment RECIPE and I'll send you the exact measurements plus the three bowl toppers I rotate every week. Follow me first so it reaches your messages. Wade, signing out."
        : `Comment ${valueKeyword} and I'll send you the daily routine we use at my shelter to keep our dogs calm and healthy. Follow me first so it reaches your messages. Wade, signing out.`,
    },
  };

  return {
    recommendedCtaType,
    whyAngle,
    ...variants[recommendedCtaType],
    variants,
  };
}

function analyzeAccountData(account, options = {}) {
  const handles = getAllHandlesForAccount(account);
  const compSet = new Set((account.competitors || []).map((c) => String(c || "").replace(/^@/, "").toLowerCase()));
  const localReels = scanLocalAvatarReels(account);

  const allEnriched = Object.values(postsDb)
    .filter((p) => (p.platform || "instagram") === (account.platform || "instagram"))
    .map(enrichPostRowForAccounts);

  const ownPosts = [];
  const competitorPosts = [];

  for (const p of allEnriched) {
    const u = String(p.username || "").replace(/^@/, "").toLowerCase();
    if (handles.has(u)) {
      ownPosts.push(p);
    } else if (compSet.has(u) || (!u && (p.category || "").toLowerCase() === (account.category || "").toLowerCase())) {
      competitorPosts.push(p);
    }
  }

  ownPosts.sort((a, b) => ((b.outlierScore ?? b.views) || 0) - ((a.outlierScore ?? a.views) || 0));

  // Build token sets
  const ownTokenMap = new Map();
  for (const op of ownPosts) {
    ownTokenMap.set(op.code, tokenizeTopicText(getPostTopicCorpus(op)));
  }
  const compTokenMap = new Map();
  const primaryTokenFreq = new Map();
  for (const cp of competitorPosts) {
    const toks = tokenizeTopicText(getPostTopicCorpus(cp));
    compTokenMap.set(cp.code, toks);
    if ((cp.outlierScore || 0) >= 2.0) {
      for (const t of toks) {
        if (!primaryTokenFreq.has(t)) primaryTokenFreq.set(t, new Set());
        primaryTokenFreq.get(t).add((cp.username || "").toLowerCase());
      }
    }
  }

  // Match each localReel to ownPosts (is it actually published on @k9americandog?)
  const localMatchToOwn = new Map();
  for (const lr of localReels) {
    let bestOwn = null;
    let bestSim = 0;
    for (const op of ownPosts) {
      const sim = computeTopicSimilarity(lr.tokens, ownTokenMap.get(op.code));
      if (sim >= 0.34 && sim > bestSim) {
        bestSim = sim;
        bestOwn = op;
      }
    }
    if (bestOwn) localMatchToOwn.set(lr.folderName, { ownPost: bestOwn, similarity: bestSim });
  }

  const localBySourceCode = new Map();
  for (const lr of localReels) {
    for (const sc of lr.sourceShortcodes) {
      localBySourceCode.set(sc, lr);
    }
  }

  const manualMap = myAccountsStore.manualReproduced || {};
  const reproducedComparisons = [];
  const compStatusMap = new Map();

  for (const cp of competitorPosts) {
    const manual = manualMap[cp.code];
    if (manual?.status === "ignored") {
      compStatusMap.set(cp.code, { status: "ignored" });
      continue;
    }

    const explicitLocal = localBySourceCode.get(cp.code) || null;
    let matchedLocal = explicitLocal;
    let localSim = explicitLocal ? 1.0 : 0;

    if (!matchedLocal && compTokenMap.get(cp.code).size >= 3) {
      for (const lr of localReels) {
        const sim = computeTopicSimilarity(compTokenMap.get(cp.code), lr.tokens);
        if (sim >= 0.4 && sim > localSim) {
          localSim = sim;
          matchedLocal = lr;
        }
      }
    }

    let matchedOwn = null;
    let ownSim = 0;
    if (manual?.status === "published") {
      matchedOwn = ownPosts.find((o) => o.code === manual.ownCode) || {
        code: manual.ownCode || "manual",
        username: account.username,
        caption: manual.note || "Marked as published on @" + account.username,
        manual: true,
      };
      ownSim = 1.0;
    } else {
      for (const op of ownPosts) {
        const sim = computeTopicSimilarity(compTokenMap.get(cp.code), ownTokenMap.get(op.code));
        if (sim >= 0.32 && sim > ownSim) {
          ownSim = sim;
          matchedOwn = op;
        }
      }
      if (!matchedOwn && matchedLocal && localMatchToOwn.has(matchedLocal.folderName)) {
        const bridge = localMatchToOwn.get(matchedLocal.folderName);
        matchedOwn = bridge.ownPost;
        ownSim = bridge.similarity;
      }
    }

    if (matchedOwn) {
      const info = {
        status: "published_on_ig",
        ownPost: matchedOwn,
        localReel: matchedLocal,
        similarity: ownSim,
      };
      compStatusMap.set(cp.code, info);
      reproducedComparisons.push({
        status: "published_on_ig",
        similarity: ownSim,
        ownPost: matchedOwn,
        localReel: matchedLocal,
        competitorPost: cp,
        viewsRatio:
          matchedOwn.views != null && cp.views > 0
            ? Number((matchedOwn.views / cp.views).toFixed(2))
            : null,
      });
    } else if (matchedLocal) {
      const info = {
        status: "local_draft_only",
        localReel: matchedLocal,
        similarity: localSim,
      };
      compStatusMap.set(cp.code, info);
      reproducedComparisons.push({
        status: "local_draft_only",
        similarity: localSim,
        ownPost: null,
        localReel: matchedLocal,
        competitorPost: cp,
        viewsRatio: null,
      });
    }
  }

  // Also include ownPosts that didn't match a competitor post in DB yet (so Victor still sees his reproduced hits compared to niche median/top)
  const usedOwnCodes = new Set(reproducedComparisons.map((r) => r.ownPost?.code).filter(Boolean));
  for (const op of ownPosts.slice(0, 20)) {
    if (usedOwnCodes.has(op.code)) continue;
    reproducedComparisons.push({
      status: "published_on_ig",
      similarity: null,
      ownPost: op,
      localReel: localReels.find((lr) => localMatchToOwn.get(lr.folderName)?.ownPost?.code === op.code) || null,
      competitorPost: null,
      viewsRatio: null,
    });
  }

  reproducedComparisons.sort((a, b) => {
    const aOrder = a.status === "published_on_ig" ? 0 : 1;
    const bOrder = b.status === "published_on_ig" ? 0 : 1;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return (b.competitorPost?.outlierScore || b.ownPost?.outlierScore || 0) - (a.competitorPost?.outlierScore || a.ownPost?.outlierScore || 0);
  });

  // Top 10 Priority Recommendations
  const excludeLocalDrafts = Boolean(options.excludeLocalDrafts);
  const candidates = [];

  for (const cp of competitorPosts) {
    const st = compStatusMap.get(cp.code);
    if (st?.status === "published_on_ig" || st?.status === "ignored") continue;
    if (excludeLocalDrafts && st?.status === "local_draft_only") continue;

    const outScore = cp.outlierScore ?? 1;
    const outlierPts = Math.min(45, Math.log2(Math.max(1, outScore) + 1) * 10.5);

    const ageDays = cp.ageHours != null ? cp.ageHours / 24 : 60;
    const velBase = cp.velocityScore != null ? cp.velocityScore : cp.viewsPerHour != null ? cp.viewsPerHour / 250 : 0;
    const freshnessBoost = ageDays <= 14 ? 8 : ageDays <= 30 ? 4 : 0;
    const velocityPts = Math.min(25, Math.log2(Math.max(0, velBase) + 1) * 6 + freshnessBoost);

    const toks = compTokenMap.get(cp.code) || new Set();
    let maxCreatorBreadth = 1;
    for (const t of toks) {
      const freq = primaryTokenFreq.get(t)?.size || 1;
      if (freq > maxCreatorBreadth) maxCreatorBreadth = freq;
    }
    const crossCreatorPts = maxCreatorBreadth >= 3 ? 15 : maxCreatorBreadth === 2 ? 8 : 0;
    const commentRatePts = cp.commentRate != null ? Math.min(15, cp.commentRate * 8) : 0;

    let priorityScore = Number(Math.min(100, outlierPts + velocityPts + crossCreatorPts + commentRatePts).toFixed(1));
    if (st?.status === "local_draft_only") {
      // Slightly deprioritize already-prepared drafts compared to untouched breakouts when mixed
      priorityScore = Number(Math.max(1, priorityScore - 6).toFixed(1));
    }

    const reasons = [];
    if (cp.outlierScore != null) reasons.push(`${cp.outlierScore.toFixed(1)}x Outlier`);
    if (cp.viewsPerHour != null && cp.viewsPerHour >= 100) reasons.push(`${Math.round(cp.viewsPerHour).toLocaleString()} views/h`);
    if (maxCreatorBreadth >= 2) reasons.push(`${maxCreatorBreadth}x Competitor Proof`);
    if (cp.commentRate != null && cp.commentRate >= 0.4) reasons.push(`${cp.commentRate}% Comment/View`);
    if (ageDays <= 14) reasons.push(`Fresh (${Math.max(1, Math.round(ageDays))}d)`);

    const topicSig = Array.from(toks).slice(0, 4).sort().join("|") || cp.code;

    candidates.push({
      ...cp,
      priorityScore,
      priorityReasons: reasons,
      reproStatus: st?.status || "unreproduced",
      localDraft: st?.status === "local_draft_only" ? st.localReel : null,
      topicSig,
      cta: buildCtaRecommendation(cp, account),
    });
  }

  candidates.sort((a, b) => b.priorityScore - a.priorityScore || (b.outlierScore || 0) - (a.outlierScore || 0));

  // Deduplicate near-identical topic signatures (keep max 2 per signature unless needed to fill 10)
  const priorityTop10 = [];
  const overflow = [];
  const sigCounts = new Map();
  for (const item of candidates) {
    const cnt = sigCounts.get(item.topicSig) || 0;
    if (item.topicSig === item.code || cnt < 2) {
      sigCounts.set(item.topicSig, cnt + 1);
      if (priorityTop10.length < 10) priorityTop10.push(item);
    } else {
      overflow.push(item);
    }
  }
  while (priorityTop10.length < 10 && overflow.length) {
    priorityTop10.push(overflow.shift());
  }
  priorityTop10.forEach((p, idx) => {
    p.priorityRank = idx + 1;
  });

  // Per-competitor summary stats
  const competitorStatusList = (account.competitors || []).map((handle) => {
    const clean = String(handle || "").replace(/^@/, "").toLowerCase();
    const list = competitorPosts.filter((p) => (p.username || "").toLowerCase() === clean);
    const topOut = list.reduce((mx, p) => Math.max(mx, p.outlierScore || 0), 0);
    const lastScrapedAt = list.reduce((latest, p) => (String(p.lastScrapedAt || "") > latest ? p.lastScrapedAt : latest), "");
    return {
      username: clean,
      postsCount: list.length,
      peakOutlier: topOut > 0 ? Number(topOut.toFixed(1)) : null,
      lastScrapedAt: lastScrapedAt || null,
      needsFirstScan: list.length === 0,
    };
  });

  // KPI metrics
  const viewNums = ownPosts.map((p) => p.views).filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
  const medianViews = viewNums.length ? viewNums[Math.floor(viewNums.length / 2)] : null;
  const peakOwnOutlier = ownPosts.reduce((mx, p) => Math.max(mx, p.outlierScore || 0), 0);
  const publishedMatchCount = Array.from(compStatusMap.values()).filter((s) => s.status === "published_on_ig").length;
  const localDraftMatchCount = Array.from(compStatusMap.values()).filter((s) => s.status === "local_draft_only").length;
  const recent7dBreakouts = competitorPosts.filter(
    (p) => (p.outlierScore || 0) >= 2.0 && p.ageHours != null && p.ageHours <= 7 * 24
  ).length;

  return {
    ok: true,
    account,
    accounts: myAccountsStore.accounts,
    activeAccountId: myAccountsStore.activeAccountId,
    kpis: {
      ownPublishedCount: ownPosts.length,
      localReelsCount: localReels.length,
      ownMedianViews: medianViews,
      ownPeakOutlier: peakOwnOutlier > 0 ? Number(peakOwnOutlier.toFixed(1)) : null,
      reproducedPublishedCount: publishedMatchCount,
      reproducedLocalDraftCount: localDraftMatchCount,
      trackedCompetitorsCount: competitorStatusList.length,
      competitorPostsCount: competitorPosts.length,
      recent7dBreakouts,
    },
    ownPosts,
    localReels: localReels.map((lr) => ({
      reelNumber: lr.reelNumber,
      folderName: lr.folderName,
      slug: lr.slug,
      keyword: lr.keyword,
      product: lr.product,
      hook: lr.hook,
      sourceShortcodes: lr.sourceShortcodes,
      publishedMatch: localMatchToOwn.get(lr.folderName)?.ownPost?.code || null,
    })),
    reproducedComparisons: reproducedComparisons.slice(0, 60),
    priorityTop10,
    competitorStatusList,
    cron: myAccountsStore.cron,
  };
}

let lastAutoAccountHydrateAt = 0;
function schedulePriorityCaptionsHydration(priorityTop10 = []) {
  if (!isExtensionConnected()) return;
  if (Date.now() - lastAutoAccountHydrateAt < 30000) return;
  const missing = priorityTop10
    .filter((p) => p.platform === "instagram" && !p.caption && !p.captionChecked)
    .slice(0, 10)
    .map((p) => p.code)
    .filter(Boolean);
  if (missing.length) {
    lastAutoAccountHydrateAt = Date.now();
    hydrateMissingCaptionsBatch({ shortcodes: missing, platform: "instagram", limit: 10 }).catch(() => {});
  }
}

async function runMyAccountsCronSync({
  accountId = myAccountsStore.activeAccountId,
  scope = "all",
  depthOwn = myAccountsStore.cron.ownDepth || 60,
  depthCompetitors = myAccountsStore.cron.competitorDepth || 30,
  onlyHandles = null,
} = {}) {
  const account =
    myAccountsStore.accounts.find((a) => a.id === accountId) || myAccountsStore.accounts[0];
  if (!account) return { ok: false, message: "No account configured." };
  if (myAccountsStore.cron.running) {
    return { ok: false, message: "A Cron sync is already running.", busy: true };
  }
  if (!isExtensionConnected()) {
    return { ok: false, message: "Chrome extension is not connected." };
  }

  myAccountsStore.cron.running = true;
  myAccountsStore.cron.lastError = null;
  const startedAt = Date.now();

  try {
    let accountsToScan = [];
    if (Array.isArray(onlyHandles) && onlyHandles.length) {
      accountsToScan = onlyHandles.map((h) => String(h).replace(/^@/, "").trim()).filter(Boolean);
    } else if (scope === "own") {
      accountsToScan = [account.username];
    } else if (scope === "competitors") {
      accountsToScan = [...(account.competitors || [])];
    } else {
      accountsToScan = [account.username, ...(account.competitors || [])];
    }

    let ownPostsAdded = 0;
    let compPostsAdded = 0;

    // 1. Scan owned account directly if included so depthOwn applies
    if (accountsToScan.includes(account.username) && (scope === "own" || scope === "all") && !onlyHandles?.length) {
      const ownRes = await runExtensionJob(
        {
          platform: "instagram",
          username: account.username.toLowerCase(),
          surface: "reels",
          sortBy: "outlier",
          outlier: "on",
          depth: Math.max(12, Math.min(1000, Number(depthOwn) || 60)),
        },
        300000
      );
      if (ownRes?.ok && Array.isArray(ownRes.rows)) {
        const baseline = ownRes.outlier?.baseline ?? null;
        const formatted = ownRes.rows.map((r, i) => {
          const item = formatPostSummary(r, i, "instagram");
          item.username = item.username || account.username.toLowerCase();
          item.creatorBaseline = baseline;
          item.category = account.category;
          return item;
        });
        ownPostsAdded = await upsertPostsToDb(formatted, {
          platform: "instagram",
          username: account.username.toLowerCase(),
          category: account.category,
          creatorBaseline: baseline,
          source: "my_accounts_cron",
        });
      }
      accountsToScan = accountsToScan.filter((u) => u.toLowerCase() !== account.username.toLowerCase());
    }

    // 2. Parallel scrape competitors via runNicheRadar
    let radarRes = null;
    if (accountsToScan.length > 0) {
      radarRes = await runNicheRadar({
        accounts: accountsToScan,
        daysBack: 0,
        perAccountDepth: Math.max(12, Math.min(250, Number(depthCompetitors) || 30)),
        sortBy: "outlier",
        category: account.category,
        concurrency: 3,
      });
      compPostsAdded = radarRes?.totalPostsScrapedAndSaved || 0;
    }

    // 3. Recompute priority recommendations and hydrate captions for Top 10
    const analysis = analyzeAccountData(account);
    const missingTopCodes = analysis.priorityTop10
      .filter((p) => p.platform === "instagram" && !p.caption)
      .map((p) => p.code)
      .filter(Boolean);
    if (missingTopCodes.length) {
      await hydrateMissingCaptionsBatch({ shortcodes: missingTopCodes, platform: "instagram", limit: 10 }).catch(() => {});
    }

    const updatedAnalysis = analyzeAccountData(account);
    const intervalHrs = Math.max(1, Number(myAccountsStore.cron.intervalHours) || 6);
    myAccountsStore.cron.lastRunAt = new Date().toISOString();
    myAccountsStore.cron.nextRunAt = new Date(Date.now() + intervalHrs * 3600 * 1000).toISOString();
    myAccountsStore.cron.lastSummary = {
      accountId: account.id,
      scope,
      ownPostsAdded,
      compPostsAdded,
      durationMs: Date.now() - startedAt,
      finishedAt: myAccountsStore.cron.lastRunAt,
    };
    await saveJson(MY_ACCOUNTS_FILE, myAccountsStore);

    return { ok: true, summary: myAccountsStore.cron.lastSummary, data: updatedAnalysis };
  } catch (err) {
    myAccountsStore.cron.lastError = err?.message || String(err);
    await saveJson(MY_ACCOUNTS_FILE, myAccountsStore);
    return { ok: false, message: myAccountsStore.cron.lastError };
  } finally {
    myAccountsStore.cron.running = false;
  }
}

async function handleMyAccountsConfigAction(body = {}) {
  const action = String(body.action || "").trim();
  const targetId = body.accountId || myAccountsStore.activeAccountId;
  const account = myAccountsStore.accounts.find((a) => a.id === targetId);

  if (action === "setActiveAccount" && account) {
    myAccountsStore.activeAccountId = account.id;
  } else if (action === "addAccount") {
    const cleanUser = String(body.username || "").replace(/^@/, "").trim().toLowerCase();
    if (!cleanUser) return { ok: false, message: "Missing Instagram username." };
    const id = `${String(body.category || "custom").toLowerCase().replace(/[^a-z0-9]/g, "")}_${cleanUser}`;
    if (!myAccountsStore.accounts.some((a) => a.id === id)) {
      const comps = String(body.competitors || "")
        .split(/[\s,;\n]+/)
        .map((c) => c.replace(/^@/, "").trim().toLowerCase())
        .filter(Boolean);
      myAccountsStore.accounts.push({
        id,
        username: cleanUser,
        aliases: [],
        displayName: body.displayName || `@${cleanUser}`,
        platform: "instagram",
        category: ensureCategoryExists(body.category || "Pets"),
        localReelsDir: null,
        localDescriptionsFile: null,
        competitors: comps,
        createdAt: new Date().toISOString(),
      });
    }
    myAccountsStore.activeAccountId = id;
  } else if (action === "addCompetitor" && account) {
    const raw = String(body.competitor || "");
    const parts = raw
      .split(/[\s,;\n]+/)
      .map((s) => parseCreatorTarget(s, "instagram")?.username || s.replace(/^@/, "").trim().toLowerCase())
      .filter(Boolean);
    for (const c of parts) {
      if (!account.competitors.includes(c) && c !== account.username.toLowerCase()) {
        account.competitors.push(c);
      }
    }
  } else if (action === "removeCompetitor" && account) {
    const c = String(body.competitor || "").replace(/^@/, "").trim().toLowerCase();
    account.competitors = (account.competitors || []).filter((x) => x.toLowerCase() !== c);
  } else if (action === "markReproduced") {
    const code = String(body.shortcode || body.code || "").trim();
    if (!code) return { ok: false, message: "Missing shortcode." };
    if (body.status === "clear") {
      delete myAccountsStore.manualReproduced[code];
    } else {
      myAccountsStore.manualReproduced[code] = {
        status: body.status === "ignored" ? "ignored" : "published",
        ownCode: String(body.ownCode || "").trim(),
        note: String(body.note || "").trim(),
        updatedAt: new Date().toISOString(),
      };
    }
  } else if (action === "updateCron") {
    if (typeof body.enabled === "boolean") myAccountsStore.cron.enabled = body.enabled;
    if (body.intervalHours != null) {
      const hrs = Math.max(1, Math.min(48, Number(body.intervalHours) || 6));
      myAccountsStore.cron.intervalHours = hrs;
      myAccountsStore.cron.nextRunAt = new Date(Date.now() + hrs * 3600 * 1000).toISOString();
    }
  }

  await saveJson(MY_ACCOUNTS_FILE, myAccountsStore);
  const active =
    myAccountsStore.accounts.find((a) => a.id === myAccountsStore.activeAccountId) ||
    myAccountsStore.accounts[0];
  return analyzeAccountData(active);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket Hub Server on 127.0.0.1:8765
// ─────────────────────────────────────────────────────────────────────────────

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(obj));
}

const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function serveStaticFile(res, filePath, extraHeaders = {}) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_MAP[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      ...extraHeaders,
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  } catch (_) {
    return false;
  }
}

async function startLocalHub() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      return sendJson(res, 200, { ok: true });
    }

    const urlObj = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const pathname = urlObj.pathname;
    const accept = String(req.headers.accept || "");

    // 0. Apple-Minimalist Dashboard Static Routes
    if (
      req.method === "GET" &&
      (pathname === "/dashboard" || pathname === "/dashboard/" || (pathname === "/" && accept.includes("text/html")))
    ) {
      const ok = await serveStaticFile(res, path.join(DASHBOARD_DIR, "index.html"));
      if (ok) return;
    }
    if (req.method === "GET" && pathname.startsWith("/dashboard/")) {
      const rel = pathname.slice("/dashboard/".length).replace(/\.\./g, "");
      const ok = await serveStaticFile(res, path.join(DASHBOARD_DIR, rel));
      if (ok) return;
    }
    if (req.method === "GET" && pathname === "/logo.svg") {
      const ok = await serveStaticFile(res, path.join(__dirname, "../extension/Icons/sortFeedLogo.svg"));
      if (ok) return;
    }

    // Serve extracted Visual Hook Frames
    if (req.method === "GET" && pathname.startsWith("/api/hook-frame/")) {
      const parts = pathname.slice("/api/hook-frame/".length).split("/").filter(Boolean);
      if (parts.length === 2) {
        const safeCode = parts[0].replace(/[^a-zA-Z0-9_-]/g, "");
        const safeFile = parts[1].replace(/[^a-zA-Z0-9_.-]/g, "");
        const ok = await serveStaticFile(res, path.join(HOOKS_DIR, safeCode, safeFile));
        if (ok) return;
      }
      return sendJson(res, 404, { ok: false, error: "FRAME_NOT_FOUND" });
    }

    // Serve Reproduce Pack .zip Download (`ig_<shortcode>.zip`)
    if (req.method === "GET" && pathname.startsWith("/api/reproduce/zip/")) {
      const packId = pathname.slice("/api/reproduce/zip/".length).replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9_-]/g, "");
      const zipFile = path.join(REPRODUCE_DIR, `${packId}.zip`);
      const ok = await serveStaticFile(res, zipFile, {
        "Content-Disposition": `attachment; filename="${packId}.zip"`,
      });
      if (ok) return;
      return sendJson(res, 404, { ok: false, error: "ZIP_NOT_FOUND" });
    }

    // Serve Reproduce Pack Assets (`storyboard.jpg`, `thumbnail.jpg`, `video.mp4`, `frames/scene_01.jpg`, `scenes.txt`)
    if (req.method === "GET" && pathname.startsWith("/api/reproduce/asset/")) {
      const relParts = pathname
        .slice("/api/reproduce/asset/".length)
        .split("/")
        .filter((seg) => seg && seg !== "." && seg !== "..");
      if (relParts.length >= 2) {
        const safePack = relParts[0].replace(/[^a-zA-Z0-9_-]/g, "");
        const subPath = relParts
          .slice(1)
          .map((s) => s.replace(/[^a-zA-Z0-9_.-]/g, ""))
          .join("/");
        const fullAsset = path.join(REPRODUCE_DIR, safePack, subPath);
        const ok = await serveStaticFile(res, fullAsset);
        if (ok) return;
      }
      return sendJson(res, 404, { ok: false, error: "ASSET_NOT_FOUND" });
    }

    // List Reproduce Packs (with optional category filter)
    if (req.method === "GET" && pathname === "/api/reproduce/list") {
      const catFilter = (urlObj.searchParams.get("category") || "all").trim();
      let packs = reproduceDb.map((p) => ({
        ...p,
        category: p.category || inferCategory(p),
      }));
      if (catFilter && catFilter.toLowerCase() !== "all") {
        const normCat = normalizeCategoryName(catFilter);
        packs = packs.filter((p) => (p.category || "Uncategorized").toLowerCase() === normCat.toLowerCase());
      }
      return sendJson(res, 200, {
        ok: true,
        count: packs.length,
        totalCount: reproduceDb.length,
        ...getCategoriesSummary(),
        packs,
      });
    }

    // Categories Summary
    if (req.method === "GET" && pathname === "/api/categories") {
      return sendJson(res, 200, { ok: true, ...getCategoriesSummary() });
    }

    // Delete a Reproduce Pack
    if (req.method === "DELETE" && pathname.startsWith("/api/reproduce/")) {
      const packId = pathname.slice("/api/reproduce/".length).replace(/[^a-zA-Z0-9_-]/g, "");
      const idx = reproduceDb.findIndex((p) => p.packId === packId);
      if (idx >= 0) reproduceDb.splice(idx, 1);
      await saveJson(REPRODUCE_DB_FILE, reproduceDb);
      await fsp.rm(path.join(REPRODUCE_DIR, packId), { recursive: true, force: true }).catch(() => {});
      await fsp.unlink(path.join(REPRODUCE_DIR, `${packId}.zip`)).catch(() => {});
      return sendJson(res, 200, { ok: true, deleted: packId });
    }

    // Query Permanent Master Posts Database
    if (req.method === "GET" && pathname === "/api/db/posts") {
      const result = queryMasterPostsDb({
        search: urlObj.searchParams.get("search") || "",
        username: urlObj.searchParams.get("username") || "",
        platform: urlObj.searchParams.get("platform") || "all",
        category: urlObj.searchParams.get("category") || "all",
        minOutlier: Number(urlObj.searchParams.get("minOutlier") || 0),
        savedOnly: urlObj.searchParams.get("savedOnly") === "1",
        reproducedOnly: urlObj.searchParams.get("reproducedOnly") === "1",
        sortBy: urlObj.searchParams.get("sortBy") || "outlier",
        limit: Number(urlObj.searchParams.get("limit") || 300),
      });
      return sendJson(res, 200, { ok: true, ...result });
    }

    // Resolve Facebook Comet Reel MP4 + Audio + Metadata directly on Hub
    if (req.method === "GET" && pathname === "/api/fb-resolve") {
      const target = urlObj.searchParams.get("url") || urlObj.searchParams.get("videoId") || "";
      const out = await resolveFacebookReelDirect(target);
      return sendJson(res, 200, out);
    }

    // Media Proxy for CORS/CORP-free Thumbnails, Inline Video Player & 1-Click MP4 Downloads
    if (req.method === "GET" && pathname === "/api/media-proxy") {
      const targetUrl = urlObj.searchParams.get("url");
      const download = urlObj.searchParams.get("dl") === "1";
      const filename = String(urlObj.searchParams.get("filename") || "viralspy_video.mp4").replace(/[^a-zA-Z0-9_.-]/g, "_");
      if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
        return sendJson(res, 400, { ok: false, error: "INVALID_URL" });
      }
      try {
        const referer = targetUrl.includes("tiktok")
          ? "https://www.tiktok.com/"
          : targetUrl.includes("facebook")
          ? "https://www.facebook.com/"
          : "https://www.instagram.com/";
        const headers = {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "*/*",
          Referer: referer,
        };
        if (req.headers.range) headers.Range = req.headers.range;
        const upstream = await fetch(targetUrl, { headers });
        if (!upstream.ok && upstream.status !== 206) {
          return sendJson(res, upstream.status, { ok: false, error: `Upstream HTTP ${upstream.status}` });
        }
        const outHeaders = {
          "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Cache-Control": "public, max-age=3600",
        };
        const cl = upstream.headers.get("content-length");
        if (cl) outHeaders["Content-Length"] = cl;
        const cr = upstream.headers.get("content-range");
        if (cr) outHeaders["Content-Range"] = cr;
        const ar = upstream.headers.get("accept-ranges");
        if (ar) outHeaders["Accept-Ranges"] = ar;
        if (download) {
          outHeaders["Content-Disposition"] = `attachment; filename="${filename}"`;
        }
        res.writeHead(upstream.status, outHeaders);
        if (upstream.body) {
          Readable.fromWeb(upstream.body).pipe(res);
        } else {
          res.end();
        }
        return;
      } catch (err) {
        return sendJson(res, 502, { ok: false, error: err?.message || "Proxy error" });
      }
    }

    // 1. Health & Status
    if (req.method === "GET" && (pathname === "/" || pathname === "/api/status" || pathname === "/access")) {
      const status = await getHubStatus();
      return sendJson(res, 200, status);
    }

    // 1b. Workspace Library, Reproduce DB & Master DB Summary for Studio Dashboard
    if (req.method === "GET" && pathname === "/api/library") {
      const enrichedSaved = savedLibrary.posts.map((p) => {
        const dbHit = postsDb[`${p.platform || "instagram"}:${p.code}`];
        const pack = findPackForCode(p.code);
        return {
          ...p,
          username: p.username || dbHit?.username || pack?.username || "",
          caption: p.caption || dbHit?.caption || pack?.caption || "",
          category: p.category && p.category !== "Uncategorized" ? p.category : dbHit?.category || inferCategory(p),
          thumbnailUrl: p.thumbnailUrl || dbHit?.thumbnailUrl || (pack ? `/api/reproduce/asset/${pack.packId}/thumbnail.jpg` : null),
          videoUrl: p.videoUrl || dbHit?.videoUrl || null,
          views: p.views ?? dbHit?.views ?? null,
          likes: p.likes ?? dbHit?.likes ?? null,
          comments: p.comments ?? dbHit?.comments ?? null,
          isSaved: true,
          reproducePackId: pack?.packId || null,
          reproduceZipUrl: pack?.zipUrl || null,
        };
      });
      const enrichedPacks = reproduceDb.map((pk) => ({
        ...pk,
        category: pk.category || inferCategory(pk),
      }));
      const catSummary = getCategoriesSummary();
      return sendJson(res, 200, {
        ok: true,
        savedPosts: enrichedSaved,
        reproducePacks: enrichedPacks,
        postsDbCount: Object.keys(postsDb).length,
        categories: catSummary.categories,
        creatorMap: catSummary.creatorMap,
        dbCategoryCounts: catSummary.dbCounts,
        videoDbCategoryCounts: catSummary.videoDbCounts,
        transcripts: transcriptCache,
        visualHooks: visualHooksCache,
        comments: commentsCache,
        recentScans: scanHistory,
        radarRuns: radarHistory,
        liveRadar: liveRadarStatus,
      });
    }

    // 2. Watch in Chrome helper route
    if (req.method === "GET" && pathname.startsWith("/watch")) {
      await focusExtensionTabLocal(true);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><body style="font-family:-apple-system,system-ui;padding:24px;">Focused ViralSpy tab in Chrome. You can close this tab.</body></html>`
      );
      return;
    }

    // Parse JSON body for POST endpoints
    let body = {};
    if (req.method === "POST") {
      try {
        const raw = await readRequestBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (_) {
        body = {};
      }
    }

    // 3. In-Page Transcription Refund / Quota / Cache / Worker Routes
    if (req.method === "POST" && pathname.endsWith("/refund")) {
      return sendJson(res, 200, { ok: true, refunded: true });
    }
    if (req.method === "POST" && pathname.startsWith("/trans-quota")) {
      return sendJson(res, 200, { ok: true, monthly_quota_mins: null, monthly_usage_secs: 0 });
    }
    if (req.method === "POST" && pathname.startsWith("/trans-cache")) {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const hits = {};
      for (const id of ids) {
        const k = String(id || "").trim();
        if (k && transcriptCache[k]) hits[k] = transcriptCache[k];
      }
      return sendJson(res, 200, { ok: true, hits });
    }
    if (
      req.method === "POST" &&
      (pathname.startsWith("/trans/instagram") ||
        pathname.startsWith("/trans/tiktok") ||
        pathname.startsWith("/trans/facebook"))
    ) {
      const platform = pathname.includes("tiktok")
        ? "tiktok"
        : pathname.includes("facebook")
        ? "facebook"
        : "instagram";
      const out = await transcribeMediaLocal({
        cacheKey: body.reelIdUi || null,
        mediaUrl: body.ReelURL || null,
        mediaBase64: body.ReelBase64 || null,
        platform: body.platform || platform,
        profileName: body.profileName || "",
      });
      if (!out.ok) {
        return sendJson(res, 200, {
          ok: false,
          errorCode: out.errorCode || "whisper_failed",
          message: out.message || "Transcription failed",
        });
      }
      return sendJson(res, 200, {
        ok: true,
        ReelType: body.ReelType || "video",
        ReelURL: body.ReelURL || null,
        transcription: out.transcription,
        hook: out.hook,
        partial: false,
        duration_seconds: out.duration_seconds,
        segments: out.segments,
      });
    }

    // 4. Unified Two-Way Save Library Endpoints (Extension <-> Studio Swipe Vault)
    if (req.method === "POST" && pathname.startsWith("/save-status")) {
      return sendJson(res, 200, { ok: true, hasLibrary: savedLibrary.posts.length > 0 });
    }
    if (req.method === "POST" && pathname.startsWith("/save")) {
      if (pathname.endsWith("/lookup")) {
        const codes = Array.isArray(body.codes) ? body.codes : [];
        const savedMap = {};
        for (const c of codes) {
          const cleanC = String(c || "").trim();
          if (cleanC && isCodeSaved(cleanC)) {
            savedMap[cleanC] = true;
          }
        }
        return sendJson(res, 200, {
          ok: true,
          saved: savedMap,
          count: savedLibrary.posts.length,
          limit: null,
        });
      }
      if (pathname.endsWith("/unsave")) {
        const code = String(body.code || body.shortcode || body.reel_code || body.id || "").trim();
        const before = savedLibrary.posts.length;
        savedLibrary.posts = savedLibrary.posts.filter((p) => p.code !== code && p.shortcode !== code);
        const removed = savedLibrary.posts.length < before;
        await saveJson(SAVED_LIBRARY_FILE, savedLibrary);
        return sendJson(res, 200, {
          ok: true,
          removed,
          count: savedLibrary.posts.length,
          limit: null,
        });
      }

      const normalized = normalizeSavedPost(body, body.platform || "instagram");
      if (!normalized) {
        return sendJson(res, 200, { ok: false, error: "BAD_POST", message: "Missing post code" });
      }
      // Enrich from Master DB if extension save lacked outlierScore, caption, or videoUrl
      const dbHit = postsDb[`${normalized.platform}:${normalized.code}`];
      if (dbHit) {
        normalized.outlierScore = normalized.outlierScore ?? dbHit.outlierScore ?? null;
        normalized.velocityScore = normalized.velocityScore ?? dbHit.velocityScore ?? null;
        normalized.viewsPerHour = normalized.viewsPerHour ?? dbHit.viewsPerHour ?? null;
        normalized.videoUrl = normalized.videoUrl || dbHit.videoUrl || null;
        normalized.thumbnailUrl = normalized.thumbnailUrl || dbHit.thumbnailUrl || null;
        normalized.username = normalized.username || dbHit.username || "";
        normalized.caption = normalized.caption || dbHit.caption || "";
        normalized.category = dbHit.category || normalized.category;
      }

      savedLibrary.posts = savedLibrary.posts.filter(
        (p) => p.code !== normalized.code && p.shortcode !== normalized.code
      );
      savedLibrary.posts.unshift(normalized);
      await saveJson(SAVED_LIBRARY_FILE, savedLibrary);
      await upsertPostsToDb([normalized], {
        platform: normalized.platform,
        username: normalized.username,
        source: "saved_vault",
      });

      // Auto-hydrate caption & creator handle in background if missing on newly saved post
      if ((!normalized.caption || !normalized.username) && normalized.platform === "instagram" && isExtensionConnected()) {
        fetchAndPersistPostDetails({
          shortcode: normalized.code,
          platform: normalized.platform,
          username: normalized.username,
          url: normalized.url,
        }).catch(() => {});
      }

      return sendJson(res, 200, {
        ok: true,
        saved: true,
        post: normalized,
        count: savedLibrary.posts.length,
        limit: null,
      });
    }

    // 4b. Categories Management & Post Description Retrieval Endpoints
    if (req.method === "POST" && pathname === "/api/categories/add") {
      const clean = ensureCategoryExists(body.name || body.category || "");
      if (!clean || clean === "all" || clean === "auto") {
        return sendJson(res, 200, { ok: false, message: "Enter a valid category name." });
      }
      await saveJson(CATEGORIES_FILE, categoriesStore);
      return sendJson(res, 200, { ok: true, category: clean, ...getCategoriesSummary() });
    }

    if (req.method === "POST" && pathname === "/api/categories/assign") {
      const out = await assignCategoryAndPropagate({
        category: body.category,
        platform: body.platform || "instagram",
        username: body.username || "",
        shortcode: body.shortcode || body.code || "",
        applyToCreator: body.applyToCreator !== false,
      });
      return sendJson(res, 200, out);
    }

    if (req.method === "POST" && pathname === "/api/post-details") {
      try {
        const out = await fetchAndPersistPostDetails(body);
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 200, { ok: false, message: err?.message || String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/api/hydrate-captions") {
      try {
        const out = await hydrateMissingCaptionsBatch(body);
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 200, { ok: false, message: err?.message || String(err) });
      }
    }

    // 5. Ingest Posts to Permanent Master Database (from Chrome In-Page Sorts or Studio)
    if (req.method === "POST" && pathname === "/api/db/ingest") {
      const list = Array.isArray(body.posts) ? body.posts : [];
      const savedCount = await upsertPostsToDb(list, {
        platform: body.platform || "instagram",
        username: body.username || "",
        source: body.source || "chrome_inpage_sort",
      });
      return sendJson(res, 200, {
        ok: true,
        ingested: savedCount,
        totalInDb: Object.keys(postsDb).length,
      });
    }

    // 6. One-Shot VideoBot Reproduce Endpoint
    if (req.method === "POST" && pathname === "/api/reproduce") {
      try {
        const out = await reproduceVideoLocal(body);
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 200, { ok: false, message: err?.message || String(err) });
      }
    }

    // 7. Studio Dashboard & Secondary MCP API Endpoints
    if (req.method === "POST" && pathname === "/api/job") {
      try {
        const result = await dispatchExtensionJobLocal(body.job || body, body.timeoutMs || 180000);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 200, {
          ok: false,
          error: { code: "DISPATCH_ERROR", message: err?.message || String(err) },
        });
      }
    }

    if (req.method === "POST" && pathname === "/api/sort") {
      try {
        const parsedTarget = parseCreatorTarget(body.username || "", body.platform || "instagram");
        const platform = String(parsedTarget?.platform || body.platform || "instagram").toLowerCase();
        const cleanUser = parsedTarget?.username || String(body.username || "").replace(/^@/, "").trim();
        const surface =
          body.surface ||
          parsedTarget?.surface ||
          (platform === "youtube" ? "shorts" : platform === "tiktok" ? "videos" : "reels");
        const sortBy = body.sortBy || "outlier";
        const isAllPosts = body.depth === "all" || Number(body.depth) >= 10000 || Number(body.depth) === 0;
        const depth = isAllPosts ? 10000 : Math.max(12, Math.min(10000, parseInt(body.depth, 10) || 60));
        const sortTimeoutMs = isAllPosts ? 1200000 : Math.max(240000, Math.ceil(depth / 12) * 5000 + 120000);

        let job;
        if (platform === "youtube") {
          job = { kind: "youtube", username: cleanUser, surface, sortBy, depth };
        } else if (platform === "tiktok") {
          job = { kind: "tiktok", username: cleanUser, surface: "videos", sortBy, depth };
        } else {
          job = {
            username: cleanUser.toLowerCase(),
            surface: surface === "posts" ? "posts" : "reels",
            sortBy,
            outlier: sortBy === "outlier" || sortBy === "velocity" ? "on" : "auto",
            depth,
            ...(body.since ? { since: new Date(body.since).getTime() } : {}),
            ...(body.until ? { until: new Date(body.until).getTime() } : {}),
          };
        }

        const rawRes = await runExtensionJob(job, sortTimeoutMs);
        if (!rawRes?.ok) {
          return sendJson(res, 200, {
            ok: false,
            message: rawRes?.error?.message || "Sort job failed.",
            error: rawRes?.error || null,
          });
        }

        const requestedCategory = body.category && body.category !== "auto" ? ensureCategoryExists(body.category) : "";
        const rows = Array.isArray(rawRes.rows) ? rawRes.rows : [];
        const baseline = rawRes.outlier?.baseline ?? null;
        const posts = rows.map((r, i) => {
          const formatted = formatPostSummary(r, i, platform);
          formatted.username = formatted.username || cleanUser;
          formatted.creatorBaseline = baseline;
          formatted.category = requestedCategory || inferCategory({ ...formatted, platform, username: cleanUser });
          if (baseline && baseline > 0 && formatted.viewsPerHour != null && formatted.velocityScore == null) {
            formatted.velocityScore = Number(((formatted.viewsPerHour * 24) / baseline).toFixed(2));
          }
          return formatted;
        });

        // Permanently save all scraped posts into Master Posts DB
        await upsertPostsToDb(posts, {
          platform,
          username: cleanUser,
          category: requestedCategory || "auto",
          creatorBaseline: baseline,
          source: "creator_spy",
        });

        const resolvedScanCategory = requestedCategory || inferCategory({ platform, username: cleanUser });

        const payload = {
          ok: true,
          platform,
          username: cleanUser,
          category: resolvedScanCategory,
          surface: rawRes.surface || surface,
          sortBy,
          totalScanned: rawRes.seenInFeed || rows.length,
          outlierBaseline: rawRes.outlier || null,
          durationMs: rawRes.ms || null,
          savedExports: rawRes.savedExports || {},
          posts,
        };

        await recordScanInHistory(payload);

        // Background-hydrate missing post descriptions for the top 12 outliers right away
        if (platform === "instagram") {
          const topMissingCodes = posts
            .filter((p) => !p.caption)
            .slice(0, 12)
            .map((p) => p.shortcode || p.code)
            .filter(Boolean);
          if (topMissingCodes.length) {
            hydrateMissingCaptionsBatch({ shortcodes: topMissingCodes, platform: "instagram", limit: 12 }).catch(() => {});
          }
        }

        return sendJson(res, 200, payload);
      } catch (err) {
        return sendJson(res, 200, { ok: false, message: err?.message || String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/api/similar") {
      try {
        const parsed = parseCreatorTarget(body.username || "", "instagram");
        const cleanUser = (parsed?.username || String(body.username || "")).replace(/^@/, "").trim().toLowerCase();
        const sim = await runExtensionJob({ kind: "similar", username: cleanUser }, 60000);
        return sendJson(res, 200, sim);
      } catch (err) {
        return sendJson(res, 200, { ok: false, message: err?.message || String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/api/niche-radar") {
      try {
        const out = await runNicheRadar(body);
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 200, { ok: false, message: err?.message || String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/api/visual-hook") {
      try {
        const shortcode = extractShortcode(body.shortcode || body.postUrlOrShortcode) || body.shortcode || null;
        let videoUrl = body.videoUrl || null;
        if (!videoUrl && shortcode) {
          const info = await runExtensionJob({ kind: "media_info", shortcode }, 45000);
          if (info?.ok && info.videoUrl) videoUrl = info.videoUrl;
        }
        const out = await extractVisualHookLocal({ shortcode, videoUrl, force: !!body.force });
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 200, { ok: false, message: err?.message || String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/api/comments") {
      try {
        const out = await runMineComments(body);
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 200, { ok: false, message: err?.message || String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/api/transcribe") {
      let mediaUrl = body.mediaUrl || null;
      const shortcode = extractShortcode(body.cacheKey || body.shortcode || body.postUrlOrShortcode) || body.cacheKey || null;
      if (!mediaUrl && shortcode) {
        if (!body.force && transcriptCache[shortcode]?.transcription) {
          return sendJson(res, 200, {
            ok: true,
            cached: true,
            cacheKey: shortcode,
            ...enrichTranscriptMetrics(transcriptCache[shortcode]),
          });
        }
        const info = await runExtensionJob({ kind: "media_info", shortcode }, 45000);
        if (info?.ok) mediaUrl = info.audioUrl || info.videoUrl;
      }
      const out = await transcribeMediaLocal({ ...body, cacheKey: shortcode, mediaUrl });
      return sendJson(res, 200, out);
    }

    if (req.method === "POST" && pathname === "/api/focus") {
      const out = await focusExtensionTabLocal(body.any !== false);
      return sendJson(res, 200, out);
    }

    // 8. My Accounts Hub, Priority Recommender & 6h Cron Endpoints
    if (req.method === "GET" && pathname === "/api/my-accounts") {
      const accId = urlObj.searchParams.get("accountId") || myAccountsStore.activeAccountId;
      const excludeLocalDrafts = urlObj.searchParams.get("excludeLocalDrafts") === "1";
      const account =
        myAccountsStore.accounts.find((a) => a.id === accId) || myAccountsStore.accounts[0];
      const data = analyzeAccountData(account, { excludeLocalDrafts });
      schedulePriorityCaptionsHydration(data.priorityTop10);
      return sendJson(res, 200, data);
    }

    if (req.method === "POST" && pathname === "/api/my-accounts/config") {
      try {
        const out = await handleMyAccountsConfigAction(body);
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 200, { ok: false, message: err?.message || String(err) });
      }
    }

    if (req.method === "POST" && pathname === "/api/my-accounts/sync") {
      try {
        const out = await runMyAccountsCronSync(body);
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 200, { ok: false, message: err?.message || String(err) });
      }
    }

    return sendJson(res, 404, { ok: false, error: "NOT_FOUND", path: pathname });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const urlObj = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (urlObj.pathname === "/ext") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    extState.ws = ws;
    extState.connectedAt = new Date().toISOString();
    extState.lastSeenAt = extState.connectedAt;

    ws.send(
      JSON.stringify({
        type: "welcome",
        claude: true,
        caps: { hour: 20000, day: 100000 },
        coolDownMs: 1800000,
        presenceMaxIdleMin: 0,
      })
    );

    // Gently backfill any saved post missing its description or creator handle once Chrome connects
    setTimeout(() => {
      const missingSaved = savedLibrary.posts
        .filter((p) => p.platform === "instagram" && (!p.caption || !p.username))
        .map((p) => p.code)
        .filter(Boolean);
      if (missingSaved.length) {
        hydrateMissingCaptionsBatch({ shortcodes: missingSaved, platform: "instagram", limit: 10 }).catch(() => {});
      }
    }, 2500);

    ws.on("message", (data) => {
      extState.lastSeenAt = new Date().toISOString();
      const raw = String(data || "");
      if (raw === "ping") {
        try {
          ws.send("pong");
        } catch (_) {}
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "hello") {
        extState.version = msg.version || "21.0";
        extState.browser = msg.browser || "Google Chrome";
        return;
      }

      if (msg.type === "status" || msg.type === "progress") {
        const pending = extState.pendingJobs.get(msg.jobId);
        if (pending) {
          pending.progress.push({ ...msg, at: Date.now() });
        }
        return;
      }

      if (msg.type === "result") {
        const pending = extState.pendingJobs.get(msg.jobId);
        if (pending) {
          pending.resolve(msg);
        }
        return;
      }

      if (msg.type === "focused") {
        const pending = extState.pendingFocus.get(msg.requestId);
        if (pending) {
          pending.resolve(msg);
        }
        return;
      }
    });

    ws.on("close", () => {
      if (extState.ws === ws) {
        extState.ws = null;
      }
    });
  });

  return new Promise((resolve) => {
    server.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        isPrimaryHub = false;
        resolve({ primary: false });
      } else {
        isPrimaryHub = false;
        resolve({ primary: false, error: err });
      }
    });
    server.listen(PORT, HOST, () => {
      isPrimaryHub = true;
      // 6-hour automatic Cron loop for My Accounts (own account + competitors)
      setInterval(() => {
        if (!myAccountsStore.cron.enabled || myAccountsStore.cron.running || !isExtensionConnected()) return;
        const nextMs = myAccountsStore.cron.nextRunAt ? Date.parse(myAccountsStore.cron.nextRunAt) : 0;
        if (!Number.isFinite(nextMs) || Date.now() >= nextMs) {
          runMyAccountsCronSync({
            accountId: myAccountsStore.activeAccountId,
            scope: "all",
          }).catch(() => {});
        }
      }, 60 * 1000);
      resolve({ primary: true, server });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server Definition & 14 Tools
// ─────────────────────────────────────────────────────────────────────────────

function createViralSpyMcpServer() {
  const mcp = new McpServer({
    name: "viralspy",
    version: "3.0.0",
  });

  // Tool 1: viralspy_status
  mcp.tool(
    "viralspy_status",
    "Check ViralSpy Studio Hub, Chrome extension connection, Master Posts Database size, Reproduce Packs count, local Whisper GPU model, and Apple Vision OCR readiness.",
    {},
    async () => {
      const status = await getHubStatus();
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }
  );

  // Tool 2: viralspy_reproduce_video (One-Shot VideoBot Replacement)
  mcp.tool(
    "viralspy_reproduce_video",
    "One-Shot VideoBot Reproduce Pack: downloads any Instagram/TikTok video, detects every shot change via ffmpeg (`frames/scene_01.jpg...`), builds `storyboard.jpg`, runs Whisper GPU word-level alignment to generate `scenes.txt` + `transcript.txt` + Vision OCR, and packages `ig_<shortcode>.zip` ready for the `video-storyboard` skill.",
    {
      urlOrShortcode: z.string().describe("Instagram Reel URL, TikTok Video URL, or shortcode."),
      force: z.boolean().default(false).describe("Re-run extraction even if pack already exists."),
      includeStoryboardInline: z.boolean().default(true).describe("Include storyboard.jpg contact sheet inline."),
    },
    async ({ urlOrShortcode, force = false, includeStoryboardInline = true }) => {
      const out = await runReproducePack({ url: urlOrShortcode, force });
      if (!out?.ok) {
        return { isError: true, content: [{ type: "text", text: `Reproduce Pack failed: ${out?.message}` }] };
      }
      const pack = out.pack || out;
      let scenesTxt = "";
      try {
        scenesTxt = await fsp.readFile(path.join(pack.folderPath, "scenes.txt"), "utf8");
      } catch (_) {}

      const content = [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              packId: pack.packId,
              folderPath: pack.folderPath,
              zipPath: pack.zipPath,
              zipDownloadUrl: `http://${HOST}:${PORT}${pack.zipUrl}`,
              sceneCount: pack.sceneCount,
              durationSeconds: pack.durationSeconds,
              spokenHook: pack.spokenHook,
              onScreenHook: pack.onScreenHook,
              transcript: pack.transcript,
              scenesTxt,
              skillPrompt: pack.skillPrompt,
            },
            null,
            2
          ),
        },
      ];

      const sbFile = path.join(pack.folderPath, "storyboard.jpg");
      if (includeStoryboardInline && fs.existsSync(sbFile)) {
        try {
          const b64 = (await fsp.readFile(sbFile)).toString("base64");
          content.push({ type: "image", data: b64, mimeType: "image/jpeg" });
        } catch (_) {}
      }
      return { content };
    }
  );

  // Tool 3: viralspy_query_database
  mcp.tool(
    "viralspy_query_database",
    "Search and filter ViralSpy's permanent Master Posts Database (all posts ever scraped across Creator Spy, Niche Radar, and Chrome sorts).",
    {
      search: z.string().optional().describe("Keyword in caption, creator handle, or transcript."),
      username: z.string().optional().describe("Filter by creator handle."),
      platform: z.enum(["all", "instagram", "tiktok", "youtube"]).default("all"),
      minOutlier: z.number().default(0),
      savedOnly: z.boolean().default(false),
      sortBy: z.enum(["outlier", "velocity", "views", "likes", "comments", "recent"]).default("outlier"),
      limit: z.number().int().min(1).max(200).default(30),
    },
    async (params) => {
      const qs = new URLSearchParams({
        search: params.search || "",
        username: params.username || "",
        platform: params.platform || "all",
        minOutlier: String(params.minOutlier || 0),
        savedOnly: params.savedOnly ? "1" : "0",
        sortBy: params.sortBy || "outlier",
        limit: String(params.limit || 30),
      });
      const data = isPrimaryHub
        ? { ok: true, ...queryMasterPostsDb(params) }
        : await fetch(`http://${HOST}:${PORT}/api/db/posts?${qs}`).then((r) => r.json());
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // Tool 4: viralspy_sort_instagram
  mcp.tool(
    "viralspy_sort_instagram",
    "Sort any Instagram profile's Reels or Posts by Outlier Score, Velocity, Views, Likes, Comments, or Oldest (and permanently archive all scraped posts).",
    {
      username: z.string().describe("Instagram handle or full profile URL (e.g. 'https://www.instagram.com/andre_gizmo/')."),
      surface: z.enum(["reels", "posts"]).default("reels"),
      sortBy: z.enum(["outlier", "velocity", "views", "likes", "comments", "oldest"]).default("outlier"),
      depth: z.number().int().min(12).max(2000).default(60),
      limit: z.number().int().min(1).max(200).default(15),
      since: z.string().optional(),
      until: z.string().optional(),
    },
    async ({ username, surface = "reels", sortBy = "outlier", depth = 60, limit = 15, since, until }) => {
      const parsed = parseCreatorTarget(username, "instagram");
      const cleanUser = (parsed?.username || username).replace(/^@/, "").trim().toLowerCase();
      const res = await fetch(`http://${HOST}:${PORT}/api/sort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "instagram", username: cleanUser, surface, sortBy, depth, since, until }),
      }).then((r) => r.json());

      if (!res || !res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `ViralSpy sort failed for @${cleanUser}: ${res?.message || JSON.stringify(res)}` }],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...res,
                posts: (res.posts || []).slice(0, limit),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 5: viralspy_sort_multiplatform (TikTok & YouTube Shorts/Videos)
  mcp.tool(
    "viralspy_sort_multiplatform",
    "Sort any TikTok creator profile or YouTube channel (Shorts or Videos) by Outlier Score, Velocity, Views, or Likes.",
    {
      platform: z.enum(["tiktok", "youtube"]).describe("Target platform: 'tiktok' or 'youtube'."),
      username: z.string().describe("Creator handle or URL."),
      surface: z.enum(["shorts", "videos"]).default("shorts").describe("For YouTube: 'shorts' or 'videos'."),
      sortBy: z.enum(["outlier", "velocity", "views", "likes"]).default("outlier"),
      depth: z.number().int().min(12).max(200).default(48),
      limit: z.number().int().min(1).max(100).default(15),
    },
    async ({ platform, username, surface = "shorts", sortBy = "outlier", depth = 48, limit = 15 }) => {
      const res = await fetch(`http://${HOST}:${PORT}/api/sort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, username, surface, sortBy, depth }),
      }).then((r) => r.json());
      if (!res?.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `${platform} sort failed: ${res?.message || JSON.stringify(res)}` }],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...res, posts: (res.posts || []).slice(0, limit) }, null, 2),
          },
        ],
      };
    }
  );

  // Tool 6: viralspy_niche_radar
  mcp.tool(
    "viralspy_niche_radar",
    "Scan multiple competitor profile URLs or @handles in parallel (up to 3 tabs at once) and permanently save all scraped posts into the Master Database.",
    {
      usernames: z.array(z.string()).optional().describe("List of competitor profile URLs (Instagram/TikTok/YouTube) or @handles."),
      seedUsername: z.string().optional().describe("Single seed Instagram URL/handle to auto-discover similar competitors from."),
      autoSimilarCount: z.number().int().min(2).max(12).default(5),
      daysBack: z.number().int().min(0).max(365).default(30),
      perAccountDepth: z.number().int().min(12).max(120).default(36),
      sortBy: z.enum(["outlier", "velocity", "views"]).default("outlier"),
      limit: z.number().int().min(5).max(100).default(25),
    },
    async ({ usernames, seedUsername, autoSimilarCount = 5, daysBack = 30, perAccountDepth = 36, sortBy = "outlier", limit = 25 }) => {
      const out = isPrimaryHub
        ? await runNicheRadar({ usernames, seedUsername, autoSimilarCount, daysBack, perAccountDepth, sortBy })
        : await fetch(`http://${HOST}:${PORT}/api/niche-radar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usernames, seedUsername, autoSimilarCount, daysBack, perAccountDepth, sortBy }),
          }).then((r) => r.json());

      if (!out?.ok) {
        return { isError: true, content: [{ type: "text", text: `Niche Radar failed: ${out?.message || JSON.stringify(out)}` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...out, leaderboard: (out.leaderboard || []).slice(0, limit) }, null, 2),
          },
        ],
      };
    }
  );

  // Tool 7: viralspy_visual_hook
  mcp.tool(
    "viralspy_visual_hook",
    "Extract the 3 visual hook frames (0.0s, 1.5s, 3.0s) from any Reel using local ffmpeg and read all burned-in on-screen text overlays using Apple Vision OCR.",
    {
      postUrlOrShortcode: z.string().optional(),
      videoUrl: z.string().optional(),
      includeImagesInline: z.boolean().default(true),
    },
    async ({ postUrlOrShortcode, videoUrl, includeImagesInline = true }) => {
      const out = await runVisualHook({ postUrlOrShortcode, videoUrl });
      if (!out?.ok) {
        return { isError: true, content: [{ type: "text", text: `Visual hook extraction failed: ${out?.message}` }] };
      }
      const content = [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              shortcode: out.shortcode,
              durationSeconds: out.durationSeconds,
              onScreenHookText: out.onScreenHookText,
              uniqueOcrLines: out.uniqueOcrLines,
              frames: (out.frames || []).map((f) => ({
                label: f.label,
                timestamp: f.timestamp,
                localPath: f.localPath,
                ocrText: f.ocrText,
              })),
            },
            null,
            2
          ),
        },
      ];
      if (includeImagesInline && Array.isArray(out.frames)) {
        for (const f of out.frames) {
          if (f.localPath && fs.existsSync(f.localPath)) {
            try {
              const b64 = (await fsp.readFile(f.localPath)).toString("base64");
              content.push({ type: "image", data: b64, mimeType: "image/jpeg" });
            } catch (_) {}
          }
        }
      }
      return { content };
    }
  );

  // Tool 8: viralspy_mine_comments
  mcp.tool(
    "viralspy_mine_comments",
    "Comment Goldmine: extract the highest-liked comments on any viral Instagram Reel/Post and automatically surface unanswered audience questions and product/topic requests.",
    {
      postUrlOrShortcode: z.string(),
      limit: z.number().int().min(15).max(150).default(60),
    },
    async ({ postUrlOrShortcode, limit = 60 }) => {
      const out = isPrimaryHub
        ? await runMineComments({ postUrlOrShortcode, limit })
        : await fetch(`http://${HOST}:${PORT}/api/comments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ postUrlOrShortcode, limit }),
          }).then((r) => r.json());

      return {
        isError: !out?.ok,
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      };
    }
  );

  // Tool 9: viralspy_similar_accounts
  mcp.tool(
    "viralspy_similar_accounts",
    "Discover similar Instagram creator accounts for any username or profile URL.",
    { username: z.string() },
    async ({ username }) => {
      const parsed = parseCreatorTarget(username, "instagram");
      const cleanUser = (parsed?.username || username).replace(/^@/, "").trim().toLowerCase();
      const res = await runExtensionJob({ kind: "similar", username: cleanUser }, 60000);
      return {
        isError: !res?.ok,
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    }
  );

  // Tool 10: viralspy_search_instagram
  mcp.tool(
    "viralspy_search_instagram",
    "Search Instagram by keyword and sort matching posts/reels across creators by likes, comments, or oldest.",
    {
      query: z.string(),
      sortBy: z.enum(["likes", "comments", "oldest"]).default("likes"),
      depth: z.number().int().min(12).max(500).default(50),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ query, sortBy = "likes", depth = 50, limit = 20 }) => {
      const res = await runExtensionJob({ kind: "search", query, sortBy, depth }, 180000);
      if (!res?.ok) {
        return { isError: true, content: [{ type: "text", text: `Search sort failed: ${res?.error?.message}` }] };
      }
      const rows = Array.isArray(res.rows) ? res.rows : [];
      const formatted = rows.map((r, i) => formatPostSummary(r, i, "instagram"));
      await upsertPostsToDb(formatted, { platform: "instagram", source: `search:${query}` });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                query,
                sortBy,
                totalCollected: rows.length,
                topPosts: formatted.slice(0, limit),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 11: viralspy_saved_instagram
  mcp.tool(
    "viralspy_saved_instagram",
    "List your saved Instagram collections or sort your Saved Posts / a specific Saved Collection.",
    {
      action: z.enum(["list_collections", "sort_all", "sort_collection"]).default("list_collections"),
      collection: z.string().optional(),
      sortBy: z.enum(["likes", "comments", "oldest"]).default("likes"),
      depth: z.number().int().min(12).max(1000).default(60),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ action = "list_collections", collection, sortBy = "likes", depth = 60, limit = 20 }) => {
      const job =
        action === "list_collections"
          ? { kind: "collections" }
          : action === "sort_collection"
          ? { kind: "saved", saved: "collection", collection, sortBy, depth }
          : { kind: "saved", saved: "all_posts", sortBy, depth };
      const res = await runExtensionJob(job, 180000);
      if (!res?.ok) {
        return { isError: true, content: [{ type: "text", text: `Saved action failed: ${res?.error?.message}` }] };
      }
      if (action === "list_collections") {
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
      }
      const rows = Array.isArray(res.rows) ? res.rows : [];
      const formatted = rows.map((r, i) => formatPostSummary(r, i, "instagram"));
      await upsertPostsToDb(formatted, { platform: "instagram", source: "instagram_saved" });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                viewer: res.viewer,
                collection: res.collection || "all_posts",
                totalCollected: rows.length,
                topPosts: formatted.slice(0, limit),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 12: viralspy_transcribe_post
  mcp.tool(
    "viralspy_transcribe_post",
    "Transcribe any Reel/Post locally and free using Whisper Metal GPU. Returns Spoken Hook (0-5s), speaking pace (WPM), full script, and segments.",
    {
      postUrlOrShortcode: z.string().optional(),
      mediaUrl: z.string().optional(),
      language: z.string().default("auto"),
    },
    async ({ postUrlOrShortcode, mediaUrl, language = "auto" }) => {
      const shortcode = extractShortcode(postUrlOrShortcode);
      let resolvedUrl = mediaUrl || null;
      let meta = null;
      if (!resolvedUrl && shortcode) {
        if (transcriptCache[shortcode]?.transcription) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: true, cached: true, shortcode, ...enrichTranscriptMetrics(transcriptCache[shortcode]) },
                  null,
                  2
                ),
              },
            ],
          };
        }
        const info = await runExtensionJob({ kind: "media_info", shortcode }, 45000);
        if (!info?.ok) {
          return { isError: true, content: [{ type: "text", text: `Could not resolve media for ${shortcode}: ${info?.error?.message}` }] };
        }
        resolvedUrl = info.audioUrl || info.videoUrl;
        meta = info;
      }
      if (!resolvedUrl) {
        return { isError: true, content: [{ type: "text", text: "Provide postUrlOrShortcode or mediaUrl." }] };
      }
      const trans = await runTranscription({
        cacheKey: shortcode || null,
        mediaUrl: resolvedUrl,
        platform: "instagram",
        profileName: meta?.username || "",
        language,
      });
      return {
        isError: !trans.ok,
        content: [{ type: "text", text: JSON.stringify({ ...trans, shortcode: shortcode || meta?.shortcode || null }, null, 2) }],
      };
    }
  );

  // Tool 13: viralspy_spy_report
  mcp.tool(
    "viralspy_spy_report",
    "Full Spy Report: sorts an account's Reels by Outlier Score + Velocity, extracts Visual Hook OCR + Whisper Audio Transcripts on top N Reels, and discovers similar competitors.",
    {
      username: z.string(),
      depth: z.number().int().min(12).max(500).default(50),
      topPostsCount: z.number().int().min(3).max(30).default(10),
      transcribeTop: z.number().int().min(0).max(10).default(3),
      extractVisualHooksTop: z.number().int().min(0).max(5).default(3),
      includeSimilarAccounts: z.boolean().default(true),
    },
    async ({ username, depth = 50, topPostsCount = 10, transcribeTop = 3, extractVisualHooksTop = 3, includeSimilarAccounts = true }) => {
      const parsed = parseCreatorTarget(username, "instagram");
      const cleanUser = (parsed?.username || username).replace(/^@/, "").trim().toLowerCase();
      const sortRes = await runExtensionJob({ username: cleanUser, surface: "reels", sortBy: "outlier", outlier: "on", depth }, 240000);
      if (!sortRes?.ok) {
        return { isError: true, content: [{ type: "text", text: `Spy Report failed on @${cleanUser}: ${sortRes?.error?.message}` }] };
      }
      const rows = Array.isArray(sortRes.rows) ? sortRes.rows : [];
      const allFormatted = rows.map((r, i) => formatPostSummary(r, i, "instagram"));
      await upsertPostsToDb(allFormatted, {
        platform: "instagram",
        username: cleanUser,
        creatorBaseline: sortRes.outlier?.baseline ?? null,
        source: "spy_report",
      });
      const topPosts = allFormatted.slice(0, topPostsCount);

      for (let i = 0; i < Math.min(topPosts.length, Math.max(transcribeTop, extractVisualHooksTop)); i++) {
        const post = topPosts[i];
        let mediaUrl = post.audioUrl || post.videoUrl;
        let videoUrl = post.videoUrl;
        if ((!mediaUrl || !videoUrl) && post.shortcode) {
          const info = await runExtensionJob({ kind: "media_info", shortcode: post.shortcode }, 45000);
          if (info?.ok) {
            mediaUrl = mediaUrl || info.audioUrl || info.videoUrl;
            videoUrl = videoUrl || info.videoUrl;
          }
        }
        if (i < transcribeTop && mediaUrl) {
          const tr = await runTranscription({ cacheKey: post.shortcode || null, mediaUrl, platform: "instagram", profileName: cleanUser });
          if (tr?.ok) {
            post.spokenHook = tr.hook;
            post.transcript = tr.transcription;
            post.wordsPerMinute = tr.wordsPerMinute;
          }
        }
        if (i < extractVisualHooksTop && videoUrl) {
          const vh = await runVisualHook({ shortcode: post.shortcode, videoUrl });
          if (vh?.ok) {
            post.onScreenHookText = vh.onScreenHookText;
            post.visualHookFrames = (vh.frames || []).map((f) => f.localPath);
          }
        }
      }

      let similarAccounts = [];
      let profileInfo = null;
      if (includeSimilarAccounts) {
        const simRes = await runExtensionJob({ kind: "similar", username: cleanUser }, 45000);
        if (simRes?.ok) {
          similarAccounts = (simRes.accounts || []).slice(0, 25);
          profileInfo = simRes.profile || null;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                username: cleanUser,
                profile: profileInfo,
                totalReelsScanned: sortRes.seenInFeed || rows.length,
                outlierBaseline: sortRes.outlier || null,
                topOutlierReels: topPosts,
                similarAccounts,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 14: viralspy_focus_tab
  mcp.tool(
    "viralspy_focus_tab",
    "Bring the Chrome tab used by ViralSpy to the foreground.",
    {},
    async () => {
      const out = isPrimaryHub
        ? await focusExtensionTabLocal(true)
        : await fetch(`http://${HOST}:${PORT}/api/focus`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ any: true }),
          }).then((r) => r.json());
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
  );

  return mcp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot: Hub + Daemon / MCP Stdio
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const hubInfo = await startLocalHub();

if (args.includes("--daemon")) {
  if (!hubInfo.primary) {
    console.log(`[ViralSpy] Studio Hub is already running on http://${HOST}:${PORT}/dashboard`);
    process.exit(0);
  }
  console.log(`[ViralSpy] Studio Dashboard v3.0 live at http://${HOST}:${PORT}/dashboard (WS ws://${HOST}:${PORT}/ext)`);
} else {
  const mcpServer = createViralSpyMcpServer();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
