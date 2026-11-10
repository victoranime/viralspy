#!/usr/bin/env node
/**
 * ViralSpy v2.0 — Local Studio Hub + Whisper & Vision Engine + MCP Server
 *
 * 1. Apple-Minimalist Web Dashboard (`http://127.0.0.1:8765/dashboard`)
 * 2. WebSocket Bridge (`ws://127.0.0.1:8765/ext`) to the ViralSpy Chrome Extension
 * 3. Free Local Whisper Transcription (`whisper-cli` on Apple Silicon Metal GPU)
 * 4. Visual Hook Extractor (`ffmpeg` 0s / 1.5s / 3s frames + macOS Vision Neural OCR)
 * 5. Multi-Competitor Niche Radar, Velocity Scoring, Comment Goldmine & Multi-Platform Sorter
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.VIRALSPY_PORT || "8765", 10);
const HOST = "127.0.0.1";
const DASHBOARD_DIR = path.join(__dirname, "dashboard");
const DATA_DIR = path.join(__dirname, "data");
const EXPORTS_DIR = path.join(DATA_DIR, "exports");
const HOOKS_DIR = path.join(DATA_DIR, "hooks");
const TRANSCRIPTS_FILE = path.join(DATA_DIR, "transcripts.json");
const SAVED_LIBRARY_FILE = path.join(DATA_DIR, "saved_library.json");
const VISUAL_HOOKS_FILE = path.join(DATA_DIR, "visual_hooks.json");
const COMMENTS_CACHE_FILE = path.join(DATA_DIR, "comments_cache.json");
const SCAN_HISTORY_FILE = path.join(DATA_DIR, "scan_history.json");
const RADAR_HISTORY_FILE = path.join(DATA_DIR, "radar_history.json");
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
const SWIFTC_BIN = resolveBin(process.env.SWIFTC_BIN, ["/usr/bin/swiftc"], null);
const WHISPER_MODEL = resolveWhisperModel();

await fsp.mkdir(EXPORTS_DIR, { recursive: true });
await fsp.mkdir(HOOKS_DIR, { recursive: true });

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

const liveRadarStatus = {
  running: false,
  step: "",
  completed: 0,
  total: 0,
  currentAccount: "",
  startedAt: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: Pacing, Velocity, Shortcode, Media Download
// ─────────────────────────────────────────────────────────────────────────────

function extractShortcode(input) {
  const s = String(input || "").trim();
  const m = s.match(/instagram\.com\/(?:[^/]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{6,20}$/.test(s) && !/^https?:/i.test(s)) return s;
  return null;
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Local Whisper.cpp Transcription Engine (100% Free, Metal GPU Accelerated)
// ─────────────────────────────────────────────────────────────────────────────

async function transcribeMediaLocal({
  cacheKey = null,
  mediaUrl = null,
  mediaBase64 = null,
  platform = "instagram",
  profileName = "",
  language = "auto",
  force = false,
}) {
  const normKey = cacheKey ? String(cacheKey).trim() : null;
  if (!force && normKey && transcriptCache[normKey]?.transcription) {
    const hit = enrichTranscriptMetrics(transcriptCache[normKey]);
    return {
      ok: true,
      cached: true,
      cacheKey: normKey,
      ...hit,
    };
  }

  const tmpId = "vs_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const tmpInput = path.join(os.tmpdir(), `${tmpId}.media`);
  const tmpWav = path.join(os.tmpdir(), `${tmpId}.wav`);
  const tmpOutPrefix = path.join(os.tmpdir(), `${tmpId}_out`);
  const tmpJson = `${tmpOutPrefix}.json`;

  try {
    if (mediaBase64) {
      const cleanB64 = String(mediaBase64).replace(/^data:[^;]+;base64,/, "");
      await fsp.writeFile(tmpInput, Buffer.from(cleanB64, "base64"));
    } else if (mediaUrl) {
      await downloadMediaToFile(mediaUrl, tmpInput);
    } else {
      return { ok: false, errorCode: "media_fetch_failed", message: "No mediaUrl or mediaBase64 provided." };
    }

    await execFileAsync(
      FFMPEG_BIN,
      ["-y", "-i", tmpInput, "-t", "600", "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmpWav],
      { timeout: 60000 }
    );

    await execFileAsync(
      WHISPER_BIN,
      ["-m", WHISPER_MODEL, "-l", language || "auto", "-oj", "-of", tmpOutPrefix, tmpWav],
      { timeout: 150000 }
    );

    const rawJson = JSON.parse(await fsp.readFile(tmpJson, "utf8"));
    const rawSegs = Array.isArray(rawJson?.transcription) ? rawJson.transcription : [];
    const segments = rawSegs
      .map((s) => ({
        start: Number(((s?.offsets?.from ?? 0) / 1000).toFixed(2)),
        end: Number(((s?.offsets?.to ?? 0) / 1000).toFixed(2)),
        text: String(s?.text || "").trim(),
      }))
      .filter((s) => s.text && !/^\[.*\]$/.test(s.text));

    const transcription = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
    const duration_seconds = segments.length ? Math.ceil(segments[segments.length - 1].end) : 0;
    const detectedLang = rawJson?.result?.language || language || "en";
    const hook = extractHookFromSegments(segments, 5.0);

    if (!transcription) {
      return { ok: false, errorCode: "empty_transcript", message: "No spoken words detected in audio." };
    }

    const record = enrichTranscriptMetrics({
      transcription,
      hook,
      segments,
      duration_seconds,
      language: detectedLang,
      platform,
      profileName,
      at: new Date().toISOString(),
    });

    if (normKey) {
      transcriptCache[normKey] = record;
      await saveJson(TRANSCRIPTS_FILE, transcriptCache);
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
    for (const f of [tmpInput, tmpWav, tmpJson]) {
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

    // Run Apple Vision OCR if available
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

    // Deduplicate OCR lines across the 3 frames into a clean On-Screen Hook Text
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
    await saveJson(VISUAL_HOOKS_FILE, visualHooksCache);

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
  const code = row.code || "";
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
    isSaved: !!(code && savedLibrary.posts.some((p) => p.code === code || p.shortcode === code)),
  };
}

async function recordScanInHistory(entry) {
  const id = `${entry.platform || "instagram"}:${entry.username}:${entry.surface || "reels"}`;
  const filtered = scanHistory.filter((x) => x.id !== id);
  filtered.unshift({ id, ...entry, scannedAt: new Date().toISOString() });
  scanHistory.length = 0;
  scanHistory.push(...filtered.slice(0, 30));
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
      service: "ViralSpy Studio Hub & MCP v2.0",
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

async function runNicheRadar({
  usernames = [],
  seedUsername = "",
  autoSimilarCount = 5,
  daysBack = 30,
  perAccountDepth = 36,
  sortBy = "outlier",
}) {
  let targets = (Array.isArray(usernames) ? usernames : [])
    .map((u) => String(u || "").replace(/^@/, "").trim().toLowerCase())
    .filter(Boolean);

  const cleanSeed = String(seedUsername || "").replace(/^@/, "").trim().toLowerCase();
  let discoveredAccounts = [];

  liveRadarStatus.running = true;
  liveRadarStatus.startedAt = new Date().toISOString();
  liveRadarStatus.completed = 0;
  liveRadarStatus.total = Math.max(1, targets.length);
  liveRadarStatus.step = "Initializing Niche Radar";

  try {
    if (cleanSeed && targets.length === 0) {
      liveRadarStatus.step = `Discovering competitors similar to @${cleanSeed}`;
      liveRadarStatus.currentAccount = cleanSeed;
      const simRes = await runExtensionJob({ kind: "similar", username: cleanSeed }, 60000);
      if (simRes?.ok && Array.isArray(simRes.accounts)) {
        discoveredAccounts = simRes.accounts.filter((a) => !a.is_private);
        targets = [
          cleanSeed,
          ...discoveredAccounts.slice(0, Math.max(1, Math.min(15, autoSimilarCount))).map((a) => a.username.toLowerCase()),
        ];
      } else {
        targets = [cleanSeed];
      }
    }

    targets = Array.from(new Set(targets)).slice(0, 16);
    if (!targets.length) {
      return { ok: false, message: "Provide at least one username or a seedUsername." };
    }

    liveRadarStatus.total = targets.length;
    const sinceMs = daysBack > 0 ? Date.now() - daysBack * 86400 * 1000 : null;
    const accountSummaries = [];
    const mergedPosts = [];

    for (let i = 0; i < targets.length; i++) {
      const handle = targets[i];
      const nextHandle = targets[i + 1] || null;
      liveRadarStatus.currentAccount = handle;
      liveRadarStatus.completed = i;
      liveRadarStatus.step = `Scanning @${handle} (${i + 1}/${targets.length})`;

      const res = await runExtensionJob(
        {
          username: handle,
          surface: "reels",
          sortBy: "outlier",
          outlier: "on",
          depth: perAccountDepth,
          ...(nextHandle ? { next: nextHandle } : {}),
        },
        240000
      );

      if (!res?.ok) {
        accountSummaries.push({
          username: handle,
          ok: false,
          error: res?.error?.message || "Scan failed",
        });
        continue;
      }

      const rawRows = Array.isArray(res.rows) ? res.rows : [];
      const baseline = res.outlier?.baseline ?? null;
      const formatted = rawRows.map((r, idx) => {
        const item = formatPostSummary(r, idx, "instagram");
        item.creatorBaseline = baseline;
        if (baseline && baseline > 0 && item.viewsPerHour != null && item.velocityScore == null) {
          item.velocityScore = Number(((item.viewsPerHour * 24) / baseline).toFixed(2));
        }
        return item;
      });

      const inWindow = sinceMs
        ? formatted.filter((p) => {
            const ms = p.createDate ? Date.parse(p.createDate) : NaN;
            return Number.isFinite(ms) ? ms >= sinceMs : true;
          })
        : formatted;

      accountSummaries.push({
        username: handle,
        ok: true,
        scannedCount: rawRows.length,
        inWindowCount: inWindow.length,
        baseline,
        topOutlier: inWindow[0]?.outlierScore ?? null,
      });

      mergedPosts.push(...inWindow);
    }

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
      seedUsername: cleanSeed || targets[0],
      targets,
      daysBack,
      perAccountDepth,
      sortBy,
      totalCreatorsScanned: accountSummaries.filter((a) => a.ok).length,
      totalPostsInWindow: mergedPosts.length,
      accountSummaries,
      leaderboard: mergedPosts.slice(0, 120),
    };

    if (isPrimaryHub) {
      radarHistory.unshift(radarRun);
      if (radarHistory.length > 15) radarHistory.length = 15;
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
  ".json": "application/json; charset=utf-8",
};

async function serveStaticFile(res, filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_MAP[ext] || "application/octet-stream";
    const buf = await fsp.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
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
    if (req.method === "GET" && (pathname === "/dashboard" || pathname === "/dashboard/" || (pathname === "/" && accept.includes("text/html")))) {
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

    // 1b. Workspace Library & History Payload for Studio Dashboard
    if (req.method === "GET" && pathname === "/api/library") {
      return sendJson(res, 200, {
        ok: true,
        savedPosts: savedLibrary.posts,
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
      res.end(`<!doctype html><html><body style="font-family:-apple-system,system-ui;padding:24px;">Focused ViralSpy tab in Chrome. You can close this tab.</body></html>`);
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

    // 4. Local Save Library Endpoints (shared between Extension & Studio Dashboard)
    if (req.method === "POST" && pathname.startsWith("/save-status")) {
      return sendJson(res, 200, { ok: true, hasLibrary: savedLibrary.posts.length > 0 });
    }
    if (req.method === "POST" && pathname.startsWith("/save")) {
      if (pathname.endsWith("/lookup")) {
        const codes = Array.isArray(body.codes) ? body.codes : [];
        const savedMap = {};
        for (const c of codes) {
          if (savedLibrary.posts.some((p) => p.code === c || p.shortcode === c || p.id === c)) {
            savedMap[c] = true;
          }
        }
        return sendJson(res, 200, { ok: true, saved: savedMap });
      }
      if (pathname.endsWith("/unsave")) {
        const code = body.code || body.shortcode || body.id;
        savedLibrary.posts = savedLibrary.posts.filter((p) => p.code !== code && p.shortcode !== code && p.id !== code);
        await saveJson(SAVED_LIBRARY_FILE, savedLibrary);
        return sendJson(res, 200, { ok: true, count: savedLibrary.posts.length });
      }
      const code = body.code || body.shortcode || body.id;
      savedLibrary.posts = savedLibrary.posts.filter((p) => p.code !== code && p.shortcode !== code);
      const entry = { ...body, code, shortcode: code, savedAt: new Date().toISOString() };
      savedLibrary.posts.unshift(entry);
      await saveJson(SAVED_LIBRARY_FILE, savedLibrary);
      return sendJson(res, 200, { ok: true, saved: true, count: savedLibrary.posts.length });
    }

    // 5. Studio Dashboard & Secondary MCP API Endpoints
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
        const platform = String(body.platform || "instagram").toLowerCase();
        const cleanUser = String(body.username || "").replace(/^@/, "").trim();
        const surface = body.surface || (platform === "youtube" ? "shorts" : platform === "tiktok" ? "videos" : "reels");
        const sortBy = body.sortBy || "outlier";
        const depth = Math.max(12, Math.min(2000, parseInt(body.depth, 10) || 60));

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

        const rawRes = await runExtensionJob(job, 240000);
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
          if (baseline && baseline > 0 && formatted.viewsPerHour != null && formatted.velocityScore == null) {
            formatted.velocityScore = Number(((formatted.viewsPerHour * 24) / baseline).toFixed(2));
          }
          return formatted;
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
        const cleanUser = String(body.username || "").replace(/^@/, "").trim().toLowerCase();
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
          return sendJson(res, 200, { ok: true, cached: true, cacheKey: shortcode, ...enrichTranscriptMetrics(transcriptCache[shortcode]) });
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
        caps: { hour: 2000, day: 10000 },
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
        extState.version = msg.version || "20.0";
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
// MCP Server Definition & 12 Tools
// ─────────────────────────────────────────────────────────────────────────────

function createViralSpyMcpServer() {
  const mcp = new McpServer({
    name: "viralspy",
    version: "2.0.0",
  });

  // Tool 1: viralspy_status
  mcp.tool(
    "viralspy_status",
    "Check ViralSpy Studio Hub, Chrome extension connection, local Whisper GPU model, and Apple Vision OCR readiness.",
    {},
    async () => {
      const status = await getHubStatus();
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }
  );

  // Tool 2: viralspy_sort_instagram
  mcp.tool(
    "viralspy_sort_instagram",
    "Sort any Instagram profile's Reels or Posts by Outlier Score, Velocity (fastest rising in 24-72h), Views, Likes, Comments, or Oldest.",
    {
      username: z.string().describe("Instagram handle to sort (e.g. 'andre_gizmo')."),
      surface: z.enum(["reels", "posts"]).default("reels"),
      sortBy: z.enum(["outlier", "velocity", "views", "likes", "comments", "oldest"]).default("outlier"),
      depth: z.number().int().min(12).max(2000).default(60),
      limit: z.number().int().min(1).max(200).default(15),
      since: z.string().optional(),
      until: z.string().optional(),
    },
    async ({ username, surface = "reels", sortBy = "outlier", depth = 60, limit = 15, since, until }) => {
      const cleanUser = username.replace(/^@/, "").trim().toLowerCase();
      const job = {
        username: cleanUser,
        surface,
        sortBy,
        outlier: sortBy === "outlier" || sortBy === "velocity" ? "on" : "auto",
        depth,
        ...(since ? { since: new Date(since).getTime() } : {}),
        ...(until ? { until: new Date(until).getTime() } : {}),
      };
      const res = await runExtensionJob(job, 240000);
      if (!res || !res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `ViralSpy sort failed for @${cleanUser}: ${res?.error?.message || JSON.stringify(res)}` }],
        };
      }
      const rows = Array.isArray(res.rows) ? res.rows : [];
      const topPosts = rows.slice(0, limit).map((r, i) => formatPostSummary(r, i, "instagram"));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                username: cleanUser,
                surface: res.surface || surface,
                sortBy,
                totalScanned: res.seenInFeed || rows.length,
                outlierBaseline: res.outlier || null,
                savedExports: res.savedExports || {},
                topPosts,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 3: viralspy_sort_multiplatform (TikTok & YouTube Shorts/Videos)
  mcp.tool(
    "viralspy_sort_multiplatform",
    "Sort any TikTok creator profile or YouTube channel (Shorts or Videos) by Outlier Score, Velocity, Views, or Likes.",
    {
      platform: z.enum(["tiktok", "youtube"]).describe("Target platform: 'tiktok' or 'youtube'."),
      username: z.string().describe("Creator handle (e.g. '@mrbeast' or 'khaby.lame')."),
      surface: z.enum(["shorts", "videos"]).default("shorts").describe("For YouTube: 'shorts' or 'videos'."),
      sortBy: z.enum(["outlier", "velocity", "views", "likes"]).default("outlier"),
      depth: z.number().int().min(12).max(200).default(48),
      limit: z.number().int().min(1).max(100).default(15),
    },
    async ({ platform, username, surface = "shorts", sortBy = "outlier", depth = 48, limit = 15 }) => {
      const cleanUser = username.replace(/^@/, "").trim();
      const res = await runExtensionJob({ kind: platform, username: cleanUser, surface, sortBy, depth }, 180000);
      if (!res?.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `${platform} sort failed for @${cleanUser}: ${res?.error?.message || JSON.stringify(res)}` }],
        };
      }
      const rows = Array.isArray(res.rows) ? res.rows : [];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: true,
                platform,
                username: cleanUser,
                surface,
                sortBy,
                totalScanned: rows.length,
                outlierBaseline: res.outlier || null,
                topPosts: rows.slice(0, limit).map((r, i) => formatPostSummary(r, i, platform)),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 4: viralspy_niche_radar
  mcp.tool(
    "viralspy_niche_radar",
    "Scan 3 to 15 competitor Instagram accounts at once (from an explicit list or auto-discovered from a single seed account) and return a unified Niche Outlier & Velocity Leaderboard.",
    {
      usernames: z.array(z.string()).optional().describe("List of competitor Instagram handles to scan together."),
      seedUsername: z.string().optional().describe("Single seed Instagram handle to auto-discover similar competitors from when usernames is omitted."),
      autoSimilarCount: z.number().int().min(2).max(12).default(5).describe("How many similar competitors to auto-scan when using seedUsername."),
      daysBack: z.number().int().min(0).max(365).default(30).describe("Only include Reels posted within the last N days (0 for all time)."),
      perAccountDepth: z.number().int().min(12).max(120).default(36).describe("How many Reels to scan per competitor."),
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
            text: JSON.stringify(
              {
                ...out,
                leaderboard: (out.leaderboard || []).slice(0, limit),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 5: viralspy_visual_hook
  mcp.tool(
    "viralspy_visual_hook",
    "Extract the 3 visual hook frames (0.0s, 1.5s, 3.0s) from any Instagram Reel using local ffmpeg and read all burned-in on-screen text overlays using Apple Vision OCR.",
    {
      postUrlOrShortcode: z.string().optional().describe("Instagram Reel URL or shortcode."),
      videoUrl: z.string().optional().describe("Optional direct MP4 URL from a previous sort."),
      includeImagesInline: z.boolean().default(true).describe("Return extracted JPEG frames inline for multimodal vision analysis."),
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

  // Tool 6: viralspy_mine_comments
  mcp.tool(
    "viralspy_mine_comments",
    "Comment Goldmine: extract the highest-liked comments on any viral Instagram Reel/Post and automatically surface unanswered audience questions and product/topic requests.",
    {
      postUrlOrShortcode: z.string().describe("Instagram Reel/Post URL or shortcode."),
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

  // Tool 7: viralspy_similar_accounts
  mcp.tool(
    "viralspy_similar_accounts",
    "Discover similar Instagram creator accounts for any username using Instagram's native chaining recommendation graph.",
    { username: z.string().describe("Instagram username (e.g. 'andre_gizmo').") },
    async ({ username }) => {
      const cleanUser = username.replace(/^@/, "").trim().toLowerCase();
      const res = await runExtensionJob({ kind: "similar", username: cleanUser }, 60000);
      return {
        isError: !res?.ok,
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    }
  );

  // Tool 8: viralspy_search_instagram
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
                topPosts: rows.slice(0, limit).map((r, i) => formatPostSummary(r, i, "instagram")),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 9: viralspy_saved_instagram
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
                topPosts: rows.slice(0, limit).map((r, i) => formatPostSummary(r, i, "instagram")),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 10: viralspy_transcribe_post
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
            content: [{ type: "text", text: JSON.stringify({ ok: true, cached: true, shortcode, ...enrichTranscriptMetrics(transcriptCache[shortcode]) }, null, 2) }],
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
      const trans = await runTranscription({ cacheKey: shortcode || null, mediaUrl: resolvedUrl, platform: "instagram", profileName: meta?.username || "", language });
      return {
        isError: !trans.ok,
        content: [{ type: "text", text: JSON.stringify({ ...trans, shortcode: shortcode || meta?.shortcode || null }, null, 2) }],
      };
    }
  );

  // Tool 11: viralspy_spy_report
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
      const cleanUser = username.replace(/^@/, "").trim().toLowerCase();
      const sortRes = await runExtensionJob({ username: cleanUser, surface: "reels", sortBy: "outlier", outlier: "on", depth }, 240000);
      if (!sortRes?.ok) {
        return { isError: true, content: [{ type: "text", text: `Spy Report failed on @${cleanUser}: ${sortRes?.error?.message}` }] };
      }
      const rows = Array.isArray(sortRes.rows) ? sortRes.rows : [];
      const topPosts = rows.slice(0, topPostsCount).map((r, i) => formatPostSummary(r, i, "instagram"));

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

  // Tool 12: viralspy_focus_tab
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
  console.log(`[ViralSpy] Studio Dashboard live at http://${HOST}:${PORT}/dashboard (WS ws://${HOST}:${PORT}/ext)`);
} else {
  const mcpServer = createViralSpyMcpServer();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
