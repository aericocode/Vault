# Vault — Setup & Walkthrough

Everything runs on your machine. Nothing is sent anywhere except your own
local AI server (LM Studio or Ollama).

---

## 1. Quick start (5 minutes)

1. **Install [Node.js](https://nodejs.org)** (LTS). That's the only hard
   requirement to browse, play, tag, and organize.
2. Double-click **`start.bat`** — it installs dependencies on first run,
   starts the local server, and opens the viewer in your browser.
3. **Drag media files onto the window** to add them (playable immediately),
   or run **`scan.bat`** for the interactive wizard that indexes whole folders.

That's a working library. Steps below add the AI features.

### Optional tools (feature-by-feature)

| Tool | Needed for | Install |
|---|---|---|
| **ffmpeg + ffprobe** | thumbnails, duration probing, beat bar, subtitles, Music ID | `winget install ffmpeg` (must end up in PATH) |
| **LM Studio** *or* **Ollama** | AI scanning, semantic search, chat-based translation fallback | see §2 |
| **fpcalc** (Chromaprint) | Music ID fingerprinting | [acoustid.org/chromaprint](https://acoustid.org/chromaprint) → PATH |
| **Python + faster-whisper** | transcription/subtitles | `python -m venv venv && venv\Scripts\pip install faster-whisper` |

---

## 2. AI backend — LM Studio or Ollama

Vault talks to any **OpenAI-compatible** `/v1/chat/completions` server and
load-balances across several (multi-GPU). Scanning needs a **vision** model.

### Option A — LM Studio (default, zero config)

1. Install [LM Studio](https://lmstudio.ai), download a vision model (see §3).
2. Load the model, start the server (Developer tab → Start, port **1234**).
3. Done — Vault's default endpoint is `http://localhost:1234/v1/chat/completions`.
   LM Studio serves whatever model is loaded; no model name needed.

### Option B — Ollama

Ollama **requires the model name in each request**, so set two env vars:

```bat
ollama pull qwen2.5vl:7b          &rem vision model for scanning (see §3)
ollama pull nomic-embed-text      &rem embeddings for semantic search

set LM_STUDIO_URLS=http://localhost:11434/v1/chat/completions
set AI_MODEL=qwen2.5vl:7b
set EMBEDDING_MODEL=nomic-embed-text
start.bat
```

(Or set them once in System → Environment Variables so start.bat always sees them.)

### Multi-GPU

Run one server instance per GPU and list both endpoints:

```
LM_STUDIO_URLS=http://localhost:1234/v1/chat/completions,http://localhost:1235/v1/chat/completions
```

---

## 3. Model recommendations by GPU size

Vision model = scan quality. Quantized (Q4) versions are the sweet spot.

| VRAM | Vision model (scanning) | Whisper (subtitles) | Notes |
|---|---|---|---|
| **6–8 GB** | Qwen2.5-VL-3B Q4 · MiniCPM-V 2.6 Q4 | `WHISPER_MODEL=small` | Lower `VISION_WORKERS=1`; scans are slower but fine |
| **10–12 GB** | **Qwen2.5-VL-7B Q4** (recommended) · LLaVA-1.6-13B Q4 | `large-v3-turbo` @ `int8_float16` (default) | The defaults target this class |
| **16 GB** | Qwen2.5-VL-7B Q8 · Gemma-3-12B-IT Q4 (vision) | default | Room for `PIPELINE_DEPTH=3` |
| **24 GB+** | Qwen2.5-VL-32B Q4 · or 7B at full precision + 2 workers | default | Multi-worker scanning shines: `VISION_WORKERS=2` |

- **Embeddings** (semantic search) are tiny — `nomic-embed-text` (~0.5 GB) runs anywhere.
- **Whisper** sizes: `small` ≈ 1 GB, `large-v3-turbo` int8 ≈ 1.5 GB VRAM; it
  shares the GPU with scans, jobs queue one at a time so they never collide.

---

## 4. Every user-editable setting (defined ONCE, in `config/index.js`)

All settings live in `config/index.js` and read environment variables —
nothing is duplicated elsewhere (`start.bat` asks the config for the port).

| Env var | Default | What it does |
|---|---|---|
| `MEDIA_TAGGER_PORT` | `8765` | Viewer port |
| `VIDEO_TAGGER_DB` | `./video_metadata.db` | Library database file |
| `VIDEO_TAGGER_DB_PASSWORD` | — | Auto-unlock an encrypted Vault at boot |
| `LM_STUDIO_URLS` | `http://localhost:1234/v1/chat/completions` | AI endpoint(s), comma-separated |
| `AI_MODEL` | *(unset)* | Model name per request — **required for Ollama**, ignored by LM Studio |
| `EMBEDDING_MODEL` | `text-embedding-nomic-embed-text-v1.5` | Semantic-search embedding model |
| `WHISPER_MODEL` | `large-v3-turbo` | Transcription model (`small` for low VRAM) |
| `WHISPER_IDLE_MINUTES` | `5` | `0` = once loaded, Whisper stays loaded; `N` = unload the sidecars after N idle minutes (low-VRAM boxes) |
| `WHISPER_VAD` | `1` | Voice-activity filter — only decode speech, skip music/silence (faster transcription on padded content). `0` to disable |
| `WHISPER_VAD_MIN_SILENCE_MS` | `500` | Minimum silence gap (ms) the VAD treats as a break — raise it if speech gets clipped |
| `SUB_ALLOW_DOWNLOADS` | `1` | AI models (whisper + translation packs + speaker-diarization models) already on disk **always** load offline. This flag governs the one-time fetch of a model that isn't installed yet: `1` = allow (warned once), `0` = never touch the network (missing model errors with instructions — air-gapped / strict mode). `VAULT_OFFLINE=1` forces this off |
| `VAULT_OFFLINE` | `0` (unset) | Hard offline switch: `1` = loopback-only networking app-wide (model downloads, update checks, remote AI endpoints all refuse; localhost services keep working). Implies `SUB_ALLOW_DOWNLOADS=0` and sets `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE` for the Python sidecars |
| `VAULT_AUTOLOCK_MINUTES` | `30` | Auto-lock idle timeout (0 = off) |
| `VIDEO_TAGGER_TRASH` | `./trash` | Trash folder (opaque filenames) |
| `VIDEO_TAGGER_THUMBS` | `./thumbnails` | Thumbnail/cache folder |
| `FRAME_WORKERS` / `VISION_WORKERS` / `PIPELINE_DEPTH` | `4` / `1` / `2` | Scan parallelism (see §3) |

---

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `Node.js is required but was not found` | Install Node LTS from nodejs.org, reopen the terminal |
| `No LM Studio endpoints available` / scan errors instantly | Start LM Studio's server (or Ollama) and check `LM_STUDIO_URLS`; for Ollama also set `AI_MODEL` |
| Scans produce empty/garbage metadata | The loaded model isn't a **vision** model — load one from §3 |
| `database is encrypted — password required` at boot | The Vault is locked: open the viewer and hold the padlock 3s, or set `VIDEO_TAGGER_DB_PASSWORD` |
| Thumbnails/duration missing on imports | ffmpeg/ffprobe not in PATH |
| Music ID says tools missing | Install fpcalc (Chromaprint) into PATH |
| Subtitles fail to generate | Create the Python venv with `faster-whisper` (§1 table) |
| Diarization/subtitles report that downloads are off | Either pre-install the models (`whisper` / OPUS-MT / `models/diarize` dirs) or set `SUB_ALLOW_DOWNLOADS=1` (and ensure `VAULT_OFFLINE` is unset) |
