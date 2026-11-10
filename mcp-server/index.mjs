#!/usr/bin/env node
/**
 * ViralSpy Local Hub + MCP Server (Antigravity & Claude)
 *
 * 1. WebSocket Bridge (`ws://127.0.0.1:8765/ext`):
 *    Connects to the ViralSpy Chrome Extension (background_agent.js) to sort
 *    Instagram profiles (Reels & Posts), Keyword Searches, Saved Collections,
 *    and fetch native Similar Accounts using your live browser session.
 *
 * 2. Local Free Whisper Transcription (`http://127.0.0.1:8765/trans/*`):
 *    Powers both the in-page "Transcribe" buttons (Instagram, TikTok, Facebook)
 *    and the `viralspy_transcribe_post` / `viralspy_spy_report` MCP tools using
 *    local `ffmpeg` + `whisper-cli` (whisper.cpp with Apple Metal GPU) — 100% free.
 *
 * 3. Multi-Client Safe Architecture:
 *    If port 8765 is free, this process hosts the HTTP + WebSocket Hub on 8765.
 *    If port 8765 is already bound by the ViralSpy daemon or another MCP session,
 *    this process proxies tool calls over HTTP (`http://127.0.0.1:8765/api/...`)
 *    so Antigravity, Claude Desktop, and the CLI can all work simultaneously.
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
const DATA_DIR = path.join(__dirname, "data");
const EXPORTS_DIR = path.join(DATA_DIR, "exports");
const TRANSCRIPTS_FILE = path.join(DATA_DIR, "transcripts.json");
const SAVED_LIBRARY_FILE = path.join(DATA_DIR, "saved_library.json");

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
const WHISPER_BIN = resolveBin(
  process.env.WHISPER_BIN,
  ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli", "/opt/homebrew/bin/whisper-cpp"],
  "whisper-cli"
);
const WHISPER_MODEL = resolveWhisperModel();

await fsp.mkdir(EXPORTS_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// Persistent Local JSON Stores (Transcripts Cache & Saved Library)
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

// ─────────────────────────────────────────────────────────────────────────────
// Local Whisper.cpp Transcription Engine (100% Free, Metal GPU Accelerated)
// ─────────────────────────────────────────────────────────────────────────────

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
    },
  });
  if (!res.ok) {
    throw new Error(`Media download failed with HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  await fsp.writeFile(destPath, Buffer.from(arrayBuffer));
}

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
    const hit = transcriptCache[normKey];
    return {
      ok: true,
      cached: true,
      cacheKey: normKey,
      transcription: hit.transcription,
      hook: hit.hook || extractHookFromSegments(hit.segments),
      duration_seconds: hit.duration_seconds ?? null,
      language: hit.language || "auto",
      segments: hit.segments || [],
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

    // Convert to 16kHz mono PCM WAV (capped at 10 minutes max for safety)
    await execFileAsync(
      FFMPEG_BIN,
      ["-y", "-i", tmpInput, "-t", "600", "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", tmpWav],
      { timeout: 60000 }
    );

    // Run whisper-cli with Apple Silicon Metal GPU
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

    const record = {
      transcription,
      hook,
      segments,
      duration_seconds,
      language: detectedLang,
      platform,
      profileName,
      at: new Date().toISOString(),
    };

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
// Extension WebSocket State & Job Dispatcher (When Running as Primary Hub)
// ─────────────────────────────────────────────────────────────────────────────

const extState = {
  ws: null,
  connectedAt: null,
  version: null,
  browser: null,
  lastSeenAt: null,
  pendingJobs: new Map(), // jobId -> { resolve, reject, timer, progress: [] }
  pendingFocus: new Map(), // requestId -> { resolve, timer }
};

function isExtensionConnected() {
  return !!(extState.ws && extState.ws.readyState === 1);
}

function dispatchExtensionJobLocal(jobPayload, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    if (!isExtensionConnected()) {
      return reject(
        new Error(
          "ViralSpy Chrome Extension is not connected to ws://127.0.0.1:8765/ext. Make sure Chrome is open and the ViralSpy extension is loaded and enabled."
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

// Save CSV/JSON exports produced by a sort job to disk
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

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + WebSocket Hub Server on 127.0.0.1:8765
// ─────────────────────────────────────────────────────────────────────────────

let isPrimaryHub = false;

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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(obj));
}

async function startLocalHub() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      return sendJson(res, 200, { ok: true });
    }

    const urlObj = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const pathname = urlObj.pathname;

    // 1. Health & Status
    if (req.method === "GET" && (pathname === "/" || pathname === "/api/status" || pathname === "/access")) {
      return sendJson(res, 200, {
        ok: true,
        service: "ViralSpy Local Hub & MCP",
        mode: "everyone",
        port: PORT,
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
        savedLibraryCount: savedLibrary.posts.length,
      });
    }

    // 2. Watch in Chrome helper route
    if (req.method === "GET" && pathname.startsWith("/watch")) {
      await focusExtensionTabLocal(true);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body style="font-family:system-ui;padding:24px;">Focused ViralSpy sorting tab in Chrome. You can close this tab.</body></html>`);
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

    // 3. In-Page Transcription Refund (no-op locally since it's 100% free)
    if (req.method === "POST" && pathname.endsWith("/refund")) {
      return sendJson(res, 200, { ok: true, refunded: true });
    }

    // 4. In-Page Transcription Quota Check (unlimited free locally)
    if (req.method === "POST" && pathname.startsWith("/trans-quota")) {
      return sendJson(res, 200, {
        ok: true,
        monthly_quota_mins: null,
        monthly_usage_secs: 0,
      });
    }

    // 5. In-Page Transcript Cache Lookup
    if (req.method === "POST" && pathname.startsWith("/trans-cache")) {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const hits = {};
      for (const id of ids) {
        const k = String(id || "").trim();
        if (k && transcriptCache[k]) {
          hits[k] = transcriptCache[k];
        }
      }
      return sendJson(res, 200, { ok: true, hits });
    }

    // 6. In-Page Single & Bulk Select Transcription (Instagram, TikTok, Facebook)
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

    // 7. Local Save Library Endpoints (for the in-page Save button on IG & TikTok)
    if (req.method === "POST" && pathname.startsWith("/save-status")) {
      return sendJson(res, 200, { ok: true, hasLibrary: savedLibrary.posts.length > 0 });
    }
    if (req.method === "POST" && pathname.startsWith("/save")) {
      if (pathname.endsWith("/lookup")) {
        const codes = Array.isArray(body.codes) ? body.codes : [];
        const savedMap = {};
        for (const c of codes) {
          if (savedLibrary.posts.some((p) => p.code === c || p.id === c)) {
            savedMap[c] = true;
          }
        }
        return sendJson(res, 200, { ok: true, saved: savedMap });
      }
      if (pathname.endsWith("/unsave")) {
        const code = body.code || body.id;
        savedLibrary.posts = savedLibrary.posts.filter((p) => p.code !== code && p.id !== code);
        await saveJson(SAVED_LIBRARY_FILE, savedLibrary);
        return sendJson(res, 200, { ok: true });
      }
      // Save post
      const entry = { ...body, savedAt: new Date().toISOString() };
      savedLibrary.posts.unshift(entry);
      await saveJson(SAVED_LIBRARY_FILE, savedLibrary);
      return sendJson(res, 200, { ok: true, saved: true });
    }

    // 8. Internal API for Secondary MCP Processes / CLI
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

    if (req.method === "POST" && pathname === "/api/focus") {
      const out = await focusExtensionTabLocal(body.any !== false);
      return sendJson(res, 200, out);
    }

    if (req.method === "POST" && pathname === "/api/transcribe") {
      const out = await transcribeMediaLocal(body);
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

    // Send welcome packet to unlock full limits & mark Claude/MCP active
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
        extState.version = msg.version || "19.0";
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
// Unified Client Helpers (Works Whether Primary Hub or Secondary MCP Process)
// ─────────────────────────────────────────────────────────────────────────────

async function getHubStatus() {
  if (isPrimaryHub) {
    return {
      ok: true,
      service: "ViralSpy Local Hub & MCP (Primary)",
      port: PORT,
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
      savedLibraryCount: savedLibrary.posts.length,
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

function extractShortcode(input) {
  const s = String(input || "").trim();
  const m = s.match(/instagram\.com\/(?:[^/]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{6,20}$/.test(s) && !/^https?:/i.test(s)) return s;
  return null;
}

function formatPostSummary(row, index) {
  const code = row.code || "";
  const url = code ? `https://www.instagram.com/reel/${code}/` : "";
  const outlierStr =
    typeof row.outlierScore === "number" ? `${row.outlierScore.toFixed(2)}x` : row.outlierScore || "n/a";
  return {
    rank: index + 1,
    shortcode: code,
    url,
    username: row.userName || "",
    createDate: row.createDate || "",
    outlierScore: row.outlierScore ?? null,
    outlierLabel: outlierStr,
    views: row.viewCount ?? null,
    likes: row.likesCount ?? null,
    comments: row.commentsCount ?? null,
    pinned: !!row.pinned,
    mediaType: row.mediaType === 2 ? "video/reel" : row.mediaType === 8 ? "carousel" : "image",
    carouselCount: row.carouselCount ?? null,
    videoDuration: row.videoDuration ?? null,
    caption: String(row.caption || "").trim(),
    videoUrl: row.videoUrl || null,
    audioUrl: row.audioUrl || null,
    thumbnailUrl: row.thumbnailUrl || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server Definition & Tools
// ─────────────────────────────────────────────────────────────────────────────

function createViralSpyMcpServer() {
  const mcp = new McpServer({
    name: "viralspy",
    version: "1.0.0",
  });

  // Tool 1: viralspy_status
  mcp.tool(
    "viralspy_status",
    "Check whether the ViralSpy Chrome extension is connected and ready, along with local Whisper transcription and cache status.",
    {},
    async () => {
      const status = await getHubStatus();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
    }
  );

  // Tool 2: viralspy_sort_instagram
  mcp.tool(
    "viralspy_sort_instagram",
    "Sort any Instagram profile's Reels or Posts by Outlier Score, Views, Likes, Comments, or Oldest using the connected ViralSpy Chrome extension. Returns the creator's baseline, top viral posts, captions, metrics, direct MP4 videoUrl/audioUrl, and local CSV/JSON export paths.",
    {
      username: z
        .string()
        .describe("Instagram handle to sort (e.g. 'andre_gizmo' or '@andre_gizmo')."),
      surface: z
        .enum(["reels", "posts"])
        .default("reels")
        .describe("Which profile tab to sort: 'reels' (includes view counts & view-based outlier score) or 'posts'."),
      sortBy: z
        .enum(["outlier", "views", "likes", "comments", "oldest"])
        .default("outlier")
        .describe("Metric to sort by. Default is 'outlier' (views divided by creator's median baseline)."),
      depth: z
        .number()
        .int()
        .min(12)
        .max(2000)
        .default(60)
        .describe("How many latest Reels/Posts to scan on the profile (e.g. 50, 100, 200, 500)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(15)
        .describe("Number of top sorted posts to return in the response payload."),
      since: z
        .string()
        .optional()
        .describe("Optional ISO date or YYYY-MM-DD start window filter."),
      until: z
        .string()
        .optional()
        .describe("Optional ISO date or YYYY-MM-DD end window filter."),
    },
    async ({ username, surface = "reels", sortBy = "outlier", depth = 60, limit = 15, since, until }) => {
      const cleanUser = username.replace(/^@/, "").trim().toLowerCase();
      const job = {
        username: cleanUser,
        surface,
        sortBy,
        outlier: sortBy === "outlier" ? "on" : "auto",
        depth,
        ...(since ? { since: new Date(since).getTime() } : {}),
        ...(until ? { until: new Date(until).getTime() } : {}),
      };

      const res = await runExtensionJob(job, 240000);
      if (!res || !res.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `ViralSpy sort failed for @${cleanUser}: ${res?.error?.message || JSON.stringify(res)}`,
            },
          ],
        };
      }

      const rows = Array.isArray(res.rows) ? res.rows : [];
      const topPosts = rows.slice(0, limit).map((r, i) => formatPostSummary(r, i));

      const payload = {
        ok: true,
        username: cleanUser,
        surface: res.surface || surface,
        sortBy: res.sortBy || sortBy,
        totalScanned: res.seenInFeed || rows.length,
        totalReturned: rows.length,
        showingTop: topPosts.length,
        outlierBaseline: res.outlier || null,
        durationMs: res.ms || null,
        savedExports: res.savedExports || {},
        topPosts,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
  );

  // Tool 3: viralspy_similar_accounts
  mcp.tool(
    "viralspy_similar_accounts",
    "Discover similar Instagram creator accounts for any username using Instagram's native chaining recommendation graph.",
    {
      username: z.string().describe("Instagram username (e.g. 'andre_gizmo')."),
    },
    async ({ username }) => {
      const cleanUser = username.replace(/^@/, "").trim().toLowerCase();
      const res = await runExtensionJob({ kind: "similar", username: cleanUser }, 60000);
      if (!res || !res.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Could not fetch similar accounts for @${cleanUser}: ${res?.error?.message || JSON.stringify(res)}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    }
  );

  // Tool 4: viralspy_search_instagram
  mcp.tool(
    "viralspy_search_instagram",
    "Search Instagram by keyword and sort matching posts/reels across creators by likes, comments, or oldest.",
    {
      query: z.string().describe("Keyword or niche phrase to search on Instagram."),
      sortBy: z.enum(["likes", "comments", "oldest"]).default("likes"),
      depth: z.number().int().min(12).max(500).default(50),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ query, sortBy = "likes", depth = 50, limit = 20 }) => {
      const res = await runExtensionJob({ kind: "search", query, sortBy, depth }, 180000);
      if (!res || !res.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Instagram search sort failed for "${query}": ${res?.error?.message || JSON.stringify(res)}`,
            },
          ],
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
                query,
                sortBy,
                totalCollected: rows.length,
                savedExports: res.savedExports || {},
                topPosts: rows.slice(0, limit).map((r, i) => formatPostSummary(r, i)),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 5: viralspy_saved_instagram
  mcp.tool(
    "viralspy_saved_instagram",
    "List your saved Instagram collections or sort your Saved Posts / a specific Saved Collection.",
    {
      action: z
        .enum(["list_collections", "sort_all", "sort_collection"])
        .default("list_collections")
        .describe("Whether to list saved collections, sort all saved posts, or sort one named collection."),
      collection: z
        .string()
        .optional()
        .describe("Collection name or ID (required when action is 'sort_collection')."),
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
      if (!res || !res.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Saved Instagram action failed: ${res?.error?.message || JSON.stringify(res)}`,
            },
          ],
        };
      }

      if (action === "list_collections") {
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
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
                viewer: res.viewer,
                collection: res.collection || "all_posts",
                totalCollected: rows.length,
                savedExports: res.savedExports || {},
                topPosts: rows.slice(0, limit).map((r, i) => formatPostSummary(r, i)),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 6: viralspy_transcribe_post
  mcp.tool(
    "viralspy_transcribe_post",
    "Transcribe any Instagram Reel/Post (by URL, shortcode, or direct audioUrl/videoUrl) 100% locally and free using Whisper. Returns the spoken Hook (first 5 seconds), Full Transcript, duration, and timestamped segments.",
    {
      postUrlOrShortcode: z
        .string()
        .optional()
        .describe("Instagram Reel/Post URL (e.g. 'https://www.instagram.com/reel/ABC123/') or shortcode ('ABC123')."),
      mediaUrl: z
        .string()
        .optional()
        .describe("Optional direct audioUrl or videoUrl from a previous viralspy_sort_instagram call."),
      language: z
        .string()
        .default("auto")
        .describe("Language code ('en', 'fr', 'es', or 'auto' for auto-detection)."),
    },
    async ({ postUrlOrShortcode, mediaUrl, language = "auto" }) => {
      const shortcode = extractShortcode(postUrlOrShortcode);
      let resolvedUrl = mediaUrl || null;
      let meta = null;

      if (!resolvedUrl && shortcode) {
        // Check cache first before hitting browser
        if (transcriptCache[shortcode]?.transcription) {
          const hit = transcriptCache[shortcode];
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, cached: true, shortcode, ...hit }, null, 2),
              },
            ],
          };
        }
        const info = await runExtensionJob({ kind: "media_info", shortcode }, 45000);
        if (!info || !info.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Could not resolve media URL for shortcode ${shortcode}: ${info?.error?.message || JSON.stringify(info)}`,
              },
            ],
          };
        }
        resolvedUrl = info.audioUrl || info.videoUrl;
        meta = info;
      }

      if (!resolvedUrl) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Provide either a valid Instagram postUrlOrShortcode or a direct mediaUrl.",
            },
          ],
        };
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
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...trans,
                shortcode: shortcode || meta?.shortcode || null,
                postMeta: meta
                  ? {
                      username: meta.username,
                      caption: meta.caption,
                      views: meta.viewCount,
                      likes: meta.likesCount,
                      comments: meta.commentsCount,
                    }
                  : null,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 7: viralspy_spy_report
  mcp.tool(
    "viralspy_spy_report",
    "Generate a complete Spy Report for an Instagram account: sorts their Reels by Outlier Score, transcribes their top N viral Reels locally via Whisper (extracting spoken hooks & full scripts), and fetches similar accounts in their niche.",
    {
      username: z.string().describe("Instagram username to spy on (e.g. 'andre_gizmo')."),
      depth: z
        .number()
        .int()
        .min(12)
        .max(500)
        .default(50)
        .describe("How many latest Reels to scan for outlier scoring."),
      topPostsCount: z
        .number()
        .int()
        .min(3)
        .max(30)
        .default(10)
        .describe("How many top Outlier Reels to include in the report."),
      transcribeTop: z
        .number()
        .int()
        .min(0)
        .max(10)
        .default(3)
        .describe("How many of the top Outlier Reels to automatically transcribe with Whisper to extract their hooks & scripts."),
      includeSimilarAccounts: z
        .boolean()
        .default(true)
        .describe("Whether to also fetch similar creator accounts."),
    },
    async ({
      username,
      depth = 50,
      topPostsCount = 10,
      transcribeTop = 3,
      includeSimilarAccounts = true,
    }) => {
      const cleanUser = username.replace(/^@/, "").trim().toLowerCase();

      // Step 1: Sort Reels by Outlier Score
      const sortRes = await runExtensionJob(
        {
          username: cleanUser,
          surface: "reels",
          sortBy: "outlier",
          outlier: "on",
          depth,
        },
        240000
      );

      if (!sortRes || !sortRes.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Spy Report failed while sorting @${cleanUser}: ${sortRes?.error?.message || JSON.stringify(sortRes)}`,
            },
          ],
        };
      }

      const rows = Array.isArray(sortRes.rows) ? sortRes.rows : [];
      const topPosts = rows.slice(0, topPostsCount).map((r, i) => formatPostSummary(r, i));

      // Step 2: Transcribe top N Outlier Reels locally via Whisper
      const toTranscribe = topPosts.slice(0, Math.max(0, transcribeTop));
      for (const post of toTranscribe) {
        let mediaUrl = post.audioUrl || post.videoUrl;
        if (!mediaUrl && post.shortcode) {
          const info = await runExtensionJob({ kind: "media_info", shortcode: post.shortcode }, 45000);
          if (info?.ok) mediaUrl = info.audioUrl || info.videoUrl;
        }
        if (mediaUrl) {
          const tr = await runTranscription({
            cacheKey: post.shortcode || null,
            mediaUrl,
            platform: "instagram",
            profileName: cleanUser,
          });
          if (tr?.ok) {
            post.hook = tr.hook;
            post.transcript = tr.transcription;
            post.transcriptLanguage = tr.language;
            post.durationSeconds = tr.duration_seconds;
          } else {
            post.transcriptError = tr?.message || "Transcription unavailable";
          }
        }
      }

      // Step 3: Fetch Similar Accounts if requested
      let similarAccounts = [];
      let profileInfo = null;
      if (includeSimilarAccounts) {
        const simRes = await runExtensionJob({ kind: "similar", username: cleanUser }, 45000);
        if (simRes?.ok) {
          similarAccounts = (simRes.accounts || []).slice(0, 25);
          profileInfo = simRes.profile || null;
        }
      }

      const report = {
        ok: true,
        username: cleanUser,
        profile: profileInfo,
        totalReelsScanned: sortRes.seenInFeed || rows.length,
        outlierBaseline: sortRes.outlier || null,
        savedExports: sortRes.savedExports || {},
        topOutlierReels: topPosts,
        similarAccounts,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    }
  );

  // Tool 8: viralspy_focus_tab
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
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      };
    }
  );

  return mcp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot: Hub + Daemon / MCP Stdio / CLI
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const hubInfo = await startLocalHub();

if (args.includes("--daemon")) {
  if (!hubInfo.primary) {
    console.log(`[ViralSpy] Hub is already running on http://${HOST}:${PORT}`);
    process.exit(0);
  }
  console.log(`[ViralSpy] Local Hub + Whisper Server listening on http://${HOST}:${PORT} (WebSocket ws://${HOST}:${PORT}/ext)`);
} else {
  const mcpServer = createViralSpyMcpServer();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}
