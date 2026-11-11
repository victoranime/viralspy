# ViralSpy: Instagram, TikTok, YouTube & Facebook Outlier Sorter + Local AI MCP

ViralSpy is an open-source Chrome extension and local Model Context Protocol (MCP) server for content creators and media buyers. It sorts social feeds by Outlier Score, views, likes, comments, shares, saves, or oldest posts, and connects your browser directly to Claude Desktop, Antigravity, or Cursor.

All Pro features are unlocked out of the box, and audio transcription runs locally on your machine using `ffmpeg` and `whisper.cpp` with zero API costs.

## Direct downloads

Choose the package that matches how you want to use ViralSpy:

1. **[Download ViralSpy-Chrome-Extension.zip](https://github.com/victoranime/viralspy/releases/latest/download/ViralSpy-Chrome-Extension.zip)**
   Download this file if you only want the Chrome extension to sort Instagram, TikTok, YouTube, and Facebook feeds in your browser and export CSV, JSON, or Excel sheets. No terminal or coding tools required.
2. **[Download ViralSpy-Full-Suite-MCP.zip](https://github.com/victoranime/viralspy/releases/latest/download/ViralSpy-Full-Suite-MCP.zip)**
   Download this file if you want the Chrome extension plus free local Whisper video transcription and the MCP server for Claude Desktop, Antigravity, or Cursor.

---

## What is included

ViralSpy combines a Manifest V3 Chrome extension, a local Studio web dashboard at `http://127.0.0.1:8765/dashboard`, and a 14-tool MCP server:

- Sort Instagram (Reels, Posts, Keyword Search, Saved Posts, Collections), TikTok (Profiles, Search, Favorites), YouTube (Videos, Shorts), and Facebook (Reels) with scan depths up to 2,000 posts or custom calendar date windows.
- Rank every video by Outlier Score (breakout multiplier against the creator's median baseline) and Views-Per-Hour velocity.
- Paste multiple competitor URLs or handles in Niche Radar to scrape all accounts in parallel and store every scraped post permanently in your local Master Database (`posts_db.json`).
- Click the **Reproduce** button on any Instagram or TikTok video (directly above the Save bookmark in Chrome or inside ViralSpy Studio) to generate a complete VideoBot `.zip` pack (`frames/scene_01.jpg...` at every shot cut, `scenes.txt` word-aligned via local Whisper GPU, `transcript.txt`, `storyboard.jpg`, Apple Vision OCR, `thumbnail.jpg`, and `video.mp4`).
- Keep your Saves synchronized two-way between the in-page Save bookmark on Instagram/TikTok and the Swipe Vault inside ViralSpy Studio.
- Mine audience questions and link requests in Comment Goldmine, or trigger all 14 tools from Claude Desktop, Antigravity, or Cursor.

---

## Option A: Install only the Chrome extension (60 seconds, no terminal)

Use this method if you just want to sort feeds, view Outlier Scores, find similar accounts, and export spreadsheets inside Google Chrome, Brave, or Arc.

### Step 1: Download and unzip the extension folder

1. Download **[ViralSpy-Chrome-Extension.zip](https://github.com/victoranime/viralspy/releases/latest/download/ViralSpy-Chrome-Extension.zip)**.
2. Double-click the downloaded `.zip` file to extract the `viralspy-extension` folder.
3. Move that folder to a permanent location on your computer (such as your `Documents` folder) so you do not accidentally delete it from `Downloads`.

### Step 2: Load the extension in Chrome

1. Open Google Chrome (or Brave / Arc) and type `chrome://extensions` into the address bar, then press **Enter**.
2. If you already have the original *Sort Feed* extension installed, toggle it **Off** so the two extensions do not duplicate buttons on Instagram or TikTok.
3. Turn on the **Developer mode** switch in the top-right corner of the page.
4. Click the **Load unpacked** button in the top-left corner.
5. Select the unzipped `viralspy-extension` folder (or the `extension` subfolder if you downloaded the full repository).

The ViralSpy icon will appear in your browser toolbar with the **Pro** badge unlocked. Pin it to your toolbar using the puzzle-piece icon for quick access.

---

## Option B: Full installation with AI MCP server and free Whisper transcription

Use this method if you want in-page video transcription and want to control ViralSpy from Claude Desktop, Antigravity, or Cursor.

### Step 1: Download or clone the repository

Open **Terminal** on macOS and run:

```bash
git clone https://github.com/victoranime/viralspy.git
cd viralspy
```

*(Alternatively, download and unzip **[ViralSpy-Full-Suite-MCP.zip](https://github.com/victoranime/viralspy/releases/latest/download/ViralSpy-Full-Suite-MCP.zip)**, open Terminal, type `cd `, drag the unzipped folder into the Terminal window, and press **Enter**.)*

### Step 2: Run the automatic installer

Run the included setup script:

```bash
chmod +x install.sh
./install.sh
```

What `./install.sh` does automatically:
1. Checks for `node`, `ffmpeg`, and `whisper-cli` (installing them via Homebrew on macOS if needed).
2. Downloads the Whisper speech recognition model into `~/.cache/whisper-models/` if you do not have one yet.
3. Installs the Node.js dependencies inside `mcp-server/`.
4. Registers the `viralspy` MCP server inside Claude Desktop, Antigravity, and Cursor config files using your exact local folder path.
5. Starts the local background bridge on `http://127.0.0.1:8765` (`ws://127.0.0.1:8765/ext`).

### Step 3: Load the extension in Chrome

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the `extension` folder inside your `viralspy` directory.
4. Restart Claude Desktop (or reload your Antigravity / Cursor window) so your AI client picks up the new `viralspy` MCP server.

---

## Manual MCP configuration (if you prefer configuring by hand)

If you prefer not to use `./install.sh`, install dependencies manually:

```bash
brew install node ffmpeg whisper-cpp
mkdir -p ~/.cache/whisper-models
curl -L "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" \
  -o ~/.cache/whisper-models/ggml-base.bin
cd mcp-server && npm install
```

Then add the `viralspy` block to your AI client's configuration file (replace `/ABSOLUTE/PATH/TO/viralspy` with the actual path on your computer):

- **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):
- **Antigravity** (`~/.gemini/config/mcp_config.json`):
- **Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "viralspy": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/viralspy/mcp-server/index.mjs"]
    }
  }
}
```

To keep the local Whisper transcription server running in the background even when Claude Desktop is closed, start the daemon with:

```bash
node /ABSOLUTE/PATH/TO/viralspy/mcp-server/index.mjs --daemon
```

---

## How to use ViralSpy in Chrome

1. Sign in to Instagram, TikTok, YouTube, or Facebook in Chrome as usual.
2. Open any creator profile (for example `https://www.instagram.com/andre_gizmo/reels/`).
3. Click the **ViralSpy** icon in your Chrome toolbar.
4. Choose how much content to scan:
   - Under **Posts / Videos**, pick `Latest 25`, `Latest 50`, `Latest 100`, `Latest 200`, `Latest 1K`, `All Posts`, or `Custom`.
   - Or switch to **Date** to scan posts from `1 Week Back`, `1 Month Back`, `3 Months Back`, `6 Months Back`, `1 Year Back`, or a custom calendar range.
5. Click a sort mode (`Outlier score`, `Views`, `Likes`, `Comments`, or `Oldest`).
6. Once the feed finishes sorting, use the floating banner at the bottom of the page to:
   - Filter by Outlier threshold (`2x+`, `3x+`, `5x+`, `10x+`).
   - Click **Similar** to view and export similar creator accounts.
   - Click **Select** to bulk-download videos or bulk-transcribe them into a spreadsheet.
   - Click **Export** to download the sorted dataset as CSV, JSON, or Excel (`.xlsx`).

---

## Available MCP tools and example prompts

Once connected to Claude Desktop, Antigravity, or Cursor, you can use natural language prompts.

### Example prompts you can copy and paste

- *"Run a full spy report on @andre_gizmo: sort their latest 60 Reels by Outlier Score, transcribe their top 3 outlier Reels to extract the exact spoken hooks, and list similar accounts in their niche."*
- *"Sort the last 100 Reels of @AlexHormozi by Outlier Score and show me every Reel above 3x with its view count and caption."*
- *"Find similar Instagram accounts to @duolingo and group them by topic."*
- *"Transcribe this Instagram Reel and break down the hook in the first 5 seconds: https://www.instagram.com/reel/SHORTCODE/"*
- *"Search Instagram for 'shih tzu tips' and sort the top 50 posts by likes."*

### MCP tool reference

| Tool name | Description |
| :--- | :--- |
| `viralspy_status` | Checks whether the Chrome extension is connected over WebSocket and verifies local Whisper model status. |
| `viralspy_spy_report` | All-in-one spy workflow: sorts a creator's Reels by Outlier Score, transcribes the top N outlier Reels with Whisper to extract their 5-second spoken hooks and full scripts, and fetches similar accounts. |
| `viralspy_sort_instagram` | Sorts any Instagram profile's `reels` or `posts` by `outlier`, `views`, `likes`, `comments`, or `oldest` (up to 2,000 items or by date window) and saves CSV/JSON exports to `mcp-server/data/exports/`. |
| `viralspy_similar_accounts` | Fetches similar creator accounts for any Instagram username using Instagram's native chaining API. |
| `viralspy_transcribe_post` | Downloads and transcribes any Instagram Reel or Post locally via `ffmpeg` and `whisper-cli`, returning the 5-second hook, full transcript, and timestamped segments. |
| `viralspy_search_instagram` | Searches Instagram by keyword and sorts matching posts by `likes`, `comments`, or `oldest`. |
| `viralspy_saved_instagram` | Lists your saved Instagram collections or sorts your saved posts. |
| `viralspy_focus_tab` | Brings the active Chrome sorting tab to the front. |

---

## Project structure

```text
viralspy/
├── extension/                  # Unpacked Chrome MV3 extension (load this in chrome://extensions)
│   ├── manifest.json           # Manifest V3 configuration
│   ├── background.js           # Service worker (Pro state, local Whisper routing, native Similar API)
│   ├── background_agent.js     # WebSocket client connected to ws://127.0.0.1:8765/ext
│   ├── popup.html              # Notion-inspired popup UI
│   ├── Instagram/              # Instagram sorting, outlier scoring, and MAIN-world GraphQL runner
│   ├── Tiktok/                 # TikTok sorting, outlier scoring, and similar accounts
│   ├── YouTube/                # YouTube Videos and Shorts sorting
│   └── Facebook/               # Facebook Reels sorting
├── mcp-server/                 # Local Node.js Hub + Whisper transcription + MCP stdio server
│   ├── index.mjs               # Multi-client safe HTTP/WebSocket hub (:8765) and MCP server
│   └── package.json            # Dependencies (@modelcontextprotocol/sdk, ws, zod)
└── install.sh                  # One-command macOS/Linux installer
```

---

## Troubleshooting

- **"ViralSpy Chrome Extension is not connected" when calling an MCP tool**:
  Make sure Google Chrome is open, the `extension` folder is loaded and enabled in `chrome://extensions`, and you are signed in to Instagram in that browser profile. You can check connection status inside the extension popup by clicking the gear icon on an Instagram tab (**Settings > AI Agents**).
- **Buttons appear twice on Instagram or TikTok**:
  Disable the original *Sort Feed* extension in `chrome://extensions` so only ViralSpy is active.
- **In-page Transcribe button fails**:
  Verify that the local hub is running (`curl http://127.0.0.1:8765/api/status`) and that `ffmpeg` and `whisper-cli` are installed (`brew install ffmpeg whisper-cpp`).

## License

Released under the [MIT License](LICENSE).
