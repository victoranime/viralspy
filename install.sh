#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$ROOT_DIR/mcp-server"
EXT_DIR="$ROOT_DIR/extension"
MODEL_DIR="$HOME/.cache/whisper-models"
MODEL_PATH="$MODEL_DIR/ggml-medium.bin"

echo "========================================================"
echo "  ViralSpy Installer (Chrome Extension + Local AI MCP)"
echo "========================================================"
echo ""

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js is not installed."
  if command -v brew >/dev/null 2>&1; then
    echo "    Installing Node.js via Homebrew..."
    brew install node
  else
    echo "    Please install Node.js (v18+) from https://nodejs.org and re-run ./install.sh"
    exit 1
  fi
fi
echo "[✓] Node.js found: $(node -v)"

# 2. Check ffmpeg & whisper-cli (macOS Homebrew)
if command -v brew >/dev/null 2>&1; then
  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "[*] Installing ffmpeg via Homebrew..."
    brew install ffmpeg
  else
    echo "[✓] ffmpeg found"
  fi

  if ! command -v whisper-cli >/dev/null 2>&1; then
    echo "[*] Installing whisper-cpp via Homebrew..."
    brew install whisper-cpp
  else
    echo "[✓] whisper-cli found"
  fi
fi

# 3. Ensure Whisper model exists for free local transcription
mkdir -p "$MODEL_DIR"
if [ ! -f "$MODEL_PATH" ] && [ ! -f "$MODEL_DIR/ggml-base.bin" ]; then
  echo "[*] Downloading Whisper model (ggml-base.bin, ~142 MB) for fast local transcription..."
  curl -L --progress-bar \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" \
    -o "$MODEL_DIR/ggml-base.bin"
  echo "[✓] Whisper model saved to $MODEL_DIR/ggml-base.bin"
else
  echo "[✓] Whisper model already present in $MODEL_DIR"
fi

# 4. Install MCP server dependencies
echo "[*] Installing MCP server dependencies..."
cd "$MCP_DIR"
npm install --silent
echo "[✓] MCP dependencies installed"

# 5. Register ViralSpy MCP in Claude Desktop, Antigravity, and Cursor
echo "[*] Registering ViralSpy MCP server in AI clients..."
NODE_BIN="$(command -v node)"
INDEX_MJS="$MCP_DIR/index.mjs"

node -e '
const fs = require("fs");
const path = require("path");
const os = require("os");

const nodeBin = process.argv[1];
const indexMjs = process.argv[2];

const targets = [
  path.join(os.homedir(), "Library/Application Support/Claude/claude_desktop_config.json"),
  path.join(os.homedir(), ".gemini/config/mcp_config.json"),
  path.join(os.homedir(), ".gemini/antigravity/mcp_config.json"),
  path.join(os.homedir(), ".cursor/mcp.json"),
];

for (const cfgPath of targets) {
  try {
    const dir = path.dirname(cfgPath);
    if (!fs.existsSync(dir)) continue;
    let cfg = {};
    if (fs.existsSync(cfgPath)) {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    }
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers.viralspy = {
      command: nodeBin,
      args: [indexMjs],
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    console.log("    [✓] Registered in:", cfgPath);
  } catch (err) {
    // skip if unreadable
  }
}
' "$NODE_BIN" "$INDEX_MJS"

# 6. Start the background Hub & Whisper server on port 8765
echo "[*] Starting ViralSpy local background hub on http://127.0.0.1:8765 ..."
nohup "$NODE_BIN" "$INDEX_MJS" --daemon >/tmp/viralspy-hub.log 2>&1 &
sleep 1

echo ""
echo "========================================================"
echo "  Setup Complete! Final step in Google Chrome:"
echo "========================================================"
echo "  1. Open Chrome and go to: chrome://extensions"
echo "  2. Enable 'Developer mode' (top-right toggle)"
echo "  3. Click 'Load unpacked' and select this folder:"
echo "     $EXT_DIR"
echo "========================================================"
