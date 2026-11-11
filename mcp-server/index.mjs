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
    const plat = /^\d{15,22}$/.test(code) ? "tiktok" : fallbackPlatform;
    return {
      platform: plat,
      shortcode: code,
      username: "",
      url: plat === "instagram" ? `https://www.instagram.com/reel/${code}/` : s,
    };
  }
  return null;
}

function normalizeSavedPost(raw, fallbackPlatform = "instagram") {
  if (!raw || typeof raw !== "object") return null;
  const code = String(raw.code || raw.shortcode || raw.reel_code || raw.id || "").trim();
  if (!code) return null;

  const platform = String(
    raw.platform || (raw.url && /tiktok\.com/i.test(raw.url) ? "tiktok" : fallbackPlatform)
  ).toLowerCase();

  const username = String(
    raw.username ||
      raw.userName ||
      raw.creator?.handle ||
      raw.creator?.username ||
      raw.profile ||
      ""
  )
    .replace(/^@/, "")
    .trim();

  let createDate = raw.createDate || "";
  if (!createDate && raw.posted_at) {
    const ms = Number(raw.posted_at) > 1e11 ? Number(raw.posted_at) : Number(raw.posted_at) * 1000;
    if (Number.isFinite(ms) && ms > 0) createDate = new Date(ms).toISOString();
  }

  const views = raw.views ?? raw.viewCount ?? raw.metrics?.views ?? null;
  const likes = raw.likes ?? raw.likesCount ?? raw.metrics?.likes ?? null;
  const comments = raw.comments ?? raw.commentsCount ?? raw.metrics?.comments ?? null;
  const shares = raw.shares ?? raw.sharesCount ?? raw.metrics?.shares ?? null;
  const outlierScore =
    typeof raw.outlierScore === "number"
      ? raw.outlierScore
      : typeof raw.outlier === "number"
      ? raw.outlier
      : null;

  const thumbnailUrl =
    raw.thumbnailUrl ||
    raw.thumbnailSmallUrl ||
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
      : `https://www.instagram.com/reel/${code}/`);

  const createdMs = createDate ? Date.parse(createDate) : NaN;
  const ageHours =
    raw.ageHours ??
    (Number.isFinite(createdMs) ? Number(Math.max(0.5, (Date.now() - createdMs) / 3600000).toFixed(2)) : null);
  const viewsPerHour =
    raw.viewsPerHour ??
    (ageHours != null && (views ?? likes) != null ? Number((+(views ?? likes) / ageHours).toFixed(2)) : null);

  return {
    platform,
    code,
    shortcode: code,
    kind: raw.kind || "reel",
    url,
    username,
    creatorName: raw.creator?.name || "",
    caption: String(raw.caption || "").trim(),
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

    postsDb[key] = {
      key,
      platform: norm.platform,
      code: norm.code,
      shortcode: norm.code,
      url: norm.url || prev.url || "",
      username: norm.username || context.username || prev.username || "",
      caption: norm.caption || prev.caption || "",
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
  }
  return count;
}

// Bootstrap Master Posts DB from existing scanHistory, radarHistory, and savedLibrary on startup
function bootstrapPostsDbFromHistorySync() {
  let added = 0;
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
        added += 1;
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
        added += 1;
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
      added += 1;
    }
  }
  if (added > 0) {
    try {
      fs.writeFileSync(POSTS_DB_FILE, JSON.stringify(postsDb, null, 2), "utf8");
    } catch (_) {}
  }
}
bootstrapPostsDbFromHistorySync();

function queryMasterPostsDb({
  search = "",
  username = "",
  platform = "all",
  minOutlier = 0,
  savedOnly = false,
  reproducedOnly = false,
  sortBy = "outlier",
  limit = 250,
} = {}) {
  const q = String(search || "").trim().toLowerCase();
  const uFilter = String(username || "").replace(/^@/, "").trim().toLowerCase();
  const minOut = Number(minOutlier || 0);

  let list = Object.values(postsDb).map((entry) => {
    const pack = findPackForCode(entry.code);
    const localThumb = pack ? `/api/reproduce/asset/${pack.packId}/thumbnail.jpg` : null;
    return {
      ...entry,
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

  return {
    totalInDb: Object.keys(postsDb).length,
    filteredCount: list.length,
    creators,
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
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "*/*",
      Referer: url.includes("tiktok") ? "https://www.tiktok.com/" : "https://www.instagram.com/",
    },
  });
  if (!res.ok) {
    throw new Error(`Media download failed with HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  await fsp.writeFile(destPath, Buffer.from(arrayBuffer));
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
  let postUrl = params.url || parsed?.url || (shortcode ? `https://www.instagram.com/reel/${shortcode}/` : "");
  let videoUrl = params.videoUrl || null;
  let thumbnailUrl = params.thumbnailUrl || null;
  let caption = params.caption || "";
  let views = params.views ?? null;
  let likes = params.likes ?? null;
  let comments = params.comments ?? null;
  let outlierScore = params.outlierScore ?? null;

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
  }

  const prefix = platform === "tiktok" ? "tt" : platform === "youtube" ? "yt" : "ig";
  const safeCode = (shortcode || crypto.createHash("md5").update(postUrl || String(Date.now())).digest("hex").slice(0, 11))
    .replace(/[^a-zA-Z0-9_-]/g, "");
  const packId = `${prefix}_${safeCode}`;
  const packFolder = path.join(REPRODUCE_DIR, packId);
  const framesDir = path.join(packFolder, "frames");
  const zipPath = path.join(REPRODUCE_DIR, `${packId}.zip`);

  // Return cached pack immediately unless force=true
  if (!params.force) {
    const existing = reproduceDb.find((p) => p.packId === packId);
    if (existing && fs.existsSync(zipPath) && fs.existsSync(path.join(packFolder, "scenes.txt"))) {
      return { ok: true, cached: true, pack: existing };
    }
  }

  // Resolve fresh videoUrl via Chrome extension if missing or expired
  const fetchFreshMediaInfo = async () => {
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
    if (info?.ok && info.videoUrl) {
      videoUrl = info.videoUrl;
      thumbnailUrl = info.thumbnailUrl || thumbnailUrl;
      username = info.username || username;
      caption = info.caption || caption;
      views = views ?? info.viewCount ?? null;
      likes = likes ?? info.likesCount ?? null;
      comments = comments ?? info.commentsCount ?? null;
    }
    return info;
  };

  if (!videoUrl) {
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

  // 6. Write exact VideoBot `transcript.txt` and `scenes.txt`
  await fsp.writeFile(transcriptPath, (fullTranscript || "(No spoken dialogue detected)") + "\n", "utf8");

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

  // 7. Write REPRODUCE_BRIEF.md & metadata.json inside pack
  const briefLines = [
    `# Reproduce Pack — ${packId}`,
    ``,
    `- **Creator**: ${username ? "@" + username : "Unknown"} (${platform})`,
    `- **Source URL**: ${postUrl}`,
    `- **Duration**: ${durationSec.toFixed(1)}s · **Scenes**: ${sceneRecords.length}`,
    ...(outlierScore != null ? [`- **Outlier Score**: ${outlierScore}x`] : []),
    ...(views != null ? [`- **Views**: ${views.toLocaleString()}`] : []),
    ...(onScreenHook ? [`- **On-Screen Hook (OCR)**: ${onScreenHook}`] : []),
    `- **Spoken Hook (0-5s)**: ${spokenHook || "—"}`,
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

  // 9. Persist in reproduce_db.json AND Master Posts DB
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
    { platform, username, source: "reproduce_pack" }
  );

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

  return {
    rank: index + 1,
    platform,
    shortcode: code,
    code,
    url,
    username: row.userName || row.username || "",
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
    caption: String(row.caption || "").trim(),
    videoUrl: row.videoUrl || null,
    audioUrl: row.audioUrl || row.videoUrl || null,
    thumbnailUrl: row.thumbnailUrl || row.thumbnailSmallUrl || null,
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
  const shortcode = extractShortcode(params.shortcode || params.postUrlOrShortcode) || params.shortcode || null;

  if (!videoUrl && shortcode) {
    const info = await runExtensionJob({ kind: "media_info", shortcode }, 45000);
    if (info?.ok && info.videoUrl) {
      videoUrl = info.videoUrl;
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
          if (baseline && baseline > 0 && item.viewsPerHour != null && item.velocityScore == null) {
            item.velocityScore = Number(((item.viewsPerHour * 24) / baseline).toFixed(2));
          }
          return item;
        });

        // Permanently save ALL scraped posts into Master Posts DB (never lose data!)
        const savedNow = await upsertPostsToDb(formatted, {
          platform: plat,
          username: handle,
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

    // List Reproduce Packs
    if (req.method === "GET" && pathname === "/api/reproduce/list") {
      return sendJson(res, 200, { ok: true, count: reproduceDb.length, packs: reproduceDb });
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
        minOutlier: Number(urlObj.searchParams.get("minOutlier") || 0),
        savedOnly: urlObj.searchParams.get("savedOnly") === "1",
        reproducedOnly: urlObj.searchParams.get("reproducedOnly") === "1",
        sortBy: urlObj.searchParams.get("sortBy") || "outlier",
        limit: Number(urlObj.searchParams.get("limit") || 300),
      });
      return sendJson(res, 200, { ok: true, ...result });
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
        const headers = {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "*/*",
          Referer: targetUrl.includes("tiktok") ? "https://www.tiktok.com/" : "https://www.instagram.com/",
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
      const enrichedSaved = savedLibrary.posts.map((p) => ({
        ...p,
        isSaved: true,
        reproducePackId: findPackForCode(p.code)?.packId || null,
        reproduceZipUrl: findPackForCode(p.code)?.zipUrl || null,
      }));
      return sendJson(res, 200, {
        ok: true,
        savedPosts: enrichedSaved,
        reproducePacks: reproduceDb,
        postsDbCount: Object.keys(postsDb).length,
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
      // Enrich from Master DB if extension save lacked outlierScore or videoUrl
      const dbHit = postsDb[`${normalized.platform}:${normalized.code}`];
      if (dbHit) {
        normalized.outlierScore = normalized.outlierScore ?? dbHit.outlierScore ?? null;
        normalized.velocityScore = normalized.velocityScore ?? dbHit.velocityScore ?? null;
        normalized.viewsPerHour = normalized.viewsPerHour ?? dbHit.viewsPerHour ?? null;
        normalized.videoUrl = normalized.videoUrl || dbHit.videoUrl || null;
        normalized.thumbnailUrl = normalized.thumbnailUrl || dbHit.thumbnailUrl || null;
        normalized.username = normalized.username || dbHit.username || "";
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

      return sendJson(res, 200, {
        ok: true,
        saved: true,
        post: normalized,
        count: savedLibrary.posts.length,
        limit: null,
      });
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

        const rows = Array.isArray(rawRes.rows) ? rawRes.rows : [];
        const baseline = rawRes.outlier?.baseline ?? null;
        const posts = rows.map((r, i) => {
          const formatted = formatPostSummary(r, i, platform);
          formatted.username = formatted.username || cleanUser;
          formatted.creatorBaseline = baseline;
          if (baseline && baseline > 0 && formatted.viewsPerHour != null && formatted.velocityScore == null) {
            formatted.velocityScore = Number(((formatted.viewsPerHour * 24) / baseline).toFixed(2));
          }
          return formatted;
        });

        // Permanently save all scraped posts into Master Posts DB
        await upsertPostsToDb(posts, {
          platform,
          username: cleanUser,
          creatorBaseline: baseline,
          source: "creator_spy",
        });

        const payload = {
          ok: true,
          platform,
          username: cleanUser,
          surface: rawRes.surface || surface,
          sortBy,
          totalScanned: rawRes.seenInFeed || rows.length,
          outlierBaseline: rawRes.outlier || null,
          durationMs: rawRes.ms || null,
          savedExports: rawRes.savedExports || {},
          posts,
        };

        await recordScanInHistory(payload);
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
